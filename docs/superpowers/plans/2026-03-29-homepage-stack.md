# Homepage Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Homepage dashboard at `home.tylercash.dev` that links to all services across all stacks with live widgets for *arr apps, Jellyfin, and qBittorrent.

**Architecture:** A new `stacks/homepage/` stack with a `docker-compose.yml` + YAML config files checked into the repo. Because the self-hosted GitHub Actions runner runs on the same machine as Docker, `deploy.yml` is modified to `cp` the config directory to `/ssd/services/homepage/` before Portainer deploys the stack. API keys are SOPS-encrypted in `.env.secret` and passed through as `HOMEPAGE_VAR_*` environment variables, which Homepage substitutes into `services.yaml` via `{{HOMEPAGE_VAR_*}}` syntax.

**Tech Stack:** Homepage (`ghcr.io/gethomepage/homepage`), Traefik for reverse proxy, SOPS + age for secrets, GitHub Actions self-hosted runner.

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `stacks/homepage/docker-compose.yml` | Create | Homepage service with Traefik labels (public, no IP restriction) |
| `stacks/homepage/config/services.yaml` | Create | All service links + widgets grouped by category |
| `stacks/homepage/config/settings.yaml` | Create | Dashboard title, theme, layout |
| `stacks/homepage/config/widgets.yaml` | Create | Top-level info widgets (datetime) |
| `stacks/homepage/config/bookmarks.yaml` | Create | Empty placeholder |
| `stacks/homepage/.env.secret` | Create | SOPS-encrypted API keys (requires manual key retrieval + encryption) |
| `.github/workflows/deploy.yml` | Modify | Add config-sync step before stack deployment |
| `CLAUDE.md` | Modify | Add rule: always add new Traefik hostnames to homepage |

---

## Task 1: Create `stacks/homepage/docker-compose.yml`

**Files:**
- Create: `stacks/homepage/docker-compose.yml`

- [ ] **Step 1: Create the compose file**

```yaml
services:
  homepage:
    image: ghcr.io/gethomepage/homepage:v0.10.9
    container_name: homepage
    restart: unless-stopped
    networks:
      - homelab_default
    volumes:
      - /ssd/services/homepage:/app/config
    environment:
      - TZ=Australia/Sydney
      - HOMEPAGE_VAR_SONARR_API_KEY=${HOMEPAGE_VAR_SONARR_API_KEY}
      - HOMEPAGE_VAR_RADARR_API_KEY=${HOMEPAGE_VAR_RADARR_API_KEY}
      - HOMEPAGE_VAR_LIDARR_API_KEY=${HOMEPAGE_VAR_LIDARR_API_KEY}
      - HOMEPAGE_VAR_PROWLARR_API_KEY=${HOMEPAGE_VAR_PROWLARR_API_KEY}
      - HOMEPAGE_VAR_QBITTORRENT_USERNAME=${HOMEPAGE_VAR_QBITTORRENT_USERNAME}
      - HOMEPAGE_VAR_QBITTORRENT_PASSWORD=${HOMEPAGE_VAR_QBITTORRENT_PASSWORD}
      - HOMEPAGE_VAR_JELLYFIN_API_KEY=${HOMEPAGE_VAR_JELLYFIN_API_KEY}
    healthcheck:
      test: ["CMD-SHELL", "wget --spider -q http://localhost:3000/ || exit 1"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 30s
    labels:
      - traefik.enable=true
      - traefik.http.routers.homepage.service=homepage
      - traefik.http.routers.homepage.rule=Host(`home.tylercash.dev`)
      - traefik.http.routers.homepage.entrypoints=websecure
      - traefik.http.services.homepage.loadbalancer.server.scheme=http
      - traefik.http.services.homepage.loadbalancer.server.port=3000
      - traefik.http.routers.homepage.tls.certresolver=leresolver
      - com.centurylinklabs.watchtower.enable=true

networks:
  homelab_default:
    external: true
```

> **Note on image digest:** After the first deployment, run `docker inspect ghcr.io/gethomepage/homepage:v0.10.9 --format '{{index .RepoDigests 0}}'` on the server and pin the digest in the image field (e.g. `ghcr.io/gethomepage/homepage:v0.10.9@sha256:<digest>`), following the pattern used by all other stacks.

- [ ] **Step 2: Commit**

```bash
git add stacks/homepage/docker-compose.yml
git commit -m "feat(homepage): add compose file for homepage stack"
```

---

## Task 2: Create Homepage config files (settings, widgets, bookmarks)

