import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startCamera } from '@falky/browser';
import { voice } from '../app/controller';
import { getState, setState } from '../app/store';
import { idleVoice, type VoicePerson } from '../voice/types';
import { CameraPreview } from './SettingsParts';

vi.mock('@falky/browser', () => ({ startCamera: vi.fn() }));
vi.mock('../app/controller', () => ({ voice: { cameraTrack: vi.fn() }, updateSettings: vi.fn() }));

const own: VoicePerson = {
  id: 'self.connection', visitorId: 'self', name: 'Sam', local: true, muted: false, deafened: false,
  sharing: false, shareTrackId: '', camera: true, cameraTrackId: 'camera-1',
};
const live = { ...idleVoice, camera: true, people: [own] };
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  setState({ voice: idleVoice });
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it('borrows the live camera, follows track replacement, and only detaches on close', async () => {
  const first = { attach: vi.fn(), detach: vi.fn(), stop: vi.fn() };
  const next = { attach: vi.fn(), detach: vi.fn(), stop: vi.fn() };
  vi.mocked(voice.cameraTrack).mockReturnValueOnce(first).mockReturnValueOnce(next);
  setState({ voice: live });
  await act(async () => root.render(createElement(CameraPreview, { active: true })));
  const element = host.querySelector('video');
  expect(voice.cameraTrack).toHaveBeenCalledExactlyOnceWith(own.id);
  expect(first.attach).toHaveBeenCalledExactlyOnceWith(element);

  await act(async () => setState({ voice: { ...live, camera: false, cameraStarting: true, people: [] } }));
  expect(first.detach).toHaveBeenCalledExactlyOnceWith(element);
  await act(async () => setState({ voice: { ...live, people: [{ ...own, cameraTrackId: 'camera-2' }] } }));
  expect(next.attach).toHaveBeenCalledExactlyOnceWith(element);
  await act(async () => root.render(createElement(CameraPreview, { active: false })));
  expect(next.detach).toHaveBeenCalledExactlyOnceWith(element);
  expect(startCamera).not.toHaveBeenCalled();
  expect(first.stop).not.toHaveBeenCalled();
  expect(next.stop).not.toHaveBeenCalled();
});

it('releases owned preview capture even when it resolves after the call camera takes over', async () => {
  let accept!: (stream: MediaStream) => void;
  const stop = vi.fn();
  const track = { attach: vi.fn(), detach: vi.fn() };
  vi.mocked(startCamera).mockImplementation(() => new Promise(resolve => { accept = resolve; }));
  vi.mocked(voice.cameraTrack).mockReturnValue(track);

  await act(async () => root.render(createElement(CameraPreview, { active: true })));
  const { cameraId, cameraResolution } = getState().settings;
  expect(startCamera).toHaveBeenCalledExactlyOnceWith({ deviceId: cameraId || undefined, width: Math.round(Number(cameraResolution) * 16 / 9), height: Number(cameraResolution) });
  await act(async () => setState({ voice: live }));
  await act(async () => accept({ getTracks: () => [{ stop }] } as unknown as MediaStream));
  expect(stop).toHaveBeenCalledOnce();
  expect(track.attach).toHaveBeenCalledExactlyOnceWith(host.querySelector('video'));
});
