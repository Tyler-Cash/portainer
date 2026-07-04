import { describe, expect, it } from 'vitest';
import { buildFfmpegArgs } from './ffmpeg';

describe('buildFfmpegArgs', () => {
  it('builds a stream-copy trim that keeps audio', () => {
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

  it('uses a software re-encode with audio in reencode mode', () => {
    const args = buildFfmpegArgs(
      '/scratch/in.ts',
      '/scratch/out.mp4',
      { start: 0, end: 10, removeAudio: false },
      'reencode',
    );
    expect(args).toEqual([
      '-y', '-ss', '0', '-to', '10', '-i', '/scratch/in.ts',
      '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '/scratch/out.mp4',
    ]);
  });

  it('uses a software re-encode without audio in reencode mode when removeAudio is set', () => {
    const args = buildFfmpegArgs(
      '/scratch/in.ts',
      '/scratch/out.mp4',
      { start: 0, end: 10, removeAudio: true },
      'reencode',
    );
    expect(args).toEqual([
      '-y', '-ss', '0', '-to', '10', '-i', '/scratch/in.ts',
      '-c:v', 'libx264', '-preset', 'veryfast', '-an', '/scratch/out.mp4',
    ]);
  });

  it('downscales and uses the fastest preset in fast mode, with audio', () => {
    const args = buildFfmpegArgs(
      '/scratch/in.ts',
      '/scratch/out.mp4',
      { start: 0, end: 10, removeAudio: false },
      'fast',
    );
    expect(args).toEqual([
      '-y', '-ss', '0', '-to', '10', '-i', '/scratch/in.ts',
      '-vf', 'scale=-2:480', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '32',
      '-c:a', 'aac', '-b:a', '64k', '/scratch/out.mp4',
    ]);
  });

  it('drops audio in fast mode when removeAudio is set', () => {
    const args = buildFfmpegArgs(
      '/scratch/in.ts',
      '/scratch/out.mp4',
      { start: 0, end: 10, removeAudio: true },
      'fast',
    );
    expect(args).toEqual([
      '-y', '-ss', '0', '-to', '10', '-i', '/scratch/in.ts',
      '-vf', 'scale=-2:480', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '32',
      '-an', '/scratch/out.mp4',
    ]);
  });
});
