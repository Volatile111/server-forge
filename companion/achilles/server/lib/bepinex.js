import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, copyFileSync, writeFileSync, statSync, openSync, readSync, closeSync, rmSync } from 'node:fs';
import path from 'node:path';
import { JsonStore } from './store.js';
import { readZip } from './zip.js';
import { gameBuildId } from './steam.js';
import { readVersionString, peArchitecture } from './peversion.js';
import { launchLogPaths, parseLaunchLog } from './gamelog.js';
import { compareVersions } from './updater.js';
import { checkAgainstLoader } from './inspect.js';
import { isGameRunning, closeGame, gamePids } from './gameprocess.js';
import { launchGame } from './game.js';

const RELEASES_API = 'https://api.github.com/repos/BepInEx/BepInEx/releases?per_page=100';
const RELEASES_TTL_MS = 6 * 3600 * 1000;

// Everything that IS the mod loader (as opposed to the user's mods, configs and our folders).
// Installing or rolling back BepInEx swaps exactly these and nothing else.
const LOADER_PATHS = ['BepInEx/core', 'BepInEx/cache', 'winhttp.dll', 'doorstop_config.ini', '.doorstop_version', 'changelog.txt'];

export const TEST_MODES = ['auto-rollback', 'ask', 'none'];

const TEST_TIMEOUT_MS = 180000;
const POLL_MS = 2000;

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const cleanVersion = (v) => (v ? String(v).replace(/^v/i, '').replace(/\+.*$/, '') : null);

/**
 * What the game runs on. BepInEx cares about THIS - the engine - not the game's build number:
 *   - backend: Mono games need a Mono build of BepInEx (5.x, or 6.x "Unity.Mono"); IL2CPP games
 *     need BepInEx 6 "Unity.IL2CPP" and completely different plugins.
 *   - arch: x64 game needs the x64 loader (winhttp.dll proxy of the same bitness).
 *   - Unity version: only matters if the developer upgrades Unity; a change is flagged.
 */
export function detectGameEngine(installPath) {
  const dataDir = path.join(installPath, 'Star Valor_Data');
  const backend = existsSync(path.join(installPath, 'GameAssembly.dll'))
    ? 'il2cpp'
    : existsSync(path.join(dataDir, 'Managed', 'Assembly-CSharp.dll')) ? 'mono' : 'unknown';
  let unityVersion = null;
  try {
    const fd = openSync(path.join(dataDir, 'globalgamemanagers'), 'r');
    const head = Buffer.alloc(256);
    readSync(fd, head, 0, 256, 0);
    closeSync(fd);
    unityVersion = head.toString('latin1').match(/\d{4}\.\d+\.\d+[abfp]\d+/)?.[0] ?? null;
  } catch {}
  return { backend, arch: peArchitecture(path.join(installPath, 'Star Valor.exe')), unityVersion, gameBuild: gameBuildId(installPath) };
}

/** The download of a release that fits this game's engine, or null if it has none. */
function assetFor(release, engine) {
  const assets = release.assets ?? [];
  if (engine.backend === 'mono') {
    return (
      // BepInEx 5 is Mono-only: "BepInEx_win_x64_5.4.23.5.zip", older "BepInEx_x64_5.4.22.0.zip"
      assets.find((a) => new RegExp(`^BepInEx_(win_)?${engine.arch}_[\\d.]+\\.zip$`, 'i').test(a.name)) ??
      assets.find((a) => new RegExp(`^BepInEx-Unity\\.Mono-win-${engine.arch}-.+\\.zip$`, 'i').test(a.name))
    );
  }
  if (engine.backend === 'il2cpp') return assets.find((a) => new RegExp(`^BepInEx-Unity\\.IL2CPP-win-${engine.arch}-.+\\.zip$`, 'i').test(a.name));
  return null;
}

export class BepInExManager {
  constructor(dataDir, installPath, { modLibrary }) {
    this.installPath = installPath;
    this.modLibrary = modLibrary;
    this.cacheDir = path.join(dataDir, 'bepinex-cache');
    this.backups = path.join(installPath, 'BepInEx', 'achilles_backups');
    this.releasesStore = new JsonStore(dataDir, 'bepinex-releases.json', { fetchedAt: 0, releases: [] });
    this.evalStore = new JsonStore(dataDir, 'bepinex-evals.json', { evals: {} });
    this.history = new JsonStore(dataDir, 'bepinex-history.json', {
      launches: [],
      installs: [],
      pending: null,
      testMode: 'auto-rollback',
      lastEngine: null,
      buildsSeen: [],
    });
    this.test = null; // in-memory state of a running/finished test launch
  }

