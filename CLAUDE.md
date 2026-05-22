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
