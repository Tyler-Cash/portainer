import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clipPath, findSourceFile, isAcceptedExtension, isValidId, mimeTypeFor } from './paths';

describe('isValidId', () => {
  it('accepts a well-formed uuid', () => {
    expect(isValidId('3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBe(true);
  });

  it('rejects path traversal attempts and malformed ids', () => {
    expect(isValidId('../../etc/passwd')).toBe(false);
    expect(isValidId('not-a-uuid')).toBe(false);
    expect(isValidId('')).toBe(false);
  });
});

describe('isAcceptedExtension', () => {
  it('accepts supported video extensions, case-insensitively', () => {
    expect(isAcceptedExtension('clip.ts')).toBe(true);
    expect(isAcceptedExtension('CLIP.MP4')).toBe(true);
    expect(isAcceptedExtension('clip.m2ts')).toBe(true);
    expect(isAcceptedExtension('clip.webm')).toBe(true);
    expect(isAcceptedExtension('clip.m4v')).toBe(true);
  });

  it('rejects unsupported extensions', () => {
    expect(isAcceptedExtension('clip.mkv')).toBe(false);
    expect(isAcceptedExtension('clip.mov')).toBe(false);
    expect(isAcceptedExtension('clip.exe')).toBe(false);
  });
});

describe('mimeTypeFor', () => {
  it('maps known extensions to their mime type', () => {
    expect(mimeTypeFor('a.ts')).toBe('video/mp2t');
    expect(mimeTypeFor('a.m2ts')).toBe('video/mp2t');
    expect(mimeTypeFor('a.mp4')).toBe('video/mp4');
    expect(mimeTypeFor('a.m4v')).toBe('video/mp4');
    expect(mimeTypeFor('a.webm')).toBe('video/webm');
  });

  it('falls back to application/octet-stream for unknown extensions', () => {
    expect(mimeTypeFor('a.bin')).toBe('application/octet-stream');
  });
});

describe('clipPath', () => {
  it('builds the trimmed output path for an id under the given scratch dir', () => {
    expect(clipPath('abc', '/scratch')).toBe(path.join('/scratch', 'abc-clip.mp4'));
  });
});

describe('findSourceFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ts-clipper-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds the uploaded source file by id prefix', async () => {
    await writeFile(path.join(dir, 'abc.mp4'), 'data');
    expect(await findSourceFile('abc', dir)).toBe(path.join(dir, 'abc.mp4'));
  });

  it('does not match the trimmed clip output for the same id', async () => {
    await writeFile(path.join(dir, 'abc-clip.mp4'), 'data');
    expect(await findSourceFile('abc', dir)).toBeNull();
  });

  it('returns null when nothing matches', async () => {
    expect(await findSourceFile('missing', dir)).toBeNull();
  });

  it('returns null when the scratch dir does not exist', async () => {
    expect(await findSourceFile('abc', path.join(dir, 'nope'))).toBeNull();
  });
});
