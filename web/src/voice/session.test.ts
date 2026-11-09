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
const startAudio = vi.fn(async () => {});
const connect = vi.fn(async () => {});
const fetchVoice = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ url: 'ws://localhost/rtc', token: 'test', grantId: 'self.old' }));
const loadSDK = vi.fn();
const remotes = new Map();
const speakers: { identity: string }[] = [];
const localTracks = new Map();
const disconnect = vi.fn();
const constructRoom = vi.fn();
const enableMicrophone = vi.fn(async () => {});
const enableShare = vi.fn(async () => {});

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  vi.clearAllMocks();
  fetchVoice.mockImplementation(async () => Response.json({ url: 'ws://localhost/rtc', token: 'test', grantId: 'self.old' }));
  remotes.clear(); speakers.length = 0; localTracks.clear();
  download = deferred();
  vi.doMock('livekit-client', async () => {
    loadSDK();
    await download.promise;
    return {
      ConnectionQuality: {}, DisconnectReason: {}, RemoteAudioTrack: class {},
      Track: { Source: { Camera: 'camera', ScreenShare: 'screen', Microphone: 'mic' } },
      RoomEvent: {},
      Room: class {
        constructor() { constructRoom(); }
        localParticipant = { identity: 'self.nonce', setScreenShareEnabled: enableShare, setMicrophoneEnabled: enableMicrophone, trackPublications: localTracks, attributes: {}, isMicrophoneEnabled: false, getTrackPublication(source: string) { return localTracks.get(source); } };
        remoteParticipants = remotes;
        activeSpeakers = speakers;
        connect = connect;
        startAudio = startAudio;
        on() { return this; }
        removeAllListeners() {}
        disconnect = disconnect;
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

it('persists a late Join grant after explicit Leave without connecting it', async () => {
  const { VoiceSession } = await import('./session');
  let respond!: (value: Response) => void;
  const received = new Promise<Response>((resolve) => { respond = resolve; });
  fetchVoice.mockImplementationOnce(() => received);
  const session = new VoiceSession(host);
  const joining = session.join('lounge');
  download.resolve();
  await vi.waitFor(() => expect(fetchVoice).toHaveBeenCalledOnce());
  await session.leave();
  fetchVoice.mockRejectedValueOnce(new Error('Offline'));
  respond(Response.json({ url: 'ws://localhost/rtc', token: 'test', grantId: 'self.late' }));
  await joining;
  expect(connect).not.toHaveBeenCalled();
  expect(session.snapshot).toMatchObject({ status: 'idle', pendingLeave: 1 });
  expect(fetchVoice.mock.calls.at(-1)).toEqual(['/api/voice/leave', expect.objectContaining({ body: JSON.stringify({ grantId: 'self.late' }) })]);
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
  fetchVoice.mockRejectedValueOnce(new Error('Offline'));
  const leaving = session.leave();
  expect(stop).toHaveBeenCalledOnce();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(session.snapshot).toMatchObject({ status: 'idle', pendingLeave: 1 });
  await leaving;
  // A later SDK/access shutdown is not explicit durable Leave.
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

it('durably retires an abandoned late Join even after access ends', async () => {
  let respond!: (value: Response) => void;
  fetchVoice.mockImplementationOnce(() => new Promise<Response>((resolve) => { respond = resolve; }));
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge'); download.resolve();
  await vi.waitFor(() => expect(fetchVoice).toHaveBeenCalledOnce());
  session.end();
  fetchVoice.mockResolvedValueOnce(Response.json({ revoked: true }));
  respond(Response.json({ url: 'ws://localhost/rtc', token: 'test', grantId: 'self.ended' }));
  await joining;
  expect(fetchVoice.mock.calls.at(-1)).toEqual(['/api/voice/leave', expect.objectContaining({ body: JSON.stringify({ grantId: 'self.ended' }) })]);
  expect(connect).not.toHaveBeenCalled();
  expect(session.snapshot).toEqual(idleVoice);
});

it('stops microphone media that becomes available after explicit Leave', async () => {
  const micReady = deferred();
  const stop = vi.fn();
  enableMicrophone.mockImplementationOnce(async () => {
    await micReady.promise;
    localTracks.set('mic', { track: { stop } });
  });
  host.joinMuted = () => false;
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge'); download.resolve();
  await vi.waitFor(() => expect(enableMicrophone).toHaveBeenCalledOnce());
  await session.leave();
  micReady.resolve();
  await joining;
  expect(stop).toHaveBeenCalledOnce();
  expect(session.snapshot.status).toBe('idle');
});

it('ignores a canceled microphone failure after a replacement Join', async () => {
  const micReady = deferred();
  enableMicrophone.mockImplementationOnce(() => micReady.promise);
  host.joinMuted = () => false;
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const oldJoin = session.join('lounge'); download.resolve();
  await vi.waitFor(() => expect(enableMicrophone).toHaveBeenCalledOnce());
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

it('retires only the captured old grant after a successful new admission and preserves it on refusal', async () => {
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const first = session.join('lounge'); download.resolve(); await first;
  fetchVoice.mockResolvedValueOnce(Response.json({ code: 'room_full' }, { status: 409 }));
  await session.join('full');
  expect(session.snapshot).toMatchObject({ status: 'connected', roomId: 'lounge' });
  expect(disconnect).not.toHaveBeenCalled();
  fetchVoice.mockResolvedValueOnce(Response.json({ url: 'ws://localhost/rtc', token: 'new', grantId: 'self.new' }));
  fetchVoice.mockResolvedValueOnce(Response.json({ revoked: true }));
  await session.join('games');
  expect(session.snapshot).toMatchObject({ status: 'connected', roomId: 'games' });
  expect(fetchVoice.mock.calls.filter(([url]) => url === '/api/voice/leave')).toEqual([
    ['/api/voice/leave', expect.objectContaining({ body: JSON.stringify({ grantId: 'self.old' }) })],
  ]);
  session.end();
});

it('durably retires failed media admission without clearing a newer connection', async () => {
  connect.mockRejectedValueOnce(new Error('Unavailable'));
  fetchVoice.mockResolvedValueOnce(Response.json({ url: 'ws://localhost/rtc', token: 'bad', grantId: 'self.failed' }));
  fetchVoice.mockRejectedValueOnce(new Error('Offline'));
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge'); download.resolve(); await joining;
  expect(session.snapshot).toMatchObject({ status: 'idle', pendingLeave: 1 });
  expect(host.onProblem).toHaveBeenCalledWith('media_failed');
  await session.join('games');
  expect(session.snapshot).toMatchObject({ status: 'connected', roomId: 'games', pendingLeave: 1 });
  expect(fetchVoice.mock.calls.filter(([url]) => url === '/api/voice/leave')).toEqual([
    ['/api/voice/leave', expect.objectContaining({ body: JSON.stringify({ grantId: 'self.failed' }) })],
  ]);
  session.end();
});

it('retires canceled RTC setup credentials when a newer operation already connected', async () => {
  const admitting = deferred();
  connect.mockImplementationOnce(() => admitting.promise);
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const first = session.join('lounge'); download.resolve();
  await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
  fetchVoice.mockResolvedValueOnce(Response.json({ revoked: true }));
  session.end();
  fetchVoice.mockResolvedValueOnce(Response.json({ url: 'ws://localhost/rtc', token: 'new', grantId: 'self.new' }));
  await session.join('games');
  fetchVoice.mockResolvedValueOnce(Response.json({ revoked: true }));
  admitting.resolve(); await first;
  expect(session.snapshot).toMatchObject({ status: 'connected', roomId: 'games' });
  const leaves = fetchVoice.mock.calls.filter(([url]) => url === '/api/voice/leave');
  expect(leaves.length).toBeGreaterThan(0);
  for (const [, options] of leaves) expect(options).toMatchObject({ body: JSON.stringify({ grantId: 'self.old' }) });
  session.end();
});

it('retires an old late HTTP admission after a canceled Join without touching a newer Join', async () => {
  let respond!: (value: Response) => void;
  fetchVoice.mockImplementationOnce(() => new Promise<Response>((resolve) => { respond = resolve; }));
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const first = session.join('lounge'); download.resolve();
  await vi.waitFor(() => expect(fetchVoice).toHaveBeenCalledOnce());
  await session.leave();
  fetchVoice.mockResolvedValueOnce(Response.json({ url: 'ws://localhost/rtc', token: 'new', grantId: 'self.new' }));
  await session.join('games');
  fetchVoice.mockRejectedValueOnce(new Error('Offline'));
  respond(Response.json({ url: 'ws://localhost/rtc', token: 'late', grantId: 'self.abandoned' }));
  await first;
  expect(session.snapshot).toMatchObject({ status: 'connected', roomId: 'games', pendingLeave: 1 });
  expect(fetchVoice.mock.calls.at(-1)).toEqual(['/api/voice/leave', expect.objectContaining({ body: JSON.stringify({ grantId: 'self.abandoned' }) })]);
  session.end();
});

it('retires credentials when media initialization itself fails', async () => {
  constructRoom.mockImplementationOnce(() => { throw new Error('Unsupported media'); });
  fetchVoice.mockResolvedValueOnce(Response.json({ url: 'ws://localhost/rtc', token: 'bad', grantId: 'self.unsupported' }));
  fetchVoice.mockRejectedValueOnce(new Error('Offline'));
  const { VoiceSession } = await import('./session');
  const session = new VoiceSession(host);
  const joining = session.join('lounge'); download.resolve();
  await joining;
  expect(session.snapshot).toMatchObject({ status: 'idle', pendingLeave: 1 });
  expect(host.onProblem).toHaveBeenCalledWith('media_failed');
  expect(fetchVoice.mock.calls.at(-1)).toEqual(['/api/voice/leave', expect.objectContaining({ body: JSON.stringify({ grantId: 'self.unsupported' }) })]);
  session.end();
});
