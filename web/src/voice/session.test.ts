import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CreateLocalTracksOptions } from 'livekit-client';
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
const rooms: { disconnect: ReturnType<typeof vi.fn>; canPlaybackAudio: boolean; state: string; localParticipant: { isMicrophoneEnabled: boolean } }[] = [];
const resume = vi.fn(async () => {});
const startAudio = vi.fn(async () => {});
const connect = vi.fn(async () => {});
const fetchVoice = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ url: 'ws://localhost/rtc', token: 'test', grantId: 'self.old' }));
const loadSDK = vi.fn();
const remotes = new Map();
const speakers: { identity: string }[] = [];
let localTracks = new Map();
const disconnect = vi.fn();
const constructRoom = vi.fn();
const listeners = new Map<string, (...args: any[]) => void>();
const enableMicrophone = vi.fn(async (_enabled: boolean, _options?: unknown) => {});
class MockLocalTrack {
  capture = { id: 'microphone', enabled: true, readyState: 'live' };
  constraints: MediaTrackConstraints = {};
  get mediaStreamTrack() { return this.capture; }
  get isMuted() { return !this.capture.enabled; }
  async mute() { this.capture.enabled = false; }
  async unmute() { this.capture.enabled = true; }
  stop = vi.fn(() => { this.capture.readyState = 'ended'; this.capture.enabled = false; });
}
class MockLocalAudioTrack extends MockLocalTrack {
  override unmute = vi.fn(async () => { await super.unmute(); });
}
const localMic = () => new MockLocalAudioTrack();
const acquireMic = vi.fn(async (_options: unknown) => [localMic()]);
const publishMic = vi.fn(async (track: MockLocalAudioTrack) => {
  const publication = { track, get isMuted() { return track.isMuted; } };
  localTracks.set('mic', publication);
  listeners.get('LocalTrackPublished')?.();
  return publication;
});
const enableShare = vi.fn(async () => {});
const enableCamera = vi.fn(async () => {});
const switchActiveDevice = vi.fn(async (_kind: string, _id: string) => {});

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  vi.clearAllMocks();
  fetchVoice.mockImplementation(async () => Response.json({ url: 'ws://localhost/rtc', token: 'test', grantId: 'self.old' }));
  listeners.clear(); remotes.clear(); speakers.length = 0; localTracks = new Map(); rooms.length = 0;
  download = deferred();
  vi.doMock('livekit-client', async () => {
    loadSDK();
    await download.promise;
    return {
      ConnectionQuality: {}, DisconnectReason: {}, LocalTrack: MockLocalTrack, RemoteAudioTrack: class {},
      Track: { Kind: { Audio: 'audio' }, Source: { Camera: 'camera', ScreenShare: 'screen', Microphone: 'mic', ScreenShareAudio: 'screen-audio' } },
      TrackEvent: { AudioPlaybackFailed: 'audioPlaybackFailed', ElementDetached: 'elementDetached' },
      RoomEvent: new Proxy({}, { get: (_, key) => key }),
      Room: class {
        constructor(options: unknown) { constructRoom(options); rooms.push(this); }
        localParticipant = {
          identity: 'self.nonce', setCameraEnabled: enableCamera, setScreenShareEnabled: enableShare,
          async setMicrophoneEnabled(enabled: boolean, options?: unknown) {
            await enableMicrophone(enabled, options);
            const track = this.getTrackPublication('mic')?.track;
            if (enabled) await track?.unmute();
            else await track?.mute();
          },
          createTracks: acquireMic, publishTrack: publishMic, setAttributes: vi.fn(async () => {}),
          trackPublications: localTracks, attributes: {},
          get isMicrophoneEnabled() {
            const publication = this.getTrackPublication('mic');
            return !!publication && !publication.isMuted;
          },
          get isCameraEnabled() { return this.trackPublications.has('camera'); },
          getTrackPublication(source: string) { return this.trackPublications.get(source); },
          async unpublishTrack(track: { stop(): void }, stop: boolean) {
            for (const [source, publication] of this.trackPublications) {
              if (publication.track === track) this.trackPublications.delete(source);
            }
            if (stop) track.stop();
            listeners.get('LocalTrackUnpublished')?.();
          },
        };
        remoteParticipants = remotes;
        activeSpeakers = speakers;
        connect = connect;
        state = 'connected';
        startAudio = startAudio;
        canPlaybackAudio = false;
        switchActiveDevice = switchActiveDevice;
        on(event: string, listener: (...args: any[]) => void) { listeners.set(event, listener); return this; }
        removeAllListeners() { listeners.clear(); }
        disconnect = vi.fn(() => disconnect());
      },
    };
  });
  vi.stubGlobal('AudioContext', class {
    resume = resume;
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() { return { fftSize: 0 }; }
  });
  vi.stubGlobal('MediaStream', class {});
  vi.stubGlobal('fetch', fetchVoice);
  host = {
    onChange: vi.fn(), onProblem: vi.fn(), onSound: vi.fn(),
    micId: () => '', speakerId: () => '',
    micProcessing: () => ({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }),
    joinMuted: () => true, pushToTalk: () => false, cameraSettings: () => prefs.settings(),
    shareSettings: () => prefs.settings(), volumeOf: () => 1,
  };
});
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
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
  expect(constructRoom).toHaveBeenCalledWith(expect.objectContaining({ webAudioMix: { audioContext: expect.any(AudioContext) } }));
  expect(session.snapshot).toMatchObject({ status: 'connected', roomId: 'lounge' });
  session.end();
});

it.each([
  ['iPhone', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }],
  ['iPad in desktop mode', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', platform: 'MacIntel', maxTouchPoints: 5 }],
])('uses direct playback and keeps deafened tracks detached on %s', async (_, device) => {
  vi.stubGlobal('navigator', { ...device });
  const participant = {
    identity: 'other.phone', attributes: {}, getTrackPublication: () => undefined, setVolume: vi.fn(),
    audioTrackPublications: new Map(),
  };
  let volume = 1.5;
  host.volumeOf = () => volume;
  remotes.set(participant.identity, participant);
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge'); download.resolve(); await joining;
  expect(constructRoom).toHaveBeenCalledWith(expect.objectContaining({ webAudioMix: false }));
  const subscribe = (source: string) => {
    const track = {
      kind: 'audio', on: vi.fn(), off: vi.fn(), attachedElements: [] as HTMLAudioElement[],
      attach: vi.fn(() => {
        const el = document.createElement('audio');
        track.attachedElements.push(el);
        return el;
      }),
      detach: vi.fn(() => track.attachedElements.splice(0)),
    };
    const publication = { track };
    participant.audioTrackPublications.set(source, publication);
    listeners.get('TrackSubscribed')!(track, publication, participant);
    return track;
  };
  const mic = subscribe('mic');
  expect(mic.attachedElements).toHaveLength(1);
  expect(participant.setVolume).toHaveBeenCalledWith(1, 'mic');

  await session.toggleDeafen();
  const share = subscribe('screen-audio');
  expect(document.querySelectorAll('audio')).toHaveLength(0);
  expect(share.attach).not.toHaveBeenCalled();
  // LiveKit playback recovery can unmute all attached elements, but has none here.
  listeners.get('Reconnected')!();
  expect(startAudio).toHaveBeenCalledOnce();
  expect(mic.attachedElements).toHaveLength(0);
  expect(share.attachedElements).toHaveLength(0);

  await session.toggleDeafen();
  expect(enableMicrophone).not.toHaveBeenCalled();
  expect(document.querySelectorAll('audio')).toHaveLength(2);
  volume = 0;
  session.applyVolumes();
  expect(document.querySelectorAll('audio')).toHaveLength(0);
  volume = 0.5;
  session.applyVolumes();
  expect(document.querySelectorAll('audio')).toHaveLength(2);
  participant.audioTrackPublications.delete('screen-audio');
  listeners.get('TrackUnsubscribed')!(share);
  expect(document.querySelectorAll('audio')).toHaveLength(1);
  session.end();
  expect(document.querySelectorAll('audio')).toHaveLength(0);
});