**Files:**
- Create: `stacks/homepage/config/settings.yaml`
- Create: `stacks/homepage/config/widgets.yaml`
- Create: `stacks/homepage/config/bookmarks.yaml`

- [ ] **Step 1: Create `stacks/homepage/config/settings.yaml`**

```yaml
title: Home
favicon: https://home.tylercash.dev/favicon.ico
theme: dark
color: slate
headerStyle: clean
layout:
  Media:
    style: row
    columns: 4
  Music:
    style: row
    columns: 3
  Content:
    style: row
    columns: 2
  Home:
    style: row
    columns: 4
  AI:
    style: row
    columns: 1
  Infrastructure:
    style: row
    columns: 3
```

- [ ] **Step 2: Create `stacks/homepage/config/widgets.yaml`**

```yaml
- datetime:
    text_size: xl
    format:
      dateStyle: long
      timeStyle: short
      hour12: true
```

- [ ] **Step 3: Create `stacks/homepage/config/bookmarks.yaml`**

```yaml
[]
```

- [ ] **Step 4: Commit**

```bash
git add stacks/homepage/config/settings.yaml stacks/homepage/config/widgets.yaml stacks/homepage/config/bookmarks.yaml
git commit -m "feat(homepage): add settings, widgets, and bookmarks config"
```

---

## Task 3: Create `stacks/homepage/config/services.yaml`

**Files:**
- Create: `stacks/homepage/config/services.yaml`

This file defines all service links. Widgets make API calls from the Homepage container to other containers on `homelab_default` using internal Docker DNS (container names), not the public hostnames — this avoids unnecessary external round-trips.

- [ ] **Step 1: Create `stacks/homepage/config/services.yaml`**

```yaml
- Media:
    - Jellyfin:
        href: https://jellyfin.tylercash.dev
        description: Media server
        icon: jellyfin.png
        widget:
          type: jellyfin
          url: http://jellyfin:8096
          key: "{{HOMEPAGE_VAR_JELLYFIN_API_KEY}}"
    - Plex:
        href: https://plex.tylercash.dev
        description: Media server
        icon: plex.png
    - Radarr:
        href: https://radarr.tylercash.dev
        description: Movie management
        icon: radarr.png
        widget:
          type: radarr
          url: http://radarr:7878
          key: "{{HOMEPAGE_VAR_RADARR_API_KEY}}"
    - Sonarr:
        href: https://sonarr.tylercash.dev
        description: TV management
        icon: sonarr.png
        widget:
          type: sonarr
          url: http://sonarr:8989
          key: "{{HOMEPAGE_VAR_SONARR_API_KEY}}"
    - Prowlarr:
        href: https://prowlarr.tylercash.dev
        description: Indexer aggregator
        icon: prowlarr.png
        widget:
          type: prowlarr
          url: http://prowlarr:9696
          key: "{{HOMEPAGE_VAR_PROWLARR_API_KEY}}"
    - qBittorrent:
        href: https://qbittorrent.tylercash.dev
        description: Torrent client
        icon: qbittorrent.png
        widget:
          type: qbittorrent
          url: http://qbittorrent:8200
          username: "{{HOMEPAGE_VAR_QBITTORRENT_USERNAME}}"
          password: "{{HOMEPAGE_VAR_QBITTORRENT_PASSWORD}}"
    - Profilarr:
        href: https://profilarr.tylercash.dev
        description: Quality profiles editor
        icon: mdi-tune
    - Byparr:
        href: https://byparr.tylercash.dev
        description: Cloudflare bypass
        icon: mdi-shield-check

- Music:
    - Navidrome:
        href: https://music.tylercash.dev
        description: Music streaming
        icon: navidrome.png
    - Lidarr:
        href: https://lidarr.tylercash.dev
        description: Music management
        icon: lidarr.png
        widget:
          type: lidarr
          url: http://lidarr:8686
          key: "{{HOMEPAGE_VAR_LIDARR_API_KEY}}"
    - Slskd:
        href: https://slskd.tylercash.dev
        description: Soulseek client
        icon: mdi-account-music

- Content:
    - Kapowarr:
        href: https://comics.tylercash.dev
        description: Comic book management
        icon: mdi-book-open-variant
    - Romm:
        href: https://roms.tylercash.dev
        description: ROM collection manager
        icon: mdi-controller

- Home:
    - Home Assistant:
        href: https://hassio.tylercash.dev
        description: Home automation
        icon: home-assistant.png
    - Mealie:
        href: https://mealie.tylercash.dev
        description: Recipe management
        icon: mealie.png
    - Immich:
        href: https://photos.tylercash.dev
        description: Photo library
        icon: immich.png
    - n8n:
        href: https://n8n.tylercash.dev
        description: Workflow automation
        icon: n8n.png

- AI:
    - Open WebUI:
        href: https://chat.tylercash.dev
        description: AI chat interface
        icon: mdi-robot

- Infrastructure:
    - Unifi:
        href: https://unifi.tylercash.dev
        description: Network management
        icon: unifi.png
    - Signoz:
        href: https://signoz.tylercash.dev
        description: Observability
        icon: mdi-chart-timeline-variant
    - Adminer:
        href: https://adminer.tylercash.dev
        description: Database admin
        icon: mdi-database
```

