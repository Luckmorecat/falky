import type { BoardSound } from './sounds';

/** The reactions anyone in voice can send; anything else that arrives is ignored. Every one pops; the last ones play a meme to the room. */
export const REACTIONS = [
  { id: 'up', emoji: '👍' },
  { id: 'heart', emoji: '❤️' },
  { id: 'laugh', emoji: '😂' },
  { id: 'wow', emoji: '😮' },
  { id: 'fire', emoji: '🔥' },
  { id: 'clap', emoji: '👏' },
  { id: 'boom', emoji: '💥', sound: 'boom' },
  { id: 'airhorn', emoji: '📢', sound: 'airhorn' },
  { id: 'sad', emoji: '🎺', sound: 'sad' },
  { id: 'pipe', emoji: '🔩', sound: 'pipe' },
  { id: 'dun', emoji: '😱', sound: 'dun' },
  { id: 'bonk', emoji: '🔨', sound: 'bonk' },
] as const satisfies readonly { id: string; emoji: string; sound?: BoardSound }[];

export type ReactionId = (typeof REACTIONS)[number]['id'];

/** What the number keys send, in order; the sounds are only a click away. */
export const EMOJI_REACTIONS = REACTIONS.filter((r) => !('sound' in r));
export const SOUND_REACTIONS = REACTIONS.filter((r) => 'sound' in r);

/**
 * Data messages are not granted, so a reaction travels as the sender's own
 * participant attribute. The counter makes a repeat of the same reaction a change.
 */
export const REACTION_ATTRIBUTE = 'reaction';

export function encodeReaction(id: ReactionId, seq: number): string {
  return `${id}:${seq}`;
}

export function parseReaction(value: string | undefined): ReactionId | null {
  const id = value?.split(':')[0];
  return REACTIONS.some((r) => r.id === id) ? id as ReactionId : null;
}

export function emojiOf(id: ReactionId): string {
  return REACTIONS.find((r) => r.id === id)!.emoji;
}

export function soundOf(id: ReactionId): BoardSound | null {
  const reaction = REACTIONS.find((r) => r.id === id);
  return reaction && 'sound' in reaction ? reaction.sound : null;
}

/** How high an emoji's pop goes, from 0 to 1, so that each one sounds like itself. */
export function popPitch(id: ReactionId): number {
  const i = EMOJI_REACTIONS.findIndex((r) => r.id === id);
  return i < 0 ? 0.5 : i / (EMOJI_REACTIONS.length - 1);
}

type Listener = (from: string, id: ReactionId) => void;
const listeners = new Set<Listener>();

export function onReaction(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Mashing a button is the point, as on a soundboard; past this many in the window it is a flood. */
const BURST = 12;
const BURST_WINDOW = 2000;

/** Recent reaction times by connection, for allowReaction. */
const recent = new Map<string, number[]>();

/**
 * Whether a reaction from this connection may show now. It guards both what
 * this client sends and what others send it, since a modified client can send
 * as fast as LiveKit lets it.
 */
export function allowReaction(from: string, now: number): boolean {
  const times = (recent.get(from) ?? []).filter((at) => now - at < BURST_WINDOW);
  const allowed = times.length < BURST;
  if (allowed) times.push(now);
  if (times.length) recent.set(from, times);
  else recent.delete(from);
  return allowed;
}

/** Shows a reaction on the sender's orb if it passes the limit; reports whether it did. */
export function emitReaction(from: string, id: ReactionId, now = performance.now()): boolean {
  if (!allowReaction(from, now)) return false;
  for (const listener of listeners) listener(from, id);
  return true;
}

export function resetReactions(): void {
  recent.clear();
}
