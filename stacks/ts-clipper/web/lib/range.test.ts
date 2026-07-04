import { describe, expect, it } from 'vitest';
import { resolveRange } from './range';

describe('resolveRange', () => {
  it('returns null when there is no range header', () => {
    expect(resolveRange(null, 1000)).toBeNull();
  });

  it('resolves an open-ended range to the end of the file', () => {
    expect(resolveRange('bytes=100-', 1000)).toEqual({ start: 100, end: 999 });
  });

  it('resolves a bounded range within the file', () => {
    expect(resolveRange('bytes=100-199', 1000)).toEqual({ start: 100, end: 199 });
  });

  it('clamps an end beyond the file size instead of overpromising bytes', () => {
    expect(resolveRange('bytes=900-999999', 1000)).toEqual({ start: 900, end: 999 });
  });

  it('is unsatisfiable when start is at or beyond the file size', () => {
    expect(resolveRange('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(resolveRange('bytes=5000-6000', 1000)).toBe('unsatisfiable');
  });

  it('is unsatisfiable when the header does not match the expected format', () => {
    expect(resolveRange('bytes=abc-def', 1000)).toBe('unsatisfiable');
  });
});
