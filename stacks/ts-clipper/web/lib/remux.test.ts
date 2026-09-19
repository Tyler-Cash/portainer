import { describe, expect, it } from 'vitest';
import { buildRemuxArgs, decodeModeForCodec } from './remux';

describe('decodeModeForCodec', () => {
  it('hardware-decodes codecs the iGPU supports', () => {
    for (const codec of ['h264', 'hevc', 'vp9', 'mpeg2video']) {
      expect(decodeModeForCodec(codec)).toBe('hw');
    }
  });

  it('software-decodes AV1 and unknown codecs', () => {
    expect(decodeModeForCodec('av1')).toBe('sw');
    expect(decodeModeForCodec('theora')).toBe('sw');
    expect(decodeModeForCodec('')).toBe('sw');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(decodeModeForCodec(' H264 ')).toBe('hw');
  });
});

describe('buildRemuxArgs', () => {
  it('remuxes from the start with no -ss when startSeconds is 0', () => {
    const args = buildRemuxArgs('/scratch/in.ts', 0, '/dev/dri/renderD128');
    expect(args).toEqual([
      '-y', '-loglevel', 'error', '-hide_banner',
      '-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128', '-hwaccel_output_format', 'vaapi',
      '-i', '/scratch/in.ts',
      '-c:v', 'h264_vaapi', '-qp', '23', '-c:a', 'aac',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      'pipe:1',
    ]);
  });

  it('seeks to the requested start time before the input', () => {
    const args = buildRemuxArgs('/scratch/in.ts', 42.5, '/dev/dri/renderD128');
    expect(args).toEqual([
      '-y', '-loglevel', 'error', '-hide_banner',
      '-ss', '42.5',
      '-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128', '-hwaccel_output_format', 'vaapi',
      '-i', '/scratch/in.ts',
      '-c:v', 'h264_vaapi', '-qp', '23', '-c:a', 'aac',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      'pipe:1',
    ]);
  });

  it('software-decodes and uploads to the GPU when decode is sw', () => {
    const args = buildRemuxArgs('/scratch/in.avi', 0, '/dev/dri/renderD128', 'sw');
    expect(args).toEqual([
      '-y', '-loglevel', 'error', '-hide_banner',
      '-vaapi_device', '/dev/dri/renderD128',
      '-i', '/scratch/in.avi', '-vf', 'format=nv12,hwupload',
      '-c:v', 'h264_vaapi', '-qp', '23', '-c:a', 'aac',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      'pipe:1',
    ]);
  });

  it('keeps -ss before the input in sw mode', () => {
    const args = buildRemuxArgs('/scratch/in.avi', 42.5, '/dev/dri/renderD128', 'sw');
    expect(args.slice(0, 6)).toEqual([
      '-y', '-loglevel', 'error', '-hide_banner', '-ss', '42.5',
    ]);
    expect(args).toContain('-vaapi_device');
  });

  it('defaults the VAAPI device to /dev/dri/renderD128 when not specified', () => {
    const args = buildRemuxArgs('/scratch/in.ts', 0);
    expect(args).toContain('/dev/dri/renderD128');
  });
});
