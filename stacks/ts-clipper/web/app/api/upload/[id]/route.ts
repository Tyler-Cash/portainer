import { unlink } from 'node:fs/promises';
import { NextRequest, NextResponse } from 'next/server';
import { findSourceFile, isValidId } from '@/lib/paths';
import { spawnRemux } from '@/lib/remux';
import { nodeStreamToResponseStream } from '@/lib/streams';
import { removeThumbnails } from '@/lib/thumbnail';

export const runtime = 'nodejs';

// Live-remuxes the source to fragmented MP4 via ffmpeg (stream copy — no
// re-encode, just repackaging) so any browser can play it natively,
// regardless of the source container/codec. There's no fixed byte length
// for a live pipe, so this doesn't support Range requests — seeking is
// instead done by the client re-requesting with a new ?start= and reloading
// the video element, which restarts ffmpeg from that point in the source.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidId(id)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const filePath = await findSourceFile(id);
  if (!filePath) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const startParam = Number(request.nextUrl.searchParams.get('start') ?? '0');
  const startSeconds = Number.isFinite(startParam) && startParam > 0 ? startParam : 0;

  const child = spawnRemux(filePath, startSeconds);
  const stream = nodeStreamToResponseStream(child.stdout, () => child.kill('SIGKILL'));

  return new NextResponse(stream, {
    status: 200,
    headers: {
      'content-type': 'video/mp4',
      'cache-control': 'no-store',
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
  await removeThumbnails(id);

  return NextResponse.json({ ok: true });
}
