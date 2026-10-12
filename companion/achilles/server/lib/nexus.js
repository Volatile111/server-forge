import { JsonStore } from './store.js';

// Star Valor's Nexus Mods game domain slug, confirmed via its Steam community modding guide
// (Nexus Mods is called out there as "the primary spot to find mods").
export const NEXUS_GAME_DOMAIN = 'starvalor';
const NEXUS_API_BASE = 'https://api.nexusmods.com/v1';

/**
 * Free-account API keys can browse/search mods and read mod details, but Nexus restricts
 * generating an actual download link to Premium members or a browser-initiated "Mod Manager
 * Download" handoff (nxm:// links). Since this app assumes a free account (confirmed with the
 * user), it never calls the download-link endpoint at all - downloads happen by opening the mod's
 * Nexus page in the built-in mod browser window and intercepting the file there (see
 * desktop/main.js's mod browser, same pattern Tavern Host uses for CurseForge/addon sites), not
 * through this API client.
 */
export class NexusClient {
  constructor(dataDir) {
    this.settings = new JsonStore(dataDir, 'settings.json', { nexusApiKey: null });
  }

  getApiKey() {
    return this.settings.read().nexusApiKey;
  }

  setApiKey(apiKey) {
    this.settings.update((data) => {
      data.nexusApiKey = apiKey ? String(apiKey).trim() : null;
      return data;
    });
  }

  async _get(pathAndQuery) {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error('No Nexus Mods API key set yet (Settings - paste your personal API key from your Nexus account).');

    const res = await fetch(`${NEXUS_API_BASE}${pathAndQuery}`, {
      headers: { apikey: apiKey, 'Content-Type': 'application/json', 'User-Agent': 'AchillesModManager/0.3.0' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Nexus API error (HTTP ${res.status}): ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  /** Confirms the API key works and returns basic account info (also how Nexus's own docs say to
   * validate a key before using it for anything else). */
  validateKey() {
    return this._get('/users/validate.json');
  }

  /** Mods trending/updated recently for Star Valor - Nexus doesn't expose free-text search over
   * the public API, so "browse recently updated" is the practical entry point; real searching
   * happens in the mod browser window (the actual Nexus website), same as installing does. */
  listUpdatedMods(period = '1m') {
    return this._get(`/games/${NEXUS_GAME_DOMAIN}/mods/updated.json?period=${encodeURIComponent(period)}`);
  }

  getModDetails(modId) {
    return this._get(`/games/${NEXUS_GAME_DOMAIN}/mods/${encodeURIComponent(modId)}.json`);
  }

  getModFiles(modId) {
    return this._get(`/games/${NEXUS_GAME_DOMAIN}/mods/${encodeURIComponent(modId)}/files.json`);
  }

  /** Identifies an installed file by its MD5 - returns which Nexus mod AND which exact file
   * version it is. Works on free accounts. Resolves to [] (not an error) when Nexus doesn't know
   * the file, which it reports as HTTP 404. */
  async md5Search(md5) {
    try {
      return await this._get(`/games/${NEXUS_GAME_DOMAIN}/mods/md5_search/${md5}.json`);
    } catch (err) {
      if (/HTTP 404/.test(err.message)) return [];
      throw err;
    }
  }
}

export function nexusFilePageUrl(modId, fileId) {
  return fileId
    ? `https://www.nexusmods.com/${NEXUS_GAME_DOMAIN}/mods/${modId}?tab=files&file_id=${fileId}`
    : `https://www.nexusmods.com/${NEXUS_GAME_DOMAIN}/mods/${modId}?tab=files`;
}

export function nexusModPageUrl(modId) {
  return `https://www.nexusmods.com/${NEXUS_GAME_DOMAIN}/mods/${modId}`;
}

export function nexusBrowseUrl() {
  return `https://www.nexusmods.com/${NEXUS_GAME_DOMAIN}/mods/`;
}
