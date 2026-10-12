# Inspects BepInEx plugin DLLs against the installed game, using the Mono.Cecil that ships inside
# BepInEx itself (BepInEx\core\Mono.Cecil.dll) - no extra tools needed on the user's PC.
#
# For each DLL it reports: BepInPlugin identity (GUID/name/version), declared dependencies, which
# BepInEx generation it was built for, and every reference into the game's code (methods, fields,
# types, Harmony patch targets, AccessTools reflection targets) that no longer exists in the
# current Assembly-CSharp.dll - i.e. what would break on this game version.
#
# Everything is read from in-memory copies (ReadAllBytes), so files are never locked - the game
# can be running while this scans.
#
# Usage: inspect-plugins.ps1 -CecilPath <Mono.Cecil.dll> -GameManaged <Star Valor_Data\Managed> -ListFile <json array of dll paths>
# Output: one JSON array on stdout.

param(
  [Parameter(Mandatory = $true)][string]$CecilPath,
  [Parameter(Mandatory = $true)][string]$GameManaged,
  [Parameter(Mandatory = $true)][string]$ListFile
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Load from bytes: avoids both file locks and the "downloaded file is blocked" (0x80131515) error
# that Add-Type hits on files extracted from an internet zip.
[void][System.Reflection.Assembly]::Load([System.IO.File]::ReadAllBytes($CecilPath))

function Read-Module([string]$path) {
  $ms = New-Object System.IO.MemoryStream(, [System.IO.File]::ReadAllBytes($path))
  return [Mono.Cecil.ModuleDefinition]::ReadModule($ms)
}

# ---- Index the game's code once: type -> member names ----------------------------------------
$game = Read-Module (Join-Path $GameManaged 'Assembly-CSharp.dll')
$index = @{}
foreach ($t in $game.GetTypes()) {
  $methods = New-Object 'System.Collections.Generic.HashSet[string]'
  $names = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($m in $t.Methods) { [void]$methods.Add("$($m.Name)/$($m.Parameters.Count)"); [void]$names.Add($m.Name) }
  foreach ($f in $t.Fields) { [void]$names.Add($f.Name) }
  foreach ($p in $t.Properties) { [void]$names.Add($p.Name) }
  foreach ($e in $t.Events) { [void]$names.Add($e.Name) }
  $index[$t.FullName] = @{ Methods = $methods; Names = $names }
}

function Test-GameScope($typeRef) {
  if ($null -eq $typeRef) { return $false }
  $scope = $typeRef.Scope
  if ($null -eq $scope) { return $false }
  return $scope.Name -eq 'Assembly-CSharp' -or $scope.Name -eq 'Assembly-CSharp.dll'
}

function Get-AttrArgs($ca) {
  $out = @()
  foreach ($a in $ca.ConstructorArguments) { $out += , $a.Value }
  return , $out
}

$paths = Get-Content -Raw -Path $ListFile | ConvertFrom-Json
$results = @()

foreach ($path in $paths) {
  $r = [ordered]@{
    path = $path; ok = $true; error = $null; isPlugin = $false
    guid = $null; name = $null; version = $null
    assemblyName = $null; loader = 'bepinex5'
    dependencies = @(); incompatibilities = @(); processes = @()
    namespaces = @(); problems = @(); missingMembers = @(); patches = @()
  }
  try {
    $mod = Read-Module $path
    $r.assemblyName = $mod.Assembly.Name.Name
    $problems = New-Object System.Collections.Generic.List[object]

    # Which mod loader was this built for?
    foreach ($ar in $mod.AssemblyReferences) {
      switch -Regex ($ar.Name) {
        '^BepInEx\.(Core|Unity\.Mono|Unity\.IL2CPP|IL2CPP)$' { $r.loader = 'bepinex6' }
        '^MelonLoader$' { $r.loader = 'melonloader' }
      }
    }
    if ($r.loader -eq 'bepinex6') { $problems.Add(@{ kind = 'loader'; detail = 'Built for BepInEx 6 - this game uses BepInEx 5, so it will not load.' }) }
    if ($r.loader -eq 'melonloader') { $problems.Add(@{ kind = 'loader'; detail = 'Built for MelonLoader, not BepInEx - it will not load here.' }) }

    $nsSet = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($t in $mod.Types) {
      if ($t.Name -eq '<Module>') { continue }
      if ($t.Namespace) { [void]$nsSet.Add($t.Namespace) }
      elseif (-not $index.ContainsKey($t.FullName)) { [void]$nsSet.Add($t.Name) }
    }
    $r.namespaces = @($nsSet)

    # ---- BepInEx attributes --------------------------------------------------------------------
    foreach ($t in $mod.GetTypes()) {
      foreach ($ca in $t.CustomAttributes) {
        $cargs = Get-AttrArgs $ca
        switch ($ca.AttributeType.Name) {
          'BepInPlugin' {
            $r.isPlugin = $true
            if ($cargs.Count -ge 3) { $r.guid = [string]$cargs[0]; $r.name = [string]$cargs[1]; $r.version = [string]$cargs[2] }
          }
          'BepInDependency' {
            $flags = 1
            if ($cargs.Count -ge 2 -and $cargs[1] -isnot [string]) { $flags = [int]$cargs[1] }
            $r.dependencies += , @{ guid = [string]$cargs[0]; hard = (($flags -band 1) -eq 1); versionRange = $(if ($cargs.Count -ge 2 -and $cargs[1] -is [string]) { $cargs[1] } else { $null }) }
          }
          'BepInIncompatibility' { $r.incompatibilities += , [string]$cargs[0] }
          'BepInProcess' { $r.processes += , [string]$cargs[0] }
        }
      }
    }

    # Problems keyed by kind|detail, each remembering which of the mod's own methods hit it, so the
    # manager can say e.g. "used by Main.GameManagerSetupGame_Post (runs on GameManager.SetupGame)".
    $found = [ordered]@{}
    function Add-Problem([string]$kind, [string]$detail, [string]$where) {
      $key = "$kind|$detail"
      if (-not $found.Contains($key)) { $found[$key] = @{ kind = $kind; detail = $detail; where = (New-Object System.Collections.Generic.List[string]) } }
      if ($where -and -not $found[$key].where.Contains($where)) { $found[$key].where.Add($where) }
    }

    # Names of missing game members exactly as Mono prints them in MissingField/MissingMethod/
    # TypeLoad exceptions ("JumpGate.jumpGateControl"), so the manager can pin a runtime error on
    # this mod even when the stack trace never shows a frame from it - which is what happens when
    # Mono fails to compile a Harmony hook and blames the game method being hooked.
    $missing = New-Object 'System.Collections.Generic.HashSet[string]'

    # Returns @(kind, detail) if a reference into the game's code no longer resolves, else $null.
    function Test-Ref($ref) {
      if ($ref -is [Mono.Cecil.MemberReference] -and -not ($ref -is [Mono.Cecil.TypeReference])) {
        $dt = $ref.DeclaringType
        if (-not (Test-GameScope $dt)) { return $null }
        $tn = $dt.GetElementType().FullName
        if (-not $index.ContainsKey($tn)) { [void]$missing.Add($tn); return @('type', "Game type '$tn' no longer exists.") }
        $gt = $index[$tn]
        if ($ref -is [Mono.Cecil.FieldReference]) {
          if (-not $gt.Names.Contains($ref.Name)) { [void]$missing.Add("$tn.$($ref.Name)"); return @('field', "Field '$($dt.Name).$($ref.Name)' no longer exists.") }
          $ft = $ref.FieldType.GetElementType()
          if ((Test-GameScope $ft) -and -not $index.ContainsKey($ft.FullName)) {
            [void]$missing.Add("$tn.$($ref.Name)"); [void]$missing.Add($ft.FullName)
            return @('field', "Field '$($dt.Name).$($ref.Name)' changed type - its old type '$($ft.FullName)' no longer exists.")
          }
        }
        elseif ($ref -is [Mono.Cecil.MethodReference]) {
          if (-not $gt.Methods.Contains("$($ref.Name)/$($ref.Parameters.Count)")) { [void]$missing.Add("$tn.$($ref.Name)"); return @('method', "Method '$($dt.Name).$($ref.Name)' ($($ref.Parameters.Count) args) no longer exists or changed signature.") }
        }
        return $null
      }
      if ($ref -is [Mono.Cecil.TypeReference]) {
        $et = $ref.GetElementType()
        if ((Test-GameScope $et) -and -not $index.ContainsKey($et.FullName)) { [void]$missing.Add($et.FullName); return @('type', "Game type '$($et.FullName)' no longer exists.") }
      }
      return $null
    }

    # ---- Harmony hooks: which game method each of the mod's methods patches -------------------
    $hookOf = @{}
    $patchTargets = @()
    foreach ($t in $mod.GetTypes()) {
      $classType = $null; $className = $null
      foreach ($ca in $t.CustomAttributes) {
        if ($ca.AttributeType.Name -ne 'HarmonyPatch') { continue }
        foreach ($a in (Get-AttrArgs $ca)) {
          if ($a -is [Mono.Cecil.TypeReference]) { $classType = $a } elseif ($a -is [string]) { $className = $a }
        }
      }
      foreach ($m in $t.Methods) {
        foreach ($ca in $m.CustomAttributes) {
          if ($ca.AttributeType.Name -ne 'HarmonyPatch') { continue }
          $mt = $classType; $mn = $className
          foreach ($a in (Get-AttrArgs $ca)) {
            if ($a -is [Mono.Cecil.TypeReference]) { $mt = $a } elseif ($a -is [string]) { $mn = $a }
          }
          if ($mt -and $mn) {
            $hookOf["$($t.Name).$($m.Name)"] = "$($mt.Name).$mn"
            $patchTargets += , @($mt, $mn, "$($t.Name).$($m.Name)")
          }
        }
      }
      if ($classType -and $className) { $patchTargets += , @($classType, $className, $t.Name) }
    }
    function Describe-Where([string]$where) {
      if ($hookOf.ContainsKey($where)) { return "$where (runs on $($hookOf[$where]))" }
      return $where
    }

    foreach ($pair in $patchTargets) {
      $tt = $pair[0]; $nm = $pair[1]; $w = Describe-Where $pair[2]
      if (-not (Test-GameScope $tt)) { continue }
      if (-not $index.ContainsKey($tt.FullName)) { Add-Problem 'patch' "Harmony patch target type '$($tt.FullName)' no longer exists." $w }
      elseif (-not $index[$tt.FullName].Names.Contains($nm)) { Add-Problem 'patch' "Harmony patch target '$($tt.Name).$nm' no longer exists." $w }
    }

    # ---- Every reference inside the mod's method bodies ---------------------------------------
    foreach ($t in $mod.GetTypes()) {
      foreach ($m in $t.Methods) {
        if (-not $m.HasBody) { continue }
        $w = Describe-Where "$($t.Name).$($m.Name)"
        foreach ($ins in $m.Body.Instructions) {
          $op = $ins.Operand
          if ($op -is [Mono.Cecil.MemberReference]) {
            $p = Test-Ref $op
            if ($p) { Add-Problem $p[0] $p[1] $w }
          }
        }
      }
    }

    # ---- Anything referenced outside method bodies (signatures, field types, attributes) -------
    foreach ($mr in $mod.GetMemberReferences()) { $p = Test-Ref $mr; if ($p) { Add-Problem $p[0] $p[1] $null } }
    foreach ($tr in $mod.GetTypeReferences()) { $p = Test-Ref $tr; if ($p) { Add-Problem $p[0] $p[1] $null } }

    foreach ($t in $mod.GetTypes()) {
      $classType = $null; $className = $null
      foreach ($ca in $t.CustomAttributes) {
        if ($ca.AttributeType.Name -ne 'HarmonyPatch') { continue }
        foreach ($a in (Get-AttrArgs $ca)) {
          if ($a -is [Mono.Cecil.TypeReference]) { $classType = $a } elseif ($a -is [string]) { $className = $a }
        }
      }
      # ---- AccessTools.Method/Field(typeof(X), "name") reflection lookups ---------------------
      foreach ($m in $t.Methods) {
        if (-not $m.HasBody) { continue }
        $ins = $m.Body.Instructions
        for ($i = 0; $i -lt $ins.Count; $i++) {
          $op = $ins[$i].Operand
          if (-not ($op -is [Mono.Cecil.MethodReference])) { continue }
          if ($op.DeclaringType.Name -ne 'AccessTools') { continue }
          if ($op.Name -notmatch '^(Method|DeclaredMethod|Field|DeclaredField|Property|DeclaredProperty|PropertyGetter|PropertySetter|StaticFieldRefAccess|FieldRefAccess)$') { continue }
          $tok = $null; $str = $null
          for ($j = $i - 1; $j -ge [Math]::Max(0, $i - 6); $j--) {
            $c = $ins[$j].OpCode.Code.ToString()
            if (-not $str -and $c -eq 'Ldstr') { $str = $ins[$j].Operand }
            if (-not $tok -and $c -eq 'Ldtoken') { $tok = $ins[$j].Operand }
          }
          if ($tok -and $str -and ($tok -is [Mono.Cecil.TypeReference]) -and (Test-GameScope $tok) -and $index.ContainsKey($tok.FullName)) {
            if (-not $index[$tok.FullName].Names.Contains($str)) { Add-Problem 'reflection' "Looks up '$($tok.Name).$str' by name, which no longer exists." (Describe-Where "$($t.Name).$($m.Name)") }
          }
        }
      }
    }

    foreach ($p in $problems) { Add-Problem $p.kind $p.detail $null }
    # A bare "type X no longer exists" (found only in a signature, no location) adds nothing when a
    # more specific problem - e.g. "field Y changed type, its old type X no longer exists" - already
    # says it. Drop those so each real problem is listed once.
    $all = @($found.Values)
    $r.problems = @($all | Where-Object {
        $p = $_
        if ($p.kind -ne 'type' -or $p.where.Count -gt 0) { return $true }
        $name = ([regex]::Match($p.detail, "'([^']+)'")).Groups[1].Value
        -not ($all | Where-Object { $_ -ne $p -and $_.detail.Contains("'$name'") })
      } | ForEach-Object { @{ kind = $_.kind; detail = $_.detail; where = @($_.where) } })
    $r.missingMembers = @($missing)
    # Game methods this mod hooks, spelled the way stack traces print them ("GameManager.SetupGame").
    $r.patches = @($patchTargets | Where-Object { Test-GameScope $_[0] } | ForEach-Object { "$($_[0].FullName.Replace('/', '+')).$($_[1])" } | Sort-Object -Unique)
  }
  catch {
    $r.ok = $false
    $r.error = $_.Exception.Message
  }
  $results += , ([pscustomobject]$r)
}

[Console]::Out.Write((ConvertTo-Json -InputObject @($results) -Depth 6 -Compress))
