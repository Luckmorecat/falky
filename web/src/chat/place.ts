/**
 * Where a room's chat was left, for this visit only. A reload starts at the bottom again.
 * Read tracking is separate: being away from the latest messages must not mark them read.
 */

export interface Anchor {
  /** A message id or a pending key. Day lines and the loading row move when history grows, so they are not anchors. */
  key: string;
  /** Row top minus scrollTop. Negative when the row begins above the viewport. */
  offset: number;
  /** Distance from the row top to the message text. Grows when a day line above the row moves away and the row gains its own padding. */
  pad?: number;
}

export interface Place {
  /** The visitor is at the newest row and should stay there as messages arrive. */
  following: boolean;
  anchor: Anchor | null;
}

const places = new Map<string, Place>();

export function rememberedPlace(roomId: string): Place | undefined {
  return places.get(roomId);
}

export function rememberPlace(roomId: string, place: Place): void {
  places.set(roomId, place);
}

/** No saved place yet means the visitor has not moved off the latest messages. */
export function followingLatest(roomId: string): boolean {
  return places.get(roomId)?.following !== false;
}

export function forgetPlaces(): void {
  places.clear();
}

/** How far past the viewport rows stay mounted, so a fast scroll does not show a gap. */
export const OVERSCAN = 360;

/** Treated as the bottom, matching the feed's existing slack. */
export const BOTTOM_SLACK = 48;

export interface Stack {
  /** Top of each row, plus one sentinel after the last. Includes the top inset and any slack above a short feed. */
  tops: number[];
  scrollHeight: number;
}

/** Stacks variable-height rows. A short feed keeps its free space above the rows, as the feed used to. */
export function stack(heights: readonly number[], topInset: number, bottomInset: number, viewport: number): Stack {
  const total = heights.reduce((sum, height) => sum + height, 0);
  const extra = Math.max(0, viewport - topInset - bottomInset - total);
  const tops = new Array<number>(heights.length + 1);
  let y = topInset + extra;
  for (let i = 0; i < heights.length; i++) {
    tops[i] = y;
    y += heights[i]!;
  }
  tops[heights.length] = y;
  return { tops, scrollHeight: y + bottomInset };
}

/** Largest row whose top is at or above y. */
export function rowAt(tops: readonly number[], y: number): number {
  const last = tops.length - 2;
  if (last <= 0) return 0;
  if (y <= tops[0]!) return 0;
  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (tops[mid]! <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The mounted window: rows that meet the viewport, plus overscan. `end` is exclusive. */
export function sliceRange(tops: readonly number[], scrollTop: number, viewport: number, overscan = OVERSCAN): { start: number; end: number } {
  const n = tops.length - 1;
  if (n <= 0) return { start: 0, end: 0 };
  const from = scrollTop - overscan;
  const to = scrollTop + viewport + overscan;
  let start = rowAt(tops, from);
  if (tops[start + 1]! <= from) start = Math.min(n, start + 1);
  let end = start;
  while (end < n && tops[end]! < to) end += 1;
  return { start, end };
}

export function atBottom(scrollTop: number, scrollHeight: number, viewport: number, slack = BOTTOM_SLACK): boolean {
  return scrollHeight - scrollTop - viewport <= slack;
}

/**
 * The message under the top edge of the viewport.
 * Day lines, the unread divider, and the loading row are skipped: those rows move
 * when older history arrives, so anchoring one of them would jump the reading place.
 */
export function anchorFrom(keys: readonly string[], tops: readonly number[], scrollTop: number, stable?: readonly boolean[]): Anchor | null {
  const n = keys.length;
  if (!n || tops.length !== n + 1) return null;
  let i = Math.min(n - 1, rowAt(tops, scrollTop));
  if (stable) {
    while (i < n && !stable[i]) i += 1;
    if (i >= n) return null;
  }
  return { key: keys[i]!, offset: tops[i]! - scrollTop };
}

/** Scroll position that puts the anchor back where it was, or null when that row is gone. */
export function scrollToAnchor(keys: readonly string[], tops: readonly number[], anchor: Anchor, maxScroll: number): number | null {
  const i = keys.indexOf(anchor.key);
  if (i < 0) return null;
  const top = tops[i]! - anchor.offset;
  return Math.min(Math.max(0, maxScroll), Math.max(0, top));
}
