import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const VAAPI_DEVICE = process.env.VAAPI_DEVICE || '/dev/dri/renderD128';

export interface ClipOptions {
  start: number;
  end: number;
  removeAudio: boolean;
}

export function buildFfmpegArgs(
  sourcePath: string,
  outputPath: string,
  { start, end, removeAudio }: ClipOptions,
  mode: 'copy' | 'reencode' | 'fast',
  vaapiDevice: string = VAAPI_DEVICE,
): string[] {
  const audioArgs = removeAudio ? ['-an'] : ['-c:a', mode === 'copy' ? 'copy' : 'aac'];

  if (mode === 'copy') {
    return [
      '-y',
      '-ss', String(start),
      '-to', String(end),
      '-i', sourcePath,
      '-c:v', 'copy',
      ...audioArgs,
      outputPath,
    ];
  }

  // Both non-copy modes decode and re-encode on the iGPU via VAAPI (Quick
  // Sync) instead of libx264 on CPU — raw .ts DVR footage almost always
  // fails the stream-copy path (irregular timestamps), so this is the
  // common case, not a rare fallback, and the fast-preview pass always
  // re-encodes by design (it has to downscale).
  const videoArgs =
    mode === 'fast'
      ? ['-vf', 'scale_vaapi=w=-2:h=480:format=nv12', '-c:v', 'h264_vaapi', '-qp', '32']
      : ['-c:v', 'h264_vaapi', '-qp', '23'];

  return [
    '-y',
    '-hwaccel', 'vaapi',
    '-hwaccel_device', vaapiDevice,
    '-hwaccel_output_format', 'vaapi',
    '-ss', String(start),
    '-to', String(end),
    '-i', sourcePath,
    ...videoArgs,
    ...audioArgs,
    outputPath,
  ];
}

export function formatTimingLog(mode: string, clipSeconds: number, wallSeconds: number): string {
  const speed = wallSeconds > 0 ? clipSeconds / wallSeconds : Infinity;
  return `[ffmpeg:${mode}] clip=${clipSeconds.toFixed(1)}s wall=${wallSeconds.toFixed(1)}s speed=${speed.toFixed(1)}x`;
}

async function runFfmpeg(
  mode: 'copy' | 'reencode' | 'fast',
  sourcePath: string,
  outputPath: string,
  options: ClipOptions,
): Promise<void> {
  const wallStart = Date.now();
  await execFileAsync('ffmpeg', buildFfmpegArgs(sourcePath, outputPath, options, mode));
  console.log(formatTimingLog(mode, options.end - options.start, (Date.now() - wallStart) / 1000));
}

export async function runClip(
  sourcePath: string,
  outputPath: string,
  options: ClipOptions,
): Promise<void> {
  try {
    await runFfmpeg('copy', sourcePath, outputPath, options);
  } catch {
    await runFfmpeg('reencode', sourcePath, outputPath, options);
  }
}

export async function runFastClip(
  sourcePath: string,
  outputPath: string,
  options: ClipOptions,
): Promise<void> {
  await runFfmpeg('fast', sourcePath, outputPath, options);
}
