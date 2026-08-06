# Spool Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track filament spool inventory for a Bambu Lab P1S (no AMS, external spool holder only), with usage deducted automatically after each print.

**Architecture:** A new `spoolman` stack runs Spoolman (inventory DB) and SpoolmanSync (spool assignment + usage sync). SpoolmanSync reads printer state from the existing Home Assistant via the `ha-bambulab` integration and generates HA automations that POST usage to Spoolman's REST API. Those automations live in git as a Home Assistant package bind-mounted into the HA container.

**Tech Stack:** Docker Compose, Traefik, Home Assistant packages, Ansible (deploy), Homepage (dashboard).

**Spec:** `docs/superpowers/specs/2026-08-06-spool-management-design.md`

---

## Important Sequencing Constraint

The HA package YAML **cannot be written up front**. SpoolmanSync generates it from the real entity IDs that `ha-bambulab` creates, which do not exist until the printer is added in the HA UI. So the order is: deploy the stack (Tasks 1-3, DNS in Task 4, deploy in Task 5) → manual HA setup (Task 6) → generate and commit the package (Task 7) → verify (Task 8).

Tasks 4, 6 and 8 require access to the printer and the HA web UI. They cannot be done by an agent.

## File Structure

| File | Responsibility |
|---|---|
| `stacks/spoolman/docker-compose.yml` (create) | Both containers, Traefik ingress, bind mounts |
| `stacks/home-assistant/packages/.gitkeep` (create) | Makes the packages dir exist before its contents do |
| `stacks/home-assistant/packages/spoolmansync.yaml` (create, Task 7) | Generated rest_commands + deduction automations |
| `stacks/home-assistant/docker-compose.yml` (modify) | Mount `./packages`, add content hash |
| `stacks/homepage/config/services.yaml` (modify) | New `3D Printing` group |

No new stack registration is needed: `.github/workflows/deploy.yml:59` discovers stacks by globbing `stacks/*/`, and Ansible syncs each to `/opt/stacks/<name>/`.

---

### Task 1: Create the spoolman stack

**Files:**
- Create: `stacks/spoolman/docker-compose.yml`

- [ ] **Step 1: Write the compose file**

Conventions copied from `stacks/mealie/docker-compose.yml`: `x-logging` anchor, tag+digest pin (Renovate manages these — `renovate.json` enables `docker:pinDigests` on the `docker-compose` manager), memory limit, healthcheck, `ClientIP` guard on the Traefik rule, watchtower label.

```yaml
x-logging: &logging
  logging:
    driver: json-file
    options:
      max-size: "50m"
      max-file: "3"
      labels: "com.docker.compose.service,com.docker.compose.project"

services:
  spoolman:
    <<: *logging
    image: ghcr.io/donkie/spoolman:0.9.1@sha256:5c45702741d7f613fb9653c095a10a2087527280ab134eb23a3d954a86ab18e9
    container_name: spoolman
    restart: unless-stopped
    networks:
      - homelab_default
    deploy:
      resources:
        limits:
          memory: 512M
    volumes:
      - /ssd/services/spoolman:/home/app/.local/share/spoolman
    environment:
      # Spoolman's entrypoint honours these via gosu (upstream entrypoint.sh:3-4),
      # so the bind mount ends up owned consistently with every other stack.
      - PUID=568
      - PGID=568
      - TZ=Australia/Sydney
    healthcheck:
      test: ["CMD-SHELL", "python3 -c \"import urllib.request; urllib.request.urlopen('http://localhost:8000/api/v1/health')\" || exit 1"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 30s
    labels:
      - traefik.enable=true
      - traefik.http.routers.spoolman.service=spoolman
      - traefik.http.routers.spoolman.rule=Host(`spoolman.tylercash.dev`) && (ClientIP(`10.0.0.0/8`) || ClientIP(`172.19.0.0/24`))
      - traefik.http.routers.spoolman.entrypoints=websecure
      - traefik.http.services.spoolman.loadbalancer.server.scheme=http
      - traefik.http.services.spoolman.loadbalancer.server.port=8000
      - traefik.http.routers.spoolman.tls.certresolver=leresolver
      - com.centurylinklabs.watchtower.enable=true

  spoolmansync:
    <<: *logging
    image: ghcr.io/gibz104/spoolmansync:1.6.8@sha256:425611390b48b7ec6dbe6420a0733d22425d56085147984e90559d7add4b96c4
    container_name: spoolmansync
    restart: unless-stopped
    depends_on:
      - spoolman
    networks:
      - homelab_default
    deploy:
      resources:
        limits:
          memory: 1000M
    volumes:
      - /ssd/services/spoolmansync:/data
    environment:
      - TZ=Australia/Sydney
      - HA_MODE=external
      - HA_URL=http://home-assistant:8123
      - SPOOLMAN_URL=http://spoolman:8000
      - NEXTAUTH_URL=https://spools.tylercash.dev
    healthcheck:
      # 127.0.0.1, not localhost: Next.js binds 0.0.0.0 (IPv4 only) while busybox
      # wget resolves localhost to ::1 first and gets connection refused.
      test: ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:3000/ || exit 1"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s
    labels:
      - traefik.enable=true
      - traefik.http.routers.spoolmansync.service=spoolmansync
      - traefik.http.routers.spoolmansync.rule=Host(`spools.tylercash.dev`) && (ClientIP(`10.0.0.0/8`) || ClientIP(`172.19.0.0/24`))
      - traefik.http.routers.spoolmansync.entrypoints=websecure
      - traefik.http.services.spoolmansync.loadbalancer.server.scheme=http
      - traefik.http.services.spoolmansync.loadbalancer.server.port=3000
      - traefik.http.routers.spoolmansync.tls.certresolver=leresolver
      - com.centurylinklabs.watchtower.enable=true

networks:
  homelab_default:
    external: true
```

