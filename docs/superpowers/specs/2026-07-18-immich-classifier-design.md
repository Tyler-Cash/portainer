# Immich Auto-Classification Design Spec

**Goal:** Two pieces working toward one outcome — your Immich library (`stacks/photo/`, `photos.tylercash.dev`) ends up organized into albums by content (social hangs, driving clips, drone FPV, etc.) without manual filing.

1. **Splice → Immich** (`stacks/ts-clipper/`): every full-quality clip Splice produces also lands in Immich as a full-size asset, in addition to the existing Zipline share link. No classification happens here — this piece is just "get the asset into Immich."
2. **Immich auto-classifier** (n8n workflow, `stacks/n8n/`): a scheduled job that sweeps *any* unclassified asset in Immich — clips Splice pushed, and your existing library — and files each one into an album, using Immich's own asset metadata plus a self-hosted vision LLM (Ollama) to decide where it belongs.

These are deliberately decoupled. Splice doesn't know or care about classification; the classifier doesn't know or care where an asset came from. The connection between them is entirely "eventually consistent" — Splice uploads it, and on some later nightly run the classifier picks it up along with everything else untagged.

---

## Part 1: Splice → Immich upload

### Change

In `app/api/clip/route.ts`, immediately after the existing Zipline upload succeeds:

- `POST {IMMICH_URL}/api/assets` with the full-quality trimmed clip (multipart `FormData`, header `x-api-key: ${IMMICH_API_KEY}`), wrapped in try/catch.
- Success: no further action. The asset now exists in Immich, untagged — the n8n workflow will pick it up on its next run.
- Failure: swallowed, does not affect the Zipline result or the HTTP status. The response becomes `{ url, immichError?: string }` where `immichError` is a short human-readable message (e.g. `"Immich upload failed: 401 Unauthorized"`).

This only applies to the **full-quality pass** — the fast-preview pass (see ts-clipper v1.1) is never pushed to Immich; it's a throwaway low-quality artifact by design.

### Frontend

`page.tsx`: when the `/api/clip` response includes `immichError`, render it as a small secondary line under the existing Zipline URL/copy-button block — doesn't replace or block the success state, purely informational.

### Config

