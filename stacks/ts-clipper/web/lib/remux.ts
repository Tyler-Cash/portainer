import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

export function buildRemuxArgs(sourcePath: string, startSeconds: number): string[] {
  const args = ['-y', '-loglevel', 'error', '-hide_banner'];
  if (startSeconds > 0) {
    args.push('-ss', String(startSeconds));
  }
  args.push(
    '-i', sourcePath,
    '-c', 'copy',
    '-avoid_negative_ts', 'make_zero',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1',
  );
  return args;
}

export function spawnRemux(
  sourcePath: string,
  startSeconds: number,
): ChildProcessByStdio<null, Readable, null> {
  return spawn('ffmpeg', buildRemuxArgs(sourcePath, startSeconds), {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}
