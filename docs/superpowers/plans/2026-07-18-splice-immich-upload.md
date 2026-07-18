# Splice → Immich Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After Splice's full-quality clip upload to Zipline succeeds, also push the same clip to Immich as a full-size asset — best-effort, non-blocking to the Zipline result, with any failure surfaced to the UI as a small secondary message.

**Architecture:** New `lib/immich.ts` module (mirrors the existing `lib/zipline.ts` pattern: `requireEnv`, a single upload function, thrown errors on failure). `app/api/clip/route.ts` calls it in a try/catch after the Zipline upload succeeds and folds any failure into the JSON response as `immichError` rather than failing the request. `app/page.tsx` renders `immichError` as a secondary line under the existing Zipline link.

**Tech Stack:** Next.js 16 App Router (Route Handlers), TypeScript, Vitest for unit tests. This is Part 1 of `docs/superpowers/specs/2026-07-18-immich-classifier-design.md` — Part 2 (the n8n classifier workflow) is a separate plan.

---

### Task 1: `lib/immich.ts` — upload function with tests

**Files:**
- Create: `stacks/ts-clipper/web/lib/immich.ts`
- Test: `stacks/ts-clipper/web/lib/immich.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// stacks/ts-clipper/web/lib/immich.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { uploadToImmich } from './immich';

describe('uploadToImmich', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ts-clipper-immich-'));
    filePath = path.join(dir, 'clip.mp4');
    await writeFile(filePath, 'fake video bytes');
    process.env.IMMICH_URL = 'https://photos.example.com';
    process.env.IMMICH_API_KEY = 'test-api-key';
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    delete process.env.IMMICH_URL;
    delete process.env.IMMICH_API_KEY;
    vi.unstubAllGlobals();
  });

  it('posts the file to Immich and returns the asset id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'asset-123' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await uploadToImmich(filePath, 'clip.mp4');

    expect(result).toEqual({ id: 'asset-123' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe('https://photos.example.com/api/assets');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'x-api-key': 'test-api-key' });
  });

  it('throws when the Immich response is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' }),
    );

    await expect(uploadToImmich(filePath, 'clip.mp4')).rejects.toThrow('Immich upload failed');
  });

  it('throws when the response has no usable asset id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
    );

    await expect(uploadToImmich(filePath, 'clip.mp4')).rejects.toThrow('missing asset id');
  });

  it('throws when IMMICH_API_KEY is missing', async () => {
    delete process.env.IMMICH_API_KEY;
    await expect(uploadToImmich(filePath, 'clip.mp4')).rejects.toThrow('IMMICH_API_KEY');
  });

  it('throws when IMMICH_URL is missing', async () => {
    delete process.env.IMMICH_URL;
    await expect(uploadToImmich(filePath, 'clip.mp4')).rejects.toThrow('IMMICH_URL');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd stacks/ts-clipper/web && npx vitest run lib/immich.test.ts`
