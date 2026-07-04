import { createReadStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { NextRequest, NextResponse } from 'next/server';
import { findSourceFile, isValidId, mimeTypeFor } from '@/lib/paths';
import { resolveRange } from '@/lib/range';

export const runtime = 'nodejs';

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
    const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
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
  const stream = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream;

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
