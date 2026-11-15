import { afterEach, describe, expect, it } from 'vitest';
import { allowReaction, emitReaction, encodeReaction, onReaction, parseReaction, resetReactions } from './reactions';

afterEach(resetReactions);

describe('reaction attribute', () => {
  it('reads back what it encodes, whatever the counter', () => {
    expect(parseReaction(encodeReaction('fire', 1))).toBe('fire');
    expect(parseReaction(encodeReaction('fire', 2))).toBe('fire');
  });

  it('ignores anything outside the list', () => {
    expect(parseReaction(undefined)).toBeNull();
    expect(parseReaction('')).toBeNull();
    expect(parseReaction('<img src=x>:1')).toBeNull();
    expect(parseReaction('constructor:1')).toBeNull();
  });
});

describe('emitReaction', () => {
  it('reaches listeners with the sender', () => {
    const seen: string[] = [];
    const off = onReaction((from, id) => seen.push(`${from} ${id}`));
    emitReaction('a', 'up', 0);
    off();
    emitReaction('a', 'up', 10_000);
    expect(seen).toEqual(['a up']);
  });
});

describe('allowReaction', () => {
  it('lets a short burst through, stops a flood, and recovers', () => {
    const burst = [0, 100, 200, 300, 400].map((at) => allowReaction('a', at));
    expect(burst).toEqual([true, true, true, true, true]);
    expect(allowReaction('a', 500)).toBe(false);
    expect(allowReaction('b', 500)).toBe(true);
    expect(allowReaction('a', 2100)).toBe(true);
  });
});
