import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ClipOptions {
  start: number;
  end: number;
  removeAudio: boolean;
}

export function buildFfmpegArgs(
  sourcePath: string,
  outputPath: string,
  { start, end, removeAudio }: ClipOptions,
  mode: 'copy' | 'reencode',
): string[] {
  const videoArgs =
    mode === 'copy' ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast'];
  const audioArgs = removeAudio ? ['-an'] : mode === 'copy' ? ['-c:a', 'copy'] : ['-c:a', 'aac'];

  return [
    '-y',
    '-ss', String(start),
    '-to', String(end),
    '-i', sourcePath,
    ...videoArgs,
    ...audioArgs,
    outputPath,
  ];
}

export async function runClip(
  sourcePath: string,
  outputPath: string,
  options: ClipOptions,
): Promise<void> {
  try {
    await execFileAsync('ffmpeg', buildFfmpegArgs(sourcePath, outputPath, options, 'copy'));
  } catch {
    await execFileAsync('ffmpeg', buildFfmpegArgs(sourcePath, outputPath, options, 'reencode'));
  }
}
