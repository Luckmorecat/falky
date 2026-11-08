import type { components } from './schema.gen';

type Schemas = components['schemas'];
export type Visitor = Schemas['Visitor'];
export type VisitorColour = Schemas['VisitorColour'];
export type Room = Schemas['Room'];
export type Participant = Schemas['Participant'];
export type Message = Schemas['Message'];
export type VoiceCredentials = Schemas['VoiceCredentials'];
export type RoomChange = Schemas['RoomChange'];
export type OccupancyChange = Schemas['OccupancyChange'];
export type AccessRevoked = Schemas['AccessRevoked'];

/** A live update, narrowed by its type. Unknown types are ignored by callers. */
export type LiveEvent = { eventId: string; timestamp: string; roomId?: string } & (
  | { type: 'message.created'; payload: Message }
  | { type: 'room.changed'; payload: RoomChange }
  | { type: 'occupancy.changed'; payload: OccupancyChange }
  | { type: 'access.revoked'; payload: AccessRevoked }
  | { type: 'visitor.colour.changed'; payload: VisitorColour }
);

/** A refused or failed request. `code` is the contract's error code, or `network`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', 'the server cannot be reached');
  }
  if (res.ok) return (await res.json()) as T;
  let code = 'internal';
  let message = res.statusText;
  try {
    const err = (await res.json()) as Schemas['Error'];
    code = err.code;
    message = err.message;
  } catch {
    // A proxy's error page instead of the contract's body.
  }
  throw new ApiError(res.status, code, message);
}

export const api = {
  enter: (secret: string, name: string) => call<Visitor>('POST', '/api/enter', { secret, name }),
  me: () => call<Visitor>('GET', '/api/me'),
  rename: (name: string) => call<Visitor>('PATCH', '/api/me', { name }),
  setColour: (palette: Schemas['PaletteName']) => call<VisitorColour>('PUT', '/api/me/colour', { palette }),
  colours: (visitorIds: string[]) => call<Schemas['VisitorColourList']>('POST', '/api/visitor-colours', { visitorIds }).then((r) => r.colours),
  rooms: () => call<Schemas['RoomList']>('GET', '/api/rooms').then((r) => r.rooms),
  /** Newest first with `before` or neither; oldest first with `after`. */
  messages: (roomId: string, q: { before?: string; after?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (q.before) params.set('before', q.before);
    if (q.after) params.set('after', q.after);
    if (q.limit) params.set('limit', String(q.limit));
    const qs = params.size ? `?${params}` : '';
    return call<Schemas['MessageList']>('GET', `/api/rooms/${encodeURIComponent(roomId)}/messages${qs}`).then((r) => r.messages);
  },
  post: (roomId: string, requestKey: string, body: string) =>
    call<Message>('POST', `/api/rooms/${encodeURIComponent(roomId)}/messages`, { requestKey, body }),
  joinVoice: (roomId: string) => call<VoiceCredentials>('POST', `/api/rooms/${encodeURIComponent(roomId)}/voice`),
};
