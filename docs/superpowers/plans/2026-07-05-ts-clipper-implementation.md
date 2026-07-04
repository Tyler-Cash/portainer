# ts-clipper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy `ts-clipper`, a self-hosted Next.js app at `upload.tylercash.dev` that lets you drag-drop a video (raw `.ts`/`.m2ts` DVR footage or a standard `.mp4`/`.webm`/`.m4v`), scrub to pick in/out points, optionally strip audio, and get back a Zipline share link — with both the raw upload and the trimmed clip deleted from local storage the moment the Zipline upload succeeds.

**Architecture:** One Next.js 16 App Router project (`stacks/ts-clipper/web/`) with Route Handlers doing all the work server-side: streaming the raw upload to a scratch disk, serving it back with Range support for browser preview, running `ffmpeg` to trim it (stream-copy first, software re-encode as fallback), and forwarding the result to Zipline's upload API. No database — state is just files on disk plus request/response round-trips. Deployed as its own Docker Compose stack (`stacks/ts-clipper/docker-compose.yml`) following this repo's existing conventions (see `stacks/zipline/docker-compose.yml` for the label/logging patterns being copied).

**Tech Stack:** Next.js 16 (App Router, `output: 'standalone'`), React 19, TypeScript, `mpegts.js` for in-browser MPEG-TS preview, Vitest for unit tests, ffmpeg (software, no VAAPI needed), Docker Compose, SOPS-encrypted secrets (existing repo convention).

**Testing scope note:** This plan applies TDD to the pure logic in `web/lib/` (path/id validation, ffmpeg argument building, the Zipline upload call, the scratch-dir sweep) — all fully unit-testable without a real ffmpeg binary or a real Zipline server. The Route Handlers and the UI are integration glue over that logic; they're checked with `next build`'s type-checking and, per this repo's established pattern for hardware/network-dependent work (see `docs/superpowers/plans/2026-07-04-zipline-transcoder.md`, Task 5), verified for real on the deployed host in the final task. There is no local ffmpeg, Docker, or reachable Zipline instance in this development sandbox.

---

## Context You Need

- This repo (`/home/tcash/code/portainer`) holds Portainer stack definitions under `stacks/<name>/docker-compose.yml`. Secrets go in `stacks/<name>/.env.secret`, SOPS-encrypted, edited only via `task edit STACK=<name>` (opens through `sops`, encrypts on save). Never hand-edit `.env.secret` directly.
- Design spec for this feature: `docs/superpowers/specs/2026-07-05-ts-clipper-design.md`. Read it if anything below is ambiguous — it takes precedence on intent, this plan takes precedence on exact code/commands.
- All stacks join an external network called `homelab_default` and share the same `x-logging` anchor block (json-file driver, 50m/3 files) — copied verbatim from `stacks/zipline/docker-compose.yml:1-7`.
- Traefik label convention (from `stacks/zipline/docker-compose.yml:42-50`):
  ```yaml
  labels:
    - traefik.enable=true
    - traefik.http.routers.<name>.service=<name>
    - traefik.http.routers.<name>.rule=Host(`<hostname>`)
    - traefik.http.routers.<name>.entrypoints=websecure
    - traefik.http.services.<name>.loadbalancer.server.scheme=http
    - traefik.http.services.<name>.loadbalancer.server.port=<port>
    - traefik.http.routers.<name>.tls.certresolver=leresolver
  ```
  Note: `com.centurylinklabs.watchtower.enable=true` is **omitted** here — this repo's convention (confirmed on both `stacks/github-runner` and `stacks/zipline`'s `zipline-transcoder`) is that `build:`-based services (no pulled image tag) don't carry the Watchtower label, since Watchtower has nothing to pull.
- Zipline v4 upload API (confirmed from `zipline.diced.sh/docs`): `POST /api/upload` with header `authorization: <token>` (no `Bearer` prefix) and a multipart field named `file`. Response JSON is `{ files: [{ url, ... }], ... }`.
- LAN-only access: per the user's explicit request, this router is restricted the same way `stacks/vaultwarden/docker-compose.yml:25` restricts the password manager — `ClientIP(\`10.0.0.0/8\`)` only, no `172.19.0.0/24` fallback (that second range, used by most other stacks in this repo, covers the Docker bridge network for container-to-container Traefik access; Vaultwarden and this app both deliberately omit it to stay LAN-only).
- Per `/home/tcash/code/portainer/CLAUDE.md`: any new service with a Traefik hostname must be added to `stacks/homepage/config/services.yaml`.
- Scratch disk convention: this repo already uses `/mnt/lvm_striped/download/<app>` as a per-app subfolder on the striped-SSD volume used for torrenting scratch I/O — see `stacks/music/docker-compose.yml:84` (`/mnt/lvm_striped/download/slskd`). This plan uses `/mnt/lvm_striped/download/ts-clipper` the same way, per the user's explicit choice.
- **No local Docker, ffmpeg, or reachable Zipline instance in this development sandbox.** Compose YAML is validated with `npx -y js-yaml <file>`. The Next.js app itself builds and type-checks locally (Node is available via nvm — source it first: `export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"`). Anything requiring ffmpeg, a real Docker build, or a real Zipline server is called out explicitly as "run on the docker host."
- Confirmed package versions (checked against the npm registry): `next@16.2.10`, `react@19.2.7`, `react-dom@19.2.7`, `mpegts.js@1.8.0`, `vitest@4.1.9`, `typescript@6.0.3`, `@types/node@22.20.0`, `@types/react@19.2.17`, `@types/react-dom@19.2.3`. `mpegts.js` ships its own TypeScript types (`d.ts/mpegts.d.ts`, `export default Mpegts` with `Mpegts.createPlayer(mediaDataSource, config?)` returning a `Player` with `attachMediaElement`, `load`, `destroy`) — no ambient module declaration needed.

