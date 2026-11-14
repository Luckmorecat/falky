import { api, ApiError, type AccountSession, type Attachment, type LiveEvent, type Message, type Room, type Visitor, type VisitorColour } from '../api/client';
import { LiveConnection } from '../api/live';
import { followingLatest } from '../chat/place';
import { isImage, onImageGone } from '../chat/images';
import { countUnread, emptyChat, mergeMessages, type ComposerUpload, type PendingMessage, type RoomChat } from '../chat/timeline';
import { type PaletteName } from '../fx/palette';
import { resolveLanguage, setLanguage, t } from '../strings';
import { VoiceSession } from '@falky/voice';
import type { VoiceClient } from '../voice/types';
import { playSound, notificationPermission, requestNotificationPermission, notificationsAvailable, notify } from '@falky/browser';
import { applyAppearance } from './appearance';
import { prefs, type Settings } from './prefs';
import { getState, setState } from './store';
import { clearSignInHints, retainSignInHint } from './signInHints';
import { captureEntryLinks, clearEntryLinks, getEntryLinks } from './entryLinks';

const PAGE = 100;
// A response from a previous access/boot must never populate the next visitor's state.
let session = 0;
let sessionChanging = false;
const sessionListeners = new Set<() => void>();
export function subscribeSessionEpoch(listener: () => void): () => void {
  sessionListeners.add(listener);
  return () => { sessionListeners.delete(listener); };
}
let colourSaveSequence = 0;
const colourRequests = new Map<string, number>();
let colourRetryTimer: ReturnType<typeof setTimeout> | null = null;
let colourRetryDelay = 3000;

function resetColourRequests(): void {
  colourRequests.clear();
  if (colourRetryTimer) clearTimeout(colourRetryTimer);
  colourRetryTimer = null;
  colourRetryDelay = 3000;
}

function mergeColours(incoming: VisitorColour[]): void {
  const s = getState();
  const colours = { ...s.colours };
  for (const colour of incoming) {
    if (!colours[colour.visitorId] || colour.revision > colours[colour.visitorId]!.revision) colours[colour.visitorId] = colour;
  }
  const visitor = s.visitor && colours[s.visitor.id] ? { ...s.visitor, colour: colours[s.visitor.id]! } : s.visitor;
  setState({ colours, visitor, accountSession: visitor && s.accountSession ? { ...s.accountSession, visitor } : s.accountSession });
}

function acceptVisitor(visitor: Visitor): void {
  setState({ visitor, accountSession: getState().accountSession ? { ...getState().accountSession!, visitor } : null });
  mergeColours([visitor.colour]);
}

function knownVisitorIds(): string[] {
  const s = getState();
  return [...new Set([
    ...(s.visitor ? [s.visitor.id] : []),
    ...Object.keys(s.colours),
    ...s.rooms.flatMap((r) => r.occupancy.map((p) => p.visitorId)),
    ...s.voice.people.map((p) => p.visitorId),
    ...Object.values(s.chats).flatMap((c) => c.messages.map((m) => m.authorId)),
  ])];
}

/** Explicit-ID snapshots include offline authors; failed or omitted IDs remain retryable. */
async function refreshColours(all = false): Promise<void> {
  if (sessionChanging) return;
  const epoch = session;
  if (!getState().visitor) return;
  let failed = false;
  const ids = knownVisitorIds().filter((id) => all || (!getState().colours[id] && colourRequests.get(id) !== epoch));
  await Promise.all(Array.from({ length: Math.ceil(ids.length / 100) }, async (_, i) => {
    const batch = ids.slice(i * 100, (i + 1) * 100);
    batch.forEach((id) => colourRequests.set(id, epoch));
    try {
      const colours = await api.colours(batch);
      if (session === epoch) mergeColours(colours);
    } catch (err) {
      if (session === epoch && !accessEnded(err)) failed = true;
    } finally {
      batch.forEach((id) => { if (colourRequests.get(id) === epoch) colourRequests.delete(id); });
    }
  }));
  if (epoch !== session) return;
  if (!failed && all) colourRetryDelay = 3000;
  if (failed && !colourRetryTimer) {
    // A socket can stay open after snapshot failure. One backed-off read retry
    // recovers colour-only edits without waiting for a message or reconnect.
    colourRetryTimer = setTimeout(() => {
      colourRetryTimer = null;
      if (session === epoch) void refreshColours(true);
    }, colourRetryDelay);
    colourRetryDelay = Math.min(30_000, colourRetryDelay * 2);
  }
}

