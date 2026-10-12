import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { JsonStore } from './store.js';
import { readZip } from './zip.js';
import { nexusFilePageUrl } from './nexus.js';

const GITHUB_API = 'https://api.github.com';
const NEGATIVE_CACHE_MS = 7 * 24 * 3600 * 1000;

export function md5Of(filePath) {
  return createHash('md5').update(readFileSync(filePath)).digest('hex');
}

/** Compares "1.3.1" / "v2.0" / "1.0.0.4" style versions numerically. Returns -1, 0, 1, or null
 * when either side isn't a recognisable version. */
export function compareVersions(a, b) {
  const parse = (v) => (String(v ?? '').match(/\d+(\.\d+)*/)?.[0] ?? '').split('.').filter(Boolean).map(Number);
  const x = parse(a);
  const y = parse(b);
  if (x.length === 0 || y.length === 0) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Accepts "owner/repo", a github.com URL, a nexusmods.com/starvalor/mods/123 URL, a bare Nexus
 * mod number, or "none". */
export function parseSourceInput(value) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  if (/^(none|off|no)$/i.test(v)) return { type: 'none' };
  const gh = v.match(/github\.com\/([\w.-]+)\/([\w.-]+)/i) ?? v.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (gh) return { type: 'github', repo: `${gh[1]}/${gh[2].replace(/\.git$/, '')}` };
  const nx = v.match(/nexusmods\.com\/starvalor\/mods\/(\d+)/i) ?? v.match(/^(\d+)$/);
  if (nx) return { type: 'nexus', nexusModId: Number(nx[1]) };
  throw new Error('Enter a GitHub "owner/repo" (or its URL), a Nexus Star Valor mod URL or number, or "none".');
}

/**
 * One-button updating.
 *
 * - GitHub-hosted mods (e.g. all of MPC88's "MC_SV..." mods) update fully automatically: the
 *   public releases API needs no account, so the new DLL is downloaded, checked for game
 *   compatibility, and swapped in (old one backed up).
 * - Nexus-hosted mods are identified by MD5 and checked with your free API key, but Nexus only
 *   lets Premium accounts download through the API. So for those the updater finds the new file
 *   and opens its page in the built-in mod browser; clicking Download there installs it as an
 *   update automatically (see ModLibrary.installIncoming).
 */
export class Updater {
  constructor(dataDir, { modLibrary, inspector, nexus }) {
    this.modLibrary = modLibrary;
    this.inspector = inspector;
    this.nexus = nexus;
    this.cacheDir = path.join(dataDir, 'update-cache');
    this.store = new JsonStore(dataDir, 'sources.json', { sources: {}, negative: {} });
  }

  // ---- GitHub -------------------------------------------------------------------------------