it('retries a paused or waiting native sink even when LiveKit reports playback works', async () => {
  vi.stubGlobal('navigator', { userAgent: 'iPhone Mobile/1' });
  const addListener = vi.spyOn(document, 'addEventListener');
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const participant = {
    identity: 'other.phone', attributes: {}, getTrackPublication: () => undefined, setVolume: vi.fn(),
    audioTrackPublications: new Map(),
  };
  remotes.set(participant.identity, participant);
  let volume = 1;
  host.volumeOf = () => volume;
  try {
    const joining = session.join('lounge'); download.resolve(); await joining;
    rooms.at(-1)!.canPlaybackAudio = true;
    const click = addListener.mock.calls.find(([type, , capture]) => type === 'click' && capture === true)?.[1] as EventListener;
    const input = { isTrusted: true } as Event;
    const makeSink = (source: string) => {
      const element = document.createElement('audio');
      const track = {
        kind: 'audio', on: vi.fn(), off: vi.fn(), attachedElements: [] as HTMLAudioElement[],
        attach() { this.attachedElements.push(element); return element; },
        detach() { return this.attachedElements.splice(0); },
      };
      const publication = { track };
      participant.audioTrackPublications.set(source, publication);
      listeners.get('TrackSubscribed')!(track, publication, participant);
      const paused = vi.spyOn(element, 'paused', 'get').mockReturnValue(false);
      const play = vi.spyOn(element, 'play').mockResolvedValue();
      return { element, paused, play };
    };
    const mic = makeSink('mic');
    const share = makeSink('screen-audio');
    mic.paused.mockReturnValue(true);
    mic.element.dispatchEvent(new Event('pause'));
    mic.element.dispatchEvent(new Event('pause'));
    expect(mic.play).toHaveBeenCalledOnce();

    mic.paused.mockReturnValue(false);
    mic.element.dispatchEvent(new Event('playing'));
    mic.element.dispatchEvent(new Event('waiting'));
    const pending = deferred();
    mic.play.mockImplementationOnce(() => pending.promise);
    click(input);
    click(input);
    expect(mic.play).toHaveBeenCalledTimes(3);
    pending.resolve();
    mic.element.dispatchEvent(new Event('playing'));
    click(input);
    expect(mic.play).toHaveBeenCalledTimes(3);
    expect(share.play).not.toHaveBeenCalled();
    expect(startAudio).toHaveBeenCalledOnce();

    volume = 0;
    session.applyVolumes();
    mic.paused.mockReturnValue(true);
    mic.element.dispatchEvent(new Event('pause'));
    click(input);
    expect(mic.play).toHaveBeenCalledTimes(3);
    expect(enableMicrophone).not.toHaveBeenCalled();
    expect(fetchVoice).toHaveBeenCalledOnce();
  } finally {
    session.end();
    addListener.mockRestore();
  }
});

function addIncomingAudio(element: HTMLAudioElement, source: string) {
  const trackListeners = new Map<string, (element: HTMLAudioElement) => void>();
  const track = {
    kind: 'audio',
    on: vi.fn((event: string, callback: (element: HTMLAudioElement) => void) => trackListeners.set(event, callback)),
    off: vi.fn((event: string) => trackListeners.delete(event)),
    attachedElements: [] as HTMLAudioElement[],
    attach() { this.attachedElements.push(element); return element; },
    detach() {
      const detached = this.attachedElements.splice(0);
      for (const sink of detached) trackListeners.get('elementDetached')?.(sink);
      return detached;
    },
  };
  const publication = { track };
  const participant = {
    identity: source, attributes: {}, getTrackPublication: () => undefined, setVolume: vi.fn(),
    audioTrackPublications: new Map([[source, publication]]),
  };
  remotes.set(participant.identity, participant);
  listeners.get('TrackSubscribed')!(track, publication, participant);
  return track;
}

it('recovers the first pause when LiveKit reuses an element for a new subscription', async () => {
  vi.stubGlobal('navigator', { userAgent: 'iPhone Mobile/1' });
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const element = document.createElement('audio');
  const play = vi.spyOn(element, 'play').mockResolvedValue();
  try {
    const joining = session.join('lounge'); download.resolve(); await joining;
    const oldTrack = addIncomingAudio(element, 'mic');
    element.dispatchEvent(new Event('pause'));
    expect(play).toHaveBeenCalledOnce();
    remotes.delete('mic');
    listeners.get('TrackUnsubscribed')!(oldTrack);
    addIncomingAudio(element, 'screen-audio');
    element.dispatchEvent(new Event('pause'));
    expect(play).toHaveBeenCalledTimes(2);
  } finally {
    session.end();
  }
});

it('detaches old-room receive tracks before disconnect while playback is still pending', async () => {
  vi.stubGlobal('navigator', { userAgent: 'iPhone Mobile/1' });
  const priorPlayback = deferred();
  const oldRoomClosed = deferred();
  startAudio.mockImplementationOnce(() => priorPlayback.promise);
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  try {
    const joining = session.join('lounge'); download.resolve(); await joining;
    const oldElement = document.createElement('audio');
    const oldTrack = addIncomingAudio(oldElement, 'mic');
    let leftWithAudio = false;
    disconnect.mockImplementationOnce(() => {
      leftWithAudio = oldTrack.attachedElements.length > 0;
      remotes.clear();
      return oldRoomClosed.promise;
    });
    await session.join('games');
    expect(disconnect).toHaveBeenCalledOnce();
    expect(leftWithAudio).toBe(false);
    expect(oldTrack.attachedElements).toHaveLength(0);
    expect(oldElement.isConnected).toBe(false);
    const newTrack = addIncomingAudio(document.createElement('audio'), 'screen-audio');
    priorPlayback.resolve();
    oldRoomClosed.resolve();
    await Promise.resolve();
    expect(newTrack.attachedElements).toHaveLength(1);
    expect(session.snapshot.roomId).toBe('games');
    expect(enableMicrophone).not.toHaveBeenCalled();
  } finally {
    priorPlayback.resolve();
    oldRoomClosed.resolve();
    session.end();
  }
});

