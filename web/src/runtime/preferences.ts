/** Set before loading application state; real mode retains its original keys. */
export let preferencePrefix = 'falky.';
export function setPreferencePrefix(prefix: string): void {
  preferencePrefix = prefix;
}
