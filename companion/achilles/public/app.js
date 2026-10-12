// Tavern Client Mod Manager opens this page as ...#k=<session key>; the local server only answers requests that
// send it. Read once, then dropped from the address.
const KEY = new URLSearchParams(location.hash.slice(1)).get('k') ?? '';
history.replaceState(null, '', location.pathname);
const api = {
  get: (p) => fetch(p, { headers: { 'X-Achilles-Key': KEY } }).then(assertOk),
  post: (p, body) => fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Achilles-Key': KEY }, body: JSON.stringify(body ?? {}) }).then(assertOk),
};

async function assertOk(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status})`);
  return data;
}

function toast(message, isError = false) {
  const el = document.getElementById('toast');
  const item = document.createElement('div');
  item.className = isError ? 'toast-item error' : 'toast-item';
  item.textContent = message;
  el.appendChild(item);
  setTimeout(() => item.remove(), isError ? 7000 : 3600);
}

function showGlobalError(message) {
  const el = document.getElementById('globalError');
  el.hidden = !message;
  if (message) el.textContent = message;
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Runs an async action with a button showing it's busy, and reports failures as a toast. */
async function busy(button, label, fn) {
  const original = button?.innerHTML;
  if (button) {
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span> ${escapeHtml(label)}`;
  }
  try {
    return await fn();
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = original;
    }
  }
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function showTab(name) {
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const section of document.querySelectorAll('main .tab')) section.hidden = section.id !== `tab-${name}`;
}
document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (btn) showTab(btn.dataset.tab);
});
document.body.addEventListener('click', (e) => {
  const back = e.target.closest('[data-tab-back]');
  if (back) showTab(back.dataset.tabBack);
});

// ---------------------------------------------------------------------------
// Status / settings facts
// ---------------------------------------------------------------------------

let status = null;

async function refreshStatus() {
  status = await api.get('/api/status');
  const pill = document.getElementById('statusPill');
  document.getElementById('brandSub').textContent = `Star Valor${status.gameBuild ? ` build ${status.gameBuild}` : ''} · Achilles ${status.appVersion}${status.hostVersion ? `, in Tavern Client Mod Manager ${status.hostVersion}` : ''}`;
  if (!status.installOk) {
    pill.textContent = 'Star Valor not found';
    pill.className = 'pill bad';
    showGlobalError('Could not find a Star Valor install through Steam on this PC. Mods/profiles/saves need it to work.');
  } else if (!status.bepInExInstalled) {
    pill.textContent = 'BepInEx not set up';
    pill.className = 'pill warn';
    showGlobalError('Star Valor was found, but BepInEx (the mod loader) isn’t installed there yet.');
  } else {
    pill.textContent = status.bepInExVersion ? `BepInEx ${status.bepInExVersion}` : 'Connected';
    pill.className = 'pill good';
    showGlobalError(null);
  }
  if (status.migratedFromLegacy?.length) toast(`Moved ${status.migratedFromLegacy.length} disabled mod(s) out of the old folder BepInEx was still loading them from.`);
  renderFacts();
  return status;
}

function renderFacts() {
  if (!status) return;
  const row = (label, value, folder) => `
    <dt>${escapeHtml(label)}</dt>
    <dd>${escapeHtml(value ?? '—')}${folder ? ` <button class="small ghost" data-open-folder="${escapeHtml(folder)}">Open</button>` : ''}</dd>`;
  document.getElementById('facts').innerHTML = [
    row('Game build', status.gameBuild),
    row('BepInEx', status.bepInExVersion),
    row('Game folder', status.installPath, status.installPath),
    row('Disabled mods', status.disabledDir, status.disabledDir),
    row('Backups', status.backupsDir, status.backupsDir),
    row('Manager data', status.dataDir, status.dataDir),
  ].join('');
}

document.body.addEventListener('click', async (e) => {
  const folder = e.target.closest('[data-open-folder]')?.dataset.openFolder;
  if (folder) {
    const err = await window.desktop.openFolder(folder);
    if (err) toast(err, true);
  }
});

// ---------------------------------------------------------------------------
// In-game bridge status (see server/lib/bridge.js + BepInExBridge/Plugin.cs)
// ---------------------------------------------------------------------------

async function refreshBridgeStatus() {
  const pill = document.getElementById('bridgePill');
  try {
    const s = await api.get('/api/bridge/status');
    if (s.connected) {
      pill.textContent = `Game: running (slot ${s.currentSlot ?? '?'}, ${s.loadedPlugins?.length ?? 0} plugins)`;
      pill.className = 'pill good';
      return;
    }
  } catch {}
  pill.textContent = 'Game: not running';
  pill.className = 'pill';
}
setInterval(refreshBridgeStatus, 5000);

document.getElementById('btnLaunch').addEventListener('click', (e) =>
  busy(e.currentTarget, 'Launching…', async () => {
    await api.post('/api/launch', {});
    toast('Launching Star Valor through Steam…');
  })
);

// ---------------------------------------------------------------------------
// Mods tab
// ---------------------------------------------------------------------------

let modsCache = [];
let lastLaunch = null;
let modFilter = 'all';
const expanded = new Set();
const collapsedGroups = new Set();

const LEVEL_LABEL = { ok: '✓ Works', warn: '⚠ Check', broken: '✕ Won’t work', unknown: '? Unknown' };

function displayName(mod) {
  if (mod.compat?.plugin?.name) return mod.compat.plugin.name;
  const base = mod.filename.replace(/\.(dll|shipmod)$/i, '');
  if (mod.kind !== 'shipmod') return base;
  // Ship files are lower-case ship names ("rising sun") - show them the way the game does. Files
  // We Mod Any Ship failed to load carry one "ERR" per failed launch; show the real name.
  const failed = /^(ERR)+/.test(base);
  const name = base.replace(/^(ERR)+/, '').replace(/(^|[\s-])([a-z])/g, (_m, sep, ch) => sep + ch.toUpperCase());
  return failed ? `${name} (failed copy)` : name;
}

// The 🗑 emoji has no glyph in Segoe UI on every Windows install, so draw it.
const TRASH_ICON = '<svg class="icon-trash" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.5 6.5v5M9.5 6.5v5"/></svg>';

function compatBadge(mod) {
  const c = mod.compat;
  if (!c) return '';
  if (mod.kind === 'shipmod' && c.level === 'ok') return '';
  let label = LEVEL_LABEL[c.level] ?? c.level;
  if (c.issues.some((i) => /reaching the main menu/.test(i.text))) label = '✕ Breaks startup';
  else if (c.issues.some((i) => /loading your save/.test(i.text))) label = '✕ Breaks save loading';
  return `<span class="badge lvl-${c.level}">${escapeHtml(label)}</span>`;
}

function updateBadge(mod) {
  const u = mod.update;
  if (!u) return '';
  if (u.status === 'update-auto') return `<button class="small update" data-update="${mod.id}" title="${u.risky ? 'The new version still has compatibility problems' : 'Download and install it now (old version is backed up)'}">⬆ Update to v${escapeHtml(u.latestVersion)}</button>`;
  if (u.status === 'update-manual') return `<button class="small update" data-open-page="${escapeHtml(u.url)}" title="Open the Nexus page - the download installs itself">⬆ v${escapeHtml(u.latestVersion)} on Nexus</button>`;
  return '';
}

// The Ships view (ship mods) has its own search and filter; everything else uses the Mods tab's.
let shipFilter = 'all';
const filterFor = (mod) => (mod.kind === 'shipmod' ? shipFilter : modFilter);
const searchFor = (kind) => document.getElementById(kind === 'shipmod' ? 'shipSearch' : 'modSearch').value.trim().toLowerCase();

function matchesFilter(mod, q) {
  const filter = filterFor(mod);
  if (filter === 'problems' && !['warn', 'broken', 'unknown'].includes(mod.compat?.level)) return false;
  if (filter === 'enabled' && !mod.enabled) return false;
  if (filter === 'disabled' && mod.enabled) return false;
  if (filter === 'edited' && !mod.edited) return false;
  if (!q) return true;
  return `${mod.filename} ${displayName(mod)}`.toLowerCase().includes(q);
}

async function refreshMods() {
  const data = await api.get('/api/mods');
  modsCache = data.mods;
  lastLaunch = data.lastLaunch;
  renderMods();
  renderShips();
  renderHealth();
}