  // ---- What's installed ----------------------------------------------------------------------

  installedVersion() {
    const core = path.join(this.installPath, 'BepInEx', 'core');
    const v5 = path.join(core, 'BepInEx.dll');
    const v6 = path.join(core, 'BepInEx.Core.dll');
    const dll = existsSync(v5) ? v5 : existsSync(v6) ? v6 : null;
    if (!dll) return null;
    // If we installed it, we know its release tag (BepInEx 6 builds report "6.0.0-be.697"
    // internally rather than the "6.0.0-pre.2" tag people know it by).
    const md5 = createHash('md5').update(readFileSync(dll)).digest('hex');
    const ours = [...this.history.read().installs].reverse().find((i) => i.coreMd5 === md5);
    return ours?.version ?? cleanVersion(readVersionString(dll, 'ProductVersion'));
  }

  // ---- Releases ------------------------------------------------------------------------------

  async releases({ refresh = false } = {}) {
    const cached = this.releasesStore.read();
    if (!refresh && cached.releases.length && Date.now() - cached.fetchedAt < RELEASES_TTL_MS) return cached.releases;
    try {
      const res = await fetch(RELEASES_API, { headers: { 'User-Agent': 'AchillesModManager/0.3.0', Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
      const list = (await res.json())
        .filter((r) => !r.draft)
        .map((r) => ({
          tag: r.tag_name,
          version: cleanVersion(r.tag_name),
          prerelease: Boolean(r.prerelease),
          publishedAt: r.published_at,
          url: r.html_url,
          notes: (r.body ?? '').slice(0, 2000),
          assets: (r.assets ?? []).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size })),
        }));
      this.releasesStore.write({ fetchedAt: Date.now(), releases: list });
      return list;
    } catch (err) {
      if (cached.releases.length) return cached.releases; // offline: last known list is fine
      throw new Error(`Couldn't get the BepInEx release list from GitHub (${err.message}).`);
    }
  }

  /** Releases that have a build for this game's engine, newest first. */
  async candidates(opts) {
    const engine = detectGameEngine(this.installPath);
    return (await this.releases(opts))
      .map((r) => ({ ...r, asset: assetFor(r, engine) ?? null }))
      .filter((r) => r.asset)
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  }

  async _candidate(version) {
    const c = (await this.candidates()).find((x) => x.version === version);
    if (!c) throw new Error(`BepInEx ${version} has no download that fits Star Valor.`);
    return c;
  }

