import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MockState } from '../../mock/protocol';
import { prefs } from '../app/prefs';
import type { VoiceHost, VoiceProblem } from '../voice/types';
import { refreshMockState } from './state';
import { VoiceSession } from './voice';

let state: MockState;
let problems: VoiceProblem[];
let session: VoiceSession;
let joinMuted = false;

beforeEach(async () => {
  localStorage.clear();
  state = {
    instanceId: crypto.randomUUID(), generation: 1, revision: 1, scenario: 'populated', scenarios: ['populated'],
    visitor: { id: 'self', name: 'Alex', nameTaken: false, colour: { visitorId: 'self', palette: 'sky', revision: 1 } }, voiceConnections: {},
    rooms: [{ id: 'lounge', name: 'Lounge', occupancy: [] }, { id: 'games', name: 'Games', occupancy: [] }],
    peers: { lounge: [{ connectionId: 'sam.connection', visitorId: 'sam', name: 'Sam', muted: false, deafened: false, sharing: false }] },
    faults: { send: 'none', colourSave: 'none', colourDelayMs: 0, colourResponseDelayMs: 0, delayMs: 0, liveDisconnected: false, roomFull: null, micDenied: false, shareFailure: false, voiceReconnecting: false },
    accessLink: '/#k=mock',
  };
  let issued = 0;
  // HTTP is the external boundary. Exercise the normal api.joinVoice client, never replace it.
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/voice')) {
      const roomId = url.split('/').at(-2)!;
      if (state.faults.roomFull === roomId) return Response.json({ code: 'room_full', message: 'Full' }, { status: 409 });
      const grantId = issued++ === 0 ? 'self.old' : `self.next${issued}`;
      state.voiceConnections[grantId] = roomId;
      state.revision++;
      return Response.json({ url: 'ws://localhost/rtc', token: 'mock', grantId });
    }
    if (url === '/__mock/action') {
      const body = JSON.parse(init!.body as string);
      if (body.generation !== state.generation) return Response.json({}, { status: 409 });
      delete state.voiceConnections[body.connectionId];
      state.revision++;
    }
    return Response.json(state);
  }));
  await refreshMockState();
  problems = [];
  joinMuted = false;
  const host: VoiceHost = {
    onChange() {}, onProblem: (problem) => problems.push(problem), onSound() {},
    micId: () => '', speakerId: () => '', micGain: () => 1, micProcessing: () => ({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }),
    joinMuted: () => joinMuted, cameraSettings: () => ({ cameraId: '', cameraResolution: '720', cameraMirror: true }),
      shareSettings: () => prefs.settings(), volumeOf: () => 1,
  };
  session = new VoiceSession(host);
});

afterEach(async () => { await session.leave(); session.dispose(); vi.unstubAllGlobals(); });

it('joins through HTTP and restores mute state across deafen, including join-muted', async () => {
  joinMuted = true;
  await session.join('lounge');
  expect(session.snapshot).toMatchObject({ status: 'connected', roomId: 'lounge', muted: true, deafened: false });
  expect(session.snapshot.people.map((p) => p.name)).toEqual(['Alex', 'Sam']);
  await session.toggleDeafen();
  await session.toggleDeafen();
  expect(session.snapshot).toMatchObject({ muted: true, deafened: false });
  await session.toggleMute();
  expect(session.snapshot.muted).toBe(false);
  await session.toggleDeafen();
  expect(session.snapshot).toMatchObject({ muted: true, deafened: true });
  await session.toggleDeafen();
  expect(session.snapshot).toMatchObject({ muted: false, deafened: false });
  expect(session.level('self.old')).toBeGreaterThanOrEqual(0);
  await session.leave();
  expect(session.snapshot.status).toBe('idle');
  expect(state.voiceConnections).toEqual({});
});

