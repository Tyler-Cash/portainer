# Immich Auto-Classifier (n8n Workflow) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. This plan builds an n8n workflow through the n8n UI/API rather than writing application code with unit tests — there is no test framework for n8n workflows in this repo, so "tests" here means triggering real executions against a live n8n/Immich/Ollama and inspecting the results, not `pytest`/`vitest` runs. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A scheduled n8n workflow that sweeps Immich for any asset missing the `classified` Immich Tag, and files each one into an auto-managed Immich Album (creating new albums or reusing existing ones) using an Ollama vision-language model, so your library — including everything Splice pushes — ends up organized without manual filing.

**Architecture:** One n8n workflow with two trigger variants sharing the same body (Cron for nightly steady-state, Webhook for a one-time larger backfill). The multi-step "propose → adversarially refine against existing buckets" classification loop (spec section "Classification loop") runs as a **single n8n Code node per asset** — modeling 5 conditional/looping Ollama round-trips as native n8n nodes would be far more nodes and much harder to read than the same logic as one function making sequential `fetch` calls. Everything before/after that Code node (listing unclassified assets, resolving/creating the album, applying the tag) uses standard n8n HTTP Request nodes against the Immich API. This is Part 2 of `docs/superpowers/specs/2026-07-18-immich-classifier-design.md` — Part 1 (Splice's upload) is a separate, already-written plan.

**Tech Stack:** n8n (existing `stacks/n8n/`), Immich REST API (existing `stacks/photo/`, pinned `v2.7.5`), Ollama REST API (existing `stacks/ai/`), model `qwen2.5vl`.

---

## Important note on API uncertainty

Several exact Immich API request/response shapes below (tag endpoints, album filtering, bulk-tag endpoint) are written from general knowledge of the Immich API and **must be confirmed against the live instance before building the corresponding node**, the same way Part 1's plan flagged the `POST /api/assets` multipart fields. The concrete way to confirm: open `https://photos.tylercash.dev/api/spec.json` (or, from the n8n container, `curl` it) and search for the endpoint in question, or check `photos.tylercash.dev/documentation` if Immich's Swagger UI is enabled. Task 2 below does this check explicitly before anything is built on top of it — don't skip it and guess.

---

### Task 1: Pull `qwen2.5vl` into Ollama

**Files:**
- Modify: `stacks/ai/docker-compose.yml`

- [ ] **Step 1: Add the model pull to the Ollama entrypoint**

```yaml
# stacks/ai/docker-compose.yml — ollama service
    entrypoint: ["/bin/sh", "-c", "ollama serve & sleep 5 && ollama pull mistral-nemo:12b-instruct-2407-q8_0 && ollama pull qwen2.5:0.5b && ollama pull qwen2.5vl:7b && wait"]
```

Starting with the `7b` variant to fit the container's existing `16G`–`20G` memory reservation alongside the already-loaded models on disk (note: `OLLAMA_MAX_LOADED_MODELS=1` means only one model is resident in memory at a time regardless of how many are pulled/on-disk, so this is about download size and per-inference VRAM/RAM footprint, not simultaneous residency).

- [ ] **Step 2: Validate the compose YAML**

Run: `cd /home/tcash/code/portainer && npx -y js-yaml stacks/ai/docker-compose.yml`
Expected: parses without error.

- [ ] **Step 3: Deploy and confirm the pull**

On the host (via Portainer or `docker compose -f stacks/ai/docker-compose.yml up -d ollama`), redeploy the `ollama` service, then confirm the model is present:

Run: `curl -s https://ollama.tylercash.dev/api/tags | grep qwen2.5vl`
Expected: a JSON fragment showing `"name":"qwen2.5vl:7b"` (or similar) in the models list. This may take several minutes after redeploy while the pull completes — re-check if it's missing at first.

- [ ] **Step 4: Commit**

```bash
cd /home/tcash/code/portainer
git add stacks/ai/docker-compose.yml
git commit -m "chore(ai): pull qwen2.5vl for Immich classifier workflow"
```

---

### Task 2: Confirm Immich API shapes for tags, albums, and assets

**Files:** none (research/verification only — produces notes used by later tasks, not committed)

- [ ] **Step 1: Confirm the Tags API**

Run: `curl -s -H "x-api-key: <your Immich API key>" https://photos.tylercash.dev/api/spec.json | python3 -c "import json,sys; d=json.load(sys.stdin); print([p for p in d['paths'] if 'tag' in p.lower()])"`

Expected: a list of tag-related paths (e.g. `/api/tags`, `/api/tags/{id}`, `/api/tags/assets` or `/api/tags/{id}/assets`). Note the exact path and body shape for: (a) listing tags, (b) creating a tag, (c) bulk-assigning a tag to a list of asset ids.

- [ ] **Step 2: Confirm the Albums API**

Run the same query filtered for `album`: expected paths `/api/albums` (GET list, POST create), `/api/albums/{id}` (GET one, includes `description`), `/api/albums/{id}/assets` (PUT add assets). Confirm `description` is a field accepted on album creation (`POST /api/albums` body) — this is what the `[auto-classified]` marker relies on.

- [ ] **Step 3: Confirm the asset listing/search API**

Confirm the paginated asset-listing endpoint (likely `POST /api/search/metadata`, taking a body like `{ page, size, order }` and returning `{ assets: { items: [...], total, ... } }` — a cursor/page-based response). Note the exact request body and response shape; Task 4 depends on this.

- [ ] **Step 4: Record the confirmed shapes**

Update the request bodies in Tasks 3–7 below if they differ from what's written — treat every JSON body in this plan from here on as a draft to be corrected against what Step 1–3 actually returned, not as verified fact.

---

### Task 3: Node — ensure the `classified` tag and fetch `[auto-classified]` albums

**n8n nodes to create** (name them exactly as shown so later steps' descriptions line up):

- [ ] **Step 1: `Get Classified Tag` (HTTP Request node)**

`GET {{$env.IMMICH_URL}}/api/tags`, header `x-api-key: {{$credentials.immichApiKey}}` (using an n8n credential, not a hardcoded key — see Task 8). Response is an array of `{ id, name }`.

- [ ] **Step 2: `Ensure Classified Tag Exists` (Code node)**

```javascript
// Code node: JavaScript, "Run Once for All Items"
const tags = $input.first().json; // array from Get Classified Tag
const existing = tags.find((t) => t.name === 'classified');
if (existing) {
  return [{ json: { tagId: existing.id } }];
}
// No existing tag — signal the next node to create one.
return [{ json: { tagId: null } }];
```

- [ ] **Step 3: `Create Classified Tag If Missing` (IF node → HTTP Request node)**

IF `{{$json.tagId}}` is empty → `POST {{$env.IMMICH_URL}}/api/tags`, body `{ "name": "classified" }` (field name/shape per Task 2's findings), response `{ id, name }`. Merge node afterward combines both branches back into a single `tagId` value downstream (use a `Set`/`Edit Fields` node on each branch to normalize to `{ tagId }`).

- [ ] **Step 4: `Get Auto Albums` (HTTP Request node)**

`GET {{$env.IMMICH_URL}}/api/albums`, same auth header. Response is an array of `{ id, albumName, description }`.

- [ ] **Step 5: `Filter Auto Albums` (Code node)**

```javascript
// Code node: JavaScript, "Run Once for All Items"
const albums = $input.first().json;
const autoAlbums = albums.filter((a) => (a.description || '').includes('[auto-classified]'));
return [{ json: { autoAlbums: autoAlbums.map((a) => ({ id: a.id, name: a.albumName })) } }];
```

These two sub-flows (classified-tag-id, auto-album-list) run once per workflow execution, before the per-asset loop — wire both as prerequisite branches feeding into Task 4's node.

---

### Task 4: Node — find unclassified assets (batch-capped)

- [ ] **Step 1: `Get Classified Asset Ids` (HTTP Request node, paginated)**

Using the tag-assets endpoint confirmed in Task 2 Step 1 (e.g. `GET {{$env.IMMICH_URL}}/api/tags/{{$json.tagId}}/assets` or equivalent), configure n8n's built-in pagination (HTTP Request node → "Pagination" section, using the endpoint's cursor/page field from Task 2) to fetch **all** asset ids currently carrying the `classified` tag. Output: array of asset ids.

- [ ] **Step 2: `Get All Assets Page` (HTTP Request node, paginated, sorted oldest-first or newest-first — pick one and stay consistent so backfill progresses predictably)**

Using the asset-listing endpoint confirmed in Task 2 Step 3, fetch asset pages. Do **not** rely on server-side "exclude this tag" filtering (not confirmed to exist) — instead fetch broadly and filter client-side in Step 3. Cap total fetched at a generous ceiling (e.g. 500 assets scanned) via n8n's pagination "max results" setting, so a huge library doesn't make the workflow scan forever just to find 50 unclassified ones.

- [ ] **Step 3: `Diff To Unclassified Batch` (Code node)**

```javascript
// Code node: JavaScript, "Run Once for All Items"
const classifiedIds = new Set($('Get Classified Asset Ids').all().map((item) => item.json.id));
const allAssets = $('Get All Assets Page').all().map((item) => item.json);
const BATCH_CAP = $env.CLASSIFIER_BATCH_SIZE ? parseInt($env.CLASSIFIER_BATCH_SIZE, 10) : 50;

const unclassified = allAssets
  .filter((asset) => !classifiedIds.has(asset.id))
  .slice(0, BATCH_CAP);

return unclassified.map((asset) => ({ json: asset }));
```

Each output item is now one unclassified asset — this Code node's output items feed directly into an n8n **Loop Over Items** node (batch size 1, sequential) wrapping Task 5.

---

### Task 5: Node — per-asset classification loop (Code node)

- [ ] **Step 1: `Fetch Asset Context` (HTTP Request node, inside the Loop Over Items branch)**

Two calls per asset (use n8n's ability to chain HTTP Request nodes within the loop, or combine into one Code node using `fetch`):
- `GET {{$env.IMMICH_URL}}/api/assets/{{$json.id}}/thumbnail` — binary response (JPEG). Configure the HTTP Request node's response format as "File"/binary so n8n stores it as binary data on the item.
- `GET {{$env.IMMICH_URL}}/api/assets/{{$json.id}}` — full asset detail, used for `people` (recognized faces) and `exifInfo`/smart-search description if present.

- [ ] **Step 2: `Classify Asset` (Code node — the core loop)**

```javascript
// Code node: JavaScript, "Run Once for Each Item"
// Inputs available on this item: binary thumbnail (from Fetch Asset Context),
// asset detail JSON, and the auto-album list from Task 3 Step 5's output
// (referenced via $('Filter Auto Albums').first().json.autoAlbums).

const OLLAMA_URL = $env.OLLAMA_URL; // e.g. http://ollama:11434
const MODEL = 'qwen2.5vl:7b';
const MAX_ITERATIONS = 5;

const assetDetail = $input.item.json;
const thumbnailBase64 = Buffer.from($input.item.binary.data.data, 'base64').toString('base64');
const autoAlbums = $('Filter Auto Albums').first().json.autoAlbums.map((a) => a.name);

const people = (assetDetail.people || []).map((p) => p.name).filter(Boolean);
const smartDescription = assetDetail.exifInfo?.description || '';

async function callOllama(messages) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, stream: false }),
  });
  if (!res.ok) {
    throw new Error(`Ollama request failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  return json.message.content.trim();
}

const contextLine = `Recognized people: ${people.length ? people.join(', ') : 'none'}. ` +
  `Existing description: ${smartDescription || 'none'}.`;

let candidate;
let matchedExisting = null;

try {
  // Iteration 1: initial open-ended proposal.
  candidate = await callOllama([
    {
      role: 'user',
      content:
        `You are categorizing a photo/video for a personal photo library into an album. ` +
        `${contextLine} Existing albums: ${autoAlbums.length ? autoAlbums.join(', ') : 'none yet'}. ` +
        `If this clearly fits one of the existing albums, reply with EXACTLY that album's name and nothing else. ` +
        `Otherwise, reply with a short new category name (2-4 words, e.g. "Drone FPV", "Driving", "Social Hangs") and nothing else.`,
      images: [thumbnailBase64],
    },
  ]);

  let previousCandidate = null;
  for (let i = 0; i < MAX_ITERATIONS - 1; i++) {
    if (autoAlbums.some((name) => name.toLowerCase() === candidate.toLowerCase())) {
      matchedExisting = autoAlbums.find((name) => name.toLowerCase() === candidate.toLowerCase());
      break;
    }
    if (candidate === previousCandidate) {
      break; // converged on a stable new-category name
    }
    previousCandidate = candidate;
    candidate = await callOllama([
      {
        role: 'user',
        content:
          `You proposed the category "${candidate}" for this image. Existing albums: ` +
          `${autoAlbums.length ? autoAlbums.join(', ') : 'none yet'}. ` +
          `Argue against your own proposal: should this instead go in one of the existing albums? ` +
          `Only keep a new category if none genuinely fit. Reply with EXACTLY the final album name ` +
          `(existing or new) and nothing else.`,
      },
    ]);
  }

  return [{
    json: {
      assetId: assetDetail.id,
      finalLabel: matchedExisting || candidate,
      isNewAlbum: !matchedExisting,
      failed: false,
    },
  }];
} catch (err) {
  return [{ json: { assetId: assetDetail.id, failed: true, error: err.message } }];
}
```

Note: `$input.item.binary.data.data` assumes the thumbnail's binary property is named `data` (n8n's HTTP Request node default) — confirm the actual binary property name in the executed node output and adjust if different.

---

### Task 6: Node — resolve/create album and tag the asset

- [ ] **Step 1: `Route On Failure` (IF node)**

IF `{{$json.failed}}` is true → skip straight to the loop's end (no album/tag action, per spec's "leave untagged, retry next run"). Otherwise continue.

- [ ] **Step 2: `Find Or Create Album` (IF node → two HTTP Request branches)**

IF `{{$json.isNewAlbum}}` is false → `PUT {{$env.IMMICH_URL}}/api/albums/{{albumId}}/assets` where `albumId` is looked up from `Filter Auto Albums`'s output by matching `finalLabel` to `name` (small Code/Set node just before this to resolve the id). Body: `{ "ids": ["{{$json.assetId}}"] }` (field name per Task 2 findings).

IF `{{$json.isNewAlbum}}` is true → `POST {{$env.IMMICH_URL}}/api/albums`, body:
```json
{
  "albumName": "={{$json.finalLabel}}",
  "description": "[auto-classified]",
  "assetIds": ["={{$json.assetId}}"]
}
```

- [ ] **Step 3: `Apply Classified Tag` (HTTP Request node)**

Using the bulk-tag endpoint confirmed in Task 2 Step 1, tag `{{$json.assetId}}` with the `classified` tag id (from Task 3's `Ensure Classified Tag Exists` output — reference via `$('Ensure Classified Tag Exists').first().json.tagId`).

This runs after **both** branches of Step 2 (success path) — the failed-asset branch from Step 1 bypasses this node entirely, leaving that asset untagged for retry.

---

### Task 7: Triggers — nightly cron and one-time backfill webhook

- [ ] **Step 1: `Cron Trigger` node**

Schedule: `0 3 * * *` (03:00 daily), timezone inherited from n8n's `GENERIC_TIMEZONE=Australia/Sydney` (already set in `stacks/n8n/docker-compose.yml`). Feeds into Task 3's first node. Uses the default `CLASSIFIER_BATCH_SIZE` (50, per Task 4 Step 3's fallback).

- [ ] **Step 2: Duplicate the workflow for backfill**

In the n8n UI, duplicate the whole workflow (or the whole node graph within one workflow behind a Switch on trigger type — duplicating the workflow is simpler to reason about and matches "two trigger variants" in the architecture). Replace the Cron Trigger with a **Webhook Trigger** node (`POST`, path `photo-classifier-backfill`, no auth needed since it's LAN-only via existing Traefik/network placement — confirm `n8n.tylercash.dev`'s existing access restriction covers this, per `stacks/n8n/docker-compose.yml`'s `ClientIP` rule already in place). Set that workflow's `CLASSIFIER_BATCH_SIZE` override to `500` via a `Set` node right after the trigger, before Task 3's nodes.

- [ ] **Step 3: Trigger the backfill once, manually**

Run: `curl -X POST https://n8n.tylercash.dev/webhook/photo-classifier-backfill`

Confirm in n8n's execution log that it runs to completion (or hits its 500-asset cap) without errors. Re-run manually (same command) on subsequent days until Immich shows no more untagged growth, or just let the nightly cron (Step 1's workflow) take over — both are safe to run concurrently since they're idempotent per-asset (the `classified` tag prevents double-processing).

---

### Task 8: Credentials

- [ ] **Step 1: Create an n8n credential for Immich**

In the n8n UI: Settings → Credentials → New → "Header Auth" (or "Generic Credential" if n8n has no built-in Immich credential type), name `Immich API`, header name `x-api-key`, value = a **new** Immich API key generated specifically for n8n (separate from Splice's key from Part 1, so each can be revoked independently — per spec). Reference this credential from every HTTP Request node in Tasks 3–6 instead of a literal header value.

- [ ] **Step 2: Set environment variables used by the Code nodes**

In `stacks/n8n/docker-compose.yml`, add to the `n8n` service's `environment:` block:

```yaml
      - IMMICH_URL=https://photos.tylercash.dev
      - OLLAMA_URL=http://ollama:11434
      - CLASSIFIER_BATCH_SIZE=50
```

(`http://ollama:11434` — same-network container-to-container address, matching the pattern already used by `open-webui` in `stacks/ai/docker-compose.yml`; confirm `n8n` and `ollama` share `homelab_default`, which both compose files already declare.)

- [ ] **Step 3: Validate and commit**

Run: `cd /home/tcash/code/portainer && npx -y js-yaml stacks/n8n/docker-compose.yml`
Expected: parses without error.

```bash
git add stacks/n8n/docker-compose.yml
git commit -m "chore(n8n): add Immich/Ollama config for photo classifier workflow"
```

---

### Task 9: Export workflow to git

**Files:**
- Create: `stacks/n8n/workflows/photo-classifier.json`
- Create: `stacks/n8n/workflows/photo-classifier-backfill.json`

- [ ] **Step 1: Export both workflows**

In the n8n UI, for each of the two workflows built above: `⋯` menu → "Download" (exports the workflow as JSON).

- [ ] **Step 2: Save into the repo**

Save the downloaded files to `stacks/n8n/workflows/photo-classifier.json` and `stacks/n8n/workflows/photo-classifier-backfill.json`.

- [ ] **Step 3: Commit**

```bash
cd /home/tcash/code/portainer
git add stacks/n8n/workflows/photo-classifier.json stacks/n8n/workflows/photo-classifier-backfill.json
git commit -m "docs(n8n): export photo classifier workflows to git"
```

Note for future edits: any change made in the n8n UI after this point must be re-exported and re-committed to stay authoritative, per the spec's "git is source of truth" convention (same pattern as the Grafana dashboards, `CLAUDE.md`).

---

### Task 10: End-to-end verification

- [ ] **Step 1: Verify auto-album creation and tagging**

After Task 7 Step 3's manual backfill trigger, in the Immich UI (`https://photos.tylercash.dev`): confirm new albums appeared with plausible names, each carrying `[auto-classified]` somewhere in its description; confirm assets that were previously unorganized now show up inside one of those albums; spot-check a couple of assets for `classified` under their Tags.

- [ ] **Step 2: Verify hand-made albums are untouched**

Pick one album you created manually before this workflow existed (no `[auto-classified]` marker). Confirm no new assets were added to it and its description wasn't modified.

- [ ] **Step 3: Verify idempotency**

Re-trigger the backfill webhook a second time (Task 7 Step 3's `curl` command again). Confirm the execution log shows it found 0 (or a much smaller number of newly-arrived) unclassified assets — i.e. it isn't reprocessing already-tagged ones.

- [ ] **Step 4: Verify failure handling**

Temporarily break `OLLAMA_URL` (e.g. via n8n's environment override in a test execution, or point it at a wrong port) and manually trigger a single-asset run. Confirm the asset comes out the `failed: true` branch, is **not** tagged `classified`, and no album mutation happens for it — matching "leave untagged, retry next run."

---

## Self-Review Notes

- **Spec coverage:** `classified` tag (Task 3, 6), `[auto-classified]` album marker (Task 3 Step 5, Task 6 Step 2), classification loop with N=5 adversarial refinement (Task 5), single vision model for both vision+text steps to avoid Ollama reload (Task 1, Task 5 — one `MODEL` constant used throughout), sequential processing / `OLLAMA_NUM_PARALLEL=1` respected (Loop Over Items batch size 1, Task 4→5), nightly cron + manual backfill webhook (Task 7), 50/night batch cap with configurable override (Task 4 Step 3, Task 7 Step 2), leave-untagged-on-failure (Task 6 Step 1, verified in Task 10 Step 4), workflow exported to git (Task 9).
- **Type/naming consistency:** node names referenced across tasks (`Filter Auto Albums`, `Ensure Classified Tag Exists`, `Get Classified Asset Ids`) are used identically wherever `$('Node Name')` expressions appear in later Code nodes — Task 5 and Task 6 both reference `Filter Auto Albums` and `Ensure Classified Tag Exists` by these exact names from Task 3.
- **Known open items (not placeholders — explicit verification steps exist for each):** exact Immich tag/album/asset-listing API shapes (Task 2, blocking for Tasks 3–6); binary property name for the thumbnail in Task 5's Code node; whether n8n's credential system needs "Generic Credential" vs a dedicated type for `x-api-key` auth (Task 8).
