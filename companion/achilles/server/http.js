import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

import { findStarValorInstallPath, looksLikeStarValorInstall, bepInExIsInstalled, gameBuildId, bepInExVersion } from './lib/steam.js';
import { ModLibrary } from './lib/mods.js';
import { ProfileStore } from './lib/profiles.js';
import { SaveLinkStore } from './lib/savelinks.js';
import { listSaveSlots } from './lib/saveinfo.js';
import { NexusClient, nexusBrowseUrl } from './lib/nexus.js';
import { launchGame } from './lib/game.js';
import { getBridgeStatus } from './lib/bridge.js';
import { PluginInspector } from './lib/inspect.js';
import { readLastLaunch, exceptionsForPlugin } from './lib/gamelog.js';
import { computeCompat } from './lib/compat.js';
import { Updater, parseSourceInput } from './lib/updater.js';
import { BepInExManager } from './lib/bepinex.js';
import { ShipEditor } from './lib/shipedit.js';

// Achilles' own version (0.3.0 was the last standalone app); since 0.4.0 it's part of SF Mod Manager.
export const APP_VERSION = '0.4.0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const MIME_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function sendJson(res, statusCode, body) {
  const text = JSON.stringify(body);
  res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Starts the local manager server: serves the UI (public/) as static files and a small JSON API
 * under /api. Runs entirely on 127.0.0.1 - it's a single-user desktop tool, not something meant to
 * be reachable from the network.
 *
 * Listens on a port the OS picks (port 0) unless told otherwise. 0.1.0 used a fixed port, so a
 * second copy of the app would fail to bind and its window would silently load the FIRST copy's
 * server. Resolves once actually listening, with the real port.
 *
 * `key`: every /api request must send it (X-Achilles-Key). The page gets it from SF Mod Manager in its URL
 * fragment; nothing else on the PC (or a web page guessing the port) can move mods around, launch the game or read
 * the Nexus key. The static UI files need no key.
 */
