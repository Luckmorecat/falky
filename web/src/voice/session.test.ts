import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prefs } from '../app/prefs';
import { idleVoice, type VoiceHost } from './types';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let download: ReturnType<typeof deferred>;
let host: VoiceHost;
const resume = vi.fn(async () => {});
const connect = vi.fn(async () => {});
const fetchVoice = vi.fn(async () => Response.json({ url: 'ws://localhost/rtc', token: 'test' }));
const loadSDK = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  download = deferred();
  vi.doMock('livekit-client', async () => {
    loadSDK();
    await download.promise;
    return {
      ConnectionQuality: {}, DisconnectReason: {}, RemoteAudioTrack: class {},
      Track: { Source: { Camera: 'camera', ScreenShare: 'screen', Microphone: 'mic' } },
      RoomEvent: {},
      Room: class {
        localParticipant = { identity: 'self', attributes: {}, isMicrophoneEnabled: false, getTrackPublication() {} };
        remoteParticipants = new Map();
        activeSpeakers = [];
        connect = connect;
        startAudio = async () => {};
        on() { return this; }
        removeAllListeners() {}
        disconnect() {}
      },
    };
  });
  vi.stubGlobal('AudioContext', class { resume = resume; });
  vi.stubGlobal('fetch', fetchVoice);
  host = {
    onChange: vi.fn(), onProblem: vi.fn(), onSound: vi.fn(),
    micId: () => '', speakerId: () => '',
    micProcessing: () => ({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }),
    joinMuted: () => true, cameraSettings: () => prefs.settings(),
    shareSettings: () => prefs.settings(), volumeOf: () => 1,
  };
});
afterEach(() => {
  vi.doUnmock('livekit-client');
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it('keeps the idle voice controls usable without downloading LiveKit', async () => {
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  expect(session.shareTrack('self')).toBeNull();
  expect(session.cameraTrack('self')).toBeNull();
  expect(session.level('self')).toBe(0);
  await session.applyMicProcessing();
  await session.setMic('mic');
  await session.toggleCamera();
  session.end();
  expect(session.snapshot).toEqual(idleVoice);
  expect(loadSDK).not.toHaveBeenCalled();
});

it('resumes audio in the click and shares a pending background download with Join', async () => {
  const { VoiceSession, preloadVoice } = await import('./session');
  const session = new VoiceSession(host);
  const warming = preloadVoice();
  const joining = session.join('lounge');
  expect(resume).toHaveBeenCalledOnce();
  expect(session.snapshot).toMatchObject({ status: 'joining', joiningRoomId: 'lounge' });
  expect(fetchVoice).not.toHaveBeenCalled();
  await session.join('games');
  download.resolve();
  await Promise.all([warming, joining]);
  expect(loadSDK).toHaveBeenCalledOnce();
  expect(fetchVoice).toHaveBeenCalledOnce();
  expect(fetchVoice.mock.calls[0]).toEqual(['/api/rooms/lounge/voice', expect.any(Object)]);
  expect(connect).toHaveBeenCalledWith('ws://localhost/rtc', 'test');
  expect(session.snapshot).toMatchObject({ status: 'connected', roomId: 'lounge' });
  session.end();
});

it('does not join after access ends while the SDK is downloading', async () => {
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge');
  session.end();
  download.resolve();
  await joining;
  expect(fetchVoice).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
  expect(session.snapshot).toEqual(idleVoice);
});

it('reports a failed SDK download through the existing voice error without leaving Join stuck', async () => {
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge');
  download.reject(new Error('Offline'));
  await joining;
  expect(host.onProblem).toHaveBeenCalledWith('join_failed');
  expect(fetchVoice).not.toHaveBeenCalled();
  expect(session.snapshot).toEqual(idleVoice);
});
