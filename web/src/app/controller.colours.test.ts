import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LiveHandlers } from '../api/live';
import type { VoiceSnapshot } from '../voice/types';

const seam = vi.hoisted(() => ({ api: { accountSession: vi.fn(), logout: vi.fn(), me: vi.fn(), rooms: vi.fn(), messages: vi.fn(), colours: vi.fn(), setColour: vi.fn(), rename: vi.fn() }, live: {} as LiveHandlers, voiceChange: undefined as undefined | ((snapshot: VoiceSnapshot) => void) }));
vi.mock('../api/client', async (original) => ({ ...await original<typeof import('../api/client')>(), api: seam.api }));
vi.mock('../api/live', () => ({ LiveConnection: class {
  constructor(options: typeof seam.live) { seam.live = options; }
  start() {} stop() {}
} }));
vi.mock('@falky/voice', async () => {
  const { idleVoice } = await import('../voice/types');
  return { VoiceSession: class {
    constructor(options: { onChange: typeof seam.voiceChange }) { seam.voiceChange = options.onChange; }
    end() { seam.voiceChange?.(idleVoice); }
  } };
});
vi.mock('@falky/browser', () => ({}));
vi.mock('./appearance', () => ({ applyAppearance() {} }));
const colour = (palette: 'sky' | 'rose' | 'moss', revision: number, visitorId = 'self') => ({ visitorId, palette, revision });
const me = () => ({ id: 'self', name: 'Alex', nameTaken: false, colour: colour('sky', 1) });
const event = (palette: 'sky' | 'rose' | 'moss', revision: number, visitorId = 'self') => ({ type: 'visitor.colour.changed' as const, payload: colour(palette, revision, visitorId), eventId: `colour-${revision}`, timestamp: '2026-11-08T00:00:00Z' });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

afterEach(() => vi.useRealTimers());

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); localStorage.clear();
  seam.api.accountSession.mockImplementation(async () => ({ visitor: await seam.api.me(), kind: 'guest', expiresAt: '2027-01-01T00:00:00Z' }));
  seam.api.me.mockResolvedValue(me()); seam.api.rooms.mockResolvedValue([]); seam.api.messages.mockResolvedValue([]); seam.api.colours.mockResolvedValue([]);
});

it('keeps the confirmed selection through failure and retry, and ignores an older response after a newer live edit', async () => {
  const app = await import('./controller'); const { getState } = await import('./store');
  await app.boot();
  const pending = deferred<ReturnType<typeof colour>>(); seam.api.setColour.mockReturnValueOnce(pending.promise);
  const saving = app.setVisitorColour('rose');
  expect(getState().colours.self?.palette).toBe('sky');
  expect(getState().colourSave?.pending).toBe(true);
  pending.reject(new Error('unreachable')); await saving;
  expect(getState().colours.self?.palette).toBe('sky'); expect(getState().colourSave).toMatchObject({ palette: 'rose', pending: false, failed: true });
  const retry = deferred<ReturnType<typeof colour>>(); seam.api.setColour.mockReturnValueOnce(retry.promise);
  const retried = app.setVisitorColour('rose');
  seam.live.onEvent!(event('moss', 3)); retry.resolve(colour('rose', 2)); await retried;
  expect(seam.api.setColour).toHaveBeenLastCalledWith('rose');
  expect(getState().colours.self).toEqual(colour('moss', 3));
  expect(getState().visitor?.colour).toEqual(colour('moss', 3));
  expect(getState().colourSave).toBeNull();
});

it('merges simultaneous saves by accepted revision, with the newest request owning pending/error feedback', async () => {
  const app = await import('./controller'); const { getState } = await import('./store'); await app.boot();
  const first = deferred<ReturnType<typeof colour>>(); const second = deferred<ReturnType<typeof colour>>();
  seam.api.setColour.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const a = app.setVisitorColour('rose'); const b = app.setVisitorColour('moss');
  second.resolve(colour('moss', 3)); await b;
  first.resolve(colour('rose', 2)); await a;
  expect(getState().colours.self).toEqual(colour('moss', 3)); expect(getState().colourSave).toBeNull();
});