it('retries blocked native audio within a trusted click without starting the microphone', async () => {
  vi.stubGlobal('navigator', { userAgent: 'iPhone' });
  startAudio.mockRejectedValueOnce(new DOMException('User activation required', 'NotAllowedError'));
  const addListener = vi.spyOn(document, 'addEventListener');
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  try {
    const joining = session.join('lounge');
    expect(startAudio).not.toHaveBeenCalled();
    download.resolve();
    await joining;
    expect(startAudio).toHaveBeenCalledOnce();

    const click = addListener.mock.calls.find(([type, , capture]) => type === 'click' && capture === true)?.[1] as EventListener;
    document.body.click();
    expect(startAudio).toHaveBeenCalledOnce();
    click({ isTrusted: true } as Event);
    expect(startAudio).toHaveBeenCalledTimes(2);
    expect(enableMicrophone).not.toHaveBeenCalled();
    await session.toggleDeafen();
    click({ isTrusted: true } as Event);
    expect(startAudio).toHaveBeenCalledTimes(2);
  } finally {
    session.end();
    addListener.mockRestore();
  }
});

it('keeps the iOS room usable while the first native playback request is pending', async () => {
  vi.stubGlobal('navigator', { userAgent: 'iPhone Mobile/1' });
  const pending = deferred();
  startAudio.mockImplementationOnce(() => pending.promise);
  const addListener = vi.spyOn(document, 'addEventListener');
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  try {
    const joining = session.join('lounge'); download.resolve();
    await vi.waitFor(() => expect(startAudio).toHaveBeenCalledOnce());
    expect(session.snapshot.status).toBe('connected');
    rooms.at(-1)!.canPlaybackAudio = true;
    const sink = document.createElement('audio');
    const play = vi.spyOn(sink, 'play').mockResolvedValue();
    addIncomingAudio(sink, 'mic');
    const click = addListener.mock.calls.find(([type, , capture]) => type === 'click' && capture === true)?.[1] as EventListener;
    click({ isTrusted: true } as Event);
    expect(play).toHaveBeenCalledOnce();
    expect(startAudio).toHaveBeenCalledOnce();
    await joining;
    expect(enableMicrophone).not.toHaveBeenCalled();
  } finally {
    pending.resolve();
    session.end();
    addListener.mockRestore();
  }
});

it('keeps the first iOS join pending until the microphone is ready', async () => {
  vi.stubGlobal('navigator', { userAgent: 'iPhone Mobile/1' });
  vi.useFakeTimers();
  const permission = deferred();
  const playback = deferred();
  acquireMic.mockImplementationOnce(async () => { await permission.promise; return [localMic()]; });
  startAudio.mockImplementationOnce(() => playback.promise);
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  host.joinMuted = () => false;
  try {
    const joining = session.join('lounge');
    download.resolve();
    await vi.waitFor(() => expect(acquireMic).toHaveBeenCalledOnce());
    const incoming = addIncomingAudio(document.createElement('audio'), 'mic');
    listeners.get('ParticipantConnected')!();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(session.snapshot).toMatchObject({ status: 'joining', roomId: null, people: [] });
    expect(incoming.attachedElements).toHaveLength(0);
    expect(startAudio).not.toHaveBeenCalled();
    expect(host.onSound).not.toHaveBeenCalled();
    expect(host.onProblem).not.toHaveBeenCalled();

    permission.resolve();
    await joining;
    expect(startAudio).toHaveBeenCalledOnce();
    expect(incoming.attachedElements).toHaveLength(1);
    const changes = vi.mocked(host.onChange).mock.calls.map(([snapshot]) => snapshot);
    expect(changes.filter((snapshot) => snapshot.status === 'connected')).toEqual([
      expect.objectContaining({ roomId: 'lounge', muted: false, listenOnly: false,
        people: expect.arrayContaining([expect.objectContaining({ local: true, muted: false })]) }),
    ]);
    expect(host.onSound).toHaveBeenCalledExactlyOnceWith('join');
  } finally {
    permission.resolve();
    playback.resolve();
    session.end();
    vi.useRealTimers();
  }
});

it('finishes the first join as reconnecting if signaling drops during mic permission', async () => {
  const permission = deferred();
  const track = localMic();
  acquireMic.mockImplementationOnce(async () => { await permission.promise; return [track]; });
  host.joinMuted = () => false;
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge');
  download.resolve();
  await vi.waitFor(() => expect(acquireMic).toHaveBeenCalledOnce());
  rooms[0]!.state = 'signalReconnecting';
  listeners.get('SignalReconnecting')!();
  permission.resolve();
  await joining;
  expect(track.stop).toHaveBeenCalledOnce();
  expect(publishMic).not.toHaveBeenCalled();
  expect(session.snapshot).toMatchObject({ status: 'reconnecting', roomId: 'lounge', muted: true });
  rooms[0]!.state = 'connected';
  listeners.get('Reconnected')!();
  expect(session.snapshot.status).toBe('connected');
  session.end();
});

