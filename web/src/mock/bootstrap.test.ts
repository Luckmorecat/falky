import { afterEach, expect, it, vi } from 'vitest';
import { prefs } from '../app/prefs';
import { bootstrap } from './bootstrap';

const faultDefaults = { send: 'none', delayMs: 0, liveDisconnected: false, roomFull: null, micDenied: false, shareFailure: false, voiceReconnecting: false };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); });

it('scopes prefs before app load and observes a reset independently of revoked or disconnected live state', async () => {
  vi.useFakeTimers();
  let state = { instanceId: 'boot-test', generation: 1, revision: 1, scenario: 'entry', visitor: null, voiceRoomId: null, accessLink: '/#k=mock-access-link', rooms: [], peers: {}, faults: faultDefaults, scenarios: ['entry', 'quiet'] };
  const bodies: unknown[] = [];
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    if (init?.body) bodies.push(JSON.parse(init.body as string));
    return Response.json(state);
  });
  let url = 'http://localhost/?scenario=entry';
  const reload = vi.fn();
  const navigation = { href: () => url, replaceURL: (next: string) => { url = next; }, reload };
  await bootstrap(navigation);
  expect(bodies[0]).toEqual({ scenario: 'entry' });
  expect(new URL(url).hash).toBe('#k=mock-access-link');
  prefs.saveSettings({ ...prefs.settings(), theme: 'light', lang: 'en' });
  // Both failure states leave the independent control channel available.
  state = { ...state, generation: 2, revision: 2, scenario: 'quiet', faults: { ...faultDefaults, liveDisconnected: true } };
  await vi.advanceTimersByTimeAsync(300);
  expect(reload).toHaveBeenCalledOnce();
  expect(new URL(url).searchParams.get('scenario')).toBe('quiet');
  expect(new URL(url).hash).toBe('');
  await bootstrap(navigation);
  expect(bodies.at(-1)).toEqual({ scenario: 'quiet' });
  expect(prefs.settings()).toMatchObject({ theme: 'dark', lang: 'uk' });
});
