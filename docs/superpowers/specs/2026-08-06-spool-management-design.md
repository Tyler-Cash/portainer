# Spool Management Design

**Date:** 2026-08-06
**Status:** Superseded in part — see "Revision: Bambuddy" below
**Revised:** 2026-08-07

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

Two long-running services on the external `homelab_default` network plus a one-shot init
container, following the conventions in
`stacks/mealie/docker-compose.yml`: `x-logging` anchor, tag **and** digest pin,
`deploy.resources.limits.memory`, healthcheck, `restart: unless-stopped`, watchtower
label, and Traefik with the `ClientIP` guard used by internal services.

| Service | Image | Host | Port | Bind mount |
|---|---|---|---|---|
| `spoolman-init` | `alpine:3.22` | — | — | `/ssd/services/spoolman:/data` |
| `spoolman` | `ghcr.io/donkie/spoolman:0.26.0` | `spoolman.tylercash.dev` | 8000 | `/ssd/services/spoolman:/home/app/.local/share/spoolman` |
| `spoolmansync` | `ghcr.io/gibz104/spoolmansync:1.6.8` | `spools.tylercash.dev` | 3000 | `/ssd/services/spoolmansync:/data` |

`spoolman-init` runs `chown -R 568:568 /data` as root and exits; see the bind mount
ownership row under Known Risks for why it is needed.

Spoolman defaults to SQLite in that directory; no database service is needed. Both
services get `TZ=Australia/Sydney`, and Spoolman additionally gets `PUID=568`/`PGID=568`
— its entrypoint honours those and drops privileges with gosu, matching every other stack.

SpoolmanSync environment:

| Variable | Value | Notes |
|---|---|---|
| `HA_MODE` | `external` | Use the existing HA, not a bundled one |
| `HA_URL` | `http://home-assistant:8123` | Container name on `homelab_default` |
| `SPOOLMAN_URL` | `http://spoolman:8000` | Internal, not via Traefik. **Only auto-applies in addon mode** — in `HA_MODE=external` the connection must be set explicitly (see below) |
| `NEXTAUTH_URL` | `https://spools.tylercash.dev` | OAuth redirect base — must be the external URL |

The Spoolman connection is stored in SpoolmanSync's own DB, not read from the env var at
runtime — `SPOOLMAN_URL` is only consulted by the addon-mode auto-configure path. Set it
once, either in Settings or via the API:

```bash
curl -X POST https://spools.tylercash.dev/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"type":"spoolman","url":"http://spoolman:8000"}'
```

This also creates the `active_tray` and `barcode` extra fields in Spoolman, which tray
assignment and QR scanning depend on.

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

The package content is generated by SpoolmanSync and pulled into the repo with
`task spoolman:sync-package` (`stacks/spoolman/scripts/sync-ha-package.sh`). It defines
`rest_command.spoolmansync_*` plus automations triggered on tray change and print
completion, which post `used_weight` / `used_length` to Spoolman.

**Do not copy-paste from the Automations page.** That page shows two blocks, and
SpoolmanSync's own auto-configure writes them to two different files: `configurationYaml`
(`rest_command`, `input_number`, `utility_meter`, `sensor`) to the package file, and
`automationsYaml` merged into HA's UI-managed `automations.yaml`, which this repo does not
track. Pasting only the automations block yields a package with no `rest_command` and
automations HA never loads. The script folds both halves into the single git-managed file,
which is valid because HA packages accept `automation:` as a top-level key.

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
| Bind mount ownership | **Hit during deploy.** `ensure-zfs-datasets.sh` creates `/ssd/services/spoolman` as root, and Spoolman's entrypoint drops to UID 568 via gosu *before* the app tries to chown it, so the app exits with `Data directory is not writable`. Nothing in the Ansible role sets ownership for any stack. | Resolved in-repo by the `spoolman-init` service: an alpine container that runs as root, chowns the mount, and exits, with `spoolman` gated on `condition: service_completed_successfully`. Declarative and survives dataset recreation, unlike a one-off host `chown`. |

## Out of Scope

- AMS support (no AMS owned).
- Hardware weight measurement (FilaMan / load cells).
- Multi-printer support.
- Grafana dashboards for filament usage.


---

# Revision: Bambuddy (2026-08-07)

## What changed

SpoolmanSync is retired. **Bambuddy** takes over spool assignment and usage reporting,
and adds a print queue.

Two drivers. First, the original design made Home Assistant load-bearing for filament
tracking — a chain of printer → `ha-bambulab` → SpoolmanSync → Spoolman, where a break
anywhere stops deduction silently. Bambuddy talks MQTT (TLS) and FTPS straight to the
printer, removing HA from the path. Second, reprinting required opening the slicer every
time; Bambuddy queues pre-sliced jobs.

## Revised architecture

```
P1S (LAN mode + Developer Mode, br_iot)
  └─> Bambuddy   (MQTT + FTPS direct; queue, spool assignment, usage reporting)
        └─> Spoolman (inventory: vendors, filaments, spools, remaining weight)
```

Spoolman itself is unchanged, as is all existing spool data.

## Why Bambuddy works here despite no AMS

Its Spoolman documentation is written around AMS slots and RFID matching, which does not
apply to an external-spool-only P1S. Verified before committing to the switch: Bambuddy
supports non-AMS printers and external spool assignment, and derives usage from **3MF
slicer estimates** as the primary source with AMS remain-% delta only as a fallback. The
accuracy basis is therefore the same as the SpoolmanSync setup — an estimate, not a
measurement.