it('retries a desktop-mode iPad after a hidden reconnect and removes old room listeners', async () => {
  vi.stubGlobal('navigator', { userAgent: 'Macintosh; Intel Mac OS X', platform: 'MacIntel', maxTouchPoints: 5 });
  const visibility = vi.spyOn(document, 'hidden', 'get');
  const removeListener = vi.spyOn(document, 'removeEventListener');
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  try {
    const joining = session.join('lounge'); download.resolve(); await joining;
    rooms.at(-1)!.canPlaybackAudio = true;
    visibility.mockReturnValue(true);
    listeners.get('Reconnected')!();
    document.dispatchEvent(new Event('visibilitychange'));
    document.body.click();
    expect(startAudio).toHaveBeenCalledOnce();

    visibility.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(startAudio).toHaveBeenCalledTimes(2);

    await session.leave();
    expect(removeListener).toHaveBeenCalledWith('click', expect.any(Function), true);
    expect(removeListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    document.dispatchEvent(new Event('visibilitychange'));
    document.body.click();
    expect(startAudio).toHaveBeenCalledTimes(2);

    await session.join('games');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(startAudio).toHaveBeenCalledTimes(4);
    expect(enableMicrophone).not.toHaveBeenCalled();
  } finally {
    session.end();
    visibility.mockRestore();
    removeListener.mockRestore();
  }
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

it('discards a late Join after explicit Leave without sending another request', async () => {
  const { VoiceSession } = await import('./session');
  let respond!: (value: Response) => void;
  const received = new Promise<Response>((resolve) => { respond = resolve; });
  fetchVoice.mockImplementationOnce(() => received);
  const session = new VoiceSession(host);
  const joining = session.join('lounge');
  download.resolve();
  await vi.waitFor(() => expect(fetchVoice).toHaveBeenCalledOnce());
  await session.leave();
  respond(Response.json({ url: 'ws://localhost/rtc', token: 'test', grantId: 'self.late' }));
  await joining;
  expect(connect).not.toHaveBeenCalled();
  expect(session.snapshot).toEqual(idleVoice);
  expect(fetchVoice).toHaveBeenCalledOnce();
  session.end();
});

it('routes same-person remote media, speakers, meters and volume by exact connection', async () => {
  const share = { mediaStreamTrack: { id: 'screen-track' } };
  const camera = { mediaStreamTrack: { id: 'camera-track' } };
  const mic = { mediaStreamTrack: { id: 'mic-track' } };
  const volume = vi.fn();
  localTracks.set('mic', { track: { mediaStreamTrack: { id: 'windows-mic' } } });
  remotes.set('self.mac', { identity: 'self.mac', name: 'Sam', attributes: {}, isMicrophoneEnabled: true,
    isScreenShareEnabled: true, isCameraEnabled: true, setVolume: volume, audioTrackPublications: new Map(),
    getTrackPublication: (source: string) => ({ track: source === 'screen' ? share : source === 'camera' ? camera : mic }) });
  speakers.push({ identity: 'self.mac' });
  const sample = vi.fn((buf: Float32Array) => buf.fill(0.5));
  vi.stubGlobal('AudioContext', class {
    resume = resume;
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData: sample }; }
  });
  vi.stubGlobal('MediaStream', class {});
  host.volumeOf = vi.fn(() => 0.4);
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge'); download.resolve(); await joining;
  expect(session.snapshot.people.map((person) => person.id)).toEqual(['self.nonce', 'self.mac']);
  expect(session.snapshot.people.map((person) => person.visitorId)).toEqual(['self', 'self']);
  expect(session.snapshot.people.map((person) => person.local)).toEqual([true, false]);
  expect(session.snapshot.speakers).toEqual(['self.mac']);
  expect(session.shareTrack('self.mac')).toBe(share);
  expect(session.cameraTrack('self.mac')).toBe(camera);
  expect(session.level('self.mac')).toBeGreaterThan(0);
  expect(session.level('self.nonce')).toBeGreaterThan(0);
  expect(session.level('self')).toBe(0);
  session.applyVolumes();
  expect(host.volumeOf).toHaveBeenCalledWith('self.mac');
  expect(volume).toHaveBeenCalledWith(0.4, 'mic');
  const stop = vi.fn(); localTracks.set('mic', { track: { stop } });
  const leaving = session.leave();
  expect(stop).toHaveBeenCalledOnce();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(session.snapshot).toMatchObject({ status: 'idle' });
  await leaving;
  expect(fetchVoice).toHaveBeenCalledOnce();
  const requests = fetchVoice.mock.calls.length;
  session.end();
  expect(fetchVoice.mock.calls).toHaveLength(requests);
});

it('does not restore voice after Leave interrupts audio startup', async () => {
  const audioReady = deferred();
  startAudio.mockImplementationOnce(() => audioReady.promise);
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge'); download.resolve();
  await vi.waitFor(() => expect(startAudio).toHaveBeenCalledOnce());
  await session.leave();
  audioReady.resolve();
  await joining;
  expect(session.snapshot.status).toBe('idle');
});

it('discards an abandoned late Join after access ends', async () => {
  let respond!: (value: Response) => void;
  fetchVoice.mockImplementationOnce(() => new Promise<Response>((resolve) => { respond = resolve; }));
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge'); download.resolve();
  await vi.waitFor(() => expect(fetchVoice).toHaveBeenCalledOnce());
  session.end();
  respond(Response.json({ url: 'ws://localhost/rtc', token: 'test', grantId: 'self.ended' }));
  await joining;
  expect(fetchVoice.mock.calls.every(([url]) => url.startsWith('/api/rooms/'))).toBe(true);
  expect(connect).not.toHaveBeenCalled();
  expect(session.snapshot).toEqual(idleVoice);
});

it.each(['cancel', 'disconnect'])('stops a late microphone after first join %s', async (reason) => {
  const micReady = deferred();
  const track = localMic();
  acquireMic.mockImplementationOnce(async () => { await micReady.promise; return [track]; });
  host.joinMuted = () => false;
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge'); download.resolve();
  await vi.waitFor(() => expect(acquireMic).toHaveBeenCalledOnce());
  if (reason === 'cancel') session.cancelJoin();
  else listeners.get('Disconnected')!();
  expect(session.snapshot).toEqual(idleVoice);
  await joining;
  micReady.resolve();
  await vi.waitFor(() => expect(track.stop).toHaveBeenCalledOnce());
  expect(publishMic).not.toHaveBeenCalled();
  expect(session.snapshot).toEqual(idleVoice);
  expect(host.onSound).not.toHaveBeenCalled();
  if (reason === 'cancel') expect(host.onProblem).not.toHaveBeenCalled();
  else expect(host.onProblem).toHaveBeenCalledExactlyOnceWith('media_failed');
});

it('ignores a canceled microphone failure after a replacement Join', async () => {
  const micReady = deferred();
  acquireMic.mockImplementationOnce(async () => { await micReady.promise; return []; });
  host.joinMuted = () => false;
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const oldJoin = session.join('lounge'); download.resolve();
  await vi.waitFor(() => expect(acquireMic).toHaveBeenCalledOnce());
  await session.leave();
  host.joinMuted = () => true;
  await session.join('games');
  micReady.reject(new DOMException('Canceled', 'NotAllowedError'));
  await oldJoin;
  expect(session.snapshot).toMatchObject({ status: 'connected', roomId: 'games', listenOnly: false });
  expect(host.onProblem).not.toHaveBeenCalled();
  session.end();
});

it('stops a screen share accepted in the picker after explicit Leave', async () => {
  const picked = deferred();
  const stop = vi.fn();
  enableShare.mockImplementationOnce(async () => { await picked.promise; localTracks.set('share', { track: { stop } }); });
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge'); download.resolve(); await joining;
  const sharing = session.toggleShare();
  await session.leave();
  picked.resolve(); await sharing;
  expect(stop).toHaveBeenCalledOnce();
  expect(session.snapshot.status).toBe('idle');
});

it('disconnects the old local room only after successful admission and preserves it on refusal', async () => {
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const first = session.join('lounge'); download.resolve(); await first;
  fetchVoice.mockResolvedValueOnce(Response.json({ code: 'room_full' }, { status: 409 }));
  await session.join('full');
  expect(session.snapshot).toMatchObject({ status: 'connected', roomId: 'lounge' });
  expect(disconnect).not.toHaveBeenCalled();
  fetchVoice.mockResolvedValueOnce(Response.json({ url: 'ws://localhost/rtc', token: 'new', grantId: 'self.new' }));
  await session.join('games');
  expect(session.snapshot).toMatchObject({ status: 'connected', roomId: 'games' });
  expect(fetchVoice.mock.calls.every(([url]) => url.startsWith('/api/rooms/'))).toBe(true);
  session.end();
});

it('discards failed media admission without HTTP cleanup and permits a newer connection', async () => {
  connect.mockRejectedValueOnce(new Error('Unavailable'));
  fetchVoice.mockResolvedValueOnce(Response.json({ url: 'ws://localhost/rtc', token: 'bad', grantId: 'self.failed' }));
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge'); download.resolve(); await joining;
  expect(session.snapshot).toMatchObject({ status: 'idle' });
  expect(host.onProblem).toHaveBeenCalledWith('media_failed');
  await session.join('games');
  expect(session.snapshot).toMatchObject({ status: 'connected', roomId: 'games' });
  expect(fetchVoice.mock.calls.every(([url]) => url.startsWith('/api/rooms/'))).toBe(true);
  session.end();
});

it.each(['resolve', 'reject'] as const)('disconnects captured obsolete RTC setup after a newer connection when old setup %ss', async (completion) => {
  const admitting = deferred();
  connect.mockImplementationOnce(() => admitting.promise);
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const first = session.join('lounge'); download.resolve();
  await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
  const oldStop = vi.fn(); localTracks.set('mic', { track: { stop: oldStop } });
  session.end();
  const currentStop = vi.fn(); localTracks = new Map([['mic', { track: { stop: currentStop } }]]);
  fetchVoice.mockResolvedValueOnce(Response.json({ url: 'ws://localhost/rtc', token: 'new', grantId: 'self.new' }));
  await session.join('games');
  if (completion === 'resolve') admitting.resolve(); else admitting.reject(new Error('Canceled RTC setup'));
  await first;
  expect(session.snapshot).toMatchObject({ status: 'connected', roomId: 'games' });
  expect(rooms[0]!.disconnect).toHaveBeenCalledTimes(2);
  expect(rooms[1]!.disconnect).not.toHaveBeenCalled();
  expect(oldStop).toHaveBeenCalledTimes(2);
  expect(currentStop).not.toHaveBeenCalled();
  expect(host.onProblem).not.toHaveBeenCalled();
  expect(fetchVoice).toHaveBeenCalledTimes(2);
  session.end();
});

it('discards a late HTTP admission without touching a newer Join', async () => {
  let respond!: (value: Response) => void;
  fetchVoice.mockImplementationOnce(() => new Promise<Response>((resolve) => { respond = resolve; }));
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const first = session.join('lounge'); download.resolve();
  await vi.waitFor(() => expect(fetchVoice).toHaveBeenCalledOnce());
  await session.leave();
  fetchVoice.mockResolvedValueOnce(Response.json({ url: 'ws://localhost/rtc', token: 'new', grantId: 'self.new' }));
  await session.join('games');
  respond(Response.json({ url: 'ws://localhost/rtc', token: 'late', grantId: 'self.abandoned' }));
  await first;
  expect(session.snapshot).toMatchObject({ status: 'connected', roomId: 'games' });
  expect(fetchVoice.mock.calls.every(([url]) => url.startsWith('/api/rooms/'))).toBe(true);
  session.end();
});

it('discards credentials when media initialization itself fails', async () => {
  constructRoom.mockImplementationOnce(() => { throw new Error('Unsupported media'); });
  fetchVoice.mockResolvedValueOnce(Response.json({ url: 'ws://localhost/rtc', token: 'bad', grantId: 'self.unsupported' }));
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge'); download.resolve();
  await joining;
  expect(session.snapshot).toMatchObject({ status: 'idle' });
  expect(host.onProblem).toHaveBeenCalledWith('media_failed');
  expect(fetchVoice.mock.calls.every(([url]) => url.startsWith('/api/rooms/'))).toBe(true);
  session.end();
});

it('stops a late camera on its captured old room while a replacement keeps its media', async () => {
  const ready = deferred();
  const oldTracks = localTracks;
  const oldStop = vi.fn();
  enableCamera.mockImplementationOnce(async () => { await ready.promise; oldTracks.set('camera', { track: { stop: oldStop } }); });
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge'); download.resolve(); await joining;
  const camera = session.toggleCamera();
  await session.leave();
  const currentStop = vi.fn(); localTracks = new Map([['mic', { track: { stop: currentStop } }]]);
  await session.join('games');
  ready.resolve(); await camera;
  expect(oldStop).toHaveBeenCalledOnce();
  expect(currentStop).not.toHaveBeenCalled();
  expect(rooms[1]!.disconnect).not.toHaveBeenCalled();
  expect(session.snapshot).toMatchObject({ status: 'connected', roomId: 'games' });
  expect(fetchVoice).toHaveBeenCalledTimes(2);
  session.end();
});

it('cancels a first Join immediately and aborts its HTTP request even when it resolves late', async () => {
  const request = deferred();
  fetchVoice.mockImplementationOnce(async () => {
    await request.promise;
    return Response.json({ url: 'ws://localhost/rtc', token: 'late', grantId: 'self.late' });
  });
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge'); download.resolve();
  await vi.waitFor(() => expect(fetchVoice).toHaveBeenCalledOnce());
  const signal = fetchVoice.mock.calls[0]![1]!.signal;
  session.cancelJoin();
  expect(signal?.aborted).toBe(true);
  expect(session.snapshot).toEqual(idleVoice);
  await joining;
  await session.join('games');
  request.resolve();
  await Promise.resolve();
  expect(connect).toHaveBeenCalledOnce();
  expect(session.snapshot.roomId).toBe('games');
  expect(host.onProblem).not.toHaveBeenCalled();
  session.end();
});

it('bounds an unresponsive admission and keeps the current call during a failed move', async () => {
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const first = session.join('lounge'); download.resolve(); await first;
  vi.useFakeTimers();
  try {
    fetchVoice.mockReturnValueOnce(new Promise(() => {}));
    const moving = session.join('games');
    await vi.advanceTimersByTimeAsync(30_000);
    await moving;
    expect(fetchVoice.mock.calls[1]![1]!.signal?.aborted).toBe(true);
    expect(session.snapshot).toMatchObject({ status: 'connected', roomId: 'lounge', joiningRoomId: null });
    expect(disconnect).not.toHaveBeenCalled();
    expect(host.onProblem).toHaveBeenCalledWith('join_failed');
  } finally {
    session.end();
    vi.useRealTimers();
  }
});

it.each(['release', 'reconnect', 'deafen'])('discards acquisition after %s before any microphone can publish', async (interrupt) => {
  host.pushToTalk = () => true;
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge'); download.resolve(); await joining;
  const micReady = deferred();
  const track = localMic();
  acquireMic.mockImplementationOnce(async () => { await micReady.promise; return [track]; });
  try {
    const pressed = session.setMuted(false);
    await vi.waitFor(() => expect(acquireMic).toHaveBeenCalledOnce());
    let interrupted: Promise<void> | undefined;
    if (interrupt === 'release') interrupted = session.setMuted(true);
    if (interrupt === 'deafen') interrupted = session.toggleDeafen();
    if (interrupt === 'reconnect') {
      listeners.get('Reconnecting')!();
      await session.setMuted(false);
      listeners.get('Reconnected')!();
    }
    micReady.resolve();
    await Promise.all([pressed, interrupted]);
    expect(publishMic).not.toHaveBeenCalled();
    expect(enableMicrophone).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(session.snapshot.muted).toBe(true);
    expect(host.onProblem).not.toHaveBeenCalled();
  } finally {
    micReady.resolve();
    session.end();
  }
});

it.each(['release', 'deafen'])('keeps the microphone silent when %s follows the SDK publication event', async (interrupt) => {
  host.pushToTalk = () => true;
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge'); download.resolve(); await joining;
  const acknowledged = deferred();
  const track = localMic();
  acquireMic.mockResolvedValueOnce([track]);
  const publish = publishMic.getMockImplementation()!;
  let sendingAtPublication: boolean | undefined;
  publishMic.mockImplementationOnce(async (candidate) => {
    sendingAtPublication = candidate.capture.enabled;
    const publication = await publish(candidate);
    await acknowledged.promise;
    return publication;
  });
  try {
    const pressed = session.setMuted(false);
    await vi.waitFor(() => expect(localTracks.has('mic')).toBe(true));
    expect(sendingAtPublication).toBe(false);
    expect(track.capture.enabled).toBe(false);
    expect(track.unmute).not.toHaveBeenCalled();
    expect(session.snapshot.muted).toBe(true);
    const interrupted = interrupt === 'release' ? session.setMuted(true) : session.toggleDeafen();
    expect(track.stop).toHaveBeenCalledOnce();
    acknowledged.resolve();
    await Promise.all([pressed, interrupted]);
    expect(track.unmute).not.toHaveBeenCalled();
    expect(localTracks.has('mic')).toBe(false);
    expect(session.snapshot.muted).toBe(true);
  } finally {
    acknowledged.resolve();
    session.end();
  }
});

it('enables a still-held microphone after publication and reuses it on the next hold', async () => {
  host.pushToTalk = () => true;
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge'); download.resolve(); await joining;
  const track = localMic();
  acquireMic.mockResolvedValueOnce([track]);
  try {
    await session.setMuted(false);
    expect(publishMic).toHaveBeenCalledWith(track);
    expect(track.capture.enabled).toBe(true);
    expect(session.snapshot.muted).toBe(false);
    await session.setMuted(true);
    expect(track.capture.enabled).toBe(false);
    await session.setMuted(false);
    expect(track.capture.enabled).toBe(true);
    expect(acquireMic).toHaveBeenCalledOnce();
    expect(publishMic).toHaveBeenCalledOnce();
    expect(track.unmute).not.toHaveBeenCalled();
  } finally {
    session.end();
  }
});

it('never queues activation behind the audio track unmute lock after publication', async () => {
  host.pushToTalk = () => true;
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge'); download.resolve(); await joining;
  const track = localMic();
  const unlock = deferred();
  const sent = vi.fn();
  acquireMic.mockResolvedValueOnce([track]);
  track.unmute.mockImplementationOnce(async () => {
    await unlock.promise;
    // The audio override can restart an ended track and expose it to the sender.
    if (track.capture.readyState === 'ended') track.capture = { id: 'restarted', enabled: true, readyState: 'live' };
    sent(track.capture.enabled);
  });
  try {
    const pressed = session.setMuted(false);
    await vi.waitFor(() => expect(publishMic).toHaveBeenCalledOnce());
    const released = session.setMuted(true);
    unlock.resolve();
    await Promise.all([pressed, released]);
    expect(track.unmute).not.toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();
    expect(track.capture.enabled).toBe(false);
  } finally {
    unlock.resolve();
    session.end();
  }
});

it.each(['ended', 'new device'])('retires the %s microphone and drops a replacement acquired after release', async (reason) => {
  host.pushToTalk = () => true;
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge'); download.resolve(); await joining;
  const oldTrack = localMic();
  const replacement = localMic();
  const microphoneReady = deferred();
  acquireMic.mockResolvedValueOnce([oldTrack]).mockImplementationOnce(async () => {
    await microphoneReady.promise;
    return [replacement];
  });
  try {
    await session.setMuted(false);
    await session.setMuted(true);
    if (reason === 'ended') {
      oldTrack.capture.readyState = 'ended';
      oldTrack.constraints.deviceId = 'previous-input';
    } else await session.setMic('usb-microphone');
    expect(acquireMic).toHaveBeenCalledOnce();

    const pressed = session.setMuted(false);
    await vi.waitFor(() => expect(acquireMic).toHaveBeenCalledTimes(2));
    expect(localTracks.has('mic')).toBe(false);
    expect(oldTrack.stop).toHaveBeenCalledOnce();
    expect(acquireMic).toHaveBeenLastCalledWith({
      audio: expect.objectContaining({ deviceId: reason === 'ended' ? { ideal: 'previous-input' } : { exact: 'usb-microphone' } }),
    });
    const released = session.setMuted(true);
    microphoneReady.resolve();
    await Promise.all([pressed, released]);
    expect(replacement.stop).toHaveBeenCalledOnce();
    expect(publishMic).toHaveBeenCalledOnce();
    expect(oldTrack.unmute).not.toHaveBeenCalled();
    expect(replacement.unmute).not.toHaveBeenCalled();
    expect(session.snapshot.muted).toBe(true);
  } finally {
    microphoneReady.resolve();
    session.end();
  }
});

it('replaces the selected microphone while talking and preserves normal deafen and mute', async () => {
  host.joinMuted = () => false;
  host.micId = () => 'saved-mic';
  const oldTrack = localMic();
  const selectedTrack = localMic();
  acquireMic.mockResolvedValueOnce([oldTrack]).mockResolvedValueOnce([selectedTrack]);
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge'); download.resolve(); await joining;
  try {
    expect(oldTrack.capture.enabled).toBe(true);
    expect(acquireMic).toHaveBeenLastCalledWith({ audio: expect.objectContaining({ deviceId: { ideal: 'saved-mic' } }) });
    await session.setMic('new-mic');
    expect(switchActiveDevice).not.toHaveBeenCalled();
    expect(acquireMic).toHaveBeenLastCalledWith({ audio: expect.objectContaining({ deviceId: { exact: 'new-mic' } }) });
    expect(oldTrack.stop).toHaveBeenCalledOnce();
    expect(selectedTrack.capture.enabled).toBe(true);
    await session.toggleDeafen();
    expect(selectedTrack.capture.enabled).toBe(false);
    await session.toggleDeafen();
    expect(selectedTrack.capture.enabled).toBe(true);
    await session.toggleMute();
    expect(selectedTrack.capture.enabled).toBe(false);
    await session.toggleMute();
    expect(selectedTrack.capture.enabled).toBe(true);
    expect(acquireMic).toHaveBeenCalledTimes(2);
  } finally {
    session.end();
  }
});

it('uses the saved input as a preference after leaving during an exact device switch', async () => {
  host.joinMuted = () => false;
  let savedDevice = '';
  host.micId = () => savedDevice;
  const original = localMic();
  const stale = localMic();
  const fallback = localMic();
  const usbReady = deferred();
  acquireMic.mockResolvedValueOnce([original]).mockImplementationOnce(async () => {
    await usbReady.promise;
    return [stale];
  }).mockImplementationOnce(async (options) => {
    const { audio } = options as { audio: { deviceId: ConstrainDOMStringParameters } };
    if (audio.deviceId.exact) throw new DOMException('USB input unavailable', 'OverconstrainedError');
    return [fallback];
  });
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  let switching: Promise<void> | undefined;
  try {
    const joining = session.join('lounge'); download.resolve(); await joining;
    savedDevice = 'usb-microphone';
    switching = session.setMic(savedDevice);
    await vi.waitFor(() => expect(acquireMic).toHaveBeenCalledTimes(2));
    expect(acquireMic).toHaveBeenLastCalledWith({ audio: expect.objectContaining({ deviceId: { exact: savedDevice } }) });
    await session.leave();
    localTracks = new Map();
    await session.join('games');
    expect(constructRoom).toHaveBeenLastCalledWith(expect.objectContaining({
      audioCaptureDefaults: expect.objectContaining({ deviceId: { ideal: savedDevice } }),
    }));
    expect(acquireMic).toHaveBeenLastCalledWith({ audio: expect.objectContaining({ deviceId: { ideal: savedDevice } }) });
    expect(session.snapshot).toMatchObject({ roomId: 'games', muted: false, listenOnly: false });
    usbReady.resolve();
    await switching;
    expect(stale.stop).toHaveBeenCalledOnce();
    expect(publishMic.mock.calls).toEqual([[original], [fallback]]);
    expect(fallback.capture.enabled).toBe(true);
  } finally {
    usbReady.resolve();
    session.end();
    await switching;
  }
});

it('keeps the input selection for the next hold when release interrupts a live device switch', async () => {
  host.pushToTalk = () => true;
  const oldTrack = localMic();
  const abandonedTrack = localMic();
  const nextTrack = localMic();
  const microphoneReady = deferred();
  acquireMic.mockResolvedValueOnce([oldTrack]).mockImplementationOnce(async () => {
    await microphoneReady.promise;
    return [abandonedTrack];
  }).mockResolvedValueOnce([nextTrack]);
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge'); download.resolve(); await joining;
  try {
    await session.setMuted(false);
    const switching = session.setMic('other-input');
    await vi.waitFor(() => expect(acquireMic).toHaveBeenCalledTimes(2));
    expect(oldTrack.capture.enabled).toBe(false);
    const released = session.setMuted(true);
    microphoneReady.resolve();
    await Promise.all([switching, released]);
    expect(abandonedTrack.stop).toHaveBeenCalledOnce();
    expect(publishMic).toHaveBeenCalledTimes(1);

    await session.setMuted(false);
    expect(acquireMic).toHaveBeenLastCalledWith({ audio: expect.objectContaining({ deviceId: { exact: 'other-input' } }) });
    expect(publishMic).toHaveBeenLastCalledWith(nextTrack);
    expect(nextTrack.capture.enabled).toBe(true);
  } finally {
    microphoneReady.resolve();
    session.end();
  }
});

it.each(['release', 'deafen'])('lets LiveKit make one device request when an exact input fails after %s', async (interrupt) => {
  host.pushToTalk = () => true;
  const ready = deferred();
  const getUserMedia = vi.fn(async (_constraints: MediaStreamConstraints) => {
    await ready.promise;
    throw new DOMException('Device was unplugged', 'OverconstrainedError');
  });
  vi.stubGlobal('navigator', { userAgent: navigator.userAgent, mediaDevices: { getUserMedia } });
  const { createLocalTracks } = await vi.importActual<typeof import('livekit-client')>('livekit-client');
  acquireMic.mockImplementationOnce(async (options) => {
    await createLocalTracks({ ...(options as CreateLocalTracksOptions), video: false });
    return [];
  });
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge'); download.resolve(); await joining;
  try {
    await session.setMic('usb-microphone');
    const pressed = session.setMuted(false);
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    const interrupted = interrupt === 'release' ? session.setMuted(true) : session.toggleDeafen();
    ready.resolve();
    await Promise.all([pressed, interrupted]);
    expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({
      audio: expect.objectContaining({ deviceId: { exact: 'usb-microphone' } }), video: false,
    });
    expect(publishMic).not.toHaveBeenCalled();
    expect(host.onProblem).not.toHaveBeenCalled();
  } finally {
    ready.resolve();
    session.end();
  }
});

it.each(['input', 'processing'])('keeps the microphone muted by LiveKit when %s settings change', async (setting) => {
  host.joinMuted = () => false;
  const track = localMic();
  acquireMic.mockResolvedValueOnce([track]);
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge'); download.resolve(); await joining;
  try {
    expect(session.snapshot.muted).toBe(false);
    await track.mute();
    listeners.get('TrackMuted')!();
    await Promise.resolve();
    expect(session.snapshot.muted).toBe(true);

    if (setting === 'input') await session.setMic('different-input');
    else await session.applyMicProcessing();
    expect(acquireMic).toHaveBeenCalledOnce();
    expect(publishMic).toHaveBeenCalledOnce();
    expect(track.capture.enabled).toBe(false);
    expect(session.snapshot.muted).toBe(true);
  } finally {
    session.end();
  }
});

it('allows a fresh hold after selecting a usable input following a failed replacement', async () => {
  host.pushToTalk = () => true;
  const track = localMic();
  acquireMic.mockResolvedValueOnce([localMic()])
    .mockRejectedValueOnce(new DOMException('Missing input', 'OverconstrainedError'))
    .mockResolvedValueOnce([track]);
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge'); download.resolve(); await joining;
  try {
    await session.setMuted(false);
    await session.setMic('missing-input');
    expect(session.snapshot).toMatchObject({ muted: true, listenOnly: true });
    expect(host.onProblem).toHaveBeenCalledWith('mic_denied');
    await session.applyMicProcessing();
    expect(session.snapshot.listenOnly).toBe(true);

    await session.setMic('usable-input');
    expect(acquireMic).toHaveBeenCalledTimes(2);
    expect(session.snapshot).toMatchObject({ muted: true, listenOnly: false });
    await session.setMuted(false);
    expect(acquireMic).toHaveBeenLastCalledWith({ audio: expect.objectContaining({ deviceId: { exact: 'usable-input' } }) });
    expect(publishMic).toHaveBeenLastCalledWith(track);
    expect(session.snapshot).toMatchObject({ muted: false, listenOnly: false });
  } finally {
    session.end();
  }
});

it.each([
  ['NotFoundError', 'mic_missing'],
  ['NotAllowedError', 'mic_denied'],
])('keeps a successful room join listen-only when capture fails with %s', async (errorName, problem) => {
  host.joinMuted = () => false;
  acquireMic.mockRejectedValueOnce(new DOMException('Capture unavailable', errorName));
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  try {
    const joining = session.join('lounge'); download.resolve(); await joining;
    expect(session.snapshot).toMatchObject({ status: 'connected', muted: true, listenOnly: true });
    const firstConnected = vi.mocked(host.onChange).mock.calls.find(([snapshot]) => snapshot.status === 'connected')?.[0];
    expect(firstConnected).toMatchObject({ muted: true, listenOnly: true });
    expect(host.onProblem).toHaveBeenCalledExactlyOnceWith(problem);
    expect(publishMic).not.toHaveBeenCalled();
  } finally {
    session.end();
  }
});

it.each(['Reconnecting', 'SignalReconnecting'])('silences an active hold before %s can republish the track', async (event) => {
  host.pushToTalk = () => true;
  const track = localMic();
  acquireMic.mockResolvedValueOnce([track]);
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge'); download.resolve(); await joining;
  try {
    await session.setMuted(false);
    listeners.get(event)!();
    expect(track.capture.enabled).toBe(false);
    await session.setMuted(false);
    listeners.get('Reconnected')!();
    expect(track.capture.enabled).toBe(false);
    await session.setMuted(false);
    expect(track.capture.enabled).toBe(true);
    expect(acquireMic).toHaveBeenCalledOnce();
  } finally {
    session.end();
  }
});

it('prompts for actual SDK and per-sink autoplay block, retries in the action, and stays quiet when deafened', async () => {
  vi.stubGlobal('navigator', { userAgent: 'iPhone Mobile/1' });
  const denied = new DOMException('Autoplay disabled', 'NotAllowedError');
  startAudio.mockRejectedValueOnce(denied);
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  try {
    const joining = session.join('lounge'); download.resolve(); await joining;
    expect(session.snapshot).toMatchObject({ status: 'connected', audioBlocked: true });
    rooms[0]!.canPlaybackAudio = true;
    listeners.get('AudioPlaybackStatusChanged')!(true);
    expect(session.snapshot.audioBlocked).toBe(false);

    const mic = document.createElement('audio');
    const play = vi.spyOn(mic, 'play').mockRejectedValueOnce(denied).mockResolvedValue();
    const track = addIncomingAudio(mic, 'mic');
    const playbackFailed = track.on.mock.calls[0]![1] as () => void;
    playbackFailed();
    await Promise.resolve();
    expect(session.snapshot.audioBlocked).toBe(true);
    listeners.get('AudioPlaybackStatusChanged')!(true);
    expect(session.snapshot.audioBlocked).toBe(true);

    // The user action calls play before yielding the event handler.
    session.retryAudio();
    expect(play).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    expect(session.snapshot.audioBlocked).toBe(false);

    const late = deferred();
    play.mockReturnValueOnce(late.promise);
    playbackFailed();
    await session.toggleDeafen();
    late.reject(denied);
    await Promise.resolve();
    session.retryAudio();
    expect(play).toHaveBeenCalledTimes(3);
    expect(session.snapshot.audioBlocked).toBe(false);
    expect(enableMicrophone).not.toHaveBeenCalled();
    expect(acquireMic).not.toHaveBeenCalled();
  } finally {
    session.end();
  }
});

it('clears a blocked native sink when LiveKit detaches it before TrackUnsubscribed', async () => {
  vi.stubGlobal('navigator', { userAgent: 'iPhone Mobile/1' });
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  try {
    const joining = session.join('lounge'); download.resolve(); await joining;
    rooms[0]!.canPlaybackAudio = true;
    const element = document.createElement('audio');
    const play = vi.spyOn(element, 'play').mockRejectedValue(new DOMException('Autoplay disabled', 'NotAllowedError'));
    const track = addIncomingAudio(element, 'mic');
    listeners.get('AudioPlaybackStatusChanged')!(false);
    await Promise.resolve();
    expect(session.snapshot.audioBlocked).toBe(true);

    // RemoteTrackPublication.setTrack detaches the old track before notifying the room.
    track.detach();
    remotes.delete('mic');
    listeners.get('TrackUnsubscribed')!(track);
    expect(session.snapshot.audioBlocked).toBe(false);
    expect(element.isConnected).toBe(false);
    session.retryAudio();
    expect(play).toHaveBeenCalledOnce();
  } finally {
    session.end();
  }
});

it('ignores benign pause failures and playback results from a recycled sink attachment', async () => {
  vi.stubGlobal('navigator', { userAgent: 'iPhone Mobile/1' });
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  try {
    const joining = session.join('lounge'); download.resolve(); await joining;
    const element = document.createElement('audio');
    const late = deferred();
    const play = vi.spyOn(element, 'play').mockRejectedValueOnce(new DOMException('Detached', 'AbortError'))
      .mockReturnValueOnce(late.promise).mockResolvedValue();
    const original = addIncomingAudio(element, 'mic');
    listeners.get('AudioPlaybackStatusChanged')!(false);
    await Promise.resolve();
    expect(session.snapshot.audioBlocked).toBe(false);
    session.retryAudio();
    expect(play).toHaveBeenCalledTimes(2);
    listeners.get('TrackUnsubscribed')!(original);
    addIncomingAudio(element, 'screen');
    late.reject(new DOMException('Autoplay disabled', 'NotAllowedError'));
    await Promise.resolve();
    expect(session.snapshot.audioBlocked).toBe(false);
  } finally {
    session.end();
  }
});

it('keeps call camera acquisition marked while replacing a camera at a new quality', async () => {
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge'); download.resolve(); await joining;
  const old = { stop: vi.fn(), mediaStreamTrack: { id: 'before' } };
  enableCamera.mockImplementationOnce(async () => { localTracks.set('camera', { track: old }); });
  await session.toggleCamera();
  expect(session.snapshot).toMatchObject({ camera: true, cameraStarting: false });

  const pending = deferred();
  enableCamera.mockImplementationOnce(async () => {
    await pending.promise;
    localTracks.set('camera', { track: { stop: vi.fn(), mediaStreamTrack: { id: 'after' } } });
  });
  const change = session.restartCamera();
  expect(session.snapshot.cameraStarting).toBe(true);
  await vi.waitFor(() => expect(enableCamera).toHaveBeenCalledTimes(2));
  expect(old.stop).toHaveBeenCalledOnce();
  expect(session.snapshot).toMatchObject({ camera: false, cameraStarting: true });
  pending.resolve();
  await change;
  expect(session.snapshot).toMatchObject({ camera: true, cameraStarting: false });
  session.end();
});