Deviations from upstream `docker-compose.prebuilt.yml`, all deliberate: no `ports:` (Traefik handles ingress), no `embedded` profile (it bundles a second Home Assistant and a `privileged: true` container), bind mounts under `/ssd/services/` instead of named volumes.

- [ ] **Step 2: Verify it parses and the bind mounts are discoverable**

`docker` is not installed in this WSL distro, so validate with Python. The second command mirrors the grep in `ansible/roles/stacks/files/ensure-zfs-datasets.sh:36` that finds paths needing ZFS datasets.

Run:
```bash
python3 -c "import yaml,sys; d=yaml.safe_load(open('stacks/spoolman/docker-compose.yml')); print(sorted(d['services'])); print([v for s in d['services'].values() for v in s['volumes']])"
grep -oE '^\s*-\s*(/ssd|/hdd)/[^:[:space:]]+' stacks/spoolman/docker-compose.yml
```

Expected:
```
['spoolman', 'spoolmansync']
['/ssd/services/spoolman:/home/app/.local/share/spoolman', '/ssd/services/spoolmansync:/data']
      - /ssd/services/spoolman
      - /ssd/services/spoolmansync
```

Both paths must appear in the grep — that is what triggers dataset creation on first deploy.

- [ ] **Step 3: Commit**

```bash
git add stacks/spoolman/docker-compose.yml
git commit -m "feat(spoolman): add spoolman + spoolmansync stack"
```

---

### Task 2: Mount a git-managed packages directory into Home Assistant

**Files:**
- Create: `stacks/home-assistant/packages/.gitkeep`
- Modify: `stacks/home-assistant/docker-compose.yml`

The directory must exist and be mounted before Task 7 writes the real package into it. Git does not track empty directories, hence `.gitkeep`. HA's `!include_dir_named` only reads `*.yaml`, so a `.gitkeep` file is ignored.

- [ ] **Step 1: Create the placeholder**

```bash
mkdir -p stacks/home-assistant/packages
printf '# Placeholder so git tracks this directory.\n# Real content arrives as spoolmansync.yaml (see docs/superpowers/plans/2026-08-06-spool-management.md).\n' > stacks/home-assistant/packages/.gitkeep
```

- [ ] **Step 2: Add the bind mount**

In `stacks/home-assistant/docker-compose.yml`, in the `home-assistant` service, change:

```yaml
    volumes:
      - /ssd/services/homeassistant:/config
      - /etc/localtime:/etc/localtime:ro
```

to:

