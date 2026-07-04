import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { NextRequest, NextResponse } from 'next/server';
import { ACCEPTED_EXTENSIONS, SCRATCH_DIR, isAcceptedExtension } from '@/lib/paths';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const filename = request.headers.get('x-filename');
  if (!filename || !isAcceptedExtension(filename)) {
    return NextResponse.json(
      { error: `Unsupported file type. Accepted: ${ACCEPTED_EXTENSIONS.join(', ')}` },
      { status: 400 },
    );
  }
  if (!request.body) {
    return NextResponse.json({ error: 'Missing request body' }, { status: 400 });
  }

  const id = randomUUID();
  const ext = path.extname(filename).toLowerCase();
  const destPath = path.join(SCRATCH_DIR, `${id}${ext}`);

  await mkdir(SCRATCH_DIR, { recursive: true });

  try {
    await pipeline(Readable.fromWeb(request.body as never), createWriteStream(destPath));
  } catch (err) {
    return NextResponse.json(
      { error: `Upload failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ id });
}
