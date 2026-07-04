import { unlink } from 'node:fs/promises';
import { NextRequest, NextResponse } from 'next/server';
import { clipPath, findSourceFile, isValidId } from '@/lib/paths';
import { runClip } from '@/lib/ffmpeg';
import { uploadToZipline } from '@/lib/zipline';

export const runtime = 'nodejs';

interface ClipRequestBody {
  id?: string;
  start?: number;
  end?: number;
  removeAudio?: boolean;
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as ClipRequestBody;
  const { id, start, end, removeAudio } = body;

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

  const output = clipPath(id);

  try {
    await runClip(source, output, { start, end, removeAudio: Boolean(removeAudio) });
  } catch (err) {
    return NextResponse.json({ error: `Clip failed: ${(err as Error).message}` }, { status: 500 });
  }

  try {
    const url = await uploadToZipline(output, `${id}.mp4`);
    await unlink(source);
    await unlink(output);
    return NextResponse.json({ url });
  } catch (err) {
    return NextResponse.json(
      { error: `Zipline upload failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }
}
