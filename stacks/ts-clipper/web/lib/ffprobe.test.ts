import { describe, expect, it } from 'vitest';
import { parseDurationOutput } from './ffprobe';

describe('parseDurationOutput', () => {
  it('parses a valid duration in seconds', () => {
    expect(parseDurationOutput('123.456000\n')).toBe(123.456);
  });

  it('falls back to 0 for empty output', () => {
    expect(parseDurationOutput('')).toBe(0);
  });

  it('falls back to 0 for non-numeric output', () => {
    expect(parseDurationOutput('N/A\n')).toBe(0);
  });
});