function modRow(mod) {
  const c = mod.compat ?? { level: 'unknown', issues: [] };
  const firstIssue = c.issues.find((i) => i.level !== 'info');
  const sub = mod.kind === 'shipmod' ? 'Ship definition' : mod.filename;
  const isOpen = expanded.has(mod.id);
  const sourceText = mod.source
    ? mod.source.type === 'github' ? `GitHub: ${mod.source.repo}` : mod.source.type === 'nexus' ? `Nexus mod #${mod.source.nexusModId}${mod.source.nexusModName ? ` (${mod.source.nexusModName})` : ''}` : 'Update checks off'
    : 'Not identified yet - run an update check';

  return `
    <div class="mod-row lvl-${c.level} ${mod.enabled ? '' : 'off'}" data-row="${mod.id}">
      <label class="switch" title="${mod.enabled ? 'On - click to turn off' : 'Off - click to turn on'}">
        <input type="checkbox" data-toggle="${mod.id}" ${mod.enabled ? 'checked' : ''}><span></span>
      </label>
      <div class="mod-main">
        <div class="mod-title">
          <span class="mod-name">${escapeHtml(displayName(mod))}</span>
          ${c.plugin?.version ? `<span class="ver">v${escapeHtml(c.plugin.version)}</span>` : ''}
          ${compatBadge(mod)}
        </div>
        <div class="mod-sub">${escapeHtml(sub)}${firstIssue ? ` · <span class="issue-${firstIssue.level}">${escapeHtml(firstIssue.text)}</span>` : ''}</div>
      </div>
      <div class="mod-actions">
        ${updateBadge(mod)}
        ${mod.kind === 'plugin' || c.issues.length ? `<button class="small ghost" data-details="${mod.id}">${isOpen ? 'Hide' : 'Details'}</button>` : ''}
        <button class="small ghost icon" data-remove="${mod.id}" title="Remove (moves the file to backups)">${TRASH_ICON}</button>
      </div>
    </div>
    ${isOpen ? `
    <div class="mod-details">
      ${c.issues.length ? `<ul class="issues">${c.issues.map((i) => `
        <li class="issue-${i.level}">
          ${escapeHtml(i.text)}
          ${i.where?.length ? `<div class="where">Used by ${i.where.map(escapeHtml).join('; ')}</div>` : ''}
        </li>`).join('')}</ul>` : '<p class="muted small-text">No problems found against this game version.</p>'}
      ${mod.kind === 'plugin' ? `
      <div class="detail-grid">
        <span>Plugin ID</span><code>${escapeHtml(c.plugin?.guid ?? '—')}</code>
        <span>File</span><code>${escapeHtml(mod.relPath ?? mod.filename)}</code>
        <span>Updates from</span><span>${escapeHtml(sourceText)} <button class="small ghost" data-source="${mod.id}">Change</button></span>
      </div>` : ''}
    </div>` : ''}`;
}

function shipTile(mod) {
  const c = mod.compat ?? { level: 'ok', issues: [] };
  const issue = c.issues.find((i) => i.level !== 'info');
  return `
    <div class="ship-tile lvl-${c.level} ${mod.enabled ? '' : 'off'}" title="${escapeHtml(issue ? issue.text : mod.filename)}">
      <label class="switch"><input type="checkbox" data-toggle="${mod.id}" ${mod.enabled ? 'checked' : ''}><span></span></label>
      <span class="ship-name">${issue ? `<span class="issue-${issue.level}">${issue.level === 'broken' ? '✕' : '⚠'}</span> ` : ''}${escapeHtml(displayName(mod))}${mod.edited ? ' <span class="badge tone-accent" title="Its stats were changed here">Edited</span>' : ''}</span>
      <button class="small ghost tile-stats" data-stats="${mod.id}" title="View and change this ship's stats">Stats</button>
      <button class="small ghost icon tile-remove" data-remove="${mod.id}" title="Remove (moves the file to backups)">${TRASH_ICON}</button>
    </div>`;
}

function renderMods() {
  const q = document.getElementById('modSearch').value.trim().toLowerCase();
  const list = document.getElementById('modList');
  const enabledCount = modsCache.filter((m) => m.enabled).length;
  document.getElementById('modCount').textContent = `(${enabledCount} of ${modsCache.length} on)`;

  if (modsCache.length === 0) {
    list.innerHTML = '<p class="muted">No mods installed yet. Drop some files above, or get some from Nexus.</p>';
    return;
  }

  // Ship mods (100+) have their own view: here they're one line with a button to it.
  const ships = modsCache.filter((m) => m.kind === 'shipmod');
  const shipLine = ships.length ? `
    <div class="mod-group">
      <div class="group-head ships-line">
        <span class="group-title">Ship mods</span>
        <span class="muted small-text">${groupSummary(ships)}</span>
        <div class="btn-row push"><button class="small primary" data-open-ships>🚀 Open ships</button></div>
      </div>
    </div>` : '';
  list.innerHTML = modGroup('plugin', 'Plugins', 'mod-list', modRow) + shipLine;
}

const levelRank = { broken: 0, warn: 1, unknown: 2, ok: 3 };

function groupSummary(all) {
  const on = all.filter((m) => m.enabled).length;
  const problems = all.filter((m) => ['warn', 'broken'].includes(m.compat?.level)).length;
  const edited = all.filter((m) => m.edited).length;
  return `${on} of ${all.length} on${problems ? ` · <span class="issue-warn">${problems} with problems</span>` : ''}${edited ? ` · ${edited} edited` : ''}`;
}

/** One kind of mod: a heading with counts and All on / All off, then the rows or tiles that match. */
function modGroup(kind, title, listClass, item) {
  const q = searchFor(kind);
  const all = modsCache.filter((m) => m.kind === kind);
  if (all.length === 0) return '';
  const shown = all
    .filter((m) => matchesFilter(m, q))
    .sort((a, b) => (levelRank[a.compat?.level] ?? 9) - (levelRank[b.compat?.level] ?? 9) || displayName(a).localeCompare(displayName(b)));
  const filtered = shown.length !== all.length;
  // An active search/filter always shows matches, even in a folded group.
  const collapsed = collapsedGroups.has(kind) && !q && filterFor(all[0]) === 'all';
  return `
    <div class="mod-group">
      <div class="group-head">
        <button class="group-toggle" data-collapse="${kind}">${collapsed ? '▸' : '▾'} ${title}</button>
        <span class="muted small-text">${groupSummary(all)}${filtered ? ` · showing ${shown.length}` : ''}</span>
        <div class="btn-row push">
          <button class="small ghost" data-bulk="${kind}" data-on="1" ${shown.length ? '' : 'disabled'}>All ${filtered ? 'shown ' : ''}on</button>
          <button class="small ghost" data-bulk="${kind}" data-on="0" ${shown.length ? '' : 'disabled'}>All ${filtered ? 'shown ' : ''}off</button>
        </div>
      </div>
      ${collapsed ? '' : !shown.length ? '<p class="muted small-text">Nothing matches.</p>' : `<div class="${listClass}">${shown.map(item).join('')}</div>`}
    </div>`;
}

function renderShips() {
  const all = modsCache.filter((m) => m.kind === 'shipmod');
  document.getElementById('shipCount').textContent = all.length ? `(${all.filter((m) => m.enabled).length} of ${all.length} on)` : '';
  document.getElementById('shipList').innerHTML = all.length
    ? modGroup('shipmod', 'All ships', 'ship-grid', shipTile)
    : '<p class="muted">No ship mods yet. They come with the "We Mod Any Ship" plugin: start Star Valor once with it on and it writes one file per ship.</p>';
}

function renderHealth() {
  const el = document.getElementById('healthBanner');
  const brokenOn = modsCache.filter((m) => m.enabled && m.compat?.level === 'broken');
  const updates = modsCache.filter((m) => ['update-auto', 'update-manual'].includes(m.update?.status));
  const lines = [];
  if (brokenOn.length) {
    lines.push(`<b>${brokenOn.length} enabled mod${brokenOn.length === 1 ? '' : 's'} won’t work on this game version:</b> ${brokenOn.map((m) => escapeHtml(displayName(m))).join(', ')}.`);
  }
  const ec = lastLaunch?.errorCounts;
  if (ec && (ec.startup || ec.loading)) {
    lines.push(`Last launch (${when(lastLaunch.loggedAt)}) hit ${ec.startup ? 'an error before the main menu' : 'an error while loading a save'} - see the mods marked below.`);
  }
  if (updates.length) lines.push(`${updates.length} update${updates.length === 1 ? '' : 's'} available.`);
  const bepIssue = bep?.recommendation && ['bad', 'warn'].includes(bep.recommendation.tone) ? bep.recommendation : null;
  if (bepIssue) lines.push(`<b>BepInEx:</b> ${escapeHtml(bepIssue.text)}`);

  el.hidden = lines.length === 0;
  el.className = `health ${brokenOn.length || ec?.startup || ec?.loading || bepIssue?.tone === 'bad' ? 'bad' : bepIssue ? 'warn' : 'info'}`;
  el.innerHTML = `<div>${lines.map((l) => `<div>${l}</div>`).join('')}</div>
    <div class="btn-row">
      ${brokenOn.length || updates.length ? '<button class="small primary" data-goto-updates>Check for fixes</button>' : ''}
      ${brokenOn.length ? '<button class="small ghost" data-filter-problems>Show problems</button>' : ''}
      ${bepIssue ? '<button class="small ghost" data-goto-bepinex>BepInEx tab</button>' : ''}
    </div>`;

  const n = updates.length;
  const badge = document.getElementById('updatesBadge');
  badge.hidden = n === 0;
  badge.textContent = n;
}

