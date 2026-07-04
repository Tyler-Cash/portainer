import path from 'node:path';
import { readdir, stat, unlink } from 'node:fs/promises';
import { SCRATCH_DIR } from './paths';

export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export async function sweepScratchDir(
  scratchDir: string = SCRATCH_DIR,
  maxAgeMs: number = MAX_AGE_MS,
  now: number = Date.now(),
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(scratchDir);
  } catch {
    return [];
  }

  const removed: string[] = [];
  for (const entry of entries) {
    const filePath = path.join(scratchDir, entry);
    const stats = await stat(filePath);
    if (now - stats.mtimeMs > maxAgeMs) {
      await unlink(filePath);
      removed.push(entry);
    }
  }
  return removed;
}
