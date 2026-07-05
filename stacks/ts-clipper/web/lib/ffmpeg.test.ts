import { describe, expect, it } from 'vitest';
import { buildFfmpegArgs, formatTimingLog } from './ffmpeg';

describe('buildFfmpegArgs', () => {
  it('builds a stream-copy trim that keeps audio, with no hwaccel flags needed', () => {
    const args = buildFfmpegArgs(
      '/scratch/in.ts',
      '/scratch/out.mp4',
      { start: 1.5, end: 4, removeAudio: false },
      'copy',
    );
    expect(args).toEqual([
      '-y', '-ss', '1.5', '-to', '4', '-i', '/scratch/in.ts',
      '-c:v', 'copy', '-c:a', 'copy', '/scratch/out.mp4',
    ]);
  });

  it('drops the audio stream when removeAudio is set, still stream-copying video', () => {
    const args = buildFfmpegArgs(
      '/scratch/in.ts',
      '/scratch/out.mp4',
      { start: 0, end: 10, removeAudio: true },
      'copy',
    );
    expect(args).toEqual([
      '-y', '-ss', '0', '-to', '10', '-i', '/scratch/in.ts',
      '-c:v', 'copy', '-an', '/scratch/out.mp4',
    ]);
  });

  it('uses VAAPI hardware encoding with audio in reencode mode', () => {
    const args = buildFfmpegArgs(
      '/scratch/in.ts',
      '/scratch/out.mp4',
      { start: 0, end: 10, removeAudio: false },
      'reencode',
      '/dev/dri/renderD128',
    );
    expect(args).toEqual([
      '-y',
      '-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128', '-hwaccel_output_format', 'vaapi',
      '-ss', '0', '-to', '10', '-i', '/scratch/in.ts',
      '-c:v', 'h264_vaapi', '-qp', '23', '-c:a', 'aac', '/scratch/out.mp4',
    ]);
  });

  it('drops audio in VAAPI reencode mode when removeAudio is set', () => {
    const args = buildFfmpegArgs(
      '/scratch/in.ts',
      '/scratch/out.mp4',
      { start: 0, end: 10, removeAudio: true },
      'reencode',
      '/dev/dri/renderD128',
    );
    expect(args).toEqual([
      '-y',
      '-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128', '-hwaccel_output_format', 'vaapi',
      '-ss', '0', '-to', '10', '-i', '/scratch/in.ts',
      '-c:v', 'h264_vaapi', '-qp', '23', '-an', '/scratch/out.mp4',
    ]);
  });

  it('downscales via VAAPI and uses a looser quality target in fast mode', () => {
    const args = buildFfmpegArgs(
      '/scratch/in.ts',
      '/scratch/out.mp4',
      { start: 0, end: 10, removeAudio: false },
      'fast',
      '/dev/dri/renderD128',
    );
    expect(args).toEqual([
      '-y',
      '-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128', '-hwaccel_output_format', 'vaapi',
      '-ss', '0', '-to', '10', '-i', '/scratch/in.ts',
      '-vf', 'scale_vaapi=w=-2:h=480:format=nv12', '-c:v', 'h264_vaapi', '-qp', '32',
      '-c:a', 'aac', '/scratch/out.mp4',
    ]);
  });

  it('drops audio in fast mode when removeAudio is set', () => {
    const args = buildFfmpegArgs(
      '/scratch/in.ts',
      '/scratch/out.mp4',
      { start: 0, end: 10, removeAudio: true },
      'fast',
      '/dev/dri/renderD128',
    );
    expect(args).toEqual([
      '-y',
      '-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128', '-hwaccel_output_format', 'vaapi',
      '-ss', '0', '-to', '10', '-i', '/scratch/in.ts',
      '-vf', 'scale_vaapi=w=-2:h=480:format=nv12', '-c:v', 'h264_vaapi', '-qp', '32',
      '-an', '/scratch/out.mp4',
    ]);
  });

  it('defaults the VAAPI device to /dev/dri/renderD128 when not specified', () => {
    const args = buildFfmpegArgs(
      '/scratch/in.ts',
      '/scratch/out.mp4',
      { start: 0, end: 10, removeAudio: false },
      'reencode',
    );
    expect(args).toContain('/dev/dri/renderD128');
  });
});

describe('formatTimingLog', () => {
  it('computes the speed multiplier from clip length and wall time', () => {
    expect(formatTimingLog('fast', 20, 2)).toBe('[ffmpeg:fast] clip=20.0s wall=2.0s speed=10.0x');
  });

  it('reports slower-than-realtime as a speed below 1x', () => {
    expect(formatTimingLog('reencode', 10, 12)).toBe('[ffmpeg:reencode] clip=10.0s wall=12.0s speed=0.8x');
  });

  it('does not divide by zero for near-instant wall time', () => {
    expect(formatTimingLog('copy', 20, 0)).toBe('[ffmpeg:copy] clip=20.0s wall=0.0s speed=Infinityx');
  });
});
