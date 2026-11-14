import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLanguage } from '../strings';
import { register, completeEnrollment, authenticate } from '../app/accounts';
import { AccountFlowProvider, useAccountUI } from './AccountFlow';
vi.mock('../app/accounts', () => ({ cancelAccountFlow: vi.fn(), completeEnrollment: vi.fn(), authenticate: vi.fn(), register: vi.fn(), recover: vi.fn(), recoveryPhrase: (codes: string[]) => codes[0] }));
vi.mock('../app/controller', () => ({ enter: vi.fn(), reconcileSession: vi.fn() }));
vi.mock('../app/entryLinks', () => ({ getEntryLinks: () => links, getDeviceEntry: () => deviceEntry, clearDeviceEntry: vi.fn(() => { deviceEntry = null; }), takeDeviceEntry: () => { const entry = deviceEntry; deviceEntry = null; return entry; }, subscribeEntryLinks: () => () => {}, clearEntryLinks: vi.fn() }));
vi.mock('../app/store', () => ({ useApp: (selector: (state: unknown) => unknown) => selector({ phase: 'ready', accountSession, visitor: { name: 'Sam' }, settings: { language: 'en' } }) }));
vi.mock('./Orb', () => ({ Orb: () => createElement('div') }));
vi.mock('./DeviceSignIn', () => ({ DeviceScanner: ({ token, onClose }: { token?: string; onClose(): void }) => { if (scannerPending) throw scannerPending; return createElement('section', {}, createElement('p', {}, token ? 'Review request' : 'Camera reader'), createElement('button', { onClick: onClose }, 'Back to Account')); }, DeviceReceiver: () => createElement('p', {}, 'Receiving request') }));
let scannerPending: Promise<void> | undefined;
let deviceEntry: { type: 'qr' | 'link'; token: string } | null = null;
let accountSession: { kind: 'account'; visitor: { id: string } } | null = null;
let links: { invitation?: string } = {};
let host: HTMLDivElement;
let root: Root;
let resolveOperation: (() => void) | undefined;
function Harness() { const ui = useAccountUI(); return createElement('div', {},
  createElement('button', { onClick: () => ui.presentKit('permanent-id', 'one two three four five six seven eight nine ten eleven yo-yo') }, 'New kit'),
  createElement('button', { onClick: () => { void ui.run(() => new Promise<void>(resolve => { resolveOperation = resolve; })); } }, 'Start'),
  createElement('button', { onClick: ui.exit }, 'Exit'),
  createElement('button', { onClick: ui.openScanner }, 'Scan'),
); }
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); setLanguage('en'); links = {}; deviceEntry = null; accountSession = null; scannerPending = undefined; vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function() { this.open = true; };
  HTMLDialogElement.prototype.close = function() { this.open = false; };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(AccountFlowProvider, { children: createElement(Harness) })));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('keeps a once-only kit above its calling surface through Escape, backdrop and alternate navigation', async () => {
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'New kit')!.click());
  const dialog = host.querySelector<HTMLDialogElement>('dialog.auth-dialog')!;
  expect(dialog.open).toBe(true);
  await act(async () => { dialog.dispatchEvent(new Event('cancel', { cancelable: true })); dialog.dispatchEvent(new Event('pointerdown', { bubbles: true })); [...host.querySelectorAll('button')].find(button => button.textContent === 'Exit')!.click(); });
  expect(dialog.open).toBe(true);
  expect(dialog.textContent).toContain('permanent-id');
  const next = [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Continue')!;
  expect(next.disabled).toBe(true);
  await act(async () => dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => next.click());
  expect(dialog.open).toBe(false); expect(dialog.textContent).not.toContain('yo-yo');
});
it('blocks dismissal while a once-only response is in flight', async () => {
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Start')!.click());
  const dialog = host.querySelector<HTMLDialogElement>('dialog.auth-dialog')!;
  await act(async () => dialog.dispatchEvent(new Event('cancel', { cancelable: true })));
  expect(dialog.open).toBe(true);
  await act(async () => resolveOperation!());
  expect(dialog.open).toBe(false);
});

