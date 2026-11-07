import { describe, expect, it } from 'vitest';
import { assignPalettes, ownPalette, PALETTE_NAMES, paletteOf, pickFavorite, roomPalette } from './palette';

describe('assignPalettes', () => {
  const ids = Array.from({ length: 8 }, (_, i) => `01JBX6Z8Q3M5W2K7R9T4V1C0D${i}`);

  it('gives everyone in a full room a different colour', () => {
    expect(new Set(assignPalettes(ids).values()).size).toBe(8);
  });

  it('decides the same whatever order a client sees people in', () => {
    const a = assignPalettes(ids);
    const b = assignPalettes([...ids].reverse());
    for (const id of ids) expect(a.get(id)).toBe(b.get(id));
  });

  it('still answers for more people than colours', () => {
    expect(assignPalettes(Array.from({ length: PALETTE_NAMES.length + 4 }, (_, i) => `id${i}`)).size).toBe(PALETTE_NAMES.length + 4);
  });

  it('keeps a lone visitor their own colour', () => {
    expect(assignPalettes([ids[0]!]).get(ids[0]!)).toBe(paletteOf(ids[0]!));
  });
});

describe('the palette', () => {
  it('has a different colour for each person in a full room, whatever the IDs', () => {
    const ids = Array.from({ length: PALETTE_NAMES.length }, (_, i) => `person-${i * 31}`);
    expect(new Set(assignPalettes(ids).values()).size).toBe(PALETTE_NAMES.length);
  });
});

describe('colours in chat', () => {
  const voice = ['anna', 'bohdan', 'chloe'];
  const writers = ['dmytro', 'anna', 'eva', 'fedir', 'halyna'];

  it('gives everyone who writes a colour of their own', () => {
    const out = assignPalettes(voice, undefined, writers);
    expect(out.size).toBe(7);
    expect(new Set(out.values()).size).toBe(7);
  });

  it('matches the avatars of those in voice', () => {
    const stage = assignPalettes(voice);
    const chat = assignPalettes(voice, undefined, writers);
    for (const id of voice) expect(chat.get(id)).toBe(stage.get(id));
  });

  it('changes nobody when someone new writes', () => {
    const before = assignPalettes(voice, undefined, writers);
    const after = assignPalettes(voice, undefined, [...writers, 'newcomer']);
    for (const [id, palette] of before) expect(after.get(id)).toBe(palette);
  });

  it('keeps a chosen colour out of everyone else\'s reach', () => {
    const out = assignPalettes(voice, { id: 'halyna', palette: 'moss' }, writers);
    expect(out.get('halyna')).toBe('moss');
    expect([...out.values()].filter((p) => p === 'moss')).toHaveLength(1);
  });
});

describe('a chosen colour', () => {
  const ids = Array.from({ length: 8 }, (_, i) => `visitor-${i}`);

  it('belongs to its owner and is never given to anyone else', () => {
    for (const palette of PALETTE_NAMES) {
      const out = assignPalettes(ids, { id: ids[3]!, palette });
      expect(out.get(ids[3]!)).toBe(palette);
      expect(new Set(out.values()).size).toBe(8);
    }
  });

  it('is held for its owner before they join, so nobody changes when they do', () => {
    const others = ids.slice(1);
    const before = assignPalettes(others, { id: ids[0]!, palette: 'sky' });
    const after = assignPalettes(ids, { id: ids[0]!, palette: 'sky' });
    for (const id of others) expect(after.get(id)).toBe(before.get(id));
    expect([...before].filter(([id, palette]) => id !== ids[0] && palette === 'sky')).toEqual([]);
  });

  it('colours only its owner in chat', () => {
    expect(ownPalette('me', 'me', 'moss')).toBe('moss');
    expect(ownPalette('me', 'me', null)).toBe(paletteOf('me'));
    expect(ownPalette('them', 'me', 'moss')).toBe(paletteOf('them'));
  });
});

describe('pickFavorite', () => {
  const favorites = ['sky', 'moss', 'coral'] as const;

  it('can land on every favourite and on nothing else', () => {
    expect(pickFavorite(favorites, () => 0)).toBe('sky');
    expect(pickFavorite(favorites, () => 0.5)).toBe('moss');
    expect(pickFavorite(favorites, () => 0.999)).toBe('coral');
  });

  it('has nothing to offer without favourites', () => {
    expect(pickFavorite([])).toBeNull();
  });
});

describe('roomPalette', () => {
  it('never repeats among the first rooms', () => {
    expect(new Set(PALETTE_NAMES.map((_, i) => roomPalette(i))).size).toBe(PALETTE_NAMES.length);
  });
});
