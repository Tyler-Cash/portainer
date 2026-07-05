import { describe, expect, it } from 'vitest';
import { parseMetadataOutput } from './ffprobe';

describe('parseMetadataOutput', () => {
  it('parses duration, a fractional frame rate, and dimensions', () => {
    const stdout = JSON.stringify({
      format: { duration: '123.456000' },
      streams: [{ r_frame_rate: '30000/1001', width: 1920, height: 1080 }],
    });
    const result = parseMetadataOutput(stdout);
    expect(result.duration).toBe(123.456);
    expect(result.fps).toBeCloseTo(29.97, 2);
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
  });

  it('parses a whole-number frame rate expressed as N/1', () => {
    const stdout = JSON.stringify({
      format: { duration: '10' },
      streams: [{ r_frame_rate: '25/1', width: 1280, height: 720 }],
    });
    expect(parseMetadataOutput(stdout)).toEqual({ duration: 10, fps: 25, width: 1280, height: 720 });
  });

  it('falls back to 0 for missing fields', () => {
    expect(parseMetadataOutput(JSON.stringify({}))).toEqual({ duration: 0, fps: 0, width: 0, height: 0 });
  });

  it('falls back to 0 for unparseable output', () => {
    expect(parseMetadataOutput('not json')).toEqual({ duration: 0, fps: 0, width: 0, height: 0 });
  });

  it('treats a zero denominator frame rate as unknown', () => {
    const stdout = JSON.stringify({
      format: { duration: '5' },
      streams: [{ r_frame_rate: '0/0', width: 640, height: 480 }],
    });
    expect(parseMetadataOutput(stdout)).toEqual({ duration: 5, fps: 0, width: 640, height: 480 });
  });
});
