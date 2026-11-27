import type { MessageReaction } from '../api/client';

/** The reactions a chat message can be given, in the contract's order. */
export const MESSAGE_REACTIONS: { id: MessageReaction; emoji: string }[] = [
  { id: 'up', emoji: '👍' },
  { id: 'heart', emoji: '❤️' },
  { id: 'laugh', emoji: '😂' },
  { id: 'wow', emoji: '😮' },
  { id: 'fire', emoji: '🔥' },
  { id: 'clap', emoji: '👏' },
];

export const emojiFor = (id: MessageReaction) => MESSAGE_REACTIONS.find((r) => r.id === id)?.emoji ?? '';