```yaml
    volumes:
      - /ssd/services/homeassistant:/config
      - ./packages:/config/packages:ro
      - /etc/localtime:/etc/localtime:ro
```

The relative path resolves because Ansible rsyncs the stack to `/opt/stacks/home-assistant/` (`ansible/roles/stacks/tasks/main.yml:14-25`). `stacks/grafana-lgtm/docker-compose.yml:148` already relies on this.

- [ ] **Step 3: Add the content hash so edits force a reload**

In the same service, change:

```yaml
    environment:
      - PUID=568
      - PGID=568
      - UMASK=0002
      - TZ=Australia/Sydney
```

to:

```yaml
    environment:
      - PUID=568
      - PGID=568
      - UMASK=0002
      - TZ=Australia/Sydney
      # Editing anything under ./packages changes this hash, which is a compose
      # definition diff, which recreates the container so HA reloads the package.
      - STACK_CONTENT_HASH=__STACK_CONTENT_HASH__
```

Ansible replaces the placeholder with a hash of the stack's file tree at `ansible/roles/stacks/tasks/main.yml:60-68`.

- [ ] **Step 4: Verify**

Run:
```bash
python3 -c "
import yaml
d = yaml.safe_load(open('stacks/home-assistant/docker-compose.yml'))['services']['home-assistant']
assert './packages:/config/packages:ro' in d['volumes'], d['volumes']
assert 'STACK_CONTENT_HASH=__STACK_CONTENT_HASH__' in d['environment'], d['environment']
print('OK')
"
test -f stacks/home-assistant/packages/.gitkeep && echo "placeholder present"
```

Expected:
```
OK
placeholder present
```

- [ ] **Step 5: Commit**

```bash
git add stacks/home-assistant/docker-compose.yml stacks/home-assistant/packages/.gitkeep
git commit -m "feat(home-assistant): mount git-managed packages directory"
```

---

### Task 3: Add the Homepage entries

**Files:**
- Modify: `stacks/homepage/config/services.yaml`

Required by the rule in `CLAUDE.md`: any new service with a Traefik hostname gets a Homepage entry.

- [ ] **Step 1: Append a new group**

Add at the end of `stacks/homepage/config/services.yaml`, matching the existing two-space-indent group style:

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

The Spoolman widget takes no API key, so no `HOMEPAGE_VAR_*` and no `.env.secret` change. It shows 4 spools by default; add `spoolIds: [1, 2, 3]` later if that needs pinning.

- [ ] **Step 2: Verify the YAML parses and the group is present**

Run:
```bash
python3 -c "
import yaml
groups = yaml.safe_load(open('stacks/homepage/config/services.yaml'))
names = [list(g)[0] for g in groups]
print(names)
assert '3D Printing' in names
svc = [g for g in groups if list(g)[0]=='3D Printing'][0]['3D Printing']
print([list(s)[0] for s in svc])
"
```

Expected: the group list ends with `'3D Printing'`, and the second line prints `['Spoolman', 'SpoolmanSync']`.

- [ ] **Step 3: Commit**

```bash
git add stacks/homepage/config/services.yaml
git commit -m "feat(homepage): add 3D Printing group for spoolman"
```

---

### Task 4: Create DNS records (MANUAL — Cloudflare dashboard)

**Files:** none.

There is no wildcard record for the zone, and nothing in this repo creates DNS. Traefik's
`CF_DNS_API_TOKEN` is used only for the ACME DNS-01 challenge; there is no external-dns or
cloudflare-companion container. Without these records the hostnames return NXDOMAIN and
the stack is unreachable no matter how healthy the containers are.

- [ ] **Step 1: Add two A records in Cloudflare**

| Name | Type | Value | Proxy |
|---|---|---|---|
| `spoolman` | A | `10.0.90.10` | DNS only (grey cloud) |
| `spools` | A | `10.0.90.10` | DNS only (grey cloud) |

Proxy must stay off — the target is a private address, and proxying would make Traefik see
Cloudflare edge IPs instead of the LAN client, failing the `ClientIP` guard.

- [ ] **Step 2: Verify resolution**

Run:
```bash
for h in spoolman.tylercash.dev spools.tylercash.dev; do printf "%-28s " "$h"; getent hosts "$h" || echo NXDOMAIN; done
```

