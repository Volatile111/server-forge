import { existsSync, statSync } from 'node:fs';
import { exceptionsForPlugin } from './gamelog.js';

export const SHIPMOD_LOADER_GUID = 'mc.starvalor.wemodanyshipdotcom';

const LEVEL_RANK = { ok: 0, info: 1, warn: 2, broken: 3 };
const worst = (a, b) => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a);

/**
 * Turns everything known about each mod into one verdict the UI can show:
 *   ok     - nothing wrong found
 *   warn   - will probably load, but something's off (errors last launch, missing soft setup...)
 *   broken - won't work on this game version / crashed it / can't load
 *   unknown- couldn't be inspected
 *
 * Two independent signals, because each catches what the other can't:
 *   1. Static scan (inspect-plugins.ps1): references to game code that no longer exists. Catches
 *      renamed/removed classes BEFORE you launch - e.g. Player Warp-In's use of JumpGateControl.
 *   2. The last launch's log: exceptions whose stack trace runs through the mod. Catches data
 *      drift no static check can see - e.g. We Mod Any Ship 1.2.0's duplicate-key crash.
 * Log findings are ignored for a mod whose file changed after that launch (it's been updated or
 * replaced since, so the old error says nothing about the current file).
 */
export function computeCompat({ mods, pathOf, inspections, lastLaunch }) {
  const enabledPlugins = mods.filter((m) => m.kind === 'plugin' && m.enabled);
  const guidOf = (m) => inspections.get(pathOf(m))?.guid ?? null;
  const enabledGuids = new Map();
  for (const m of enabledPlugins) {
    const g = guidOf(m);
    if (!g) continue;
    enabledGuids.set(g, [...(enabledGuids.get(g) ?? []), m]);
  }
  const allByGuid = new Map(mods.filter((m) => m.kind === 'plugin').map((m) => [guidOf(m), m]).filter(([g]) => g));
  const logTime = lastLaunch ? Date.parse(lastLaunch.loggedAt) : 0;

  const out = new Map();
  for (const mod of mods) {
    const issues = [];
    const add = (level, text, extra = {}) => issues.push({ level, text, ...extra });

    if (mod.hasDisabledDuplicate) add('info', 'An old disabled copy of this file also exists - the enabled one is what the game uses.');

    if (mod.kind === 'shipmod') {
      // We Mod Any Ship renames a ship file it fails to load to "ERR<name>" - and since it still
      // scans those, it fails again and adds another "ERR" every launch (seen: 25 in a row).
      const errPrefix = mod.filename.match(/^(?:ERR)+/)?.[0];
      if (errPrefix) {
        const real = mod.filename.slice(errPrefix.length);
        const regenerated = mods.some((m) => m.kind === 'shipmod' && m.filename.toLowerCase() === real.toLowerCase());
        add(
          'broken',
          `We Mod Any Ship failed to load this file ${errPrefix.length / 3} time${errPrefix.length === 3 ? '' : 's'} and renamed it with "ERR" each time.` +
            (regenerated ? ` A working "${real}" exists alongside it. Turn this one off to stop the renaming.` : ' Turn it off to stop the renaming.')
        );
      }
      if (mod.enabled && !enabledGuids.has(SHIPMOD_LOADER_GUID)) {
        add('warn', allByGuid.has(SHIPMOD_LOADER_GUID) ? 'Ship mods only work while "We Mod Any Ship" is enabled - it\'s currently off.' : 'Ship mods need the "We Mod Any Ship" plugin, which isn\'t installed.');
      }
      out.set(mod.id, finish(issues, null));
      continue;
    }

    const p = pathOf(mod);
    const info = inspections.get(p);
    if (!info || !info.ok) {
      add('unknown', `Couldn't inspect this file${info?.error ? `: ${info.error}` : '.'}`);
      out.set(mod.id, finish(issues, info));
      continue;
    }
    if (!info.isPlugin) {
      add('info', 'Library, not a plugin by itself - other mods use it.');
      out.set(mod.id, finish(issues, info));
      continue;
    }

    for (const prob of info.problems) {
      add('broken', prob.detail, { where: prob.where, source: 'scan' });
    }

    if (info.processes.length > 0 && !info.processes.some((x) => x.toLowerCase() === 'star valor.exe')) {
      add('broken', `Made for a different game (${info.processes.join(', ')}) - BepInEx will skip it.`);
    }

    for (const dep of info.dependencies) {
      if (!dep.hard || enabledGuids.has(dep.guid)) continue;
      const installed = allByGuid.get(dep.guid);
      add('broken', installed ? `Needs "${installed.filename}", which is disabled.` : `Needs another mod (${dep.guid}) that isn't installed.`);
    }

    for (const bad of info.incompatibilities) {
      if (enabledGuids.has(bad)) add('warn', `Declares itself incompatible with "${enabledGuids.get(bad)[0].filename}", which is enabled.`);
    }

    if (mod.enabled && (enabledGuids.get(info.guid)?.length ?? 0) > 1) {
      add('warn', `More than one enabled file is this same plugin (${info.guid}) - BepInEx only loads one of them.`);
    }

    // ---- last launch ----
    const changedSince = existsSync(p) && statSync(p).mtimeMs > logTime;
    if (lastLaunch && !changedSince) {
      const exs = exceptionsForPlugin(lastLaunch, info);
      const sure = exs.filter((e) => e.how !== 'patched');
      const text = (e) => `${e.type}: ${e.message}`;

      const startup = sure.find((e) => e.phase === 'startup');
      if (startup) add('broken', `Stopped the game reaching the main menu on the last launch - ${text(startup)}`, { source: 'log' });
      const loading = sure.find((e) => e.phase === 'loading');
      if (loading) add('broken', `Caused an error while loading your save on the last launch - ${text(loading)}`, { source: 'log' });
      const play = sure.filter((e) => e.phase === 'play');
      if (play.length > 0) {
        const total = play.reduce((n, e) => n + e.count, 0);
        add('warn', `Threw ${total} error${total === 1 ? '' : 's'} while playing on the last launch (first: ${text(play[0])})`, { source: 'log' });
      }
      const maybe = exs.find((e) => e.how === 'patched');
      if (maybe && sure.length === 0) {
        add('warn', `An error happened inside a game method this mod changes, so it may be involved - ${text(maybe)}`, { source: 'log' });
      }
      for (const li of lastLaunch.loaderIssues) {
        if (li.pluginName && li.pluginName === info.name) add(li.level === 'warning' ? 'warn' : 'broken', `BepInEx: ${li.message}`, { source: 'log' });
      }
    }

    out.set(mod.id, finish(issues, info));
  }
  return out;
}

function finish(issues, info) {
  let level = 'ok';
  for (const i of issues) if (i.level !== 'unknown') level = worst(level, i.level);
  if (issues.some((i) => i.level === 'unknown') && level === 'ok') level = 'unknown';
  if (level === 'info') level = 'ok';
  return {
    level,
    issues,
    plugin: info && info.isPlugin ? { guid: info.guid, name: info.name, version: info.version } : null,
  };
}