let noticeSeq = 0;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

const voiceSession: VoiceClient = new VoiceSession({
  onChange: (snapshot) => { setState({ voice: snapshot }); if (!sessionChanging) void refreshColours(); },
  onProblem(problem) {
    if (sessionChanging) return;
    if (problem === 'visitor_required') return endAccess();
    if (problem === 'name_taken') void refreshMe();
    showNotice(t.voiceProblems[problem].title, t.voiceProblems[problem].body);
  },
  onSound(sound) {
    if (sessionChanging) return;
    const s = getState();
    if (s.settings.sounds && !s.voice.deafened) playSound(sound, s.settings.speakerId);
  },
  micId: () => getState().settings.micId,
  speakerId: () => getState().settings.speakerId,
  micProcessing() {
    const s = getState().settings;
    return { echoCancellation: s.echoCancellation, noiseSuppression: s.noiseSuppression, autoGainControl: s.autoGain };
  },
  joinMuted: () => getState().settings.joinMuted,
  shareSettings: () => getState().settings,
  cameraSettings: () => getState().settings,
  volumeOf: (id) => prefs.volume(id),
});

const pausedVoiceActions = new Set<PropertyKey>(['join', 'toggleMute', 'toggleDeafen', 'toggleShare', 'toggleCamera', 'restartCamera', 'setCamera', 'setMic', 'setSpeaker', 'applyMicProcessing']);
const voiceMethods = new Map<PropertyKey, unknown>();
export const voice: VoiceClient = new Proxy(voiceSession, {
  get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== 'function') return value;
    if (!voiceMethods.has(key)) voiceMethods.set(key, pausedVoiceActions.has(key)
      ? (...args: unknown[]) => sessionChanging ? Promise.resolve() : value.apply(target, args)
      : value.bind(target));
    return voiceMethods.get(key);
  },
});

function makeLive(epoch: number): LiveConnection { return new LiveConnection({
  onEvent: (event) => { if (epoch === session) handleEvent(event); },
  onOpen() {
    if (epoch !== session) return;
    setState({ live: 'open' });
    void catchUp();
  },
  onDown: () => { if (epoch === session) setState({ live: 'reconnecting' }); },
  onRevoked: () => { if (epoch === session) endAccess(); },
  async shouldRetry() {
    if (epoch !== session) return false;
    try {
      if (!await refreshIdentity(epoch)) return false;
      const me = getState().visitor;
      if (me?.nameTaken) setState({ live: 'off' });
      return !!me && !me.nameTaken;
    } catch (err) {
      if (epoch !== session) return false;
      if (err instanceof ApiError && err.status === 401) {
        endAccess();
        return false;
      }
      return true;
    }
  },
}); }
let live = makeLive(session);

function clearOwner(clearPreferences = true): void {
  dropUploads();
  dismissNotice();
  if (clearPreferences) prefs.clearIdentity();
  setState({ visitor: null, accountSession: null, ownerRevision: getState().ownerRevision + 1, rooms: [], chats: {}, colours: {}, colourSave: null, viewedRoomId: null, newAfterId: null, chatOpen: false, roomsOpen: false });
}

function endAccess(): void {
  beginSessionChange();
  clearOwner();
  setState({ phase: 'revoked' });
}

/** Stops everything if a request found the access gone; says whether it did. */
function accessEnded(err: unknown): boolean {
  if (err instanceof ApiError && err.status === 401) {
    endAccess();
    return true;
  }
  return false;
}

export function showNotice(title: string, body?: string): void {
  if (noticeTimer) clearTimeout(noticeTimer);
  setState({ notice: { id: ++noticeSeq, title, body } });
  noticeTimer = setTimeout(() => setState({ notice: null }), 7000);
}

export function dismissNotice(): void {
  if (noticeTimer) clearTimeout(noticeTimer);
  setState({ notice: null });
}

/* ---------- Entering ---------- */

/** Invalidates old requests before a cookie-changing finish. Keep Main mounted during the flow. */
export function beginSessionChange(): number {
  const epoch = ++session;
  sessionChanging = true;
  clearSignInHints();
  sessionListeners.forEach(listener => listener());
  setState({ sessionPaused: true });
  resetColourRequests();
  live.stop();
  live = makeLive(epoch);
  voice.end();
  uploading.forEach((control) => control.abort());
  uploading.clear();
  const state = getState();
  setState({ live: 'off', colourSave: null,
    uploads: Object.fromEntries(Object.entries(state.uploads).map(([id, list]) => [id, list.map((u) => u.status === 'uploading' ? { ...u, status: 'failed' as const, reason: t.errors.postNetwork } : u)])),
    chats: Object.fromEntries(Object.entries(state.chats).map(([id, chat]) => [id, { ...chat, loadingOlder: false, pending: chat.pending.map((p) => ({ ...p, failed: true, reason: t.errors.postNetwork })) }])) });
  return epoch;
}