---

## File Structure

```
stacks/ts-clipper/
├── docker-compose.yml
├── .env.secret                       # SOPS-encrypted: ZIPLINE_TOKEN (created via `task edit`)
└── web/                               # Next.js project root
    ├── package.json
    ├── package-lock.json              # generated by `npm install`
    ├── next.config.ts
    ├── tsconfig.json
    ├── next-env.d.ts
    ├── vitest.config.ts
    ├── Dockerfile
    ├── .dockerignore
    ├── instrumentation.ts             # runs the scratch-dir sweep on server start
    ├── public/
    │   └── .gitkeep
    ├── lib/
    │   ├── paths.ts                   # id validation, extension whitelist, mime types, path helpers
    │   ├── paths.test.ts
    │   ├── ffmpeg.ts                  # ffmpeg arg building + trim-with-fallback
    │   ├── ffmpeg.test.ts
    │   ├── zipline.ts                 # uploadToZipline()
    │   ├── zipline.test.ts
    │   ├── sweep.ts                   # sweepScratchDir()
    │   └── sweep.test.ts
    └── app/
        ├── layout.tsx
        ├── page.tsx
        ├── globals.css
        └── api/
            ├── upload/
            │   ├── route.ts           # POST: stream raw upload to scratch/
            │   └── [id]/
            │       └── route.ts       # GET: Range-aware playback of the raw upload
            └── clip/
                └── route.ts           # POST: ffmpeg trim + Zipline upload + one-shot cleanup

stacks/homepage/config/services.yaml   # add a ts-clipper entry (modify existing file)
```

---

### Task 1: Scaffold the Next.js project

**Files:**
- Create: `stacks/ts-clipper/web/package.json`
- Create: `stacks/ts-clipper/web/tsconfig.json`
- Create: `stacks/ts-clipper/web/next.config.ts`
- Create: `stacks/ts-clipper/web/next-env.d.ts`
- Create: `stacks/ts-clipper/web/vitest.config.ts`
- Create: `stacks/ts-clipper/web/.dockerignore`
- Create: `stacks/ts-clipper/web/public/.gitkeep`
- Create: `stacks/ts-clipper/web/app/layout.tsx`
- Create: `stacks/ts-clipper/web/app/page.tsx` (placeholder, replaced in Task 6)
- Create: `stacks/ts-clipper/web/app/globals.css`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "ts-clipper",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run"
  },
  "dependencies": {
    "next": "^16.2.10",
    "react": "^19.2.7",
    "react-dom": "^19.2.7",
    "mpegts.js": "^1.8.0"
  },
  "devDependencies": {
    "@types/node": "^22.20.0",
    "@types/react": "^19.2.17",
    "@types/react-dom": "^19.2.3",
    "typescript": "^6.0.3",
    "vitest": "^4.1.9"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Create `next.config.ts`**

```ts
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
};

export default nextConfig;
```

- [ ] **Step 4: Create `next-env.d.ts`**

```ts
/// <reference types="next" />
/// <reference types="next/image-types/global" />

// NOTE: This file should not be edited
// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.
```

- [ ] **Step 5: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
  },
});
```

- [ ] **Step 6: Create `.dockerignore`**

```
node_modules
.next
.git
*.log
```

- [ ] **Step 7: Create the empty `public/` folder**

Create `stacks/ts-clipper/web/public/.gitkeep` with empty content. (Next.js's standalone Docker build copies `public/` unconditionally — it must exist even if empty.)

- [ ] **Step 8: Create `app/globals.css`**

```css
:root {
  color-scheme: dark;
}

body {
  margin: 0;
  font-family: system-ui, sans-serif;
  background: #111;
  color: #eee;
}

.page {
  max-width: 720px;
  margin: 0 auto;
  padding: 2rem 1rem;
}

.dropzone {
  display: block;
  border: 2px dashed #555;
  border-radius: 8px;
  padding: 3rem 1rem;
  text-align: center;
  cursor: pointer;
}

.dropzone input {
  display: none;
}

.preview {
  width: 100%;
  max-height: 60vh;
  background: black;
}

.controls {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin-top: 1rem;
}

.controls input[type='range'] {
  width: 100%;
}

.error {
  color: #ff6b6b;
}

