/** How a message's pictures sit together. Sizes come from the server, so the row has its height before any image arrives. */

export interface Sized {
  width: number;
  height: number;
}

/** One picture keeps its shape within reason; a panorama or a receipt is cropped, not shrunk to a line. */
export const MIN_RATIO = 0.6;
export const MAX_RATIO = 2.2;
export const SINGLE_MAX_HEIGHT = 320;
const FALLBACK_RATIO = 4 / 3;

export function ratioOf(item: Sized): number {
  if (!item.width || !item.height) return FALLBACK_RATIO;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, item.width / item.height));
}

/**
 * The whole gallery's width over its height. One picture keeps its own shape;
 * two stand side by side; three are one large and two stacked; four are a square.
 */
export function galleryRatio(items: Sized[]): number {
  switch (items.length) {
    case 0: return 1;
    case 1: return ratioOf(items[0]!);
    case 2: return 2 / 1.15;
    case 3: return 3 / 2;
    default: return 1;
  }
}

/** The gallery's size in a column `available` wide. */
export function gallerySize(items: Sized[], available: number): { width: number; height: number } {
  const ratio = galleryRatio(items);
  if (items.length === 1) {
    const width = Math.min(available, SINGLE_MAX_HEIGHT * ratio);
    return { width, height: width / ratio };
  }
  return { width: available, height: available / ratio };
}

export const formatBytes = (bytes: number, locale: string): string => {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toLocaleString(locale, { maximumFractionDigits: unit && value < 10 ? 1 : 0 })} ${units[unit]}`;
};
