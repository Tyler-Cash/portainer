import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

export const VAAPI_DEVICE = process.env.VAAPI_DEVICE || '/dev/dri/renderD128';

// Always re-encodes (VAAPI/Quick Sync) rather than attempting -c copy.
// Stream-copy from an arbitrary -ss point isn't reliable on sources with
// irregular timestamps and can produce a near-empty output. Re-encoding
// normalizes timestamps as part of decoding, avoiding that. A live pipe
// can't easily retry after it starts, so this skips attempting copy
// entirely rather than detecting and recovering mid-stream.
export function buildRemuxArgs(
  sourcePath: string,
  startSeconds: number,
  vaapiDevice: string = VAAPI_DEVICE,
): string[] {
  const args = ['-y', '-loglevel', 'error', '-hide_banner'];
  if (startSeconds > 0) {
    args.push('-ss', String(startSeconds));
  }
  args.push(
    '-hwaccel', 'vaapi',
    '-hwaccel_device', vaapiDevice,
    '-hwaccel_output_format', 'vaapi',
    '-i', sourcePath,
    '-c:v', 'h264_vaapi',
    '-qp', '23',
    '-c:a', 'aac',
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