export function currentSessionEpoch(): number { return session; }
export function handleAccountError(error: unknown, epoch: number): void {
  if (epoch === session) accessEnded(error);
}

/** Only use after a known precommit failure. Unknown outcomes need reconcileSession. */
export function resumeSession(epoch: number): void {
  if (epoch !== session || !getState().visitor) return;
  sessionChanging = false;
  setState({ sessionPaused: false });
  if (!getState().visitor?.nameTaken) live.start();
  void catchUp();
}

export async function boot(): Promise<void> {
  captureEntryLinks();
  await reconcileSession().catch(() => {});
}

export async function reconcileSession(): Promise<AccountSession | null> {
  const epoch = beginSessionChange();
  try {
    const resolved = await api.accountSession();
    if (epoch !== session) return null;
    await adoptSession(resolved, epoch);
    return resolved;
  } catch (err) {
    if (epoch !== session) return null;
    if (err instanceof ApiError && err.status === 401) {
      clearOwner();
      setState({ phase: 'entry' });
      return null;
    }
    // A failed restore does not establish that the existing session is invalid.
    setTimeout(() => { if (epoch === session) void reconcileSession().catch(() => {}); }, 3000);
    throw err;
  }
}

/** Tries guest entry using only a captured reusable access link. */
export async function enter(name: string): Promise<string | null> {
  const secret = getEntryLinks().guest;
  if (!secret) return t.errors.invalid_link;
  const epoch = beginSessionChange();
  let entered = false;
  try {
    await api.enter(secret, name);
    entered = true;
    if (epoch !== session) return null;
    clearEntryLinks('guest');
    const resolved = await api.accountSession();
    await adoptSession(resolved, epoch);
    return null;
  } catch (err) {
    if (epoch !== session) return null;
    if (entered || !(err instanceof ApiError) || err.status === 0 || err.status >= 500 || err.code === 'invalid_response') {
      void reconcileSession().catch(() => {});
    } else resumeSession(epoch);
    const code = err instanceof ApiError ? err.code : 'other';
    if (code === 'invalid_link' || code === 'name_taken' || code === 'invalid_name' || code === 'rate_limited' || code === 'network') return t.errors[code];
    return t.errors.other;
  }
}

export async function adoptSession(resolved: AccountSession, epoch: number): Promise<void> {
  if (epoch !== session) return;
  const sameOwner = getState().visitor?.id === resolved.visitor.id;
  if (!sameOwner) clearOwner(getState().visitor !== null);
  const visitor = resolved.visitor;
  setState({ visitor, accountSession: resolved, phase: 'ready' });
  mergeColours([visitor.colour]);
  let rooms: Room[];
  try { rooms = await api.rooms(); }
  catch (err) {
    if (epoch === session) {
      if (!accessEnded(err)) setTimeout(() => { if (epoch === session) void reconcileSession().catch(() => {}); }, 3000);
    }
    return;
  }
  if (epoch !== session) return;
  sessionChanging = false;
  setState({ sessionPaused: false });
  const state = getState();
  const remembered = sameOwner ? state.viewedRoomId : prefs.viewedRoom();
  const viewedRoomId = rooms.some((r) => r.id === remembered) ? remembered : (rooms[0]?.id ?? null);
  setState({ phase: 'ready', rooms, viewedRoomId, chats: Object.fromEntries(rooms.map((r) => [r.id, state.chats[r.id] ?? emptyChat()])), live: visitor.nameTaken ? 'off' : 'reconnecting' });
  void readAttachmentLimits(epoch);
  await Promise.all([refreshColours(), ...rooms.map(loadChat)]);
  if (epoch === session && !visitor.nameTaken) live.start();
}

export async function logout(): Promise<void> {
  const epoch = beginSessionChange();
  try { await api.logout(); }
  catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) {
      if (epoch === session) { clearOwner(); clearEntryLinks(); setState({ phase: 'entry' }); }
      throw err;
    }
  }
  if (epoch !== session) return;
  clearOwner();
  clearEntryLinks();
  setState({ phase: 'entry' });
}

