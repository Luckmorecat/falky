export interface EntryLinks {
  guest?: string;
  invitation?: string;
  recovery?: { accountId: string; proof: string };
}

export type DeviceEntry = { type: 'link' | 'qr'; token: string };
let deviceEntry: DeviceEntry | null = null;
export function getDeviceEntry(): DeviceEntry | null { return deviceEntry; }
export function clearDeviceEntry(): void { deviceEntry = null; publish(); }
export function takeDeviceEntry(): DeviceEntry | null {
  const entry = deviceEntry;
  clearDeviceEntry();
  return entry;
}

/** Scanned URLs are parsed as data, never navigated. */
export function parseDeviceSignInURL(value: string, origin = location.origin): DeviceEntry | null {
  if (value.length > 2048) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.origin !== origin || url.username || url.password || url.pathname !== '/' || url.search) return null;
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (fragment.size !== 1) return null;
  const key = fragment.has('signin') ? 'signin' : 'qr-signin';
  const token = fragment.get(key);
  if (!token || token.length > 256 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  return { type: key === 'signin' ? 'link' : 'qr', token };
}

let links: EntryLinks = {};
const listeners = new Set<() => void>();
function publish(): void { listeners.forEach((listener) => listener()); }
export function subscribeEntryLinks(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function getEntryLinks(): EntryLinks { return links; }
export function clearEntryLinks(kind?: keyof EntryLinks): void {
  if (kind) { const next = { ...links }; delete next[kind]; links = next; }
  else links = {};
  publish();
}

export function captureEntryLinks(): boolean {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const hasDevice = fragment.has('signin') || fragment.has('qr-signin');
  if (hasDevice) {
    const deviceFragment = new URLSearchParams();
    for (const key of ['signin', 'qr-signin', 'k', 'invite', 'recover', 'account']) {
      for (const value of fragment.getAll(key)) deviceFragment.append(key, value);
    }
    deviceEntry = location.pathname === '/' ? parseDeviceSignInURL(`${location.origin}/#${deviceFragment}`) : null;
  }
  if (!['signin', 'qr-signin', 'k', 'invite', 'recover', 'account'].some((key) => fragment.has(key))) return false;
  const guest = fragment.get('k');
  const invitation = fragment.get('invite');
  const proof = fragment.get('recover');
  const accountId = fragment.get('account');
  links = { ...links, ...(guest ? { guest } : {}), ...(invitation ? { invitation } : {}), ...(proof !== null && accountId !== null ? { recovery: { accountId, proof } } : {}) };
  for (const key of ['signin', 'qr-signin', 'k', 'invite', 'recover', 'account']) fragment.delete(key);
  history.replaceState(null, '', location.pathname + location.search + (fragment.size ? `#${fragment}` : ''));
  publish();
  return true;
}