document.getElementById('healthBanner').addEventListener('click', (e) => {
  if (e.target.closest('[data-goto-updates]')) {
    showTab('updates');
    document.getElementById('btnCheckUpdates').click();
  } else if (e.target.closest('[data-filter-problems]')) {
    setFilter('problems');
  } else if (e.target.closest('[data-goto-bepinex]')) {
    showTab('bepinex');
    if (!bepChecked) checkBepInEx(null);
  }
});

function setFilter(f) {
  modFilter = f;
  for (const b of document.querySelectorAll('#modFilter .chip')) b.classList.toggle('active', b.dataset.filter === f);
  renderMods();
}
document.getElementById('modFilter').addEventListener('click', (e) => {
  const b = e.target.closest('[data-filter]');
  if (b) setFilter(b.dataset.filter);
});
document.getElementById('modSearch').addEventListener('input', renderMods);

// Ships view: its own search and filter chips.
function setShipFilter(f) {
  shipFilter = f;
  for (const b of document.querySelectorAll('#shipFilter .chip')) b.classList.toggle('active', b.dataset.filter === f);
  renderShips();
}
document.getElementById('shipFilter').addEventListener('click', (e) => {
  const b = e.target.closest('[data-filter]');
  if (b) setShipFilter(b.dataset.filter);
});
document.getElementById('shipSearch').addEventListener('input', renderShips);

// The same switches and buttons in the Mods list and the Ships view.
async function onModListChange(e) {
  const modId = e.target.dataset.toggle;
  if (!modId) return;
  try {
    await api.post('/api/mods/enable', { modId, enabled: e.target.checked });
    await refreshMods();
  } catch (err) {
    toast(err.message, true);
    e.target.checked = !e.target.checked;
  }
}

async function onModListClick(e) {
  const t = e.target.closest('button');
  if (!t) return;
  const d = t.dataset;

  if ('openShips' in d) {
    showTab('ships');
  } else if (d.collapse) {
    collapsedGroups.has(d.collapse) ? collapsedGroups.delete(d.collapse) : collapsedGroups.add(d.collapse);
    renderMods();
    renderShips();
  } else if (d.details) {
    expanded.has(d.details) ? expanded.delete(d.details) : expanded.add(d.details);
    renderMods();
  } else if (d.bulk) {
    const q = searchFor(d.bulk);
    const enabled = d.on === '1';
    const ids = modsCache.filter((m) => m.kind === d.bulk && matchesFilter(m, q) && m.enabled !== enabled).map((m) => m.id);
    if (ids.length === 0) return;
    await busy(t, enabled ? 'Turning on…' : 'Turning off…', async () => {
      await api.post('/api/mods/enable-many', { modIds: ids, enabled });
      toast(`Turned ${ids.length} mod${ids.length === 1 ? '' : 's'} ${enabled ? 'on' : 'off'}.`);
      await refreshMods();
    });
  } else if (d.remove) {
    const mod = modsCache.find((m) => m.id === d.remove);
    if (!await ask(`Remove "${mod?.filename}"?`, 'The file is moved to BepInEx\\achilles_backups, so you can get it back.', { ok: 'Remove', danger: true })) return;
    await busy(t, '', async () => {
      await api.post('/api/mods/remove', { modId: d.remove });
      toast(`Removed ${mod?.filename} (kept in backups).`);
      await refreshMods();
    });
  } else if (d.update) {
    await busy(t, 'Updating…', async () => {
      const { result } = await api.post('/api/updates/apply', { modId: d.update });
      toast(result.status === 'updated' ? `Updated ${result.filename} to v${result.latestVersion}.` : `${result.filename}: ${result.detail ?? result.status}`, result.status !== 'updated');
      await refreshMods();
    });
  } else if (d.openPage) {
    window.desktop.openModPage(d.openPage);
  } else if (d.source) {
    openSourceDialog(d.source);
  } else if (d.stats) {
    await busy(t, '', () => openShipDialog(d.stats));
  }
}
for (const id of ['modList', 'shipList']) {
  document.getElementById(id).addEventListener('change', onModListChange);
  document.getElementById(id).addEventListener('click', onModListClick);
}

async function installFromPath(sourcePath, filename) {
  try {
    const { installed, replaced } = await api.post('/api/mods/install', { sourcePath, filename });
    for (const r of replaced) toast(`Updated ${r.filename} (old version backed up).`);
    if (installed.length) toast(`Installed ${installed.join(', ')}`);
    await refreshMods();
  } catch (err) {
    toast(err.message, true);
  }
}

const modDrop = document.getElementById('modDrop');
modDrop.addEventListener('click', async (e) => {
  e.preventDefault();
  const paths = await window.desktop.pickModFiles();
  for (const p of paths) await installFromPath(p, p.split(/[\\/]/).pop());
});
modDrop.addEventListener('dragover', (e) => {
  e.preventDefault();
  modDrop.classList.add('drag-over');
});
modDrop.addEventListener('dragleave', () => modDrop.classList.remove('drag-over'));
modDrop.addEventListener('drop', async (e) => {
  e.preventDefault();
  modDrop.classList.remove('drag-over');
  for (const file of e.dataTransfer.files) {
    await installFromPath(window.desktop.getPathForFile(file), file.name);
  }
});

document.getElementById('btnBrowseMods').addEventListener('click', () => window.desktop.browseMods());
document.getElementById('btnRefreshMods').addEventListener('click', (e) => busy(e.currentTarget, 'Refreshing…', refreshMods));

window.desktop.onModDownload(async (info) => {
  const el = document.getElementById('downloadStatus');
  if (info.status === 'downloading') {
    el.textContent = `Downloading ${info.filename}…`;
  } else if (info.status === 'ready') {
    el.textContent = '';
    if (await ask(`Install "${info.filename}"?`, "If it's a newer version of a mod you already have, it replaces that one and the old version is backed up.\n\nOnly install mods from sources you trust.", { ok: 'Install' })) {
      installFromPath(info.sourcePath, info.filename);
    }
  } else if (info.status === 'failed') {
    el.textContent = '';
    toast(`${info.filename}: ${info.error}`, true);
  }
});

// ---- Ship stats dialog (server/lib/shipedit.js) ----
// Shows a .shipmod's values grouped the way a player thinks about a ship; only changed values are sent back.

const shipDialog = document.getElementById('shipDialog');
let shipData = null;

