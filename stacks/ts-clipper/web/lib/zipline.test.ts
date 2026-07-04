import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { uploadToZipline } from './zipline';

describe('uploadToZipline', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ts-clipper-zipline-'));
    filePath = path.join(dir, 'clip.mp4');
    await writeFile(filePath, 'fake video bytes');
    process.env.ZIPLINE_TOKEN = 'test-token';
    process.env.ZIPLINE_URL = 'https://video.example.com';
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    delete process.env.ZIPLINE_TOKEN;
    delete process.env.ZIPLINE_URL;
    vi.unstubAllGlobals();
  });

  it('posts the file to Zipline and returns the share url', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ files: [{ url: 'https://video.example.com/u/abc' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const url = await uploadToZipline(filePath, 'clip.mp4');

    expect(url).toBe('https://video.example.com/u/abc');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe('https://video.example.com/api/upload');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ authorization: 'test-token' });
  });

  it('throws when the Zipline response is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' }),
    );

    await expect(uploadToZipline(filePath, 'clip.mp4')).rejects.toThrow('Zipline upload failed');
  });

  it('throws when the response has no usable file url', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ files: [] }) }),
    );

    await expect(uploadToZipline(filePath, 'clip.mp4')).rejects.toThrow('missing file url');
  });

  it('throws when ZIPLINE_TOKEN is missing', async () => {
    delete process.env.ZIPLINE_TOKEN;
    await expect(uploadToZipline(filePath, 'clip.mp4')).rejects.toThrow('ZIPLINE_TOKEN');
  });

  it('throws when ZIPLINE_URL is missing', async () => {
    delete process.env.ZIPLINE_URL;
    await expect(uploadToZipline(filePath, 'clip.mp4')).rejects.toThrow('ZIPLINE_URL');
  });
});
