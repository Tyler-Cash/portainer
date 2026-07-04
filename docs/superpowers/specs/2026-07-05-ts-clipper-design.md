# ts-clipper Design Spec

**Goal:** A self-hosted, single-page Next.js app (`upload.tylercash.dev`) that replaces the current manual flow for sharing FPV DVR footage (raw `.ts` files off HDZero Goggles 2, currently: convert to mp4 → clip in VLC → upload with ShareX). The app lets you drag-drop a video, preview and scrub it in the browser, cut a clip, and get back a Zipline share link — all in one page, with no files retained afterward.

**Scope for v1:** Browser upload only (no watched-folder/network-share ingestion path). Accepts raw `.ts`/`.m2ts` (the DVR case this was built for) as well as standard container types that already work as ordinary shared clips: `.mp4`, `.webm`, `.m4v`. Single clip per upload, no batching, no thumbnails/waveform. No app-level auth — access is restricted to the LAN at the Traefik layer, the same way `stacks/vaultwarden` restricts the password manager (`ClientIP` matching only, no public exposure).

**Format handling note:** `.ts`/`.m2ts` aren't natively playable by `<video>` — those go through the `mpegts.js` demux path described below. `.mp4`/`.webm`/`.m4v` play natively, so the frontend skips `mpegts.js` for those and points `<video>` straight at `/api/upload/[id]`. `.mov`/`.mkv`/`.avi` are deliberately excluded from v1: ffmpeg could technically trim them, but browser preview support for those containers is inconsistent enough that "drag it in and it just plays" wouldn't reliably hold, which defeats the point of the tool. The upload route rejects any extension outside `{.ts, .m2ts, .mp4, .webm, .m4v}` with a clear error.

---

## Architecture

One Docker Compose stack, `stacks/ts-clipper/`, one container: a self-hosted Next.js app (App Router, `output: 'standalone'`) serving both the UI and its own API via Route Handlers. No database — single-user, stateless; in-flight job state lives only as files on disk plus request/response round-trips.

```
Browser (drag-drop .ts, mpegts.js preview, scrub UI)
   │  raw bytes, streamed
   ▼
POST /api/upload  ──────────────►  scratch/<uuid>.ts
   │  returns { id }
   ▼
GET /api/upload/[id]  (Range-aware) ──► browser mpegts.js player reads raw bytes back
   │
   │  user sets in/out points, clicks "Clip & Upload"
   ▼
POST /api/clip { id, start, end, removeAudio }
   │  ffmpeg -ss -to -c copy [-an] (fallback: re-encode)  ──► scratch/<uuid>-clip.mp4
   │  POST to Zipline /api/upload (Authorization: token)
   │  on success: delete scratch/<uuid>.ts and scratch/<uuid>-clip.mp4
   ▼
{ url: <zipline share link> }
```

## Components

**Frontend (`app/page.tsx`, client component)**
- Drag-drop zone / file input for the raw `.ts`.
- On file selection: `fetch('/api/upload', { method: 'POST', body: file, headers: { 'x-filename': file.name } })`. The raw `File` is sent as the request body (not multipart `FormData`) so the browser streams it and the server never has to buffer a multi-hundred-MB blob before it can start writing to disk.
- Once `{ id }` comes back, points an `mpegts.js` player at `/api/upload/[id]` for preview/scrub (plain `<video>` can't demux MPEG-TS directly, which is the likely cause of VLC's clip/export flow being unreliable on these files today).
- A dual-handle range control tied to the player's current time sets in/out points; "set in"/"set out" buttons snap to the current playhead.
- A "Remove audio" checkbox/toggle next to the clip controls.
- "Clip & Upload" POSTs `{ id, start, end, removeAudio }` to `/api/clip`, shows a spinner, then displays the returned Zipline URL with a copy button — or an error with a "retry" action (see Error Handling).

**`app/api/upload/route.ts` (POST)**
- Generates a `uuid`, pipes `request.body` (a `ReadableStream`) directly to `scratch/<uuid>.ts` via `fs.createWriteStream` + `Readable.fromWeb` + `stream/promises.pipeline` — no in-memory buffering regardless of file size.
- Returns `{ id: uuid }`.