it('recovers every loaded historical author on live open without new messages, batches lookup and ignores stale snapshots and rename metadata', async () => {
  const authors = Array.from({ length: 125 }, (_, i) => `offline-${i}`);
  const messages = authors.map((authorId, i) => ({ id: String(i).padStart(4, '0'), roomId: 'room', authorId, authorName: authorId, body: 'History', attachments: [], createdAt: '2026-11-08T00:00:00Z' }));
  seam.api.rooms.mockResolvedValue([{ id: 'room', name: 'Lounge', occupancy: [] }]);
  seam.api.messages.mockImplementation(async (_id, q) => q.before ? [...messages.slice(0, 25)].reverse() : q.after ? [] : [...messages.slice(25)].reverse());
  seam.api.colours.mockImplementation(async (ids: string[]) => ids.map((id) => colour('rose', 1, id)));
  const app = await import('./controller'); const { getState } = await import('./store'); await app.boot();
  expect(getState().colours['offline-124']).toEqual(colour('rose', 1, 'offline-124'));
  await app.loadOlder('room'); expect(getState().chats.room?.messages).toHaveLength(125);
  expect(getState().colours['offline-0']).toEqual(colour('rose', 1, 'offline-0'));
  const snapshot = deferred<ReturnType<typeof colour>[]>();
  let delayedIds: string[] = [];
  seam.api.colours.mockImplementation((ids: string[]) => { if (ids.includes('offline-124')) { delayedIds = ids; return snapshot.promise; } return Promise.resolve(ids.map((id) => colour('moss', 2, id))); });
  const callsBefore = seam.api.colours.mock.calls.length;
  seam.live.onOpen!();
  await vi.waitFor(() => expect(seam.api.colours.mock.calls.length).toBeGreaterThan(callsBefore));
  seam.live.onEvent!(event('moss', 5, 'offline-124'));
  snapshot.resolve(delayedIds.map((id) => id === 'offline-124' ? colour('sky', 4, id) : colour('moss', 2, id)));
  await vi.waitFor(() => expect(getState().colours['offline-0']?.revision).toBe(2));
  expect(getState().colours['offline-124']).toEqual(colour('moss', 5, 'offline-124'));
  expect(seam.api.colours.mock.calls.every(([ids]) => ids.length <= 100)).toBe(true);
  const requested = seam.api.colours.mock.calls.slice(callsBefore).flatMap(([ids]) => ids);
  expect(requested).toEqual(expect.arrayContaining(['self', ...authors]));
  seam.live.onEvent!(event('moss', 6)); seam.api.rename.mockResolvedValue({ ...me(), name: 'New name' });
  await app.rename('New name'); expect(getState().visitor).toMatchObject({ name: 'New name', colour: colour('moss', 6) });
});

it('retries failed and missing snapshots on discovery, fetches SDK-only IDs, and ignores a previous session snapshot', async () => {
  const { idleVoice } = await import('../voice/types');
  seam.api.rooms.mockResolvedValue([{ id: 'room', name: 'Lounge', occupancy: [{ connectionId: 'peer.connection', visitorId: 'peer', name: 'Peer' }] }]);
  seam.api.colours.mockRejectedValue(new Error('offline'));
  const app = await import('./controller'); const { getState } = await import('./store'); await app.boot();
  expect(getState().colours.peer).toBeUndefined();
  seam.api.colours.mockResolvedValue([]);
  seam.live.onEvent!({ type: 'occupancy.changed', eventId: 'occupancy', timestamp: '2026-11-08T00:00:00Z', payload: { roomId: 'room', occupancy: [{ connectionId: 'peer.connection', visitorId: 'peer', name: 'Peer' }] } });
  await vi.waitFor(() => expect(seam.api.colours).toHaveBeenCalledTimes(3));
  const old = deferred<ReturnType<typeof colour>[]>(); seam.api.colours.mockReturnValueOnce(old.promise);
  seam.voiceChange!({ ...idleVoice, roomId: 'room', people: [{ id: 'sdk-only.connection', visitorId: 'sdk-only', name: 'SDK', local: false, muted: false, deafened: false, sharing: false, shareTrackId: '', camera: false, cameraTrackId: '' }] });
  expect(seam.api.colours).toHaveBeenLastCalledWith(['peer', 'sdk-only']);
  seam.api.rooms.mockResolvedValue([]); seam.api.me.mockResolvedValue({ id: 'new-self', name: 'Other', colour: colour('sky', 1, 'new-self') });
  await app.boot(); old.resolve([colour('rose', 5, 'peer'), colour('rose', 5)]);
  await Promise.resolve(); await Promise.resolve();
  expect(getState().colours.self).toBeUndefined(); expect(getState().colours.peer).toBeUndefined();
  expect(getState().visitor?.id).toBe('new-self');
  seam.api.colours.mockImplementation(async (ids: string[]) => ids.map((id) => colour('moss', 2, id)));
  expect(getState().voice.people).toEqual([]);
  seam.voiceChange!({ ...idleVoice, roomId: 'room', people: [{ id: 'sdk-only.connection', visitorId: 'sdk-only', name: 'SDK', local: false, muted: false, deafened: false, sharing: false, shareTrackId: '', camera: false, cameraTrackId: '' }] });
  await vi.waitFor(() => expect(getState().colours['sdk-only']?.palette).toBe('moss'));
});