.result {
  margin-top: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
```

- [ ] **Step 9: Create `app/layout.tsx`**

```tsx
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ts-clipper',
  description: 'Clip and share videos',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

- [ ] **Step 10: Create a placeholder `app/page.tsx`**

```tsx
export default function Home() {
  return (
    <main className="page">
      <h1>ts-clipper</h1>
      <p>Coming up in Task 6.</p>
    </main>
  );
}
```

- [ ] **Step 11: Install dependencies and verify the build**

```bash
export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
cd /home/tcash/code/portainer/stacks/ts-clipper/web
npm install
npm run build
```

Expected: `npm install` creates `package-lock.json` and `node_modules/`; `npm run build` completes with `✓ Compiled successfully` and no type errors.

- [ ] **Step 12: Ignore build artifacts and commit**

Add to `/home/tcash/code/portainer/.gitignore` (check first whether these lines already exist; only append missing ones):
```
stacks/ts-clipper/web/node_modules/
stacks/ts-clipper/web/.next/
```

```bash
cd /home/tcash/code/portainer
git add stacks/ts-clipper/web/package.json stacks/ts-clipper/web/package-lock.json \
  stacks/ts-clipper/web/tsconfig.json stacks/ts-clipper/web/next.config.ts \
  stacks/ts-clipper/web/next-env.d.ts stacks/ts-clipper/web/vitest.config.ts \
  stacks/ts-clipper/web/.dockerignore stacks/ts-clipper/web/public/.gitkeep \
  stacks/ts-clipper/web/app/globals.css stacks/ts-clipper/web/app/layout.tsx \
  stacks/ts-clipper/web/app/page.tsx .gitignore
git commit -m "feat(ts-clipper): scaffold Next.js project"
```

---

### Task 2: `lib/paths.ts` — id/extension validation and path helpers

**Files:**
- Create: `stacks/ts-clipper/web/lib/paths.ts`
- Create: `stacks/ts-clipper/web/lib/paths.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `stacks/ts-clipper/web/lib/paths.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clipPath, findSourceFile, isAcceptedExtension, isValidId, mimeTypeFor } from './paths';

