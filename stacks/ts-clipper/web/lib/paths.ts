import path from 'node:path';
import { readdir } from 'node:fs/promises';

export const SCRATCH_DIR = process.env.SCRATCH_DIR ?? '/app/scratch';

// Preview no longer depends on the browser being able to natively play the
// source container (everything is remuxed server-side by ffmpeg before it
// reaches the browser) — so this is now a broad sanity check against common
// video containers ffmpeg can read, not a "must be browser-playable" gate.
export const ACCEPTED_EXTENSIONS = [
  '.ts', '.m2ts', '.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.flv', '.wmv', '.mpg', '.mpeg',
] as const;

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isValidId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export function isAcceptedExtension(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return (ACCEPTED_EXTENSIONS as readonly string[]).includes(ext);
}

export function clipPath(id: string, scratchDir: string = SCRATCH_DIR): string {
  return path.join(scratchDir, `${id}-clip.mp4`);
}

export async function findSourceFile(
  id: string,
  scratchDir: string = SCRATCH_DIR,
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(scratchDir);
  } catch {
    return null;
  }
  const match = entries.find((entry) => entry.startsWith(`${id}.`));
  return match ? path.join(scratchDir, match) : null;
}
