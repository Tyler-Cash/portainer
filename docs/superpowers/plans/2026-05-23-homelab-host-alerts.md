# Homelab Host & Peep-Bot Alert Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add host-level alert coverage and close peep-bot `NoData` gaps in Grafana Alerting, with a new silent `info` severity tier that records without paging.

**Architecture:** Grafana-managed alert rules provisioned via YAML files mounted into the `grafana-lgtm` stack. Three severity tiers routed by `severity` label; `critical` and `warning` go to the existing Discord webhook, `info` routes to a no-op webhook receiver and never notifies. Host rules live in a new `homelab.yaml`; peep-bot additions append a new group to the existing `peepbot.yaml`.

**Tech Stack:** Grafana 13 (otel-lgtm bundle 0.28.0), Prometheus, Loki, YAML provisioning, bash for smoke-test scripts. Deployment is automated — Ansible/Portainer re-creates the `grafana-lgtm` container when `STACK_CONTENT_HASH` flips (any file change under `stacks/grafana-lgtm/`).

**Source spec:** `docs/superpowers/specs/2026-05-23-homelab-host-alerts-design.md`

---

## Conventions used throughout

- All paths absolute from repo root.
- Datasource UIDs are `prometheus`, `loki`, and `__expr__` (Grafana's server-side expression engine), confirmed via `mcp__grafana__list_datasources` during design.
- Every rule UID is unique and prefixed: `host-*` for homelab rules, `peepbot-*` for peepbot rules.
- Selectors scope to `{job="..."}` so a future second host doesn't accidentally cancel alerts via `max by (zpool)` etc.
- YAML files use 2-space indent (matches existing files).
- Each task ends in a commit. Commit subject prefix: `feat(grafana-lgtm)` for additions, `fix(grafana-lgtm)` for corrections.

## Pre-flight: required environment

The smoke validations need a Grafana service-account token. The engineer must export it before running any `task` smoke command:

```bash
export GRAFANA_TOKEN=<service-account-token>
```

A token already exists for the dashboards smoke test (referenced in `Taskfile.yml`). Reuse the same one.

---

## Task 1: Add null-receiver contact point for silent info routing

**Files:**
- Modify: `stacks/grafana-lgtm/grafana/provisioning/alerting/contact-points.yaml`

**Why:** Grafana's notification policy must route every alert *somewhere*. To make `severity=info` silent, we route it to a webhook pointed at an unreachable local URL. Grafana will attempt delivery, fail, and not retry into the existing Discord channel. No Discord noise; alert state still tracked in the UI/history.

- [ ] **Step 1: Add the null contact point**

Append to `stacks/grafana-lgtm/grafana/provisioning/alerting/contact-points.yaml` (after the existing `peepbot-discord` block):

```yaml
  - orgId: 1
    name: null-receiver
    receivers:
      - uid: null-receiver
        type: webhook
        # Discard target: TCP-refused on localhost:1. Grafana logs a single
        # delivery error per evaluation; that's acceptable for an alert tier
        # we explicitly don't want to notify. If log noise becomes an issue,
        # swap to a dedicated low-traffic Discord channel.
        settings:
          url: http://127.0.0.1:1/discard
          httpMethod: POST
          # Don't retry — fire-and-forget delivery attempt.
          maxAlerts: 0
        disableResolveMessage: true
```

- [ ] **Step 2: Lint YAML**

Run:

```bash
python3 -c "import yaml; yaml.safe_load(open('stacks/grafana-lgtm/grafana/provisioning/alerting/contact-points.yaml'))"
```

Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add stacks/grafana-lgtm/grafana/provisioning/alerting/contact-points.yaml
git commit -m "feat(grafana-lgtm): add null-receiver for silent info-severity alerts"
```

---

## Task 2: Route severity=info to the null receiver

**Files:**
- Modify: `stacks/grafana-lgtm/grafana/provisioning/alerting/notification-policies.yaml`

**Why:** Without this child route, an `info` alert would fall through to the root (Discord). The route must come first with `continue: false` to terminate before reaching critical/warning siblings.

- [ ] **Step 1: Insert the info route**

Replace the `routes:` list in `notification-policies.yaml` with:

```yaml
    routes:
      - receiver: null-receiver
        matchers:
          - severity = info
        # Group aggressively — these never page, so we don't need fine-grained
        # delivery timing.
        group_wait: 5m
        group_interval: 1h
        repeat_interval: 24h
        continue: false
      - receiver: peepbot-discord
        matchers:
          - severity = critical
        group_wait: 30s
        group_interval: 5m
        repeat_interval: 1h
        continue: false
      - receiver: peepbot-discord
        matchers:
          - severity = warning
        group_wait: 2m
        group_interval: 10m
        repeat_interval: 4h
        continue: false
```

- [ ] **Step 2: Lint YAML**

```bash
python3 -c "import yaml; yaml.safe_load(open('stacks/grafana-lgtm/grafana/provisioning/alerting/notification-policies.yaml'))"
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add stacks/grafana-lgtm/grafana/provisioning/alerting/notification-policies.yaml
git commit -m "feat(grafana-lgtm): route severity=info to null-receiver (silent tier)"
```

---

## Task 3: Create homelab.yaml with the critical group

**Files:**
- Create: `stacks/grafana-lgtm/grafana/provisioning/alerting/homelab.yaml`
- Modify: `stacks/grafana-lgtm/docker-compose.yml` (add bind mount for the new file)

**Why:** Critical group ships first because `host-fs-full` will fire immediately on deploy (`/hdd` is at 99.98%). That's the live smoke test for the whole pipeline — if it doesn't fire, the provisioning isn't loading.

- [ ] **Step 1: Create homelab.yaml with the critical group**

Create `stacks/grafana-lgtm/grafana/provisioning/alerting/homelab.yaml`:

```yaml
apiVersion: 1

# Alert rules for the homelab host itself.
#
# Rules are grouped by severity. Selectors restrict to known scrape jobs so a
# future second host doesn't accidentally mask alerts via aggregation. PromQL
# validated via scripts/smoke-alerts.sh (uses GRAFANA_TOKEN like the
# dashboards smoke test).
#
# Filesystem rules deliberately match pool-root mountpoints only. ZFS datasets
# share pool space and per-dataset avail/size ratios are misleading.

groups:
  - orgId: 1
    name: homelab-critical
    folder: Homelab
    interval: 1m
    rules:
      - uid: host-down
        title: Scrape target down ≥5m
        condition: B
        for: 5m
        noDataState: Alerting
        execErrState: Error
        data:
          - refId: A
            relativeTimeRange: { from: 300, to: 0 }
            datasourceUid: prometheus
            model:
              refId: A
              expr: up == 0
              queryType: instant
          - refId: B
            relativeTimeRange: { from: 0, to: 0 }
            datasourceUid: __expr__
            model:
              refId: B
              type: threshold
              expression: A
              conditions:
                - evaluator: { type: gt, params: [0] }
        labels:
          severity: critical
          component: host
        annotations:
          summary: "Scrape target {{ $labels.job }}/{{ $labels.instance }} down ≥5m"
          description: |
            Prometheus has been unable to scrape this target for at least 5 minutes.
            If the target is node-exporter itself, all other host alerts are
            effectively silenced until it recovers.

      - uid: host-zfs-pool-not-online
        title: ZFS pool not ONLINE
        condition: B
        for: 2m
        noDataState: OK
        execErrState: Error
        data:
          - refId: A
            relativeTimeRange: { from: 120, to: 0 }
            datasourceUid: prometheus
            model:
              refId: A
              expr: max by (zpool) (node_zfs_zpool_state{job="node-exporter",state=~"degraded|faulted|unavail|suspended|removed"})
              queryType: instant
          - refId: B
            relativeTimeRange: { from: 0, to: 0 }
            datasourceUid: __expr__
            model:
              refId: B
              type: threshold
              expression: A
              conditions:
                - evaluator: { type: gt, params: [0] }
        labels:
          severity: critical
          component: zfs
        annotations:
          summary: "ZFS pool {{ $labels.zpool }} is not ONLINE"
          description: |
            Pool state has dropped out of ONLINE. Run `zpool status` on the host
            to identify the failing vdev/device. Recovery requires manual
            intervention (resilver, replace, import).

      - uid: host-smart-failed
        title: SMART overall-health failed
        condition: B
        for: 5m
        noDataState: OK
        execErrState: Error
        data:
          - refId: A
            relativeTimeRange: { from: 300, to: 0 }
            datasourceUid: prometheus
            model:
              refId: A
              expr: smartctl_device_smart_status{job="smartctl-exporter"} == 0
              queryType: instant
          - refId: B
            relativeTimeRange: { from: 0, to: 0 }
            datasourceUid: __expr__
            model:
              refId: B
              type: threshold
              expression: A
              conditions:
                - evaluator: { type: gt, params: [-1] }
        labels:
          severity: critical
          component: disk
        annotations:
          summary: "Disk {{ $labels.device }} reports SMART FAIL"
          description: |
            The drive's own SMART self-assessment reports failure. Replace
            ASAP — once a drive flips this flag it has very limited remaining
            life.

      - uid: host-nvme-critical-warning
        title: NVMe critical warning flag
        condition: B
        for: 5m
        noDataState: OK
        execErrState: Error
        data:
          - refId: A
            relativeTimeRange: { from: 300, to: 0 }
            datasourceUid: prometheus
            model:
              refId: A
              expr: smartctl_device_critical_warning_total{job="smartctl-exporter"} > 0
              queryType: instant
          - refId: B
            relativeTimeRange: { from: 0, to: 0 }
            datasourceUid: __expr__
            model:
              refId: B
              type: threshold
              expression: A
              conditions:
                - evaluator: { type: gt, params: [-1] }
        labels:
          severity: critical
          component: disk
        annotations:
          summary: "NVMe {{ $labels.device }} reports critical warning"
          description: |
            The NVMe firmware has raised a critical warning (spare exhausted,
            thermal, media error, or read-only). Inspect with
            `smartctl -a /dev/{{ $labels.device }}` to identify which.

      - uid: host-fs-full
        title: Pool root filesystem ≥98% full
        condition: B
        for: 15m
        noDataState: OK
        execErrState: Error
        data:
          - refId: A
            relativeTimeRange: { from: 900, to: 0 }
            datasourceUid: prometheus
            model:
              refId: A
              expr: |
                node_filesystem_avail_bytes{job="node-exporter",mountpoint=~"/|/hdd|/ssd"}
                / node_filesystem_size_bytes{job="node-exporter",mountpoint=~"/|/hdd|/ssd"}
              queryType: instant
          - refId: B
            relativeTimeRange: { from: 0, to: 0 }
            datasourceUid: __expr__
            model:
              refId: B
              type: threshold
              expression: A
              conditions:
                - evaluator: { type: lt, params: [0.02] }
        labels:
          severity: critical
          component: disk
        annotations:
          summary: "Pool root {{ $labels.mountpoint }} ≥98% full"
          description: |
            Pool root is nearly full. ZFS dataset-level ratios will show 100%
            once the pool fills — this alert checks the pool root, which is
            the truthful signal. Free space immediately (delete, prune
            snapshots, expand).
```

- [ ] **Step 2: Mount the new file in docker-compose**

In `stacks/grafana-lgtm/docker-compose.yml`, add this line directly after the existing alerting bind mounts (after the `notification-policies.yaml` line, around line 156):

```yaml
      - ./grafana/provisioning/alerting/homelab.yaml:/otel-lgtm/grafana/conf/provisioning/alerting/homelab.yaml:ro
```

The complete alerting mount block should now read:

```yaml
      - ./grafana/provisioning/alerting/peepbot.yaml:/otel-lgtm/grafana/conf/provisioning/alerting/peepbot.yaml:ro
      - ./grafana/provisioning/alerting/contact-points.yaml:/otel-lgtm/grafana/conf/provisioning/alerting/contact-points.yaml:ro
      - ./grafana/provisioning/alerting/notification-policies.yaml:/otel-lgtm/grafana/conf/provisioning/alerting/notification-policies.yaml:ro
      - ./grafana/provisioning/alerting/homelab.yaml:/otel-lgtm/grafana/conf/provisioning/alerting/homelab.yaml:ro
```

- [ ] **Step 3: Lint YAML**

```bash
python3 -c "import yaml; yaml.safe_load(open('stacks/grafana-lgtm/grafana/provisioning/alerting/homelab.yaml'))"
python3 -c "import yaml; yaml.safe_load(open('stacks/grafana-lgtm/docker-compose.yml'))"
```

Expected: no output for either.

- [ ] **Step 4: Smoke-test each PromQL against live Prometheus**

Until the smoke script exists (Task 7), use one-off curls. Run each expression and confirm `.status == "success"`:

```bash
GRAFANA_URL="${GRAFANA_URL:-https://grafana.tylercash.dev}"
for expr in \
  'up == 0' \
  'max by (zpool) (node_zfs_zpool_state{job="node-exporter",state=~"degraded|faulted|unavail|suspended|removed"})' \
  'smartctl_device_smart_status{job="smartctl-exporter"} == 0' \
  'smartctl_device_critical_warning_total{job="smartctl-exporter"} > 0' \
  'node_filesystem_avail_bytes{job="node-exporter",mountpoint=~"/|/hdd|/ssd"} / node_filesystem_size_bytes{job="node-exporter",mountpoint=~"/|/hdd|/ssd"}'
do
  status=$(curl -sS -G \
    -H "Authorization: Bearer $GRAFANA_TOKEN" \
    --data-urlencode "query=$expr" \
    "$GRAFANA_URL/api/datasources/proxy/uid/prometheus/api/v1/query" | jq -r '.status')
  echo "$status  $expr"
done
```

Expected: every line begins with `success`. Anything else means a typo in the expression — fix before committing.

- [ ] **Step 5: Commit**

```bash
git add stacks/grafana-lgtm/grafana/provisioning/alerting/homelab.yaml stacks/grafana-lgtm/docker-compose.yml
git commit -m "feat(grafana-lgtm): add homelab critical-tier alert rules"
```

---

## Task 4: Add homelab-warning group

**Files:**
- Modify: `stacks/grafana-lgtm/grafana/provisioning/alerting/homelab.yaml`

**Why:** Warnings notify but at a calmer cadence (4h repeat). These are "needs attention this week" not "deal with it now".

Note: the container-restart-loop rule from the spec is **dropped** at implementation time. The current OTel docker_stats receiver does not emit a restart counter (`container_*_restarts_total` does not exist; only cpu/mem/net/blockio). Replacing it would require enabling cAdvisor or a dedicated exporter — outside scope. `host-down` already catches the consequence (a container that fails to stay up will show its scrape target as down).

- [ ] **Step 1: Append warning group to homelab.yaml**

Append the following directly after the `homelab-critical` group in `homelab.yaml`:

```yaml
  - orgId: 1
    name: homelab-warning
    folder: Homelab
    interval: 1m
    rules:
      - uid: host-fs-90
        title: Pool root filesystem ≥90% full
        condition: B
        for: 1h
        noDataState: OK
        execErrState: Error
        data:
          - refId: A
            relativeTimeRange: { from: 3600, to: 0 }
            datasourceUid: prometheus
            model:
              refId: A
              expr: |
                node_filesystem_avail_bytes{job="node-exporter",mountpoint=~"/|/hdd|/ssd"}
                / node_filesystem_size_bytes{job="node-exporter",mountpoint=~"/|/hdd|/ssd"}
              queryType: instant
          - refId: B
            relativeTimeRange: { from: 0, to: 0 }
            datasourceUid: __expr__
            model:
              refId: B
              type: threshold
              expression: A
              conditions:
                - evaluator: { type: lt, params: [0.10] }
        labels:
          severity: warning
          component: disk
        annotations:
          summary: "Pool root {{ $labels.mountpoint }} ≥90% full"
          description: |
            Pool is approaching full. Plan to free space or expand within the
            week before host-fs-full fires.

      - uid: host-smart-sectors-growing
        title: SMART reallocated/pending sectors increased
        condition: B
        for: 1h
        noDataState: OK
        execErrState: Error
        data:
          - refId: A
            relativeTimeRange: { from: 86400, to: 0 }
            datasourceUid: prometheus
            model:
              refId: A
              expr: |
                increase(smartctl_device_attribute{
                  job="smartctl-exporter",
                  attribute_name=~"Reallocated_Sector_Ct|Current_Pending_Sector",
                  attribute_value_type="raw"
                }[24h])
              queryType: instant
          - refId: B
            relativeTimeRange: { from: 0, to: 0 }
            datasourceUid: __expr__
            model:
              refId: B
              type: threshold
              expression: A
              conditions:
                - evaluator: { type: gt, params: [0] }
        labels:
          severity: warning
          component: disk
        annotations:
          summary: "{{ $labels.device }} sector count growing ({{ $labels.attribute_name }})"
          description: |
            Reallocated or pending sectors increased in the last 24h. This is
            early disk degradation. Check `smartctl -a /dev/{{ $labels.device }}`
            and plan a replacement.

      - uid: host-nvme-wearout
        title: NVMe wearout >80%
        condition: B
        for: 10m
        noDataState: OK
        execErrState: Error
        data:
          - refId: A
            relativeTimeRange: { from: 600, to: 0 }
            datasourceUid: prometheus
            model:
              refId: A
              expr: smartctl_device_percentage_used_total{job="smartctl-exporter"}
              queryType: instant
          - refId: B
            relativeTimeRange: { from: 0, to: 0 }
            datasourceUid: __expr__
            model:
              refId: B
              type: threshold
              expression: A
              conditions:
                - evaluator: { type: gt, params: [80] }
        labels:
          severity: warning
          component: disk
        annotations:
          summary: "NVMe {{ $labels.device }} wearout {{ $value }}%"
          description: |
            Reported NVMe endurance is past 80%. Plan replacement within the
            next few months; the firmware will eventually flip to read-only.
```

- [ ] **Step 2: Lint YAML**

```bash
python3 -c "import yaml; yaml.safe_load(open('stacks/grafana-lgtm/grafana/provisioning/alerting/homelab.yaml'))"
```

Expected: no output.

- [ ] **Step 3: Smoke-test each PromQL**

```bash
for expr in \
  'node_filesystem_avail_bytes{job="node-exporter",mountpoint=~"/|/hdd|/ssd"} / node_filesystem_size_bytes{job="node-exporter",mountpoint=~"/|/hdd|/ssd"}' \
  'increase(smartctl_device_attribute{job="smartctl-exporter",attribute_name=~"Reallocated_Sector_Ct|Current_Pending_Sector",attribute_value_type="raw"}[24h])' \
  'smartctl_device_percentage_used_total{job="smartctl-exporter"}'
do
  status=$(curl -sS -G -H "Authorization: Bearer $GRAFANA_TOKEN" \
    --data-urlencode "query=$expr" \
    "$GRAFANA_URL/api/datasources/proxy/uid/prometheus/api/v1/query" | jq -r '.status')
  echo "$status  $expr"
done
```

Expected: every line begins with `success`.

- [ ] **Step 4: Commit**

```bash
git add stacks/grafana-lgtm/grafana/provisioning/alerting/homelab.yaml
git commit -m "feat(grafana-lgtm): add homelab warning-tier alert rules"
```

---

## Task 5: Add homelab-info group

**Files:**
- Modify: `stacks/grafana-lgtm/grafana/provisioning/alerting/homelab.yaml`

**Why:** Info tier — silent, dashboard-only. Captures "slow but not broken" signals and OOM kills for post-incident correlation.

- [ ] **Step 1: Append info group**

Append directly after the `homelab-warning` group:

```yaml
  - orgId: 1
    name: homelab-info
    folder: Homelab
    interval: 1m
    rules:
      - uid: host-load-high
        title: Load avg high vs cores
        condition: B
        for: 30m
        noDataState: OK
        execErrState: OK
        data:
          - refId: A
            relativeTimeRange: { from: 1800, to: 0 }
            datasourceUid: prometheus
            model:
              refId: A
              expr: node_load5{job="node-exporter"} / count by (instance) (node_cpu_seconds_total{job="node-exporter",mode="idle"})
              queryType: instant
          - refId: B
            relativeTimeRange: { from: 0, to: 0 }
            datasourceUid: __expr__
            model:
              refId: B
              type: threshold
              expression: A
              conditions:
                - evaluator: { type: gt, params: [2] }
        labels:
          severity: info
          component: host
        annotations:
          summary: "Load5/cores > 2 on {{ $labels.instance }}"

      - uid: host-iowait-high
        title: CPU iowait elevated
        condition: B
        for: 30m
        noDataState: OK
        execErrState: OK
        data:
          - refId: A
            relativeTimeRange: { from: 1800, to: 0 }
            datasourceUid: prometheus
            model:
              refId: A
              expr: avg by (instance) (rate(node_cpu_seconds_total{job="node-exporter",mode="iowait"}[5m]))
              queryType: instant
          - refId: B
            relativeTimeRange: { from: 0, to: 0 }
            datasourceUid: __expr__
            model:
              refId: B
              type: threshold
              expression: A
              conditions:
                - evaluator: { type: gt, params: [0.2] }
        labels:
          severity: info
          component: host
        annotations:
          summary: "iowait > 20% for 30m on {{ $labels.instance }}"

      - uid: host-cpu-temp-warm
        title: CPU temperature warm
        condition: B
        for: 30m
        noDataState: OK
        execErrState: OK
        data:
          - refId: A
            relativeTimeRange: { from: 1800, to: 0 }
            datasourceUid: prometheus
            model:
              refId: A
              expr: node_hwmon_temp_celsius{job="node-exporter"}
              queryType: instant
          - refId: B
            relativeTimeRange: { from: 0, to: 0 }
            datasourceUid: __expr__
            model:
              refId: B
              type: threshold
              expression: A
              conditions:
                - evaluator: { type: gt, params: [75] }
        labels:
          severity: info
          component: host
        annotations:
          summary: "CPU sensor {{ $labels.chip }}/{{ $labels.sensor }} > 75°C"

      - uid: host-root-fs-75
        title: Root filesystem ≥75% full
        condition: B
        for: 1h
        noDataState: OK
        execErrState: OK
        data:
          - refId: A
            relativeTimeRange: { from: 3600, to: 0 }
            datasourceUid: prometheus
            model:
              refId: A
              expr: |
                node_filesystem_avail_bytes{job="node-exporter",mountpoint="/"}
                / node_filesystem_size_bytes{job="node-exporter",mountpoint="/"}
              queryType: instant
          - refId: B
            relativeTimeRange: { from: 0, to: 0 }
            datasourceUid: __expr__
            model:
              refId: B
              type: threshold
              expression: A
              conditions:
                - evaluator: { type: lt, params: [0.25] }
        labels:
          severity: info
          component: disk
        annotations:
          summary: "Root filesystem ≥75% full"

      - uid: host-disk-temp-high
        title: Disk temperature high
        condition: B
        for: 30m
        noDataState: OK
        execErrState: OK
        data:
          - refId: A
            relativeTimeRange: { from: 1800, to: 0 }
            datasourceUid: prometheus
            model:
              refId: A
              expr: smartctl_device_temperature{job="smartctl-exporter"}
              queryType: instant
          - refId: B
            relativeTimeRange: { from: 0, to: 0 }
            datasourceUid: __expr__
            model:
              refId: B
              type: threshold
              expression: A
              conditions:
                - evaluator: { type: gt, params: [55] }
        labels:
          severity: info
          component: disk
        annotations:
          summary: "Disk {{ $labels.device }} > 55°C"

      - uid: host-memory-pressure
        title: Available memory <5%
        condition: B
        for: 30m
        noDataState: OK
        execErrState: OK
        data:
          - refId: A
            relativeTimeRange: { from: 1800, to: 0 }
            datasourceUid: prometheus
            model:
              refId: A
              expr: node_memory_MemAvailable_bytes{job="node-exporter"} / node_memory_MemTotal_bytes{job="node-exporter"}
              queryType: instant
          - refId: B
            relativeTimeRange: { from: 0, to: 0 }
            datasourceUid: __expr__
            model:
              refId: B
              type: threshold
              expression: A
              conditions:
                - evaluator: { type: lt, params: [0.05] }
        labels:
          severity: info
          component: host
        annotations:
          summary: "Available memory <5% on {{ $labels.instance }}"

      - uid: host-swap-used
        title: Swap >50% used
        condition: B
        for: 1h
        noDataState: OK
        execErrState: OK
        data:
          - refId: A
            relativeTimeRange: { from: 3600, to: 0 }
            datasourceUid: prometheus
            model:
              refId: A
              expr: |
                (node_memory_SwapTotal_bytes{job="node-exporter"} - node_memory_SwapFree_bytes{job="node-exporter"})
                / (node_memory_SwapTotal_bytes{job="node-exporter"} > 0)
              queryType: instant
          - refId: B
            relativeTimeRange: { from: 0, to: 0 }
            datasourceUid: __expr__
            model:
              refId: B
              type: threshold
              expression: A
              conditions:
                - evaluator: { type: gt, params: [0.5] }
        labels:
          severity: info
          component: host
        annotations:
          summary: "Swap >50% used on {{ $labels.instance }}"

      - uid: host-oom-kill
        title: OOM kill occurred
        condition: B
        for: 0s
        noDataState: OK
        execErrState: OK
        data:
          - refId: A
            relativeTimeRange: { from: 600, to: 0 }
            datasourceUid: prometheus
            model:
              refId: A
              expr: increase(node_vmstat_oom_kill{job="node-exporter"}[10m])
              queryType: instant
          - refId: B
            relativeTimeRange: { from: 0, to: 0 }
            datasourceUid: __expr__
            model:
              refId: B
              type: threshold
              expression: A
              conditions:
                - evaluator: { type: gt, params: [0] }
        labels:
          severity: info
          component: host
        annotations:
          summary: "OOM kill recorded in the last 10m"

      - uid: host-network-errs
        title: Network interface RX/TX errors
        condition: B
        for: 10m
        noDataState: OK
        execErrState: OK
        data:
          - refId: A
            relativeTimeRange: { from: 600, to: 0 }
            datasourceUid: prometheus
            model:
              refId: A
              expr: |
                rate(node_network_receive_errs_total{job="node-exporter"}[5m])
                + rate(node_network_transmit_errs_total{job="node-exporter"}[5m])
              queryType: instant
          - refId: B
            relativeTimeRange: { from: 0, to: 0 }
            datasourceUid: __expr__
            model:
              refId: B
              type: threshold
              expression: A
              conditions:
                - evaluator: { type: gt, params: [0] }
        labels:
          severity: info
          component: network
        annotations:
          summary: "Network errors on {{ $labels.device }}"

      - uid: host-network-drops
        title: Network interface RX/TX drops
        condition: B
        for: 10m
        noDataState: OK
        execErrState: OK
        data:
          - refId: A
            relativeTimeRange: { from: 600, to: 0 }
            datasourceUid: prometheus
            model:
              refId: A
              expr: |
                rate(node_network_receive_drop_total{job="node-exporter"}[5m])
                + rate(node_network_transmit_drop_total{job="node-exporter"}[5m])
              queryType: instant
          - refId: B
            relativeTimeRange: { from: 0, to: 0 }
            datasourceUid: __expr__
            model:
              refId: B
              type: threshold
              expression: A
              conditions:
                - evaluator: { type: gt, params: [0] }
        labels:
          severity: info
          component: network
        annotations:
          summary: "Network drops on {{ $labels.device }}"
```

- [ ] **Step 2: Lint YAML**

```bash
python3 -c "import yaml; yaml.safe_load(open('stacks/grafana-lgtm/grafana/provisioning/alerting/homelab.yaml'))"
```

Expected: no output.

- [ ] **Step 3: Smoke-test each PromQL**

```bash
for expr in \
  'node_load5{job="node-exporter"} / count by (instance) (node_cpu_seconds_total{job="node-exporter",mode="idle"})' \
  'avg by (instance) (rate(node_cpu_seconds_total{job="node-exporter",mode="iowait"}[5m]))' \
  'node_hwmon_temp_celsius{job="node-exporter"}' \
  'node_filesystem_avail_bytes{job="node-exporter",mountpoint="/"} / node_filesystem_size_bytes{job="node-exporter",mountpoint="/"}' \
  'smartctl_device_temperature{job="smartctl-exporter"}' \
  'node_memory_MemAvailable_bytes{job="node-exporter"} / node_memory_MemTotal_bytes{job="node-exporter"}' \
  '(node_memory_SwapTotal_bytes{job="node-exporter"} - node_memory_SwapFree_bytes{job="node-exporter"}) / (node_memory_SwapTotal_bytes{job="node-exporter"} > 0)' \
  'increase(node_vmstat_oom_kill{job="node-exporter"}[10m])' \
  'rate(node_network_receive_errs_total{job="node-exporter"}[5m]) + rate(node_network_transmit_errs_total{job="node-exporter"}[5m])' \
  'rate(node_network_receive_drop_total{job="node-exporter"}[5m]) + rate(node_network_transmit_drop_total{job="node-exporter"}[5m])'
do
  status=$(curl -sS -G -H "Authorization: Bearer $GRAFANA_TOKEN" \
    --data-urlencode "query=$expr" \
    "$GRAFANA_URL/api/datasources/proxy/uid/prometheus/api/v1/query" | jq -r '.status')
  echo "$status  $expr"
done
```

Expected: every line begins with `success`.

If `node_vmstat_oom_kill` returns no data, that's fine — it means no OOM kills have happened (the metric appears once an OOM occurs). The smoke test only checks that the expression parses.

- [ ] **Step 4: Commit**

```bash
git add stacks/grafana-lgtm/grafana/provisioning/alerting/homelab.yaml
git commit -m "feat(grafana-lgtm): add homelab info-tier (silent) alert rules"
```

---

## Task 6: Append peepbot-info group to peepbot.yaml

**Files:**
- Modify: `stacks/grafana-lgtm/grafana/provisioning/alerting/peepbot.yaml`

**Why:** Closes the `NoData` blind spot. If peep-bot's metric stream stops, `peepbot-app-down` lights up with context — the existing rules just resolve silently.

- [ ] **Step 1: Append the peepbot-info group**

Append at the end of `stacks/grafana-lgtm/grafana/provisioning/alerting/peepbot.yaml` (after the existing `peepbot-warning` group):

```yaml
  - orgId: 1
    name: peepbot-info
    folder: Peep Bot
    interval: 1m
    rules:
      - uid: peepbot-app-down
        title: Peep Bot metric stream absent ≥5m
        condition: B
        for: 5m
        noDataState: Alerting
        execErrState: OK
        data:
          - refId: A
            relativeTimeRange: { from: 300, to: 0 }
            datasourceUid: prometheus
            model:
              refId: A
              expr: absent_over_time(application_ready_time_milliseconds{service_namespace="peep-bot"}[5m])
              queryType: instant
          - refId: B
            relativeTimeRange: { from: 0, to: 0 }
            datasourceUid: __expr__
            model:
              refId: B
              type: threshold
              expression: A
              conditions:
                - evaluator: { type: gt, params: [0] }
        labels:
          severity: info
          component: lifecycle
        annotations:
          summary: "Peep Bot metric stream absent ≥5m"
          description: |
            No `application_ready_time_milliseconds` samples seen for 5m.
            Either the app is down, the OTel pipeline is broken, or the
            scrape is failing. host-down covers the paging case at the
            target level; this rule adds component context for history.

      - uid: peepbot-restart-spike
        title: Peep Bot JVM restart spike
        condition: B
        for: 0s
        noDataState: OK
        execErrState: OK
        data:
          - refId: A
            relativeTimeRange: { from: 3600, to: 0 }
            datasourceUid: prometheus
            model:
              refId: A
              expr: changes(process_start_time_seconds{service_namespace="peep-bot"}[1h])
              queryType: instant
          - refId: B
            relativeTimeRange: { from: 0, to: 0 }
            datasourceUid: __expr__
            model:
              refId: B
              type: threshold
              expression: A
              conditions:
                - evaluator: { type: gt, params: [2] }
        labels:
          severity: info
          component: lifecycle
        annotations:
          summary: "Peep Bot JVM restarted {{ $value }} times in 1h"

      - uid: peepbot-log-error-rate
        title: Peep Bot log ERROR rate elevated
        condition: B
        for: 10m
        noDataState: OK
        execErrState: OK
        data:
          - refId: A
            relativeTimeRange: { from: 300, to: 0 }
            datasourceUid: loki
            model:
              refId: A
              expr: sum(rate({service_namespace="peep-bot"} |= "ERROR" [5m]))
              queryType: instant
          - refId: B
            relativeTimeRange: { from: 0, to: 0 }
            datasourceUid: __expr__
            model:
              refId: B
              type: threshold
              expression: A
              conditions:
                - evaluator: { type: gt, params: [0.5] }
        labels:
          severity: info
          component: logs
        annotations:
          summary: "Peep Bot ERROR log rate > 0.5/s"
          description: |
            Background tasks or listeners that swallow exceptions won't show
            in http_server_requests metrics. Drill in via Loki:
              {service_namespace="peep-bot"} |= "ERROR"

      - uid: peepbot-listener-failure-rate
        title: Lifecycle listener failure ratio >5%
        condition: B
        for: 10m
        noDataState: OK
        execErrState: OK
        data:
          - refId: A
            relativeTimeRange: { from: 600, to: 0 }
            datasourceUid: prometheus
            model:
              refId: A
              expr: |
                sum(rate(lifecycle_listener_invoke_milliseconds_count{service_namespace="peep-bot",error!="none"}[10m]))
                / sum(rate(lifecycle_listener_invoke_milliseconds_count{service_namespace="peep-bot"}[10m]))
              queryType: instant
          - refId: B
            relativeTimeRange: { from: 0, to: 0 }
            datasourceUid: __expr__
            model:
              refId: B
              type: threshold
              expression: A
              conditions:
                - evaluator: { type: gt, params: [0.05] }
        labels:
          severity: info
          component: lifecycle
        annotations:
          summary: "Lifecycle listener failure ratio >5%"
          description: |
            More than 5% of listener invocations are completing with a
            non-none `error` label. This precedes the lifecycle-stuck
            critical alert by indicating sustained transient failures.

      - uid: peepbot-otel-collector-down
        title: OTel collector down ≥5m
        condition: B
        for: 5m
        noDataState: Alerting
        execErrState: OK
        data:
          - refId: A
            relativeTimeRange: { from: 300, to: 0 }
            datasourceUid: prometheus
            model:
              refId: A
              expr: up{job="otelcol-contrib"} == 0
              queryType: instant
          - refId: B
            relativeTimeRange: { from: 0, to: 0 }
            datasourceUid: __expr__
            model:
              refId: B
              type: threshold
              expression: A
              conditions:
                - evaluator: { type: gt, params: [-1] }
        labels:
          severity: info
          component: telemetry
        annotations:
          summary: "OTel collector {{ $labels.instance }} down ≥5m"
          description: |
            If the collector is down, peep-bot metrics stop arriving and all
            other peep-bot rules silently resolve. host-down catches the
            paging case; this rule provides telemetry-layer attribution.
```

- [ ] **Step 2: Lint YAML**

```bash
python3 -c "import yaml; yaml.safe_load(open('stacks/grafana-lgtm/grafana/provisioning/alerting/peepbot.yaml'))"
```

Expected: no output.

- [ ] **Step 3: Smoke-test PromQL expressions**

```bash
for expr in \
  'absent_over_time(application_ready_time_milliseconds{service_namespace="peep-bot"}[5m])' \
  'changes(process_start_time_seconds{service_namespace="peep-bot"}[1h])' \
  'sum(rate(lifecycle_listener_invoke_milliseconds_count{service_namespace="peep-bot",error!="none"}[10m])) / sum(rate(lifecycle_listener_invoke_milliseconds_count{service_namespace="peep-bot"}[10m]))' \
  'up{job="otelcol-contrib"} == 0'
do
  status=$(curl -sS -G -H "Authorization: Bearer $GRAFANA_TOKEN" \
    --data-urlencode "query=$expr" \
    "$GRAFANA_URL/api/datasources/proxy/uid/prometheus/api/v1/query" | jq -r '.status')
  echo "$status  $expr"
done
```

Expected: every line begins with `success`.

- [ ] **Step 4: Smoke-test the LogQL expression**

```bash
curl -sS -G -H "Authorization: Bearer $GRAFANA_TOKEN" \
  --data-urlencode 'query=sum(rate({service_namespace="peep-bot"} |= "ERROR" [5m]))' \
  --data-urlencode "time=$(date -u +%s)" \
  "$GRAFANA_URL/api/datasources/proxy/uid/loki/loki/api/v1/query" | jq -r '.status'
```

Expected: `success`.

- [ ] **Step 5: Commit**

```bash
git add stacks/grafana-lgtm/grafana/provisioning/alerting/peepbot.yaml
git commit -m "feat(grafana-lgtm): add peepbot-info silent alerts for NoData visibility"
```

---

## Task 7: Add an alert-rules smoke-test script

**Files:**
- Create: `stacks/grafana-lgtm/scripts/smoke-alerts.sh`
- Modify: `Taskfile.yml`

**Why:** Future edits to these YAML files need the same one-command guardrail the dashboards have. Walks every rule's PromQL/LogQL expression and runs it against the live datasource.

- [ ] **Step 1: Create the script**

Create `stacks/grafana-lgtm/scripts/smoke-alerts.sh`:

```bash
#!/usr/bin/env bash
# Smoke-test every alert-rule expression in stacks/grafana-lgtm/grafana/provisioning/alerting/.
# Usage: GRAFANA_TOKEN=<service-account-token> ./smoke-alerts.sh
# Exit non-zero on any parse error.

set -euo pipefail

GRAFANA_URL="${GRAFANA_URL:-https://grafana.tylercash.dev}"
ALERTING_DIR="$(cd "$(dirname "$0")/.." && pwd)/grafana/provisioning/alerting"

if [[ -z "${GRAFANA_TOKEN:-}" ]]; then
  echo "GRAFANA_TOKEN env var required" >&2
  exit 2
fi

fail=0
total=0

# Walk every rule's data[]; for each entry, send its model.expr to the
# matching datasource's instant query endpoint. The __expr__ refs are
# server-side expressions (threshold/math), not datasource queries, so
# they're filtered out.
for f in "$ALERTING_DIR"/{homelab,peepbot}.yaml; do
  [[ -f "$f" ]] || continue
  base="$(basename "$f")"

  # yq isn't assumed; use python for YAML→JSON.
  python3 -c "
import sys, yaml, json
data = yaml.safe_load(open('$f'))
for group in data.get('groups', []):
    for rule in group.get('rules', []):
        for d in rule.get('data', []):
            if d.get('datasourceUid') in ('prometheus', 'loki'):
                expr = (d.get('model') or {}).get('expr')
                if expr:
                    print(json.dumps({'rule': rule['uid'], 'ds': d['datasourceUid'], 'expr': expr}))
" | while IFS= read -r line; do
    rule=$(echo "$line" | jq -r '.rule')
    ds=$(echo "$line" | jq -r '.ds')
    expr=$(echo "$line" | jq -r '.expr')

    total=$((total + 1))
    if [[ "$ds" == "prometheus" ]]; then
      url="$GRAFANA_URL/api/datasources/proxy/uid/prometheus/api/v1/query"
      status=$(curl -sS -G \
        -H "Authorization: Bearer $GRAFANA_TOKEN" \
        --data-urlencode "query=$expr" \
        "$url" | jq -r '.status // "unknown"')
    else
      url="$GRAFANA_URL/api/datasources/proxy/uid/loki/loki/api/v1/query"
      status=$(curl -sS -G \
        -H "Authorization: Bearer $GRAFANA_TOKEN" \
        --data-urlencode "query=$expr" \
        --data-urlencode "time=$(date -u +%s)" \
        "$url" | jq -r '.status // "unknown"')
    fi

    if [[ "$status" != "success" ]]; then
      echo "FAIL [$base/$rule/$ds] $expr"
      fail=$((fail + 1))
    fi
  done
done

echo "---"
echo "$((total - fail))/$total queries OK ($fail failed)"
exit "$fail"
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x stacks/grafana-lgtm/scripts/smoke-alerts.sh
```

- [ ] **Step 3: Add the Task target**

In `Taskfile.yml`, directly after the existing `grafana:smoke` task, add:

```yaml
  grafana:smoke-alerts:
    desc: "Smoke-test PromQL/LogQL in alert-rule YAML (requires GRAFANA_TOKEN)"
    cmds:
      - stacks/grafana-lgtm/scripts/smoke-alerts.sh
```

- [ ] **Step 4: Run the new smoke test**

```bash
task grafana:smoke-alerts
```

Expected: `<N>/<N> queries OK (0 failed)` where N matches the number of distinct prometheus+loki query refs across both files (host rules: ~22 refs; peepbot rules: existing + 5 new).

- [ ] **Step 5: Commit**

```bash
git add stacks/grafana-lgtm/scripts/smoke-alerts.sh Taskfile.yml
git commit -m "feat(grafana-lgtm): add smoke-alerts task to validate alert-rule PromQL/LogQL"
```

---

## Task 8: Deploy and verify in Grafana

**Files:** None (deployment is Ansible-driven).

**Why:** Final end-to-end verification that the provisioning loaded, rules are visible, and severity routing works.

- [ ] **Step 1: Push to trigger deployment**

```bash
git push
```

Ansible will detect the change under `stacks/grafana-lgtm/`, bump `STACK_CONTENT_HASH`, and recreate the `grafana-lgtm` container. Allow ~2–3 minutes for the container's healthcheck (`start_period: 5m`) and Grafana provisioning to settle.

- [ ] **Step 2: Confirm rules are loaded via the Grafana API**

```bash
curl -sS -H "Authorization: Bearer $GRAFANA_TOKEN" \
  "https://grafana.tylercash.dev/api/v1/provisioning/alert-rules" \
  | jq -r '.[] | "\(.uid)  \(.title)"' \
  | sort
```

Expected output includes (in addition to the pre-existing `peepbot-*` rules):
- `host-cpu-temp-warm`, `host-disk-temp-high`, `host-down`, `host-fs-90`, `host-fs-full`, `host-iowait-high`, `host-load-high`, `host-memory-pressure`, `host-network-drops`, `host-network-errs`, `host-nvme-critical-warning`, `host-nvme-wearout`, `host-oom-kill`, `host-root-fs-75`, `host-smart-failed`, `host-smart-sectors-growing`, `host-swap-used`, `host-zfs-pool-not-online`
- `peepbot-app-down`, `peepbot-listener-failure-rate`, `peepbot-log-error-rate`, `peepbot-otel-collector-down`, `peepbot-restart-spike`

If a UID is missing, check Grafana container logs for provisioning errors:

```bash
docker logs grafana-lgtm 2>&1 | grep -iE "alerting|provisioning" | tail -30
```

(Or via Portainer's log viewer for the grafana-lgtm service.)

- [ ] **Step 3: Verify host-fs-full is firing (live smoke test)**

```bash
curl -sS -H "Authorization: Bearer $GRAFANA_TOKEN" \
  "https://grafana.tylercash.dev/api/v1/provisioning/alert-rules/host-fs-full" \
  | jq '.'
```

Then check current alert state:

```bash
curl -sS -H "Authorization: Bearer $GRAFANA_TOKEN" \
  "https://grafana.tylercash.dev/api/prometheus/grafana/api/v1/rules" \
  | jq '.data.groups[] | select(.name=="homelab-critical") | .rules[] | select(.name=="Pool root filesystem ≥98% full") | {name, state, alerts}'
```

Expected: `state` reaches `firing` within `for: 15m` (account for the `for` duration). For an immediate check, look for state `pending` or `firing` and at least one alert with `value` showing `/hdd` close to 0.0002 (≈1 − 0.9998).

If `state == "normal"` after 20 minutes despite `/hdd` being at 99.98%, the rule isn't evaluating correctly — re-check the expression syntax in `homelab.yaml`.

- [ ] **Step 4: Confirm an info alert does NOT reach Discord**

Pick a deliberately-easy-to-trigger info rule (`host-load-high` if load is high; otherwise the network rules will fire on any drop). Identify one that's currently `firing` from Step 2:

```bash
curl -sS -H "Authorization: Bearer $GRAFANA_TOKEN" \
  "https://grafana.tylercash.dev/api/prometheus/grafana/api/v1/rules" \
  | jq '.data.groups[] | select(.name=="homelab-info") | .rules[] | select(.state=="firing") | .name'
```

Then ask the user (or check the Discord channel directly) to confirm no Discord message has appeared for these info-tier alerts in the last few minutes. The existing critical/warning Discord behaviour for peep-bot rules should be unchanged.

- [ ] **Step 5: Mark the spec as implemented**

Append a brief status note at the top of `docs/superpowers/specs/2026-05-23-homelab-host-alerts-design.md`:

```markdown
**Status:** Implemented 2026-MM-DD (commit <sha>)
```

(Replace `Status: Design — pending implementation plan`.)

Commit:

```bash
git add docs/superpowers/specs/2026-05-23-homelab-host-alerts-design.md
git commit -m "docs: mark host-alerts spec as implemented"
git push
```

---

## Follow-ups (not in this plan)

Captured here for visibility — tracked separately:

1. **Container restart-loop detection.** The current OTel docker_stats receiver doesn't emit a restart counter. To add a real `host-container-restart-loop` warning, enable cAdvisor (or the OTel `cadvisor` receiver) and reference `container_restart_count` / `container_oom_events_total`. Independent project.
2. **Backup freshness, Traefik cert expiry, `node_reboot_required`, UPS metrics.** Each needs new exporters or scrape configs — see the spec's "Out of scope" section.
3. **`node_textfile_scrape_error == 1` at design time.** The textfile collector path exists but is failing to read. Diagnose and fix independently; doing so unlocks the reboot-required follow-up.

---

## Plan self-review

**Spec coverage:** Critical (5 rules), warning (4 — minus the dropped container-restart-loop, with rationale), info (10 host + 5 peepbot). Severity model and null-receiver routing covered in tasks 1–2. Smoke-test guardrail (task 7). Validation pathway (task 8). Out-of-scope items listed verbatim from spec.

**Placeholder scan:** No TBDs. Every expression is concrete. The container-restart-loop omission is explained where the spec rule lived.

**Type consistency:** Rule UIDs are stable across tasks (no renames between definition and verification). Labels (`severity`, `component`) follow the convention from existing rules. Datasource UIDs (`prometheus`, `loki`, `__expr__`) are spelled consistently.
