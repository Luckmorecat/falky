import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { CandidateState } from '../app/deviceSignIn';
import { setState } from '../app/store';
import { DeviceReceiver, DeviceScanner } from './DeviceSignIn';
import { setLanguage, t } from '../strings';
import { idleVoice } from '../voice/types';
const model = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return { state: {} as CandidateState, listeners, beginLink: vi.fn().mockResolvedValue(undefined), finish: vi.fn(), dispose: vi.fn() };
});
const scanner = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), preview: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@falky/browser', () => ({ startQRScanner: scanner.start }));
vi.mock('../app/deviceSignIn', () => {
  const idle = { phase: 'idle', busy: false };
  return {
    createDeviceCandidate: () => ({ getSnapshot: () => model.state, subscribe: (listener: () => void) => { model.listeners.add(listener); return () => model.listeners.delete(listener); }, beginLink: model.beginLink, finish: model.finish, dispose: model.dispose }),
    deviceIssuer: {},
    createQRApprover: () => ({ getSnapshot: () => idle, subscribe: () => () => {}, preview: scanner.preview, dispose: vi.fn() }),
  };
});
vi.mock('../app/controller', () => ({ subscribeSessionEpoch: () => () => {} }));
afterEach(() => { setState({ voice: idleVoice }); vi.unstubAllGlobals(); model.listeners.clear(); vi.clearAllMocks(); });
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

it('blocks QR camera capture while the call camera is active or starting and leaves pasting available', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setLanguage('en');
  setState({ voice: { ...idleVoice, camera: true } });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const button = (name: string) => [...host.querySelectorAll('button')].find(el => el.textContent === name)!;
  scanner.start.mockReturnValue({ stop: scanner.stop });
  try {
    await act(async () => root.render(createElement(DeviceScanner, { onClose: vi.fn() })));
    expect(host.textContent).toContain('Turn off your call camera to scan, or paste the QR link.');
    expect(button(t.device.cameraStart).disabled).toBe(true);
    expect(scanner.start).not.toHaveBeenCalled();
    await act(async () => { button(t.device.pasteQR).click(); });
    expect(host.querySelector('input')).toBeTruthy();

    await act(async () => setState({ voice: idleVoice }));
    await act(async () => { button(t.device.cameraStart).click(); });
    expect(scanner.start).toHaveBeenCalledOnce();
    await act(async () => setState({ voice: { ...idleVoice, cameraStarting: true } }));
    expect(scanner.stop).toHaveBeenCalledOnce();
    expect(button(t.device.cameraStart).disabled).toBe(true);
    expect(host.textContent).toContain(t.device.callCameraBusy);
    await act(async () => setState({ voice: idleVoice }));
    expect(button(t.device.cameraStart).disabled).toBe(false);
    expect(scanner.start).toHaveBeenCalledOnce();

    await act(async () => { button(t.device.cameraStart).click(); });
    const read = scanner.start.mock.calls[1]![1];
    await act(async () => read(`${location.origin}/#qr-signin=qr-request`));
    expect(scanner.preview).toHaveBeenCalledExactlyOnceWith('qr-request');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
