# Peep Bot Grafana Dashboards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver seven JSON-provisioned Grafana dashboards (Overview, HTTP, Discord, Jobs, Data, JVM, Deps) for peep-bot via the `grafana/otel-lgtm` bundle in `stacks/grafana-lgtm/`.

**Architecture:** Each dashboard is a hand-authored JSON file under `stacks/grafana-lgtm/grafana/dashboards/peepbot/`. A single Grafana provisioning yaml registers them as a `file` provider scoped to the `Peep Bot` folder. Two new bind mounts on the `grafana-lgtm` service expose the directory and provisioning yaml inside the container. Source of truth is git; UI edits are disabled (`allowUiUpdates: false`).

**Tech Stack:** Grafana 10+ (bundled in `grafana/otel-lgtm:0.11.10`), Mimir (PromQL), Loki (LogQL), Tempo, OTel collector, Docker Compose, jq (validation), grafana MCP (smoke testing).

**Reference spec:** `docs/superpowers/specs/2026-05-23-peepbot-grafana-dashboards-design.md` — read it before starting. The spec defines every panel's PromQL and the standard label selector. This plan assumes you've internalised the spec's selector convention:

```promql
{service_namespace="peep-bot", service_name=~"$service", deployment_environment_name=~"$env"}
```

**Out of scope:** The eight prerequisites (A–H) in the spec. Dashboards ship even if some panels render flat lines or empty-states — that's by design.

---

## Task 1: Verify the otel-lgtm provisioning path

The spec lists `/otel-lgtm/grafana/conf/provisioning/` as the inferred provisioning directory inside the image. Verify before wiring bind mounts to it.

**Files:**
- None (investigation only)

- [ ] **Step 1: Inspect the running container for Grafana provisioning paths**

Run:
```bash
docker exec grafana-lgtm find /otel-lgtm /etc/grafana /data -maxdepth 6 -type d -name provisioning 2>/dev/null
```
Expected output: one or more lines including `.../grafana/conf/provisioning`. The first hit under `/otel-lgtm/` is the canonical provisioning dir.

- [ ] **Step 2: Inspect the GF_PATHS_PROVISIONING env if set**

Run:
```bash
docker exec grafana-lgtm sh -c 'env | grep -i provisioning' || true
docker exec grafana-lgtm cat /otel-lgtm/grafana/conf/defaults.ini 2>/dev/null | grep -A2 '\[paths\]' || true
```
Note the path. The defaults.ini `[paths]` section's `provisioning =` value is authoritative.

- [ ] **Step 3: Record the verified path**

Record the verified path in a scratch note. From here on, this plan refers to it as `<PROV_PATH>`. The expected value is `/otel-lgtm/grafana/conf/provisioning`. If it differs, every subsequent bind-mount target in this plan must be updated.

- [ ] **Step 4: Confirm Grafana auto-discovers dashboard providers on a write to that dir**

Run:
```bash
docker exec grafana-lgtm sh -c 'touch <PROV_PATH>/dashboards/.canary && ls -la <PROV_PATH>/dashboards/'
docker exec grafana-lgtm rm <PROV_PATH>/dashboards/.canary
```
Expected: write succeeds; the directory is writable from inside (or at minimum readable — we will mount our provider yaml read-only).

