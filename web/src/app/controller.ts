import { api, ApiError, type LiveEvent, type Message, type Room, type Visitor, type VisitorColour } from '../api/client';
import { LiveConnection } from '../api/live';
import { followingLatest } from '../chat/place';
import { countUnread, emptyChat, mergeMessages, type PendingMessage, type RoomChat } from '../chat/timeline';
import { type PaletteName } from '../fx/palette';
import { resolveLanguage, setLanguage, t } from '../strings';
import { VoiceSession } from '@falky/voice';
import type { VoiceClient } from '../voice/types';
import { playSound, notificationPermission, requestNotificationPermission, notificationsAvailable, notify } from '@falky/browser';
import { applyAppearance } from './appearance';
import { prefs, type Settings } from './prefs';
import { getState, setState } from './store';

const PAGE = 100;
// A response from a previous access/boot must never populate the next visitor's state.
let session = 0;
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
  setState({ colours, visitor });
}

function acceptVisitor(visitor: Visitor): void {
  setState({ visitor });
  mergeColours([visitor.colour]);
}

function knownVisitorIds(): string[] {
  const s = getState();
  return [...new Set([
    ...(s.visitor ? [s.visitor.id] : []),
    ...Object.keys(s.colours),
    ...s.rooms.flatMap((r) => r.occupancy.map((p) => p.visitorId)),
    ...s.voice.people.map((p) => p.id),
    ...Object.values(s.chats).flatMap((c) => c.messages.map((m) => m.authorId)),
  ])];
}