- `IMMICH_URL` — plain env var, `https://photos.tylercash.dev`.
- `IMMICH_API_KEY` — Immich API key (generated in Immich's user settings), added to `stacks/ts-clipper/.env.secret` via `task edit STACK=ts-clipper`, following repo convention.

### Error handling

| Failure | Behavior |
|---|---|
| Immich upload fails (network, auth, 5xx) | Zipline flow is entirely unaffected. `immichError` surfaced in the UI. No retry — if the clip's source has already been cleaned up per the existing scratch-file lifecycle, there's nothing left to retry with anyway. |
| `IMMICH_API_KEY` missing/invalid | Same as any other Immich failure — caught, surfaced as `immichError`, doesn't fail the request. |

---

## Part 2: Immich auto-classifier (n8n workflow)

### Conventions

- **`classified` tag** (Immich's native Tags feature, not albums): applied to an asset once the workflow has successfully filed it into an album. This is the *only* progress-tracking mechanism — no separate database. An asset without this tag is "needs classification."
- **Auto-album marker**: every album the workflow creates has a fixed marker string, `[auto-classified]`, appended to its Immich description field. Only albums carrying this marker are visible to the classifier as candidate buckets (for both the adversarial-match step and for adding new assets). Hand-made albums without the marker are never read, matched against, or written to.

### Workflow structure

**Trigger**: Cron, nightly at 03:00 Australia/Sydney.

**Steps per run:**

1. Fetch all `[auto-classified]`-marked albums from Immich (`GET /api/albums`, filter by description) → bucket name list, fetched once per run.
2. Fetch classified asset ids via `POST /api/search/metadata` with `tagIds: [<classified tag id>]` (paginated), then fetch a broader page of assets via the same endpoint with no tag filter and diff client-side to find unclassified ones, capped at **50 assets per run**.
3. For each asset, sequentially (no parallel Ollama calls — `OLLAMA_NUM_PARALLEL=1` on the Ollama container means parallel requests would just queue anyway):
   - Fetch the asset's thumbnail (`GET /api/assets/{id}/thumbnail`). Recognized people and any smart-search description are already present on the asset object returned by step 2's search call — no separate detail fetch needed.
   - **Classification, fixed two-pass**, model `qwen2.5vl` throughout (single model for both calls, avoiding an Ollama reload mid-asset since `OLLAMA_MAX_LOADED_MODELS=1`):
     - **Pass 1 (propose)**: given the thumbnail + people/description + current bucket list, propose a label — instructed to strongly prefer an existing bucket if one plausibly fits, otherwise propose a short new category name.
     - **Pass 2 (reconsider)**: shown its own pass-1 answer plus the bucket list again, asked to confirm or correct — "if an existing bucket actually fits better than what you proposed, switch to it; otherwise confirm." The pass-2 answer is final, no further iteration.
   - **On success**: resolve to an existing `[auto-classified]` album (by matched name) or create a new one (name = final label, description = `[auto-classified]`). Add the asset (`PUT /api/albums/{id}/assets`). Apply the `classified` tag.
   - **On hard failure** (Ollama unreachable, malformed/unparseable response): leave the asset untagged. It's picked up again on a future run. *(Accepted tradeoff: a persistently-failing asset — e.g. corrupt thumbnail — could eat a batch slot on every future run indefinitely. No attempt-count cap for v1; easy to add later if this turns out to matter in practice.)*

**Platform constraint that shaped this** (discovered during implementation, not known when this spec was first written): n8n's Code node has no network access — it cannot call Ollama itself. A true N-round dynamic loop with early-exit-on-convergence would need to be unrolled into many chained HTTP/IF nodes, which is disproportionately fragile for the benefit. The fixed two-pass design above keeps the "propose, then check against existing buckets" intent as plain HTTP Request nodes with no loop construct at all.

**Initial backfill**: since 50/night is slow against a large existing library, a second copy of the same workflow with a Webhook trigger (fired manually, once) and a much higher batch cap handles the initial catch-up. The nightly cron then maintains steady-state going forward.

### Version control

The workflow is exported from n8n's UI and committed to `stacks/n8n/workflows/photo-classifier.json`. Re-export after any meaningful edit made in the n8n UI — n8n's own DB remains the live/running copy, git is the reviewable source of truth, matching this repo's GitOps convention (same "UI edits are ephemeral, git is authoritative" pattern used for Grafana dashboards per `CLAUDE.md`).

### Config / secrets

Reuses existing infra — no new stack, no new secrets:
- Immich API key: n8n needs its own Immich API key (separate from Splice's, so each caller's access can be revoked independently) — stored as an n8n credential, not in a repo secret file (matching how n8n manages its own credentials today).
- `ollama.tylercash.dev` — already reachable from n8n on `homelab_default`.

`qwen2.5vl` needs to be pulled into the Ollama container (`stacks/ai/docker-compose.yml`'s `ollama` service entrypoint, alongside the existing `mistral-nemo`/`qwen2.5:0.5b` pulls). Model size (7b vs larger) to be decided at implementation time against the container's ~16–20G memory reservation.

### Testing plan

No live Immich/Ollama/n8n available in this development sandbox, so:
- Part 1 (Splice): same pattern as existing ts-clipper testing — `next build` locally for type/route errors, real verification deferred to the host (deploy, produce a clip, confirm it appears as a new asset in Immich, confirm a forced failure — e.g. wrong `IMMICH_API_KEY` — surfaces `immichError` without breaking the Zipline link).
- Part 2 (classifier): workflow JSON validated for syntax; real verification deferred to the host — trigger the webhook backfill against a handful of test assets, confirm albums get created/reused sensibly, confirm the `classified` tag prevents reprocessing on a second manual trigger, confirm a hand-made (unmarked) album is never touched.

### Out of scope for v1

- Real-time/immediate classification of Splice uploads — deliberately eventually-consistent via the nightly sweep instead.
- Attempt-count capping for persistently-failing assets.
- Re-classification or album cleanup for already-tagged assets (the `classified` tag is permanent; correcting a bad classification is a manual Immich UI action).
- Any UI in Splice for viewing/confirming Immich classification results — Splice only reports upload success/failure, not album placement.
