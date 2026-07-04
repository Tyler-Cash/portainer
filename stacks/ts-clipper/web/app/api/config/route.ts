import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export function GET() {
  const fastPreviewEnabled = process.env.FAST_PREVIEW_ENABLED !== 'false';
  return NextResponse.json({ fastPreviewEnabled });
}
