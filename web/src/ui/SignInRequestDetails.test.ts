import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import type { SignInRequest } from '../api/client';
import { setLanguage } from '../strings';
import { requestDevice, SignInRequestDetails } from './SignInRequestDetails';

vi.mock('../app/store', () => ({ useApp: (select: (state: unknown) => unknown) => select({ settings: { language: 'en' } }) }));

beforeEach(() => setLanguage('en'));
it.each([
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 'iPhone'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X) Mobile/15E148', 'iPad'],
  ['Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile', 'Android phone'],
  ['Mozilla/5.0 (Linux; Android 15; Tablet)', 'Android device'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Windows PC'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X)', 'Mac'],
  ['Mozilla/5.0 (X11; CrOS x86_64)', 'Chromebook'],
  ['Mozilla/5.0 (X11; Linux x86_64)', 'Linux PC'],
  ['', 'Device'],
  ['Some unrecognised browser description', 'Device'],
])('describes %s as %s', (agent, expected) => expect(requestDevice(agent)).toBe(expected));

it('localizes inferred device names', () => {
  setLanguage('uk');
  expect(requestDevice('Windows NT 10.0')).toBe('Комп’ютер Windows');
  expect(requestDevice('')).toBe('Пристрій');
});

it.each<[SignInRequest['requesterLocation'], string | undefined]>([
  [{ city: 'Kyiv', countryCode: 'UA' }, 'Kyiv, Ukraine'],
  [{ countryCode: 'UA' }, 'Ukraine'],
  [{ city: 'Kyiv' }, 'Kyiv'],
  [undefined, undefined],
])('renders location %j alongside the IP', async (requesterLocation, expected) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const request: SignInRequest = {
    id: 'request', type: 'qr', state: 'pending', version: 1, requesterUserAgent: 'Browser',
    createdAt: '2026-11-23T00:00:00Z', expiresAt: '2026-11-23T00:05:00Z',
    requesterIp: '203.0.113.42', requesterLocation,
  };
  try {
    await act(async () => root.render(createElement(SignInRequestDetails, { request })));
    expect(host.querySelector('.device-request-location bdi')?.textContent).toBe(expected);
    expect(host.querySelector('.device-request-location [aria-hidden]')?.textContent?.trim()).toBe(expected && '≈');
    expect(host.querySelector('.device-request-ip')?.textContent).toBe('203.0.113.42');
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