async function refreshIdentity(epoch: number): Promise<boolean> {
  const resolved = await api.accountSession();
  if (epoch !== session) return false;
  const current = getState().accountSession;
  if (current?.visitor.id !== resolved.visitor.id || current.kind !== resolved.kind || current.expiresAt !== resolved.expiresAt) {
    await reconcileSession();
    return false;
  }
  acceptVisitor(resolved.visitor);
  return true;
}

async function refreshMe(): Promise<void> {
  if (sessionChanging) return;
  const epoch = session;
  try {
    await refreshIdentity(epoch);
  } catch (err) {
    if (epoch === session) accessEnded(err);
  }
}

/** Renames; answers the reason for the person, or null when done. */
export async function rename(name: string): Promise<string | null> {
  if (sessionChanging) return t.errors.other;
  const epoch = session;
  try {
    const before = getState().visitor;
    const visitor = await api.rename(name);
    if (epoch !== session) return null;
    acceptVisitor(visitor);
    // Live updates stayed closed while someone else held the name.
    if (before?.nameTaken && !visitor.nameTaken) live.start();
    return null;
  } catch (err) {
    if (epoch !== session || accessEnded(err)) return null;
    const code = err instanceof ApiError ? err.code : 'other';
    if (code === 'name_taken' || code === 'invalid_name' || code === 'network') return t.errors[code];
    return t.errors.other;
  }
}

/* ---------- Live updates ---------- */

function handleEvent(event: LiveEvent): void {
  const s = getState();
  switch (event.type) {
    case 'account.signin.requested':
      retainSignInHint(event.payload);
      break;
    case 'visitor.colour.changed':
      mergeColours([event.payload]);
      break;
    case 'message.created':
      addMessages(event.payload.roomId, [event.payload]);
      notifyOfMessage(event.payload);
      break;
    case 'room.changed': {
      const { id, name } = event.payload;
      const exists = s.rooms.some((r) => r.id === id);
      const rooms: Room[] = exists ? s.rooms.map((r) => (r.id === id ? { ...r, name } : r)) : [...s.rooms, { id, name, occupancy: [] }];
      setState({ rooms, chats: exists ? s.chats : { ...s.chats, [id]: { ...emptyChat(), loaded: true } }, viewedRoomId: s.viewedRoomId ?? id });
      break;
    }
    case 'occupancy.changed': {
      const { roomId, occupancy } = event.payload;
      setState({ rooms: s.rooms.map((r) => (r.id === roomId ? { ...r, occupancy } : r)) });
      void refreshColours();
      break;
    }
    case 'attachments.expired':
      if (event.roomId) expireAttachments(event.roomId, event.payload.attachmentIds);
      break;
    case 'access.revoked':
      endAccess();
      break;
  }
}

/** After any disconnection: events are not replayed, so read what was missed. */
async function catchUp(): Promise<void> {
  if (sessionChanging) return;
  const epoch = session;
  try {
    await Promise.all([refreshMe(), refreshColours(true)]);
    if (epoch !== session) return;
    const rooms = await api.rooms();
    if (epoch !== session) return;
    const s = getState();
    const chats = { ...s.chats };
    for (const r of rooms) chats[r.id] ??= emptyChat();
    setState({ rooms, chats, viewedRoomId: s.viewedRoomId ?? rooms[0]?.id ?? null });
    await Promise.all([refreshColours(), ...rooms.map(loadChat)]);
    if (epoch !== session) return;
    await refreshAttachments(epoch);
  } catch (err) {
    if (epoch === session) accessEnded(err);
  }
}

/* ---------- Chat ---------- */

function patchChat(roomId: string, patch: Partial<RoomChat> | ((c: RoomChat) => Partial<RoomChat>)): void {
  const s = getState();
  const chat = s.chats[roomId] ?? emptyChat();
  const p = typeof patch === 'function' ? patch(chat) : patch;
  setState({ chats: { ...s.chats, [roomId]: { ...chat, ...p } } });
}

const reading = (roomId: string): boolean => {
  const s = getState();
  return s.chatOpen && s.viewedRoomId === roomId && document.visibilityState === 'visible';
};

function addMessages(roomId: string, incoming: Message[]): void {
  patchChat(roomId, (c) => ({ messages: mergeMessages(c.messages, incoming) }));
  void refreshColours();
  syncRead(roomId);
}

function recount(roomId: string): void {
  const self = getState().visitor?.id;
  patchChat(roomId, (c) => ({ unread: countUnread(c.messages, prefs.lastRead(roomId), self) }));
}

