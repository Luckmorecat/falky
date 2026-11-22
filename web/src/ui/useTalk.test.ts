import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prefs } from '../app/prefs';
import { getState, setState } from '../app/store';
import { idleVoice } from '../voice/types';
import { showNotice, voice } from '../app/controller';
import { Dock } from './Dock';
import { useTalk } from './useTalk';

vi.mock('../app/controller', () => ({
  showNotice: vi.fn(),
  voice: { setMuted: vi.fn(async () => {}) },
}));
const activeVoice = {
  ...idleVoice, status: 'connected' as const, roomId: 'lounge', joinedAt: 1,
  people: [{
    id: 'self.1', visitorId: 'self', name: 'Sam', local: true, muted: false, deafened: false,
    sharing: false, shareTrackId: '', camera: false, cameraTrackId: '',
  }],
};
function TestTalk() { useTalk(); return null; }
function TestDock() { return createElement(Dock, { room: null, holdToTalk: useTalk() }); }

let root: ReturnType<typeof createRoot>;
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="test"></div>';
  root = createRoot(document.querySelector('#test')!);
  setState({ voice: activeVoice, settings: { ...prefs.settings(), awayMute: true, awayMinutes: '5', pushToTalk: false } });
  await act(async () => root.render(createElement(TestTalk)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

it('counts continuous silence, resetting after throttled polls and speech between polls', async () => {
  await vi.advanceTimersByTimeAsync(240_000);
  vi.setSystemTime(Date.now() + 300_000);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(voice.setMuted).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(240_000);
  setState({ voice: { ...activeVoice, speakers: ['self.1'] } });
  setState({ voice: activeVoice });
  await vi.advanceTimersByTimeAsync(299_000);
  expect(voice.setMuted).not.toHaveBeenCalled();
  vi.mocked(voice.setMuted).mockImplementation(async (muted) => {
    setState({ voice: { ...getState().voice, muted } });
  });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(voice.setMuted).toHaveBeenCalledExactlyOnceWith(true);
  expect(showNotice).toHaveBeenCalledOnce();
});

it('releases an active keyboard hold on hide and does not reopen on stale keyup after reconnect', async () => {
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  setState({ voice: { ...activeVoice, muted: true }, settings: { ...getState().settings, pushToTalk: true } });
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', cancelable: true }));
  expect(voice.setMuted).toHaveBeenCalledExactlyOnceWith(false);
  hidden.mockReturnValue(true);
  document.dispatchEvent(new Event('visibilitychange'));
  expect(vi.mocked(voice.setMuted).mock.calls).toEqual([[false], [true]]);
  setState({ voice: { ...activeVoice, status: 'reconnecting', muted: true } });
  hidden.mockReturnValue(false);
  setState({ voice: { ...activeVoice, muted: true } });
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', cancelable: true }));
  expect(vi.mocked(voice.setMuted).mock.calls).toEqual([[false], [true]]);
});

it('holds from touch and releases on pointer cancellation or loss of capture', async () => {
  setState({ voice: { ...activeVoice, muted: true }, settings: { ...getState().settings, pushToTalk: true } });
  await act(async () => root.render(createElement(TestDock)));
  const button = document.querySelector<HTMLButtonElement>('.dock-talk')!;
  const touch = (event: string) => button.dispatchEvent(new PointerEvent(event, {
    pointerType: 'touch', isPrimary: true, pointerId: 4, bubbles: true, button: 0,
  }));

  touch('pointerdown');
  touch('pointercancel');
  expect(vi.mocked(voice.setMuted).mock.calls).toEqual([[false], [true]]);
  touch('pointerdown');
  touch('lostpointercapture');
  touch('pointerup');
  button.click();
  expect(vi.mocked(voice.setMuted).mock.calls).toEqual([[false], [true], [false], [true]]);
});

it('retries microphone capture on a fresh touch hold after a listen-only failure', async () => {
  const setMuted = vi.mocked(voice.setMuted);
  setMuted.mockImplementationOnce(async () => {
    setState({ voice: { ...getState().voice, muted: true, listenOnly: true } });
  });
  setState({ voice: { ...activeVoice, muted: true }, settings: { ...getState().settings, pushToTalk: true } });
  await act(async () => root.render(createElement(TestDock)));
  const button = document.querySelector<HTMLButtonElement>('.dock-talk')!;
  const touch = (event: string) => button.dispatchEvent(new PointerEvent(event, {
    pointerType: 'touch', isPrimary: true, pointerId: 4, bubbles: true, button: 0,
  }));

  await act(async () => { touch('pointerdown'); });
  expect(getState().voice.listenOnly).toBe(true);
  expect(setMuted).toHaveBeenCalledExactlyOnceWith(false);
  await act(async () => { touch('pointerup'); });
  expect(setMuted.mock.calls).toEqual([[false], [true]]);
  expect(button.getAttribute('aria-disabled')).toBe('false');

  setMuted.mockImplementationOnce(async () => {
    setState({ voice: { ...getState().voice, muted: false, listenOnly: false } });
  });
  await act(async () => { touch('pointerdown'); });
  expect(button.getAttribute('aria-pressed')).toBe('true');
  await act(async () => { touch('pointerup'); });
  expect(setMuted.mock.calls).toEqual([[false], [true], [false], [true]]);
});
