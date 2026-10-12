import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';

/**
 * Where everything lives inside the game's BepInEx folder.
 *
 * Disabled mods MUST live outside BepInEx/plugins: BepInEx 5's chainloader scans plugins/ with
 * SearchOption.AllDirectories (verified in BepInEx.dll's TypeLoader.FindPluginTypes), so any DLL in
 * any subfolder of plugins/ - including the old "plugins/.disabled" - still gets loaded. That's
 * why 0.1.0's Vanilla profile never actually produced a vanilla game.
 *
 * (Ship mods are different: We Mod Any Ship only reads the top level of plugins/ShipMods, so a
 * subfolder would hide them - but keeping all disabled mods in one place is simpler to reason
 * about, so they move out too.)
 */
export function layoutFor(installPath) {
  const bepInEx = path.join(installPath, 'BepInEx');
  const plugins = path.join(bepInEx, 'plugins');
  const disabledRoot = path.join(bepInEx, 'disabled_mods');
  return {
    bepInEx,
    plugins,
    shipMods: path.join(plugins, 'ShipMods'),
    disabledPlugins: path.join(disabledRoot, 'plugins'),
    disabledShipMods: path.join(disabledRoot, 'ShipMods'),
    backups: path.join(bepInEx, 'achilles_backups'),
    // 0.1.0's locations - migrated away from on startup, never written to again.
    legacyDisabledPlugins: path.join(plugins, '.disabled'),
    legacyDisabledShipMods: path.join(plugins, 'ShipMods', '.disabled'),
  };
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Moves a file into achilles_backups/<timestamp>_<reason>/ instead of deleting or overwriting it.
 * Returns the backup path. Nothing this app does ever deletes a mod file outright. */
export function backupFile(layout, filePath, reason) {
  const dir = path.join(layout.backups, `${stamp()}_${reason}`);
  mkdirSync(dir, { recursive: true });
  let target = path.join(dir, path.basename(filePath));
  for (let n = 2; existsSync(target); n++) {
    const ext = path.extname(filePath);
    target = path.join(dir, `${path.basename(filePath, ext)} (${n})${ext}`);
  }
  renameSync(filePath, target);
  return target;
}

/** Moves anything 0.1.0 left in plugins/.disabled or ShipMods/.disabled to the new disabled
 * folders. If a same-named file already exists at the destination, the incoming copy goes to
 * backups rather than overwriting. The (now empty) legacy folders are left in place. */
export function migrateLegacyDisabledFolders(layout) {
  const moved = [];
  const pairs = [
    [layout.legacyDisabledPlugins, layout.disabledPlugins],
    [layout.legacyDisabledShipMods, layout.disabledShipMods],
  ];
  for (const [from, to] of pairs) {
    if (!existsSync(from)) continue;
    const files = readdirSync(from, { withFileTypes: true }).filter((e) => e.isFile());
    if (files.length === 0) continue;
    mkdirSync(to, { recursive: true });
    for (const f of files) {
      const src = path.join(from, f.name);
      const dest = path.join(to, f.name);
      if (existsSync(dest)) backupFile(layout, src, 'legacy-duplicate');
      else renameSync(src, dest);
      moved.push(f.name);
    }
  }
  return moved;
}