it('refreshes colours learned only through global edits before their older history is loaded', async () => {
  const app = await import('./controller'); const { getState } = await import('./store'); await app.boot();
  seam.live.onEvent!(event('rose', 2, 'not-loaded-yet'));
  seam.api.colours.mockImplementation(async (ids: string[]) => ids.map((id) => colour('moss', 3, id)));
  seam.live.onOpen!();
  await vi.waitFor(() => expect(getState().colours['not-loaded-yet']).toEqual(colour('moss', 3, 'not-loaded-yet')));
  expect(seam.api.colours).toHaveBeenCalledWith(['self', 'not-loaded-yet']);
});

it('does not let a previous session refresh or failed save revoke or recolour fresh access', async () => {
  const app = await import('./controller'); const { getState } = await import('./store'); const { ApiError } = await import('../api/client');
  await app.boot();
  const oldMe = deferred<ReturnType<typeof me>>(); seam.api.me.mockReturnValueOnce(oldMe.promise);
  const oldSave = deferred<ReturnType<typeof colour>>(); seam.api.setColour.mockReturnValueOnce(oldSave.promise);
  seam.live.onOpen!(); const saving = app.setVisitorColour('rose');
  seam.api.me.mockResolvedValue({ ...me(), id: 'fresh', colour: colour('moss', 1, 'fresh') });
  await app.boot();
  oldMe.reject(new ApiError(401, 'visitor_required', 'old access')); oldSave.reject(new ApiError(401, 'visitor_required', 'old access')); await saving;
  await Promise.resolve();
  expect(getState().phase).toBe('ready'); expect(getState().visitor?.id).toBe('fresh');
  expect(getState().colours).toEqual({ fresh: colour('moss', 1, 'fresh') }); expect(getState().colourSave).toBeNull();
});


it('retries a failed recovery snapshot while the live socket remains open and no messages arrive', async () => {
  vi.useFakeTimers();
  seam.api.rooms.mockResolvedValue([{ id: 'room', name: 'Lounge', occupancy: [{ connectionId: 'peer.connection', visitorId: 'peer', name: 'Peer' }] }]);
  seam.api.colours.mockResolvedValue([colour('rose', 1, 'peer')]);
  const app = await import('./controller'); const { getState } = await import('./store'); await app.boot();
  seam.api.colours.mockRejectedValue(new Error('snapshot unavailable'));
  seam.live.onOpen!(); await vi.advanceTimersByTimeAsync(0);
  expect(getState().colours.peer).toEqual(colour('rose', 1, 'peer'));
  await vi.advanceTimersByTimeAsync(3000);
  const attempts = seam.api.colours.mock.calls.length;
  seam.api.colours.mockResolvedValue([colour('moss', 2, 'peer')]);
  await vi.advanceTimersByTimeAsync(5999);
  expect(seam.api.colours).toHaveBeenCalledTimes(attempts);
  await vi.advanceTimersByTimeAsync(1);
  expect(getState().colours.peer).toEqual(colour('moss', 2, 'peer'));
  seam.api.colours.mockRejectedValue(new Error('snapshot unavailable again'));
  seam.live.onOpen!(); await vi.advanceTimersByTimeAsync(0);
  seam.live.onEvent!({ type: 'occupancy.changed', eventId: 'unknown-peer', timestamp: '2026-11-08T00:00:00Z', payload: { roomId: 'room', occupancy: [{ connectionId: 'missing-peer.connection', visitorId: 'missing-peer', name: 'Peer' }] } });
  const beforeEnd = seam.api.colours.mock.calls.length;
  seam.live.onRevoked!();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(seam.api.colours).toHaveBeenCalledTimes(beforeEnd);
  expect(getState().phase).toBe('revoked');
});


