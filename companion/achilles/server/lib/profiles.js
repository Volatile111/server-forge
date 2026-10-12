import { randomUUID } from 'node:crypto';
import { JsonStore } from './store.js';

/**
 * A profile is just a named set of mod ids that should be enabled together (everything else
 * gets disabled). "Vanilla" is a permanent built-in profile with an empty mod set - applying it
 * disables every mod, giving an unmodded game, exactly the "vanilla experience" toggle asked for.
 */
const VANILLA_PROFILE = { id: 'vanilla', name: 'Vanilla', modIds: [], builtIn: true };

export class ProfileStore {
  constructor(dataDir) {
    this.store = new JsonStore(dataDir, 'profiles.json', { profiles: [VANILLA_PROFILE], activeProfileId: null });
  }

  list() {
    return this.store.read().profiles;
  }

  getActiveProfileId() {
    return this.store.read().activeProfileId;
  }

  create(name, modIds = []) {
    return this.store.update((data) => {
      const profile = { id: randomUUID(), name: String(name).trim().slice(0, 60) || 'New profile', modIds: [...modIds], builtIn: false };
      data.profiles.push(profile);
      return data;
    }).profiles.at(-1);
  }

  rename(profileId, name) {
    this.store.update((data) => {
      const profile = data.profiles.find((p) => p.id === profileId);
      if (!profile) throw new Error('Profile not found.');
      if (profile.builtIn) throw new Error('The Vanilla profile cannot be renamed.');
      profile.name = String(name).trim().slice(0, 60) || profile.name;
      return data;
    });
  }

  setModIds(profileId, modIds) {
    return this.store.update((data) => {
      const profile = data.profiles.find((p) => p.id === profileId);
      if (!profile) throw new Error('Profile not found.');
      if (profile.builtIn) throw new Error('The Vanilla profile always has zero mods.');
      profile.modIds = [...new Set(modIds)];
      return data;
    }).profiles.find((p) => p.id === profileId);
  }

  delete(profileId) {
    this.store.update((data) => {
      const profile = data.profiles.find((p) => p.id === profileId);
      if (!profile) return data;
      if (profile.builtIn) throw new Error('The Vanilla profile cannot be deleted.');
      data.profiles = data.profiles.filter((p) => p.id !== profileId);
      if (data.activeProfileId === profileId) data.activeProfileId = null;
      return data;
    });
  }

  /** Applies `profile.modIds` to the live mod library (enable those, disable everything else),
   * then remembers it as the active profile. */
  apply(profileId, modLibrary) {
    const profiles = this.list();
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error('Profile not found.');

    const wanted = new Set(profile.modIds);
    for (const mod of modLibrary.list()) {
      const shouldBeEnabled = wanted.has(mod.id);
      if (mod.enabled !== shouldBeEnabled) modLibrary.setEnabled(mod.id, shouldBeEnabled);
    }

    this.store.update((data) => {
      data.activeProfileId = profileId;
      return data;
    });

    return profile;
  }
}

export { VANILLA_PROFILE };
