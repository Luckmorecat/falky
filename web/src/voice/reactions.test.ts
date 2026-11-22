import { afterEach, describe, expect, it } from 'vitest';
import { allowReaction, emitReaction, popPitch, soundOf, encodeReaction, onReaction, parseReaction, resetReactions } from './reactions';

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
    const burst = Array.from({ length: 12 }, (_, i) => allowReaction('a', i * 100));
    expect(burst.every(Boolean)).toBe(true);
    expect(allowReaction('a', 1250)).toBe(false);
    expect(allowReaction('b', 1250)).toBe(true);
    expect(allowReaction('a', 2100)).toBe(true);
  });
});

describe('board sounds', () => {
  it('belong only to the sound reactions', () => {
    expect(soundOf('airhorn')).toBe('airhorn');
    expect(soundOf('up')).toBeNull();
  });

  it('give every emoji a pop of its own pitch', () => {
    expect(popPitch('up')).toBe(0);
    expect(popPitch('clap')).toBe(1);
    expect(popPitch('heart')).toBeGreaterThan(0);
  });
});
