import { JsonStore } from './store.js';

/**
 * Tracks which mod profile was active each time a given save slot was played through this
 * manager - the reliable, forward-looking half of "detect vanilla vs modded save" (see
 * profiles.js's apply()). Every save slot that already existed before this tool was ever run has
 * no such record, so it starts as "unknown" rather than a fabricated guess - the user can mark it
 * vanilla/modded once by hand (setManual), after which it's remembered exactly like a
 * tool-tracked save from then on. This is the honest middle ground: real bookkeeping for
 * everything played going forward, a clearly-labeled "unknown, played before tracking" for
 * anything older, correctable in one click rather than silently wrong.
 */
export class SaveLinkStore {
  constructor(dataDir) {
    this.store = new JsonStore(dataDir, 'save-links.json', { links: {} });
  }

  /** { status: 'tracked'|'manual'|'unknown', profileId, profileName } for one slot. */
  getStatus(slot, profilesById) {
    const link = this.store.read().links[slot];
    if (!link) return { status: 'unknown', profileId: null, profileName: null };
    const profile = profilesById.get(link.profileId);
    return { status: link.source, profileId: link.profileId, profileName: profile?.name ?? '(deleted profile)' };
  }

  /** Called right when the manager applies a profile and is about to launch into this slot -
   * this is the authoritative, "we actually know" record. */
  recordPlayed(slot, profileId) {
    this.store.update((data) => {
      data.links[slot] = { profileId, source: 'tracked', at: new Date().toISOString() };
      return data;
    });
  }

  /** The user manually says "this old save is vanilla" or "this old save is modded, treat it as
   * profile X" for a save the tool never tracked. */
  setManual(slot, profileId) {
    this.store.update((data) => {
      data.links[slot] = { profileId, source: 'manual', at: new Date().toISOString() };
      return data;
    });
  }
}
