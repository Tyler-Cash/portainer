import { describe, expect, it } from 'vitest';
import { parseMetadataOutput } from './ffprobe';

describe('parseMetadataOutput', () => {
  it('parses duration and a fractional frame rate', () => {
    const stdout = JSON.stringify({
      format: { duration: '123.456000' },
      streams: [{ r_frame_rate: '30000/1001' }],
    });
    const result = parseMetadataOutput(stdout);
    expect(result.duration).toBe(123.456);
    expect(result.fps).toBeCloseTo(29.97, 2);
  });

  it('parses a whole-number frame rate expressed as N/1', () => {
    const stdout = JSON.stringify({
      format: { duration: '10' },
      streams: [{ r_frame_rate: '25/1' }],
    });
    expect(parseMetadataOutput(stdout)).toEqual({ duration: 10, fps: 25 });
  });

  it('falls back to 0/0 for missing fields', () => {
    expect(parseMetadataOutput(JSON.stringify({}))).toEqual({ duration: 0, fps: 0 });
  });

  it('falls back to 0/0 for unparseable output', () => {
    expect(parseMetadataOutput('not json')).toEqual({ duration: 0, fps: 0 });
  });

  it('treats a zero denominator frame rate as unknown', () => {
    const stdout = JSON.stringify({
      format: { duration: '5' },
      streams: [{ r_frame_rate: '0/0' }],
    });
    expect(parseMetadataOutput(stdout)).toEqual({ duration: 5, fps: 0 });
  });
});
