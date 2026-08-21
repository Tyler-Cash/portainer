# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

Portainer stack management repo for `portainer.tylercash.dev`. Each subdirectory under `stacks/` contains a `docker-compose.yml` (and optionally `.env.secret` for encrypted secrets) for a single Docker Compose stack deployed via Portainer.

## Secret Management

Secrets are managed with **SOPS + age encryption**. Sensitive env vars live in `.env.secret` files (SOPS-encrypted). Decrypted versions use the `.dec` suffix and must never be committed.

**Never modify `.env.secret` files directly** — use `task edit STACK=<name>` which opens them through SOPS for safe editing.

A pre-commit hook (`hooks/pre-commit`) blocks commits containing unencrypted `.env.secret` files.

## Common Commands (via Taskfile)

| Command | Description |
|---------|-------------|
| `task setup` | First-time setup: installs pre-commit hook, checks for sops/age |
| `task encrypt` | Encrypt all `.env.secret.dec` → `.env.secret` |
| `task decrypt` | Decrypt all `.env.secret` → `.env.secret.dec` |
| `task edit STACK=<name>` | Edit a stack's secrets via SOPS (e.g., `task edit STACK=clawbot`) |
| `task status` | Show encryption status of all secret files |
| `task clean` | Remove all decrypted `.dec` files |
| `task hook` | Install the pre-commit hook to `.git/hooks/` |

## Repository Structure

- `stacks/<name>/docker-compose.yml` — Compose definition for each stack
- `stacks/<name>/.env.secret` — SOPS-encrypted secret env vars (not all stacks have these)
- `hooks/pre-commit` — Git hook preventing unencrypted secret commits
- `Taskfile.yml` — Task runner definitions
- `script.sh` — Portainer stack exporter
- `.sops.yaml` — SOPS encryption config (age key recipients)

## Homepage Dashboard

A Homepage dashboard runs at `home.tylercash.dev` (`stacks/homepage/`).

**Rule: Whenever you add a new service with a Traefik hostname to any stack, you must also add it to `stacks/homepage/config/services.yaml`** under the appropriate group. Use the existing entries as a template. If the service has a native Homepage widget integration, wire it up with the relevant `HOMEPAGE_VAR_*` key in both `docker-compose.yml` (environment section) and `.env.secret`.

## Grafana Dashboards (peep-bot)

Peep Bot dashboards are JSON-provisioned via the `grafana/otel-lgtm` bundle. JSON lives in `stacks/grafana-lgtm/grafana/dashboards/peepbot/`; the provider config lives in `stacks/grafana-lgtm/grafana/provisioning/dashboards/peepbot.yaml`. Both are bind-mounted into the container. UI edits revert on the next 30s sweep — source of truth is git.

After changing any dashboard JSON, run `task grafana:smoke` (requires `GRAFANA_TOKEN`) to validate every PromQL expression parses against the live Prometheus.

The dashboards use an OTel-flavoured selector: `{service_namespace="peep-bot", service_name=~"$service", deployment_environment_name=~"$env"}`. **All Micrometer timers from peep-bot export with `_milliseconds_*` suffix, not `_seconds_*`.** Template variables use `application_ready_time_milliseconds` (not `up{}`) for label discovery since OTLP-ingested series don't carry the resource labels on `up`.

## 3D Printing (Bambu P1S)

`stacks/spoolman/` runs three user-facing services: **Spoolman** (`spoolman.tylercash.dev`) as the filament inventory database, **Bambuddy** (`bambuddy.tylercash.dev`) as the print queue and printer control plane, and **Manyfold** (`manyfold.tylercash.dev`) as the 3D-model library of record. Bambuddy reports per-filament usage into Spoolman. Design: `docs/superpowers/specs/2026-08-06-spool-management-design.md`.

**Bambuddy talks MQTT (TLS) and FTPS directly to the printer. Home Assistant is not in the path.** An earlier iteration used SpoolmanSync driving Spoolman through HA automations; that was replaced to decouple printing from HA and to gain a print queue. `ha-bambulab` is still installed for HA dashboards and automations, but nothing depends on it for filament tracking.

**Developer Mode must stay enabled on the printer.** Bambu firmware >= 01.08.03 verifies the source of MQTT control commands and rejects anything not signed by current Studio/Handy (HMS `0500-0500-0001-0007`). Developer Mode disables that check, and without it Bambuddy cannot start prints.

The printer has **no AMS**, only the external spool holder, so there is no RFID reader and no auto-detection of what is loaded. The mounted spool is assigned by hand in Bambuddy on every swap. Deducted weight comes from the 3MF slicer estimate rather than a measurement, so error accumulates — re-weigh spools occasionally and correct the value in Spoolman.

`stacks/home-assistant/packages/` is still bind-mounted read-only at `/config/packages` with `STACK_CONTENT_HASH` wired up, and `configuration.yaml` (on the host, not in git) carries the matching `packages: !include_dir_named packages` directive. It is currently empty, kept for any future git-managed HA config.

### Manyfold (3D model library)