/** Newest messages count as read only while the visitor is actually with them. */
function syncRead(roomId: string): void {
  if (reading(roomId) && followingLatest(roomId)) markRead(roomId);
  else recount(roomId);
}

function markRead(roomId: string): void {
  const last = getState().chats[roomId]?.messages.at(-1);
  if (last) {
    const read = prefs.lastRead(roomId);
    if (read === null || last.id > read) prefs.setLastRead(roomId, last.id);
  }
  patchChat(roomId, { unread: 0 });
}

/** Reads the newest page the first time, then only what came after. */
async function loadChat(room: Pick<Room, 'id'>): Promise<void> {
  if (sessionChanging) return;
  const epoch = session;
  const roomId = room.id;
  try {
    const chat = getState().chats[roomId];
    const last = chat?.messages.at(-1);
    if (!last) {
      const page = await api.messages(roomId, { limit: PAGE });
      if (epoch !== session) return;
      patchChat(roomId, (c) => ({ messages: mergeMessages(c.messages, page), hasOlder: page.length === PAGE, loaded: true }));
      // A newcomer starts with the room read; history is not news to them.
      const newest = getState().chats[roomId]?.messages.at(-1);
      if (newest && prefs.lastRead(roomId) === null) prefs.setLastRead(roomId, newest.id);
    } else {
      let cursor = last.id;
      for (;;) {
        const page = await api.messages(roomId, { after: cursor, limit: PAGE });
        if (epoch !== session) return;
        patchChat(roomId, (c) => ({ messages: mergeMessages(c.messages, page) }));
        const newest = page.at(-1);
        if (page.length < PAGE || !newest) break;
        cursor = newest.id;
      }
    }
    await refreshColours();
    if (epoch !== session) return;
    syncRead(roomId);
  } catch (err) {
    if (epoch !== session) return;
    if (!accessEnded(err)) patchChat(roomId, { loaded: true });
  }
}

export async function loadOlder(roomId: string): Promise<void> {
  if (sessionChanging) return;
  const epoch = session;
  const chat = getState().chats[roomId];
  const first = chat?.messages[0];
  if (!chat || !first || !chat.hasOlder || chat.loadingOlder) return;
  patchChat(roomId, { loadingOlder: true });
  try {
    const page = await api.messages(roomId, { before: first.id, limit: PAGE });
    if (epoch !== session) return;
    patchChat(roomId, (c) => ({ messages: mergeMessages(c.messages, page), hasOlder: page.length === PAGE, loadingOlder: false }));
    await refreshColours();
  } catch (err) {
    if (epoch !== session) return;
    if (!accessEnded(err)) patchChat(roomId, { loadingOlder: false });
  }
}

export function postMessage(roomId: string, body: string): void {
  if (sessionChanging) return;
  const ready = (getState().uploads[roomId] ?? []).filter((u) => u.status === 'ready' && u.attachment);
  const attachments = ready.map((u) => ({ ...u.attachment!, contentUrl: u.previewUrl }));
  const pending: PendingMessage = { requestKey: crypto.randomUUID(), roomId, body, attachments, failed: false, reason: '' };
  // The previews now belong to the pending message; failed pictures stay for the person to see why.
  setUploads(roomId, (list) => list.filter((u) => !ready.includes(u)));
  ready.forEach((u) => files.delete(u.localId));
  patchChat(roomId, (c) => ({ pending: [...c.pending, pending] }));
  void send(pending);
}

/** Sending again under the same key can never post it twice. */
export function retryMessage(p: PendingMessage): void {
  if (sessionChanging) return;
  patchChat(p.roomId, (c) => ({ pending: c.pending.map((x) => (x.requestKey === p.requestKey ? { ...x, failed: false, reason: '' } : x)) }));
  void send(p);
}

export function discardMessage(p: PendingMessage): void {
  if (sessionChanging) return;
  patchChat(p.roomId, (c) => ({ pending: c.pending.filter((x) => x.requestKey !== p.requestKey) }));
  for (const a of p.attachments) {
    URL.revokeObjectURL(a.contentUrl);
    void api.cancelAttachment(a.id).catch(() => {});
  }
}

