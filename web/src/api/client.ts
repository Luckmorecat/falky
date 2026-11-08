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
export type Attachment = Schemas['Attachment'];
export type AttachmentsExpired = Schemas['AttachmentsExpired'];

/** A live update, narrowed by its type. Unknown types are ignored by callers. */
export type LiveEvent = { eventId: string; timestamp: string; roomId?: string } & (
  | { type: 'message.created'; payload: Message }
  | { type: 'attachments.expired'; payload: AttachmentsExpired }
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
  if (res.status === 204) return undefined as T;
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

async function failure(status: number, statusText: string, text: string): Promise<ApiError> {
  try {
    const err = JSON.parse(text) as Schemas['Error'];
    return new ApiError(status, err.code, err.message);
  } catch {
    return new ApiError(status, 'internal', statusText);
  }
}

/**
 * Sends one file as a private draft. XHR rather than fetch, because only XHR
 * tells how much of the body has gone; `onProgress` gets 0..1.
 */
function uploadAttachment(roomId: string, file: File, onProgress: (sent: number) => void, signal?: AbortSignal): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append('file', file, file.name);
    xhr.open('POST', `/api/rooms/${encodeURIComponent(roomId)}/attachments`);
    xhr.responseType = 'text';
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText) as Attachment); } catch { reject(new ApiError(xhr.status, 'internal', 'Bad upload response')); }
      } else void failure(xhr.status, xhr.statusText, xhr.responseText).then(reject);
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', 'the server cannot be reached'));
    xhr.ontimeout = () => reject(new ApiError(408, 'upload_timeout', 'Upload took too long'));
    xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Upload cancelled'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(form);
  });
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
  post: (roomId: string, requestKey: string, body: string, attachmentIds: string[] = []) =>
    call<Message>('POST', `/api/rooms/${encodeURIComponent(roomId)}/messages`, { requestKey, body, ...(attachmentIds.length ? { attachmentIds } : {}) }),
  attachmentLimits: () => call<Schemas['AttachmentLimits']>('GET', '/api/attachments/limits'),
  attachment: (id: string) => call<Attachment>('GET', `/api/attachments/${encodeURIComponent(id)}`),
  cancelAttachment: (id: string) => call<void>('DELETE', `/api/attachments/${encodeURIComponent(id)}`),
  upload: uploadAttachment,
  joinVoice: (roomId: string) => call<VoiceCredentials>('POST', `/api/rooms/${encodeURIComponent(roomId)}/voice`),
};