**Manyfold** (`manyfold.tylercash.dev`) is the self-hosted library of record for 3D models. Three services in the same compose file: the `manyfold` app (which also runs its own background workers — no separate worker service), `manyfold-db` (Postgres), and `manyfold-redis`. Pinned on **ghcr**, not Docker Hub: Docker Hub's `manyfold3d/manyfold` only publishes `sha-`/`edge`/`nightly` tags, so a semver-tag + digest pin (what Renovate tracks) is only possible on ghcr — same as Spoolman. The app listens on **3214**. Env is discrete `DATABASE_*` vars, not a `DATABASE_URL`. Manyfold has its **own** library dir `/ssd/services/manyfold/models` (register it as `/models` in the "new library" form) — Bambuddy's archive is deliberately not bind-mounted in; the sync add-on uploads over the API instead.

**Option-A provenance workflow.** "Source" is captured two ways:
1. **Manyfold's built-in URL import** — paste a Thingiverse / MyMiniFactory / Cults3D / Thangs model URL and it creates the model with the source link, metadata and images. **Printables is NOT supported by URL import** — for a Printables model, import the file manually and add the source link by hand.
2. **The `bambuddy-to-manyfold` sync add-on** (`hibikipr/bambuddy_to_manyfold`, Phase 2 below) pushes Bambuddy's print archive + file-manager library into Manyfold, recreating the folder hierarchy as nested collections and enriching MakerWorld-sourced 3MFs with source link, tags and cover.

**Two-phase bring-up** (it can't be one-shot — the sync needs an OAuth app that only exists once Manyfold is running):
- **Phase 1** (live): app + db + redis. After deploy, create the admin account and a library pointing at `/models`. `SECRET_KEY_BASE` and `MANYFOLD_DB_PASSWORD` are in `stacks/spoolman/.env.secret` (SOPS).
- **Phase 2** (commented block in the compose): the sync container. It needs a Manyfold **OAuth application** (grant `client_credentials`) carrying the **`upload`** scope — a personal access token can NOT carry it; the script probes on startup and exits with instructions if it's missing. `--cleanup-empty` additionally needs the **`delete`** scope. It keeps a local state file to skip already-synced items (`--force` retries failures) and uploads via Manyfold's resumable Tus API. One-shot at heart, but shipped here as its long-lived web GUI (port 8089) at `manyfold-sync.tylercash.dev`. To enable: create the OAuth app + a Bambuddy API key, add `MANYFOLD_OAUTH_CLIENT_ID` / `MANYFOLD_OAUTH_CLIENT_SECRET` / `BAMBUDDY_API_KEY` via `task edit STACK=spoolman`, uncomment the block, then add the DNS record + Homepage entry.

### Virtual printer

Bambuddy emulates a Bambu printer so Bambu Studio / OrcaSlicer can send prints straight into its queue.

**Bambuddy sits on two networks.** `printer_lan` is a **macvlan** giving it its own MAC and the LAN IP **`10.0.90.254`**, so the virtual printer is a real L2 device: it binds and advertises its own address, SSDP discovery works, and **no host ports are published at all**. `homelab_default` keeps Traefik, Spoolman and `obico-ml` reachable by container name.

`10.0.90.254` must stay reserved/excluded in UniFi's DHCP scope. The compose pins Docker's IPAM pool to `10.0.90.254/32` so it can never allocate anything else on the LAN.

**Macvlan caveat:** the Docker *host* cannot reach a macvlan container — kernel behaviour, not a misconfiguration. Container-to-container traffic is unaffected, which is why Bambuddy stays on `homelab_default` as well and why Traefik (itself a container) still routes to it normally.

`cap_add: NET_BIND_SERVICE` is still required because the VP binds FTP directly on port 990.

**One manual slicer-side step:** **import Bambuddy's self-signed CA.** Bambu Studio and OrcaSlicer validate printer TLS against a bundled BBL CA rather than the system trust store, and their Add Printer dialog is IP-only, so a publicly-trusted certificate cannot substitute. On Windows/OrcaSlicer, append it to `C:\Program Files\OrcaSlicer\resources\cert\printer.cer` (as Administrator) and fully restart — note OrcaSlicer upgrades overwrite that file.

### AI failure detection

`obico-ml` runs Obico's failure-detection ML API. Bambuddy drives it natively — only the inference service is needed, not the full Obico server (Django, Postgres, Redis, Celery). It has no Traefik hostname; only Bambuddy talks to it over `homelab_default`.

**It is built from source, not pinned to a published image** — the only `ml_api` tag on Docker Hub is from 2019 and the `base-*` tags are build bases. The git context is pinned to a commit SHA so builds are reproducible and Ansible's content-hash gate only rebuilds when that SHA changes. **Renovate cannot track this — bump the SHA by hand.**

`ML_API_TOKEN` lives in `stacks/spoolman/.env.secret` (SOPS). It gates Obico's `/p/` endpoint; `/hc/` stays open and is what the healthcheck uses.

Obico's ML API is GET-only (`/p/?img=<url>`) and **fetches the frame itself**, so Bambuddy's `external_url` setting must be reachable from the `obico-ml` container. Keep it as `https://bambuddy.tylercash.dev` — the `ClientIP(172.19.0.0/24)` clause in the Traefik rule covers container-network sources. Do not set it to an internal URL: it also builds the login links in notifications.
