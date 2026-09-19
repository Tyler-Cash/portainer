import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

export const VAAPI_DEVICE = process.env.VAAPI_DEVICE || '/dev/dri/renderD128';

export type DecodeMode = 'hw' | 'sw';

// Codecs the Intel iGPU can decode via VAAPI, so their frames come out as GPU
// surfaces ready for h264_vaapi ('hw' zero-copy path). Anything else — most
// notably AV1, which older iGPUs can't decode — has to be software-decoded and
// uploaded to the GPU ('sw'), otherwise ffmpeg fails with "Impossible to
// convert between the formats supported by the filter" and the live pipe emits
// nothing, leaving the <video> preview blank.
const HW_DECODABLE_CODECS = new Set([
  'h264', 'hevc', 'h265', 'vp9', 'vp8', 'mpeg2video', 'vc1', 'wmv3', 'mjpeg',
]);

export function decodeModeForCodec(codec: string): DecodeMode {
  return HW_DECODABLE_CODECS.has(codec.trim().toLowerCase()) ? 'hw' : 'sw';
}

// Always re-encodes (VAAPI/Quick Sync) rather than attempting -c copy.
// Stream-copy from an arbitrary -ss point isn't reliable on sources with
// irregular timestamps and can produce a near-empty output. Re-encoding
// normalizes timestamps as part of decoding, avoiding that. A live pipe
// can't easily retry after it starts, so this skips attempting copy
// entirely rather than detecting and recovering mid-stream — and, for the
// same reason, the decode mode is chosen up front from the source codec
// (see decodeModeForCodec) rather than by catching a hw-decode failure.
export function buildRemuxArgs(
  sourcePath: string,
  startSeconds: number,
  vaapiDevice: string = VAAPI_DEVICE,
  decode: DecodeMode = 'hw',
): string[] {
  const args = ['-y', '-loglevel', 'error', '-hide_banner'];
  if (startSeconds > 0) {
    args.push('-ss', String(startSeconds));
  }
  if (decode === 'sw') {
    // Software decode into system memory, then hwupload the frames for the
    // VAAPI encoder.
    args.push('-vaapi_device', vaapiDevice, '-i', sourcePath, '-vf', 'format=nv12,hwupload');
  } else {
    args.push(
      '-hwaccel', 'vaapi',
      '-hwaccel_device', vaapiDevice,
      '-hwaccel_output_format', 'vaapi',
      '-i', sourcePath,
    );
  }
  args.push(
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
  decode: DecodeMode = 'hw',
): ChildProcessByStdio<null, Readable, null> {
  return spawn('ffmpeg', buildRemuxArgs(sourcePath, startSeconds, VAAPI_DEVICE, decode), {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}
