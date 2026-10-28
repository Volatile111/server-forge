// Publishes a built installer as a GitHub release: creates the release (tag v<version>) if needed, uploads the
// installer (replacing one with the same name) and sets the notes from CHANGELOG.md.
//   node tools/publish-release.mjs host     Tavern Host → github.com/Volatile111/server-forge
//   node tools/publish-release.mjs client   Tavern Client Mod Manager → github.com/Volatile111/mod-forge-releases
// Needs a GitHub token with write access in the GH_TOKEN environment variable (it's never printed).
// Run by `npm run release` / `npm run release:client` after building.
import { readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { releaseNames, prepareAssets } from './forge-release-assets.mjs';

const root = path.resolve(import.meta.dirname, '..');
const which = process.argv[2];
const APPS = {
  host: {
    repo: 'Volatile111/server-forge',
    title: 'Server Forge',
    version: () => JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version,
    file: (v) => `Server-Forge-Setup-${v}.exe`,
  },
  client: {
    repo: 'Volatile111/mod-forge-releases',
    title: 'Mod Forge',
    version: () => JSON.parse(readFileSync(path.join(root, 'companion', 'builder.json'), 'utf8')).extraMetadata.version,
    file: (v) => `Mod-Forge-Setup-${v}.exe`,
  },
};
const app = APPS[which];
if (!app) throw new Error('Say which app: node tools/publish-release.mjs host|client');
const token = process.env.GH_TOKEN;
if (!token) throw new Error('Set GH_TOKEN to a GitHub token with write access first.');

const version = app.version();
const tag = `v${version}`;
const heading = `${app.title} ${version}`;
const installer = path.join(root, 'release', app.file(version));
if (!existsSync(installer)) throw new Error(`${installer} isn't built yet.`);

// Release notes: the CHANGELOG.md section "## <app> <version>".
const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const start = changelog.indexOf(`## ${heading}`);
if (start < 0) throw new Error(`Add a "## ${heading}" section to CHANGELOG.md first (it becomes the release notes and the apps' "What's new").`);
const rest = changelog.slice(start + heading.length + 3);
const end = rest.search(/\n## /);
const notes = (end < 0 ? rest : rest.slice(0, end)).trim();

const api = async (method, url, body, headers = {}) => {
  const res = await fetch(url.startsWith('http') ? url : `https://api.github.com/repos/${app.repo}${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'tavern-release', ...headers },
    body,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${method} ${url}: GitHub answered ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? {} : res.json();
};

let release = await api('GET', `/releases/tags/${tag}`);
release = release
  ? await api('PATCH', `/releases/${release.id}`, JSON.stringify({ name: heading, body: notes }))
  : await api('POST', '/releases', JSON.stringify({ tag_name: tag, name: heading, body: notes, draft: false, prerelease: false }));
// Upload both names: old installations require the legacy alias to discover this update.
prepareAssets(root, which);
for (const name of releaseNames(which, version)) {
  const assetFile = path.join(root, 'release', name);
  const old = release.assets.find((a) => a.name === name);
  if (old) await api('DELETE', `/releases/assets/${old.id}`);
  const size = statSync(assetFile).size;
  console.log(`Uploading ${name} (${(size / 1048576).toFixed(1)} MB)…`);
  const up = await api('POST', `https://uploads.github.com/repos/${app.repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, readFileSync(assetFile), {
    'Content-Type': 'application/octet-stream', 'Content-Length': String(size),
  });
  console.log(`Checksum: ${up.digest ?? 'not listed'}`);
}
console.log(`Published ${heading}: ${release.html_url}`);