**`app/api/upload/[id]/route.ts` (GET)**
- Streams `scratch/<id>.ts` back, honoring `Range` request headers (needed for `mpegts.js` to seek/scrub smoothly instead of loading the whole file up front).
- 404s if the id doesn't exist (already clipped-and-deleted, or never uploaded).

**`app/api/clip/route.ts` (POST)**
- Validates `id` exists and `0 <= start < end`.
- Runs `ffmpeg -y -ss <start> -to <end> -i scratch/<id>.ts -c:v copy [-an | -c:a copy] scratch/<id>-clip.mp4` via `execFile` (not `exec`, to avoid shell interpolation of user-controlled values). When `removeAudio` is true this is just `-an` in place of an audio codec flag — still a pure stream-copy on the video track, so it's just as fast as the normal trim.
- If that exits non-zero (common when the trim boundary isn't on a keyframe and stream-copy can't cut there cleanly), retries once with a software re-encode: `-c:v libx264 -preset veryfast` plus either `-an` or `-c:a aac` depending on `removeAudio`.
- On successful trim: POSTs the resulting file to `${ZIPLINE_URL}/api/upload` as multipart `FormData` (field name `file`) with header `Authorization: ${ZIPLINE_TOKEN}`.
- On a successful Zipline response: deletes both `scratch/<id>.ts` and `scratch/<id>-clip.mp4`, returns `{ url: json.files[0].url }`.
- On any failure (ffmpeg or the Zipline request): **does not delete anything**, returns `{ error }` with the original `id` still valid, so the frontend can retry `/api/clip` with new in/out points or the same ones without re-uploading the source file from the browser.

**Startup sweep**
- On container start, delete any file under `scratch/` older than 24h. This is a safety net for orphans left behind by a crash mid-job, not a general retention/TTL policy — the one-shot delete-on-success path above is what normally cleans up.

## Secrets & Config

- `ZIPLINE_TOKEN` — Zipline API token (from the Zipline user settings page), stored in `stacks/ts-clipper/.env.secret`, SOPS-encrypted, created via `task edit STACK=ts-clipper` per repo convention. Never hand-edited.
- `ZIPLINE_URL` — plain env var, `https://video.tylercash.dev`.

## Storage