const SHIP_LABELS = {
  manufacturer: 'Manufacturer', shipClass: 'Class', shipRole: 'Role', level: 'Level', rarity: 'Rarity', sellChance: 'Sell chance (%)', sizeScale: 'Size scale',
  hullPoints: 'Hull points', speed: 'Speed', agility: 'Agility', mass: 'Mass',
  weaponSpace: 'Weapon space', equipSpace: 'Equipment space', cargoSpace: 'Cargo space', hangarDroneSpace: 'Drone hangar', hangarShipSpace: 'Ship hangar', passengers: 'Passengers',
  factionIndex: 'Faction number', repNeeded: 'Reputation needed', TFaction: 'Sold by',
  minRequired: 'Minimum', space: 'Seats',
  type: 'Mount', spinalMount: 'Spinal mount', degreesLimit: 'Arc (degrees)', turnSpeed: 'Turn speed', totalSpace: 'Space', maxInstalledWeapons: 'Max weapons', hasSpecialStats: 'Has bonuses',
};
const SHIP_SECTIONS = [
  ['Ship', ['manufacturer', 'shipClass', 'shipRole', 'level', 'rarity', 'sellChance', 'sizeScale']],
  ['Hull & handling', ['hullPoints', 'speed', 'agility', 'mass']],
  ['Space', ['weaponSpace', 'equipSpace', 'cargoSpace', 'hangarDroneSpace', 'hangarShipSpace', 'passengers']],
];
/** "criticalChanceBonus" / "SB_WeaponCrit" → "Critical chance bonus" / "Weapon crit". */
const humanize = (s) => {
  const t = String(s).replace(/^[A-Z]{1,3}_/, '').replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const shipLabel = (name) => SHIP_LABELS[name] ?? humanize(name);
/** "weapons[1]/Turret[3]/mods[1]/dmgBonus[1]" → ['weapons', 1, 'Turret', 3, …]. */
const pathParts = (p) => p.split('/').flatMap((seg) => {
  const m = /^(.+)\[(\d+)\]$/.exec(seg);
  return [m[1], Number(m[2])];
});

function shipInput(f, label = shipLabel(f.name)) {
  const id = `sf-${f.path}`;
  const attrs = `id="${escapeHtml(id)}" data-path="${escapeHtml(f.path)}"`;
  let input;
  if (f.locked) input = `<span class="ship-locked">${escapeHtml(f.value)}</span>`;
  else if (f.type === 'bool') input = `<label class="switch"><input type="checkbox" ${attrs} ${/^true$/i.test(f.value) ? 'checked' : ''}><span></span></label>`;
  else if (f.choice) {
    const opts = [...new Set([f.value, ...(shipData.choices[f.choice] ?? [])])];
    input = `<select ${attrs}>${opts.map((o) => `<option ${o === f.value ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}</select>`;
  } else if (f.type === 'int' || f.type === 'float') input = `<input type="number" ${attrs} value="${escapeHtml(f.value)}" step="${f.type === 'int' ? 1 : 'any'}">`;
  else input = `<input type="text" ${attrs} value="${escapeHtml(f.value)}" maxlength="200">`;
  return `<label class="ship-field" for="${escapeHtml(id)}"><span>${escapeHtml(label)}</span>${input}</label>`;
}

function renderShipFields() {
  const fields = shipData.fields;
  const used = new Set();
  const take = (f) => (used.add(f.path), f);
  const section = (title, body, open = true) => (body ? `<details class="ship-section" ${open ? 'open' : ''}><summary>${escapeHtml(title)}</summary>${body}</details>` : '');
  const grid = (items) => (items.length ? `<div class="ship-grid-fields">${items.join('')}</div>` : '');
  const top = new Map(fields.filter((f) => !f.path.includes('/')).map((f) => [f.name, f]));
  const html = [];

  for (const [title, names] of SHIP_SECTIONS) html.push(section(title, grid(names.filter((n) => top.has(n)).map((n) => shipInput(take(top.get(n)))))));

  // Shops and factions. A station's shipyard stocks ships whose manufacturer is the station's faction (Independent
  // ships turn up anywhere now and then), each rolled against Sell chance; the factions list is who flies it (NPC
  // ships, fleets) and decides research. A ship with Sell chance 0 is never in a shop: bosses like Tri-Cerberus.
  const sell = top.get('sellChance');
  const manufacturer = top.get('manufacturer')?.value;
  const rep = fields.filter((f) => f.path.startsWith('repReq['));
  const factionBoxes = shipData.factions
    ? `<div class="ship-field"><span>Flown by (NPC factions)</span><div class="faction-picks">${shipData.choices.faction.map((x) => `
        <label class="pick"><input type="checkbox" data-faction="${escapeHtml(x)}" ${shipData.factions.includes(x) ? 'checked' : ''}><span>${escapeHtml(x)}</span></label>`).join('')}</div></div>`
    : '';
  html.push(section('Shops & factions', `
    ${sell && Number(sell.value) === 0 ? `<div class="ship-note">Never sold in shops: its sell chance is 0. Shipyards at <b>${escapeHtml(manufacturer ?? 'its manufacturer’s')}</b> stations sell it once Sell chance is above 0. <button type="button" class="small" data-make-buyable>Make it buyable</button></div>` : ''}
    ${factionBoxes}
    ${grid(rep.map((f) => shipInput(take(f))))}`, sell && Number(sell.value) === 0));

  // Crew seats: one row per seat.
  const seats = new Map();
  for (const f of fields.filter((x) => x.path.startsWith('crewSpace['))) {
    const n = pathParts(f.path)[3];
    if (!seats.has(n)) seats.set(n, []);
    seats.get(n).push(take(f));
  }
  html.push(section('Crew seats', [...seats.values()].map((fs) => {
    const pos = fs.find((f) => f.name === 'position');
    return `<div class="ship-row"><b>${escapeHtml(humanize(pos?.value ?? 'Seat'))}</b>${fs.filter((f) => f !== pos).map((f) => shipInput(f)).join('')}</div>`;
  }).join(''), false));

  // Weapon slots: the slot's own values, and its bonuses folded away.
  const slots = new Map();
  for (const f of fields.filter((x) => x.path.startsWith('weapons['))) {
    const n = pathParts(f.path)[3];
    if (!slots.has(n)) slots.set(n, { own: [], mods: [] });
    (f.path.includes('/mods[') ? slots.get(n).mods : slots.get(n).own).push(take(f));
  }
  html.push(section(`Weapon slots (${slots.size})`, [...slots.entries()].map(([n, s]) => `
    <div class="ship-sub">
      <div class="ship-sub-head">Slot ${n}</div>
      ${grid(s.own.map((f) => shipInput(f)))}
      ${s.mods.length ? `<details class="ship-mods"><summary>Slot bonuses</summary>${grid(s.mods.map((f) => shipInput(f)))}</details>` : ''}
    </div>`).join(''), false));

  // Built-in bonuses: "name" + "value" pairs, shown as one field each.
  const bonuses = new Map();
  for (const f of fields.filter((x) => x.path.startsWith('bonuses['))) {
    const n = pathParts(f.path)[3];
    if (!bonuses.has(n)) bonuses.set(n, []);
    bonuses.get(n).push(take(f));
  }
  html.push(section(`Built-in bonuses (${bonuses.size})`, [...bonuses.values()].map((fs) => {
    const type = fs.find((f) => f.name === 'type' && !f.path.includes('BonusProperty'));
    const props = new Map();
    for (const f of fs.filter((x) => x.path.includes('BonusProperty['))) {
      const key = f.path.replace(/\/[^/]+$/, '');
      if (!props.has(key)) props.set(key, {});
      props.get(key)[f.name] = f;
    }
    const inputs = [...props.values()].filter((p) => p.value).map((p) => shipInput(p.value, humanize(p.name?.value ?? 'Value')));
    const rest = fs.filter((f) => f !== type && !f.path.includes('BonusProperty[')).map((f) => shipInput(f));
    return `<div class="ship-sub"><div class="ship-sub-head">${escapeHtml(humanize(type?.value ?? 'Bonus'))}</div>${grid([...inputs, ...rest])}</div>`;
  }).join(''), false));

  // Anything the groups above don't cover (and isn't the name), so nothing in the file is out of reach.
  const other = fields.filter((f) => !used.has(f.path) && f.name !== 'shipModelName' && !(f.locked && f.path.includes('BonusProperty')));
  html.push(section('Other', grid(other.map((f) => shipInput(f, `${shipLabel(f.name)}${f.path.includes('/') ? ` (${f.path.replace(/\[1\]/g, '').replace(/\/[^/]+$/, '')})` : ''}`))), false));

  document.getElementById('shipFields').innerHTML = html.join('');
  shipChanged();
}

/** { path: newValue } for every field that differs from the file. */
function shipChanges() {
  const out = {};
  const byPath = new Map(shipData.fields.map((f) => [f.path, f]));
  for (const input of document.querySelectorAll('#shipFields [data-path]')) {
    const f = byPath.get(input.dataset.path);
    const v = input.type === 'checkbox' ? String(input.checked) : input.value.trim();
    const same = f.type === 'bool' ? v === String(/^true$/i.test(f.value)) : f.type === 'int' || f.type === 'float' ? v !== '' && Number(v) === Number(f.value) : v === f.value;
    input.closest('.ship-field').classList.toggle('changed', !same);
    if (!same) out[f.path] = v;
  }
  return out;
}

/** The factions list if it was changed, else null. */
function shipFactions() {
  const boxes = [...document.querySelectorAll('#shipFields [data-faction]')];
  if (!boxes.length) return null;
  const list = boxes.filter((b) => b.checked).map((b) => b.dataset.faction);
  const same = list.length === shipData.factions.length && list.every((x) => shipData.factions.includes(x));
  boxes[0].closest('.ship-field').classList.toggle('changed', !same);
  return same ? null : list;
}

function shipChanged() {
  const n = Object.keys(shipChanges()).length + (shipFactions() ? 1 : 0);
  document.getElementById('shipChanged').textContent = n ? `${n} change${n === 1 ? '' : 's'} not saved` : '';
  document.getElementById('shipSave').disabled = n === 0;
}

function showShipData(data) {
  shipData = data;
  const mod = modsCache.find((m) => m.id === data.modId);
  document.getElementById('shipTitle').textContent = `${data.fields.find((f) => f.name === 'shipModelName')?.value ?? displayName(mod)}: ship stats`;
  document.getElementById('shipIntro').textContent =
    `${data.filename}${data.enabled ? '' : ' (this ship mod is off)'}${data.edited ? ' · edited here, the original is kept' : ''}. ` +
    'Changes are written to the ship file and apply the next time Star Valor starts. The first save keeps a copy of the original, so you can always reset it.';
  const reset = document.getElementById('shipReset');
  reset.hidden = !data.canReset;
  reset.textContent = 'Reset to original';
  delete reset.dataset.armed;
  document.getElementById('shipError').textContent = '';
  renderShipFields();
}

async function openShipDialog(modId) {
  showShipData(await api.get(`/api/ships/stats?modId=${encodeURIComponent(modId)}`));
  shipDialog.showModal();
}

document.getElementById('shipFields').addEventListener('input', shipChanged);
// "Make it buyable": sell chance 100 and, for a ship nobody flies, its manufacturer as a faction too.
document.getElementById('shipFields').addEventListener('click', (e) => {
  if (!e.target.closest('[data-make-buyable]')) return;
  const sell = document.querySelector('#shipFields [data-path="sellChance[1]"]');
  if (sell) sell.value = '100';
  const maker = shipData.fields.find((f) => f.path === 'manufacturer[1]')?.value;
  const boxes = [...document.querySelectorAll('#shipFields [data-faction]')];
  if (maker && !boxes.some((b) => b.checked)) boxes.forEach((b) => (b.checked = b.dataset.faction === maker));
  e.target.closest('.ship-note').remove();
  shipChanged();
});
document.getElementById('shipFields').addEventListener('change', shipChanged);
document.getElementById('shipForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const changes = shipChanges();
  const factions = shipFactions();
  const n = Object.keys(changes).length + (factions ? 1 : 0);
  if (!n) return;
  document.getElementById('shipError').textContent = '';
  await busy(document.getElementById('shipSave'), 'Saving…', async () => {
    try {
      showShipData(await api.post('/api/ships/stats', { modId: shipData.modId, changes, factions }));
    } catch (err) {
      document.getElementById('shipError').textContent = err.message;
      return;
    }
    toast(`Saved ${n} change${n === 1 ? '' : 's'}. Restart Star Valor if it's running to use them.`);
    await refreshMods();
  });
  shipChanged();
});
// Two clicks instead of a confirm() box (native dialogs can freeze Electron's window).
document.getElementById('shipReset').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  if (!b.dataset.armed) {
    b.dataset.armed = '1';
    b.textContent = 'Click again to undo all edits';
    return;
  }
  await busy(b, 'Resetting…', async () => {
    showShipData(await api.post('/api/ships/reset', { modId: shipData.modId }));
    toast('Ship put back to its original stats.');
    await refreshMods();
  });
});
document.getElementById('shipCancel').addEventListener('click', () => shipDialog.close());

