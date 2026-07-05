import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { nodeStreamToResponseStream } from './streams';

async function readAll(stream: ReadableStream): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

describe('nodeStreamToResponseStream', () => {
  it('streams all data through and closes normally', async () => {
    const source = Readable.from([Buffer.from('hello '), Buffer.from('world')]);
    const stream = nodeStreamToResponseStream(source);

    const result = await readAll(stream);

    expect(result.toString()).toBe('hello world');
  });

  it('propagates a source error to the consumer instead of throwing uncaught', async () => {
    const source = new Readable({
      read() {
        this.destroy(new Error('boom'));
      },
    });
    const stream = nodeStreamToResponseStream(source);

    await expect(readAll(stream)).rejects.toThrow('boom');
  });

  it('destroys the underlying node stream when the consumer cancels', async () => {
    let started = false;
    const source = new Readable({
      read() {
        if (started) return;
        started = true;
        this.push(Buffer.from('a'));
        // Deliberately never push(null) — proves cancel() tears the stream
        // down instead of it hanging around waiting for more reads.
      },
    });
    const destroySpy = vi.spyOn(source, 'destroy');
    const stream = nodeStreamToResponseStream(source);

    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();

    expect(destroySpy).toHaveBeenCalled();
  });

  it('invokes the onCancel callback in addition to destroying the stream', async () => {
    let started = false;
    const source = new Readable({
      read() {
        if (started) return;
        started = true;
        this.push(Buffer.from('a'));
      },
    });
    const onCancel = vi.fn();
    const stream = nodeStreamToResponseStream(source, onCancel);

    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
