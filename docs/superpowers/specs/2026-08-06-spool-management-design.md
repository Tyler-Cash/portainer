# Spool Management Design

**Date:** 2026-08-06
**Status:** Approved

## Overview

Add filament spool inventory tracking for a Bambu Lab P1S, using
[Spoolman](https://github.com/Donkie/Spoolman) as the inventory database and
[SpoolmanSync](https://github.com/gibz104/SpoolmanSync) to assign the loaded spool and
deduct filament usage automatically after each print.

The printer is a **P1S with no AMS** — just the external spool holder. Filament is a mix
of genuine Bambu and eSun, with more third-party brands planned.

## Constraint That Shapes The Design

The RFID reader lives in the AMS. The external spool holder has no reader, so the printer
cannot identify a mounted spool — a Bambu spool with an RFID tag is indistinguishable from
an eSun one. **All RFID-driven auto-detection is unavailable**, which rules out
`bambulab-ams-spoolman-filamentstatus` and `spoolman-bambu-filament-status`; both are
RFID-only and AMS-only.

With one slot, "which spool is loaded" is a single value that changes on swap. The only
thing worth automating is subtracting the filament a print consumed.

## Architecture

```
P1S (LAN mode, br_iot)
  └─> ha-bambulab in the existing Home Assistant
        └─> SpoolmanSync   (assign spool to slot, generate deduction automations)
              └─> Spoolman (inventory: vendors, filaments, spools, remaining weight)
```

SpoolmanSync does **not** talk to the printer. It reads state from Home Assistant via
`ha-bambulab` and generates HA automations that POST usage to Spoolman's REST API. HA is
therefore load-bearing for filament tracking.

External spool support is confirmed in the SpoolmanSync source, not just its README:
`external_spools[]` is a distinct array alongside AMS trays, composite tray ID `0` is
reserved for the external spool, and the assign/scan UI offers "External Spool" as a
target (`app/src/app/scan/spool/[id]/page.tsx:128`).

### Workflow

1. Swap filament on the holder.
2. In SpoolmanSync, assign the spool to **External Spool** — pick from a list, or scan a
   QR sticker on the spool.
3. Print. On completion the HA automation posts `used_weight` to Spoolman.

## Files Created

```
stacks/spoolman/
└── docker-compose.yml                    # spoolman + spoolmansync

stacks/home-assistant/
└── packages/
    └── spoolmansync.yaml                 # rest_commands + deduction automations
```

## Files Modified

```
stacks/home-assistant/docker-compose.yml  # mount ./packages, add STACK_CONTENT_HASH
stacks/homepage/config/services.yaml      # new "3D Printing" group
```

## stacks/spoolman/docker-compose.yml

Two services on the external `homelab_default` network, following the conventions in
`stacks/mealie/docker-compose.yml`: `x-logging` anchor, tag **and** digest pin,
`deploy.resources.limits.memory`, healthcheck, `restart: unless-stopped`, watchtower
label, and Traefik with the `ClientIP` guard used by internal services.

| Service | Image | Host | Port | Bind mount |
|---|---|---|---|---|
| `spoolman` | `ghcr.io/donkie/spoolman:0.9.1` | `spoolman.tylercash.dev` | 8000 | `/ssd/services/spoolman:/home/app/.local/share/spoolman` |
| `spoolmansync` | `ghcr.io/gibz104/spoolmansync:1.6.8` | `spools.tylercash.dev` | 3000 | `/ssd/services/spoolmansync:/data` |

Spoolman defaults to SQLite in that directory; no database service is needed. Both
services get `TZ=Australia/Sydney`, and Spoolman additionally gets `PUID=568`/`PGID=568`
— its entrypoint honours those and drops privileges with gosu, matching every other stack.

SpoolmanSync environment:

| Variable | Value | Notes |
|---|---|---|
| `HA_MODE` | `external` | Use the existing HA, not a bundled one |
| `HA_URL` | `http://home-assistant:8123` | Container name on `homelab_default` |
| `SPOOLMAN_URL` | `http://spoolman:8000` | Internal, not via Traefik |
| `NEXTAUTH_URL` | `https://spools.tylercash.dev` | OAuth redirect base — must be the external URL |

Deviations from upstream's `docker-compose.prebuilt.yml`:

- **Drop the `ports:` mappings.** Traefik handles ingress.
- **Drop the `embedded` profile entirely.** It bundles a second Home Assistant and a
  `privileged: true` container. Use the `external` profile's service definition only.
- **Named volumes become bind mounts** under `/ssd/services/`, matching every other stack.

Traefik rule pattern, per `stacks/mealie/docker-compose.yml:36`:

```
Host(`spoolman.tylercash.dev`) && (ClientIP(`10.0.0.0/8`) || ClientIP(`172.19.0.0/24`))
```

## DNS

There is **no wildcard record** for `*.tylercash.dev` — each service hostname is an
explicit A record in Cloudflare pointing at `10.0.90.10`, and nothing in this repo creates
them (Traefik uses `CF_DNS_API_TOKEN` only for the ACME DNS-01 challenge; there is no
external-dns or cloudflare-companion container). Verified: `mealie.tylercash.dev` resolves
to `10.0.90.10`, while an arbitrary name under the zone returns NXDOMAIN.

Two A records must be created by hand in Cloudflare before the stack is reachable:

| Name | Type | Value | Proxy |
|---|---|---|---|
| `spoolman` | A | `10.0.90.10` | DNS only (grey cloud) |
| `spools` | A | `10.0.90.10` | DNS only (grey cloud) |

Proxying must stay off: the target is a private address, and Traefik's `ClientIP` guard
would see Cloudflare's edge IPs rather than the LAN client.

## Secrets

**None.** Spoolman on SQLite has no credentials. SpoolmanSync authenticates to Home
Assistant over OAuth and stores refresh tokens in its own `/data` volume, not in an env
var. No `.env.secret` for this stack, and nothing for SOPS to manage.

## Home Assistant Config Management

`stacks/home-assistant/packages/spoolmansync.yaml` is bind-mounted read-only at
`/config/packages/spoolmansync.yaml`. Git is the source of truth, the same contract the
Grafana dashboards use.

Add `STACK_CONTENT_HASH: __STACK_CONTENT_HASH__` to the `home-assistant` service so that
editing the package file produces a compose definition diff and recreates the container,
reloading the package. The mechanism is implemented in
`ansible/roles/stacks/tasks/main.yml:44-68`; relative bind mounts resolve because Ansible
syncs each stack to `/opt/stacks/<name>/`, as `stacks/grafana-lgtm/docker-compose.yml:148`
already relies on.

The package content is generated by SpoolmanSync's Automations page and copied into the
repo file. It defines `rest_command.spoolmansync_*` plus automations triggered on tray
change and print completion, which post `used_weight` / `used_length` to Spoolman.

### Deliberately Not Git-Managed

**The printer's config entry.** `ha-bambulab` declares `config_flow: true` with no YAML
setup path, so the printer IP, serial, and LAN access code live in
`.storage/core.config_entries` — HA-owned state. Adding the printer is a one-time UI
click-through.

**`configuration.yaml`.** It lives at `/ssd/services/homeassistant` and is UI-adjacent, so
the repo does not own the whole file. It needs one manual addition:

```yaml
homeassistant:
  packages: !include_dir_named packages
```

Add this by hand rather than using SpoolmanSync's auto-configure, which edits the file
in place and has a known bug (issue #73) where it inserts a duplicate `packages:` key on
CRLF files. YAML keeps the last duplicate, so the package silently never loads while the
UI reports success.

**The `ha-bambulab` integration files.** Installed via HACS into
`/ssd/services/homeassistant/custom_components/`. Chosen over vendoring the source into
the repo: HACS gives UI updates with changelogs, whereas vendoring would mean re-copying
the source tree by hand on every release and writing a custom Renovate manager to notice
them.

## Homepage

New `3D Printing` group in `stacks/homepage/config/services.yaml`, per the rule in
`CLAUDE.md`:

```yaml
- 3D Printing:
    - Spoolman:
        href: https://spoolman.tylercash.dev
        description: Filament inventory
        icon: spoolman.png
        widget:
          type: spoolman
          url: http://spoolman:8000
    - SpoolmanSync:
        href: https://spools.tylercash.dev
        description: Spool assignment and usage sync
        icon: mdi-printer-3d-nozzle
```

The Spoolman widget needs no API key. It shows 4 spools by default; `spoolIds` can pin
which ones once there are more than that.

## Manual Setup Steps

Ordered, one-time, outside git:

1. Enable **LAN Mode Liveview** on the P1S; note its IP, serial, and access code.
2. Install HACS in Home Assistant, then `ha-bambulab` through it.
3. Add the Bambu Lab integration in the HA UI with the printer's credentials. Confirm an
   **External Spool** device with a `external_spool` entity appears.
4. Add the `packages:` directive to `configuration.yaml` and restart HA.
5. Deploy the `spoolman` stack.
6. In SpoolmanSync settings, set the Spoolman URL and complete the HA OAuth connection.
7. Generate the automations, copy the package YAML into
   `stacks/home-assistant/packages/spoolmansync.yaml`, commit, and let Ansible deploy it.
8. Create spools in Spoolman, assign one to the External Spool slot, run a test print,
   confirm the remaining weight drops.

## Accuracy Limitation

Deduction uses `filament_used_weight` as reported through `ha-bambulab`. Without an AMS
load cell this derives from the **slicer's estimate**, not a measurement, so error
accumulates over the life of a spool. Re-weigh spools periodically and correct the value
in Spoolman. The only real fix is hardware — [FilaMan](https://www.filaman.app/)'s ESP32
load cell — which is out of scope.

## Known Risks

| Risk | Detail | Mitigation |
|---|---|---|
| HA OAuth behind Traefik | SpoolmanSync hardcodes `client_id: 'http://spoolmansync'` (`app/src/lib/api/homeassistant.ts:208`). HA's IndieAuth flow may reject a client_id it cannot resolve. | Verify at step 6. If it fails, reach HA directly on the container network or expose SpoolmanSync at a URL HA can resolve. |
| HA reachability to printer | HA must reach the P1S across `br_iot`. | Already true for existing IoT devices on that network. |
| Duplicate `packages:` key | See above. | Add the directive manually; verify `rest_command.spoolmansync_*` exists in Developer Tools after restart. |
| Silent tracking failure | An unassigned slot or a broken automation deducts nothing, and inventory drifts without an error. | Confirm the weight drop on the step 8 test print. |
| Bind mount ownership | **Hit during deploy.** `ensure-zfs-datasets.sh` creates `/ssd/services/spoolman` as root, and Spoolman's entrypoint drops to UID 568 via gosu *before* the app tries to chown it, so the app exits with `Data directory is not writable`. Nothing in the Ansible role sets ownership for any stack. | One-off `sudo chown -R 568:568 /ssd/services/spoolman` on the host, then restart. Applies to any new stack whose container runs unprivileged. |

## Out of Scope

- AMS support (no AMS owned).
- Hardware weight measurement (FilaMan / load cells).
- Multi-printer support.
- Grafana dashboards for filament usage.