export function startServer(dataDir, { port = 0, key, hostVersion = null } = {}) {
  if (!key || key.length < 32) throw new Error('startServer needs a session key.');
  const installPath = findStarValorInstallPath();
  const installOk = looksLikeStarValorInstall(installPath);

  const modLibrary = installOk ? new ModLibrary(dataDir, installPath) : null;
  const inspector = installOk ? new PluginInspector(dataDir, installPath) : null;
  const profiles = new ProfileStore(dataDir);
  const saveLinks = new SaveLinkStore(dataDir);
  const nexus = new NexusClient(dataDir);
  const updater = installOk ? new Updater(dataDir, { modLibrary, inspector, nexus }) : null;
  const bepinex = installOk ? new BepInExManager(dataDir, installPath, { modLibrary }) : null;
  const ships = installOk ? new ShipEditor(dataDir, modLibrary) : null;

  // For test launches: which enabled mods a startup error points at (so a mod crash isn't
  // reported as "BepInEx doesn't work"). Uses the cached scans, so it's instant.
  let lastInspections = new Map();
  const explainLog = (log) => {
    const names = [];
    for (const m of modLibrary.list().filter((x) => x.kind === 'plugin' && x.enabled)) {
      const info = lastInspections.get(pathOf(m));
      if (info && exceptionsForPlugin(log, info).some((e) => e.phase === 'startup' && e.how !== 'patched')) names.push(info.name ?? m.filename);
    }
    return names;
  };

  // Latest update-check result per mod, so the mod list can show "update available" badges
  // between checks. Cleared for a mod whenever its file is replaced.
  const lastUpdate = new Map();

  function requireInstall() {
    if (!installOk) throw new Error('Star Valor install not found - is it installed through Steam on this PC?');
  }

  const pathOf = (mod) => modLibrary.locate(mod).currentPath;

  async function inspectInstalled(mods) {
    try {
      lastInspections = await inspector.inspect(mods.filter((m) => m.kind === 'plugin').map(pathOf));
      return lastInspections;
    } catch (err) {
      return new Map(mods.filter((m) => m.kind === 'plugin').map((m) => [pathOf(m), { ok: false, error: err.message }]));
    }
  }

  async function modsWithCompat() {
    const mods = modLibrary.list();
    const inspections = await inspectInstalled(mods);
    const lastLaunch = readLastLaunch(installPath);
    const compat = computeCompat({ mods, pathOf, inspections, lastLaunch });
    const edited = ships.editedFiles();
    return {
      mods: mods.map((m) => ({ ...m, compat: compat.get(m.id), update: lastUpdate.get(m.id) ?? null, source: updater.getSource(m.id), edited: edited.has(m.filename.toLowerCase()) })),
      lastLaunch: lastLaunch && {
        loggedAt: lastLaunch.loggedAt,
        chainloaderComplete: lastLaunch.chainloaderComplete,
        errorCounts: {
          startup: lastLaunch.exceptions.filter((e) => e.phase === 'startup').length,
          loading: lastLaunch.exceptions.filter((e) => e.phase === 'loading').length,
          play: lastLaunch.exceptions.filter((e) => e.phase === 'play').length,
        },
      },
    };
  }

  async function install(sourcePath, filename) {
    const mods = modLibrary.list();
    const inspections = await inspectInstalled(mods);
    const installedGuids = new Map();
    for (const m of mods) {
      const guid = inspections.get(pathOf(m))?.guid;
      if (guid) installedGuids.set(guid, m.id);
    }
    const result = await modLibrary.installIncoming(sourcePath, filename, {
      identify: async (dll) => (await inspector.inspectOne(dll).catch(() => null))?.guid ?? null,
      installedGuids,
    });
    for (const r of result.replaced) lastUpdate.delete(r.modId);
    return result;
  }

  const routes = {
    'GET /api/status': async () => ({
      appVersion: APP_VERSION,
      hostVersion,
      installPath,
      installOk,
      bepInExInstalled: installOk ? bepInExIsInstalled(installPath) : false,
      bepInExVersion: installOk ? bepInExVersion(installPath) : null,
      gameBuild: installOk ? gameBuildId(installPath) : null,
      dataDir,
      backupsDir: modLibrary?.layout.backups ?? null,
      disabledDir: modLibrary ? path.dirname(modLibrary.layout.disabledPlugins) : null,
      migratedFromLegacy: modLibrary?.migrated ?? [],
    }),

    'GET /api/mods': async () => {
      requireInstall();
      return modsWithCompat();
    },

    'POST /api/mods/install': async (req) => {
      requireInstall();
      const { sourcePath, filename } = await readJsonBody(req);
      if (!sourcePath || !existsSync(sourcePath)) throw new Error('That file could not be found.');
      return install(sourcePath, filename);
    },

    'POST /api/mods/enable': async (req) => {
      requireInstall();
      const { modId, enabled } = await readJsonBody(req);
      return { mod: modLibrary.setEnabled(modId, Boolean(enabled)) };
    },

    'POST /api/mods/enable-many': async (req) => {
      requireInstall();
      const { modIds, enabled } = await readJsonBody(req);
      modLibrary.setManyEnabled(modIds ?? [], Boolean(enabled));
      return { ok: true };
    },

    'POST /api/mods/remove': async (req) => {
      requireInstall();
      const { modId } = await readJsonBody(req);
      modLibrary.remove(modId);
      lastUpdate.delete(modId);
      return { ok: true };
    },

    // ---- Ship stats (.shipmod files) ----

    'GET /api/ships/stats': async (req) => {
      requireInstall();
      return ships.read(new URL(req.url, 'http://x').searchParams.get('modId'));
    },

    'POST /api/ships/stats': async (req) => {
      requireInstall();
      const { modId, changes, factions } = await readJsonBody(req);
      return ships.save(modId, changes, factions);
    },

    'POST /api/ships/reset': async (req) => {
      requireInstall();
      const { modId } = await readJsonBody(req);
      return ships.reset(modId);
    },

    'GET /api/profiles': async () => ({ profiles: profiles.list(), activeProfileId: profiles.getActiveProfileId() }),

    'POST /api/profiles': async (req) => {
      const { name, modIds } = await readJsonBody(req);
      return { profile: profiles.create(name, modIds) };
    },

    'POST /api/profiles/rename': async (req) => {
      const { profileId, name } = await readJsonBody(req);
      profiles.rename(profileId, name);
      return { ok: true };
    },

    'POST /api/profiles/mods': async (req) => {
      const { profileId, modIds } = await readJsonBody(req);
      return { profile: profiles.setModIds(profileId, modIds) };
    },

    'POST /api/profiles/delete': async (req) => {
      const { profileId } = await readJsonBody(req);
      profiles.delete(profileId);
      return { ok: true };
    },

    'POST /api/profiles/apply': async (req) => {
      requireInstall();
      const { profileId } = await readJsonBody(req);
      return { profile: profiles.apply(profileId, modLibrary) };
    },

    'GET /api/saves': async () => {
      requireInstall();
      const slots = listSaveSlots(installPath);
      const profilesById = new Map(profiles.list().map((p) => [p.id, p]));
      return {
        slots: slots.map((slot) => ({ ...slot, link: saveLinks.getStatus(slot.slot, profilesById) })),
      };
    },

    'POST /api/saves/link': async (req) => {
      const { slot, profileId, manual } = await readJsonBody(req);
      if (manual) saveLinks.setManual(slot, profileId);
      else saveLinks.recordPlayed(slot, profileId);
      return { ok: true };
    },

    'POST /api/launch': async (req) => {
      requireInstall();
      const { profileId, slot } = await readJsonBody(req);
      if (profileId) {
        profiles.apply(profileId, modLibrary);
        if (slot) saveLinks.recordPlayed(slot, profileId);
      }
      return launchGame();
    },

    'GET /api/nexus/settings': async () => ({ hasApiKey: Boolean(nexus.getApiKey()), browseUrl: nexusBrowseUrl() }),

    'POST /api/nexus/key': async (req) => {
      const { apiKey } = await readJsonBody(req);
      nexus.setApiKey(apiKey);
      if (!apiKey) return { ok: true, user: null };
      try {
        const user = await nexus.validateKey();
        return { ok: true, user: { name: user.name, isPremium: Boolean(user.is_premium) } };
      } catch (err) {
        nexus.setApiKey(null); // don't keep a key that doesn't work
        throw err;
      }
    },

    'GET /api/nexus/updated': async () => ({ mods: (await nexus.listUpdatedMods()).slice(0, 40) }),

    'POST /api/updates/check': async () => {
      requireInstall();
      const results = await updater.checkAll();
      for (const r of results) lastUpdate.set(r.modId, r);
      return { results };
    },

    'POST /api/updates/all': async () => {
      requireInstall();
      const results = await updater.updateAll();
      for (const r of results) {
        if (r.status === 'updated') lastUpdate.delete(r.modId);
        else lastUpdate.set(r.modId, r);
      }
      return { results };
    },

    'POST /api/updates/apply': async (req) => {
      requireInstall();
      const { modId } = await readJsonBody(req);
      const result = await updater.apply(modId);
      if (result.status === 'updated') lastUpdate.delete(modId);
      else lastUpdate.set(modId, result);
      return { result };
    },

    'POST /api/updates/source': async (req) => {
      requireInstall();
      const { modId, value } = await readJsonBody(req);
      updater.setSource(modId, parseSourceInput(value));
      lastUpdate.delete(modId);
      return { ok: true };
    },

    'GET /api/bridge/status': async () => getBridgeStatus(),

    // ---- BepInEx version management ----

    'GET /api/bepinex': async (req) => {
      requireInstall();
      return bepinex.status({ refresh: new URL(req.url, 'http://x').searchParams.has('refresh') });
    },

    /** Checks the installed version, the newest stable and the newest pre-release (or one given
     * version) against every installed plugin. */
    'POST /api/bepinex/check': async (req) => {
      requireInstall();
      const { version } = await readJsonBody(req);
      const status = await bepinex.status({ refresh: !version });
      const targets = version
        ? [version]
        : [
            status.installed?.version,
            status.versions.find((v) => !v.prerelease)?.version,
            status.versions.find((v) => v.prerelease)?.version,
          ].filter((v, i, a) => v && a.indexOf(v) === i && status.versions.some((x) => x.version === v));
      const errors = [];
      for (const v of targets) {
        try {
          await bepinex.evaluate(v);
        } catch (err) {
          errors.push(`${v}: ${err.message}`);
        }
      }
      return { ...(await bepinex.status()), checkErrors: errors };
    },

    'POST /api/bepinex/mode': async (req) => {
      requireInstall();
      const { mode } = await readJsonBody(req);
      bepinex.setTestMode(mode);
      return { ok: true };
    },

    /** Installs a version, then (unless the mode is "none") starts a test launch. */
    'POST /api/bepinex/install': async (req) => {
      requireInstall();
      const { version, mode } = await readJsonBody(req);
      if (mode) bepinex.setTestMode(mode);
      const installed = await bepinex.install(version);
      let test = null;
      if (bepinex.history.read().testMode !== 'none') test = await bepinex.startTest({ explain: explainLog });
      return { installed, test };
    },

    'POST /api/bepinex/rollback': async (req) => {
      requireInstall();
      const { closeGame } = await readJsonBody(req);
      return bepinex.rollback({ closeRunningGame: Boolean(closeGame) });
    },

    'POST /api/bepinex/test': async () => {
      requireInstall();
      return { test: await bepinex.startTest({ explain: explainLog }) };
    },

    'GET /api/bepinex/test': async () => ({ test: bepinex?.test ?? null }),
  };

  const keyBuf = Buffer.from(key);
  const keyMatches = (sent) => typeof sent === 'string' && sent.length === key.length && timingSafeEqual(Buffer.from(sent), keyBuf);

  function serveStatic(req, res) {
    const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    const filePath = path.join(publicDir, urlPath);
    if (!filePath.startsWith(publicDir) || !existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' });
    res.end(readFileSync(filePath));
  }

  const server = http.createServer(async (req, res) => {
    // Only requests addressed to this server itself (a DNS-rebinding page would send its own host name).
    if (req.headers.host !== `127.0.0.1:${server.address().port}`) return sendJson(res, 403, { error: 'Forbidden' });
    const urlPath = req.url.split('?')[0];
    const routeKey = `${req.method} ${urlPath}`;
    const handler = routes[routeKey];

    if (urlPath.startsWith('/api/') && !keyMatches(req.headers['x-achilles-key'])) return sendJson(res, 403, { error: 'Forbidden' });

    if (!handler) {
      if (req.method === 'GET') return serveStatic(req, res);
      return sendJson(res, 404, { error: 'Not found' });
    }

    try {
      const result = await handler(req);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, installPath, installOk }));
  });
}