(No commit for this task — it's investigation only.)

---

## Task 2: Scaffold directory structure in the repo

**Files:**
- Create: `stacks/grafana-lgtm/grafana/dashboards/peepbot/.gitkeep`
- Create: `stacks/grafana-lgtm/grafana/provisioning/dashboards/.gitkeep`

- [ ] **Step 1: Create the directory tree**

Run:
```bash
mkdir -p stacks/grafana-lgtm/grafana/dashboards/peepbot
mkdir -p stacks/grafana-lgtm/grafana/provisioning/dashboards
touch stacks/grafana-lgtm/grafana/dashboards/peepbot/.gitkeep
touch stacks/grafana-lgtm/grafana/provisioning/dashboards/.gitkeep
```

- [ ] **Step 2: Verify**

Run:
```bash
find stacks/grafana-lgtm/grafana -type d
```
Expected:
```
stacks/grafana-lgtm/grafana
stacks/grafana-lgtm/grafana/dashboards
stacks/grafana-lgtm/grafana/dashboards/peepbot
stacks/grafana-lgtm/grafana/provisioning
stacks/grafana-lgtm/grafana/provisioning/dashboards
```

- [ ] **Step 3: Commit**

```bash
git add stacks/grafana-lgtm/grafana
git commit -m "chore(grafana-lgtm): scaffold dashboard provisioning layout"
```

---

## Task 3: Author the provisioning yaml

**Files:**
- Create: `stacks/grafana-lgtm/grafana/provisioning/dashboards/peepbot.yaml`

- [ ] **Step 1: Write the provider yaml**

Create `stacks/grafana-lgtm/grafana/provisioning/dashboards/peepbot.yaml`:

```yaml
apiVersion: 1
providers:
  - name: peepbot
    orgId: 1
    folder: Peep Bot
    folderUid: peepbot
    type: file
    disableDeletion: false
    updateIntervalSeconds: 30
    allowUiUpdates: false
    options:
      path: /etc/grafana/provisioning/peepbot
      foldersFromFilesStructure: false
```

Notes:
- `path` is the **in-container** path where our dashboards directory will be bind-mounted (Task 4).
- `folderUid: peepbot` is stable — used by Task 8+ if any dashboard links back to the folder.
- `allowUiUpdates: false` — UI edits get overwritten on the next 30s sweep.

- [ ] **Step 2: Validate yaml syntax**

Run:
```bash
docker run --rm -v "$(pwd)/stacks/grafana-lgtm/grafana/provisioning/dashboards/peepbot.yaml:/x.yaml" mikefarah/yq:4 'true' /x.yaml
```
Expected: `true` (file parses).

- [ ] **Step 3: Commit**

```bash
git add stacks/grafana-lgtm/grafana/provisioning/dashboards/peepbot.yaml
git commit -m "feat(grafana-lgtm): add peepbot dashboard provider config"
```

---

## Task 4: Wire bind mounts into the grafana-lgtm service

**Files:**
- Modify: `stacks/grafana-lgtm/docker-compose.yml` (the `grafana-lgtm` service's `volumes:` list)

- [ ] **Step 1: Read the current volumes block**

Run:
```bash
grep -n -A 5 'grafana-lgtm:$\|container_name: grafana-lgtm$' stacks/grafana-lgtm/docker-compose.yml | head -40
```
Locate the `grafana-lgtm` service (not `grafana-lgtm-init`) and its `volumes:` list. Current state: one entry, `- /ssd/databases/grafana-lgtm/data:/data`.

- [ ] **Step 2: Add the two bind mounts**

Edit `stacks/grafana-lgtm/docker-compose.yml`. In the `grafana-lgtm` service's `volumes:` list, append two entries so it becomes:

```yaml
    volumes:
      - /ssd/databases/grafana-lgtm/data:/data
      - ./grafana/dashboards/peepbot:/etc/grafana/provisioning/peepbot:ro
      - ./grafana/provisioning/dashboards/peepbot.yaml:<PROV_PATH>/dashboards/peepbot.yaml:ro
```

Replace `<PROV_PATH>` with the path verified in Task 1, Step 3 (expected: `/otel-lgtm/grafana/conf/provisioning`).

- [ ] **Step 3: Validate compose syntax**

Run:
```bash
docker compose -f stacks/grafana-lgtm/docker-compose.yml config -q
```
Expected: no output, exit 0. (If errors mention env vars, that's fine — we only care about yaml validity.)

- [ ] **Step 4: Commit (no deploy yet — Task 5 will deploy with the canary)**

```bash
git add stacks/grafana-lgtm/docker-compose.yml
git commit -m "feat(grafana-lgtm): bind-mount peepbot dashboards + provider"
```

---

## Task 5: Canary dashboard — prove the pipeline works end-to-end

Before authoring seven real dashboards, ship one trivial one and confirm Grafana picks it up. Catches path/permission mistakes once, not seven times.

**Files:**
- Create: `stacks/grafana-lgtm/grafana/dashboards/peepbot/_canary.json`

- [ ] **Step 1: Write a minimal canary dashboard**

Create `stacks/grafana-lgtm/grafana/dashboards/peepbot/_canary.json`:

```json
{
  "uid": "peepbot-canary",
  "title": "Peep Bot — Canary",
  "tags": ["peepbot", "canary"],
  "schemaVersion": 39,
  "version": 1,
  "refresh": "30s",
  "time": { "from": "now-15m", "to": "now" },
  "timezone": "browser",
  "editable": false,
  "panels": [
    {
      "id": 1,
      "type": "stat",
      "title": "Hello from provisioning",
      "gridPos": { "h": 4, "w": 8, "x": 0, "y": 0 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "targets": [
        {
          "refId": "A",
          "expr": "vector(1)",
          "datasource": { "type": "prometheus", "uid": "prometheus" }
        }
      ],
      "options": {
        "reduceOptions": { "calcs": ["lastNotNull"], "fields": "", "values": false },
        "colorMode": "value",
        "graphMode": "none"
      }
    }
  ]
}
```

- [ ] **Step 2: Validate JSON syntax**

Run:
```bash
jq . stacks/grafana-lgtm/grafana/dashboards/peepbot/_canary.json > /dev/null && echo "OK"
```
Expected: `OK`.

- [ ] **Step 3: Restart the grafana-lgtm stack to pick up the new bind mounts**

Run:
```bash
docker compose -f stacks/grafana-lgtm/docker-compose.yml up -d
```
Expected: `grafana-lgtm` container recreated, `otel-agent` recreated. Wait ~30s for the healthcheck to settle.

- [ ] **Step 4: Confirm the provisioner inside the container sees the file**

Run:
```bash
docker exec grafana-lgtm ls -la /etc/grafana/provisioning/peepbot/
docker exec grafana-lgtm ls -la <PROV_PATH>/dashboards/peepbot.yaml
```
Expected: both list correctly. The peepbot dir contains `_canary.json` and `.gitkeep`.

- [ ] **Step 5: Confirm Grafana loaded the dashboard via API**

Use the grafana MCP:

```
mcp__grafana__search_dashboards: query="canary"
```

Expected: one hit, uid `peepbot-canary`, folder title `Peep Bot`.

- [ ] **Step 6: Check Grafana logs for provisioning errors**

Run:
```bash
docker logs grafana-lgtm 2>&1 | grep -i 'provision\|peepbot' | tail -20
```
Expected: lines like `provisioning dashboards: peepbot` and no `error` or `failed` near peepbot.

If errors appear, fix the bind-mount path or yaml and reload before continuing.

- [ ] **Step 7: Commit the canary**

```bash
git add stacks/grafana-lgtm/grafana/dashboards/peepbot/_canary.json
git commit -m "test(grafana-lgtm): add canary dashboard to verify provisioning"
```

The canary stays in the repo as a regression check. It will be deleted in Task 13 once all seven real dashboards are in.

---

## Task 6: Overview dashboard (the canonical example)

This is the exemplar dashboard. Subsequent dashboards follow its structure: same `templating` block, same `datasource` references, same panel JSON shape. Tasks 7–12 reuse this scaffold — copy and replace panels.

**Files:**
- Create: `stacks/grafana-lgtm/grafana/dashboards/peepbot/overview.json`

Per spec section C.1 ("Overview"). Panels: firing-alerts list, four golden-signal stats, four service-up stats, dashboard-list.

- [ ] **Step 1: Smoke-test every PromQL query via grafana MCP before encoding**

For each of the queries below, run via the MCP and confirm no error (data presence not required):

1. `sum(rate(http_server_requests_milliseconds_count{service_namespace="peep-bot", service_name=~"peepbot-backend", deployment_environment_name=~"production"}[5m]))`
2. `100 * sum(rate(http_server_requests_milliseconds_count{service_namespace="peep-bot", service_name=~"peepbot-backend", deployment_environment_name=~"production", outcome=~"SERVER_ERROR|CLIENT_ERROR"}[5m])) / clamp_min(sum(rate(http_server_requests_milliseconds_count{service_namespace="peep-bot", service_name=~"peepbot-backend", deployment_environment_name=~"production"}[5m])), 1)`
3. `histogram_quantile(0.95, sum by (le) (rate(http_server_requests_milliseconds_bucket{service_namespace="peep-bot", service_name=~"peepbot-backend", deployment_environment_name=~"production"}[5m])))`
4. `process_cpu_usage{service_namespace="peep-bot", service_name=~"peepbot-backend", deployment_environment_name=~"production"}`
5. `application_ready_time_milliseconds{service_namespace="peep-bot", service_name=~"peepbot-backend", deployment_environment_name=~"production"}`
6. `hikaricp_connections{service_namespace="peep-bot", service_name=~"peepbot-backend", deployment_environment_name=~"production"}`

Tool call shape:
```
mcp__grafana__query_prometheus: datasourceUid="prometheus", expr="<query>", queryType="instant"
```

Expected: each returns either a result vector or an empty vector. NO `parse error` or `unknown function`.

If any query errors, fix it inline (most likely cause: a label name typo). Update both the query above and the JSON below.

- [ ] **Step 2: Discover the template-var label discovery query that works**

Run via MCP:
```
mcp__grafana__query_prometheus: datasourceUid="prometheus", expr="up{service_namespace=\"peep-bot\"}", queryType="instant"
```

If the result has the labels `service_name` and `deployment_environment_name` present on the series, use `up{...}` for the template variables. If not, fall back to `application_ready_time_milliseconds{service_namespace="peep-bot"}` (we know that one carries them).

Record the chosen label-discovery target. The JSON below assumes `up` works; substitute if needed.

- [ ] **Step 3: Write the Overview dashboard JSON**

Create `stacks/grafana-lgtm/grafana/dashboards/peepbot/overview.json`:

```json
{
  "uid": "peepbot-overview",
  "title": "Peep Bot — Overview",
  "tags": ["peepbot", "overview"],
  "schemaVersion": 39,
  "version": 1,
  "refresh": "30s",
  "time": { "from": "now-1h", "to": "now" },
  "timezone": "browser",
  "editable": false,
  "templating": {
    "list": [
      {
        "name": "datasource",
        "type": "datasource",
        "query": "prometheus",
        "current": { "text": "Prometheus", "value": "prometheus" },
        "hide": 0
      },
      {
        "name": "service",
        "type": "query",
        "datasource": { "type": "prometheus", "uid": "prometheus" },
        "query": "label_values(up{service_namespace=\"peep-bot\"}, service_name)",
        "refresh": 1,
        "includeAll": true,
        "multi": true,
        "current": { "text": "peepbot-backend", "value": "peepbot-backend" }
      },
      {
        "name": "env",
        "type": "query",
        "datasource": { "type": "prometheus", "uid": "prometheus" },
        "query": "label_values(up{service_namespace=\"peep-bot\"}, deployment_environment_name)",
        "refresh": 1,
        "includeAll": true,
        "multi": true,
        "current": { "text": "production", "value": "production" }
      }
    ]
  },
  "panels": [
    {
      "id": 1,
      "type": "alertlist",
      "title": "Firing alerts",
      "gridPos": { "h": 8, "w": 24, "x": 0, "y": 0 },
      "options": {
        "showOptions": "current",
        "maxItems": 20,
        "alertName": "",
        "stateFilter": { "firing": true, "pending": false, "noData": false, "normal": false, "error": true },
        "alertInstanceLabelFilter": "{service_namespace=\"peep-bot\"}"
      }
    },
    {
      "id": 2,
      "type": "stat",
      "title": "Req/s",
      "gridPos": { "h": 4, "w": 6, "x": 0, "y": 8 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "targets": [
        {
          "refId": "A",
          "expr": "sum(rate(http_server_requests_milliseconds_count{service_namespace=\"peep-bot\", service_name=~\"$service\", deployment_environment_name=~\"$env\"}[5m]))"
        }
      ],
      "options": {
        "reduceOptions": { "calcs": ["lastNotNull"] },
        "graphMode": "area",
        "colorMode": "value"
      },
      "fieldConfig": { "defaults": { "unit": "reqps", "decimals": 2 } }
    },
    {
      "id": 3,
      "type": "stat",
      "title": "Error %",
      "gridPos": { "h": 4, "w": 6, "x": 6, "y": 8 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "targets": [
        {
          "refId": "A",
          "expr": "100 * sum(rate(http_server_requests_milliseconds_count{service_namespace=\"peep-bot\", service_name=~\"$service\", deployment_environment_name=~\"$env\", outcome=~\"SERVER_ERROR|CLIENT_ERROR\"}[5m])) / clamp_min(sum(rate(http_server_requests_milliseconds_count{service_namespace=\"peep-bot\", service_name=~\"$service\", deployment_environment_name=~\"$env\"}[5m])), 1)"
        }
      ],
      "options": {
        "reduceOptions": { "calcs": ["lastNotNull"] },
        "graphMode": "area",
        "colorMode": "value"
      },
      "fieldConfig": {
        "defaults": {
          "unit": "percent",
          "decimals": 2,
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "color": "green", "value": null },
              { "color": "yellow", "value": 1 },
              { "color": "red", "value": 5 }
            ]
          }
        }
      }
    },
    {
      "id": 4,
      "type": "stat",
      "title": "p95 latency",
      "gridPos": { "h": 4, "w": 6, "x": 12, "y": 8 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "targets": [
        {
          "refId": "A",
          "expr": "histogram_quantile(0.95, sum by (le) (rate(http_server_requests_milliseconds_bucket{service_namespace=\"peep-bot\", service_name=~\"$service\", deployment_environment_name=~\"$env\"}[5m])))"
        }
      ],
      "options": {
        "reduceOptions": { "calcs": ["lastNotNull"] },
        "graphMode": "area",
        "colorMode": "value"
      },
      "fieldConfig": {
        "defaults": {
          "unit": "ms",
          "decimals": 0,
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "color": "green", "value": null },
              { "color": "yellow", "value": 500 },
              { "color": "red", "value": 2000 }
            ]
          }
        }
      }
    },
    {
      "id": 5,
      "type": "stat",
      "title": "CPU",
      "gridPos": { "h": 4, "w": 6, "x": 18, "y": 8 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "targets": [
        {
          "refId": "A",
          "expr": "process_cpu_usage{service_namespace=\"peep-bot\", service_name=~\"$service\", deployment_environment_name=~\"$env\"}"
        }
      ],
      "options": {
        "reduceOptions": { "calcs": ["lastNotNull"] },
        "graphMode": "area",
        "colorMode": "value"
      },
      "fieldConfig": {
        "defaults": {
          "unit": "percentunit",
          "decimals": 2,
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "color": "green", "value": null },
              { "color": "yellow", "value": 0.5 },
              { "color": "red", "value": 0.8 }
            ]
          }
        }
      }
    },
    {
      "id": 6,
      "type": "stat",
      "title": "Backend",
      "gridPos": { "h": 3, "w": 6, "x": 0, "y": 12 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "targets": [
        {
          "refId": "A",
          "expr": "count(application_ready_time_milliseconds{service_namespace=\"peep-bot\", service_name=~\"$service\", deployment_environment_name=~\"$env\"}) > bool 0"
        }
      ],
      "options": {
        "reduceOptions": { "calcs": ["lastNotNull"] },
        "colorMode": "background",
        "graphMode": "none"
      },
      "fieldConfig": {
        "defaults": {
          "mappings": [
            { "type": "value", "options": { "0": { "text": "DOWN", "color": "red" }, "1": { "text": "UP", "color": "green" } } }
          ]
        }
      }
    },
    {
      "id": 7,
      "type": "stat",
      "title": "Postgres (via HikariCP)",
      "gridPos": { "h": 3, "w": 6, "x": 6, "y": 12 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "targets": [
        {
          "refId": "A",
          "expr": "(sum(hikaricp_connections{service_namespace=\"peep-bot\", service_name=~\"$service\", deployment_environment_name=~\"$env\"}) > bool 0)"
        }
      ],
      "options": { "reduceOptions": { "calcs": ["lastNotNull"] }, "colorMode": "background", "graphMode": "none" },
      "fieldConfig": {
        "defaults": {
          "mappings": [
            { "type": "value", "options": { "0": { "text": "DOWN", "color": "red" }, "1": { "text": "UP", "color": "green" } } }
          ]
        }
      },
      "description": "Derived from HikariCP until OTel postgres receiver (spec Prereq F) emits postgresql_up."
    },
    {
      "id": 8,
      "type": "stat",
      "title": "OTel collector",
      "gridPos": { "h": 3, "w": 6, "x": 12, "y": 12 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "targets": [
        {
          "refId": "A",
          "expr": "count(otelcol_process_uptime_seconds_total or otelcol_process_uptime_seconds) > bool 0"
        }
      ],
      "options": { "reduceOptions": { "calcs": ["lastNotNull"] }, "colorMode": "background", "graphMode": "none" },
      "fieldConfig": {
        "defaults": {
          "mappings": [
            { "type": "value", "options": { "0": { "text": "DOWN", "color": "red" }, "1": { "text": "UP", "color": "green" } } }
          ]
        }
      }
    },
    {
      "id": 9,
      "type": "stat",
      "title": "Frontend",
      "gridPos": { "h": 3, "w": 6, "x": 18, "y": 12 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "targets": [{ "refId": "A", "expr": "vector(0)" }],
      "options": { "reduceOptions": { "calcs": ["lastNotNull"] }, "colorMode": "background", "graphMode": "none" },
      "fieldConfig": {
        "defaults": {
          "mappings": [
            { "type": "value", "options": { "0": { "text": "Not yet wired", "color": "blue" } } }
          ]
        }
      },
      "description": "Placeholder until Next.js RUM is instrumented."
    },
    {
      "id": 10,
      "type": "dashlist",
      "title": "Dashboards",
      "gridPos": { "h": 6, "w": 24, "x": 0, "y": 15 },
      "options": {
        "showStarred": false,
        "showRecentlyViewed": false,
        "showSearch": true,
        "showHeadings": false,
        "tags": ["peepbot"],
        "maxItems": 20
      }
    }
  ]
}
```

- [ ] **Step 4: Validate JSON**

Run:
```bash
jq . stacks/grafana-lgtm/grafana/dashboards/peepbot/overview.json > /dev/null && echo "OK"
```
Expected: `OK`.

- [ ] **Step 5: Confirm provisioner picked it up**

Wait 30s (provisioner sweep interval) then run via MCP:
```
mcp__grafana__search_dashboards: query="overview"
```
Expected: hit for uid `peepbot-overview`.

- [ ] **Step 6: Eyeball in browser**

Open https://grafana.tylercash.dev/d/peepbot-overview . Confirm:
- All ten panels load (some may show "No data" — fine).
- `$service` and `$env` dropdowns show `peepbot-backend` and `production`.
- Switching `$env` to `staging` swaps to `peepbot-staging-backend` data.
- The alert-list panel renders even with no alerts ("No alerts found" message).

- [ ] **Step 7: Commit**

```bash
git add stacks/grafana-lgtm/grafana/dashboards/peepbot/overview.json
git commit -m "feat(grafana-lgtm): add peep-bot Overview dashboard"
```

---

## Tasks 7–12: Six remaining dashboards

Each remaining dashboard task shares the structure of Task 6:

1. Pre-smoke every PromQL query via `mcp__grafana__query_prometheus` (instant queries, no time range needed — confirms parser + label match).
2. Author the JSON following the Overview's structure: identical `templating` block, identical datasource refs (`uid: prometheus`, `uid: loki`), unique `uid` and `title`, panel JSON shape mirroring Overview's panels.
3. `jq .` validate.
4. Wait 30s for provisioner sweep, confirm via `mcp__grafana__search_dashboards`.
5. Eyeball in browser.
6. Commit.

**The templating block is identical across all seven dashboards.** Copy it verbatim from Overview. Do not retype.

### Task 7: HTTP API RED (`peepbot-http`)

**Files:**
- Create: `stacks/grafana-lgtm/grafana/dashboards/peepbot/http.json`

Per spec section C.2. Tags: `["peepbot", "http"]`.

- [ ] **Step 1: Smoke-test queries via MCP**

Run each via `mcp__grafana__query_prometheus`:

```promql
# Per-endpoint req/s (timeseries)
sum by (uri) (rate(http_server_requests_milliseconds_count{service_namespace="peep-bot", service_name=~"peepbot-backend", deployment_environment_name=~"production"}[5m]))

# Per-endpoint error %
100 * sum by (uri) (rate(http_server_requests_milliseconds_count{service_namespace="peep-bot", service_name=~"peepbot-backend", deployment_environment_name=~"production", outcome=~"SERVER_ERROR|CLIENT_ERROR"}[5m])) / clamp_min(sum by (uri) (rate(http_server_requests_milliseconds_count{service_namespace="peep-bot", service_name=~"peepbot-backend", deployment_environment_name=~"production"}[5m])), 1)

# p50 / p95 / p99 per uri
histogram_quantile(0.50, sum by (le, uri) (rate(http_server_requests_milliseconds_bucket{service_namespace="peep-bot", service_name=~"peepbot-backend", deployment_environment_name=~"production"}[5m])))
histogram_quantile(0.95, sum by (le, uri) (rate(http_server_requests_milliseconds_bucket{service_namespace="peep-bot", service_name=~"peepbot-backend", deployment_environment_name=~"production"}[5m])))
histogram_quantile(0.99, sum by (le, uri) (rate(http_server_requests_milliseconds_bucket{service_namespace="peep-bot", service_name=~"peepbot-backend", deployment_environment_name=~"production"}[5m])))

# Status-code stacked area (group by outcome)
sum by (outcome) (rate(http_server_requests_milliseconds_count{service_namespace="peep-bot", service_name=~"peepbot-backend", deployment_environment_name=~"production"}[5m]))

# Top 5 failing
topk(5, sum by (uri) (rate(http_server_requests_milliseconds_count{service_namespace="peep-bot", service_name=~"peepbot-backend", deployment_environment_name=~"production", outcome=~"SERVER_ERROR|CLIENT_ERROR"}[5m])))

# Security filter chain — rate-limit blocks
rate(spring_security_filterchains_RateLimitFilter_before_total{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m])
```

LogQL via `mcp__grafana__query_loki_logs` for the OAuth funnel (count, last 1h):

```logql
count_over_time({service_name="peepbot-backend"} |= "/oauth2/authorization/discord" [1h])
count_over_time({service_name="peepbot-backend"} |= "/login/oauth2/code/discord" [1h])
count_over_time({service_name="peepbot-backend"} |~ "session.*created" [1h])
```

All must parse without error.

- [ ] **Step 2: Author `http.json`**

Build the dashboard with these panels (rows top-to-bottom, replicating Overview's JSON shape — copy templating block verbatim, copy panel structure):

| # | Type | Title | Query (refId A) | Grid |
|---|---|---|---|---|
| 1 | timeseries | Request rate by endpoint | `topk(10, sum by (uri) (rate(http_server_requests_milliseconds_count{service_namespace="peep-bot", service_name=~"$service", deployment_environment_name=~"$env"}[5m])))` | h:8 w:8 x:0 y:0 |
| 2 | timeseries | Error % by endpoint | `topk(10, 100 * sum by (uri) (rate(http_server_requests_milliseconds_count{service_namespace="peep-bot", service_name=~"$service", deployment_environment_name=~"$env", outcome=~"SERVER_ERROR\|CLIENT_ERROR"}[5m])) / clamp_min(sum by (uri) (rate(http_server_requests_milliseconds_count{service_namespace="peep-bot", service_name=~"$service", deployment_environment_name=~"$env"}[5m])), 1))` (unit `percent`) | h:8 w:8 x:8 y:0 |
| 3 | timeseries | p95 latency by endpoint | `topk(10, histogram_quantile(0.95, sum by (le, uri) (rate(http_server_requests_milliseconds_bucket{service_namespace="peep-bot", service_name=~"$service", deployment_environment_name=~"$env"}[5m]))))` (unit `ms`) | h:8 w:8 x:16 y:0 |
| 4 | table | Per-endpoint RED | One target per metric (req/s, err %, p50, p95, p99) — use Grafana's "transformations" to join by `uri`. Sort desc on err %. | h:10 w:16 x:0 y:8 |
| 5 | timeseries | Status mix (stacked) | `sum by (outcome) (rate(http_server_requests_milliseconds_count{service_namespace="peep-bot", service_name=~"$service", deployment_environment_name=~"$env"}[5m]))` — stacked area | h:10 w:8 x:16 y:8 |
| 6 | bargauge | Top 5 failing | `topk(5, sum by (uri) (rate(http_server_requests_milliseconds_count{service_namespace="peep-bot", service_name=~"$service", deployment_environment_name=~"$env", outcome=~"SERVER_ERROR\|CLIENT_ERROR"}[5m])))` | h:6 w:12 x:0 y:18 |
| 7 | stat (x3) | OAuth funnel: authorize → callback → session | Three logs panels, datasource `{type:"loki", uid:"loki"}`, each running one of the `count_over_time` queries above with `$__range`. Stacked horizontally. | h:6 w:4 x:12,16,20 y:18 |
| 8 | timeseries | Rate-limit filter activity | `rate(spring_security_filterchains_RateLimitFilter_before_total{service_namespace="peep-bot", service_name=~"$service", deployment_environment_name=~"$env"}[5m])` | h:6 w:24 x:0 y:24 |

`uid`: `peepbot-http`. `title`: `Peep Bot — HTTP API`. `refresh`: `30s`. `time`: `now-1h` to `now`.

- [ ] **Step 3: jq validate**

```bash
jq . stacks/grafana-lgtm/grafana/dashboards/peepbot/http.json > /dev/null && echo "OK"
```

- [ ] **Step 4: Verify via MCP**

```
mcp__grafana__search_dashboards: query="HTTP API"
```
Expected: hit for `peepbot-http`.

- [ ] **Step 5: Eyeball in browser, then commit**

```bash
git add stacks/grafana-lgtm/grafana/dashboards/peepbot/http.json
git commit -m "feat(grafana-lgtm): add peep-bot HTTP API dashboard"
```

---

### Task 8: Discord Listener Health (`peepbot-discord`)

**Files:**
- Create: `stacks/grafana-lgtm/grafana/dashboards/peepbot/discord.json`

Per spec section C.3. Tags: `["peepbot", "discord"]`. **Gap-heaviest dashboard** — half its panels will render flat until Prereqs A–D land. Build them anyway with a `description` field on each gated panel noting the prerequisite.

- [ ] **Step 1: Smoke-test queries via MCP**

```promql
# 3-second budget (will be flat until Prereq A buckets are configured)
histogram_quantile(0.99, sum by (le) (rate(lifecycle_listener_invoke_milliseconds_bucket{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m])))
sum(rate(lifecycle_listener_invoke_milliseconds_count{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m]))

# Executor pool (flat until Prereq B)
executor_pool_size_threads{name="discordListenerExecutor", service_namespace="peep-bot"}
executor_active_threads{name="discordListenerExecutor", service_namespace="peep-bot"}
executor_queued_tasks{name="discordListenerExecutor", service_namespace="peep-bot"}
rate(executor_completed_tasks_total{name="discordListenerExecutor", service_namespace="peep-bot"}[5m])

# 10062 — Loki fallback (works today)
# (LogQL via mcp__grafana__query_loki_logs)
sum(count_over_time({service_name="peepbot-backend"} |= "10062" [5m]))

# Discord HTTP latency
histogram_quantile(0.95, sum by (le) (rate(discord_http_milliseconds_bucket{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m])))
sum(rate(discord_http_milliseconds_count{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m]))

# Button + modal interaction
histogram_quantile(0.95, sum by (le) (rate(discord_button_interaction_milliseconds_bucket{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m])))
histogram_quantile(0.95, sum by (le) (rate(discord_modal_interaction_milliseconds_bucket{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m])))

# Per-operation table — uses metric-name regex
{__name__=~"discord_(channel|message|role|archive|delete|sort|refresh|update|assign)_.+_milliseconds_count"}
```

- [ ] **Step 2: Author `discord.json`** with these panels:

| # | Type | Title | Query | Grid | Notes |
|---|---|---|---|---|---|
| 1 | stat | % under 3s budget | `1 - (sum(rate(lifecycle_listener_invoke_milliseconds_bucket{service_namespace="peep-bot", service_name=~"$service", le="3000"}[5m])) / clamp_min(sum(rate(lifecycle_listener_invoke_milliseconds_count{service_namespace="peep-bot", service_name=~"$service"}[5m])), 1))` displayed as `1 - <above>`; unit `percentunit`; threshold red ≥ 0.001 (0.1%) | h:5 w:8 x:0 y:0 | description: "Gated on spec Prereq A. Flat until lifecycle.listener.invoke SLO buckets are added." |
| 2 | heatmap | Listener invoke latency heatmap | `sum by (le) (rate(lifecycle_listener_invoke_milliseconds_bucket{service_namespace="peep-bot", service_name=~"$service"}[5m]))` ; add y-axis threshold line at 3000 | h:8 w:16 x:8 y:0 | same gating |
| 3 | stat | Executor pool size | `executor_pool_size_threads{name="discordListenerExecutor", service_namespace="peep-bot", service_name=~"$service"}` | h:4 w:6 x:0 y:5 | gated Prereq B |
| 4 | stat | Active threads | `executor_active_threads{name="discordListenerExecutor", service_namespace="peep-bot", service_name=~"$service"}` | h:4 w:6 x:6 y:5 | gated Prereq B |
| 5 | stat | Queue depth | `executor_queued_tasks{name="discordListenerExecutor", service_namespace="peep-bot", service_name=~"$service"}`; threshold red ≥ 100 | h:4 w:6 x:12 y:5 | gated Prereq B |
| 6 | stat | Completed rate | `rate(executor_completed_tasks_total{name="discordListenerExecutor", service_namespace="peep-bot", service_name=~"$service"}[5m])` | h:4 w:6 x:18 y:5 | gated Prereq B |
| 7 | timeseries | UNKNOWN_INTERACTION errors (Loki fallback) | LogQL: `sum(count_over_time({service_name=~"$service"} \|= "10062" [5m]))`; datasource `loki` | h:6 w:12 x:0 y:13 | description: "Loki-derived until spec Prereq C lands the discord_interaction_error_total counter." |
| 8 | timeseries | Discord HTTP p50/p95/p99 | three targets, refId A/B/C, quantiles 0.5/0.95/0.99 over `discord_http_milliseconds_bucket` | h:6 w:12 x:12 y:13 | |
| 9 | timeseries | Discord HTTP rate | `sum(rate(discord_http_milliseconds_count{service_namespace="peep-bot", service_name=~"$service"}[5m]))` | h:6 w:12 x:0 y:19 | |
| 10 | timeseries | Button + Modal interaction p95 | two targets: button (refId A) and modal (refId B), p95 over respective buckets | h:6 w:12 x:12 y:19 | |
| 11 | table | Per-operation Discord RED | Three targets joined by `__name__`: rate, error-rate (use logback errors as proxy until per-op error counter exists), p95. Use Grafana's `Labels to fields` transform. Metric selector: `{__name__=~"discord_(channel\|message\|role\|archive\|delete\|sort\|refresh\|update\|assign)_.+_milliseconds_count", service_namespace="peep-bot", service_name=~"$service"}` | h:10 w:18 x:0 y:25 | |
| 12 | stat | JDA gateway | `vector(0)` placeholder | h:5 w:6 x:18 y:25 | mappings: 0→"Not yet wired" blue; description: "Gated on spec Prereq D." |

`uid`: `peepbot-discord`. `title`: `Peep Bot — Discord Listener`.

- [ ] **Step 3: jq validate, Step 4: verify via MCP, Step 5: eyeball, Step 6: commit**

```bash
git add stacks/grafana-lgtm/grafana/dashboards/peepbot/discord.json
git commit -m "feat(grafana-lgtm): add peep-bot Discord Listener dashboard"
```

---

### Task 9: Jobs & Schedulers (`peepbot-jobs`)

**Files:**
- Create: `stacks/grafana-lgtm/grafana/dashboards/peepbot/jobs.json`

Per spec section C.4. Tags: `["peepbot", "jobs"]`. peep-bot uses `@Scheduled` + ShedLock, **not Spring Batch** — use `tasks_scheduled_execution_milliseconds_*`.

- [ ] **Step 1: Smoke-test queries**

```promql
# Identify which labels tasks_scheduled emits — run a metadata lookup first
mcp__grafana__list_prometheus_label_names: datasourceUid="prometheus", matches=["tasks_scheduled_execution_milliseconds_count"]

# Then per-task rates (substitute the discovered grouping label, likely `class` and `method`, or `name`)
sum by (class, method) (rate(tasks_scheduled_execution_milliseconds_count{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m]))

# Per-task p95
histogram_quantile(0.95, sum by (le, class, method) (rate(tasks_scheduled_execution_milliseconds_bucket{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m])))

# Per-task error rate
sum by (class, method) (rate(tasks_scheduled_execution_milliseconds_count{service_namespace="peep-bot", service_name=~"peepbot-backend", exception!=""}[5m]))

# Lifecycle published
sum by (type) (rate(event_lifecycle_published_total{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m]))

# Stuck listeners
event_lifecycle_listener_stuck{service_namespace="peep-bot", service_name=~"peepbot-backend"}

# Retry-poller activity (via lifecycle.listener.invoke observation, grouped by listener_name)
sum by (listener_name) (rate(lifecycle_listener_invoke_milliseconds_count{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m]))
```

LogQL for the TfNSW poller fallback:
```logql
sum(count_over_time({service_name="peepbot-backend"} |= "TfNSW" |~ "noteworthy|posted" [1h]))
```

Record the actual label names returned by the metadata call. Substitute into the JSON if different from `class`/`method`.

- [ ] **Step 2: Author `jobs.json`** with these panels:

| # | Type | Title | Query | Grid |
|---|---|---|---|---|
| 1 | table | Scheduled tasks — RED | three joined targets (rate, error rate, p95) by `class`/`method`, sort by error rate desc | h:10 w:24 x:0 y:0 |
| 2 | timeseries | Lifecycle events published | `sum by (type) (rate(event_lifecycle_published_total{service_namespace="peep-bot", service_name=~"$service"}[5m]))` stacked area | h:8 w:12 x:0 y:10 |
| 3 | stat | Stuck listeners | `event_lifecycle_listener_stuck{service_namespace="peep-bot", service_name=~"$service"}` with `Labels to fields` transform showing per-listener; threshold red ≥ 1 | h:8 w:12 x:12 y:10 |
| 4 | timeseries | Listener invocation rate (retry-poller proxy) | `sum by (listener_name) (rate(lifecycle_listener_invoke_milliseconds_count{service_namespace="peep-bot", service_name=~"$service"}[5m]))` | h:8 w:12 x:0 y:18 |
| 5 | timeseries | TfNSW poller activity (Loki fallback) | LogQL: `sum(count_over_time({service_name=~"$service"} \|= "TfNSW" \|~ "noteworthy\|posted" [$__range]))`; datasource `loki` | h:8 w:12 x:12 y:18 | description: "Loki fallback until spec Prereq E adds tfnsw_poller_runs_total." |

`uid`: `peepbot-jobs`. `title`: `Peep Bot — Jobs & Schedulers`.

- [ ] **Step 3-6: jq validate, MCP verify, eyeball, commit**

```bash
git add stacks/grafana-lgtm/grafana/dashboards/peepbot/jobs.json
git commit -m "feat(grafana-lgtm): add peep-bot Jobs & Schedulers dashboard"
```

---

### Task 10: Data Layer (`peepbot-data`)

**Files:**
- Create: `stacks/grafana-lgtm/grafana/dashboards/peepbot/data.json`

Per spec section C.5. Tags: `["peepbot", "data"]`. Built from HikariCP + `datasource-micrometer` until OTel postgres receiver is fixed (Prereq F).

- [ ] **Step 1: Smoke-test**

```promql
hikaricp_connections_active{service_namespace="peep-bot", service_name=~"peepbot-backend"}
hikaricp_connections_idle{service_namespace="peep-bot", service_name=~"peepbot-backend"}
hikaricp_connections_pending{service_namespace="peep-bot", service_name=~"peepbot-backend"}
hikaricp_connections_max{service_namespace="peep-bot", service_name=~"peepbot-backend"}
rate(hikaricp_connections_timeout_total{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m])

histogram_quantile(0.95, sum by (le) (rate(hikaricp_connections_acquire_milliseconds_bucket{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m])))
histogram_quantile(0.95, sum by (le) (rate(hikaricp_connections_usage_milliseconds_bucket{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m])))
histogram_quantile(0.95, sum by (le) (rate(hikaricp_connections_creation_milliseconds_bucket{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m])))

histogram_quantile(0.95, sum by (le) (rate(jdbc_query_milliseconds_bucket{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m])))
rate(jdbc_connection_acquired_total{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m])
rate(jdbc_commit_total{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m])
rate(jdbc_rollback_total{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m])

# Per-repository
sum by (repository) (rate(spring_data_repository_invocations_milliseconds_count{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m]))
histogram_quantile(0.95, sum by (le, repository) (rate(spring_data_repository_invocations_milliseconds_bucket{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m])))

# Sessions
tomcat_sessions_active_current{service_namespace="peep-bot", service_name=~"peepbot-backend"}
rate(tomcat_sessions_created_total{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m])
rate(tomcat_sessions_rejected_total{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m])
```

- [ ] **Step 2: Author `data.json`** with panels:

| # | Type | Title | Query | Grid |
|---|---|---|---|---|
| 1-5 | stat (row of 5) | HikariCP: Active / Idle / Pending / Max / Timeouts | Five separate stats, queries above; thresholds: Pending red ≥ 1; Timeouts red ≥ 0 (any value) | h:4 w:4-5 each, y:0 |
| 6 | timeseries | Connection wait & usage (p95) | three targets (acquire/usage/creation p95), legend per series; unit `ms` | h:8 w:12 x:0 y:4 |
| 7 | timeseries | JDBC commits vs rollbacks | two targets (commit rate, rollback rate); legend; rollback red trend | h:8 w:12 x:12 y:4 |
| 8 | table | Per-repository latency | targets: rate, p95 by `repository`; sort by p95 desc | h:10 w:24 x:0 y:12 |
| 9 | stat (row of 3) | Sessions: Active / Created/s / Rejected/s | three stats, last two are rates | h:4 w:8 each, y:22 |
| 10 | stat | Anonymous-session skip rate (placeholder) | `vector(0)`; description: "Gated on spec Prereq G — adds session.anonymous_skip counter." | h:4 w:8 x:0 y:26 |
| 11 | text (markdown) | Postgres (server-side) — gated on Prereq F | Markdown panel explaining that the OTel postgres receiver is not yet emitting. | h:4 w:16 x:8 y:26 |

`uid`: `peepbot-data`. `title`: `Peep Bot — Data Layer`.

- [ ] **Step 3-6: validate, verify, eyeball, commit**

```bash
git add stacks/grafana-lgtm/grafana/dashboards/peepbot/data.json
git commit -m "feat(grafana-lgtm): add peep-bot Data Layer dashboard"
```

---

### Task 11: JVM & Host (`peepbot-jvm`)

**Files:**
- Create: `stacks/grafana-lgtm/grafana/dashboards/peepbot/jvm.json`

Per spec section C.6. Tags: `["peepbot", "jvm"]`.

- [ ] **Step 1: Smoke-test**

```promql
jvm_memory_used_bytes{service_namespace="peep-bot", service_name=~"peepbot-backend", area="heap"}
jvm_memory_max_bytes{service_namespace="peep-bot", service_name=~"peepbot-backend", area="heap"}
jvm_memory_used_bytes{service_namespace="peep-bot", service_name=~"peepbot-backend", area="nonheap"}

rate(jvm_gc_pause_milliseconds_count{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m])
histogram_quantile(0.99, sum by (le) (rate(jvm_gc_pause_milliseconds_bucket{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m])))
rate(jvm_gc_memory_allocated_bytes_total{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m])
jvm_gc_overhead{service_namespace="peep-bot", service_name=~"peepbot-backend"}

jvm_threads_live{service_namespace="peep-bot", service_name=~"peepbot-backend"}
jvm_threads_daemon{service_namespace="peep-bot", service_name=~"peepbot-backend"}
jvm_threads_peak{service_namespace="peep-bot", service_name=~"peepbot-backend"}
jvm_threads_states{service_namespace="peep-bot", service_name=~"peepbot-backend"}

process_files_open{service_namespace="peep-bot", service_name=~"peepbot-backend"}
process_files_max{service_namespace="peep-bot", service_name=~"peepbot-backend"}
system_load_average_1m{service_namespace="peep-bot", service_name=~"peepbot-backend"}
process_uptime_milliseconds{service_namespace="peep-bot", service_name=~"peepbot-backend"}

# Container stats from docker_stats receiver (verify label name first; likely container_name)
container_cpu_utilization{container_name=~".*peepbot.*"}
container_memory_usage{container_name=~".*peepbot.*"}
```

If `container_cpu_utilization` doesn't exist, list with:
```
mcp__grafana__list_prometheus_metric_names: datasourceUid="prometheus", regex="^container_.*"
```
and substitute the actual names.

- [ ] **Step 2: Author `jvm.json`** with panels:

| # | Type | Title | Query | Grid |
|---|---|---|---|---|
| 1 | timeseries | Heap by region (stacked) | `jvm_memory_used_bytes{...,area="heap"}` by `id` stacked; overlay `jvm_memory_max_bytes{...,area="heap"}` | h:8 w:12 x:0 y:0 |
| 2 | stat | Heap utilization | `sum(jvm_memory_used_bytes{...,area="heap"}) / sum(jvm_memory_max_bytes{...,area="heap"})` unit `percentunit`; threshold red ≥ 0.85 | h:4 w:6 x:12 y:0 |
| 3 | stat | GC overhead | `jvm_gc_overhead{...}` percentunit; red ≥ 0.1 | h:4 w:6 x:18 y:0 |
| 4 | timeseries | Non-heap by region | `jvm_memory_used_bytes{...,area="nonheap"}` by `id` stacked | h:8 w:12 x:12 y:4 |
| 5 | timeseries | GC pause p99 + rate | two targets: p99 ms (left axis), rate /s (right axis) | h:8 w:12 x:0 y:8 |
| 6 | timeseries | Allocation rate | `rate(jvm_gc_memory_allocated_bytes_total[5m])` unit `Bps` | h:6 w:12 x:0 y:16 |
| 7 | timeseries | Thread states (stacked) | `jvm_threads_states{...}` by `state` | h:6 w:12 x:12 y:16 |
| 8 | stat (row of 3) | Live / Daemon / Peak threads | three stats | h:4 w:8 each y:22 |
| 9 | timeseries | File descriptors | two targets: open + max | h:6 w:8 x:0 y:26 |
| 10 | stat | Uptime | `process_uptime_milliseconds{...} / 1000` unit `s` | h:4 w:4 x:8 y:26 |
| 11 | stat | Load avg 1m | `system_load_average_1m{...}` | h:4 w:4 x:12 y:26 |
| 12 | timeseries | Container CPU | `container_cpu_utilization{container_name=~".*peepbot-backend.*"}` (substitute actual metric) | h:6 w:8 x:16 y:26 |
| 13 | timeseries | Container memory | matching memory metric | h:6 w:12 x:0 y:32 |

`uid`: `peepbot-jvm`. `title`: `Peep Bot — JVM & Host`.

- [ ] **Step 3-6: validate, verify, eyeball, commit**

```bash
git add stacks/grafana-lgtm/grafana/dashboards/peepbot/jvm.json
git commit -m "feat(grafana-lgtm): add peep-bot JVM & Host dashboard"
```

---

### Task 12: External Dependencies (`peepbot-deps`)

**Files:**
- Create: `stacks/grafana-lgtm/grafana/dashboards/peepbot/deps.json`

Per spec section C.7. Tags: `["peepbot", "deps"]`.

- [ ] **Step 1: Smoke-test**

```promql
# Determine what grouping label http_client_requests emits
mcp__grafana__list_prometheus_label_names: datasourceUid="prometheus", matches=["http_client_requests_milliseconds_count"]

# Then per-host rate; likely `client_name` or extract host from `uri`. Pick one and substitute.
sum by (client_name) (rate(http_client_requests_milliseconds_count{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m]))

# Discord HTTP (specific)
sum(rate(discord_http_milliseconds_count{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m]))
histogram_quantile(0.95, sum by (le) (rate(discord_http_milliseconds_bucket{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m])))

# TfNSW
sum(rate(tfnsw_live_traffic_major_events_milliseconds_count{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m]))
sum(rate(tfnsw_live_traffic_hazards_milliseconds_count{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m]))

# Immich
{__name__=~"immich_.+_milliseconds_count", service_namespace="peep-bot"}

# Places
sum(rate(places_fetch_coords_milliseconds_count{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m]))
histogram_quantile(0.95, sum by (le) (rate(places_fetch_coords_milliseconds_bucket{service_namespace="peep-bot", service_name=~"peepbot-backend"}[5m])))
```

- [ ] **Step 2: Author `deps.json`** with panels:

| # | Type | Title | Query | Grid |
|---|---|---|---|---|
| 1 | table | Outbound HTTP RED | three joined targets (rate, error rate, p95) by host/client label | h:10 w:24 x:0 y:0 |
| 2 | timeseries | Discord REST latency | p50/p95/p99 over discord_http_milliseconds | h:8 w:12 x:0 y:10 |
| 3 | timeseries | Discord REST rate | sum rate of count | h:8 w:12 x:12 y:10 |
| 4 | timeseries | TfNSW polls | two targets: major-events rate, hazards rate, stacked | h:8 w:12 x:0 y:18 |
| 5 | stat | TfNSW circuit (placeholder) | `vector(0)`; description: "Gated on spec Prereq H — needs resilience4j-micrometer dep." | h:4 w:6 x:12 y:18 |
| 6 | table | Immich per-operation | metric selector `{__name__=~"immich_.+_milliseconds_count", service_namespace="peep-bot", service_name=~"$service"}` with rate; legend `{{__name__}}` | h:8 w:12 x:0 y:26 |
| 7 | timeseries | Places fetch rate + p95 | two targets | h:8 w:12 x:12 y:26 |

`uid`: `peepbot-deps`. `title`: `Peep Bot — External Dependencies`.

- [ ] **Step 3-6: validate, verify, eyeball, commit**

```bash
git add stacks/grafana-lgtm/grafana/dashboards/peepbot/deps.json
git commit -m "feat(grafana-lgtm): add peep-bot External Dependencies dashboard"
```

---

## Task 13: Cross-link verification & canary cleanup

**Files:**
- Delete: `stacks/grafana-lgtm/grafana/dashboards/peepbot/_canary.json`

- [ ] **Step 1: Confirm all seven dashboards are loaded**

Via MCP:
```
mcp__grafana__search_dashboards: query="Peep Bot"
```

Expected: seven hits with uids `peepbot-overview`, `peepbot-http`, `peepbot-discord`, `peepbot-jobs`, `peepbot-data`, `peepbot-jvm`, `peepbot-deps`. Plus `peepbot-canary` (to be removed).

- [ ] **Step 2: Confirm Overview's dashlist renders the other six**

Open https://grafana.tylercash.dev/d/peepbot-overview . Scroll to the "Dashboards" panel at the bottom. Confirm six clickable links (canary may show up too — that's fine for now).

- [ ] **Step 3: Click each link and confirm the destination loads**

Click each in turn; confirm the destination dashboard renders without errors. Click back to Overview each time.

- [ ] **Step 4: Confirm `$env` switch propagates**

On Overview, change `$env` from `production` to `staging`. Confirm all golden-signal panels switch to staging data (or empty, if staging is idle). Click through to HTTP dashboard; the URL should carry `?var-env=staging` and the dashboard should respect it.

- [ ] **Step 5: Delete the canary**

```bash
rm stacks/grafana-lgtm/grafana/dashboards/peepbot/_canary.json
```

Wait 30s for the provisioner sweep, then via MCP:
```
mcp__grafana__search_dashboards: query="canary"
```
Expected: 0 hits.

- [ ] **Step 6: Commit**

```bash
git add -A stacks/grafana-lgtm/grafana/dashboards/peepbot/
git commit -m "chore(grafana-lgtm): remove canary dashboard"
```

---

## Task 14: PromQL smoke test script (regression guard)

A small repeatable script that walks every dashboard JSON, extracts every `expr` field, and runs it against Prometheus via the API. Run manually or wire into CI later.

**Files:**
- Create: `stacks/grafana-lgtm/scripts/smoke-dashboards.sh`

- [ ] **Step 1: Write the script**

Create `stacks/grafana-lgtm/scripts/smoke-dashboards.sh`:

```bash
#!/usr/bin/env bash
# Smoke-test every PromQL expr in the peepbot dashboards.
# Usage: GRAFANA_TOKEN=<service-account-token> ./smoke-dashboards.sh
# Exit non-zero on any parse error.

set -euo pipefail

GRAFANA_URL="${GRAFANA_URL:-https://grafana.tylercash.dev}"
DASHBOARD_DIR="$(dirname "$0")/../grafana/dashboards/peepbot"

if [[ -z "${GRAFANA_TOKEN:-}" ]]; then
  echo "GRAFANA_TOKEN env var required" >&2
  exit 2
fi

fail=0
total=0
for f in "$DASHBOARD_DIR"/*.json; do
  base="$(basename "$f")"
  # Extract every panel.targets[].expr value (Prometheus targets only).
  exprs=$(jq -r '
    .. | objects | select(.expr? != null and (.datasource.type? == "prometheus" or .datasource.type? == null)) | .expr
  ' "$f")

  while IFS= read -r expr; do
    [[ -z "$expr" ]] && continue
    # Resolve template vars to defaults so the query is concrete.
    resolved="${expr//\$service/peepbot-backend}"
    resolved="${resolved//\$env/production}"
    resolved="${resolved//\$__range/1h}"

    total=$((total + 1))
    response=$(curl -sS -G \
      -H "Authorization: Bearer $GRAFANA_TOKEN" \
      --data-urlencode "query=$resolved" \
      "$GRAFANA_URL/api/datasources/proxy/uid/prometheus/api/v1/query")

    status=$(echo "$response" | jq -r '.status // "unknown"')
    if [[ "$status" != "success" ]]; then
      echo "FAIL [$base] $expr"
      echo "  → $(echo "$response" | jq -c '.error // .')"
      fail=$((fail + 1))
    fi
  done <<< "$exprs"
done

echo "---"
echo "$((total - fail))/$total queries OK ($fail failed)"
exit "$fail"
```

- [ ] **Step 2: Make executable**

```bash
chmod +x stacks/grafana-lgtm/scripts/smoke-dashboards.sh
```

- [ ] **Step 3: Run it (requires a Grafana service-account token)**

If you don't yet have a token: Grafana → Administration → Service accounts → create one with `Viewer` role, generate a token.

```bash
GRAFANA_TOKEN=<your-token> stacks/grafana-lgtm/scripts/smoke-dashboards.sh
```

Expected: `N/N queries OK (0 failed)`. Anything > 0 failures means a typo or missing label — fix and re-run.

- [ ] **Step 4: Commit**

```bash
git add stacks/grafana-lgtm/scripts/smoke-dashboards.sh
git commit -m "test(grafana-lgtm): add PromQL smoke-test script for dashboards"
```

---

## Task 15: Document in Taskfile + CLAUDE.md

**Files:**
- Modify: `Taskfile.yml` (add a `grafana:smoke` task)
- Modify: `CLAUDE.md` (one-paragraph addition)

- [ ] **Step 1: Add a Taskfile entry**

Open `Taskfile.yml`. Add a new task:

```yaml
  grafana:smoke:
    desc: "Run PromQL smoke test against peepbot dashboards (requires GRAFANA_TOKEN)"
    cmds:
      - stacks/grafana-lgtm/scripts/smoke-dashboards.sh
```

- [ ] **Step 2: Add a paragraph to CLAUDE.md**

Open `CLAUDE.md`. After the "Homepage Dashboard" section, add:

```markdown
## Grafana Dashboards (peep-bot)

Peep Bot dashboards are JSON-provisioned via the `grafana/otel-lgtm` bundle. JSON lives in `stacks/grafana-lgtm/grafana/dashboards/peepbot/`; the provider config lives in `stacks/grafana-lgtm/grafana/provisioning/dashboards/peepbot.yaml`. Both are bind-mounted into the container. UI edits revert on the next 30s sweep — source of truth is git.

After changing any dashboard JSON, run `task grafana:smoke` (requires `GRAFANA_TOKEN`) to validate every PromQL expression parses against the live Prometheus.

The dashboards are designed around an OTel-flavoured selector: `{service_namespace="peep-bot", service_name=~"$service", deployment_environment_name=~"$env"}`. **Note: all Micrometer timers from peep-bot export as `_milliseconds_*`, not `_seconds_*`.**
```

- [ ] **Step 3: Commit**

```bash
git add Taskfile.yml CLAUDE.md
git commit -m "docs: document peepbot Grafana dashboards in Taskfile + CLAUDE.md"
```

---

## Done. Verification checklist

After all tasks complete:

- [ ] `mcp__grafana__search_dashboards query="Peep Bot"` returns exactly seven hits.
- [ ] `stacks/grafana-lgtm/scripts/smoke-dashboards.sh` exits 0.
- [ ] Browser walkthrough: Overview → click each dashlist link → all six load → click back → switch `$env` to staging → propagates.
- [ ] `docker logs grafana-lgtm 2>&1 | grep -i 'provision.*error\|peepbot.*error'` returns no lines.
- [ ] `git log --oneline` shows ~12 commits (one per task that commits).

Out-of-scope reminders for follow-up (the eight Prereqs from the spec; one peep-bot PR each, or one bundled "instrument what dashboards expect" PR):

| Prereq | One-line summary |
|---|---|
| A | Add 3s SLO bucket to `lifecycle.listener.invoke` Observation |
| B | Switch `discordListenerExecutor` to `ThreadPoolTaskExecutor` or bind via `ExecutorServiceMetrics.monitor` |
| C | `Counter("discord.interaction.error", "code", "UNKNOWN_INTERACTION")` in listener catch blocks |
| D | `JdaGatewayMetricsBinder` — gauge from `JDA.getGatewayPing()`, counter on `ReconnectedEvent` |
| E | `Counter`+`Timer` on `TfnswWeekBeforePoller.run()` and `GtfsStopsIndex.refresh()` |
| F | Fix OTel postgres receiver in `stacks/grafana-lgtm/docker-compose.yml` pipeline |
| G | `Counter("session.anonymous_skip")` in `AnonymousSkippingSessionRepository` |
| H | Add `io.github.resilience4j:resilience4j-micrometer` to `backend/build.gradle` |
