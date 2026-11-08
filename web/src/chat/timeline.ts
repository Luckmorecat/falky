import type { Attachment, Message } from '../api/client';
import { t } from '../strings';

/** A message on its way to the server, shown until the server has it. */
export interface PendingMessage {
  requestKey: string;
  roomId: string;
  body: string;
  /** Drafts already on the server, in order; shown from the person's own copies while sending. */
  attachments: Attachment[];
  failed: boolean;
  /** Why it failed, for the person; empty while sending. */
  reason: string;
}

/** A picture in the composer: on its way up, ready to go with the message, or refused. */
export interface ComposerUpload {
  localId: string;
  roomId: string;
  name: string;
  size: number;
  /** The person's own copy, shown at once and kept for the sent message. */
  previewUrl: string;
  status: 'uploading' | 'ready' | 'failed';
  /** 0..1 of the bytes sent. */
  progress: number;
  attachment?: Attachment;
  /** Why it failed, for the person. */
  reason: string;
}

export interface RoomChat {
  /** Oldest first, one per ID. */
  messages: Message[];
  pending: PendingMessage[];
  /** Whether the server may have messages older than the first here. */
  hasOlder: boolean;
  loadingOlder: boolean;
  /** Whether the first page has arrived. */
  loaded: boolean;
  /** Messages from others since the person last read this room. */
  unread: number;
}

export const emptyChat = (): RoomChat => ({ messages: [], pending: [], hasOlder: false, loadingOlder: false, loaded: false, unread: 0 });

/** Adds messages to a list, keeping one per ID in posting order. IDs sort as posted. */
export function mergeMessages(list: Message[], incoming: Message[]): Message[] {
  if (!incoming.length) return list;
  const byId = new Map(list.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function countUnread(messages: Message[], lastReadId: string | null, selfId: string | undefined): number {
  return messages.filter((m) => m.authorId !== selfId && (lastReadId === null || m.id > lastReadId)).length;
}

export type FeedItem =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'new'; key: string }
  | { kind: 'message'; key: string; message: Message; continued: boolean }
  | { kind: 'pending'; key: string; pending: PendingMessage; continued: boolean };

const GROUP_WINDOW_MS = 5 * 60_000;

/** Says "today" and "yesterday" as such, and any other day by its date. */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days === 0) return t.today;
  if (days === 1) return t.yesterday;
  return d.toLocaleDateString(t.locale, { day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

/**
 * Lays out a room's chat: day separators, the "new messages" line after
 * `newAfterId`, and which messages continue their author's previous one.
 */
export function buildFeed(chat: Pick<RoomChat, 'messages' | 'pending'>, selfId: string | undefined, newAfterId: string | null, now: Date = new Date()): FeedItem[] {
  const items: FeedItem[] = [];
  let lastDay = '';
  let prev: Message | null = null;
  let newShown = newAfterId === null;
  for (const m of chat.messages) {
    const day = dayLabel(m.createdAt, now);
    if (day !== lastDay) {
      items.push({ kind: 'day', key: `day-${day}`, label: day });
      lastDay = day;
      prev = null;
    }
    if (!newShown && newAfterId !== null && m.id > newAfterId) {
      newShown = true;
      items.push({ kind: 'new', key: 'new-line' });
      prev = null;
    }
    const continued = prev !== null && prev.authorId === m.authorId && prev.authorName === m.authorName
      && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < GROUP_WINDOW_MS;
    items.push({ kind: 'message', key: m.id, message: m, continued });
    prev = m;
  }
  chat.pending.forEach((p, i) => {
    const continued = i > 0 || (prev !== null && prev.authorId === selfId);
    items.push({ kind: 'pending', key: p.requestKey, pending: p, continued });
  });
  return items;
}

export type TextPart = { text: string; href?: string };

/** Splits text into plain parts and http(s) links; nothing else becomes a link. */
export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  const re = /https?:\/\/[^\s<>"]+/gi;
  let at = 0;
  for (const match of text.matchAll(re)) {
    let url = match[0];
    // Punctuation closing a sentence belongs to the sentence.
    const trail = /[.,;:!?)\]}'»]+$/.exec(url);
    if (trail) {
      const body = url.slice(0, -trail[0].length);
      // A closing bracket stays when the link opened one, as in Wikipedia's.
      url = trail[0].startsWith(')') && body.includes('(') ? url : body;
    }
    const start = match.index;
    if (start > at) parts.push({ text: text.slice(at, start) });
    parts.push({ text: url, href: url });
    at = start + url.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

/** A body the server would accept; it counts characters, not UTF-16 units. */
export const MESSAGE_MAX = 4000;
export const messageLength = (s: string): number => [...s].length;
/** Text, pictures or both; pictures alone need no words. */
export const canPost = (s: string, attachments = 0): boolean => (s.trim().length > 0 || attachments > 0) && messageLength(s) <= MESSAGE_MAX;