describe('isValidId', () => {
  it('accepts a well-formed uuid', () => {
    expect(isValidId('3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBe(true);
  });

  it('rejects path traversal attempts and malformed ids', () => {
    expect(isValidId('../../etc/passwd')).toBe(false);
    expect(isValidId('not-a-uuid')).toBe(false);
    expect(isValidId('')).toBe(false);
  });
});

describe('isAcceptedExtension', () => {
  it('accepts supported video extensions, case-insensitively', () => {
    expect(isAcceptedExtension('clip.ts')).toBe(true);
    expect(isAcceptedExtension('CLIP.MP4')).toBe(true);
    expect(isAcceptedExtension('clip.m2ts')).toBe(true);
    expect(isAcceptedExtension('clip.webm')).toBe(true);
    expect(isAcceptedExtension('clip.m4v')).toBe(true);
  });

  it('rejects unsupported extensions', () => {
    expect(isAcceptedExtension('clip.mkv')).toBe(false);
    expect(isAcceptedExtension('clip.mov')).toBe(false);
    expect(isAcceptedExtension('clip.exe')).toBe(false);
  });
});

describe('mimeTypeFor', () => {
  it('maps known extensions to their mime type', () => {
    expect(mimeTypeFor('a.ts')).toBe('video/mp2t');
    expect(mimeTypeFor('a.m2ts')).toBe('video/mp2t');
    expect(mimeTypeFor('a.mp4')).toBe('video/mp4');
    expect(mimeTypeFor('a.m4v')).toBe('video/mp4');
    expect(mimeTypeFor('a.webm')).toBe('video/webm');
  });

  it('falls back to application/octet-stream for unknown extensions', () => {
    expect(mimeTypeFor('a.bin')).toBe('application/octet-stream');
  });
});

describe('clipPath', () => {
  it('builds the trimmed output path for an id under the given scratch dir', () => {
    expect(clipPath('abc', '/scratch')).toBe(path.join('/scratch', 'abc-clip.mp4'));
  });
});

describe('findSourceFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ts-clipper-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds the uploaded source file by id prefix', async () => {
    await writeFile(path.join(dir, 'abc.mp4'), 'data');
    expect(await findSourceFile('abc', dir)).toBe(path.join(dir, 'abc.mp4'));
  });

  it('does not match the trimmed clip output for the same id', async () => {
    await writeFile(path.join(dir, 'abc-clip.mp4'), 'data');
    expect(await findSourceFile('abc', dir)).toBeNull();
  });

  it('returns null when nothing matches', async () => {
    expect(await findSourceFile('missing', dir)).toBeNull();
  });

  it('returns null when the scratch dir does not exist', async () => {
    expect(await findSourceFile('abc', path.join(dir, 'nope'))).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
cd /home/tcash/code/portainer/stacks/ts-clipper/web
npx vitest run lib/paths.test.ts
```

Expected: FAIL — `Cannot find module './paths'` (the file doesn't exist yet).

- [ ] **Step 3: Create `lib/paths.ts`**

```ts
import path from 'node:path';
import { readdir } from 'node:fs/promises';

export const SCRATCH_DIR = process.env.SCRATCH_DIR ?? '/app/scratch';

export const ACCEPTED_EXTENSIONS = ['.ts', '.m2ts', '.mp4', '.webm', '.m4v'] as const;

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isValidId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export function isAcceptedExtension(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return (ACCEPTED_EXTENSIONS as readonly string[]).includes(ext);
}

export function mimeTypeFor(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.ts' || ext === '.m2ts') return 'video/mp2t';
  if (ext === '.mp4' || ext === '.m4v') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  return 'application/octet-stream';
}

export function clipPath(id: string, scratchDir: string = SCRATCH_DIR): string {
  return path.join(scratchDir, `${id}-clip.mp4`);
}

export async function findSourceFile(
  id: string,
  scratchDir: string = SCRATCH_DIR,
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(scratchDir);
  } catch {
    return null;
  }
  const match = entries.find((entry) => entry.startsWith(`${id}.`));
  return match ? path.join(scratchDir, match) : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd /home/tcash/code/portainer/stacks/ts-clipper/web
npx vitest run lib/paths.test.ts
```

Expected: PASS, all assertions green.

- [ ] **Step 5: Commit**

```bash
cd /home/tcash/code/portainer
git add stacks/ts-clipper/web/lib/paths.ts stacks/ts-clipper/web/lib/paths.test.ts
git commit -m "feat(ts-clipper): add id/extension validation and path helpers"
```

---

### Task 3: `lib/ffmpeg.ts` — trim argument building and execution

**Files:**
- Create: `stacks/ts-clipper/web/lib/ffmpeg.ts`
- Create: `stacks/ts-clipper/web/lib/ffmpeg.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `stacks/ts-clipper/web/lib/ffmpeg.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildFfmpegArgs } from './ffmpeg';

describe('buildFfmpegArgs', () => {
  it('builds a stream-copy trim that keeps audio', () => {
    const args = buildFfmpegArgs(
      '/scratch/in.ts',
      '/scratch/out.mp4',
      { start: 1.5, end: 4, removeAudio: false },
      'copy',
    );
    expect(args).toEqual([
      '-y', '-ss', '1.5', '-to', '4', '-i', '/scratch/in.ts',
      '-c:v', 'copy', '-c:a', 'copy', '/scratch/out.mp4',
    ]);
  });

  it('drops the audio stream when removeAudio is set, still stream-copying video', () => {
    const args = buildFfmpegArgs(
      '/scratch/in.ts',
      '/scratch/out.mp4',
      { start: 0, end: 10, removeAudio: true },
      'copy',
    );
    expect(args).toEqual([
      '-y', '-ss', '0', '-to', '10', '-i', '/scratch/in.ts',
      '-c:v', 'copy', '-an', '/scratch/out.mp4',
    ]);
  });

  it('uses a software re-encode with audio in reencode mode', () => {
    const args = buildFfmpegArgs(
      '/scratch/in.ts',
      '/scratch/out.mp4',
      { start: 0, end: 10, removeAudio: false },
      'reencode',
    );
    expect(args).toEqual([
      '-y', '-ss', '0', '-to', '10', '-i', '/scratch/in.ts',
      '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '/scratch/out.mp4',
    ]);
  });

  it('uses a software re-encode without audio in reencode mode when removeAudio is set', () => {
    const args = buildFfmpegArgs(
      '/scratch/in.ts',
      '/scratch/out.mp4',
      { start: 0, end: 10, removeAudio: true },
      'reencode',
    );
    expect(args).toEqual([
      '-y', '-ss', '0', '-to', '10', '-i', '/scratch/in.ts',
      '-c:v', 'libx264', '-preset', 'veryfast', '-an', '/scratch/out.mp4',
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /home/tcash/code/portainer/stacks/ts-clipper/web
npx vitest run lib/ffmpeg.test.ts
```

Expected: FAIL — `Cannot find module './ffmpeg'`.

- [ ] **Step 3: Create `lib/ffmpeg.ts`**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ClipOptions {
  start: number;
  end: number;
  removeAudio: boolean;
}

export function buildFfmpegArgs(
  sourcePath: string,
  outputPath: string,
  { start, end, removeAudio }: ClipOptions,
  mode: 'copy' | 'reencode',
): string[] {
  const videoArgs =
    mode === 'copy' ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast'];
  const audioArgs = removeAudio ? ['-an'] : mode === 'copy' ? ['-c:a', 'copy'] : ['-c:a', 'aac'];

  return [
    '-y',
    '-ss', String(start),
    '-to', String(end),
    '-i', sourcePath,
    ...videoArgs,
    ...audioArgs,
    outputPath,
  ];
}

export async function runClip(
  sourcePath: string,
  outputPath: string,
  options: ClipOptions,
): Promise<void> {
  try {
    await execFileAsync('ffmpeg', buildFfmpegArgs(sourcePath, outputPath, options, 'copy'));
  } catch {
    await execFileAsync('ffmpeg', buildFfmpegArgs(sourcePath, outputPath, options, 'reencode'));
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd /home/tcash/code/portainer/stacks/ts-clipper/web
npx vitest run lib/ffmpeg.test.ts
```

Expected: PASS, all assertions green. (`runClip` itself calls the real `ffmpeg` binary and is intentionally not unit-tested — verified on the host in Task 9.)

- [ ] **Step 5: Commit**

```bash
cd /home/tcash/code/portainer
git add stacks/ts-clipper/web/lib/ffmpeg.ts stacks/ts-clipper/web/lib/ffmpeg.test.ts
git commit -m "feat(ts-clipper): add ffmpeg trim argument building with re-encode fallback"
```

---

### Task 4: `lib/zipline.ts` — upload to Zipline

**Files:**
- Create: `stacks/ts-clipper/web/lib/zipline.ts`
- Create: `stacks/ts-clipper/web/lib/zipline.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `stacks/ts-clipper/web/lib/zipline.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { uploadToZipline } from './zipline';

describe('uploadToZipline', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ts-clipper-zipline-'));
    filePath = path.join(dir, 'clip.mp4');
    await writeFile(filePath, 'fake video bytes');
    process.env.ZIPLINE_TOKEN = 'test-token';
    process.env.ZIPLINE_URL = 'https://video.example.com';
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    delete process.env.ZIPLINE_TOKEN;
    delete process.env.ZIPLINE_URL;
    vi.unstubAllGlobals();
  });

  it('posts the file to Zipline and returns the share url', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ files: [{ url: 'https://video.example.com/u/abc' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const url = await uploadToZipline(filePath, 'clip.mp4');

    expect(url).toBe('https://video.example.com/u/abc');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe('https://video.example.com/api/upload');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ authorization: 'test-token' });
  });

  it('throws when the Zipline response is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' }),
    );

    await expect(uploadToZipline(filePath, 'clip.mp4')).rejects.toThrow('Zipline upload failed');
  });

  it('throws when the response has no usable file url', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ files: [] }) }),
    );

    await expect(uploadToZipline(filePath, 'clip.mp4')).rejects.toThrow('missing file url');
  });

  it('throws when ZIPLINE_TOKEN is missing', async () => {
    delete process.env.ZIPLINE_TOKEN;
    await expect(uploadToZipline(filePath, 'clip.mp4')).rejects.toThrow('ZIPLINE_TOKEN');
  });

  it('throws when ZIPLINE_URL is missing', async () => {
    delete process.env.ZIPLINE_URL;
    await expect(uploadToZipline(filePath, 'clip.mp4')).rejects.toThrow('ZIPLINE_URL');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /home/tcash/code/portainer/stacks/ts-clipper/web
npx vitest run lib/zipline.test.ts
```

Expected: FAIL — `Cannot find module './zipline'`.

- [ ] **Step 3: Create `lib/zipline.ts`**

```ts
import { readFile } from 'node:fs/promises';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export async function uploadToZipline(filePath: string, filename: string): Promise<string> {
  const token = requireEnv('ZIPLINE_TOKEN');
  const baseUrl = requireEnv('ZIPLINE_URL');

  const buffer = await readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'video/mp4' }), filename);

  const res = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    headers: { authorization: token },
    body: form,
  });

  if (!res.ok) {
    throw new Error(`Zipline upload failed: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as { files?: { url: string }[] };
  const url = json.files?.[0]?.url;
  if (!url) {
    throw new Error('Zipline response missing file url');
  }
  return url;
}
```

Note: the trimmed clip is read fully into memory here (not streamed) before upload. That's a deliberate trade-off — clips are short by definition, so buffering the *output* of a trim is cheap, unlike the raw source upload in Task 6 which must stream because raw DVR footage can be multiple GB.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd /home/tcash/code/portainer/stacks/ts-clipper/web
npx vitest run lib/zipline.test.ts
```

Expected: PASS, all assertions green.

- [ ] **Step 5: Commit**

```bash
cd /home/tcash/code/portainer
git add stacks/ts-clipper/web/lib/zipline.ts stacks/ts-clipper/web/lib/zipline.test.ts
git commit -m "feat(ts-clipper): add Zipline upload client"
```

---

### Task 5: `lib/sweep.ts` — scratch dir cleanup + startup wiring

**Files:**
- Create: `stacks/ts-clipper/web/lib/sweep.ts`
- Create: `stacks/ts-clipper/web/lib/sweep.test.ts`
- Create: `stacks/ts-clipper/web/instrumentation.ts`

- [ ] **Step 1: Write the failing tests**

Create `stacks/ts-clipper/web/lib/sweep.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sweepScratchDir } from './sweep';

describe('sweepScratchDir', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ts-clipper-sweep-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('removes files older than maxAgeMs and keeps recent ones', async () => {
    const oldFile = path.join(dir, 'old.ts');
    const newFile = path.join(dir, 'new.ts');
    await writeFile(oldFile, 'data');
    await writeFile(newFile, 'data');

    const now = Date.now();
    const oldTime = new Date(now - 2 * 24 * 60 * 60 * 1000);
    await utimes(oldFile, oldTime, oldTime);

    const removed = await sweepScratchDir(dir, 24 * 60 * 60 * 1000, now);

    expect(removed).toEqual(['old.ts']);
    expect(await readdir(dir)).toEqual(['new.ts']);
  });

  it('returns an empty array when the scratch dir does not exist', async () => {
    const removed = await sweepScratchDir(path.join(dir, 'missing'), 1000, Date.now());
    expect(removed).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /home/tcash/code/portainer/stacks/ts-clipper/web
npx vitest run lib/sweep.test.ts
```

Expected: FAIL — `Cannot find module './sweep'`.

- [ ] **Step 3: Create `lib/sweep.ts`**

```ts
import path from 'node:path';
import { readdir, stat, unlink } from 'node:fs/promises';
import { SCRATCH_DIR } from './paths';

export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export async function sweepScratchDir(
  scratchDir: string = SCRATCH_DIR,
  maxAgeMs: number = MAX_AGE_MS,
  now: number = Date.now(),
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(scratchDir);
  } catch {
    return [];
  }

  const removed: string[] = [];
  for (const entry of entries) {
    const filePath = path.join(scratchDir, entry);
    const stats = await stat(filePath);
    if (now - stats.mtimeMs > maxAgeMs) {
      await unlink(filePath);
      removed.push(entry);
    }
  }
  return removed;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd /home/tcash/code/portainer/stacks/ts-clipper/web
npx vitest run lib/sweep.test.ts
```

Expected: PASS, all assertions green.

- [ ] **Step 5: Wire the sweep into server startup via `instrumentation.ts`**

Create `stacks/ts-clipper/web/instrumentation.ts`:

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { sweepScratchDir } = await import('./lib/sweep');
    const removed = await sweepScratchDir();
    if (removed.length > 0) {
      console.log(`[startup sweep] removed ${removed.length} stale scratch file(s):`, removed);
    }
  }
}
```

- [ ] **Step 6: Verify the project still builds with instrumentation wired in**

```bash
export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
cd /home/tcash/code/portainer/stacks/ts-clipper/web
npm run build
```

Expected: `✓ Compiled successfully`, and the build output mentions instrumentation being picked up (no error either way — Next.js auto-detects `instrumentation.ts` at the project root with no config flag needed since Next 15).

- [ ] **Step 7: Commit**

```bash
cd /home/tcash/code/portainer
git add stacks/ts-clipper/web/lib/sweep.ts stacks/ts-clipper/web/lib/sweep.test.ts \
  stacks/ts-clipper/web/instrumentation.ts
git commit -m "feat(ts-clipper): add scratch dir startup sweep"
```

---

### Task 6: API routes — upload, playback, clip

**Files:**
- Create: `stacks/ts-clipper/web/app/api/upload/route.ts`
- Create: `stacks/ts-clipper/web/app/api/upload/[id]/route.ts`
- Create: `stacks/ts-clipper/web/app/api/clip/route.ts`

- [ ] **Step 1: Create the upload route**

Create `stacks/ts-clipper/web/app/api/upload/route.ts`:

```ts
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
```

- [ ] **Step 2: Create the playback route**

Create `stacks/ts-clipper/web/app/api/upload/[id]/route.ts`:

```ts
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { NextRequest, NextResponse } from 'next/server';
import { findSourceFile, isValidId, mimeTypeFor } from '@/lib/paths';

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
  const range = request.headers.get('range');

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

  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!match) {
    return new NextResponse(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
  }

  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
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
```

- [ ] **Step 3: Create the clip route**

Create `stacks/ts-clipper/web/app/api/clip/route.ts`:

```ts
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
```

- [ ] **Step 4: Verify the project builds and type-checks**

```bash
export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
cd /home/tcash/code/portainer/stacks/ts-clipper/web
npm run build
```

Expected: `✓ Compiled successfully`, with all three new routes listed in the route summary (`/api/upload`, `/api/upload/[id]`, `/api/clip`).

- [ ] **Step 5: Run the full test suite to confirm nothing broke**

```bash
cd /home/tcash/code/portainer/stacks/ts-clipper/web
npx vitest run
```

Expected: all existing `lib/*.test.ts` suites still PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/tcash/code/portainer
git add stacks/ts-clipper/web/app/api
git commit -m "feat(ts-clipper): add upload, playback, and clip API routes"
```

---

### Task 7: Frontend UI

**Files:**
- Modify: `stacks/ts-clipper/web/app/page.tsx`

- [ ] **Step 1: Replace the placeholder page with the full clipper UI**

Replace the contents of `stacks/ts-clipper/web/app/page.tsx`:

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';

type UploadState =
  | { status: 'idle' }
  | { status: 'uploading' }
  | { status: 'ready'; id: string; isTs: boolean }
  | { status: 'clipping'; id: string; isTs: boolean }
  | { status: 'done'; url: string }
  | { status: 'error'; message: string; id?: string; isTs?: boolean };

function isTsFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.endsWith('.ts') || lower.endsWith('.m2ts');
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function Home() {
  const [state, setState] = useState<UploadState>({ status: 'idle' });
  const [duration, setDuration] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [removeAudio, setRemoveAudio] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<{ destroy: () => void } | null>(null);

  const editing =
    state.status === 'ready' || state.status === 'clipping' || (state.status === 'error' && state.id);

  async function handleFile(file: File) {
    setState({ status: 'uploading' });
    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: file,
        headers: { 'x-filename': file.name },
      });
      const json = await res.json();
      if (!res.ok) {
        setState({ status: 'error', message: json.error ?? 'Upload failed' });
        return;
      }
      setState({ status: 'ready', id: json.id, isTs: isTsFile(file.name) });
    } catch (err) {
      setState({ status: 'error', message: (err as Error).message });
    }
  }

  useEffect(() => {
    if (!editing || !videoRef.current) return;
    const id = state.status !== 'done' && state.status !== 'uploading' && state.status !== 'idle' ? state.id : undefined;
    const isTs = state.status !== 'done' && state.status !== 'uploading' && state.status !== 'idle' ? state.isTs : undefined;
    if (!id) return;

    const video = videoRef.current;
    const src = `/api/upload/${id}`;

    if (isTs) {
      let cancelled = false;
      import('mpegts.js').then((mod) => {
        if (cancelled) return;
        const mpegts = mod.default;
        const player = mpegts.createPlayer({ type: 'mse', isLive: false, url: src });
        player.attachMediaElement(video);
        player.load();
        playerRef.current = player;
      });
      return () => {
        cancelled = true;
        playerRef.current?.destroy();
        playerRef.current = null;
      };
    }

    video.src = src;
    return () => {
      video.removeAttribute('src');
      video.load();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  function onLoadedMetadata() {
    const video = videoRef.current;
    if (!video) return;
    setDuration(video.duration);
    setEnd(video.duration);
  }

  async function handleClip() {
    if (state.status !== 'ready' && state.status !== 'error') return;
    const id = state.id;
    const isTs = state.isTs ?? false;
    if (!id) return;

    setState({ status: 'clipping', id, isTs });
    try {
      const res = await fetch('/api/clip', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, start, end, removeAudio }),
      });
      const json = await res.json();
      if (!res.ok) {
        setState({ status: 'error', message: json.error ?? 'Clip failed', id, isTs });
        return;
      }
      setState({ status: 'done', url: json.url });
    } catch (err) {
      setState({ status: 'error', message: (err as Error).message, id, isTs });
    }
  }

  function reset() {
    setState({ status: 'idle' });
    setDuration(0);
    setStart(0);
    setEnd(0);
    setRemoveAudio(false);
  }

  return (
    <main className="page">
      <h1>ts-clipper</h1>

      {state.status === 'idle' && (
        <label className="dropzone">
          <input
            type="file"
            accept=".ts,.m2ts,.mp4,.webm,.m4v"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
          />
          Drop a video here or click to choose a file
        </label>
      )}

      {state.status === 'uploading' && <p>Uploading&hellip;</p>}

      {editing && (
        <div className="editor">
          <video ref={videoRef} controls onLoadedMetadata={onLoadedMetadata} className="preview" />

          <div className="controls">
            <label>
              In: {formatTime(start)}
              <input
                type="range"
                min={0}
                max={duration || 0}
                step={0.1}
                value={start}
                onChange={(e) => setStart(Math.min(Number(e.target.value), end))}
              />
            </label>
            <label>
              Out: {formatTime(end)}
              <input
                type="range"
                min={0}
                max={duration || 0}
                step={0.1}
                value={end}
                onChange={(e) => setEnd(Math.max(Number(e.target.value), start))}
              />
            </label>
            <button type="button" onClick={() => setStart(videoRef.current?.currentTime ?? 0)}>
              Set in to current time
            </button>
            <button type="button" onClick={() => setEnd(videoRef.current?.currentTime ?? duration)}>
              Set out to current time
            </button>
            <label>
              <input
                type="checkbox"
                checked={removeAudio}
                onChange={(e) => setRemoveAudio(e.target.checked)}
              />
              Remove audio
            </label>
            <button type="button" disabled={state.status === 'clipping'} onClick={handleClip}>
              {state.status === 'clipping' ? 'Clipping…' : 'Clip & Upload'}
            </button>
          </div>
        </div>
      )}

      {state.status === 'error' && <p className="error">{state.message}</p>}

      {state.status === 'done' && (
        <div className="result">
          <p>
            Uploaded: <a href={state.url}>{state.url}</a>
          </p>
          <button type="button" onClick={() => navigator.clipboard.writeText(state.url)}>
            Copy link
          </button>
          <button type="button" onClick={reset}>
            Clip another
          </button>
        </div>
      )}
    </main>
  );
}
```

- [ ] **Step 2: Verify the project builds and type-checks**

```bash
export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
cd /home/tcash/code/portainer/stacks/ts-clipper/web
npm run build
```

Expected: `✓ Compiled successfully`, no type errors.

- [ ] **Step 3: Commit**

```bash
cd /home/tcash/code/portainer
git add stacks/ts-clipper/web/app/page.tsx
git commit -m "feat(ts-clipper): add drag-drop clip editor UI"
```

---

### Task 8: Dockerfile, Compose stack, and Homepage entry

**Files:**
- Create: `stacks/ts-clipper/web/Dockerfile`
- Create: `stacks/ts-clipper/docker-compose.yml`
- Modify: `stacks/homepage/config/services.yaml`

- [ ] **Step 1: Create the Dockerfile**

Create `stacks/ts-clipper/web/Dockerfile`:

```dockerfile
FROM node:22-bookworm-slim AS base

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs \
    && mkdir -p /app/scratch \
    && chown nextjs:nodejs /app/scratch

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV SCRATCH_DIR=/app/scratch

CMD ["node", "server.js"]
```

- [ ] **Step 2: Create the Compose file**

Create `stacks/ts-clipper/docker-compose.yml`:

```yaml
x-logging: &logging
  logging:
    driver: json-file
    options:
      max-size: "50m"
      max-file: "3"
      labels: "com.docker.compose.service,com.docker.compose.project"

services:
  ts-clipper:
    <<: *logging
    build: ./web
    container_name: ts-clipper
    restart: unless-stopped
    networks:
      - homelab_default
    volumes:
      - /mnt/lvm_striped/download/ts-clipper:/app/scratch
    environment:
      - SCRATCH_DIR=/app/scratch
      - ZIPLINE_URL=https://video.tylercash.dev
      - ZIPLINE_TOKEN=${ZIPLINE_TOKEN}
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 30s
    labels:
      - traefik.enable=true
      - traefik.http.routers.ts-clipper.service=ts-clipper
      - traefik.http.routers.ts-clipper.rule=Host(`upload.tylercash.dev`) && ClientIP(`10.0.0.0/8`)
      - traefik.http.routers.ts-clipper.entrypoints=websecure
      - traefik.http.services.ts-clipper.loadbalancer.server.scheme=http
      - traefik.http.services.ts-clipper.loadbalancer.server.port=3000
      - traefik.http.routers.ts-clipper.tls.certresolver=leresolver

networks:
  homelab_default:
    external: true
```

- [ ] **Step 3: Validate the Compose YAML**

```bash
cd /home/tcash/code/portainer
npx -y js-yaml stacks/ts-clipper/docker-compose.yml
```

Expected: prints the parsed document back out with no error.

- [ ] **Step 4: Add the Homepage entry**

In `stacks/homepage/config/services.yaml`, add a `ts-clipper` entry to the existing `Sharing:` group (alongside `Zipline`):

```yaml
- Sharing:
    - Zipline:
        href: https://video.tylercash.dev
        description: ShareX-compatible file/video sharing
        icon: mdi-share-variant
    - ts-clipper:
        href: https://upload.tylercash.dev
        description: Clip videos and share via Zipline
        icon: mdi-content-cut
```

- [ ] **Step 5: Validate the Homepage YAML**

```bash
cd /home/tcash/code/portainer
npx -y js-yaml stacks/homepage/config/services.yaml
```

Expected: parsed document printed, no error.

- [ ] **Step 6: Commit**

```bash
cd /home/tcash/code/portainer
git add stacks/ts-clipper/web/Dockerfile stacks/ts-clipper/docker-compose.yml \
  stacks/homepage/config/services.yaml
git commit -m "feat(ts-clipper): add Dockerfile, compose stack, and homepage entry"
```

---

### Task 9: Deploy and verify on the real host

Everything in this task requires the actual homelab host (Docker, ffmpeg, network access to the real Zipline instance) — none of it can run in this development sandbox.

**Files:** none (secrets + verification only)

- [ ] **Step 1: Get a Zipline API token**

Log into `https://video.tylercash.dev`, open your avatar/username menu → user settings, and copy your API token.

- [ ] **Step 2: Store the token as a secret**

```bash
cd /home/tcash/code/portainer
task edit STACK=ts-clipper
```

This opens `stacks/ts-clipper/.env.secret` through `sops` (creating it fresh). Add one line:
```
ZIPLINE_TOKEN=<paste the token from Step 1>
```
Save and exit — `sops` encrypts it on write. Confirm with `task status`; expected output includes `🔒 stacks/ts-clipper/.env.secret`.

- [ ] **Step 3: Create the scratch host directory**

On the docker host:
```bash
mkdir -p /mnt/lvm_striped/download/ts-clipper
chown 1001:1001 /mnt/lvm_striped/download/ts-clipper
```
(uid/gid 1001 matches the `nextjs` user created in the Dockerfile.)

- [ ] **Step 4: Deploy**

Deploy `stacks/ts-clipper/` the same way every other stack in this repo reaches Portainer (existing git-based deployment flow / Portainer GitOps pull).

- [ ] **Step 5: Confirm the container is healthy**

```bash
docker ps --filter "name=ts-clipper"
```
Expected: `ts-clipper` listed with status `Up` (healthy).

- [ ] **Step 6: End-to-end test — standard format, audio kept**

1. Visit `https://upload.tylercash.dev`.
2. Drag in a short `.mp4` test clip.
3. Confirm it plays natively in the preview player.
4. Set in/out points narrower than the full clip, leave "Remove audio" unchecked, click "Clip & Upload".
5. Confirm a Zipline URL is returned and that opening it plays the trimmed clip **with** audio.
6. On the host, confirm `/mnt/lvm_striped/download/ts-clipper` is empty again (both the raw upload and the trimmed output were deleted).

- [ ] **Step 7: End-to-end test — raw `.ts` DVR footage, audio removed**

1. Drag in a raw `.ts` file (e.g. copied off the HDZero Goggles 2 SD card).
2. Confirm it plays via the `mpegts.js` preview path (this is the format plain `<video>` can't handle).
3. Set in/out points, check "Remove audio", click "Clip & Upload".
4. Confirm the resulting Zipline link plays the trimmed clip with **no** audio track.
5. Confirm the scratch directory is empty again afterward.

- [ ] **Step 8: Confirm failure path leaves files intact**

Temporarily break `ZIPLINE_TOKEN` (edit it to garbage via `task edit STACK=ts-clipper`, redeploy), repeat Step 6, and confirm:
- The UI shows a "Zipline upload failed" error instead of silently succeeding.
- Both the raw upload and the trimmed clip are still present in `/mnt/lvm_striped/download/ts-clipper` (files are only deleted on confirmed success).

Restore the correct `ZIPLINE_TOKEN` afterward and redeploy.

- [ ] **Step 9: Confirm the rejected-format path**

Attempt to drag in a `.mkv` or `.mov` file. Expected: the upload is rejected with the "Unsupported file type" error from `/api/upload`, and nothing is written to the scratch directory.
