import { describe, expect, it } from 'vitest';
import { anchorFrom, atBottom, forgetPlaces, followingLatest, rememberPlace, scrollToAnchor, sliceRange, stack } from './place';

const keys = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `m${from + i}`);

describe('stack and slice', () => {
  it('keeps free space above a short feed and mounts every row', () => {
    const { tops, scrollHeight } = stack([20, 30], 28, 12, 200);
    expect(tops[0]).toBe(28 + (200 - 28 - 12 - 50));
    expect(scrollHeight).toBe(200);
    expect(sliceRange(tops, 0, 200, 0)).toEqual({ start: 0, end: 2 });
  });

  it('mounts a bounded window however long the history is', () => {
    const heights = Array.from({ length: 5000 }, () => 24);
    const top = stack(heights, 28, 12, 640);
    const atTop = sliceRange(top.tops, 0, 640);
    const atMid = sliceRange(top.tops, 40_000, 640);
    expect(atTop.end - atTop.start).toBeLessThan(80);
    expect(atMid.end - atMid.start).toBeLessThan(80);
    expect(atMid.start).toBeGreaterThan(1000);
    expect(atMid.end).toBeLessThan(5000);
  });
});

describe('anchor', () => {
  it('keeps the same row and offset when older rows are prepended', () => {
    const before = stack(Array.from({ length: 40 }, () => 30), 28, 12, 400);
    const current = keys(40);
    const anchor = anchorFrom(current, before.tops, 600);
    expect(anchor).toEqual({ key: 'm19', offset: 28 + 19 * 30 - 600 });
    const afterHeights = [...Array.from({ length: 10 }, () => 44), ...Array.from({ length: 40 }, () => 30)];
    const after = stack(afterHeights, 28, 12, 400);
    const combined = [...keys(10, 1000), ...current];
    const max = after.scrollHeight - 400;
    const next = scrollToAnchor(combined, after.tops, anchor!, max);
    const moved = after.tops[combined.indexOf(anchor!.key)]! - next!;
    expect(moved).toBe(anchor!.offset);
    expect(next! - 600).toBe(10 * 44);
  });

  it('shifts only for a height change above the anchor', () => {
    const keys40 = keys(10);
    const before = stack(Array.from({ length: 10 }, () => 20), 0, 0, 100);
    const anchor = anchorFrom(keys40, before.tops, 50)!;
    const grown = stack([40, 40, 40, 20, 20, 20, 20, 20, 20, 20], 0, 0, 100);
    const next = scrollToAnchor(keys40, grown.tops, anchor, grown.scrollHeight)!;
    expect(grown.tops[keys40.indexOf(anchor.key)]! - next).toBe(anchor.offset);
    const below = stack([20, 20, 20, 20, 20, 80, 80, 80, 80, 80], 0, 0, 100);
    const same = scrollToAnchor(keys40, below.tops, anchor, below.scrollHeight)!;
    expect(same).toBe(50);
  });

  it('anchors the message below a day line, which stays put when that day line moves', () => {
    const beforeKeys = ['day', 'm26', 'm27'];
    const before = stack([36, 30, 30], 0, 0, 50);
    const anchor = anchorFrom(beforeKeys, before.tops, 0, [false, true, true]);
    expect(anchor).toEqual({ key: 'm26', offset: 36 });
    const afterKeys = ['day', 'm1', 'm26', 'm27'];
    const after = stack([36, 40, 30, 30], 0, 0, 50);
    const next = scrollToAnchor(afterKeys, after.tops, anchor!, after.scrollHeight - 50);
    expect(after.tops[afterKeys.indexOf('m26')]! - next!).toBe(anchor!.offset);
    expect(next).toBe(40);
  });

  it('returns null once the anchored row is gone', () => {
    const tops = stack([10, 10], 0, 0, 40).tops;
    expect(scrollToAnchor(['a', 'b'], tops, { key: 'c', offset: 0 }, 0)).toBeNull();
  });

  it('treats the slack at the bottom as following', () => {
    expect(atBottom(100, 200, 80)).toBe(true);
    expect(atBottom(40, 200, 80)).toBe(false);
  });
});

describe('places', () => {
  it('follows the latest messages until a room is left higher up', () => {
    forgetPlaces();
    expect(followingLatest('lounge')).toBe(true);
    rememberPlace('lounge', { following: false, anchor: { key: 'm4', offset: -8 } });
    rememberPlace('games', { following: true, anchor: null });
    expect(followingLatest('lounge')).toBe(false);
    expect(followingLatest('games')).toBe(true);
    forgetPlaces();
  });
});
