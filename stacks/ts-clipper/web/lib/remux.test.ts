import { describe, expect, it } from 'vitest';
import { buildRemuxArgs } from './remux';

describe('buildRemuxArgs', () => {
  it('remuxes from the start with no -ss when startSeconds is 0', () => {
    const args = buildRemuxArgs('/scratch/in.ts', 0);
    expect(args).toEqual([
      '-y', '-loglevel', 'error', '-hide_banner',
      '-i', '/scratch/in.ts',
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      'pipe:1',
    ]);
  });

  it('seeks to the requested start time before the input', () => {
    const args = buildRemuxArgs('/scratch/in.ts', 42.5);
    expect(args).toEqual([
      '-y', '-loglevel', 'error', '-hide_banner',
      '-ss', '42.5',
      '-i', '/scratch/in.ts',
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      'pipe:1',
    ]);
  });
});