- [ ] **Step 2: Commit**

```bash
git add stacks/homepage/config/services.yaml
git commit -m "feat(homepage): add services config with all stacks and widgets"
```

---

## Task 4: Create and encrypt `.env.secret`

**Files:**
- Create: `stacks/homepage/.env.secret` (via SOPS)

The API keys for Homepage widgets live in `.env.secret`. You need to retrieve them from each running service before encrypting.

**How to get each API key:**
- **Sonarr/Radarr/Lidarr/Prowlarr:** Settings → General → API Key
- **Jellyfin:** Dashboard → API Keys → + (create one)
- **qBittorrent:** The WebUI username/password (Settings → Web UI)

- [ ] **Step 1: Create the decrypted secret file**

```bash
cat > stacks/homepage/.env.secret.dec <<'EOF'
HOMEPAGE_VAR_SONARR_API_KEY=<sonarr-api-key>
HOMEPAGE_VAR_RADARR_API_KEY=<radarr-api-key>
HOMEPAGE_VAR_LIDARR_API_KEY=<lidarr-api-key>
HOMEPAGE_VAR_PROWLARR_API_KEY=<prowlarr-api-key>
HOMEPAGE_VAR_QBITTORRENT_USERNAME=<qbittorrent-webui-username>
HOMEPAGE_VAR_QBITTORRENT_PASSWORD=<qbittorrent-webui-password>
HOMEPAGE_VAR_JELLYFIN_API_KEY=<jellyfin-api-key>
EOF
```

Replace each `<...>` with the real value from the running services.

- [ ] **Step 2: Encrypt it**

```bash
task encrypt
```

Expected output includes: `Encrypted: stacks/homepage/.env.secret.dec → stacks/homepage/.env.secret`

- [ ] **Step 3: Verify it's encrypted (not plaintext)**

```bash
task status
```

Expected: `🔒 stacks/homepage/.env.secret`

- [ ] **Step 4: Clean up the decrypted file**

```bash
task clean
```

- [ ] **Step 5: Commit the encrypted file**

```bash
git add stacks/homepage/.env.secret
git commit -m "feat(homepage): add encrypted API keys for widget integrations"
```

---

## Task 5: Add config-sync step to `deploy.yml`

**Files:**
- Modify: `.github/workflows/deploy.yml`

The self-hosted runner runs on the same machine as Docker, so it can write directly to `/ssd/services/homepage/`. This step syncs the checked-in config files there before Portainer deploys the stack.

- [ ] **Step 1: Add the sync step to `deploy.yml`**

In `.github/workflows/deploy.yml`, add a new step **between** "Detect changed stacks" and "Deploy changed stacks":

```yaml
      - name: Sync homepage config
        run: |
          if echo "${{ steps.changes.outputs.stacks }}" | grep -q "^homepage$"; then
            mkdir -p /ssd/services/homepage
            cp -r stacks/homepage/config/. /ssd/services/homepage/
            echo "Homepage config synced to /ssd/services/homepage/"
          fi
```

The full `deploy` job steps section should read:

