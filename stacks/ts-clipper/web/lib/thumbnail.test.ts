import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildThumbnailArgs,
  ensureThumbnail,
  removeThumbnails,
  roundToThumbnailSecond,
  thumbnailPath,
} from './thumbnail';

describe('roundToThumbnailSecond', () => {
  it('rounds to the nearest whole second', () => {
    expect(roundToThumbnailSecond(12.4)).toBe(12);
    expect(roundToThumbnailSecond(12.6)).toBe(13);
  });

  it('clamps negative values to 0', () => {
    expect(roundToThumbnailSecond(-3)).toBe(0);
  });
});

describe('thumbnailPath', () => {
  it('builds a cache path keyed by id and rounded second', () => {
    expect(thumbnailPath('abc', 42, '/scratch')).toBe(path.join('/scratch', 'abc-thumb-42.jpg'));
  });
});

describe('buildThumbnailArgs', () => {
  it('extracts a single scaled frame at the given second', () => {
    const args = buildThumbnailArgs('/scratch/in.ts', 42, '/scratch/abc-thumb-42.jpg');
    expect(args).toEqual([
      '-y', '-loglevel', 'error', '-hide_banner',
      '-ss', '42',
      '-i', '/scratch/in.ts',
      '-frames:v', '1',
      '-vf', 'scale=160:-1',
      '-q:v', '4',
      '/scratch/abc-thumb-42.jpg',
    ]);
  });
});

describe('ensureThumbnail', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ts-clipper-thumb-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the existing cached file without regenerating it', async () => {
    const cached = thumbnailPath('abc', 10, dir);
    await writeFile(cached, 'already-generated');

    const result = await ensureThumbnail('/does/not/exist.ts', 'abc', 10, dir);

    expect(result).toBe(cached);
  });
});

describe('removeThumbnails', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ts-clipper-thumb-rm-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('removes only thumbnails belonging to the given id', async () => {
    await writeFile(thumbnailPath('abc', 5, dir), 'a');
    await writeFile(thumbnailPath('abc', 10, dir), 'a');
    await writeFile(thumbnailPath('def', 5, dir), 'b');

    await removeThumbnails('abc', dir);

    expect((await readdir(dir)).sort()).toEqual(['def-thumb-5.jpg']);
  });

  it('does not throw when the scratch dir does not exist', async () => {
    await expect(removeThumbnails('abc', path.join(dir, 'nope'))).resolves.toBeUndefined();
  });
});