it('keeps denied microphones listen-only and exposes reconnecting and recovery through the same snapshot', async () => {
  state.faults.micDenied = true;
  state.revision++;
  await refreshMockState();
  await session.join('lounge');
  expect(session.snapshot).toMatchObject({ status: 'connected', muted: true, listenOnly: true });
  expect(problems).toContain('mic_denied');
  state.faults.voiceReconnecting = true;
  state.revision++;
  await refreshMockState();
  expect(session.snapshot.status).toBe('reconnecting');
  expect(session.level('sam.connection')).toBe(0);
  state.faults.voiceReconnecting = false;
  state.faults.micDenied = false;
  state.revision++;
  await refreshMockState();
  await session.toggleMute();
  expect(session.snapshot).toMatchObject({ status: 'connected', muted: false, listenOnly: false });
});

it('retains the old room after a full-room move and ends when server occupancy is revoked', async () => {
  await session.join('lounge');
  state.faults.roomFull = 'games';
  await session.join('games');
  expect(session.snapshot).toMatchObject({ status: 'connected', roomId: 'lounge', joiningRoomId: null });
  expect(problems).toEqual(['room_full']);
  state.voiceConnections = {};
  state.revision++;
  await refreshMockState();
  expect(session.snapshot).toMatchObject({ status: 'idle', people: [] });
});

it('starts and stops synthetic shares and reports configured share failure without inventing transport stats', async () => {
  await session.join('lounge');
  await session.toggleShare();
  expect(session.snapshot.sharing).toBe(true);
  const track = session.shareTrack('self.old');
  expect(track).not.toBeNull();
  expect(track?.sender).toBeUndefined();
  expect(track?.receiver).toBeUndefined();
  expect(session.snapshot.people.find((p) => p.local)?.shareTrackId).not.toBe('');
  await session.toggleShare();
  expect(session.shareTrack('self.old')).toBeNull();
  state.faults.shareFailure = true;
  state.revision++;
  await refreshMockState();
  await session.toggleShare();
  expect(session.snapshot.sharing).toBe(false);
  expect(problems).toContain('share_failed');
  state.peers.lounge![0]!.sharing = true;
  state.revision++;
  await refreshMockState();
  expect(session.shareTrack('sam.connection')).not.toBeNull();
  await session.leave();
  expect(session.shareTrack('sam.connection')).toBeNull();
});

it('denies Settings microphone tests through the same configured permission outcome', async () => {
  state.faults.micDenied = true;
  state.revision++;
  await refreshMockState();
  const { startMicTest } = await import('./browser');
  await expect(startMicTest({})).rejects.toMatchObject({ name: 'NotAllowedError' });
});

it('releases a late successful join after leaving without restoring the voice UI', async () => {
  const fetchHTTP = fetch;
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => { finish = resolve; });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.endsWith('/voice')) await wait;
    return fetchHTTP(url, init);
  });
  const joining = session.join('lounge');
  await session.leave();
  finish();
  await joining;
  expect(session.snapshot.status).toBe('idle');
  expect(state.voiceConnections).toEqual({});
});

it('also releases when leave interrupts state synchronization after successful HTTP join', async () => {
  const fetchHTTP = fetch;
  let finish!: () => void;
  let syncing!: () => void;
  const wait = new Promise<void>((resolve) => { finish = resolve; });
  const started = new Promise<void>((resolve) => { syncing = resolve; });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url === '/__mock/state') { syncing(); await wait; }
    return fetchHTTP(url, init);
  });
  const joining = session.join('lounge');
  await started;
  await session.leave();
  finish();
  await joining;
  expect(session.snapshot.status).toBe('idle');
  expect(state.voiceConnections).toEqual({});
});

it('disconnects both captured connections when Leave interrupts a room switch after HTTP admission', async () => {
  await session.join('lounge');
  const fetchHTTP = fetch;
  let finish!: () => void;
  let syncing!: () => void;
  const wait = new Promise<void>((resolve) => { finish = resolve; });
  const started = new Promise<void>((resolve) => { syncing = resolve; });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url === '/__mock/state') { syncing(); await wait; }
    return fetchHTTP(url, init);
  });
  const moving = session.join('games');
  await started;
  await session.leave();
  expect(state.voiceConnections).toEqual({});
  finish(); await moving;
  expect(session.snapshot.status).toBe('idle');
});