```yaml
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2

      - name: Detect changed stacks
        id: changes
        run: |
          if [ "${{ github.event_name }}" = "workflow_dispatch" ]; then
            echo "Manual trigger — deploying all stacks"
            changed=$(find stacks -name 'docker-compose.yml' \
              | sed 's|stacks/||' \
              | sed 's|/docker-compose\.yml||')
          elif git rev-parse HEAD~1 &>/dev/null; then
            changed=$(git diff --name-only HEAD~1 HEAD -- stacks/ \
              | grep -E '(docker-compose\.yml|\.env\.secret)' \
              | sed 's|stacks/||' \
              | sed 's|/[^/]*$||' \
              | sort -u)
          else
            echo "Initial commit — deploying all stacks"
            changed=$(find stacks -name 'docker-compose.yml' \
              | sed 's|stacks/||' \
              | sed 's|/docker-compose\.yml||')
          fi
          echo "Changed stacks: $changed"
          echo "stacks<<EOF" >> $GITHUB_OUTPUT
          echo "$changed" >> $GITHUB_OUTPUT
          echo "EOF" >> $GITHUB_OUTPUT

      - name: Sync homepage config
        run: |
          if echo "${{ steps.changes.outputs.stacks }}" | grep -q "^homepage$"; then
            mkdir -p /ssd/services/homepage
            cp -r stacks/homepage/config/. /ssd/services/homepage/
            echo "Homepage config synced to /ssd/services/homepage/"
          fi

      - name: Deploy changed stacks
        env:
          PORTAINER_URL: ${{ vars.PORTAINER_URL }}
          PORTAINER_TOKEN: ${{ secrets.PORTAINER_TOKEN }}
          PORTAINER_ENDPOINT_ID: ${{ vars.PORTAINER_ENDPOINT_ID }}
          SOPS_AGE_KEY: ${{ secrets.SOPS_AGE_KEY }}
        run: |
          failed_stacks=()
          while IFS= read -r stack; do
            [ -z "$stack" ] && continue
            echo "Deploying stack: $stack"
            if ! bash scripts/deploy-stack.sh "$stack"; then
              echo "ERROR: Stack '$stack' failed"
              failed_stacks+=("$stack")
            fi
          done <<< "${{ steps.changes.outputs.stacks }}"
          if [ ${#failed_stacks[@]} -gt 0 ]; then
            echo "Failed stacks: ${failed_stacks[*]}"
            exit 1
          fi
```

> **Note:** The grep pattern `^homepage$` ensures an exact match so a stack named e.g. `homepage-staging` wouldn't accidentally trigger the sync. The `workflow_dispatch` path will also output `homepage` as one of the stacks, so a manual full redeploy correctly syncs config too.

- [ ] **Step 2: Also trigger sync when config files change**

The "Detect changed stacks" step only watches `docker-compose.yml` and `.env.secret`. If someone edits `services.yaml`, the homepage stack won't redeploy. Fix this by adding `stacks/**/config/**` to the path filters in `deploy.yml`'s `on.push.paths`:

```yaml
on:
  push:
    branches: [master]
    paths:
      - "stacks/**/docker-compose.yml"
      - "stacks/**/.env.secret"
      - "stacks/**/config/**"
  workflow_dispatch:
```

Also update the changed-stacks detection to include config file changes. Note: the second `sed` is changed from `'s|/[^/]*$||'` (strips last component) to `'s|/.*||'` (strips everything after first slash), so that 3-level paths like `homepage/config/services.yaml` correctly resolve to `homepage`:

```yaml
          elif git rev-parse HEAD~1 &>/dev/null; then
            changed=$(git diff --name-only HEAD~1 HEAD -- stacks/ \
              | grep -E '(docker-compose\.yml|\.env\.secret|config/)' \
              | sed 's|stacks/||' \
              | sed 's|/.*||' \
              | sort -u)
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "feat(homepage): sync config files to server on deploy"
```

---

## Task 6: Update `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add homepage rule to `CLAUDE.md`**

Append a new section at the end of `CLAUDE.md`:

```markdown
## Homepage Dashboard

A Homepage dashboard runs at `home.tylercash.dev` (`stacks/homepage/`).

**Rule: Whenever you add a new service with a Traefik hostname to any stack, you must also add it to `stacks/homepage/config/services.yaml`** under the appropriate group. Use the existing entries as a template. If the service has a native Homepage widget integration, wire it up with the relevant `HOMEPAGE_VAR_*` key in both `docker-compose.yml` (environment section) and `.env.secret`.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add homepage maintenance rule to CLAUDE.md"
```

---

## Task 7: Verify deployment

- [ ] **Step 1: Push to master and watch the Actions run**

```bash
git push origin claude/wizardly-jennings
```

After the PR is merged to master, the GitHub Actions deploy workflow will:
1. Sync `stacks/homepage/config/` → `/ssd/services/homepage/`
2. Deploy the `homepage` stack to Portainer

- [ ] **Step 2: Verify the service is up**

Navigate to `https://home.tylercash.dev` in a browser. You should see the Homepage dashboard with all six service groups.

- [ ] **Step 3: Check widget connectivity**

If any widget shows an error icon, check:
1. The API key for that service is correct in `.env.secret`
2. The service container is running and healthy (`docker ps | grep <container-name>`)
3. The internal URL in `services.yaml` matches the container name (`docker inspect <container> | grep '"Name"'`)
