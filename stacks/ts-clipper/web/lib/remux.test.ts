import { describe, expect, it } from 'vitest';
import { buildRemuxArgs } from './remux';

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

  it('defaults the VAAPI device to /dev/dri/renderD128 when not specified', () => {
    const args = buildRemuxArgs('/scratch/in.ts', 0);
    expect(args).toContain('/dev/dri/renderD128');
  });
});