it('requires acknowledgement before adopting a staged registration and cannot dismiss an uncertain finish', async () => {
  links = { invitation: 'unconsumed-invitation' };
  vi.mocked(register).mockRejectedValue({ code: 'outcome_unknown' });
  await act(async () => root.render(createElement(AccountFlowProvider, { children: createElement(Harness) })));
  const dialog = host.querySelector<HTMLDialogElement>('dialog.auth-dialog')!;
  await act(async () => [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Create your passkey')!.click());
  expect(dialog.textContent).toContain('Restore session');
  await act(async () => dialog.dispatchEvent(new Event('cancel', { cancelable: true })));
  expect(dialog.open).toBe(true);
  expect(dialog.textContent).toContain('Restore session');
  expect(completeEnrollment).not.toHaveBeenCalled();
});

it('keeps the invitation form mounted during a retryable name conflict', async () => {
  links = { invitation: 'unconsumed-invitation' };
  vi.mocked(register).mockRejectedValue({ code: 'name_taken' });
  await act(async () => root.render(createElement(AccountFlowProvider, { children: createElement(Harness) })));
  const dialog = host.querySelector<HTMLDialogElement>('dialog.auth-dialog')!;
  const name = dialog.querySelector('input')!;
  await act(async () => [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Create your passkey')!.click());
  expect(dialog.querySelector('input')).toBe(name);
  expect(dialog.textContent).toContain('name');
});

it('adopts registration only after acknowledging the genuine server kit', async () => {
  links = { invitation: 'unconsumed-invitation' };
  const enrollment = { session: { kind: 'account' as const, visitor: { id: 'permanent-id', name: 'Sam', nameTaken: false, colour: { visitorId: 'permanent-id', palette: 'sky' as const, revision: 1 } }, expiresAt: '2027-01-01T00:00:00Z' }, recoveryCodes: ['one two three four five six seven eight nine ten eleven yo-yo'], sessionEpoch: 2 };
  vi.mocked(register).mockImplementation(async () => { links = {}; return enrollment; });
  await act(async () => root.render(createElement(AccountFlowProvider, { children: createElement(Harness) })));
  const dialog = host.querySelector<HTMLDialogElement>('dialog.auth-dialog')!;
  await act(async () => [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Create your passkey')!.click());
  expect(completeEnrollment).not.toHaveBeenCalled();
  expect(dialog.querySelectorAll('ol li')).toHaveLength(12);
  expect(dialog.textContent).toContain('permanent-id');
  await act(async () => dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Continue')!.click());
  expect(completeEnrollment).toHaveBeenCalledWith(enrollment);
  expect(dialog.open).toBe(false);
  expect(dialog.textContent).not.toContain('yo-yo');
});

it('offers a newly captured invitation after an earlier entry flow was explicitly exited', async () => {
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Exit')!.click());
  links = { invitation: 'new-invitation' };
  await act(async () => root.render(createElement(AccountFlowProvider, { children: createElement(Harness) })));
  expect(host.querySelector<HTMLDialogElement>('dialog.auth-dialog')!.textContent).toContain('Create your passkey');
});

it('retains a QR approval handoff through authentication and consumes it only for review', async () => {
  deviceEntry = { type: 'qr', token: 'memory-only-request' };
  vi.mocked(authenticate).mockImplementation(async () => { accountSession = { kind: 'account', visitor: { id: 'actual-account' } }; return { session: { kind: 'account', visitor: { id: 'actual-account', name: 'Sam', nameTaken: false, colour: { visitorId: 'actual-account', palette: 'sky', revision: 1 } } }, recoveryCodes: [] }; });
  await act(async () => root.render(createElement(AccountFlowProvider, { children: createElement(Harness) })));
  expect(host.querySelector('.device-dialog')?.textContent).not.toContain('Review request');
  expect(deviceEntry?.token).toBe('memory-only-request');
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Sign in with a passkey')!.click());
  await vi.waitFor(() => expect(host.querySelector('.device-dialog')?.textContent).toContain('Review request'));
  expect(deviceEntry).toBeNull();
  expect(completeEnrollment).not.toHaveBeenCalled();
});
it('abandons pending QR authority on explicit auth cancellation', async () => {
  deviceEntry = { type: 'qr', token: 'abandoned-request' };
  await act(async () => root.render(createElement(AccountFlowProvider, { children: createElement(Harness) })));
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Exit')!.click());
  expect(deviceEntry).toBeNull();
  expect(host.querySelector('.device-dialog')?.textContent).not.toContain('Review request');
});

it('opens a quickly loaded scanner without showing the loading screen', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  scannerPending = new Promise<void>(resolve => { finish = resolve; });
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Scan')!.click());
  const dialog = host.querySelector<HTMLDialogElement>('.device-dialog')!;
  expect(dialog.open).toBe(false);
  await act(async () => vi.advanceTimersByTime(100));
  expect(dialog.open).toBe(false);
  await act(async () => { scannerPending = undefined; finish(); });
  expect(dialog.open).toBe(true);
  expect(dialog.textContent).toContain('Camera reader');
  expect(dialog.textContent).not.toContain('Loading…');
  await act(async () => vi.advanceTimersByTime(150));
  expect(dialog.textContent).not.toContain('Loading…');
});

it('delays the loading screen by 150ms and cancels a pending scanner without reopening it', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  scannerPending = new Promise<void>(resolve => { finish = resolve; });
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Scan')!.click());
  const dialog = host.querySelector<HTMLDialogElement>('.device-dialog')!;
  await act(async () => vi.advanceTimersByTime(149));
  expect(dialog.open).toBe(false);
  await act(async () => vi.advanceTimersByTime(1));
  expect(dialog.open).toBe(true);
  expect(dialog.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe('Loading…');
  expect(dialog.querySelector('.device-camera')).not.toBeNull();
  expect(dialog.textContent).not.toContain('Finishing securely');
  await act(async () => dialog.querySelector('button')!.click());
  expect(dialog.open).toBe(false);
  await act(async () => { scannerPending = undefined; finish(); vi.advanceTimersByTime(150); });
  expect(dialog.open).toBe(false);
  expect(dialog.textContent).not.toContain('Camera reader');
});
