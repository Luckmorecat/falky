import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SignInLink } from '../api/client';
import type { IssuerState } from '../app/deviceSignIn';
import { setLanguage } from '../strings';
import { DeviceLinkFlow, type DeviceLinkIssuer } from './DeviceLinkFlow';

const link: SignInLink = { id: 'link', state: 'open', version: 1, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString(), requests: [], approvalGrantsRecentProof: false };
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); setLanguage('en');
  HTMLDialogElement.prototype.showModal = function() { this.open = true; };
  HTMLDialogElement.prototype.close = function() { this.open = false; };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function renderFlow() {
  let state: IssuerState = { links: [], urls: {}, busy: false };
  const listeners = new Set<() => void>();
  const update = (patch: Partial<IssuerState>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
  let resolve!: (link: SignInLink) => void;
  let reject!: (error: Error) => void;
  const response = new Promise<SignInLink>((yes, no) => { resolve = yes; reject = no; });
  const issuer: DeviceLinkIssuer = {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh: async () => {},
    create: () => { update({ busy: true }); return response; },
    revoke: vi.fn(), approve: vi.fn(), deny: vi.fn(),
  };
  await act(async () => root.render(createElement(DeviceLinkFlow, { issuer, active: true, disabled: false, onScan: vi.fn(), scanFocusRequested: false, onScanFocused: vi.fn() })));
  const create = [...host.querySelectorAll('button')].find(button => button.textContent === 'Create sign-in link')!;
  await act(async () => create.click());
  const dialog = document.querySelector<HTMLDialogElement>('.device-link-drawer')!;
  return {
    dialog,
    complete: async () => { await act(async () => { update({ links: [link], urls: { [link.id]: 'https://example.test/#signin=link' }, busy: false }); resolve(link); }); },
    fail: async () => { await act(async () => { update({ busy: false, problem: { code: 'network' } }); reject(new Error('Offline')); }); },
  };
}
it('opens directly with the result when creation finishes during the grace period', async () => {
  const { dialog, complete } = await renderFlow();
  await act(async () => vi.advanceTimersByTime(100));
  expect(dialog.open).toBe(false);
  await complete();
  expect(dialog.open).toBe(true);
  expect(dialog.querySelector('input')?.value).toBe('https://example.test/#signin=link');
  expect(dialog.querySelector('.device-link-skeleton')).toBeNull();
  await act(async () => vi.advanceTimersByTime(200));
  expect(dialog.querySelector('.device-link-skeleton')).toBeNull();
});
it('shows a skeleton only after 150 ms and replaces it as soon as the result arrives', async () => {
  const { dialog, complete } = await renderFlow();
  await act(async () => vi.advanceTimersByTime(149));
  expect(dialog.open).toBe(false);
  await act(async () => vi.advanceTimersByTime(1));
  expect(dialog.open).toBe(true);
  expect(dialog.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull();
  expect(dialog.querySelector('input')).toBeNull();
  await complete();
  expect(dialog.querySelector('.device-link-skeleton')).toBeNull();
  expect(dialog.querySelector('input')?.value).toContain('#signin=link');
});
it('shows errors promptly and cancels the delayed skeleton', async () => {
  const { dialog, fail } = await renderFlow();
  await act(async () => vi.advanceTimersByTime(50));
  await fail();
  expect(dialog.open).toBe(true);
  expect(dialog.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () => vi.advanceTimersByTime(200));
  expect(dialog.querySelector('.device-link-skeleton')).toBeNull();
});
it('cleans up the delayed fallback when the flow unmounts', async () => {
  await renderFlow();
  await act(async () => root.unmount());
  expect(vi.getTimerCount()).toBe(0);
  root = createRoot(host);
});
