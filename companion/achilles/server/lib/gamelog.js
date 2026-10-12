import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { unityLogFolder } from './steam.js';

const EXCEPTION_LINE = /^(?:\[(?:Error|Fatal)\s*:[^\]]*\]\s*)?([A-Za-z_][\w.]*(?:Exception|Error)):\s?(.*)$/;
const UNITY_FRAME = /^\s+at\s+(?:\(wrapper [^)]*\)\s+)?([^\s(]+)/;
const BEPINEX_FRAME = /^([A-Za-z_<][\w.`<>+|]*)\s*\(/; // "Main.Foo () (at <...>:0)" style, after "Stack trace:"
const BEPINEX_ISSUE = /^\[(Error|Warning|Fatal)\s*:\s*(BepInEx|HarmonyX)\]\s*(.*)$/;
const BRACKET_PLUGIN = /\[([^\]]+?) (\d[\w.-]*)\]/;

/**
 * Reads what happened on the most recent game launch. Unity's Player.log also contains
 * everything BepInEx logs, so one file covers both the game's own exceptions (with full stack
 * traces) and BepInEx's plugin-loading errors. Falls back to BepInEx/LogOutput.log if Player.log
 * isn't there.
 *
 * Returns null if no log exists yet (game never launched).
 */
export function readLastLaunch(installPath, logPathOverride = null) {
  const unityDir = unityLogFolder(installPath);
  const candidates = [logPathOverride, unityDir && path.join(unityDir, 'Player.log'), path.join(installPath, 'BepInEx', 'LogOutput.log')].filter(Boolean);
  const logPath = candidates.find((p) => existsSync(p));
  return logPath ? parseLaunchLog(logPath) : null;
}

/** Both launch logs Unity keeps - the latest (Player.log) and the one before it (Player-prev.log). */
export function launchLogPaths(installPath) {
  const unityDir = unityLogFolder(installPath);
  if (!unityDir) return [];
  return ['Player.log', 'Player-prev.log'].map((f) => path.join(unityDir, f)).filter((p) => existsSync(p));
}

export function parseLaunchLog(logPath) {
  const lines = readFileSync(logPath, 'utf8').split(/\r?\n/);
  const result = {
    logPath,
    loggedAt: statSync(logPath).mtime.toISOString(),
    bepInExVersion: null,
    unityVersion: null,
    chainloaderComplete: false,
    // Leaving the splash scene for the main menu makes Unity log "Unloading N Unused Serialized
    // files" - verified present on a launch that reached the menu and absent on one that died at
    // the splash screen. Only counts if it comes after BepInEx finished loading plugins.
    reachedMenu: false,
    loadedPlugins: [],
    exceptions: [],
    loaderIssues: [],
  };

  const byKey = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.includes('Chainloader startup complete')) result.chainloaderComplete = true;
    if (!result.reachedMenu && result.chainloaderComplete && /^Unloading \d+ Unused Serialized files/.test(line)) result.reachedMenu = true;
    const bep = !result.bepInExVersion && line.match(/\] BepInEx (\d[\w.+-]*) - /);
    if (bep) result.bepInExVersion = bep[1].replace(/\+.*$/, '');
    const engine = !result.unityVersion && line.match(/^Initialize engine version: (\S+)/);
    if (engine) result.unityVersion = engine[1];

    const loading = line.match(/^\[Info\s*:\s*BepInEx\] Loading \[(.+?) (\d[\w.-]*)\]/);
    if (loading) {
      result.loadedPlugins.push({ name: loading[1], version: loading[2] });
      continue;
    }

    const issue = line.match(BEPINEX_ISSUE);
    if (issue) {
      const plugin = issue[3].match(BRACKET_PLUGIN);
      result.loaderIssues.push({ level: issue[1].toLowerCase(), source: issue[2], message: issue[3].trim(), pluginName: plugin?.[1] ?? null });
      // Error lines can also start an exception block (handled below) - fall through.
    }

    const ex = line.match(EXCEPTION_LINE);
    if (!ex || line.startsWith('Fallback handler')) continue;

    const frames = [];
    let j = i + 1;
    let inBepInExTrace = false;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (/^Stack trace:/i.test(l)) {
        inBepInExTrace = true;
        continue;
      }
      const f = l.match(UNITY_FRAME) ?? (inBepInExTrace ? l.match(BEPINEX_FRAME) : null);
      if (f) frames.push(f[1]);
      else if (l.trim() === '' && frames.length === 0 && j === i + 1) continue;
      else break;
    }
    if (frames.length === 0) continue;
    i = j - 1;

    const key = `${ex[1]}|${ex[2]}|${frames.slice(0, 4).join('|')}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count++;
      continue;
    }
    const entry = { type: ex[1], message: ex[2].trim(), frames, count: 1, line: i + 1 };
    byKey.set(key, entry);
    result.exceptions.push(entry);
  }

  for (const ex of result.exceptions) ex.phase = phaseOf(ex.frames);
  return result;
}

// Where in the game's lifecycle an exception happened, judged from its stack. Note Unity's
// "Uploading Crash Report" line is just its error reporter - it appears for ordinary exceptions
// while the game keeps running, so it says nothing about whether the game actually died.
const STARTUP_FRAMES = /^(SplashControl|GameData\.LoadDatabase|[A-Za-z]+DB\.(LoadDatabase|ValidateDatabase)|BepInEx\.)/;
const LOADING_FRAMES = /^(GameLauncher\.|GameManager\.SetupGame|MenuControl\.LoadGame|GameData\.LoadGame|SaveLoad)/;

function phaseOf(frames) {
  if (frames.some((f) => STARTUP_FRAMES.test(f))) return 'startup';
  if (frames.some((f) => LOADING_FRAMES.test(f))) return 'loading';
  return 'play';
}

const isEngineFrame = (f) => /^(System\.|UnityEngine\.|Mono\.|HarmonyLib\.|MonoMod\.|\(wrapper)/.test(f);

/**
 * Which exceptions from the last launch this plugin is responsible for, and how sure we are:
 *   'direct'  - a stack frame is inside the plugin's own code
 *   'missing' - the error names a game member the plugin's scan found missing (Mono failed to
 *               compile the plugin's hook, so its frame never appears - blame lands on the game
 *               method being hooked, e.g. "GameManager.SetupGame")
 *   'patched' - the first game frame is a method this plugin hooks with Harmony (it may be involved)
 */
export function exceptionsForPlugin(lastLaunch, info) {
  if (!lastLaunch || !info) return [];
  const prefixes = (info.namespaces ?? []).map((ns) => `${ns}.`);
  const missing = info.missingMembers ?? [];
  const patches = new Set(info.patches ?? []);
  const out = [];
  for (const ex of lastLaunch.exceptions) {
    let how = null;
    if (ex.frames.some((f) => prefixes.some((p) => f.startsWith(p)))) how = 'direct';
    else if (/Missing(Field|Method|Member)Exception|TypeLoadException/.test(ex.type) && missing.some((m) => ex.message.includes(m))) how = 'missing';
    else {
      const firstGameFrame = ex.frames.find((f) => !isEngineFrame(f));
      if (firstGameFrame && patches.has(firstGameFrame)) how = 'patched';
    }
    if (how) out.push({ ...ex, how });
  }
  return out;
}