// ---- Ask dialog (replaces confirm(): native dialogs can freeze Electron's window) ----

const askDialog = document.getElementById('askDialog');
let askResolve = null;

function ask(title, text, { ok = 'OK', danger = false } = {}) {
  askResolve?.(false);
  document.getElementById('askTitle').textContent = title;
  document.getElementById('askText').textContent = text;
  const okButton = document.getElementById('askOk');
  okButton.textContent = ok;
  okButton.classList.toggle('danger', danger);
  askDialog.showModal();
  (danger ? document.getElementById('askCancel') : okButton).focus(); // Enter shouldn't remove/delete
  return new Promise((resolve) => { askResolve = resolve; });
}
function answerAsk(value) {
  const resolve = askResolve;
  askResolve = null;
  if (askDialog.open) askDialog.close();
  resolve?.(value);
}
document.getElementById('askForm').addEventListener('submit', (e) => { e.preventDefault(); answerAsk(true); });
document.getElementById('askCancel').addEventListener('click', () => answerAsk(false));
askDialog.addEventListener('close', () => answerAsk(false)); // Esc

// ---- Update source dialog ----

const sourceDialog = document.getElementById('sourceDialog');
let sourceModId = null;

function openSourceDialog(modId) {
  const mod = modsCache.find((m) => m.id === modId);
  sourceModId = modId;
  document.getElementById('sourceModName').textContent = displayName(mod);
  const s = mod.source;
  document.getElementById('sourceValue').value = !s || !s.manual ? '' : s.type === 'github' ? s.repo : s.type === 'nexus' ? String(s.nexusModId) : 'none';
  document.getElementById('sourceError').textContent = '';
  sourceDialog.showModal();
}
document.getElementById('sourceCancel').addEventListener('click', () => sourceDialog.close());
document.getElementById('sourceForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api.post('/api/updates/source', { modId: sourceModId, value: document.getElementById('sourceValue').value });
    sourceDialog.close();
    toast('Update source saved.');
    await refreshMods();
  } catch (err) {
    document.getElementById('sourceError').textContent = err.message;
  }
});

// ---------------------------------------------------------------------------
// Updates tab
// ---------------------------------------------------------------------------

const UPDATE_STATUS = {
  updated: ['good', '✓ Updated'],
  'up-to-date': ['good', 'Up to date'],
  'update-auto': ['accent', 'Update available'],
  'update-manual': ['accent', 'New version on Nexus'],
  'no-source': ['muted', 'Source unknown'],
  'needs-key': ['warn', 'Needs Nexus key'],
  ignored: ['muted', 'Not checked'],
  error: ['bad', 'Couldn’t check'],
};

