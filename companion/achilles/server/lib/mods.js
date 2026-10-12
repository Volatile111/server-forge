import { existsSync, mkdirSync, readdirSync, renameSync, copyFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonStore } from './store.js';
import { layoutFor, backupFile, migrateLegacyDisabledFolders } from './layout.js';
import { readZip } from './zip.js';

// A "mod" is one file: a BepInEx plugin .dll (anywhere under BepInEx/plugins, since BepInEx loads
// subfolders too) or a .shipmod ship definition (top level of plugins/ShipMods, which is all
// We Mod Any Ship reads). Disabled mods live under BepInEx/disabled_mods, mirroring the same
// relative path - see layout.js for why they can't stay inside plugins/.
//
// Nothing here deletes a mod file. Removing, replacing or un-duplicating a mod moves the old file
// into BepInEx/achilles_backups/<timestamp>_<reason>/.

function kindOf(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.dll') return 'plugin';
  if (ext === '.shipmod') return 'shipmod';
  return null;
}

const keyOf = (kind, relPath) => `${kind}|${relPath.replace(/\\/g, '/').toLowerCase()}`;

export class ModLibrary {
  constructor(dataDir, installPath) {
    this.layout = layoutFor(installPath);
    this.store = new JsonStore(dataDir, 'mods.json', { mods: [] });
    this.migrated = migrateLegacyDisabledFolders(this.layout);
    for (const dir of [this.layout.plugins, this.layout.shipMods, this.layout.disabledPlugins, this.layout.disabledShipMods]) {
      mkdirSync(dir, { recursive: true });
    }
    this.sync();
  }

  _baseDirs(kind) {
    return kind === 'shipmod'
      ? { enabled: this.layout.shipMods, disabled: this.layout.disabledShipMods }
      : { enabled: this.layout.plugins, disabled: this.layout.disabledPlugins };
  }

