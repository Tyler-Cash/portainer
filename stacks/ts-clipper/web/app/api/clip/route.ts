import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { NextRequest, NextResponse } from 'next/server';
import { clipPath, findSourceFile, isValidId } from '@/lib/paths';
import { runClip, runFastClip } from '@/lib/ffmpeg';
import { deleteFromZipline, uploadToZipline } from '@/lib/zipline';

export const runtime = 'nodejs';

interface ClipRequestBody {
  id?: string;
  start?: number;
  end?: number;
  removeAudio?: boolean;
  mode?: 'fast' | 'full';
  supersedesZiplineId?: string;
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as ClipRequestBody;
  const { id, start, end, removeAudio, mode, supersedesZiplineId } = body;

  if (!id || !isValidId(id)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }
  if (typeof start !== 'number' || typeof end !== 'number' || !(start >= 0) || !(end > start)) {
    return NextResponse.json({ error: 'Invalid start/end' }, { status: 400 });
  }

  const source = await findSourceFile(id);
  if (!source) {
    return NextResponse.json({ error: 'Source file not found' }, { status: 404 });
  }

  const clipMode = mode === 'fast' ? 'fast' : 'full';

  // Each clip request gets its own output id — a source can be clipped
  // multiple times (and clipped twice per request, fast then full), so the
  // output can't share the source's id.
  const outputId = randomUUID();
  const output = clipPath(outputId);

  try {
    if (clipMode === 'fast') {
      await runFastClip(source, output, { start, end, removeAudio: Boolean(removeAudio) });
    } else {
      await runClip(source, output, { start, end, removeAudio: Boolean(removeAudio) });
    }
  } catch (err) {
    await unlink(output).catch(() => {});
    return NextResponse.json({ error: `Clip failed: ${(err as Error).message}` }, { status: 500 });
  }

  try {
    const { url, id: ziplineId } = await uploadToZipline(output, `${outputId}.mp4`);
    await unlink(output);

    if (supersedesZiplineId) {
      // The fast preview has now been superseded by this (better-quality or
      // final) upload — best-effort cleanup, doesn't fail the request if it
      // doesn't work out.
      await deleteFromZipline(supersedesZiplineId).catch((err) => {
        console.error(`Failed to delete superseded Zipline file ${supersedesZiplineId}:`, err);
      });
    }

    return NextResponse.json({ url, ziplineId, mode: clipMode });
  } catch (err) {
    return NextResponse.json(
      { error: `Zipline upload failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }
}
