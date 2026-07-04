export interface ByteRange {
  start: number;
  end: number;
}

export function resolveRange(
  rangeHeader: string | null,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  if (!rangeHeader) return null;

  const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
  if (!match) return 'unsatisfiable';

  const start = Number(match[1]);
  let end = match[2] ? Number(match[2]) : size - 1;

  if (start >= size || start > end) return 'unsatisfiable';

  end = Math.min(end, size - 1);
  return { start, end };
}