it('keeps same-owner drafts during guest upgrade, but clears old identity data and previews on account switch', async () => {
  const app = await import('./controller'); const { getState, setState } = await import('./store');
  await app.boot();
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  setState({ uploads: { room: [{ localId: 'draft', roomId: 'room', name: 'picture', size: 1, previewUrl: 'blob:ready', status: 'ready', progress: 1, reason: '' }] }, chatOpen: true });
  const before = getState().ownerRevision;
  seam.api.rooms.mockResolvedValue([{ id: 'room', name: 'Lounge', occupancy: [] }]);
  setState({ chats: { room: { messages: [], pending: [{ requestKey: 'pending', roomId: 'room', body: 'Draft', attachments: [{ id: 'pending-image', contentUrl: 'blob:pending' } as never], failed: false, reason: '' }], hasOlder: false, loadingOlder: false, loaded: true, unread: 0 } } });
  const epoch = app.beginSessionChange();
  await app.adoptSession({ visitor: me(), kind: 'account', expiresAt: '2027-02-01T00:00:00Z' }, epoch);
  expect(getState().uploads.room?.[0]?.previewUrl).toBe('blob:ready');
  expect(getState().ownerRevision).toBe(before);
  expect(getState().chats.room?.pending[0]).toMatchObject({ body: 'Draft', failed: true });
  expect(revoke).not.toHaveBeenCalled();
  expect(getState().accountSession?.kind).toBe('account');
  const next = app.beginSessionChange();
  await app.adoptSession({ visitor: { ...me(), id: 'other', colour: colour('moss', 1, 'other') }, kind: 'account' }, next);
  expect(getState().uploads).toEqual({});
  expect(getState().chatOpen).toBe(false);
  expect(getState().ownerRevision).toBe(before + 1);
  expect(revoke).toHaveBeenCalledWith('blob:ready');
  expect(revoke).toHaveBeenCalledWith('blob:pending');
  revoke.mockRestore();
});

it('pauses old Main effects/actions before finish and ignores stale live callbacks after adoption', async () => {
  const app = await import('./controller'); const { getState } = await import('./store');
  await app.boot();
  const previousLive = seam.live;
  const epoch = app.beginSessionChange();
  expect(getState().sessionPaused).toBe(true);
  const reads = seam.api.messages.mock.calls.length;
  await app.loadOlder('room'); app.postMessage('room', 'Old owner action');
  expect(await app.rename('Old owner name')).toBeTruthy();
  expect(seam.api.rename).not.toHaveBeenCalled();
  expect(seam.api.messages).toHaveBeenCalledTimes(reads);
  await app.adoptSession({ visitor: { ...me(), id: 'new', colour: colour('rose', 1, 'new') }, kind: 'account' }, epoch);
  previousLive.onRevoked(); previousLive.onEvent(event('moss', 99));
  expect(getState().phase).toBe('ready'); expect(getState().visitor?.id).toBe('new');
  expect(getState().colours.self).toBeUndefined(); expect(getState().sessionPaused).toBe(false);
});

it('signs out an already invalid session, clears identity state and links, and preserves browser choices', async () => {
  const app = await import('./controller'); const { getState } = await import('./store'); const { ApiError } = await import('../api/client');
  const links = await import('./entryLinks');
  await app.boot();
  app.updateSettings({ theme: 'light', sounds: false });
  history.replaceState(null, '', '/#invite=TransientInvitation'); links.captureEntryLinks();
  seam.api.logout.mockRejectedValueOnce(new ApiError(401, 'visitor_required', 'expired'));
  await app.logout();
  expect(seam.api.logout).toHaveBeenCalledTimes(1);
  expect(getState()).toMatchObject({ phase: 'entry', visitor: null, accountSession: null, chats: {}, uploads: {}, viewedRoomId: null, settings: { theme: 'light', sounds: false } });
  expect(links.getEntryLinks()).toEqual({});
});

it('reclassifies live retry snapshots and clears old owner state when the shared cookie changed identities', async () => {
  const app = await import('./controller'); const { getState, setState } = await import('./store');
  await app.boot();
  const oldRevision = getState().ownerRevision;
  setState({ uploads: { private: [{ localId: 'old', roomId: 'private', name: 'old image', size: 1, previewUrl: 'blob:old', status: 'ready', progress: 1, reason: '' }] } });
  seam.api.accountSession.mockResolvedValue({ visitor: { ...me(), id: 'other', colour: colour('rose', 1, 'other') }, kind: 'account' });
  expect(await seam.live.shouldRetry()).toBe(false);
  expect(getState().accountSession?.kind).toBe('account');
  expect(getState().visitor?.id).toBe('other');
  expect(getState().uploads).toEqual({});
  expect(getState().ownerRevision).toBe(oldRevision + 1);
});

it('resolves the current cookie owner before retrying room adoption after a network failure', async () => {
  vi.useFakeTimers();
  const app = await import('./controller'); const { getState } = await import('./store');
  seam.api.rooms.mockRejectedValueOnce(new Error('rooms offline'));
  await app.boot();
  seam.api.accountSession.mockResolvedValue({ visitor: { ...me(), id: 'next', colour: colour('rose', 1, 'next') }, kind: 'account' });
  await vi.advanceTimersByTimeAsync(3000);
  expect(getState().visitor?.id).toBe('next');
  expect(getState().accountSession?.kind).toBe('account');
});
