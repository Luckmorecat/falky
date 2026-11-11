import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLanguage } from '../strings';
import { register, completeEnrollment } from '../app/accounts';
import { AccountFlowProvider, useAccountUI } from './AccountFlow';
vi.mock('../app/accounts', () => ({ cancelAccountFlow: vi.fn(), completeEnrollment: vi.fn(), authenticate: vi.fn(), register: vi.fn(), recover: vi.fn(), recoveryPhrase: (codes: string[]) => codes[0] }));
vi.mock('../app/controller', () => ({ enter: vi.fn(), reconcileSession: vi.fn() }));
vi.mock('../app/entryLinks', () => ({ getEntryLinks: () => links, subscribeEntryLinks: () => () => {}, clearEntryLinks: vi.fn() }));
vi.mock('../app/store', () => ({ useApp: (selector: (state: unknown) => unknown) => selector({ phase: 'ready', visitor: { name: 'Sam' }, settings: { language: 'en' } }) }));
vi.mock('./Orb', () => ({ Orb: () => createElement('div') }));
let links: { invitation?: string } = {};
let host: HTMLDivElement;
let root: Root;
let resolveOperation: (() => void) | undefined;
function Harness() { const ui = useAccountUI(); return createElement('div', {},
  createElement('button', { onClick: () => ui.presentKit('permanent-id', 'one two three four five six seven eight nine ten eleven yo-yo') }, 'New kit'),
  createElement('button', { onClick: () => { void ui.run(() => new Promise<void>(resolve => { resolveOperation = resolve; })); } }, 'Start'),
  createElement('button', { onClick: ui.exit }, 'Exit'),
); }
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); setLanguage('en'); links = {}; vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function() { this.open = true; };
  HTMLDialogElement.prototype.close = function() { this.open = false; };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(AccountFlowProvider, { children: createElement(Harness) })));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
it('keeps a once-only kit above its calling surface through Escape, backdrop and alternate navigation', async () => {
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'New kit')!.click());
  const dialog = host.querySelector('dialog')!;
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
  const dialog = host.querySelector('dialog')!;
  await act(async () => dialog.dispatchEvent(new Event('cancel', { cancelable: true })));
  expect(dialog.open).toBe(true);
  await act(async () => resolveOperation!());
  expect(dialog.open).toBe(false);
});

it('requires acknowledgement before adopting a staged registration and cannot dismiss an uncertain finish', async () => {
  links = { invitation: 'unconsumed-invitation' };
  vi.mocked(register).mockRejectedValue({ code: 'outcome_unknown' });
  await act(async () => root.render(createElement(AccountFlowProvider, { children: createElement(Harness) })));
  const dialog = host.querySelector('dialog')!;
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
  const dialog = host.querySelector('dialog')!;
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
  const dialog = host.querySelector('dialog')!;
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
  expect(host.querySelector('dialog')!.textContent).toContain('Create your passkey');
});