function renderUpdates(results) {
  const list = document.getElementById('updateList');
  const summary = document.getElementById('updateSummary');
  const count = (s) => results.filter((r) => r.status === s).length;
  const parts = [];
  if (count('updated')) parts.push(`<b>${count('updated')} updated</b>`);
  if (count('update-auto')) parts.push(`${count('update-auto')} ready to install`);
  if (count('update-manual')) parts.push(`${count('update-manual')} on Nexus need one click each`);
  if (count('up-to-date')) parts.push(`${count('up-to-date')} up to date`);
  const unknown = count('no-source') + count('needs-key');
  if (unknown) parts.push(`${unknown} not identified`);
  if (count('error')) parts.push(`${count('error')} couldn’t be checked`);
  summary.hidden = false;
  summary.innerHTML = parts.join(' · ') || 'No plugins to check.';

  const nameOf = (r) => displayName(modsCache.find((m) => m.id === r.modId) ?? { filename: r.filename });
  list.innerHTML = results.length
    ? results
        .map((r) => {
          const [tone, label] = UPDATE_STATUS[r.status] ?? ['muted', r.status];
          const versions =
            r.status === 'updated' ? `v${escapeHtml(r.installedVersion)} → <b>v${escapeHtml(r.latestVersion)}</b>`
            : r.latestVersion && r.latestVersion !== r.installedVersion ? `v${escapeHtml(r.installedVersion ?? '?')} → v${escapeHtml(r.latestVersion)}`
            : r.installedVersion ? `v${escapeHtml(r.installedVersion)}` : '';
          let action = '';
          if (r.status === 'update-auto') action = `<button class="small primary" data-apply="${r.modId}">${r.risky ? 'Install anyway' : 'Update'}</button>`;
          else if (r.status === 'update-manual') action = `<button class="small primary" data-open-page="${escapeHtml(r.url)}">Get from Nexus</button>`;
          else if (r.status === 'no-source') action = `<button class="small ghost" data-source="${r.modId}">Set source</button>`;
          else if (r.status === 'needs-key') action = `<button class="small ghost" data-goto-settings>Settings</button>`;
          const notes = r.url && r.source?.type === 'github' ? `<button class="small ghost" data-open-page="${escapeHtml(r.url)}">Release notes</button>` : '';
          const extra =
            r.status === 'update-auto' && r.risky ? `<div class="issue-warn small-text">Held back: the new version still has ${r.newProblems} compatibility problem${r.newProblems === 1 ? '' : 's'} with this game version.</div>`
            : r.detail ? `<div class="muted small-text">${escapeHtml(r.detail)}</div>`
            : r.status === 'updated' && r.backup ? `<div class="muted small-text">Old version kept in backups.</div>` : '';
          return `
            <div class="update-row">
              <div class="mod-main">
                <div class="mod-title"><span class="mod-name">${escapeHtml(nameOf(r))}</span> <span class="badge tone-${tone}">${label}</span></div>
                <div class="mod-sub">${versions}${r.source?.type === 'github' ? ` · GitHub ${escapeHtml(r.source.repo)}` : r.source?.type === 'nexus' ? ` · Nexus #${escapeHtml(r.source.nexusModId)}` : ''}</div>
                ${extra}
              </div>
              <div class="btn-row">${notes}${action}</div>
            </div>`;
        })
        .join('')
    : '<p class="muted">No plugins installed.</p>';
}

async function runUpdates(button, endpoint, label) {
  await busy(button, label, async () => {
    for (const b of [document.getElementById('btnCheckUpdates'), document.getElementById('btnUpdateAll')]) b.disabled = true;
    try {
      const { results } = await api.post(endpoint);
      renderUpdates(results);
      const updated = results.filter((r) => r.status === 'updated').length;
      if (endpoint.endsWith('/all')) toast(updated ? `Updated ${updated} mod${updated === 1 ? '' : 's'}.` : 'No automatic updates to install.');
      await refreshMods();
    } finally {
      for (const b of [document.getElementById('btnCheckUpdates'), document.getElementById('btnUpdateAll')]) b.disabled = false;
    }
  });
}
document.getElementById('btnUpdateAll').addEventListener('click', (e) => runUpdates(e.currentTarget, '/api/updates/all', 'Updating…'));
document.getElementById('btnCheckUpdates').addEventListener('click', (e) => runUpdates(e.currentTarget, '/api/updates/check', 'Checking…'));

document.getElementById('updateList').addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.apply) {
    await busy(t, 'Updating…', async () => {
      const { result } = await api.post('/api/updates/apply', { modId: t.dataset.apply });
      toast(result.status === 'updated' ? `Updated ${result.filename} to v${result.latestVersion}.` : `${result.filename}: ${result.detail ?? result.status}`, result.status !== 'updated');
      await refreshMods();
      await runUpdates(document.getElementById('btnCheckUpdates'), '/api/updates/check', 'Checking…');
    });
  } else if (t.dataset.openPage) {
    window.desktop.openModPage(t.dataset.openPage);
  } else if (t.dataset.source) {
    openSourceDialog(t.dataset.source);
  } else if ('gotoSettings' in t.dataset) {
    showTab('settings');
  }
});

// ---------------------------------------------------------------------------
// BepInEx tab
// ---------------------------------------------------------------------------

let bep = null;
let bepChecked = false; // mod checks run automatically the first time the tab is opened
let bepPollTimer = null;
const bepExpanded = new Set();

async function refreshBepInEx({ refresh = false } = {}) {
  bep = await api.get(`/api/bepinex${refresh ? '?refresh=1' : ''}`);
  renderBepInEx();
  if (bep.test?.running) pollTest();
}

async function checkBepInEx(button, version) {
  await busy(button, version ? 'Checking…' : 'Checking versions…', async () => {
    bep = await api.post('/api/bepinex/check', version ? { version } : {});
    bepChecked = true;
    if (bep.checkErrors?.length) toast(bep.checkErrors.join('\n'), true);
    renderBepInEx();
  });
}

const VERDICT = {
  verified: ['good', '✓ Worked here'],
  failed: ['bad', '✕ Failed here'],
  untested: ['muted', 'Not run here yet'],
};

function modsVerdict(v) {
  const ev = v.evaluation;
  if (!ev) return `<button class="small ghost" data-bep-check="${escapeHtml(v.version)}">Check my mods</button>`;
  if (ev.enabledTotal === 0) return '<span class="muted small-text">No plugins enabled</span>';
  return ev.enabledBroken
    ? `<button class="badge tone-bad as-link" data-bep-details="${escapeHtml(v.version)}">✕ ${ev.enabledBroken} of ${ev.enabledTotal} mods won’t work</button>`
    : `<span class="badge tone-good">✓ All ${ev.enabledTotal} mods OK</span>`;
}

function renderBepInEx() {
  if (!bep) return;
  const e = bep.engine;
  document.getElementById('bepEngine').textContent = `Unity ${e.unityVersion ?? '?'} · ${e.backend === 'mono' ? 'Mono' : e.backend === 'il2cpp' ? 'IL2CPP' : '?'} · ${e.arch ?? '?'}`;
  document.getElementById('bepFits').innerHTML = `Game build ${escapeHtml(e.gameBuild ?? '?')} · needs ${escapeHtml(bep.fits)}${
    bep.engineChanged ? `<div class="issue-warn">The game's engine changed since last time (was Unity ${escapeHtml(bep.engineChanged.from.unityVersion)} ${escapeHtml(bep.engineChanged.from.backend)}).</div>` : ''}`;

  const inst = bep.installed;
  document.getElementById('bepInstalled').textContent = inst ? `BepInEx ${inst.version}` : 'Not installed';
  const vi = inst?.verdict;
  document.getElementById('bepInstalledVerdict').innerHTML = !inst ? ''
    : bep.pending ? `<span class="issue-warn">Just installed - ${bep.pending.result && !bep.pending.result.ok ? `failed: ${escapeHtml(bep.pending.result.reason)}` : 'not tested yet'}</span>`
    : vi.state === 'verified' ? `<span class="issue-ok">✓ Works on this game build</span> <span class="muted">(${vi.okCount} good launch${vi.okCount === 1 ? '' : 'es'}, last ${when(vi.lastAt)})</span>`
    : vi.state === 'failed' ? `<span class="issue-broken">✕ Last launch failed${vi.lastError ? `: ${escapeHtml(vi.lastError)}` : ''}</span>`
    : `<span class="issue-warn">Not run on this game build yet</span>`;

  // Recommendation banner
  const rec = bep.recommendation;
  const recEl = document.getElementById('bepRecommendation');
  recEl.hidden = !rec;
  if (rec) {
    recEl.className = `health ${{ bad: 'bad', warn: 'warn', info: 'info', good: 'good' }[rec.tone] ?? 'info'}`;
    const btn =
      rec.action === 'install' ? `<button class="small primary" data-bep-install="${escapeHtml(rec.version)}">Install ${escapeHtml(rec.version)}</button>`
      : rec.action === 'rollback' ? `<button class="small primary" data-bep-rollback>Roll back${rec.version ? ` to ${escapeHtml(rec.version)}` : ''}</button>`
      : rec.action === 'test' ? `<button class="small primary" data-bep-test>▶ Test launch</button>`
      : rec.action === 'check' ? `<button class="small primary" data-bep-check="${escapeHtml(rec.version)}">Check my mods</button>` : '';
    recEl.innerHTML = `<div>${escapeHtml(rec.text)}</div><div class="btn-row">${btn}</div>`;
  }
  const badge = document.getElementById('bepinexBadge');
  badge.hidden = !rec || !['bad', 'warn'].includes(rec.tone);

  // Test mode
  for (const r of document.querySelectorAll('input[name="bepMode"]')) r.checked = r.value === bep.testMode;

  // Versions
  const showAll = document.getElementById('bepShowAll').checked;
  const newestStable = bep.versions.find((v) => !v.prerelease)?.version;
  const newestPre = bep.versions.find((v) => v.prerelease)?.version;
  const shown = bep.versions.filter((v, i) => showAll || v.installed || v.version === newestPre || v.verdict.state !== 'untested' || (!v.prerelease && bep.versions.filter((x) => !x.prerelease).indexOf(v) < 3));
  document.getElementById('bepVersions').innerHTML =
    (bep.releasesError ? `<p class="issue-warn small-text">${escapeHtml(bep.releasesError)}</p>` : '') +
    shown
      .map((v) => {
        const [tone, label] = VERDICT[v.verdict.state];
        const tags = [
          v.installed ? '<span class="badge tone-accent">Installed</span>' : '',
          v.version === newestStable ? '<span class="badge tone-muted">Newest stable</span>' : '',
          v.prerelease ? '<span class="badge tone-warn">Pre-release</span>' : '',
        ].join(' ');
        const action = v.installed
          ? ''
          : `<button class="small ${bep.recommendation?.action === 'install' && bep.recommendation.version === v.version ? 'primary' : 'ghost'}" data-bep-install="${escapeHtml(v.version)}">Install</button>`;
        const open = bepExpanded.has(v.version) && v.evaluation;
        return `
          <div class="bep-row">
            <div class="mod-main">
              <div class="mod-title"><span class="mod-name">BepInEx ${escapeHtml(v.version)}</span> ${tags}</div>
              <div class="mod-sub">Released ${escapeHtml(v.publishedAt.slice(0, 10))} · <a href="#" data-open-page="${escapeHtml(v.url)}">release notes</a></div>
            </div>
            <div class="bep-cell"><div class="bep-cell-label">Mods</div>${modsVerdict(v)}</div>
            <div class="bep-cell"><div class="bep-cell-label">This game build</div><span class="badge tone-${tone}" title="${escapeHtml(v.verdict.lastError ?? '')}">${label}</span></div>
            <div class="bep-cell narrow">${action}</div>
          </div>
          ${open ? `<div class="mod-details"><ul class="issues">${v.evaluation.mods.filter((m) => m.problems.length).map((m) => `
              <li class="issue-${m.enabled ? 'broken' : 'info'}"><b>${escapeHtml(m.filename)}</b>${m.enabled ? '' : ' (off)'} - ${escapeHtml(m.problems[0].detail)}${m.problems.length > 1 ? ` <span class="muted">+${m.problems.length - 1} more</span>` : ''}</li>`).join('')}</ul></div>` : ''}`;
      })
      .join('');

  renderTestPanel();
  renderHealth();
}

function renderTestPanel() {
  const el = document.getElementById('bepTestPanel');
  const t = bep?.test;
  el.hidden = !t;
  if (!t) return;
  if (t.running) {
    el.className = 'card test-panel running';
    el.innerHTML = `<div class="test-line"><span class="spinner"></span> <b>Test launch</b> - ${escapeHtml(t.phase)}</div>
      <div class="muted small-text">Testing BepInEx ${escapeHtml(t.expected ?? '?')} · mode: ${escapeHtml({ 'auto-rollback': 'roll back automatically on failure', ask: 'ask before rolling back', none: 'no test' }[t.mode] ?? t.mode)}</div>`;
    return;
  }
  const r = t.result ?? {};
  el.className = `card test-panel ${r.ok ? 'passed' : 'failed'}`;
  el.innerHTML = `
    <div class="test-line"><b>${r.ok ? '✓ Test passed' : '✕ Test failed'}</b> - ${escapeHtml(r.reason ?? '')}</div>
    ${r.blame?.length ? `<div class="small-text">The error came from: <b>${r.blame.map(escapeHtml).join(', ')}</b> - that's a mod problem rather than BepInEx (see the Mods tab).</div>` : ''}
    ${r.rolledBack ? `<div class="small-text">Rolled back to BepInEx ${escapeHtml(r.rolledBack)} automatically.</div>` : ''}
    ${r.rollbackError ? `<div class="issue-broken small-text">Automatic roll back failed: ${escapeHtml(r.rollbackError)}</div>` : ''}
    ${r.ok ? '<div class="muted small-text">The game was left running for you.</div>' : ''}
    <div class="btn-row spaced">
      ${r.canRollback ? '<button class="small primary" data-bep-rollback>Roll back</button>' : ''}
      <button class="small ghost" data-bep-dismiss>Dismiss</button>
    </div>`;
}

function pollTest() {
  clearTimeout(bepPollTimer);
  bepPollTimer = setTimeout(async () => {
    try {
      const { test } = await api.get('/api/bepinex/test');
      bep.test = test;
      renderTestPanel();
      if (test?.running) return pollTest();
      toast(test?.result?.ok ? 'Test launch passed.' : 'Test launch failed - see the BepInEx tab.', !test?.result?.ok);
      await refreshBepInEx();
      await refreshMods();
    } catch (err) {
      toast(err.message, true);
    }
  }, 2000);
}

async function startTest(button) {
  await busy(button, 'Starting…', async () => {
    const { test } = await api.post('/api/bepinex/test');
    bep.test = test;
    renderTestPanel();
    showTab('bepinex');
    pollTest();
  });
}

async function installBepInEx(button, version) {
  const v = bep.versions.find((x) => x.version === version);
  const mode = document.querySelector('input[name="bepMode"]:checked')?.value ?? bep.testMode;
  const warnings = [];
  if (v?.prerelease) warnings.push('This is a PRE-RELEASE build.');
  if (v?.evaluation?.enabledBroken) warnings.push(`${v.evaluation.enabledBroken} of your ${v.evaluation.enabledTotal} enabled mods won't work with it.`);
  if (v && !v.evaluation) warnings.push("Your mods haven't been checked against it yet.");
  const after = { 'auto-rollback': 'Star Valor will then launch to test it, and your current BepInEx comes back automatically if the test fails.', ask: 'Star Valor will then launch to test it; if it fails you can press Roll back.', none: "It won't be tested now - the next time you play, the manager checks it and offers Roll back if it failed." }[mode];
  const current = bep.installed?.version;
  if (!await ask(`Install BepInEx ${version}${current ? ` (replacing ${current})` : ''}?`, `${warnings.length ? `⚠ ${warnings.join('\n⚠ ')}\n\n` : ''}Only BepInEx itself is swapped - your mods and settings stay. The current version is backed up.\n\n${after}`, { ok: 'Install' })) return;
  await busy(button, 'Installing…', async () => {
    const { test } = await api.post('/api/bepinex/install', { version, mode });
    toast(`BepInEx ${version} installed.`);
    await refreshBepInEx();
    if (test) {
      bep.test = test;
      renderTestPanel();
      pollTest();
    }
  });
}

async function rollbackBepInEx(button) {
  if (!await ask('Put the previous BepInEx back?', 'If Star Valor is running it will be closed first.', { ok: 'Roll back' })) return;
  await busy(button, 'Rolling back…', async () => {
    const r = await api.post('/api/bepinex/rollback', { closeGame: true });
    toast(`Rolled back to BepInEx ${r.restored ?? 'the previous version'}.`);
    if (bep.test) bep.test = null;
    await refreshBepInEx();
  });
}

document.getElementById('tab-bepinex').addEventListener('click', async (e) => {
  const t = e.target.closest('button, a');
  if (!t) return;
  const d = t.dataset;
  if ('bepInstall' in d) await installBepInEx(t, d.bepInstall);
  else if ('bepCheck' in d) await checkBepInEx(t, d.bepCheck);
  else if ('bepRollback' in d) await rollbackBepInEx(t);
  else if ('bepTest' in d) await startTest(t);
  else if ('bepDetails' in d) {
    bepExpanded.has(d.bepDetails) ? bepExpanded.delete(d.bepDetails) : bepExpanded.add(d.bepDetails);
    renderBepInEx();
  } else if ('bepDismiss' in d) {
    bep.test = null;
    renderTestPanel();
  } else if (d.openPage) {
    e.preventDefault();
    window.desktop.openModPage(d.openPage);
  }
});
document.getElementById('btnBepCheck').addEventListener('click', (e) => checkBepInEx(e.currentTarget));
document.getElementById('btnBepTest').addEventListener('click', (e) => startTest(e.currentTarget));
document.getElementById('bepShowAll').addEventListener('change', renderBepInEx);
document.getElementById('bepModes').addEventListener('change', async (e) => {
  if (e.target.name !== 'bepMode') return;
  try {
    await api.post('/api/bepinex/mode', { mode: e.target.value });
    bep.testMode = e.target.value;
    toast('Saved.');
  } catch (err) {
    toast(err.message, true);
  }
});
document.getElementById('tabs').addEventListener('click', (e) => {
  if (e.target.closest('[data-tab="bepinex"]') && !bepChecked) checkBepInEx(null);
});

// ---------------------------------------------------------------------------
// Profiles tab
// ---------------------------------------------------------------------------

let profilesCache = [];
let activeProfileId = null;

async function refreshProfiles() {
  const { profiles, activeProfileId: active } = await api.get('/api/profiles');
  profilesCache = profiles;
  activeProfileId = active;
  renderProfiles();
}

function renderProfiles() {
  const list = document.getElementById('profileList');
  const byId = new Map(modsCache.map((m) => [m.id, m]));
  list.innerHTML = profilesCache
    .map((profile) => {
      const mods = profile.modIds.map((id) => byId.get(id)).filter(Boolean);
      const broken = mods.filter((m) => m.compat?.level === 'broken').length;
      const missing = profile.modIds.length - mods.length;
      const bits = profile.builtIn ? ['Built-in - always zero mods'] : [`${mods.length} mod${mods.length === 1 ? '' : 's'}`];
      if (broken) bits.push(`<span class="issue-broken">${broken} won’t work on this game version</span>`);
      if (missing) bits.push(`<span class="muted">${missing} no longer installed</span>`);
      return `
        <div class="profile-row ${profile.id === activeProfileId ? 'active' : ''}">
          <div class="profile-info">
            <b>${escapeHtml(profile.name)}</b> ${profile.id === activeProfileId ? '<span class="pill-mini good">active</span>' : ''}
            <div class="muted small-text">${bits.join(' · ')}</div>
          </div>
          <div class="btn-row">
            ${profile.builtIn ? '' : `<button class="small ghost" data-edit="${profile.id}">Edit</button>`}
            <button class="small primary" data-apply="${profile.id}">Apply</button>
            <button class="small" data-launch="${profile.id}">▶ Launch</button>
            ${profile.builtIn ? '' : `<button class="small ghost" data-delete="${profile.id}">Delete</button>`}
          </div>
        </div>`;
    })
    .join('');
}

document.getElementById('profileList').addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  const { apply, launch, edit, delete: del } = t.dataset;

  if (apply) {
    await busy(t, 'Applying…', async () => {
      await api.post('/api/profiles/apply', { profileId: apply });
      toast('Profile applied.');
      await refreshProfiles();
      await refreshMods();
      renderProfiles();
    });
  } else if (launch) {
    await busy(t, 'Launching…', async () => {
      await api.post('/api/launch', { profileId: launch });
      toast('Launching Star Valor…');
      await refreshProfiles();
      await refreshMods();
      renderProfiles();
    });
  } else if (edit) {
    openProfileDialog(profilesCache.find((p) => p.id === edit));
  } else if (del) {
    const profile = profilesCache.find((p) => p.id === del);
    if (!await ask(`Delete profile "${profile?.name}"?`, "This doesn't remove any mod files.", { ok: 'Delete', danger: true })) return;
    await busy(t, '', async () => {
      await api.post('/api/profiles/delete', { profileId: del });
      await refreshProfiles();
    });
  }
});

