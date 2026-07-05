import { readFile } from 'node:fs/promises';
import { NextRequest, NextResponse } from 'next/server';
import { findSourceFile, isValidId } from '@/lib/paths';
import { ensureThumbnail } from '@/lib/thumbnail';

export const runtime = 'nodejs';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidId(id)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const source = await findSourceFile(id);
  if (!source) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const tParam = Number(request.nextUrl.searchParams.get('t') ?? '0');
  const seconds = Number.isFinite(tParam) && tParam > 0 ? tParam : 0;

  try {
    const thumbPath = await ensureThumbnail(source, id, seconds);
    const buffer = await readFile(thumbPath);
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'content-type': 'image/jpeg',
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Thumbnail generation failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}