## Developer Mode is now mandatory

Bambu firmware >= 01.08.03 verifies the source of MQTT control commands and rejects
anything not signed by current Studio/Handy (HMS `0500-0500-0001-0007`). Developer Mode
disables that verification. Reading state degrades without it; **starting a print is
impossible**, so the queue does not work at all.

This was already required to resolve the MQTT verification errors seen on this printer.

## Deployment deviations from upstream

| Upstream default | Here | Why |
|---|---|---|
| `network_mode: host` | bridge on `homelab_default` | Host mode exists for SSDP discovery (needs L2 multicast). The printer has a fixed DHCP reservation, so it is added by IP. Bridge keeps Traefik routing by container name, consistent with every other stack. |
| Virtual printer enabled | omitted | Needs `cap_add: NET_BIND_SERVICE`, privileged ports 322/990, and a ~30-port passive-FTP range, plus a CA the slicer must trust. Files are uploaded through the web UI instead. Additive later. |
| Named volumes | bind mounts under `/ssd/services/bambuddy/` | Matches every other stack and puts the data in the ZFS dataset the backup job discovers. |

No init container is needed: Bambuddy's entrypoint chowns `/app/data` and `/app/logs` as
root *before* dropping to `PUID` via gosu — the ordering Spoolman gets wrong.

## DNS

`bambuddy` A → `10.0.90.10`, proxy off. Same manual Cloudflare step as the others; there
is still no wildcard.

The `spools` record is now unused and can be deleted.

## Versioning gotcha

Bambuddy's tags are **4-component** (`1.2.5.2`), not semver. Filtering or sorting tags with
a `\d+\.\d+\.\d+` pattern silently drops every `1.2.x.y` release and picks `0.2.2` — a
five-month-old build — as "latest". This bit the initial pin here. The same class of error
put Spoolman on `0.9.1` (lexical sort ranks it above `0.26.0`). Always resolve "latest" by
image creation date, not by string ordering.

## Retired

- The `spoolmansync` service.
- `stacks/home-assistant/packages/spoolmansync.yaml`.
- `stacks/spoolman/scripts/sync-ha-package.sh` and `task spoolman:sync-package`.
- The `/ssd/services/spoolmansync` dataset still exists on the host with the old SQLite
  DB. Harmless; destroy it once the migration is confirmed good.

`ha-bambulab` stays installed for HA dashboards and automations. Worth watching: two MQTT
clients (HA and Bambuddy) now connect to the printer, and Bambu firmware has been reported
to limit concurrent connections. If printer entities start flapping, that is the first
thing to suspect.

The `./packages` mount and `STACK_CONTENT_HASH` on Home Assistant are kept — empty, but
useful for any future git-managed HA config, and free.


---

# Addendum: AI failure detection (2026-08-07)

## Scope

Obico's **ML API only** — not the Obico server. Bambuddy has first-class support for it
(README:192): it watches each running print's camera feed, smooths scores over time
(30-frame warmup + EWM + rolling means), and fires one configurable action per print —
notify, pause, or pause-and-power-off. Bambuddy is the orchestrator, so the Django app,
Postgres, Redis and Celery workers that make up the rest of Obico are unnecessary.

## Built from source, deliberately

There is no current published image. `thespaghettidetective/ml_api:latest` on Docker Hub
dates from 2019, and the `base-*` tags are build bases referenced by the app's Dockerfile,
not the app. So `obico-ml` uses a `build:` context — consistent with `ts-clipper` and
`zipline-transcoder`, and supported by `ansible/roles/stacks/tasks/main.yml`, which runs
`docker compose build` gated on the stack content hash.

The git context is pinned to a commit rather than a branch, so builds are reproducible and
the content-hash gate only rebuilds when the pin changes:

```
context: https://github.com/TheSpaghettiDetective/obico-server.git#<sha>:ml_api
```

**Renovate cannot track this.** Everything else in the repo is a digest-pinned upstream
image; this is the one exception, and the SHA must be bumped by hand. The build context
itself is tiny (~148K) — the model weights (darknet, ONNX, RKNN) download during the build.

## Wiring

Obico's ML API is **GET-only** (`/p/?img=<url>`) and **fetches the frame itself** rather
than receiving it. Bambuddy caches a frame at
`{external_url}/api/v1/obico/cached-frame/{nonce}` and passes that URL, so `obico-ml` must
be able to reach Bambuddy's configured `external_url`.

Keep `external_url` as `https://bambuddy.tylercash.dev`: the `ClientIP(172.19.0.0/24)`
clause already present in every Traefik rule covers container-network sources. It must not
be set to an internal URL, because it also builds the login links in notifications.

`/p/` is gated behind `ML_API_TOKEN`; `/hc/` is open and is what the healthcheck targets.

## Secrets

This introduces the stack's **first** secret: `ML_API_TOKEN` in
`stacks/spoolman/.env.secret`, SOPS-encrypted. Edit with `task edit STACK=spoolman`.

## Not exposed

`obico-ml` has no Traefik labels and no hostname — only Bambuddy talks to it. That means no
Cloudflare DNS record and no Homepage entry, so the `CLAUDE.md` Homepage rule does not
apply.