Expected: both resolve to `10.0.90.10`. Existing services resolve there too — compare
against `getent hosts mealie.tylercash.dev`.

---

### Task 5: Deploy

**Files:** none — this is a merge and a deploy.

- [ ] **Step 1: Push the branch and open a PR**

```bash
git push -u origin spool-management
gh pr create --title "feat: spool management for P1S" --body "Implements docs/superpowers/specs/2026-08-06-spool-management-design.md"
```

If `gh` is not installed (it was not, on this machine), open the PR in the web UI instead.

- [ ] **Step 2: Merge to master**

`.github/workflows/deploy.yml` triggers on push to `master`. Merging runs the Ansible playbook, which creates the ZFS datasets, syncs the stacks, and brings up the containers.

- [ ] **Step 3: Verify the deploy**

Watch the Actions run to completion. Then from a machine on the LAN:

```bash
curl -sf https://spoolman.tylercash.dev/api/v1/health && echo " spoolman up"
curl -sfo /dev/null -w "%{http_code}\n" https://spools.tylercash.dev
```

Expected: a JSON health body followed by `spoolman up`, then `200`.

Spoolman's entrypoint honours `PUID`/`PGID` and drops privileges with gosu, so ownership should sort itself out. If it still logs permission errors on `/home/app/.local/share/spoolman`, `chown -R 568:568` the dataset on the host.

- [ ] **Step 4: Confirm the Homepage widget renders**

Load `https://home.tylercash.dev` and check the 3D Printing group appears. The widget will show an empty state until spools exist — that is expected, not a failure.

---

### Task 6: Home Assistant setup (MANUAL — requires the HA UI and the printer)

**Files:** none in git. This task deliberately touches HA-owned state.

- [ ] **Step 1: Put the printer in LAN mode**

On the P1S: Settings → General → enable **LAN Mode Liveview**. Note the IP, serial number, and access code.

- [ ] **Step 2: Install HACS, then ha-bambulab**

Follow the HACS install docs, restart HA, then add `ha-bambulab` (greghesp/ha-bambulab) through HACS and restart again.

- [ ] **Step 3: Add the Bambu Lab integration**

Settings → Devices & Services → Add Integration → Bambu Lab. Enter the IP, serial, and access code from Step 1.

- [ ] **Step 4: Verify the external spool entity exists**

This is the gate for everything downstream. In Developer Tools → States, filter for `external_spool`.

Expected: at least one entity whose ID ends in `_external_spool`. If only `_tray_1` through `_tray_4` appear and no external spool, stop — SpoolmanSync will have nothing to assign, and the rest of the plan will not work.

- [ ] **Step 5: Enable packages in configuration.yaml**

Edit `/ssd/services/homeassistant/configuration.yaml` on the host and add:

```yaml
homeassistant:
  packages: !include_dir_named packages
```

If a `homeassistant:` key already exists, add `packages:` under it rather than creating a second top-level key.

**Do not use SpoolmanSync's auto-configure for this.** It edits the file in place and has a known bug (upstream issue #73, regression-tested in `app/src/lib/ha-packages-config.test.ts`) where it inserts a duplicate `packages:` key on CRLF files. YAML keeps the last duplicate, so the package silently never loads while the UI reports success.

- [ ] **Step 6: Restart HA and confirm the directory is mounted**

Restart Home Assistant, then in Developer Tools → Template, render:

```jinja
{{ states | selectattr('entity_id', 'search', 'external_spool') | map(attribute='entity_id') | list }}
```

Expected: a non-empty list. Also confirm the container sees the mount:

```bash
docker exec home-assistant ls -la /config/packages
```

Expected: the `.gitkeep` file from Task 2.

---

### Task 7: Generate and commit the HA package

**Files:**
- Create: `stacks/home-assistant/packages/spoolmansync.yaml`

- [ ] **Step 1: Point SpoolmanSync at Spoolman and connect it to HA**

Open `https://spools.tylercash.dev` → Settings. Set the Spoolman URL to `http://spoolman:8000`. Complete the Home Assistant OAuth connection.

