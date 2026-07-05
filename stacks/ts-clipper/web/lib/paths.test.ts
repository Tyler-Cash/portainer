import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clipPath, findSourceFile, isAcceptedExtension, isValidId } from './paths';

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
  it('accepts common video container extensions, case-insensitively', () => {
    expect(isAcceptedExtension('clip.ts')).toBe(true);
    expect(isAcceptedExtension('CLIP.MP4')).toBe(true);
    expect(isAcceptedExtension('clip.m2ts')).toBe(true);
    expect(isAcceptedExtension('clip.webm')).toBe(true);
    expect(isAcceptedExtension('clip.m4v')).toBe(true);
    expect(isAcceptedExtension('clip.mkv')).toBe(true);
    expect(isAcceptedExtension('clip.mov')).toBe(true);
    expect(isAcceptedExtension('clip.avi')).toBe(true);
  });

  it('rejects non-video extensions', () => {
    expect(isAcceptedExtension('clip.exe')).toBe(false);
    expect(isAcceptedExtension('clip.txt')).toBe(false);
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