  /** Plugin DLLs anywhere under a folder (BepInEx loads subfolders), as paths relative to it. The
   * ShipMods folder and 0.1.0's leftover .disabled folders are skipped. */
  _pluginFiles(root) {
    const out = [];
    const walk = (dir, rel) => {
      if (!existsSync(dir)) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!rel && (e.name.toLowerCase() === 'shipmods' || e.name === '.disabled')) continue;
          walk(path.join(dir, e.name), childRel);
        } else if (e.isFile() && kindOf(e.name) === 'plugin') {
          out.push(childRel);
        }
      }
    };
    walk(root, '');
    return out;
  }

  _shipModFiles(root) {
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isFile() && kindOf(e.name) === 'shipmod')
      .map((e) => e.name);
  }

  /** Rescans disk and reconciles mods.json with it. If the same mod exists both enabled and
   * disabled, the ENABLED copy is the truth (it's what the game actually loads) and the entry is
   * flagged - 0.1.0 let the disabled copy win, which left mods stuck "off" while still loading. */
  sync() {
    const found = new Map();
    const note = (kind, relPath, enabled) => {
      const key = keyOf(kind, relPath);
      const prev = found.get(key);
      if (prev) {
        prev.hasDisabledDuplicate = true;
        if (enabled) prev.enabled = true;
        return;
      }
      found.set(key, { kind, relPath, enabled, hasDisabledDuplicate: false });
    };
    for (const f of this._pluginFiles(this.layout.plugins)) note('plugin', f, true);
    for (const f of this._shipModFiles(this.layout.shipMods)) note('shipmod', f, true);
    for (const f of this._pluginFiles(this.layout.disabledPlugins)) note('plugin', f, false);
    for (const f of this._shipModFiles(this.layout.disabledShipMods)) note('shipmod', f, false);

    return this.store.update((data) => {
      const byKey = new Map(data.mods.map((m) => [keyOf(m.kind, m.relPath ?? m.filename), m]));
      const mods = [];
      for (const [key, f] of found) {
        const existing = byKey.get(key);
        const mod = existing ?? { id: randomUUID(), addedAt: new Date().toISOString() };
        Object.assign(mod, {
          kind: f.kind,
          relPath: f.relPath,
          filename: path.basename(f.relPath),
          enabled: f.enabled,
          hasDisabledDuplicate: f.hasDisabledDuplicate,
        });
        mods.push(mod);
      }
      data.mods = mods;
      return data;
    }).mods;
  }

  list() {
    return this.sync();
  }

  get(modId) {
    const mod = this.store.read().mods.find((m) => m.id === modId);
    if (!mod) throw new Error('Mod not found.');
    return mod;
  }

  /** Absolute paths of a mod's enabled and disabled locations, and where it currently is. */
  locate(mod) {
    const base = this._baseDirs(mod.kind);
    const rel = (mod.relPath ?? mod.filename).split('/');
    const enabledPath = path.join(base.enabled, ...rel);
    const disabledPath = path.join(base.disabled, ...rel);
    return { enabledPath, disabledPath, currentPath: existsSync(enabledPath) ? enabledPath : disabledPath };
  }

  setEnabled(modId, enabled) {
    const mod = this.get(modId);
    const { enabledPath, disabledPath } = this.locate(mod);
    const from = enabled ? disabledPath : enabledPath;
    const to = enabled ? enabledPath : disabledPath;

    if (!existsSync(from)) {
      if (existsSync(to)) return this.sync().find((m) => m.id === modId); // already in the requested state
      throw new Error(`"${mod.filename}" is missing from disk.`);
    }
    if (existsSync(to)) backupFile(this.layout, to, 'duplicate');
    mkdirSync(path.dirname(to), { recursive: true });
    renameSync(from, to);
    return this.sync().find((m) => m.id === modId);
  }

  setManyEnabled(modIds, enabled) {
    for (const id of modIds) this.setEnabled(id, enabled);
    return this.sync();
  }

  /** "Remove" = move to backups. Recoverable from BepInEx/achilles_backups. */
  remove(modId) {
    const mod = this.get(modId);
    const { enabledPath, disabledPath } = this.locate(mod);
    for (const p of [enabledPath, disabledPath]) if (existsSync(p)) backupFile(this.layout, p, 'removed');
    this.sync();
  }

  /** Swaps a mod's file for a new one in the same place (enabled or disabled stays as it was),
   * backing the old one up first. Used by the updater and by re-downloads of an installed mod. */
  replaceFile(modId, newFilePath, reason = 'updated') {
    const mod = this.get(modId);
    const { currentPath } = this.locate(mod);
    const backup = existsSync(currentPath) ? backupFile(this.layout, currentPath, reason) : null;
    mkdirSync(path.dirname(currentPath), { recursive: true });
    copyFileSync(newFilePath, currentPath);
    this.sync();
    return { mod: this.get(modId), backup };
  }

  /**
   * Installs whatever the user dropped in or downloaded: a .dll, a .shipmod, or a .zip holding
   * any mix of them. A file matching a mod that's already installed (same plugin GUID, or same
   * filename) REPLACES that mod in place - so downloading a newer version from Nexus is an update,
   * not an "already installed" error.
   *
   * `identify(dllPath)` returns the plugin GUID of a DLL (from the inspector), or null.
   * `installedGuids` maps GUID -> modId for plugins currently installed.
   */
  async installIncoming(sourcePath, filenameHint, { identify, installedGuids }) {
    const filename = filenameHint || path.basename(sourcePath);
    const ext = path.extname(filename).toLowerCase();
    if (ext === '.7z' || ext === '.rar') throw new Error(`"${filename}" is a ${ext} archive - only .zip can be opened automatically. Extract it and drop the .dll/.shipmod files in.`);

    const work = mkdtempSync(path.join(tmpdir(), 'achilles-install-'));
    try {
      let items; // [{ file, relPath, kind }]
      if (ext === '.zip') {
        items = [];
        for (const entry of readZip(sourcePath)) {
          const kind = kindOf(entry.name);
          if (!kind) continue;
          const lower = entry.name.toLowerCase();
          if (/(^|\/)bepinex\/(core|patchers)\//.test(lower)) continue; // never touch the loader itself
          let rel;
          if (kind === 'shipmod') rel = path.posix.basename(entry.name);
          else {
            const i = lower.lastIndexOf('plugins/');
            rel = i >= 0 ? entry.name.slice(i + 'plugins/'.length) : path.posix.basename(entry.name);
          }
          const file = path.join(work, `${items.length}_${path.posix.basename(entry.name)}`);
          writeFileSync(file, entry.data);
          items.push({ file, relPath: rel, kind });
        }
        if (items.length === 0) throw new Error(`"${filename}" doesn't contain any .dll or .shipmod files.`);
      } else {
        const kind = kindOf(filename);
        if (!kind) throw new Error(`"${filename}" isn't a .dll, .shipmod or .zip file.`);
        items = [{ file: sourcePath, relPath: filename, kind }];
      }

      const installed = [];
      const replaced = [];
      const current = this.sync();
      for (const item of items) {
        let match = current.find((m) => m.kind === item.kind && m.filename.toLowerCase() === path.posix.basename(item.relPath).toLowerCase());
        if (item.kind === 'plugin') {
          const guid = await identify(item.file);
          if (guid && installedGuids.has(guid)) match = current.find((m) => m.id === installedGuids.get(guid)) ?? match;
        }
        if (match) {
          const { backup } = this.replaceFile(match.id, item.file, 'replaced');
          replaced.push({ filename: match.filename, modId: match.id, backup });
          continue;
        }
        const base = this._baseDirs(item.kind).enabled;
        const dest = path.join(base, ...item.relPath.split('/'));
        mkdirSync(path.dirname(dest), { recursive: true });
        copyFileSync(item.file, dest);
        installed.push(path.basename(dest));
      }
      this.sync();
      return { installed, replaced };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}