async function send(p: PendingMessage): Promise<void> {
  if (sessionChanging) return;
  const epoch = session;
  try {
    const message = await api.post(p.roomId, p.requestKey, p.body, p.attachments.map((a) => a.id));
    if (epoch !== session) return;
    patchChat(p.roomId, (c) => ({ pending: c.pending.filter((x) => x.requestKey !== p.requestKey), messages: mergeMessages(c.messages, [message]) }));
    p.attachments.forEach((a) => URL.revokeObjectURL(a.contentUrl));
    syncRead(p.roomId);
  } catch (err) {
    if (epoch !== session || accessEnded(err)) return;
    const code = err instanceof ApiError ? err.code : 'other';
    const reason = code === 'rate_limited' ? t.errors.postRateLimited
      : code === 'network' ? t.errors.postNetwork
        : code === 'invalid_attachments' ? t.errors.postAttachmentsGone
          : t.errors.postOther;
    patchChat(p.roomId, (c) => ({ pending: c.pending.map((x) => (x.requestKey === p.requestKey ? { ...x, failed: true, reason } : x)) }));
  }
}

/* ---------- Attachments ---------- */

const uploading = new Map<string, AbortController>();

function setUploads(roomId: string, change: (list: ComposerUpload[]) => ComposerUpload[]): void {
  const s = getState();
  setState({ uploads: { ...s.uploads, [roomId]: change(s.uploads[roomId] ?? []) } });
}

function patchUpload(roomId: string, localId: string, patch: Partial<ComposerUpload>): void {
  setUploads(roomId, (list) => list.map((u) => (u.localId === localId ? { ...u, ...patch } : u)));
}

function dropUploads(): void {
  uploading.forEach((c) => c.abort());
  uploading.clear();
  for (const list of Object.values(getState().uploads)) for (const u of list) URL.revokeObjectURL(u.previewUrl);
  for (const chat of Object.values(getState().chats)) for (const pending of chat.pending) for (const attachment of pending.attachments) URL.revokeObjectURL(attachment.contentUrl);
  files.clear();
  setState({ uploads: {} });
}

async function readAttachmentLimits(epoch: number): Promise<void> {
  try {
    const limits = await api.attachmentLimits();
    if (epoch === session) setState({ attachmentLimits: { maxAttachments: limits.maxAttachments, maxFileBytes: limits.maxFileBytes } });
  } catch (error) {
    if (epoch === session) accessEnded(error);
    // The defaults match the server's; it refuses anything beyond them anyway.
  }
}

function uploadReason(err: unknown): string {
  const code = err instanceof ApiError ? err.code : 'other';
  const reasons: Record<string, string> = {
    attachment_too_large: t.errors.attachmentTooLarge,
    invalid_image: t.errors.invalidImage,
    image_dimensions: t.errors.imageDimensions,
    rate_limited: t.errors.uploadBusy,
    attachment_busy: t.errors.uploadBusy,
    attachment_capacity: t.errors.uploadUnavailable,
    attachment_processing: t.errors.uploadUnavailable,
    attachment_unavailable: t.errors.uploadUnavailable,
    upload_timeout: t.errors.uploadTimeout,
    network: t.errors.postNetwork,
  };
  return reasons[code] ?? t.errors.uploadOther;
}

async function upload(u: ComposerUpload, file: File): Promise<void> {
  const epoch = session;
  const control = new AbortController();
  uploading.set(u.localId, control);
  let last = 0;
  try {
    const attachment = await api.upload(u.roomId, file, (sent) => {
      // A render per percent is plenty.
      if (epoch !== session || control.signal.aborted) return;
      if (sent - last >= 0.01 || sent === 1) {
        last = sent;
        patchUpload(u.roomId, u.localId, { progress: sent });
      }
    }, control.signal);
    if (epoch !== session) return;
    if (!(getState().uploads[u.roomId] ?? []).some((x) => x.localId === u.localId)) {
      // Removed while it was on its way: the server should not keep it.
      void api.cancelAttachment(attachment.id).catch(() => {});
      return;
    }
    patchUpload(u.roomId, u.localId, { status: 'ready', progress: 1, attachment });
  } catch (err) {
    if (epoch !== session || (err instanceof ApiError && err.code === 'aborted') || accessEnded(err)) return;
    patchUpload(u.roomId, u.localId, { status: 'failed', reason: uploadReason(err) });
  } finally {
    if (uploading.get(u.localId) === control) uploading.delete(u.localId);
  }
}

const files = new Map<string, File>();

/**
 * Takes pictures for a room's next message: from the picker, a paste or a
 * drop. Only images; anything past the per-message number is turned away with
 * a notice rather than silently.
 */
