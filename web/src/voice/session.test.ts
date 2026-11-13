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
const rooms: { disconnect: ReturnType<typeof vi.fn>; localParticipant: { isMicrophoneEnabled: boolean } }[] = [];
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
const enableMicrophone = vi.fn(async (_enabled: boolean) => {});
const createMicrophone = vi.fn<() => Promise<unknown[]>>();
const publishMicrophone = vi.fn(async (_track: unknown) => {});
const enableShare = vi.fn(async () => {});
const enableCamera = vi.fn(async () => {});

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  vi.clearAllMocks();
  fetchVoice.mockImplementation(async () => Response.json({ url: 'ws://localhost/rtc', token: 'test', grantId: 'self.old' }));
  remotes.clear(); speakers.length = 0; localTracks = new Map(); rooms.length = 0;
  createMicrophone.mockImplementation(async () => [{ stop: vi.fn(), setAudioContext: vi.fn(), setProcessor: vi.fn(), mute: vi.fn() }]);
  download = deferred();
  vi.doMock('livekit-client', async () => {
    loadSDK();
    await download.promise;
    return {
      ConnectionQuality: {}, DisconnectReason: {}, RemoteAudioTrack: class {},
      Track: { Source: { Camera: 'camera', ScreenShare: 'screen', Microphone: 'mic' } },
      RoomEvent: {},
      Room: class {
        constructor() { constructRoom(); rooms.push(this); }
        localParticipant = { identity: 'self.nonce', setCameraEnabled: enableCamera, setScreenShareEnabled: enableShare, async setMicrophoneEnabled(enabled: boolean) { await enableMicrophone(enabled); this.isMicrophoneEnabled = enabled; }, createTracks: createMicrophone, async publishTrack(track: unknown) { await publishMicrophone(track); this.trackPublications.set('mic', { track }); this.isMicrophoneEnabled = true; }, trackPublications: localTracks, attributes: {}, isMicrophoneEnabled: false, getTrackPublication(source: string) { return this.trackPublications.get(source); } };
        remoteParticipants = remotes;
        activeSpeakers = speakers;
        connect = connect;
        startAudio = startAudio;
        on() { return this; }
        removeAllListeners() {}
        disconnect = vi.fn(() => disconnect());
      },
    };
  });
  vi.stubGlobal('AudioContext', class { resume = resume; });
  vi.stubGlobal('fetch', fetchVoice);
  host = {
    onChange: vi.fn(), onProblem: vi.fn(), onSound: vi.fn(),
    micId: () => '', speakerId: () => '', micGain: () => 1,
    micProcessing: () => ({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }),
    joinMuted: () => true, cameraSettings: () => prefs.settings(),
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

it('stops microphone media that becomes available after explicit Leave', async () => {
  const micReady = deferred();
  const stop = vi.fn();
  createMicrophone.mockImplementationOnce(async () => {
    await micReady.promise;
    return [{ stop }];
  });
  host.joinMuted = () => false;
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge'); download.resolve();
  await vi.waitFor(() => expect(createMicrophone).toHaveBeenCalledOnce());
  await session.leave();
  micReady.resolve();
  await joining;
  expect(stop).toHaveBeenCalledOnce();
  expect(session.snapshot.status).toBe('idle');
});

it.each([false, true])('restores the pre-test mute state (already muted: %s)', async (muted) => {
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge'); download.resolve(); await joining;
  rooms[0]!.localParticipant.isMicrophoneEnabled = !muted;
  localTracks.set('mic', { track: { stop: vi.fn() } });
  const test = session.suspendMicForTest();
  await test.ready;
  expect(session.snapshot.muted).toBe(true);
  await session.toggleMute();
  expect(session.snapshot.muted).toBe(true);
  test.release();
  await vi.waitFor(() => expect(rooms[0]!.localParticipant.isMicrophoneEnabled).toBe(!muted));
  session.end();
});

it('never unmutes a replacement room when a test ends', async () => {
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge'); download.resolve(); await joining;
  rooms[0]!.localParticipant.isMicrophoneEnabled = true;
  const test = session.suspendMicForTest();
  await test.ready;
  await session.leave();
  await session.join('games');
  enableMicrophone.mockClear();
  test.release();
  await Promise.resolve();
  expect(enableMicrophone).not.toHaveBeenCalled();
  expect(session.snapshot.muted).toBe(true);
  session.end();
});

it('installs microphone gain before publishing any audio', async () => {
  const setProcessor = vi.fn(async () => {});
  const track = { stop: vi.fn(), setAudioContext: vi.fn(), setProcessor, mute: vi.fn() };
  createMicrophone.mockResolvedValueOnce([track]);
  publishMicrophone.mockImplementationOnce(async () => { expect(setProcessor).toHaveBeenCalledOnce(); });
  host.joinMuted = () => false;
  host.micGain = () => 0;
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge'); download.resolve(); await joining;
  expect(publishMicrophone).toHaveBeenCalledWith(track);
  expect(host.onProblem).not.toHaveBeenCalled();
  session.end();
});

it('meters processed audio directly without looping it into the capture context', async () => {
  const { VoiceSession } = await import('./session');
  const { MicrophoneGain } = await import('./micGain');
  const processor = new MicrophoneGain(() => 0.5);
  vi.spyOn(processor, 'level').mockReturnValue(0.4);
  const update = vi.spyOn(processor, 'update');
  const source = vi.fn();
  vi.stubGlobal('AudioContext', class { resume = resume; createMediaStreamSource = source; });
  const track = { mediaStreamTrack: { id: 'processed' }, stop: vi.fn(), setAudioContext: vi.fn(), setProcessor: vi.fn(), getProcessor: () => processor, mute: vi.fn() };
  createMicrophone.mockResolvedValueOnce([track]);
  host.joinMuted = () => false;
  const session = new VoiceSession(host);
  const joining = session.join('lounge'); download.resolve(); await joining;
  expect(session.level('self.nonce')).toBe(0.4);
  expect(source).not.toHaveBeenCalled();
  session.applyMicGain();
  expect(update).toHaveBeenCalledOnce();
  await session.toggleMute();
  expect(session.level('self.nonce')).toBe(0);
  session.end();
});

it('ignores a canceled microphone failure after a replacement Join', async () => {
  const micReady = deferred();
  createMicrophone.mockImplementationOnce(async () => { await micReady.promise; return []; });
  host.joinMuted = () => false;
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const oldJoin = session.join('lounge'); download.resolve();
  await vi.waitFor(() => expect(createMicrophone).toHaveBeenCalledOnce());
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
