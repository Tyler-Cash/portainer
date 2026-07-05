import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { NextRequest, NextResponse } from 'next/server';
import { buildConcatArgs } from '@/lib/concat';
import { getMetadata, hasAudioStream } from '@/lib/ffprobe';
import { findSourceFile, isValidId, SCRATCH_DIR } from '@/lib/paths';

const execFileAsync = promisify(execFile);

export const runtime = 'nodejs';

interface MergeRequestBody {
  ids?: string[];
}

// Multiple files uploaded together are stitched into one video, in the
// order given, so the rest of the app only ever deals with a single
// source — clipping, previewing, and thumbnailing don't need to know a
// merge ever happened.
export async function POST(request: NextRequest) {
  const body = (await request.json()) as MergeRequestBody;
  const ids = body.ids;

  if (!Array.isArray(ids) || ids.length < 2 || ids.some((id) => !isValidId(id))) {
    return NextResponse.json({ error: 'Provide at least two valid source ids to merge' }, { status: 400 });
  }

  const sources = await Promise.all(ids.map((id) => findSourceFile(id)));
  const missingIndex = sources.findIndex((source) => !source);
  if (missingIndex !== -1) {
    return NextResponse.json({ error: `Source not found: ${ids[missingIndex]}` }, { status: 404 });
  }

  const inputs = [];
  for (const source of sources as string[]) {
    const meta = await getMetadata(source);
    if (meta.width <= 0 || meta.height <= 0) {
      return NextResponse.json(
        { error: `Could not read video dimensions for ${path.basename(source)}` },
        { status: 400 },
      );
    }
    const hasAudio = await hasAudioStream(source).catch(() => false);
    inputs.push({
      path: source,
      width: meta.width,
      height: meta.height,
      fps: meta.fps,
      duration: meta.duration,
      hasAudio,
    });
  }

  const mergedId = randomUUID();
  const outputPath = path.join(SCRATCH_DIR, `${mergedId}.mp4`);

  try {
    await execFileAsync('ffmpeg', buildConcatArgs(inputs, outputPath));
  } catch (err) {
    await unlink(outputPath).catch(() => {});
    return NextResponse.json({ error: `Merge failed: ${(err as Error).message}` }, { status: 500 });
  }

  // The individual uploads are now folded into the merged file.
  await Promise.all((sources as string[]).map((source) => unlink(source).catch(() => {})));

  const { duration, fps } = await getMetadata(outputPath).catch(() => ({
    duration: 0,
    fps: 0,
    width: 0,
    height: 0,
  }));

  return NextResponse.json({ id: mergedId, duration, fps });
}