export function addFiles(roomId: string, picked: Iterable<File>): void {
  if (sessionChanging) return;
  const { attachmentLimits: limits, uploads } = getState();
  const list = [...picked];
  const images = list.filter((f) => f.type.startsWith('image/'));
  const room = limits.maxAttachments - (uploads[roomId]?.length ?? 0);
  const taken = images.slice(0, Math.max(0, room));
  if (images.length < list.length) showNotice(t.onlyImages);
  else if (taken.length < images.length) showNotice(t.tooManyImages(limits.maxAttachments));
  for (const file of taken) {
    const u: ComposerUpload = {
      localId: crypto.randomUUID(), roomId, name: file.name || 'image', size: file.size,
      previewUrl: URL.createObjectURL(file), status: 'uploading', progress: 0, reason: '',
    };
    if (file.size > limits.maxFileBytes) {
      u.status = 'failed';
      u.reason = t.errors.attachmentTooLarge;
    }
    setUploads(roomId, (l) => [...l, u]);
    files.set(u.localId, file);
    if (u.status === 'uploading') void upload(u, file);
  }
}

export function removeUpload(roomId: string, localId: string): void {
  if (sessionChanging) return;
  const u = getState().uploads[roomId]?.find((x) => x.localId === localId);
  if (!u) return;
  uploading.get(localId)?.abort();
  files.delete(localId);
  URL.revokeObjectURL(u.previewUrl);
  setUploads(roomId, (list) => list.filter((x) => x.localId !== localId));
  if (u.attachment) void api.cancelAttachment(u.attachment.id).catch(() => {});
}

export function retryUpload(roomId: string, localId: string): void {
  if (sessionChanging) return;
  const u = getState().uploads[roomId]?.find((x) => x.localId === localId);
  const file = files.get(localId);
  if (!u || !file || u.status !== 'failed' || file.size > getState().attachmentLimits.maxFileBytes) return;
  const next = { ...u, status: 'uploading' as const, progress: 0, reason: '' };
  patchUpload(roomId, localId, next);
  void upload(next, file);
}

function patchAttachments(roomId: string, change: (a: Attachment) => Attachment): void {
  patchChat(roomId, (c) => {
    let touched = false;
    const messages = c.messages.map((m) => {
      if (!m.attachments.length) return m;
      let changed = false;
      const attachments = m.attachments.map((a) => {
        const next = change(a);
        if (next !== a) changed = true;
        return next;
      });
      if (!changed) return m;
      touched = true;
      return { ...m, attachments };
    });
    return touched ? { messages } : {};
  });
}

function expireAttachments(roomId: string, ids: string[]): void {
  const gone = new Set(ids);
  patchAttachments(roomId, (a) => (gone.has(a.id) && a.availability !== 'expired' ? { ...a, availability: 'expired' } : a));
}

onImageGone((id) => {
  for (const roomId of Object.keys(getState().chats)) expireAttachments(roomId, [id]);
});

/** Expiry events are not replayed: after a reconnect, ask after every picture still shown as there. */
async function refreshAttachments(epoch: number): Promise<void> {
  if (sessionChanging) return;
  const shown = Object.entries(getState().chats).flatMap(([roomId, c]) => c.messages.flatMap((m) =>
    m.attachments.filter((a) => a.availability === 'posted' && isImage(a)).map((a) => ({ roomId, id: a.id })))).slice(-120);
  for (let i = 0; i < shown.length; i += 4) {
    const batch = shown.slice(i, i + 4);
    const fresh = await Promise.all(batch.map(({ id }) => api.attachment(id).catch((error) => { if (epoch === session) accessEnded(error); return null; })));
    if (epoch !== session) return;
    batch.forEach(({ roomId }, j) => {
      const next = fresh[j];
      if (next && next.availability !== 'posted') expireAttachments(roomId, [next.id]);
    });
  }
}

function notifyOfMessage(m: Message): void {
  const s = getState();
  if (!s.settings.notifications || m.authorId === s.visitor?.id || document.visibilityState === 'visible') return;
  if (notificationPermission() !== 'granted') return;
  const room = s.rooms.find((r) => r.id === m.roomId)?.name ?? '';
  const epoch = session;
  notify(`${m.authorName} · ${room}`, { body: (m.body.trim() ? m.body : t.imagesSummary(m.attachments.length)).slice(0, 160), tag: m.roomId }, () => {
    if (epoch !== session) return;
    window.focus();
    viewRoom(m.roomId);
    setChatOpen(true);
  });
}

/* ---------- Navigation ---------- */