/** Explicit-ID snapshots include offline authors; failed or omitted IDs remain retryable. */
async function refreshColours(all = false): Promise<void> {
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

/** The access link's secret, from the URL fragment, kept only while it is needed. */
let linkSecret: string | null = null;
let noticeSeq = 0;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

export const voice: VoiceClient = new VoiceSession({
  onChange: (snapshot) => { setState({ voice: snapshot }); void refreshColours(); },
  onProblem(problem) {
    if (problem === 'visitor_required') return endAccess();
    if (problem === 'name_taken') void refreshMe();
    showNotice(t.voiceProblems[problem].title, t.voiceProblems[problem].body);
  },
  onSound(sound) {
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

const live = new LiveConnection({
  onEvent: handleEvent,
  onOpen() {
    setState({ live: 'open' });
    void catchUp();
  },
  onDown: () => setState({ live: 'reconnecting' }),
  onRevoked: endAccess,
  async shouldRetry() {
    const epoch = session;
    try {
      const me = await api.me();
      if (epoch !== session) return false;
      acceptVisitor(me);
      if (me.nameTaken) setState({ live: 'off' });
      return !me.nameTaken;
    } catch (err) {
      if (epoch !== session) return false;
      if (err instanceof ApiError && err.status === 401) {
        endAccess();
        return false;
      }
      return true;
    }
  },
});

function endAccess(): void {
  session++;
  resetColourRequests();
  live.stop();
  setState({ phase: 'revoked', live: 'off', visitor: null, rooms: [], chats: {}, colours: {}, colourSave: null });
  voice.end();
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

export async function boot(): Promise<void> {
  const epoch = ++session;
  resetColourRequests();
  setState({ visitor: null, rooms: [], chats: {}, colours: {}, colourSave: null });
  const fragment = new URLSearchParams(location.hash.slice(1));
  const secret = fragment.get('k');
  if (secret) {
    linkSecret = secret;
    // Out of the address bar and the history at once.
    history.replaceState(null, '', location.pathname + location.search);
  }
  live.stop();
  voice.end();
  try {
    const visitor = await api.me();
    if (epoch === session) await startWith(visitor, epoch);
  } catch (err) {
    if (epoch !== session) return;
    if (err instanceof ApiError && err.status === 401) {
      setState({ phase: linkSecret ? 'entry' : getState().phase === 'revoked' ? 'revoked' : 'noaccess' });
      return;
    }
    // Server unreachable: try again rather than pretend access is gone.
    setTimeout(() => void boot(), 3000);
  }
}

/** Tries to enter; answers the reason for the person, or null when in. */
export async function enter(name: string): Promise<string | null> {
  if (!linkSecret) return t.errors.invalid_link;
  try {
    const visitor = await api.enter(linkSecret, name);
    linkSecret = null;
    await startWith(visitor, ++session);
    return null;
  } catch (err) {
    const code = err instanceof ApiError ? err.code : 'other';
    if (code === 'invalid_link' || code === 'name_taken' || code === 'invalid_name' || code === 'rate_limited' || code === 'network') return t.errors[code];
    return t.errors.other;
  }
}

async function startWith(visitor: Visitor, epoch: number): Promise<void> {
  const rooms = await api.rooms();
  if (epoch !== session) return;
  const remembered = prefs.viewedRoom();
  const viewedRoomId = rooms.some((r) => r.id === remembered) ? remembered : (rooms[0]?.id ?? null);
  setState({ phase: 'ready', visitor, rooms, viewedRoomId, chats: Object.fromEntries(rooms.map((r) => [r.id, emptyChat()])), live: visitor.nameTaken ? 'off' : 'reconnecting' });
  mergeColours([visitor.colour]);
  await Promise.all([refreshColours(), ...rooms.map(loadChat)]);
  if (epoch === session && !visitor.nameTaken) live.start();
}

async function refreshMe(): Promise<void> {
  const epoch = session;
  try {
    const visitor = await api.me();
    if (epoch === session) acceptVisitor(visitor);
  } catch (err) {
    if (epoch === session) accessEnded(err);
  }
}

/** Renames; answers the reason for the person, or null when done. */
export async function rename(name: string): Promise<string | null> {
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
    case 'access.revoked':
      endAccess();
      break;
  }
}

/** After any disconnection: events are not replayed, so read what was missed. */
async function catchUp(): Promise<void> {
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
  const pending: PendingMessage = { requestKey: crypto.randomUUID(), roomId, body, failed: false, reason: '' };
  patchChat(roomId, (c) => ({ pending: [...c.pending, pending] }));
  void send(pending);
}

/** Sending again under the same key can never post it twice. */
export function retryMessage(p: PendingMessage): void {
  patchChat(p.roomId, (c) => ({ pending: c.pending.map((x) => (x.requestKey === p.requestKey ? { ...x, failed: false, reason: '' } : x)) }));
  void send(p);
}

export function discardMessage(p: PendingMessage): void {
  patchChat(p.roomId, (c) => ({ pending: c.pending.filter((x) => x.requestKey !== p.requestKey) }));
}

async function send(p: PendingMessage): Promise<void> {
  const epoch = session;
  try {
    const message = await api.post(p.roomId, p.requestKey, p.body);
    if (epoch !== session) return;
    patchChat(p.roomId, (c) => ({ pending: c.pending.filter((x) => x.requestKey !== p.requestKey), messages: mergeMessages(c.messages, [message]) }));
    syncRead(p.roomId);
  } catch (err) {
    if (epoch !== session || accessEnded(err)) return;
    const code = err instanceof ApiError ? err.code : 'other';
    const reason = code === 'rate_limited' ? t.errors.postRateLimited : code === 'network' ? t.errors.postNetwork : t.errors.postOther;
    patchChat(p.roomId, (c) => ({ pending: c.pending.map((x) => (x.requestKey === p.requestKey ? { ...x, failed: true, reason } : x)) }));
  }
}

function notifyOfMessage(m: Message): void {
  const s = getState();
  if (!s.settings.notifications || m.authorId === s.visitor?.id || document.visibilityState === 'visible') return;
  if (notificationPermission() !== 'granted') return;
  const room = s.rooms.find((r) => r.id === m.roomId)?.name ?? '';
  notify(`${m.authorName} · ${room}`, { body: m.body.slice(0, 160), tag: m.roomId }, () => {
    window.focus();
    viewRoom(m.roomId);
    setChatOpen(true);
  });
}

/* ---------- Navigation ---------- */

export function viewRoom(roomId: string): void {
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
  if (reading(roomId)) markRead(roomId);
}

export function setChatOpen(open: boolean): void {
  const s = getState();
  setState({ chatOpen: open, newAfterId: open ? s.newAfterId : null });
  if (open && s.viewedRoomId) openReading(s.viewedRoomId);
}

document.addEventListener('visibilitychange', () => {
  const s = getState();
  if (document.visibilityState === 'visible' && s.chatOpen && s.viewedRoomId) syncRead(s.viewedRoomId);
});

/* ---------- Settings ---------- */

/** A swatch requests that exact palette. The confirmed map never changes optimistically. */
export async function setVisitorColour(palette: PaletteName): Promise<void> {
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

export function setParticipantVolume(visitorId: string, value: number): void {
  prefs.setVolume(visitorId, value);
  voice.applyVolumes();
}
