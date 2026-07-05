import { createReadStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { NextRequest, NextResponse } from 'next/server';
import { findSourceFile, isValidId, mimeTypeFor } from '@/lib/paths';
import { resolveRange } from '@/lib/range';

export const runtime = 'nodejs';

// A video player doing range-based seeking routinely aborts in-flight
// requests (it cancels the previous byte range as soon as it starts a new
// one). That leaves the underlying fs stream's 'error' event with no
// listener, which Node reports as an uncaught exception even though the
// client disconnect itself is completely normal — attach a no-op listener
// so it's just dropped instead of crashing/logging as a real failure.
function toResponseStream(nodeStream: Readable): ReadableStream {
  nodeStream.on('error', () => {});
  return Readable.toWeb(nodeStream) as ReadableStream;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidId(id)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const filePath = await findSourceFile(id);
  if (!filePath) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { size } = await stat(filePath);
  const contentType = mimeTypeFor(filePath);
  const range = resolveRange(request.headers.get('range'), size);

  if (range === 'unsatisfiable') {
    return new NextResponse(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
  }

  if (!range) {
    const stream = toResponseStream(createReadStream(filePath));
    return new NextResponse(stream, {
      status: 200,
      headers: {
        'content-type': contentType,
        'content-length': String(size),
        'accept-ranges': 'bytes',
      },
    });
  }

  const { start, end } = range;
  const stream = toResponseStream(createReadStream(filePath, { start, end }));

  return new NextResponse(stream, {
    status: 206,
    headers: {
      'content-type': contentType,
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${size}`,
      'accept-ranges': 'bytes',
    },
  });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidId(id)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const filePath = await findSourceFile(id);
  if (filePath) {
    await unlink(filePath);
  }

  return NextResponse.json({ ok: true });
}
