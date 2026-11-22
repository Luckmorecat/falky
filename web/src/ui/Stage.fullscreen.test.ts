import { vi } from 'vitest';

vi.hoisted(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() { return false; },
  }));
});

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { voice } from '../app/controller';
import { setState } from '../app/store';
import { setLanguage, t } from '../strings';
import type { ShareTrack } from '../voice/types';
import { idleVoice } from '../voice/types';
import { ShareView } from './Stage';

vi.mock('../app/controller', () => ({
  voice: { shareTrack: vi.fn(() => null), level: () => 0 },
}));

let container: HTMLDivElement;
let root: Root;
let fullscreenEl: Element | null = null;
const requestFullscreen = vi.fn(function (this: HTMLElement) {
  fullscreenEl = this;
  document.dispatchEvent(new Event('fullscreenchange'));
  return Promise.resolve();
});
const exitFullscreen = vi.fn(() => {
  fullscreenEl = null;
  document.dispatchEvent(new Event('fullscreenchange'));
  return Promise.resolve();
});

const person = { id: 'sam.connection', visitorId: 'sam', name: 'Sam', live: true, isSelf: false, muted: false, deafened: false, sharing: true, cameraTrackId: '' };

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setLanguage('uk');
  fullscreenEl = null;
  requestFullscreen.mockClear();
  exitFullscreen.mockClear();
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenEl });
  HTMLElement.prototype.requestFullscreen = requestFullscreen;
  document.exitFullscreen = exitFullscreen;
  vi.mocked(voice.shareTrack).mockReturnValue({ attach: vi.fn(), detach: vi.fn() } as unknown as ShareTrack);
  setState({
    voice: { ...idleVoice, status: 'connected', roomId: 'room', people: [{ id: 'sam.connection', visitorId: 'sam', name: 'Sam', local: false, muted: false, deafened: false, sharing: true, shareTrackId: 'track-1', camera: false, cameraTrackId: '' }] },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, 'fullscreenElement');
  setState({ voice: idleVoice });
});

function mount() {
  return act(async () => { root.render(createElement(ShareView, { width: 640, person, others: [person], onPick: () => {} })); });
}

function button(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>('.share .ib');
  if (!el) throw new Error('fullscreen button missing');
  return el;
}

it('toggles the screen-share viewer fullscreen and follows an Esc exit', async () => {
  await mount();
  const video = container.querySelector('video');
  const track = vi.mocked(voice.shareTrack).mock.results.at(-1)?.value as ShareTrack;
  expect(button().getAttribute('aria-label')).toBe(t.fullscreen);
  expect(button().getAttribute('aria-pressed')).toBe('false');
  expect(button().querySelector('path')?.getAttribute('d')?.startsWith('M4.500 9')).toBe(true);
  expect(track.attach).toHaveBeenCalledTimes(1);
  expect(track.attach).toHaveBeenCalledWith(video);

  await act(async () => { button().click(); });
  expect(requestFullscreen).toHaveBeenCalledTimes(1);
  expect(document.fullscreenElement).toBe(container.querySelector('.share'));
  expect(button().getAttribute('aria-label')).toBe(t.exitFullscreen);
  expect(button().getAttribute('aria-pressed')).toBe('true');
  expect(button().querySelector('path')?.getAttribute('d')?.startsWith('M9 4.500')).toBe(true);
  expect(container.querySelector('video')).toBe(video);

  await act(async () => { button().click(); });
  expect(exitFullscreen).toHaveBeenCalledTimes(1);
  expect(document.fullscreenElement).toBeNull();
  expect(button().getAttribute('aria-label')).toBe(t.fullscreen);
  expect(button().getAttribute('aria-pressed')).toBe('false');

  await act(async () => { button().click(); });
  await act(async () => {
    fullscreenEl = null;
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  expect(button().getAttribute('aria-label')).toBe(t.fullscreen);
  expect(button().querySelector('path')?.getAttribute('d')?.startsWith('M4.500 9')).toBe(true);

  await act(async () => { button().click(); });
  expect(requestFullscreen).toHaveBeenCalledTimes(3);
  expect(exitFullscreen).toHaveBeenCalledTimes(1);
  expect(container.querySelector('video')).toBe(video);
  expect(track.attach).toHaveBeenCalledTimes(1);
  expect(track.detach).not.toHaveBeenCalled();
});

it('omits the control when neither fullscreen API is available', async () => {
  Reflect.deleteProperty(HTMLElement.prototype, 'requestFullscreen');
  Reflect.deleteProperty(document, 'exitFullscreen');
  await mount();
  expect(container.querySelector('.share .ib')).toBeNull();
  expect(voice.shareTrack(person.id)?.attach).toHaveBeenCalledOnce();
});

it.each([
  ['webkitEnterFullscreen', 'webkitExitFullscreen'],
  ['webkitEnterFullScreen', 'webkitExitFullScreen'],
])('uses %s native fullscreen when element fullscreen is disabled and follows native exits', async (enterMethod, exitMethod) => {
  const enter = vi.fn(function (this: HTMLVideoElement) { this.dispatchEvent(new Event('webkitbeginfullscreen')); });
  const exit = vi.fn(function (this: HTMLVideoElement) { this.dispatchEvent(new Event('webkitendfullscreen')); });
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: false });
  Object.assign(HTMLVideoElement.prototype, { [enterMethod]: enter, [exitMethod]: exit });
  try {
    await mount();
    expect(button().getAttribute('aria-label')).toBe(t.fullscreen);
    await act(async () => { button().click(); });
    expect(enter).toHaveBeenCalledOnce();
    expect(requestFullscreen).not.toHaveBeenCalled();
    expect(button().getAttribute('aria-label')).toBe(t.exitFullscreen);
    await act(async () => { button().click(); });
    expect(exit).toHaveBeenCalledOnce();
    await act(async () => { button().click(); });
    await act(async () => { container.querySelector('video')?.dispatchEvent(new Event('webkitendfullscreen')); });
    expect(button().getAttribute('aria-pressed')).toBe('false');
  } finally {
    Reflect.deleteProperty(document, 'fullscreenEnabled');
    Reflect.deleteProperty(HTMLVideoElement.prototype, enterMethod);
    Reflect.deleteProperty(HTMLVideoElement.prototype, exitMethod);
  }
});

it('keeps the viewer usable when fullscreen requests throw or reject', async () => {
  const denied = new DOMException('Unsupported', 'NotSupportedError');
  requestFullscreen.mockImplementationOnce(() => { throw denied; }).mockRejectedValueOnce(denied);
  await mount();
  await act(async () => { button().click(); });
  await act(async () => { button().click(); });
  expect(button().getAttribute('aria-pressed')).toBe('false');
  expect(container.querySelector('video')).toBeTruthy();
  await act(async () => { button().click(); });
  exitFullscreen.mockRejectedValueOnce(denied);
  await act(async () => { button().click(); });
  expect(button().getAttribute('aria-pressed')).toBe('true');
});
