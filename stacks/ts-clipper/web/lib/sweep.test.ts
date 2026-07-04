import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sweepScratchDir } from './sweep';

describe('sweepScratchDir', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ts-clipper-sweep-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('removes files older than maxAgeMs and keeps recent ones', async () => {
    const oldFile = path.join(dir, 'old.ts');
    const newFile = path.join(dir, 'new.ts');
    await writeFile(oldFile, 'data');
    await writeFile(newFile, 'data');

    const now = Date.now();
    const oldTime = new Date(now - 2 * 24 * 60 * 60 * 1000);
    await utimes(oldFile, oldTime, oldTime);

    const removed = await sweepScratchDir(dir, 24 * 60 * 60 * 1000, now);

    expect(removed).toEqual(['old.ts']);
    expect(await readdir(dir)).toEqual(['new.ts']);
  });

  it('returns an empty array when the scratch dir does not exist', async () => {
    const removed = await sweepScratchDir(path.join(dir, 'missing'), 1000, Date.now());
    expect(removed).toEqual([]);
  });
});
