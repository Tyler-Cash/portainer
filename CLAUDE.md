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

`stacks/spoolman/` runs two services: **Spoolman** (`spoolman.tylercash.dev`) as the filament inventory database, and **Bambuddy** (`bambuddy.tylercash.dev`) as the print queue and printer control plane. Bambuddy reports per-filament usage into Spoolman. Design: `docs/superpowers/specs/2026-08-06-spool-management-design.md`.

**Bambuddy talks MQTT (TLS) and FTPS directly to the printer. Home Assistant is not in the path.** An earlier iteration used SpoolmanSync driving Spoolman through HA automations; that was replaced to decouple printing from HA and to gain a print queue. `ha-bambulab` is still installed for HA dashboards and automations, but nothing depends on it for filament tracking.

**Developer Mode must stay enabled on the printer.** Bambu firmware >= 01.08.03 verifies the source of MQTT control commands and rejects anything not signed by current Studio/Handy (HMS `0500-0500-0001-0007`). Developer Mode disables that check, and without it Bambuddy cannot start prints.

The printer has **no AMS**, only the external spool holder, so there is no RFID reader and no auto-detection of what is loaded. The mounted spool is assigned by hand in Bambuddy on every swap. Deducted weight comes from the 3MF slicer estimate rather than a measurement, so error accumulates — re-weigh spools occasionally and correct the value in Spoolman.

`stacks/home-assistant/packages/` is still bind-mounted read-only at `/config/packages` with `STACK_CONTENT_HASH` wired up, and `configuration.yaml` (on the host, not in git) carries the matching `packages: !include_dir_named packages` directive. It is currently empty, kept for any future git-managed HA config.

### Virtual printer

Bambuddy emulates a Bambu printer so Bambu Studio can send prints straight into its queue. This is the one place the stack publishes host ports; the web UI still goes through Traefik on 8000.

Published: `3000`, `3002` (bind/detect), `8883` (MQTT), `990` (FTP control), `2024-2026` (A1/P1S proprietary), `50000-50009` (passive FTP). Ports `6000` and `322` are **proxy-mode only** — and 322 is for X1/H2/P2 cameras — so neither is published. Passive-FTP ports are sliced 10 per VP by id (VP 1 → `50000-50009`); widen the range when adding VPs. Every published port spawns a docker-proxy process per address family, which is why the full `50000-50100` range is avoided.

`cap_add: NET_BIND_SERVICE` is required because the VP binds FTP directly on 990. `VIRTUAL_PRINTER_PASV_ADDRESS=10.0.90.10` is required on bridge mode — passive FTP hands the client a callback address, and without it the VP advertises its unreachable container IP.

**Two manual slicer-side steps:** SSDP discovery does not work on bridge mode, so add the VP in Bambu Studio **by host IP**, and **import Bambuddy's self-signed CA** — Studio validates printer TLS against a bundled BBL CA rather than the system trust store, and its Add Printer dialog is IP-only, so a publicly-trusted cert cannot substitute.

### AI failure detection

`obico-ml` runs Obico's failure-detection ML API. Bambuddy drives it natively — only the inference service is needed, not the full Obico server (Django, Postgres, Redis, Celery). It has no Traefik hostname; only Bambuddy talks to it over `homelab_default`.

**It is built from source, not pinned to a published image** — the only `ml_api` tag on Docker Hub is from 2019 and the `base-*` tags are build bases. The git context is pinned to a commit SHA so builds are reproducible and Ansible's content-hash gate only rebuilds when that SHA changes. **Renovate cannot track this — bump the SHA by hand.**

`ML_API_TOKEN` lives in `stacks/spoolman/.env.secret` (SOPS). It gates Obico's `/p/` endpoint; `/hc/` stays open and is what the healthcheck uses.

Obico's ML API is GET-only (`/p/?img=<url>`) and **fetches the frame itself**, so Bambuddy's `external_url` setting must be reachable from the `obico-ml` container. Keep it as `https://bambuddy.tylercash.dev` — the `ClientIP(172.19.0.0/24)` clause in the Traefik rule covers container-network sources. Do not set it to an internal URL: it also builds the login links in notifications.
