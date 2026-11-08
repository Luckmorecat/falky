import { randomBytes, randomInt } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { attachmentLimits, fixtureImage, newAttachmentId, parseMultipart, sniffImage, type StoredAttachment } from './attachments.ts';
import { scenarios, type MockState, type Scenario, type Schema } from './protocol.ts';

const palettes: Schema['PaletteName'][] = ['sky', 'apricot', 'lagoon', 'rose', 'violet', 'amber', 'moss', 'coral', 'indigo', 'plum', 'sunset', 'aurora', 'lime', 'clay', 'ocean', 'ruby'];
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const validId = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
function encodeId(value: bigint) {
  let text = '';
  for (let i = 0; i < 26; i++) { text = alphabet[Number(value & 31n)] + text; value >>= 5n; }
  return text;
}
class Refused extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function rawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new Refused(413, 'attachment_too_large', 'The file is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Refused(400, 'invalid_request', 'JSON body required');
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 64 * 1024) throw new Refused(400, 'invalid_request', 'Request too large');
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new Refused(400, 'invalid_request', 'Invalid JSON object'); }
}
function scenarioName(value: unknown): Scenario {
  if (!scenarios.includes(value as Scenario)) throw new Refused(400, 'invalid_request', 'Unknown scenario');
  return value as Scenario;
}

