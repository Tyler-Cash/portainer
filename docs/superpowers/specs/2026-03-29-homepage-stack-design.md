# Homepage Stack Design

**Date:** 2026-03-29
**Status:** Approved

## Overview

Add a [Homepage](https://gethomepage.dev) dashboard as a new dedicated stack (`stacks/homepage/`) that links to all services in the project. The dashboard will be publicly accessible at `home.tylercash.dev` and will include live service widgets where supported.

## Files Created

```
stacks/homepage/
├── docker-compose.yml        # Homepage container with Traefik labels
└── config/
    ├── services.yaml         # All service links grouped by category
    ├── settings.yaml         # Title, theme, color scheme
    ├── widgets.yaml          # Top-level info widgets (datetime)
    └── bookmarks.yaml        # Empty placeholder
```

## docker-compose.yml

- Image: `ghcr.io/gethomepage/homepage:latest` (pinned to digest)
- Volume mounts: `./config:/app/config/`
- Traefik labels:
  - Host: `home.tylercash.dev`
  - Entrypoint: `websecure`
  - TLS: `leresolver`
  - **No IP restriction** (publicly accessible)
- Network: `homelab_default` (external)

## Service Groups in services.yaml

| Group | Services |
|---|---|
| Media | Jellyfin (`jellyfin.tylercash.dev`), Plex (`plex.tylercash.dev`), Radarr (`radarr.tylercash.dev`), Sonarr (`sonarr.tylercash.dev`), Prowlarr (`prowlarr.tylercash.dev`), qBittorrent (`qbittorrent.tylercash.dev`), Profilarr (`profilarr.tylercash.dev`), Byparr (`byparr.tylercash.dev`) |
| Music | Navidrome (`music.tylercash.dev`), Lidarr (`lidarr.tylercash.dev`), Slskd (`slskd.tylercash.dev`) |
| Content | Kapowarr (`comics.tylercash.dev`), Romm (`roms.tylercash.dev`) |
| Home | Home Assistant (`hassio.tylercash.dev`), Mealie (`mealie.tylercash.dev`), Immich (`photos.tylercash.dev`), n8n (`n8n.tylercash.dev`) |
| AI | Open WebUI (`chat.tylercash.dev`) |
| Infrastructure | Unifi (`unifi.tylercash.dev`), Signoz (`signoz.tylercash.dev`), Adminer (`adminer.tylercash.dev`) |

## Live Widgets

Homepage has native integrations for these services — wire them up with API keys sourced from a `stacks/homepage/.env.secret` SOPS file:

| Service | Widget type | Data shown |
|---|---|---|
| Sonarr | sonarr | Wanted, queued, series count |
| Radarr | radarr | Wanted, queued, movie count |
| Lidarr | lidarr | Wanted, queued, artist count |
| Prowlarr | prowlarr | Indexer count, grab stats |
| qBittorrent | qbittorrent | Active torrents, speeds |
| Jellyfin | jellyfin | Library counts, active streams |

API keys go in `stacks/homepage/.env.secret` (SOPS-encrypted), referenced in `services.yaml` via `{{HOMEPAGE_VAR_*}}` environment variable syntax.

## CLAUDE.md Update

Add a rule: whenever a new service with a Traefik hostname is added to any stack, it must also be added to `stacks/homepage/config/services.yaml`.

## Access

- URL: `https://home.tylercash.dev`
- Auth: None (public) — the dashboard links to services, most of which are already protected by their own auth or IP restriction at the Traefik level