Scratch directory is a bind mount to the striped-SSD volume already used for torrenting scratch I/O (see `slskd`'s `/mnt/lvm_striped/download/slskd` in `stacks/music/docker-compose.yml`), following the same per-app-subfolder convention:

```yaml
volumes:
  - /mnt/lvm_striped/download/ts-clipper:/app/scratch
```

Using this fast local volume (rather than `/hdd` or `/ssd/services/...`) matters here because raw DVR footage can be multiple GB and both the upload write and the ffmpeg read/write happen against it directly.

## Container

`node:22-bookworm-slim` base, multi-stage build per the standard Next.js standalone Dockerfile pattern, with `apt-get install -y ffmpeg` added in the runner stage. No `/dev/dri` VAAPI passthrough needed — the re-encode fallback path is software (`libx264`) since it's a rare edge case and doesn't justify the extra device-passthrough complexity here.

Compose service joins `homelab_default`, Traefik host `upload.tylercash.dev` restricted to the LAN via `ClientIP(\`10.0.0.0/8\`)` (matching `stacks/vaultwarden/docker-compose.yml:25`, not the wider `172.19.0.0/24`-inclusive pattern most other stacks use), standard `x-logging` anchor and Traefik labels matching every other stack in this repo (see `stacks/zipline/docker-compose.yml` for the exact label block to copy).

## Homepage integration

Add an entry to the existing `Sharing:` group in `stacks/homepage/config/services.yaml` (created alongside the Zipline entry), per the CLAUDE.md rule that any new Traefik-fronted service must be listed there.

## Error Handling Summary

| Failure | Behavior |
|---|---|
| Upload stream interrupted mid-write | Partial file remains in `scratch/`; cleaned up by the 24h startup sweep. Frontend shows a generic upload error; user re-selects the file. |
| ffmpeg stream-copy trim fails | Automatic single retry with software re-encode. |
| ffmpeg re-encode also fails | Error surfaced to UI with the raw source file untouched; user can retry. |
| Zipline upload request fails (network/auth/5xx) | Trimmed clip and raw source both retained; error surfaced with retry, no re-upload from browser needed. |
| `ZIPLINE_TOKEN` missing/invalid | Fails fast on the `/api/clip` call with a clear "check Zipline token" error, since this is a single-token setup. |

## Testing Plan

No ffmpeg/Docker available in this development sandbox, so this repo's usual pattern applies:
- Compose YAML validated here with `npx -y js-yaml stacks/ts-clipper/docker-compose.yml`.
- `next build` run locally (Node is available via nvm) to catch type/route errors before deploy.
- Real verification deferred to the host: deploy, drop a short test `.ts`, confirm preview/scrub works, confirm the resulting Zipline link plays the trimmed clip, confirm both scratch files are gone after success, and confirm a forced failure (e.g. temporarily wrong `ZIPLINE_TOKEN`) leaves the scratch files in place rather than deleting them.

## Out of Scope for v1

- Watched-folder/network-share ingestion (may be added later as a second ingestion path alongside browser upload).
- Multi-clip batching, thumbnails/waveform scrubbing.
- Any authentication beyond LAN/Traefik network placement.

## v1.1 additions: multi-clip queue, timeline scrubbing, fast preview

Superseded the single-clip-per-upload model above once real usage showed the need for it:

- **Timeline overlay:** a custom scrubber (`app/timeline.tsx`) replaces the two disconnected range sliders — it draws the selected clip range directly on a track under the video, with draggable start/end handles and click-to-seek.
- **Quick-clip buttons:** "Start clip here" sets the draft clip's start to the current playhead and its end to `start + 20s` (clamped to the video's duration); "Stop clip here" overrides the end to the current playhead. Both operate on one "draft" range shown on the timeline; "Add clip to queue" snapshots the draft into a queue and advances the draft's start to the previous draft's end, so consecutive clips can be queued by scrubbing forward.
- **Multi-clip queue:** one uploaded source can now produce N clips. This required decoupling clip processing from source lifecycle: `POST /api/clip` no longer deletes the source file after a successful upload (only its own trimmed output) — the source is deleted only by an explicit `DELETE /api/upload/[id]` call, which the frontend fires from a "Finish & clip another video" button once the user is done queuing clips from that source. The 24h startup sweep remains the safety net for sources abandoned without clicking Finish.
- **Fast preview (behind `FAST_PREVIEW_ENABLED`, default on):** when enabled, each queued clip is processed in two sequential passes. Pass 1 (`mode: 'fast'`) downscales and uses `ffmpeg`'s `ultrafast` preset for a low-quality-but-near-instant result, uploaded to Zipline immediately so the user has a usable link right away. Pass 2 (`mode: 'full'`) runs the normal stream-copy-with-re-encode-fallback trim; once it uploads successfully, the request also deletes the pass-1 Zipline file via `supersedesZiplineId` (Zipline's `DELETE /api/user/files/:id`), so only the full-quality file persists as the final artifact. `GET /api/config` exposes the toggle's current value to the client (env vars aren't visible in Route Handler-rendered client bundles).
- **Byte-range bug fix carried in the same pass:** the original Range-request handling didn't clamp `end` to the file size or reject `start >= size`, so a request near end-of-file could advertise a `Content-Length` larger than the bytes actually sent — the browser/`mpegts.js` would then hang waiting for bytes that never arrived. Fixed via `lib/range.ts`'s `resolveRange()`, unit tested directly.
- **Drag-and-drop bug fix:** the dropzone had no `onDragOver`/`onDrop` handlers, so dropping a file triggered the browser's default behavior of navigating to the local `file://` path instead of uploading it. Fixed by wiring real HTML5 drag-and-drop events with `preventDefault()`.
