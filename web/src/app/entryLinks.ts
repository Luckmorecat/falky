export interface EntryLinks {
  guest?: string;
  invitation?: string;
  recovery?: { accountId: string; proof: string };
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
  if (!['k', 'invite', 'recover', 'account'].some((key) => fragment.has(key))) return false;
  const guest = fragment.get('k');
  const invitation = fragment.get('invite');
  const proof = fragment.get('recover');
  const accountId = fragment.get('account');
  links = { ...links, ...(guest ? { guest } : {}), ...(invitation ? { invitation } : {}), ...(proof !== null && accountId !== null ? { recovery: { accountId, proof } } : {}) };
  for (const key of ['k', 'invite', 'recover', 'account']) fragment.delete(key);
  history.replaceState(null, '', location.pathname + location.search + (fragment.size ? `#${fragment}` : ''));
  publish();
  return true;
}
