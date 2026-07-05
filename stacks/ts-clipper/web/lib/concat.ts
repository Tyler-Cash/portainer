import { VAAPI_DEVICE } from './ffmpeg';

export interface ConcatInput {
  path: string;
  width: number;
  height: number;
  fps: number;
}

// Joins multiple videos into one, in the given order. Inputs are decoded
// and filtered in software (concat needs to inspect/re-time raw frames, not
// hardware surfaces), normalized to the first input's dimensions — with
// letterboxing so differing aspect ratios don't distort — and frame rate,
// then uploaded to the iGPU once for a single VAAPI encode pass.
export function buildConcatArgs(
  inputs: ConcatInput[],
  outputPath: string,
  vaapiDevice: string = VAAPI_DEVICE,
): string[] {
  const { width, height, fps } = inputs[0];
  const targetFps = fps > 0 ? fps : 30;

  const scaleFilters = inputs
    .map(
      (_, i) =>
        `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${targetFps}[v${i}]`,
    )
    .join(';');

  const concatStreams = inputs.map((_, i) => `[v${i}][${i}:a]`).join('');
  const filterComplex =
    `${scaleFilters};${concatStreams}concat=n=${inputs.length}:v=1:a=1[vcat][acat];` +
    `[vcat]format=nv12,hwupload[v]`;

  return [
    '-y', '-loglevel', 'error', '-hide_banner',
    '-init_hw_device', `vaapi=va:${vaapiDevice}`,
    '-filter_hw_device', 'va',
    ...inputs.flatMap((input) => ['-i', input.path]),
    '-filter_complex', filterComplex,
    '-map', '[v]', '-map', '[acat]',
    '-c:v', 'h264_vaapi', '-qp', '23',
    '-c:a', 'aac',
    outputPath,
  ];
}
