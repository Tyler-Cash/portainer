import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const VAAPI_DEVICE = process.env.VAAPI_DEVICE || '/dev/dri/renderD128';

export interface ClipOptions {
  start: number;
  end: number;
  removeAudio: boolean;
}

// 'hw' does zero-copy VAAPI decode+encode: the fast path for codecs the iGPU
// can decode (H.264/HEVC). 'sw' decodes in software and uploads the frames to
// the GPU for the h264_vaapi encoder — the fallback for inputs with no VAAPI
// decoder (e.g. AV1), where 'hw' fails with "Impossible to convert between the
// formats supported by the filter" because nothing produces GPU surfaces.
export type DecodeMode = 'hw' | 'sw';

export function buildFfmpegArgs(
  sourcePath: string,
  outputPath: string,
  { start, end, removeAudio }: ClipOptions,
  mode: 'reencode' | 'fast',
  vaapiDevice: string = VAAPI_DEVICE,
  decode: DecodeMode = 'hw',
): string[] {
  const audioArgs = removeAudio ? ['-an'] : ['-c:a', 'aac'];

  // Always decode and re-encode on the iGPU via VAAPI (Quick Sync) instead
  // of stream-copying. Stream-copy can only cut at keyframes, so the
  // exported clip's start would silently drift from whatever boundary the
  // user actually picked in the UI — re-encoding is what makes the export
  // match the frame the user selected.
  //
  // In 'sw' mode the decode happens in system memory, so we hwupload before
  // any VAAPI filter/encoder. scale_vaapi has to run after hwupload since it
  // operates on GPU surfaces.
  const downloadFilters =
    mode === 'fast' ? 'format=nv12,hwupload,scale_vaapi=w=-2:h=480' : 'format=nv12,hwupload';
  const videoArgs =
    decode === 'sw'
      ? ['-vf', downloadFilters, '-c:v', 'h264_vaapi', '-qp', mode === 'fast' ? '32' : '23']
      : mode === 'fast'
        ? ['-vf', 'scale_vaapi=w=-2:h=480:format=nv12', '-c:v', 'h264_vaapi', '-qp', '32']
        : ['-c:v', 'h264_vaapi', '-qp', '23'];

  const inputArgs =
    decode === 'sw'
      ? ['-vaapi_device', vaapiDevice]
      : ['-hwaccel', 'vaapi', '-hwaccel_device', vaapiDevice, '-hwaccel_output_format', 'vaapi'];

  return [
    '-y',
    ...inputArgs,
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
  mode: 'reencode' | 'fast',
  sourcePath: string,
  outputPath: string,
  options: ClipOptions,
): Promise<void> {
  const wallStart = Date.now();
  try {
    await execFileAsync('ffmpeg', buildFfmpegArgs(sourcePath, outputPath, options, mode, VAAPI_DEVICE, 'hw'));
  } catch (err) {
    // Zero-copy VAAPI decode only works for codecs the iGPU can decode. Inputs
    // with no VAAPI decoder (e.g. AV1) fail the hw pipeline outright, so retry
    // with a software decode that uploads frames to the GPU for the encoder.
    console.warn(`[ffmpeg:${mode}] hw decode failed, retrying with software decode: ${(err as Error).message.split('\n')[0]}`);
    await execFileAsync('ffmpeg', buildFfmpegArgs(sourcePath, outputPath, options, mode, VAAPI_DEVICE, 'sw'));
  }
  console.log(formatTimingLog(mode, options.end - options.start, (Date.now() - wallStart) / 1000));
}

export async function runClip(
  sourcePath: string,
  outputPath: string,
  options: ClipOptions,
): Promise<void> {
  await runFfmpeg('reencode', sourcePath, outputPath, options);
}

export async function runFastClip(
  sourcePath: string,
  outputPath: string,
  options: ClipOptions,
): Promise<void> {
  await runFfmpeg('fast', sourcePath, outputPath, options);
}
