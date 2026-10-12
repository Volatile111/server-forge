# Checks whether plugin DLLs would still work on a DIFFERENT BepInEx version, by resolving every
# reference each plugin makes into the mod loader's own assemblies (BepInEx, 0Harmony, MonoMod,
# Mono.Cecil, ...) against that version's BepInEx\core folder. Same idea as inspect-plugins.ps1,
# but aimed at the loader instead of the game.
#
# A plugin built for BepInEx 5 references BepInEx.dll; BepInEx 6 has no BepInEx.dll (it's split
# into BepInEx.Core / BepInEx.Unity.Mono), so every such plugin is reported - exactly the "newer
# isn't better for this game's mods" case the manager has to catch before installing anything.
#
# Usage: check-loader.ps1 -CecilPath <Mono.Cecil.dll> -CandidateCore <new BepInEx\core>
#                         -CurrentCore <installed BepInEx\core> -CandidateVersion <label> -ListFile <json array of dll paths>
# Output: JSON array of { path, problems: [ { detail, where[] } ] } on stdout.

param(
  [Parameter(Mandatory = $true)][string]$CecilPath,
  [Parameter(Mandatory = $true)][string]$CandidateCore,
  [Parameter(Mandatory = $true)][string]$CurrentCore,
  [Parameter(Mandatory = $true)][string]$CandidateVersion,
  [Parameter(Mandatory = $true)][string]$ListFile
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[void][System.Reflection.Assembly]::Load([System.IO.File]::ReadAllBytes($CecilPath))

function Read-Module([string]$path) {
  $ms = New-Object System.IO.MemoryStream(, [System.IO.File]::ReadAllBytes($path))
  return [Mono.Cecil.ModuleDefinition]::ReadModule($ms)
}

# ---- Index the candidate loader: assembly -> type -> member names -----------------------------
$candidate = @{}
foreach ($dll in Get-ChildItem -Path $CandidateCore -Filter *.dll) {
  try { $m = Read-Module $dll.FullName } catch { continue }
  $types = @{}
  foreach ($t in $m.GetTypes()) {
    $methods = New-Object 'System.Collections.Generic.HashSet[string]'
    $names = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($x in $t.Methods) { [void]$methods.Add("$($x.Name)/$($x.Parameters.Count)"); [void]$names.Add($x.Name) }
    foreach ($x in $t.Fields) { [void]$names.Add($x.Name) }
    foreach ($x in $t.Properties) { [void]$names.Add($x.Name) }
    foreach ($x in $t.Events) { [void]$names.Add($x.Name) }
    $types[$t.FullName] = @{ Methods = $methods; Names = $names }
  }
  # Type forwarders: the type exists (elsewhere); members can't be checked from here.
  foreach ($e in $m.ExportedTypes) { if (-not $types.ContainsKey($e.FullName)) { $types[$e.FullName] = $null } }
  $candidate[$m.Assembly.Name.Name] = $types
}

# Every assembly name that belongs to "the loader", in either version - a plugin reference to one
# of these that the candidate doesn't ship is a hard failure.
$loaderNames = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($k in $candidate.Keys) { [void]$loaderNames.Add($k) }
foreach ($dll in Get-ChildItem -Path $CurrentCore -Filter *.dll) { [void]$loaderNames.Add([IO.Path]::GetFileNameWithoutExtension($dll.Name)) }

function Scope-Name($typeRef) {
  if ($null -eq $typeRef) { return $null }
  $s = $typeRef.Scope
  if ($null -eq $s) { return $null }
  return ($s.Name -replace '\.dll$', '')
}

$paths = Get-Content -Raw -Path $ListFile | ConvertFrom-Json
$results = @()

foreach ($path in $paths) {
  $found = [ordered]@{}
  function Add-Problem([string]$detail, [string]$where) {
    if (-not $found.Contains($detail)) { $found[$detail] = New-Object System.Collections.Generic.List[string] }
    if ($where -and -not $found[$detail].Contains($where)) { $found[$detail].Add($where) }
  }

  function Test-LoaderRef($ref) {
    $isType = $ref -is [Mono.Cecil.TypeReference]
    $dt = if ($isType) { $ref.GetElementType() } else { $ref.DeclaringType }
    if ($null -eq $dt) { return $null }
    $asm = Scope-Name $dt
    if (-not $asm -or -not $loaderNames.Contains($asm)) { return $null }
    if (-not $candidate.ContainsKey($asm)) { return "Needs $asm.dll, which BepInEx $CandidateVersion doesn't include." }
    $tn = if ($isType) { $dt.FullName } else { $dt.GetElementType().FullName }
    $types = $candidate[$asm]
    if (-not $types.ContainsKey($tn)) { return "Uses $tn from $asm.dll, which BepInEx $CandidateVersion doesn't have." }
    if ($isType -or $null -eq $types[$tn]) { return $null }
    if ($ref -is [Mono.Cecil.MethodReference]) {
      if (-not $types[$tn].Methods.Contains("$($ref.Name)/$($ref.Parameters.Count)")) { return "Calls $($dt.Name).$($ref.Name) ($($ref.Parameters.Count) args) from $asm.dll, which changed or is gone in BepInEx $CandidateVersion." }
    }
    elseif ($ref -is [Mono.Cecil.FieldReference]) {
      if (-not $types[$tn].Names.Contains($ref.Name)) { return "Uses $($dt.Name).$($ref.Name) from $asm.dll, which is gone in BepInEx $CandidateVersion." }
    }
    return $null
  }

  try {
    $mod = Read-Module $path
    foreach ($ar in $mod.AssemblyReferences) {
      if ($loaderNames.Contains($ar.Name) -and -not $candidate.ContainsKey($ar.Name)) { Add-Problem "Needs $($ar.Name).dll, which BepInEx $CandidateVersion doesn't include." $null }
    }
    foreach ($t in $mod.GetTypes()) {
      foreach ($m in $t.Methods) {
        if (-not $m.HasBody) { continue }
        foreach ($ins in $m.Body.Instructions) {
          if ($ins.Operand -is [Mono.Cecil.MemberReference]) {
            $p = Test-LoaderRef $ins.Operand
            if ($p) { Add-Problem $p "$($t.Name).$($m.Name)" }
          }
        }
      }
      if ($t.BaseType) { $p = Test-LoaderRef $t.BaseType; if ($p) { Add-Problem $p $t.Name } }
      foreach ($ca in $t.CustomAttributes) { $p = Test-LoaderRef $ca.AttributeType; if ($p) { Add-Problem $p $t.Name } }
    }
    foreach ($mr in $mod.GetMemberReferences()) { $p = Test-LoaderRef $mr; if ($p) { Add-Problem $p $null } }
    $results += , ([pscustomobject]@{ path = $path; ok = $true; problems = @($found.Keys | ForEach-Object { @{ detail = $_; where = @($found[$_]) } }) })
  }
  catch {
    $results += , ([pscustomobject]@{ path = $path; ok = $false; error = $_.Exception.Message; problems = @() })
  }
}

[Console]::Out.Write((ConvertTo-Json -InputObject @($results) -Depth 6 -Compress))
