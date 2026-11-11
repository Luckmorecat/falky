import { getDeviceEntry, getEntryLinks } from '../app/entryLinks';
import { preparePreferences } from './preferences';
import { bootstrapState, refreshMockState, subscribeMockState } from './state';

interface Navigation {
  href(): string;
  replaceURL(url: string): void;
  reload(): void;
}
const browserNavigation: Navigation = {
  href: () => location.href,
  replaceURL: (url) => history.replaceState(null, '', url),
  reload: () => location.reload(),
};

/** Runs before prefs/store/controller imports. Reset observation never uses public live. */
export async function bootstrap(navigation: Navigation = browserNavigation): Promise<void> {
  const url = new URL(navigation.href());
  const state = await bootstrapState(url.searchParams.get('scenario') ?? undefined);
  preparePreferences(state.instanceId, state.generation);
  if (state.scenario === 'entry' && !state.visitor && !getDeviceEntry() && !Object.keys(getEntryLinks()).length && !['k', 'invite', 'recover', 'signin', 'qr-signin'].some((key) => new URLSearchParams(url.hash.slice(1)).has(key))) {
    url.hash = new URL(state.accessLink, url).hash;
    navigation.replaceURL(url.href);
  }
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const unsubscribe = subscribeMockState((next) => {
    if (next.instanceId === state.instanceId && next.generation === state.generation) return;
    stop();
    const nextURL = new URL(navigation.href());
    // Do not let the old page's query reselect its fixture after an external reset.
    nextURL.searchParams.set('scenario', next.scenario);
    nextURL.hash = '';
    navigation.replaceURL(nextURL.href);
    // Fresh bootstrap clears owned prefs after old promises/timers have been destroyed.
    navigation.reload();
  });
  function stop() {
    stopped = true;
    clearTimeout(timer);
    unsubscribe();
    removeEventListener('pagehide', stop);
  }
  async function poll() {
    try { await refreshMockState(); } catch { /* Restart may briefly interrupt the control channel. */ }
    if (!stopped) timer = setTimeout(() => void poll(), 250);
  }
  addEventListener('pagehide', stop, { once: true });
  timer = setTimeout(() => void poll(), 250);
}