/** One process-memory visitor, isolated even when browsers share cookies across ports. */
export async function startMockServer(options: { port?: number; scenario?: string } = {}) {
  const instanceId = randomBytes(8).toString('hex');
  const cookieName = `falky_mock_${instanceId}`;
  let token = randomBytes(24).toString('hex');
  let sequence = BigInt('0x' + randomBytes(10).toString('hex'));
  const id = () => encodeId((BigInt(Date.now()) << 80n) + sequence++);
  const roomIds = [id(), id(), id()];
  const colours = new Map<string, Schema['VisitorColour']>();
  function assignColour(visitorId: string): Schema['VisitorColour'] {
    const existing = colours.get(visitorId);
    if (existing) return existing;
    const unused = palettes.filter((palette) => ![...colours.values()].some((c) => c.palette === palette));
    const connected = new Set(Object.values(state.peers).flat().map((peer) => peer.visitorId));
    if (state.visitor && sockets.clients.size) connected.add(state.visitor.id);
    const uses = palettes.map((palette) => [...connected].filter((id) => colours.get(id)?.palette === palette).length);
    const minimum = Math.min(...uses);
    const choices = unused.length ? unused : palettes.filter((_, i) => uses[i] === minimum);
    const colour = { visitorId, palette: choices[randomInt(choices.length)]!, revision: 1 };
    colours.set(visitorId, colour);
    return colour;
  }
  function visitor(name: string): Schema['Visitor'] {
    const visitorId = id();
    return { id: visitorId, name, nameTaken: false, colour: assignColour(visitorId) };
  }
  const messages = new Map<string, Schema['Message'][]>();
  const attachments = new Map<string, StoredAttachment>();
  function storeAttachment(roomId: string, ownerId: string, filename: string, data: Buffer, availability: Schema['Attachment']['availability']): Schema['Attachment'] {
    const sniffed = sniffImage(data);
    const attachmentId = newAttachmentId();
    const meta: Schema['Attachment'] = {
      id: attachmentId, filename, contentType: sniffed?.contentType ?? 'application/octet-stream', size: data.length,
      inline: !!sniffed && sniffed.contentType !== 'image/gif', width: sniffed?.width ?? 0, height: sniffed?.height ?? 0, availability,
      contentUrl: `/api/attachments/${attachmentId}/content`,
      ...(availability === 'ready' ? { expiresAt: new Date(Date.now() + attachmentLimits.draftTtlSeconds * 1000).toISOString() } : {}),
    };
    attachments.set(attachmentId, { meta, roomId, ownerId, data });
    return meta;
  }
  /** Generated pictures posted by someone else, as fixtures and the message action post them. */
  function fixtureAttachments(roomId: string, ownerId: string, count: number, seed: number): Schema['Attachment'][] {
    const sizes = [[1600, 1200], [1080, 1440], [1400, 1400], [2400, 1000], [1200, 900], [900, 1600]];
    return Array.from({ length: count }, (_, i) => {
      const [w, h] = sizes[(seed + i) % sizes.length]!;
      return storeAttachment(roomId, ownerId, `photo-${seed + i}.svg`, fixtureImage(seed + i, w!, h!), 'posted');
    });
  }
  const state: MockState = {
    instanceId, generation: 1, revision: 1, scenario: scenarioName(options.scenario ?? 'populated'), scenarios,
    visitor: null, voiceRoomId: null,
    rooms: roomIds.map((roomId, i) => ({ id: roomId, name: ['Lounge', 'Games', 'Quiet'][i]!, occupancy: [] })),
    peers: {}, faults: { send: 'none', colourSave: 'none', colourDelayMs: 0, colourResponseDelayMs: 0, delayMs: 0, liveDisconnected: false, roomFull: null, micDenied: false, shareFailure: false, voiceReconnecting: false },
    accessLink: '/#k=mock-access-link',
  };
  if (state.scenario === 'entry') state.visitor = null;
  const sam = { visitorId: id(), name: 'Sam', muted: false, deafened: false, sharing: state.scenario === 'remote-share' };
  state.peers[roomIds[0]!] = [sam, { visitorId: id(), name: 'Robin', muted: true, deafened: false, sharing: false }];
  state.rooms[0]!.occupancy = state.peers[roomIds[0]!]!.map(({ visitorId, name }) => ({ visitorId, name }));
  let conflictName: string | null = null;
  let accessSecret = 'mock-access-link';
  const requests = new Map<string, Schema['Message']>();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });
  function publish(type: Schema['EventType'], payload: Schema['Event']['payload'], roomId?: string) {
    const event: Schema['Event'] = { v: 1, type, eventId: id(), payload, timestamp: new Date().toISOString(), ...(roomId ? { roomId } : {}) };
    for (const socket of sockets.clients) {
      if (socket.bufferedAmount > 1024 * 1024) socket.close(4000, 'Event queue full');
      else if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
    }
  }
  function changeColour(visitorId: string, palette: unknown): Schema['VisitorColour'] {
    if (!palettes.includes(palette as Schema['PaletteName'])) throw new Refused(400, 'invalid_palette', 'Unknown palette');
    const current = colours.get(visitorId)!;
    const colour = { visitorId, palette: palette as Schema['PaletteName'], revision: current.revision + 1 };
    colours.set(visitorId, colour);
    if (state.visitor?.id === visitorId) state.visitor.colour = colour;
    publish('visitor.colour.changed', colour);
    return colour;
  }
  function occupancy() {
    for (const room of state.rooms) {
      const next = (state.peers[room.id] ?? []).map(({ visitorId, name }) => ({ visitorId, name }));
      if (state.voiceRoomId === room.id && state.visitor) next.push({ visitorId: state.visitor.id, name: state.visitor.name });
      if (JSON.stringify(next) !== JSON.stringify(room.occupancy)) {
        room.occupancy = next;
        publish('occupancy.changed', { roomId: room.id, occupancy: next }, room.id);
      }
    }
  }
  function authenticated(req: IncomingMessage) {
    return !!state.visitor && req.headers.cookie?.split(';').some((part) => part.trim() === `${cookieName}=${token}`);
  }
  function setCookie(res: ServerResponse) { res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/api; HttpOnly; SameSite=Strict`); }
  function name(input: unknown) {
    if (input === undefined) throw new Refused(400, 'invalid_name', 'A name is required');
    if (typeof input !== 'string') throw new Refused(400, 'invalid_request', 'Name must be a string');
    const trimmed = input.trim();
    if (!trimmed || [...trimmed].length > 32 || /[\p{Cc}\p{Cf}]/u.test(trimmed)) throw new Refused(400, 'invalid_name', 'Name must have 1–32 characters and no controls');
    if (conflictName === trimmed.toLowerCase()) throw new Refused(409, 'name_taken', 'That name is held by another visitor');
    if (Object.values(state.peers).flat().some((peer) => peer.name.trim().toLowerCase() === trimmed.toLowerCase())) throw new Refused(409, 'name_taken', 'That name is held by another visitor');
    return trimmed;
  }
  for (const room of state.rooms) messages.set(room.id, []);
  // The same two people throughout, as in a real room; their IDs are the ones they hold in voice.
  const historyAuthors = state.peers[roomIds[0]!]!;
  for (let i = 1; i <= 125; i++) {
    const author = historyAuthors[i % 2]!;
    messages.get(roomIds[0]!)!.push({ id: id(), roomId: roomIds[0]!, authorId: author.visitorId, authorName: author.name,
      body: i === 125 ? 'Welcome back! Try sending a message or joining voice.' : `Lounge history ${i}`,
      attachments: i === 118 ? fixtureAttachments(roomIds[0]!, author.visitorId, 1, 1)
        : i === 121 ? fixtureAttachments(roomIds[0]!, author.visitorId, 2, 3)
          : i === 123 ? fixtureAttachments(roomIds[0]!, author.visitorId, 3, 7)
            : i === 124 ? fixtureAttachments(roomIds[0]!, author.visitorId, 4, 11) : [],
      createdAt: new Date().toISOString() });
    // Pictures alone need no words.
    if (i === 124) messages.get(roomIds[0]!)!.at(-1)!.body = '';
  }
  const fixtureMessages = structuredClone(messages);
  const fixtureAttachmentIds = new Set(attachments.keys());
  const fixturePeers = structuredClone(state.peers);
  let publicOrigin = '';
  function seed(scenario: Scenario) {
    state.scenario = scenario;
    colours.clear();
    for (const history of fixtureMessages.values()) for (const message of history) assignColour(message.authorId);
    state.visitor = scenario === 'entry' ? null : visitor('Alex');
    state.voiceRoomId = null;
    state.peers = scenario === 'quiet' ? {} : structuredClone(fixturePeers);
    for (const peers of Object.values(state.peers)) for (const peer of peers) peer.sharing = scenario === 'remote-share' && peer.name === 'Sam';
    messages.clear();
    for (const [roomId, history] of fixtureMessages) messages.set(roomId, scenario === 'quiet' ? [] : structuredClone(history));
    for (const [attachmentId, stored] of attachments) {
      if (fixtureAttachmentIds.has(attachmentId)) stored.meta.availability = 'posted';
      else attachments.delete(attachmentId);
    }
    for (const room of state.rooms) room.occupancy = (state.peers[room.id] ?? []).map(({ visitorId, name }) => ({ visitorId, name }));
    state.faults = { send: 'none', colourSave: 'none', colourDelayMs: 0, colourResponseDelayMs: 0, delayMs: 0, liveDisconnected: false, roomFull: null, micDenied: false, shareFailure: false, voiceReconnecting: false };
    requests.clear();
    conflictName = null;
    accessSecret = 'mock-access-link';
    state.accessLink = `${publicOrigin}/#k=${accessSecret}`;
    token = randomBytes(24).toString('hex');
  }
  function reset(scenario: Scenario) {
    state.generation++;
    state.revision++;
    for (const socket of sockets.clients) socket.close(4000, 'Mock reset');
    seed(scenario);
  }
  seed(state.scenario);
  const ownOrigins = new Set<string>();
  const server = createServer((req, res) => { void handle(req, res).catch((error: unknown) => {
    const failure = error instanceof Refused ? error : new Refused(500, 'internal', 'Mock request failed');
    json(res, failure.status, { code: failure.code, message: failure.message } satisfies Schema['Error']);
  }); });
  server.on('upgrade', (req, socket, head) => {
    let status = 0;
    if (!ownOrigins.has(`http://${req.headers.host}`) || req.headers.origin !== publicOrigin) status = 403;
    else if (req.url !== '/api/live') status = 404;
    else if (!authenticated(req)) status = 401;
    else if (state.visitor?.nameTaken) status = 409;
    else if (state.faults.liveDisconnected) status = 503;
    if (status) { socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\n\r\n`); return; }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => {});
      let timeout: ReturnType<typeof setTimeout> | undefined;
      ws.on('pong', () => { clearTimeout(timeout); timeout = undefined; });
      const ping = setInterval(() => {
        ws.ping();
        timeout = setTimeout(() => ws.terminate(), 10_000);
      }, 20_000);
      ws.on('close', () => { clearInterval(ping); clearTimeout(timeout); });
    });
  });
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!ownOrigins.has(`http://${req.headers.host}`) || (req.headers.origin && !ownOrigins.has(req.headers.origin))) {
      throw new Refused(403, 'origin_forbidden', 'Only the local mock origins are allowed');
    }
    const generation = state.generation;
    const hasBody = req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) > 0;
    const multipart = req.headers['content-type']?.startsWith('multipart/form-data') ?? false;
    const input = (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') && hasBody && !multipart ? await body(req) : {};
    if (generation !== state.generation) throw new Refused(409, 'invalid_request', 'Mock generation changed');
    if (url.pathname === '/__mock/bootstrap' && req.method === 'POST') {
      if (input.scenario !== undefined && scenarioName(input.scenario) !== state.scenario) reset(scenarioName(input.scenario));
      setCookie(res);
      return json(res, 200, state);
    }
    if (url.pathname === '/__mock' && req.method === 'GET') return json(res, 200, {
      scenarios, endpoints: { bootstrap: 'POST /__mock/bootstrap {scenario?}', state: 'GET /__mock/state', reset: 'POST /__mock/reset {scenario?}', action: 'POST /__mock/action' },
      actions: ['colour', 'message', 'participants', 'faults', 'name-conflict', 'revoke', 'voice-leave', 'expire-attachments'],
      faults: state.faults,
      lifecycle: 'Same-scenario bootstrap preserves state. Reset advances generation; poll state independently of /api/live. Voice leave requires the current generation.',
    });
    if (url.pathname === '/__mock/state' && req.method === 'GET') return json(res, 200, state);
    if (url.pathname === '/__mock/reset' && req.method === 'POST') {
      reset(input.scenario === undefined ? state.scenario : scenarioName(input.scenario));
      setCookie(res);
      return json(res, 200, state);
    }
    if (url.pathname === '/__mock/action' && req.method === 'POST') {
      if (input.type === 'faults') {
        const faults = input.faults;
        if (!faults || typeof faults !== 'object' || Array.isArray(faults)) throw new Refused(400, 'invalid_request', 'Expected faults object');
        for (const [key, value] of Object.entries(faults)) {
          if (['delayMs', 'colourDelayMs', 'colourResponseDelayMs'].includes(key) && typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 30_000) state.faults[key as 'delayMs' | 'colourDelayMs' | 'colourResponseDelayMs'] = value;
          else if (key === 'colourSave' && ['none', 'fail'].includes(String(value))) state.faults.colourSave = value as MockState['faults']['colourSave'];
          else if (key === 'send' && ['none', 'fail', 'lost-response'].includes(String(value))) state.faults.send = value as MockState['faults']['send'];
          else if (key === 'roomFull' && (value === null || state.rooms.some((room) => room.id === value))) state.faults.roomFull = value as string | null;
          else if (['liveDisconnected', 'micDenied', 'shareFailure', 'voiceReconnecting'].includes(key) && typeof value === 'boolean') {
            state.faults[key as 'micDenied' | 'shareFailure' | 'voiceReconnecting' | 'liveDisconnected'] = value;
          } else throw new Refused(400, 'invalid_request', 'Invalid fault value');
        }
        if (state.faults.liveDisconnected) for (const socket of sockets.clients) socket.close(4000, 'Scripted disconnect');
      } else if (input.type === 'colour') {
        if (typeof input.visitorId !== 'string' || !colours.has(input.visitorId)) throw new Refused(404, 'not_found', 'Unknown visitor');
        changeColour(input.visitorId, input.palette);
      } else if (input.type === 'voice-leave') {
        if (input.generation !== state.generation) throw new Refused(409, 'invalid_request', 'Mock generation changed');
        state.voiceRoomId = null;
        occupancy();
      } else if (input.type === 'participants') {
        if (!state.rooms.some((room) => room.id === input.roomId)) throw new Refused(404, 'room_not_found', 'No such room');
        if (!Array.isArray(input.participants)) throw new Refused(400, 'invalid_request', 'Expected participants array');
        const peers = input.participants as unknown[];
        const ids = new Set<string>();
        for (const raw of peers) {
          const peer = raw as Record<string, unknown> | null;
          if (!peer || typeof peer.visitorId !== 'string' || !validId.test(peer.visitorId) || peer.visitorId === state.visitor?.id || ids.has(peer.visitorId) ||
            typeof peer.name !== 'string' || !peer.name.trim() || [...peer.name.trim()].length > 32 || /[\p{Cc}\p{Cf}]/u.test(peer.name) ||
            ['muted', 'deafened', 'sharing'].some((key) => typeof peer[key] !== 'boolean')) throw new Refused(400, 'invalid_request', 'Invalid scripted participant');
          ids.add(peer.visitorId);
          assignColour(peer.visitorId);
        }
        for (const room of state.rooms) state.peers[room.id] = (state.peers[room.id] ?? []).filter((peer) => !ids.has(peer.visitorId));
        state.peers[input.roomId as string] = peers.map((raw) => {
          const peer = raw as MockState['peers'][string][number];
          return { visitorId: peer.visitorId, name: peer.name.trim(), muted: peer.muted || peer.deafened, deafened: peer.deafened, sharing: peer.sharing };
        });
        occupancy();
      } else if (input.type === 'name-conflict') {
        if (typeof input.active !== 'boolean') throw new Refused(400, 'invalid_request', 'Expected active boolean');
        if (state.visitor) {
          conflictName = input.active ? state.visitor.name.toLowerCase() : null;
          state.visitor.nameTaken = input.active;
          if (input.active) {
            state.voiceRoomId = null;
            occupancy();
            for (const socket of sockets.clients) socket.close(4000, 'Name taken');
          }
        }
      } else if (input.type === 'revoke') {
        publish('access.revoked', { reason: 'link_replaced' });
        for (const socket of sockets.clients) socket.close(4001, 'Access revoked');
        state.visitor = null;
        state.voiceRoomId = null;
        token = randomBytes(24).toString('hex');
        accessSecret = `mock-access-${state.generation}-${state.revision}`;
        state.accessLink = `${publicOrigin}/#k=${accessSecret}`;
        requests.clear();
        occupancy();
      } else if (input.type === 'message') {
        const history = typeof input.roomId === 'string' ? messages.get(input.roomId) : undefined;
        if (!history) throw new Refused(404, 'room_not_found', 'No such room');
        const images = input.images === undefined ? 0 : Number(input.images);
        if (!Number.isInteger(images) || images < 0 || images > 4) throw new Refused(400, 'invalid_request', 'images must be 0–4');
        const text = input.body === undefined ? '' : input.body;
        if (typeof text !== 'string' || (!text.trim() && !images) || [...text].length > 4000) throw new Refused(400, 'invalid_message', 'Invalid message body');
        const authorName = typeof input.authorName === 'string' ? input.authorName : 'Sam';
        const author = Object.values(state.peers).flat().find((peer) => peer.name === authorName);
        const authorId = author?.visitorId ?? id();
        const message: Schema['Message'] = { id: id(), roomId: input.roomId as string, authorId, authorName, body: text,
          attachments: fixtureAttachments(input.roomId as string, authorId, images, randomInt(1000)), createdAt: new Date().toISOString() };
        assignColour(message.authorId);
        history.push(message);
        publish('message.created', message, message.roomId);
      } else if (input.type === 'expire-attachments') {
        if (!messages.has(input.roomId as string)) throw new Refused(404, 'room_not_found', 'No such room');
        const expired: string[] = [];
        for (const stored of attachments.values()) {
          if (stored.roomId === input.roomId && stored.meta.availability === 'posted') {
            stored.meta.availability = 'expired';
            expired.push(stored.meta.id);
          }
        }
        for (const message of messages.get(input.roomId as string)!) {
          message.attachments = message.attachments.map((a) => attachments.get(a.id)?.meta ?? a);
        }
        if (expired.length) publish('attachments.expired', { attachmentIds: expired }, input.roomId as string);
      } else throw new Refused(400, 'invalid_request', 'Unknown action');
      state.revision++;
      return json(res, 200, state);
    }
    if (!url.pathname.startsWith('/api/')) throw new Refused(404, 'not_found', 'No such mock route');
    const delayMs = state.faults.delayMs;
    if (delayMs) {
      state.faults.delayMs = 0;
      state.revision++;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (generation !== state.generation) throw new Refused(409, 'invalid_request', 'Mock generation changed');
    }
    if (url.pathname === '/api/enter' && req.method === 'POST') {
      if (input.secret !== accessSecret) throw new Refused(403, 'invalid_link', 'The access link is invalid');
      const chosen = name(input.name);
      state.voiceRoomId = null;
      for (const socket of sockets.clients) socket.close(4000, 'Visitor entered again');
      state.visitor = visitor(chosen);
      occupancy();
      requests.clear();
      token = randomBytes(24).toString('hex');
      setCookie(res);
      state.revision++;
      return json(res, 201, state.visitor);
    }
    if (!authenticated(req) || !state.visitor) throw new Refused(401, 'visitor_required', 'Enter through the access link');
    if (url.pathname === '/api/visitor-colours' && req.method === 'POST') {
      if (!Array.isArray(input.visitorIds) || input.visitorIds.length > 100 || input.visitorIds.some((id) => typeof id !== 'string')) throw new Refused(400, 'invalid_request', 'Expected at most 100 visitor IDs');
      return json(res, 200, { colours: [...new Set(input.visitorIds as string[])].flatMap((id) => colours.has(id) ? [colours.get(id)!] : []) } satisfies Schema['VisitorColourList']);
    }
    if (url.pathname === '/api/me/colour' && req.method === 'PUT') {
      if (!palettes.includes(input.palette as Schema['PaletteName'])) throw new Refused(400, 'invalid_palette', 'Unknown palette');
      const visitorId = state.visitor.id;
      const delay = state.faults.colourDelayMs;
      const responseDelay = state.faults.colourResponseDelayMs;
      const failure = state.faults.colourSave;
      state.faults.colourDelayMs = 0; state.faults.colourResponseDelayMs = 0; state.faults.colourSave = 'none';
      state.revision++;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (generation !== state.generation) throw new Refused(409, 'invalid_request', 'Mock generation changed');
      if (!authenticated(req) || state.visitor?.id !== visitorId) throw new Refused(401, 'visitor_required', 'Enter through the access link');
      if (failure === 'fail') throw new Refused(503, 'internal', 'Scripted colour save failure; retry the colour');
      const colour = changeColour(visitorId, input.palette);
      state.revision++;
      if (responseDelay) await new Promise((resolve) => setTimeout(resolve, responseDelay));
      return json(res, 200, colour);
    }
    if (url.pathname === '/api/me' && req.method === 'GET') return json(res, 200, state.visitor);
    if (url.pathname === '/api/me' && req.method === 'PATCH') {
      state.visitor.name = name(input.name);
      state.visitor.nameTaken = false;
      occupancy();
      state.revision++;
      return json(res, 200, state.visitor);
    }
    if (url.pathname === '/api/rooms' && req.method === 'GET') return json(res, 200, { rooms: state.rooms } satisfies Schema['RoomList']);
    const voice = /^\/api\/rooms\/([^/]+)\/voice$/.exec(url.pathname);
    if (voice && req.method === 'POST') {
      const roomId = voice[1]!;
      if (!state.rooms.some((room) => room.id === roomId)) throw new Refused(404, 'room_not_found', 'No such room');
      if (state.visitor.nameTaken) throw new Refused(409, 'name_taken', 'Rename before joining voice');
      if (state.faults.roomFull === roomId && state.voiceRoomId !== roomId) throw new Refused(409, 'room_full', 'The room is full');
      state.voiceRoomId = roomId;
      occupancy();
      state.revision++;
      // Syntactically JWT-shaped; consumed only by the dev-only voice adapter.
      const jwt = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      return json(res, 200, { url: publicOrigin.replace('http', 'ws') + '/rtc', token: `${jwt({ alg: 'none', typ: 'JWT' })}.${jwt({ sub: state.visitor.id, room: roomId, mock: true })}.mock` } satisfies Schema['VoiceCredentials']);
    }
    if (url.pathname === '/api/attachments/limits' && req.method === 'GET') return json(res, 200, attachmentLimits);
    const upload = /^\/api\/rooms\/([^/]+)\/attachments$/.exec(url.pathname);
    if (upload && req.method === 'POST') {
      if (!messages.has(upload[1]!)) throw new Refused(404, 'room_not_found', 'No such room');
      if (!multipart) throw new Refused(400, 'invalid_request', 'Multipart body required');
      const raw = await rawBody(req, attachmentLimits.maxFileBytes + attachmentLimits.multipartOverheadBytes);
      const part = parseMultipart(req.headers['content-type']!, raw);
      if (!part) throw new Refused(400, 'invalid_request', 'Expected one file part');
      if (part.data.length > attachmentLimits.maxFileBytes) throw new Refused(413, 'attachment_too_large', 'The file is too large');
      const owned = [...attachments.values()].filter((a) => a.ownerId === state.visitor!.id && a.meta.availability === 'ready');
      if (owned.length >= attachmentLimits.maxPending) throw new Refused(429, 'attachment_busy', 'Too many pending drafts');
      // Long enough to watch the progress on a fast machine.
      await new Promise((resolve) => setTimeout(resolve, 350));
      const sniffed = sniffImage(part.data);
      const filename = sniffed && sniffed.contentType !== 'image/gif' && sniffed.contentType !== 'image/svg+xml' ? part.filename.replace(/\.[^.]*$/, '') + '.webp' : part.filename;
      state.revision++;
      return json(res, 201, storeAttachment(upload[1]!, state.visitor.id, filename, part.data, 'ready'));
    }
    const attachmentRoute = /^\/api\/attachments\/([0-9a-f]{32})(\/content)?$/.exec(url.pathname);
    if (attachmentRoute) {
      const stored = attachments.get(attachmentRoute[1]!);
      const visible = stored && (stored.meta.availability === 'posted' || stored.meta.availability === 'expired' || stored.ownerId === state.visitor.id);
      if (!stored || !visible) throw new Refused(404, 'attachment_not_found', 'No such attachment');
      if (attachmentRoute[2] && req.method === 'GET') {
        if (stored.meta.availability === 'expired' || stored.meta.availability === 'cancelled') throw new Refused(410, 'attachment_expired', 'The attachment has expired');
        res.writeHead(200, { 'Content-Type': stored.meta.contentType, 'Content-Length': stored.data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': `${stored.meta.inline ? 'inline' : 'attachment'}; filename="${stored.meta.filename}"` });
        res.end(stored.data);
        return;
      }
      if (!attachmentRoute[2] && req.method === 'GET') return json(res, 200, stored.meta);
      if (!attachmentRoute[2] && req.method === 'DELETE') {
        if (stored.ownerId !== state.visitor.id || stored.meta.availability === 'posted' || stored.meta.availability === 'expired') throw new Refused(404, 'attachment_not_found', 'No such draft');
        stored.meta.availability = 'cancelled';
        res.writeHead(204).end();
        return;
      }
    }
    const match = /^\/api\/rooms\/([^/]+)\/messages$/.exec(url.pathname);
    if (match && req.method === 'POST') {
      const history = messages.get(match[1]!);
      if (!history) throw new Refused(404, 'room_not_found', 'No such room');
      if (typeof input.requestKey !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.requestKey)) throw new Refused(400, 'invalid_request', 'Invalid request key');
      if (input.body !== undefined && typeof input.body !== 'string') throw new Refused(400, 'invalid_request', 'Message body must be a string');
      const ids = input.attachmentIds === undefined ? [] : input.attachmentIds;
      if (!Array.isArray(ids) || ids.length > attachmentLimits.maxAttachments || ids.some((x) => typeof x !== 'string') || new Set(ids).size !== ids.length) throw new Refused(400, 'invalid_attachments', 'Invalid attachment IDs');
      const text = input.body ?? '';
      if (typeof text !== 'string' || (!text.trim() && !ids.length) || [...text].length > 4000) throw new Refused(400, 'invalid_message', 'Message must have text or attachments, and at most 4000 characters');
      const previous = requests.get(input.requestKey);
      if (previous) {
        if (previous.roomId !== match[1] || previous.body !== text || previous.attachments.map((a) => a.id).join() !== ids.join()) throw new Refused(409, 'request_key_reused', 'Request key was used for another message');
        return json(res, 200, previous);
      }
      const sendFault = state.faults.send;
      state.faults.send = 'none';
      if (sendFault === 'fail') { state.revision++; throw new Refused(503, 'internal', 'Scripted send failure; retry the message'); }
      const drafts = (ids as string[]).map((x) => attachments.get(x));
      if (drafts.some((d) => !d || d.ownerId !== state.visitor!.id || d.roomId !== match[1] || d.meta.availability !== 'ready')) throw new Refused(400, 'invalid_attachments', 'Unknown, foreign or used drafts');
      for (const d of drafts) {
        d!.meta.availability = 'posted';
        delete d!.meta.expiresAt;
      }
      const message: Schema['Message'] = { id: id(), roomId: match[1]!, authorId: state.visitor.id, authorName: state.visitor.name, body: text, attachments: drafts.map((d) => structuredClone(d!.meta)), createdAt: new Date().toISOString() };
      history.push(message);
      requests.set(input.requestKey, message);
      publish('message.created', message, message.roomId);
      state.revision++;
      if (sendFault === 'lost-response') { res.destroy(); return; }
      return json(res, 201, message);
    }
    if (match && req.method === 'GET') {
      const history = messages.get(match[1]!);
      if (!history) throw new Refused(404, 'room_not_found', 'No such room');
      const before = url.searchParams.get('before') || null;
      const after = url.searchParams.get('after') || null;
      const rawLimit = url.searchParams.get('limit') ?? '50';
      const limit = Number(rawLimit);
      if ((before && after) || (before && !validId.test(before)) || (after && !validId.test(after)) || !/^\d+$/.test(rawLimit) || limit < 1 || limit > 100) {
        throw new Refused(400, 'invalid_request', 'Invalid message cursor or limit');
      }
      const page = history.filter((message) => (!before || message.id < before) && (!after || message.id > after));
      if (!after) page.reverse();
      return json(res, 200, { messages: page.slice(0, limit) } satisfies Schema['MessageList']);
    }
    throw new Refused(404, 'not_found', 'No such mock route');
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ownOrigins.add(url);
  publicOrigin = url;
  return { url, setPublicOrigin(origin: string) { ownOrigins.add(origin); publicOrigin = origin; state.accessLink = `${publicOrigin}/#k=mock-access-link`; },
    close: () => new Promise<void>((resolve, reject) => { for (const socket of sockets.clients) { socket.close(1001, 'Mock shutdown'); socket.terminate(); } sockets.close(); server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}
