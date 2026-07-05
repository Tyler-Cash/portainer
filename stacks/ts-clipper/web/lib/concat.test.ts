import { describe, expect, it } from 'vitest';
import { buildConcatArgs } from './concat';

describe('buildConcatArgs', () => {
  it('joins two same-sized inputs in order, video-then-video, audio-then-audio', () => {
    const args = buildConcatArgs(
      [
        { path: '/scratch/a.mp4', width: 1920, height: 1080, fps: 30 },
        { path: '/scratch/b.mp4', width: 1920, height: 1080, fps: 30 },
      ],
      '/scratch/out.mp4',
      '/dev/dri/renderD128',
    );

    expect(args).toEqual([
      '-y', '-loglevel', 'error', '-hide_banner',
      '-init_hw_device', 'vaapi=va:/dev/dri/renderD128',
      '-filter_hw_device', 'va',
      '-i', '/scratch/a.mp4',
      '-i', '/scratch/b.mp4',
      '-filter_complex',
      '[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v0];' +
        '[1:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v1];' +
        '[v0][0:a][v1][1:a]concat=n=2:v=1:a=1[vcat][acat];[vcat]format=nv12,hwupload[v]',
      '-map', '[v]', '-map', '[acat]',
      '-c:v', 'h264_vaapi', '-qp', '23',
      '-c:a', 'aac',
      '/scratch/out.mp4',
    ]);
  });

  it('normalizes later inputs to the first input dimensions and frame rate', () => {
    const args = buildConcatArgs(
      [
        { path: '/scratch/a.mp4', width: 1280, height: 720, fps: 25 },
        { path: '/scratch/b.mp4', width: 1920, height: 1080, fps: 60 },
      ],
      '/scratch/out.mp4',
    );

    const filterComplex = args[args.indexOf('-filter_complex') + 1];
    expect(filterComplex).toContain('[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=25[v0]');
    expect(filterComplex).toContain('[1:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=25[v1]');
  });

  it('falls back to 30fps when the first input reports an unknown frame rate', () => {
    const args = buildConcatArgs(
      [
        { path: '/scratch/a.mp4', width: 640, height: 480, fps: 0 },
        { path: '/scratch/b.mp4', width: 640, height: 480, fps: 0 },
      ],
      '/scratch/out.mp4',
    );

    const filterComplex = args[args.indexOf('-filter_complex') + 1];
    expect(filterComplex).toContain('fps=30');
  });

  it('handles three or more inputs, concatenating them in the given order', () => {
    const args = buildConcatArgs(
      [
        { path: '/scratch/a.mp4', width: 640, height: 480, fps: 30 },
        { path: '/scratch/b.mp4', width: 640, height: 480, fps: 30 },
        { path: '/scratch/c.mp4', width: 640, height: 480, fps: 30 },
      ],
      '/scratch/out.mp4',
    );

    expect(args).toEqual(expect.arrayContaining(['-i', '/scratch/a.mp4', '-i', '/scratch/b.mp4', '-i', '/scratch/c.mp4']));
    const filterComplex = args[args.indexOf('-filter_complex') + 1];
    expect(filterComplex).toContain('[v0][0:a][v1][1:a][v2][2:a]concat=n=3:v=1:a=1[vcat][acat]');
  });

  it('defaults the VAAPI device to /dev/dri/renderD128 when not specified', () => {
    const args = buildConcatArgs(
      [
        { path: '/scratch/a.mp4', width: 640, height: 480, fps: 30 },
        { path: '/scratch/b.mp4', width: 640, height: 480, fps: 30 },
      ],
      '/scratch/out.mp4',
    );
    expect(args).toContain('vaapi=va:/dev/dri/renderD128');
  });
});