  /** Downloads (once) and unpacks a release into the cache. Returns the unpacked folder. */
  async _unpacked(candidate) {
    const dir = path.join(this.cacheDir, candidate.version);
    const out = path.join(dir, 'files');
    if (existsSync(path.join(out, 'BepInEx', 'core'))) return out;
    mkdirSync(dir, { recursive: true });
    const zipPath = path.join(dir, candidate.asset.name);
    if (!existsSync(zipPath)) {
      const res = await fetch(candidate.asset.url, { headers: { 'User-Agent': 'AchillesModManager/0.3.0' } });
      if (!res.ok) throw new Error(`Downloading BepInEx ${candidate.version} failed (HTTP ${res.status}).`);
      writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
    }
    rmSync(out, { recursive: true, force: true });
    for (const entry of readZip(zipPath)) {
      const rel = path.posix.normalize(entry.name);
      if (rel.startsWith('..') || path.posix.isAbsolute(rel)) continue; // never write outside the folder
      const dest = path.join(out, ...rel.split('/'));
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, entry.data);
    }
    if (!existsSync(path.join(out, 'BepInEx', 'core')) || !existsSync(path.join(out, 'winhttp.dll'))) {
      throw new Error(`The BepInEx ${candidate.version} download doesn't look like a normal BepInEx install.`);
    }
    return out;
  }

  // ---- Will my mods work on version X? -------------------------------------------------------

  _pluginPaths() {
    return this.modLibrary.list().filter((m) => m.kind === 'plugin').map((m) => ({ mod: m, path: this.modLibrary.locate(m).currentPath }));
  }

  _modsKey(plugins) {
    return createHash('md5')
      .update(plugins.map(({ path: p }) => (existsSync(p) ? `${p}:${statSync(p).size}:${Math.floor(statSync(p).mtimeMs)}` : p)).join('|'))
      .digest('hex');
  }

  cachedEvaluation(version) {
    const plugins = this._pluginPaths();
    return this.evalStore.read().evals[`${version}|${this._modsKey(plugins)}`] ?? null;
  }

  /** Checks every installed plugin (on or off) against a BepInEx version's own files. */
  async evaluate(version) {
    const cached = this.cachedEvaluation(version);
    if (cached) return cached;
    const candidate = await this._candidate(version);
    const files = await this._unpacked(candidate);
    const plugins = this._pluginPaths();
    const results = await checkAgainstLoader(this.installPath, path.join(files, 'BepInEx', 'core'), version, plugins.map((p) => p.path));
    const mods = plugins.map(({ mod, path: p }) => ({
      modId: mod.id,
      filename: mod.filename,
      enabled: mod.enabled,
      problems: results.get(p)?.problems ?? [],
      error: results.get(p)?.error ?? null,
    }));
    const evaluation = {
      version,
      checkedAt: new Date().toISOString(),
      enabledTotal: mods.filter((m) => m.enabled).length,
      enabledBroken: mods.filter((m) => m.enabled && m.problems.length).length,
      mods,
    };
    this.evalStore.update((d) => {
      d.evals[`${version}|${this._modsKey(plugins)}`] = evaluation;
      return d;
    });
    return evaluation;
  }

  // ---- Launch history: which BepInEx actually worked on which game build ----------------------

  /** Reads Unity's last two launch logs into the history (once each). The game build recorded is
   * the one installed when the log is first seen - fine in practice since both logs are recent. */
  recordLaunches() {
    const build = gameBuildId(this.installPath);
    const engine = detectGameEngine(this.installPath);
    this.history.update((h) => {
      for (const logPath of launchLogPaths(this.installPath)) {
        const log = parseLaunchLog(logPath);
        if (h.launches.some((l) => l.loggedAt === log.loggedAt)) continue;
        const startupErrors = log.exceptions.filter((e) => e.phase === 'startup');
        h.launches.push({
          loggedAt: log.loggedAt,
          gameBuild: build,
          bepInExVersion: log.bepInExVersion,
          chainloaderComplete: log.chainloaderComplete,
          reachedMenu: log.reachedMenu,
          pluginCount: log.loadedPlugins.length,
          startupErrors: startupErrors.map((e) => `${e.type}: ${e.message}`).slice(0, 3),
          ok: Boolean(log.bepInExVersion && log.chainloaderComplete && log.reachedMenu && startupErrors.length === 0),
        });
      }
      h.launches.sort((a, b) => Date.parse(a.loggedAt) - Date.parse(b.loggedAt));
      h.launches = h.launches.slice(-200);

      // An install left untested ("none" mode) gets its verdict from the next real launch.
      if (h.pending && !h.pending.result) {
        const after = h.launches.filter((l) => Date.parse(l.loggedAt) > Date.parse(h.pending.at) && l.bepInExVersion === h.pending.version);
        const last = after[after.length - 1];
        if (last?.ok) h.pending = null;
        else if (last) h.pending.result = { ok: false, reason: last.startupErrors[0] ?? (last.chainloaderComplete ? 'The game never reached the main menu.' : 'BepInEx didn\'t finish loading.'), at: last.loggedAt };
      }

      if (build && !h.buildsSeen.includes(build)) h.buildsSeen.push(build);
      if (!h.lastEngine) h.lastEngine = engine;
      return h;
    });
  }

  /** 'verified' | 'failed' | 'untested' for a BepInEx version on a game build, from real launches. */
  verdict(version, build) {
    const runs = this.history.read().launches.filter((l) => l.bepInExVersion === version && l.gameBuild === build);
    if (runs.length === 0) return { state: 'untested' };
    const last = runs[runs.length - 1];
    return { state: last.ok ? 'verified' : 'failed', lastAt: last.loggedAt, okCount: runs.filter((r) => r.ok).length, runs: runs.length, lastError: last.startupErrors[0] ?? null };
  }

  // ---- Status for the UI ---------------------------------------------------------------------

  async status({ refresh = false } = {}) {
    this.recordLaunches();
    const h = this.history.read();
    const engine = detectGameEngine(this.installPath);
    const installed = this.installedVersion();
    const build = engine.gameBuild;

    let candidates = [];
    let releasesError = null;
    try {
      candidates = await this.candidates({ refresh });
    } catch (err) {
      releasesError = err.message;
    }

    const versions = candidates.map((c) => ({
      version: c.version,
      prerelease: c.prerelease,
      publishedAt: c.publishedAt,
      url: c.url,
      notes: c.notes,
      major: Number(c.version.split('.')[0]),
      installed: c.version === installed,
      verdict: this.verdict(c.version, build),
      evaluation: this.cachedEvaluation(c.version),
    }));

    const installedMajor = installed ? Number(installed.split('.')[0]) : null;
    const newestStable = versions.find((v) => !v.prerelease && (installedMajor === null || v.major === installedMajor)) ?? versions.find((v) => !v.prerelease);

    const engineChanged =
      h.lastEngine && (h.lastEngine.backend !== engine.backend || h.lastEngine.arch !== engine.arch || h.lastEngine.unityVersion !== engine.unityVersion)
        ? { from: h.lastEngine, to: engine }
        : null;
    const verdictInstalled = installed ? this.verdict(installed, build) : { state: 'untested' };
    const verifiedBuilds = [...new Set(h.launches.filter((l) => l.ok && l.bepInExVersion === installed).map((l) => l.gameBuild))];
    const gameUpdated = verdictInstalled.state === 'untested' && verifiedBuilds.length > 0 && !verifiedBuilds.includes(build) ? { verifiedOn: verifiedBuilds[verifiedBuilds.length - 1], now: build } : null;

    return {
      engine,
      engineChanged,
      fits: engine.backend === 'mono' ? `BepInEx 5 (or 6 "Unity.Mono") - ${engine.arch}` : engine.backend === 'il2cpp' ? `BepInEx 6 "Unity.IL2CPP" - ${engine.arch}` : 'unknown',
      installed: installed && { version: installed, verdict: verdictInstalled, verifiedBuilds },
      pending: h.pending,
      gameUpdated,
      testMode: h.testMode,
      test: this.test,
      releasesError,
      versions,
      recommendation: this._recommend({ installed, verdictInstalled, versions, newestStable, engine, pending: h.pending, gameUpdated, build }),
      lastLaunch: h.launches[h.launches.length - 1] ?? null,
    };
  }

  _recommend({ installed, verdictInstalled, versions, newestStable, engine, pending, gameUpdated, build }) {
    if (engine.backend === 'il2cpp') {
      return { tone: 'bad', action: 'none', text: 'Star Valor now runs on IL2CPP. BepInEx 5 and every current plugin stop working on IL2CPP games - mods need new builds for BepInEx 6 IL2CPP.' };
    }
    if (!installed) {
      return newestStable
        ? { tone: 'warn', action: 'install', version: newestStable.version, text: `BepInEx isn't installed. BepInEx ${newestStable.version} fits Star Valor.` }
        : { tone: 'warn', action: 'none', text: 'BepInEx isn\'t installed.' };
    }
    if (pending?.result && !pending.result.ok) {
      return { tone: 'bad', action: 'rollback', version: pending.previous, text: `BepInEx ${pending.version} failed: ${pending.result.reason} Roll back to ${pending.previous ?? 'the previous version'}.` };
    }
    if (pending) {
      return { tone: 'warn', action: 'test', text: `BepInEx ${pending.version} is installed but hasn't been tested yet.` };
    }
    if (verdictInstalled.state === 'failed') {
      const good = versions.find((v) => v.verdict.state === 'verified' && !v.installed);
      return good
        ? { tone: 'bad', action: 'install', version: good.version, text: `BepInEx ${installed} failed on the last launch. ${good.version} worked on this game build before.` }
        : { tone: 'bad', action: 'test', text: `The last launch with BepInEx ${installed} failed${verdictInstalled.lastError ? ` (${verdictInstalled.lastError})` : ''}. Check the Mods tab - it may be a mod rather than BepInEx.` };
    }
    if (gameUpdated) {
      return { tone: 'warn', action: 'test', text: `Star Valor updated (build ${gameUpdated.verifiedOn} → ${gameUpdated.now}). BepInEx ${installed} worked on the old build but hasn't been run on this one yet.` };
    }
    if (newestStable && compareVersions(newestStable.version, installed) === 1) {
      const ev = newestStable.evaluation;
      if (!ev) return { tone: 'info', action: 'check', version: newestStable.version, text: `BepInEx ${newestStable.version} is out. Check whether your mods work with it before installing.` };
      if (ev.enabledBroken > 0) return { tone: 'info', action: 'none', version: newestStable.version, text: `BepInEx ${newestStable.version} is out, but ${ev.enabledBroken} of your ${ev.enabledTotal} enabled mods wouldn't work with it. Staying on ${installed} is the safe choice.` };
      return { tone: 'good', action: 'install', version: newestStable.version, text: `BepInEx ${newestStable.version} is out and all ${ev.enabledTotal} of your enabled mods check out against it.` };
    }
    const v = verdictInstalled.state === 'verified' ? ' and verified on this game build' : '';
    return { tone: 'good', action: 'none', text: `You're on BepInEx ${installed}, the newest version that fits Star Valor${v}. Nothing to do.` };
  }

  // ---- Settings ------------------------------------------------------------------------------

  setTestMode(mode) {
    if (!TEST_MODES.includes(mode)) throw new Error('Unknown test mode.');
    this.history.update((h) => ({ ...h, testMode: mode }));
  }

  // ---- Install / roll back -------------------------------------------------------------------

  async _assertGameClosed(action) {
    if (await isGameRunning()) throw new Error(`Close Star Valor first - BepInEx's files are in use while the game runs, so they can't be ${action}.`);
  }

  _moveLoaderFiles(fromRoot, toRoot) {
    const moved = [];
    for (const rel of LOADER_PATHS) {
      const src = path.join(fromRoot, ...rel.split('/'));
      if (!existsSync(src)) continue;
      const dest = path.join(toRoot, ...rel.split('/'));
      mkdirSync(path.dirname(dest), { recursive: true });
      renameSync(src, dest);
      moved.push(rel);
    }
    return moved;
  }

  _copyTree(from, to) {
    for (const e of readdirSync(from, { withFileTypes: true })) {
      const s = path.join(from, e.name);
      const d = path.join(to, e.name);
      if (e.isDirectory()) {
        mkdirSync(d, { recursive: true });
        this._copyTree(s, d);
      } else {
        copyFileSync(s, d);
      }
    }
  }

  /** Swaps in a BepInEx version. Only the loader itself changes (core, doorstop, winhttp.dll);
   * plugins, configs and everything else stay. The old loader goes to achilles_backups. */
  async install(version) {
    await this._assertGameClosed('replaced');
    const candidate = await this._candidate(version);
    const files = await this._unpacked(candidate);
    const previous = this.installedVersion();

    const backupDir = path.join(this.backups, `${stamp()}_bepinex-${previous ?? 'none'}`);
    const moved = this._moveLoaderFiles(this.installPath, backupDir);
    try {
      this._copyTree(files, this.installPath);
    } catch (err) {
      // Put the old loader straight back rather than leave a half-installed one.
      for (const rel of LOADER_PATHS) rmSync(path.join(this.installPath, ...rel.split('/')), { recursive: true, force: true });
      this._moveLoaderFiles(backupDir, this.installPath);
      throw new Error(`Installing BepInEx ${version} failed and the previous version was restored: ${err.message}`);
    }

    const coreDll = ['BepInEx.dll', 'BepInEx.Core.dll'].map((f) => path.join(this.installPath, 'BepInEx', 'core', f)).find(existsSync);
    const coreMd5 = coreDll ? createHash('md5').update(readFileSync(coreDll)).digest('hex') : null;
    const at = new Date().toISOString();
    this.history.update((h) => {
      h.installs.push({ action: 'install', version, previous, backupDir, moved, coreMd5, at, gameBuild: gameBuildId(this.installPath) });
      h.pending = { version, previous, backupDir, at };
      return h;
    });
    return { version, previous, backupDir };
  }

  /** Puts back the BepInEx that was replaced by the last install. */
  async rollback({ closeRunningGame = false } = {}) {
    if (closeRunningGame) await closeGame();
    await this._assertGameClosed('rolled back');
    const h = this.history.read();
    const target = h.pending ?? [...h.installs].reverse().find((i) => i.action === 'install' && existsSync(i.backupDir));
    if (!target || !existsSync(target.backupDir)) throw new Error('There\'s no earlier BepInEx backup to roll back to.');

    const current = this.installedVersion();
    const setAside = path.join(this.backups, `${stamp()}_bepinex-${current ?? 'unknown'}-rolled-back`);
    this._moveLoaderFiles(this.installPath, setAside);
    this._moveLoaderFiles(target.backupDir, this.installPath);

    this.history.update((d) => {
      d.installs.push({ action: 'rollback', version: target.previous, previous: current, backupDir: setAside, at: new Date().toISOString() });
      d.pending = null;
      return d;
    });
    return { restored: target.previous, setAside };
  }

  // ---- Test launch ---------------------------------------------------------------------------

  /**
   * Launches the game through Steam and watches Player.log until it either reaches the main menu
   * with BepInEx and the plugins loaded (pass) or doesn't (fail). What happens on failure depends
   * on the chosen mode:
   *   auto-rollback - close the test launch and restore the previous BepInEx automatically
   *   ask           - report it; the Roll back button restores it (closing the game if needed)
   * On success the game is left running.
   *
   * `explain(log)` (optional) names the mods behind startup errors, so a failure caused by a mod
   * isn't mistaken for a BepInEx problem.
   */
  async startTest({ explain } = {}) {
    if (this.test?.running) throw new Error('A test launch is already running.');
    if (await isGameRunning()) throw new Error('Close Star Valor first so the test starts from a fresh launch.');

    const expected = this.installedVersion();
    const mode = this.history.read().testMode;
    const pending = this.history.read().pending;
    const logPath = launchLogPaths(this.installPath).find((p) => p.endsWith('Player.log'));
    const logBefore = logPath && existsSync(logPath) ? statSync(logPath).mtimeMs : 0;
    const startedAt = Date.now();

    this.test = { running: true, startedAt: new Date(startedAt).toISOString(), expected, mode, phase: 'Starting Star Valor through Steam…', result: null };
    launchGame();

    const finish = async (ok, reason, extra = {}) => {
      const result = { ok, reason, ...extra };
      if (!ok && pending && mode === 'auto-rollback') {
        this.test.phase = 'Test failed - closing the test launch and restoring the previous BepInEx…';
        try {
          await closeGame();
          const rb = await this.rollback();
          result.rolledBack = rb.restored;
        } catch (err) {
          result.rollbackError = err.message;
        }
      } else if (!ok && pending) {
        this.history.update((h) => {
          if (h.pending) h.pending.result = { ok: false, reason, at: new Date().toISOString() };
          return h;
        });
        result.canRollback = true;
      }
      if (ok) this.history.update((h) => ({ ...h, pending: null }));
      this.recordLaunches();
      this.test = { ...this.test, running: false, phase: ok ? 'Passed' : 'Failed', result, finishedAt: new Date().toISOString() };
    };

    const tick = async () => {
      try {
        const elapsed = Date.now() - startedAt;
        const fresh = logPath && existsSync(logPath) && statSync(logPath).mtimeMs > logBefore;
        const running = (await gamePids()).length > 0;

        if (!fresh) {
          if (elapsed > 90000) return finish(false, running ? 'The game started but never wrote a log.' : 'The game didn\'t start - is Steam running?');
          this.test.phase = running ? 'Game is starting…' : 'Waiting for Steam to start the game…';
          return setTimeout(tick, POLL_MS);
        }

        const log = parseLaunchLog(logPath);
        const startupErrors = log.exceptions.filter((e) => e.phase === 'startup');
        if (log.bepInExVersion && expected && log.bepInExVersion !== expected) {
          return finish(false, `The game loaded BepInEx ${log.bepInExVersion}, not ${expected}.`);
        }
        if (startupErrors.length) {
          const blame = explain?.(log) ?? [];
          const e = startupErrors[0];
          return finish(false, `Error before the main menu: ${e.type}: ${e.message}`, { blame });
        }
        if (log.chainloaderComplete && log.reachedMenu) {
          return finish(true, `Reached the main menu with BepInEx ${log.bepInExVersion} and ${log.loadedPlugins.length} plugin${log.loadedPlugins.length === 1 ? '' : 's'} loaded.`, { plugins: log.loadedPlugins.length });
        }
        if (!running && elapsed > 15000) return finish(false, 'The game closed before reaching the main menu.');
        if (!log.bepInExVersion && elapsed > 60000) return finish(false, 'BepInEx never started - the game ran without the mod loader (winhttp.dll/doorstop didn\'t load).');
        if (elapsed > TEST_TIMEOUT_MS) return finish(false, 'Timed out waiting for the main menu.');

        this.test.phase = !log.bepInExVersion ? 'Game is starting…' : !log.chainloaderComplete ? `BepInEx ${log.bepInExVersion} is loading plugins…` : 'Plugins loaded - waiting for the main menu…';
        setTimeout(tick, POLL_MS);
      } catch (err) {
        finish(false, `Test error: ${err.message}`);
      }
    };
    setTimeout(tick, POLL_MS);
    return this.test;
  }
}
