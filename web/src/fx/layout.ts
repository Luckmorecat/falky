/** The largest square block size that fits `count` blocks in an area, and its columns. */
export function fitBlocks(count: number, width: number, height: number, gap: number, maxSize: number): { size: number; columns: number } {
  if (count < 1) return { size: 0, columns: 1 };
  let best = 0;
  let columns = 1;
  for (let c = 1; c <= count; c++) {
    const rows = Math.ceil(count / c);
    const size = Math.min((width - (c - 1) * gap) / c, (height - (rows - 1) * gap) / rows);
    // Ties go to fewer columns: a taller arrangement reads no worse.
    if (size > best + 0.5) {
      best = size;
      columns = c;
    }
  }
  return { size: Math.max(0, Math.floor(Math.min(best, maxSize))), columns };
}
