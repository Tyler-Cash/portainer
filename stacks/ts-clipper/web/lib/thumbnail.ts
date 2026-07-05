import { execFile } from 'node:child_process';
import { access, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { SCRATCH_DIR } from './paths';

const execFileAsync = promisify(execFile);

export function roundToThumbnailSecond(seconds: number): number {
  return Math.max(0, Math.round(seconds));
}

export function thumbnailPath(
  id: string,
  roundedSeconds: number,
  scratchDir: string = SCRATCH_DIR,
): string {
  return path.join(scratchDir, `${id}-thumb-${roundedSeconds}.jpg`);
}

export function buildThumbnailArgs(sourcePath: string, seconds: number, outputPath: string): string[] {
  return [
    '-y', '-loglevel', 'error', '-hide_banner',
    '-ss', String(seconds),
    '-i', sourcePath,
    '-frames:v', '1',
    '-vf', 'scale=160:-1',
    '-q:v', '4',
    outputPath,
  ];
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Thumbnails are generated on demand (not pre-batched for the whole video)
// and cached to disk keyed by id + rounded second, so repeated drags near
// the same position don't re-invoke ffmpeg every time.
export async function ensureThumbnail(
  sourcePath: string,
  id: string,
  seconds: number,
  scratchDir: string = SCRATCH_DIR,
): Promise<string> {
  const rounded = roundToThumbnailSecond(seconds);
  const output = thumbnailPath(id, rounded, scratchDir);
  if (await fileExists(output)) {
    return output;
  }
  await execFileAsync('ffmpeg', buildThumbnailArgs(sourcePath, rounded, output));
  return output;
}

export async function removeThumbnails(id: string, scratchDir: string = SCRATCH_DIR): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(scratchDir);
  } catch {
    return;
  }
  const prefix = `${id}-thumb-`;
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => unlink(path.join(scratchDir, entry)).catch(() => {})),
  );
}