// ---- Profile editor ----

const profileDialog = document.getElementById('profileDialog');
let editingProfileId = null;
const picked = new Set();

function renderPicker() {
  const q = document.getElementById('pickerSearch').value.trim().toLowerCase();
  const picker = document.getElementById('profileModPicker');
  document.getElementById('pickerCount').textContent = `(${picked.size} of ${modsCache.length} selected)`;
  if (modsCache.length === 0) {
    picker.innerHTML = '<p class="muted small-text">No mods installed yet.</p>';
    return;
  }
  const groups = [['plugin', 'Plugins'], ['shipmod', 'Ship mods']];
  const scroll = picker.scrollTop; // re-rendering on every tick would otherwise jump to the top
  picker.innerHTML = groups
    .map(([kind, title]) => {
      const all = modsCache.filter((m) => m.kind === kind);
      if (!all.length) return '';
      const shown = all.filter((m) => !q || `${m.filename} ${displayName(m)}`.toLowerCase().includes(q)).sort((a, b) => displayName(a).localeCompare(displayName(b)));
      const n = all.filter((m) => picked.has(m.id)).length;
      return `
        <div class="picker-group">
          <div class="picker-group-head">
            <b>${title}</b> <span class="muted small-text">${n} of ${all.length}</span>
            <div class="btn-row push">
              <button type="button" class="small ghost" data-pick-group="${kind}" data-on="1">All</button>
              <button type="button" class="small ghost" data-pick-group="${kind}" data-on="0">None</button>
            </div>
          </div>
          <div class="${kind === 'shipmod' ? 'picker-grid' : 'picker-col'}">
            ${shown.map((m) => `
              <label class="pick ${m.compat?.level === 'broken' ? 'lvl-broken' : ''}" title="${escapeHtml(m.filename)}">
                <input type="checkbox" value="${m.id}" ${picked.has(m.id) ? 'checked' : ''}>
                <span>${escapeHtml(displayName(m))}</span>
                ${m.kind === 'plugin' ? compatBadge(m) : ''}
              </label>`).join('') || '<span class="muted small-text">Nothing matches.</span>'}
          </div>
        </div>`;
    })
    .join('');
  picker.scrollTop = scroll;
}

