import { setPreferencePrefix } from '../runtime/preferences';

/** Instance-owned keys only: mock reset must never erase normal development prefs. */
export function preparePreferences(instanceId: string, generation: number): void {
  const prefix = `falky.mock.${instanceId}.`;
  const marker = `falky.mock-generation.${instanceId}`;
  try {
    if (localStorage.getItem(marker) !== String(generation)) {
      for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key);
      localStorage.setItem(marker, String(generation));
    }
  } catch {
    // Private storage can be unavailable, just as in normal mode.
  }
  setPreferencePrefix(prefix);
}