Expected: FAIL — `Cannot find module './immich'` (the module doesn't exist yet).

- [ ] **Step 3: Write the implementation**

```typescript
// stacks/ts-clipper/web/lib/immich.ts
import { readFile } from 'node:fs/promises';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export interface ImmichUploadResult {
  id: string;
}

export async function uploadToImmich(
  filePath: string,
  filename: string,
): Promise<ImmichUploadResult> {
  const apiKey = requireEnv('IMMICH_API_KEY');
  const baseUrl = requireEnv('IMMICH_URL');

  const buffer = await readFile(filePath);
  const form = new FormData();
  form.append('assetData', new Blob([buffer], { type: 'video/mp4' }), filename);
  form.append('deviceAssetId', filename);
  form.append('deviceId', 'ts-clipper');
  form.append('fileCreatedAt', new Date().toISOString());
  form.append('fileModifiedAt', new Date().toISOString());

  const res = await fetch(`${baseUrl}/api/assets`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey },
    body: form,
  });

  if (!res.ok) {
    throw new Error(`Immich upload failed: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as { id?: string };
  if (!json.id) {
    throw new Error('Immich response missing asset id');
  }
  return { id: json.id };
}
```

Note: `deviceAssetId`/`deviceId`/`fileCreatedAt`/`fileModifiedAt` are required fields on Immich's `POST /api/assets` endpoint as of the version pinned in `stacks/photo/docker-compose.yml` (`v2.7.5`) — confirm against that version's OpenAPI spec (`https://photos.tylercash.dev/api/spec.json` once deployed, or the `immich-app/immich` repo tag `v2.7.5`) before deploying; adjust field names here if the schema differs. The test in Step 1 only asserts on the URL/method/headers/response handling, not the exact form field set, so it won't catch a schema mismatch — this is a real-Immich verification item, not a unit-test gap.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd stacks/ts-clipper/web && npx vitest run lib/immich.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
cd /home/tcash/code/portainer
git add stacks/ts-clipper/web/lib/immich.ts stacks/ts-clipper/web/lib/immich.test.ts
git commit -m "feat(ts-clipper): add Immich upload helper"
```

---

### Task 2: Wire Immich upload into `/api/clip`, non-blocking

**Files:**
- Modify: `stacks/ts-clipper/web/app/api/clip/route.ts:1-74`

- [ ] **Step 1: Update the route**

Add the import and call the new helper after the Zipline upload succeeds, catching any failure into `immichError` without affecting the response status or the Zipline result:

```typescript
// stacks/ts-clipper/web/app/api/clip/route.ts
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { NextRequest, NextResponse } from 'next/server';
import { clipPath, findSourceFile, isValidId } from '@/lib/paths';
import { runClip, runFastClip } from '@/lib/ffmpeg';
import { deleteFromZipline, uploadToZipline } from '@/lib/zipline';
import { uploadToImmich } from '@/lib/immich';

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

    let immichError: string | undefined;
    if (clipMode === 'full') {
      try {
        await uploadToImmich(output, `${outputId}.mp4`);
      } catch (err) {
        immichError = (err as Error).message;
        console.error(`Immich upload failed for clip ${outputId}:`, err);
      }
    }

    await unlink(output);

    if (supersedesZiplineId) {
      // The fast preview has now been superseded by this (better-quality or
      // final) upload — best-effort cleanup, doesn't fail the request if it
      // doesn't work out.
      await deleteFromZipline(supersedesZiplineId).catch((err) => {
        console.error(`Failed to delete superseded Zipline file ${supersedesZiplineId}:`, err);
      });
    }

    return NextResponse.json({ url, ziplineId, mode: clipMode, immichError });
  } catch (err) {
    return NextResponse.json(
      { error: `Zipline upload failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }
}
```

Note the Immich upload runs against `output` **before** it's deleted, and only for `mode === 'full'` (fast-preview clips are never pushed to Immich, per the spec).

- [ ] **Step 2: Type-check**

Run: `cd stacks/ts-clipper/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /home/tcash/code/portainer
git add stacks/ts-clipper/web/app/api/clip/route.ts
git commit -m "feat(ts-clipper): push full-quality clips to Immich, non-blocking"
```

---

### Task 3: Surface `immichError` in the UI

**Files:**
- Modify: `stacks/ts-clipper/web/app/page.tsx:13-21` (interface), `:359-368` (response handling), `:567-579` (render)

- [ ] **Step 1: Add `immichError` to `QueuedClip`**

```typescript
// stacks/ts-clipper/web/app/page.tsx:13-21
interface QueuedClip {
  clipId: string;
  start: number;
  end: number;
  removeAudio: boolean;
  status: 'pending' | 'processing' | 'fast-ready' | 'done' | 'error';
  url?: string;
  error?: string;
  immichError?: string;
}
```

- [ ] **Step 2: Capture `immichError` from the `/api/clip` response**

```typescript
// stacks/ts-clipper/web/app/page.tsx:359-368 — replace the existing block
      const json = await res.json();
      if (!res.ok) {
        setClips((prev) =>
          prev.map((c) => (c.clipId === clip.clipId ? { ...c, status: 'error', error: json.error } : c)),
        );
        return;
      }
      setClips((prev) =>
        prev.map((c) =>
          c.clipId === clip.clipId
            ? { ...c, status: 'done', url: json.url, immichError: json.immichError }
            : c,
        ),
      );
```

- [ ] **Step 3: Render it under the Zipline link**

```tsx
// stacks/ts-clipper/web/app/page.tsx:567-579 — replace the existing 'done' block
                      {clip.status === 'done' && clip.url && (
                        <>
                          <a href={clip.url} target="_blank" rel="noopener noreferrer">
                            {clip.url}
                          </a>
                          <button
                            type="button"
                            onClick={() => navigator.clipboard.writeText(clip.url!)}
                          >
                            Copy
                          </button>
                          {clip.immichError && (
                            <span className="error">Immich upload failed: {clip.immichError}</span>
                          )}
                        </>
                      )}
```

- [ ] **Step 4: Type-check**

Run: `cd stacks/ts-clipper/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Manual verification**

Run: `cd stacks/ts-clipper/web && npm run dev`, open `http://localhost:3000`, upload a short test clip, trim, click "Clip & Upload" (or the queue equivalent). Since `IMMICH_URL`/`IMMICH_API_KEY` won't be set in local dev, confirm the Zipline link still appears and an "Immich upload failed: IMMICH_URL is not set" message appears beneath it, without the overall flow erroring out.

- [ ] **Step 6: Commit**

```bash
cd /home/tcash/code/portainer
git add stacks/ts-clipper/web/app/page.tsx
git commit -m "feat(ts-clipper): show Immich upload errors in the UI"
```

---

### Task 4: Config — compose file and secrets

**Files:**
- Modify: `stacks/ts-clipper/docker-compose.yml:15-20`

- [ ] **Step 1: Add the new env vars**

```yaml
# stacks/ts-clipper/docker-compose.yml — environment block
    environment:
      - SCRATCH_DIR=/app/scratch
      - ZIPLINE_URL=https://video.tylercash.dev
      - ZIPLINE_TOKEN=${ZIPLINE_TOKEN}
      - FAST_PREVIEW_ENABLED=true
      - VAAPI_DEVICE=/dev/dri/renderD128
      - IMMICH_URL=https://photos.tylercash.dev
      - IMMICH_API_KEY=${IMMICH_API_KEY}
```

- [ ] **Step 2: Validate the compose YAML**

Run: `cd /home/tcash/code/portainer && npx -y js-yaml stacks/ts-clipper/docker-compose.yml`
Expected: parses without error, prints the parsed YAML.

- [ ] **Step 3: Add the secret**

Run: `task edit STACK=ts-clipper` and add `IMMICH_API_KEY=<key generated from Immich's user settings page>` to the SOPS-encrypted `.env.secret`. This opens the file through SOPS per repo convention — do not hand-edit `.env.secret` directly.

- [ ] **Step 4: Commit**

```bash
cd /home/tcash/code/portainer
git add stacks/ts-clipper/docker-compose.yml stacks/ts-clipper/.env.secret
git commit -m "chore(ts-clipper): add Immich API config"
```

---

## Self-Review Notes

- **Spec coverage:** "Splice change is small" (upload call, no classification) → Task 1–2. "Frontend renders immichError" → Task 3. "Config: IMMICH_URL, IMMICH_API_KEY" → Task 4. "Failure doesn't affect Zipline result or HTTP status" → Task 2's try/catch structure. "Only the full-quality pass" → Task 2's `if (clipMode === 'full')` guard.
- **Type consistency:** `uploadToImmich(filePath, filename)` signature matches its one call site in Task 2. `immichError?: string` on the JSON response (Task 2) matches the `QueuedClip.immichError?: string` field and its usage (Task 3).
- **Open item carried forward, not a placeholder:** the exact Immich `POST /api/assets` multipart field names (Task 1, Step 3 note) need confirming against the live/deployed Immich version before this ships — flagged explicitly with how to check, not left vague.