  async _gh(pathAndQuery) {
    const res = await fetch(`${GITHUB_API}${pathAndQuery}`, {
      headers: { 'User-Agent': 'AchillesModManager/0.3.0', Accept: 'application/vnd.github+json' },
    });
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const mins = reset ? Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 60000)) : null;
      throw new Error(`GitHub's hourly limit for update checks was reached${mins ? ` - try again in about ${mins} min` : ''}.`);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub error (HTTP ${res.status}).`);
    return res.json();
  }

  _pickAsset(release, filename) {
    const assets = release.assets ?? [];
    const lower = filename.toLowerCase();
    return (
      assets.find((a) => a.name.toLowerCase() === lower) ??
      (assets.filter((a) => a.name.toLowerCase().endsWith('.dll')).length === 1 ? assets.find((a) => a.name.toLowerCase().endsWith('.dll')) : null) ??
      assets.find((a) => a.name.toLowerCase().endsWith('.zip'))
    );
  }

  async _latestGithubRelease(repo, filename) {
    const releases = await this._gh(`/repos/${repo}/releases?per_page=10`);
    if (!releases) return null;
    for (const rel of releases) {
      if (rel.draft || rel.prerelease) continue;
      const asset = this._pickAsset(rel, filename);
      if (asset) return { release: rel, asset };
    }
    return null;
  }

  /** Finds a GitHub repo named exactly like the plugin's assembly whose releases actually ship
   * this file - that double condition keeps unrelated same-named repos from matching. */
  async _detectGithub(assemblyName, filename) {
    if (!assemblyName) return null;
    const search = await this._gh(`/search/repositories?q=${encodeURIComponent(assemblyName)}+in:name&per_page=10`);
    const candidates = (search?.items ?? [])
      .filter((r) => r.name.toLowerCase() === assemblyName.toLowerCase())
      .sort((a, b) => Number(a.fork) - Number(b.fork) || b.stargazers_count - a.stargazers_count);
    for (const repo of candidates) {
      if (await this._latestGithubRelease(repo.full_name, filename)) return repo.full_name;
    }
    return null;
  }

  /** Downloads a release asset into the update cache (once) and returns the DLL path inside it. */
  async _fetchGithubDll(repo, release, asset, filename) {
    const dir = path.join(this.cacheDir, 'github', repo.replace('/', '__'), release.tag_name);
    mkdirSync(dir, { recursive: true });
    const assetPath = path.join(dir, asset.name);
    if (!existsSync(assetPath)) {
      const res = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'AchillesModManager/0.3.0' } });
      if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}).`);
      writeFileSync(assetPath, Buffer.from(await res.arrayBuffer()));
    }
    if (!asset.name.toLowerCase().endsWith('.zip')) return assetPath;

    const dlls = readZip(assetPath).filter((e) => e.name.toLowerCase().endsWith('.dll'));
    const pick = dlls.find((e) => path.posix.basename(e.name).toLowerCase() === filename.toLowerCase()) ?? (dlls.length === 1 ? dlls[0] : null);
    if (!pick) throw new Error(`The release zip doesn't contain ${filename}.`);
    const out = path.join(dir, filename);
    if (!existsSync(out)) writeFileSync(out, pick.data);
    return out;
  }

  // ---- Source bookkeeping -------------------------------------------------------------------

  getSource(modId) {
    return this.store.read().sources[modId] ?? null;
  }

  setSource(modId, parsed) {
    this.store.update((data) => {
      if (parsed) data.sources[modId] = { ...parsed, manual: true };
      else delete data.sources[modId];
      delete data.negative[modId];
      return data;
    });
  }

  async _resolveSource(mod, info, md5) {
    const data = this.store.read();
    const known = data.sources[mod.id];
    // Nexus sources are pinned to an exact file; if the file changed (user updated it), re-identify.
    if (known && !(known.type === 'nexus' && !known.manual && known.md5 !== md5)) return known;

    const neg = data.negative[mod.id];
    if (!known && neg && neg.md5 === md5 && Date.now() - neg.at < NEGATIVE_CACHE_MS) return null;

    let found = null;
    if (this.nexus.getApiKey()) {
      const hits = await this.nexus.md5Search(md5);
      const hit = Array.isArray(hits) ? hits[0] : null;
      if (hit?.mod?.mod_id) {
        found = {
          type: 'nexus',
          nexusModId: hit.mod.mod_id,
          nexusModName: hit.mod.name,
          installedFileId: hit.file_details?.file_id ?? null,
          installedVersion: hit.file_details?.version ?? null,
          md5,
        };
      }
    }
    if (!found) {
      const repo = await this._detectGithub(info?.assemblyName, mod.filename);
      if (repo) found = { type: 'github', repo };
    }

    this.store.update((d) => {
      if (found) {
        d.sources[mod.id] = found;
        delete d.negative[mod.id];
      } else {
        d.negative[mod.id] = { at: Date.now(), md5 };
      }
      return d;
    });
    return found;
  }

  // ---- Checking -----------------------------------------------------------------------------

  async check(mod) {
    const base = { modId: mod.id, filename: mod.filename };
    if (mod.kind !== 'plugin') return { ...base, status: 'not-applicable' };

    const { currentPath } = this.modLibrary.locate(mod);
    const info = await this.inspector.inspectOne(currentPath);
    const installedVersion = info?.version ?? null;
    const md5 = md5Of(currentPath);

    let source;
    try {
      source = await this._resolveSource(mod, info, md5);
    } catch (err) {
      return { ...base, status: 'error', installedVersion, detail: err.message };
    }
    if (!source) {
      return {
        ...base,
        status: 'no-source',
        installedVersion,
        detail: this.nexus.getApiKey()
          ? 'Not found on GitHub or Nexus automatically - set its source by hand.'
          : 'Not found on GitHub. Add your free Nexus API key in Settings so Nexus mods can be identified too, or set the source by hand.',
      };
    }
    if (source.type === 'none') return { ...base, status: 'ignored', installedVersion, source };

    try {
      if (source.type === 'github') return await this._checkGithub(base, source, mod, installedVersion, info);
      return await this._checkNexus(base, source, installedVersion);
    } catch (err) {
      return { ...base, status: 'error', installedVersion, source, detail: err.message };
    }
  }

  async _checkGithub(base, source, mod, installedVersion, installedInfo) {
    const latest = await this._latestGithubRelease(source.repo, mod.filename);
    if (!latest) return { ...base, status: 'error', installedVersion, source, detail: `No release of ${source.repo} contains ${mod.filename}.` };

    const dll = await this._fetchGithubDll(source.repo, latest.release, latest.asset, mod.filename);
    const newInfo = await this.inspector.inspectOne(dll);
    const latestVersion = newInfo?.version ?? latest.release.tag_name;
    const cmp = compareVersions(latestVersion, installedVersion);
    const url = latest.release.html_url;

    if (cmp === null ? md5Of(dll) === md5Of(this.modLibrary.locate(mod).currentPath) : cmp <= 0) {
      return { ...base, status: 'up-to-date', installedVersion, latestVersion, source, url };
    }

    const newProblems = newInfo?.problems?.length ?? 0;
    const oldProblems = installedInfo?.problems?.length ?? 0;
    return {
      ...base,
      status: 'update-auto',
      installedVersion,
      latestVersion,
      source,
      url,
      releaseNotes: (latest.release.body ?? '').slice(0, 1500),
      publishedAt: latest.release.published_at,
      newProblems,
      risky: newProblems > oldProblems,
      downloadedFile: dll,
    };
  }

  async _checkNexus(base, source, installedVersion) {
    if (!this.nexus.getApiKey()) {
      return { ...base, status: 'needs-key', installedVersion, source, detail: 'Add your free Nexus API key in Settings to check Nexus mods.' };
    }
    const { files = [] } = await this.nexus.getModFiles(source.nexusModId);
    const live = files.filter((f) => !['ARCHIVED', 'DELETED', 'OLD_VERSION'].includes(f.category_name));
    const main = live.filter((f) => f.category_name === 'MAIN');
    const newest = (main.length ? main : live).sort((a, b) => b.uploaded_timestamp - a.uploaded_timestamp)[0];
    const url = nexusFilePageUrl(source.nexusModId, newest?.file_id);
    if (!newest) return { ...base, status: 'error', installedVersion, source, detail: 'That Nexus mod has no downloadable files.' };

    const haveVersion = source.installedVersion ?? installedVersion;
    let newer;
    if (source.installedFileId) {
      const mine = files.find((f) => f.file_id === source.installedFileId);
      newer = newest.file_id !== source.installedFileId && (!mine || newest.uploaded_timestamp > mine.uploaded_timestamp);
    } else {
      newer = compareVersions(newest.version, haveVersion) === 1;
    }
    return {
      ...base,
      status: newer ? 'update-manual' : 'up-to-date',
      installedVersion: haveVersion,
      latestVersion: newest.version,
      source,
      url,
      detail: newer ? 'Nexus only allows Premium accounts to download through apps - open the page and click Download; the manager installs it as an update automatically.' : undefined,
    };
  }

  async checkAll() {
    const results = [];
    for (const mod of this.modLibrary.list()) {
      if (mod.kind !== 'plugin') continue;
      results.push(await this.check(mod)); // sequential: keeps well under GitHub/Nexus rate limits
    }
    return results;
  }

  // ---- Applying -----------------------------------------------------------------------------

  async apply(modId) {
    const mod = this.modLibrary.get(modId);
    const result = await this.check(mod);
    if (result.status !== 'update-auto') return result;
    const { backup } = this.modLibrary.replaceFile(mod.id, result.downloadedFile, `updated_${mod.filename.replace(/\.dll$/i, '')}_v${result.installedVersion ?? 'unknown'}`);
    return { ...result, status: 'updated', backup };
  }

  /** The one button: check everything, install every safe automatic update, and report what's
   * left (Nexus updates that need a click, risky updates held back, errors). */
  async updateAll() {
    const checked = await this.checkAll();
    const out = [];
    for (const r of checked) {
      if (r.status === 'update-auto' && !r.risky) {
        const { backup } = this.modLibrary.replaceFile(r.modId, r.downloadedFile, `updated_${r.filename.replace(/\.dll$/i, '')}_v${r.installedVersion ?? 'unknown'}`);
        out.push({ ...r, status: 'updated', backup });
      } else {
        out.push(r);
      }
    }
    return out;
  }
}