export function viewRoom(roomId: string): void {
  if (sessionChanging) return;
  const s = getState();
  if (s.viewedRoomId === roomId) {
    setState({ roomsOpen: false });
    return;
  }
  prefs.setViewedRoom(roomId);
  setState({ viewedRoomId: roomId, roomsOpen: false, newAfterId: null });
  if (getState().chatOpen) openReading(roomId);
}

export function stepRoom(delta: number): void {
  if (sessionChanging) return;
  const { rooms, viewedRoomId } = getState();
  if (!rooms.length) return;
  const i = rooms.findIndex((r) => r.id === viewedRoomId);
  const next = rooms[(i + delta + rooms.length) % rooms.length];
  if (next) viewRoom(next.id);
}

function openReading(roomId: string): void {
  const chat = getState().chats[roomId];
  // Unread stays marked by the line until the chat closes or the room changes.
  // A saved place up in the history must not mark the newer messages read.
  setState({ newAfterId: chat?.unread ? prefs.lastRead(roomId) : null });
  if (followingLatest(roomId)) markRead(roomId);
}

/** The visitor came back to the newest messages, by scrolling or the latest button. */
export function markLatestRead(roomId: string): void {
  if (sessionChanging) return;
  if (reading(roomId)) markRead(roomId);
}

export function setChatOpen(open: boolean): void {
  if (sessionChanging) return;
  const s = getState();
  setState({ chatOpen: open, newAfterId: open ? s.newAfterId : null });
  if (open && s.viewedRoomId) openReading(s.viewedRoomId);
}

document.addEventListener('visibilitychange', () => {
  const s = getState();
  if (!sessionChanging && document.visibilityState === 'visible' && s.chatOpen && s.viewedRoomId) syncRead(s.viewedRoomId);
});

/* ---------- Settings ---------- */

/** A swatch requests that exact palette. The confirmed map never changes optimistically. */
export async function setVisitorColour(palette: PaletteName): Promise<void> {
  if (sessionChanging) return;
  const epoch = session;
  const request = ++colourSaveSequence;
  setState({ colourSave: { palette, pending: true, failed: false } });
  try {
    const colour = await api.setColour(palette);
    if (epoch !== session) return;
    mergeColours([colour]);
    if (request === colourSaveSequence) setState({ colourSave: null });
  } catch (err) {
    if (epoch !== session || accessEnded(err)) return;
    if (request === colourSaveSequence) setState({ colourSave: { palette, pending: false, failed: true } });
  }
}

export function updateSettings(patch: Partial<Settings>): void {
  const settings = { ...getState().settings, ...patch };
  prefs.saveSettings(settings);
  setLanguage(resolveLanguage(settings.language));
  setState({ settings });
  if (patch.language !== undefined || patch.theme !== undefined || patch.fewerEffects !== undefined || patch.orbLight !== undefined) applyAppearance();
  if (patch.noiseSuppression !== undefined || patch.echoCancellation !== undefined || patch.autoGain !== undefined) void voice.applyMicProcessing();
  if (patch.micId !== undefined) void voice.setMic(patch.micId);
  if (patch.speakerId !== undefined) void voice.setSpeaker(patch.speakerId);
  if (patch.cameraId !== undefined) void voice.setCamera(patch.cameraId);
  if (patch.cameraResolution !== undefined) void voice.restartCamera();
}

/** Turns message notifications on, asking the browser first; answers whether they are on. */
export async function enableNotifications(): Promise<boolean> {
  if (!notificationsAvailable) return false;
  const permission = notificationPermission() === 'default' ? await requestNotificationPermission() : notificationPermission();
  updateSettings({ notifications: permission === 'granted' });
  return permission === 'granted';
}

export function setParticipantVolume(connectionId: string, value: number): void {
  prefs.setVolume(connectionId, value);
  voice.applyVolumes();
}


// A tab's cookies can change without this tab sending a mutation.
let checkingCookie = false;
async function checkCookieSession(): Promise<void> {
  if (checkingCookie || sessionChanging && getState().phase !== 'entry') return;
  checkingCookie = true;
  const epoch = session;
  try {
    const actual = await api.accountSession();
    const previous = getState().accountSession;
    if (epoch === session && (actual.kind !== previous?.kind || actual.visitor.id !== previous?.visitor.id || actual.expiresAt !== previous?.expiresAt)) await reconcileSession();
  } catch (error) {
    if (epoch === session && error instanceof ApiError && error.status === 401 && getState().accountSession) await reconcileSession();
  } finally { checkingCookie = false; }
}
addEventListener('focus', () => { void checkCookieSession(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void checkCookieSession();
});