function openProfileDialog(profile) {
  editingProfileId = profile?.id ?? null;
  document.getElementById('profileDialogTitle').textContent = profile ? `Edit "${profile.name}"` : 'New profile';
  document.getElementById('profileName').value = profile?.name ?? '';
  document.getElementById('profileError').textContent = '';
  document.getElementById('pickerSearch').value = '';
  picked.clear();
  const installed = new Set(modsCache.map((m) => m.id));
  for (const id of profile?.modIds ?? []) if (installed.has(id)) picked.add(id);
  renderPicker();
  profileDialog.showModal();
}

document.getElementById('profileModPicker').addEventListener('change', (e) => {
  if (e.target.type !== 'checkbox') return;
  e.target.checked ? picked.add(e.target.value) : picked.delete(e.target.value);
  document.getElementById('pickerCount').textContent = `(${picked.size} of ${modsCache.length} selected)`;
  renderPicker();
});

function visiblePickerMods(kind) {
  const q = document.getElementById('pickerSearch').value.trim().toLowerCase();
  return modsCache.filter((m) => (!kind || m.kind === kind) && (!q || `${m.filename} ${displayName(m)}`.toLowerCase().includes(q)));
}

profileDialog.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.pick === 'all') for (const m of visiblePickerMods()) picked.add(m.id);
  else if (t.dataset.pick === 'none') for (const m of visiblePickerMods()) picked.delete(m.id);
  else if (t.dataset.pick === 'ok') {
    for (const m of visiblePickerMods()) (m.compat?.level === 'broken' ? picked.delete(m.id) : picked.add(m.id));
  } else if (t.dataset.pickGroup) {
    for (const m of visiblePickerMods(t.dataset.pickGroup)) t.dataset.on === '1' ? picked.add(m.id) : picked.delete(m.id);
  } else return;
  renderPicker();
});
document.getElementById('pickerSearch').addEventListener('input', renderPicker);

document.getElementById('btnNewProfile').addEventListener('click', () => openProfileDialog(null));
document.getElementById('profileCancel').addEventListener('click', () => profileDialog.close());

document.getElementById('profileForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('profileName').value.trim();
  const modIds = [...picked];
  try {
    if (editingProfileId) {
      await api.post('/api/profiles/rename', { profileId: editingProfileId, name });
      await api.post('/api/profiles/mods', { profileId: editingProfileId, modIds });
    } else {
      await api.post('/api/profiles', { name, modIds });
    }
    profileDialog.close();
    await refreshProfiles();
  } catch (err) {
    document.getElementById('profileError').textContent = err.message;
  }
});

// ---------------------------------------------------------------------------
// Saves tab
// ---------------------------------------------------------------------------

async function refreshSaves() {
  const { slots } = await api.get('/api/saves');
  renderSaves(slots);
}

function renderSaves(slots) {
  const list = document.getElementById('saveList');
  if (slots.length === 0) {
    list.innerHTML = '<p class="muted">No save slots found yet.</p>';
    return;
  }
  list.innerHTML = slots
    .map((slot) => {
      const info = slot.info;
      const linkBadge =
        slot.link.status === 'tracked' ? `<span class="pill-mini good">${escapeHtml(slot.link.profileName)}</span>`
        : slot.link.status === 'manual' ? `<span class="pill-mini">${escapeHtml(slot.link.profileName)} (marked)</span>`
        : `<span class="pill-mini warn">Unknown</span>`;
      return `
        <div class="save-row">
          <div class="save-info">
            <b>Slot ${slot.slot}${info?.charName ? ` — ${escapeHtml(info.charName)}` : ''}</b> ${linkBadge}
            <div class="muted small-text">
              ${info ? `${escapeHtml(info.gameMode ?? '?')} · Level ${info.level ?? '?'} · ${(info.credits ?? 0).toLocaleString()} credits · ${info.timePlayedHours ?? '?'}h played${info.lastSaveDateTime ? ` · saved ${when(info.lastSaveDateTime)}` : ''}` : slot.infoError ? `Could not read details: ${escapeHtml(slot.infoError)}` : 'No details available'}
            </div>
          </div>
          <div class="btn-row">
            <select data-mark-slot="${slot.slot}">
              <option value="">Mark as…</option>
              ${profilesCache.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}
            </select>
          </div>
        </div>`;
    })
    .join('');
}

document.getElementById('saveList').addEventListener('change', async (e) => {
  const slot = e.target.dataset.markSlot;
  if (!slot || !e.target.value) return;
  try {
    await api.post('/api/saves/link', { slot, profileId: e.target.value, manual: true });
    toast(`Slot ${slot} marked.`);
    await refreshSaves();
  } catch (err) {
    toast(err.message, true);
  }
});

document.getElementById('btnRefreshSaves').addEventListener('click', (e) => busy(e.currentTarget, 'Refreshing…', refreshSaves));

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

async function refreshNexusSettings() {
  const s = await api.get('/api/nexus/settings');
  document.getElementById('nexusKeyStatus').textContent = s.hasApiKey ? '✓ A key is saved - Nexus mods can be checked for updates.' : 'No key saved yet.';
  document.getElementById('updateIntro').textContent = s.hasApiKey
    ? 'Checks every plugin against GitHub and Nexus, installs every safe update automatically, and backs up the old versions. Nexus updates open in the mod browser for one click each (Nexus only lets Premium accounts download through apps).'
    : 'Checks every plugin against GitHub and installs every safe update automatically, backing up the old versions. Add a free Nexus API key in Settings to include Nexus mods too.';
}

document.getElementById('nexusKeyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('nexusKey');
  const apiKey = input.value.trim();
  if (!apiKey) return;
  await busy(e.submitter, 'Checking…', async () => {
    const { user } = await api.post('/api/nexus/key', { apiKey });
    input.value = '';
    toast(`Nexus key saved${user?.name ? ` - signed in as ${user.name}${user.isPremium ? ' (Premium)' : ''}` : ''}.`);
    await refreshNexusSettings();
  });
});
document.getElementById('btnClearKey').addEventListener('click', async () => {
  await api.post('/api/nexus/key', { apiKey: null });
  toast('Nexus key removed.');
  await refreshNexusSettings();
});
document.getElementById('linkNexusKeys').addEventListener('click', (e) => {
  e.preventDefault();
  window.desktop.openModPage('https://next.nexusmods.com/settings/api-keys');
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function boot() {
  try {
    await refreshStatus();
    await refreshMods();
    await refreshProfiles();
    await refreshSaves();
    await refreshNexusSettings();
    await refreshBridgeStatus();
  } catch (err) {
    showGlobalError(err.message);
  }
  // Separate so a GitHub/network hiccup here never blocks the rest of the app from loading.
  refreshBepInEx().catch((err) => toast(`BepInEx check: ${err.message}`, true));
})();
