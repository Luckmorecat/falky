import { describe, expect, it } from 'vitest';
import { fitBlocks } from './layout';

describe('fitBlocks', () => {
  it('keeps two people side by side on a wide stage, within the largest size', () => {
    expect(fitBlocks(2, 1000, 640, 16, 460)).toEqual({ size: 460, columns: 2 });
  });
  it('makes four into two rows when that gives larger blocks', () => {
    expect(fitBlocks(4, 900, 640, 16, 460).columns).toBe(2);
  });
  it('fits eight on a wide stage in four columns', () => {
    const { size, columns } = fitBlocks(8, 930, 640, 12, 460);
    expect(columns).toBe(4);
    expect(size * 4 + 3 * 12).toBeLessThanOrEqual(930);
  });
  it('stacks on a phone', () => {
    expect(fitBlocks(2, 351, 620, 16, 460).columns).toBe(1);
  });
  it('answers for an empty room and a tiny window without a negative size', () => {
    expect(fitBlocks(0, 900, 600, 16, 460).size).toBe(0);
    expect(fitBlocks(8, 10, 10, 16, 460).size).toBe(0);
  });
});
