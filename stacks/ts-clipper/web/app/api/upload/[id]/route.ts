import { unlink } from 'node:fs/promises';
import { NextRequest, NextResponse } from 'next/server';
import { getVideoCodec } from '@/lib/ffprobe';
import { findSourceFile, isValidId } from '@/lib/paths';
import { decodeModeForCodec, spawnRemux } from '@/lib/remux';
import { nodeStreamToResponseStream } from '@/lib/streams';
import { removeThumbnails } from '@/lib/thumbnail';

export const runtime = 'nodejs';

// Live-remuxes the source to fragmented MP4 via ffmpeg (VAAPI re-encode to
// H.264/AAC, not a stream copy) so any browser can play it natively,
// regardless of the source container/codec. The decode is done on the iGPU
// for codecs it supports and in software (uploaded to the GPU) otherwise —
// e.g. AV1, which would otherwise fail and leave the preview blank. There's
// no fixed byte length for a live pipe, so this doesn't support Range
// requests — seeking is instead done by the client re-requesting with a new
// ?start= and reloading the video element, which restarts ffmpeg from that
// point in the source.
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

  // Pick hw vs software decode from the source codec before spawning: a live
  // pipe can't be retried once bytes start flowing, so we can't fall back on
  // a hw-decode failure the way the clip path does.
  const codec = await getVideoCodec(filePath).catch(() => '');
  const decode = decodeModeForCodec(codec);

  const child = spawnRemux(filePath, startSeconds, decode);
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
