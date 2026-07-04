import path from 'node:path';
import { readdir } from 'node:fs/promises';

export const SCRATCH_DIR = process.env.SCRATCH_DIR ?? '/app/scratch';

export const ACCEPTED_EXTENSIONS = ['.ts', '.m2ts', '.mp4', '.webm', '.m4v'] as const;

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isValidId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export function isAcceptedExtension(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return (ACCEPTED_EXTENSIONS as readonly string[]).includes(ext);
}

export function mimeTypeFor(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.ts' || ext === '.m2ts') return 'video/mp2t';
  if (ext === '.mp4' || ext === '.m4v') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  return 'application/octet-stream';
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