If OAuth fails: SpoolmanSync hardcodes `client_id: 'http://spoolmansync'` (`app/src/lib/api/homeassistant.ts:208`) and HA's IndieAuth flow may reject a client_id it cannot resolve. This is the top risk in the spec. Read the SpoolmanSync container logs and the HA logs before changing anything.

- [ ] **Step 2: Confirm the printer and its external spool slot are discovered**

The SpoolmanSync home page should list the printer with an **External Spool** slot. If the slot is missing, go back to Task 6 Step 4.

- [ ] **Step 3: Generate the automations**

Go to the Automations page. Copy the **automations YAML** block (the "Copy" button at `app/src/app/automations/page.tsx:589`).

- [ ] **Step 4: Write it into the repo**

Paste into `stacks/home-assistant/packages/spoolmansync.yaml`, prefixed with:

```yaml
# Generated by SpoolmanSync's Automations page. Do not edit by hand — regenerate
# there and re-copy, otherwise the next regeneration silently drops your changes.
# Deployed by Ansible via the ./packages bind mount in this stack's compose file.
```

The page also shows a `configuration.yaml` block. That block is the `packages:` directive, which Task 6 Step 5 already added by hand. Do not paste it here.

- [ ] **Step 5: Verify it parses and defines what it should**

Run:
```bash
python3 -c "
import yaml
d = yaml.safe_load(open('stacks/home-assistant/packages/spoolmansync.yaml'))
print(sorted(d))
assert 'rest_command' in d, 'no rest_command block'
assert any('spoolmansync' in k for k in d['rest_command']), sorted(d['rest_command'])
print('rest_commands:', sorted(d['rest_command']))
print('automations:', len(d.get('automation', [])))
"
```

Expected: top-level keys including `rest_command` and `automation`, at least one `spoolmansync_*` rest command, and a non-zero automation count.

HA's `!include` and `!secret` tags will break `yaml.safe_load`. If the generated file contains them, the parse fails — that is a real problem worth investigating, not something to work around, because this package is meant to be self-contained.

- [ ] **Step 6: Commit and deploy**

```bash
git add stacks/home-assistant/packages/spoolmansync.yaml
git commit -m "feat(home-assistant): add spoolmansync usage-tracking package"
git push
```

Merging to master recreates the HA container via the changed `STACK_CONTENT_HASH`, loading the package.

- [ ] **Step 7: Verify the rest commands exist at runtime**

In Developer Tools → Actions, search for `rest_command.spoolmansync`.

Expected: at least one action. Their absence is the exact silent failure mode that upstream issue #73 produces — if they are missing, check `configuration.yaml` for a duplicate `packages:` key.

---

### Task 8: End-to-end verification (MANUAL — requires a print)

**Files:** none.

- [ ] **Step 1: Create a spool in Spoolman**

At `https://spoolman.tylercash.dev`, create a vendor (e.g. eSun), a filament (e.g. PLA+ Black, 1.75mm), and a spool with a known initial weight. Note the remaining weight.

- [ ] **Step 2: Assign it to the external spool slot**

In SpoolmanSync, assign that spool to the printer's **External Spool** slot.

- [ ] **Step 3: Run a small test print**

A calibration cube is enough. Note the slicer's estimated filament usage in grams.

- [ ] **Step 4: Confirm the deduction**

After the print completes, reload the spool in Spoolman.

Expected: remaining weight has dropped by roughly the slicer estimate. Exact agreement is not expected — the value is derived from the slicer, not measured (see the spec's accuracy limitation).

If nothing was deducted, check in this order: the slot was assigned (Task 7 Step 2), the rest commands exist (Task 7 Step 7), and the automation traces in HA under Settings → Automations → the SpoolmanSync automation → Traces.

- [ ] **Step 5: Print QR labels (optional)**

SpoolmanSync can generate QR label sheets. Sticking one on each spool makes swaps a scan instead of a dropdown selection. Worth doing once there are more than a handful of spools.

---

## Post-Implementation

Update `CLAUDE.md` with a short section describing the spool management setup, following the existing "Grafana Dashboards (peep-bot)" section's format — specifically that `stacks/home-assistant/packages/spoolmansync.yaml` is generated by SpoolmanSync and must not be hand-edited.
