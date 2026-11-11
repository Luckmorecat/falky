import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { CandidateState } from '../app/deviceSignIn';
import { DeviceReceiver } from './DeviceSignIn';
import { setLanguage } from '../strings';
const model = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return { state: {} as CandidateState, listeners, beginLink: vi.fn().mockResolvedValue(undefined), finish: vi.fn(), dispose: vi.fn() };
});
vi.mock('../app/deviceSignIn', () => ({ createDeviceCandidate: () => ({ getSnapshot: () => model.state, subscribe: (listener: () => void) => { model.listeners.add(listener); return () => model.listeners.delete(listener); }, beginLink: model.beginLink, finish: model.finish, dispose: model.dispose }), deviceIssuer: {}, createQRApprover: vi.fn() }));
vi.mock('../app/store', () => ({ useApp: (selector: (state: unknown) => unknown) => selector({ accountSession: null }) }));
vi.mock('../app/controller', () => ({ subscribeSessionEpoch: () => () => {} }));
afterEach(() => { vi.unstubAllGlobals(); model.listeners.clear(); vi.clearAllMocks(); });
it('requires explicit finish retry even when a later poll clears the transient controller error', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); setLanguage('en');
  model.state = { phase: 'waiting', busy: false, code: '0000', request: { id: 'candidate', type: 'link', state: 'approved', version: 2, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), requesterUserAgent: 'Browser' } };
  model.finish.mockImplementation(async () => { model.state = { ...model.state, problem: { code: 'outcome_unknown' } }; model.listeners.forEach(listener => listener()); throw new Error('lost response'); });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(DeviceReceiver, { token: 'memory-only-link', onClose: vi.fn() })));
    expect(model.finish).toHaveBeenCalledOnce();
    await act(async () => { model.state = { ...model.state, problem: undefined }; model.listeners.forEach(listener => listener()); });
    expect(model.finish).toHaveBeenCalledOnce();
    const retry = [...host.querySelectorAll('button')].find(button => button.textContent === 'Try again'); expect(retry).toBeDefined();
    await act(async () => retry!.click()); expect(model.finish).toHaveBeenCalledTimes(2);
  } finally { await act(async () => root.unmount()); host.remove(); }
  expect(model.dispose).toHaveBeenCalledOnce();
});
