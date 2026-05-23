# Homelab Host & Peep-Bot Alert Coverage

**Date:** 2026-05-23
**Status:** Design — pending implementation plan

## Problem

Grafana has 11 alert rules today, all peep-bot specific. There are zero host-level
alerts, despite a rich data set (node-exporter, smartctl across 9 disks, ZFS pool
state for `hdd` and `ssd`, container metrics via OTel). If the host runs out of
disk, a pool degrades, or a drive fails SMART, nothing notifies.

Peep-bot's existing rules are solid for runtime behaviour but go silent if the
app or its OTel pipeline dies — `NoData` resolves rather than escalates.

## Goals

1. Add host-level alarm coverage scoped to a single-host homelab.
2. Introduce a silent `info` severity so "slow but not broken" signals get
   recorded without paging.
3. Close peep-bot gaps where rules currently rely on data continuing to arrive.

## Non-goals

- Wiring up new exporters (backup freshness, Traefik metrics, reboot-required
  textfile script, UPS). Tracked as follow-up — see "Out of Scope" below.
- Reworking notification formatting or contact points.
- Multi-host concerns.

## Severity model

Three tiers, routed by the `severity` label in the notification policy tree.

| Tier | Behaviour | Repeat |
|---|---|---|
| `critical` | Notify Discord, fast | 1h (existing) |
| `warning` | Notify Discord, patient | 4h (existing) |
| `info` | **Silent** — recorded in Grafana UI/history, no notification | n/a |

### Routing change

Add a root-level child route in
`stacks/grafana-lgtm/grafana/provisioning/alerting/notification-policies.yaml`
that matches `severity = info` and routes to a new no-op contact point
(`null-receiver`, type `webhook` pointing at a discard endpoint, or — cleaner —
a contact point with `disableResolveMessage: true` and an unreachable URL that
silently no-ops). Place this route **before** the critical/warning routes with
`continue: false` so info alerts terminate without falling through.

Implementation note for the planner: Grafana's provisioning doesn't expose a
literal "drop" receiver, so the chosen pattern is a webhook receiver pointed at
`http://localhost:1/discard` (TCP-refused; Alertmanager treats it as a delivery
failure but does not retry indefinitely under default settings). Validate this
during implementation; fall back to a separate low-traffic Discord channel if
the discard receiver causes log spam.

## Host alerts

All host rules live in a new file:
`stacks/grafana-lgtm/grafana/provisioning/alerting/homelab.yaml`
in groups `homelab-critical`, `homelab-warning`, `homelab-info`.

Datasource: `prometheus` for everything below unless noted.

Selectors omitted in the table for readability; each rule scopes to
`{job="node-exporter"}` or `{job="smartctl-exporter"}` as appropriate.

### Critical

| UID | Title | Expression | For |
|---|---|---|---|
| `host-down` | Scrape target down ≥5m | `up == 0` | 5m |
| `host-zfs-pool-not-online` | ZFS pool not ONLINE | `max by (zpool) (node_zfs_zpool_state{state=~"degraded\|faulted\|unavail\|suspended\|removed"}) == 1` | 2m |
| `host-smart-failed` | SMART overall-health failed | `smartctl_device_smart_status == 0` | 5m |
| `host-nvme-critical-warning` | NVMe critical warning flag | `smartctl_device_critical_warning_total > 0` | 5m |
| `host-fs-full` | Pool root ≥98% full | `node_filesystem_avail_bytes{mountpoint=~"/\|/hdd\|/ssd"} / node_filesystem_size_bytes{mountpoint=~"/\|/hdd\|/ssd"} < 0.02` | 15m |

Notes:
- `host-down` uses **the generic `up` metric across all scrape targets** so a
  silent peep-bot, node-exporter, navidrome, n8n, smartctl-exporter, grafana, or
  otelcol all surface here. Combined with the new peep-bot `app-down` rule
  below, this replaces the original suggestion of an OOM-kill alert: we alert
  on the *consequence* (something stayed down) instead of the *cause* (OOM
  happened), since a quick OOM-restart isn't actionable.
- `host-fs-full` deliberately restricts `mountpoint` to **pool roots only**
  (`/`, `/hdd`, `/ssd`). ZFS datasets share pool space and their per-dataset
  `avail/size` ratios are misleading — `/hdd/media` reads 100% even when the
  pool has free space. Alerting on the pool root is the truthful signal.
- Current state at design time: `/hdd` is at 99.98%. This rule will fire on
  deploy. That's correct — `/hdd` genuinely needs attention.

### Warning

| UID | Title | Expression | For |
|---|---|---|---|
| `host-fs-90` | Pool root ≥90% full | same as `host-fs-full` with `< 0.10` | 1h |
| `host-smart-sectors-growing` | Reallocated/pending sectors increased | `increase(smartctl_device_attribute{attribute_name=~"Reallocated_Sector_Ct\|Current_Pending_Sector",attribute_value_type="raw"}[24h]) > 0` | 1h |
| `host-nvme-wearout` | NVMe wearout >80% | `smartctl_device_percentage_used_total > 80` | 10m |
| `host-container-restart-loop` | Container restart-loop | `changes(container_*_restarts_total[15m]) > 3` *(exact metric name TBD during implementation — verify against the current cAdvisor/OTel export)* | 5m |

### Info (silent)

| UID | Title | Expression | For |
|---|---|---|---|
| `host-load-high` | Load avg high vs cores | `node_load5 / count by (instance) (node_cpu_seconds_total{mode="idle"}) > 2` | 30m |
| `host-iowait-high` | CPU iowait elevated | `avg by (instance) (rate(node_cpu_seconds_total{mode="iowait"}[5m])) > 0.2` | 30m |
| `host-cpu-temp-warm` | CPU temperature warm | `node_hwmon_temp_celsius > 75` | 30m |
| `host-root-fs-75` | Root fs ≥75% full | `host-fs-full` shape with `< 0.25`, only `mountpoint="/"` | 1h |
| `host-disk-temp-high` | Disk temp high | `smartctl_device_temperature > 55` | 30m |
| `host-memory-pressure` | Available memory <5% | `node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes < 0.05` | 30m |
| `host-swap-used` | Swap >50% used | `(node_memory_SwapTotal_bytes - node_memory_SwapFree_bytes) / node_memory_SwapTotal_bytes > 0.5` | 1h |
| `host-oom-kill` | OOM kill occurred | `increase(node_vmstat_oom_kill[10m]) > 0` | (instant) |
| `host-network-errs` | Network RX/TX errors | `rate(node_network_receive_errs_total[5m]) > 0 or rate(node_network_transmit_errs_total[5m]) > 0` | 10m |
| `host-network-drops` | Network RX/TX drops | `rate(node_network_receive_drop_total[5m]) > 0 or rate(node_network_transmit_drop_total[5m]) > 0` | 10m |

## Peep-bot additions (info)

Appended to the existing `stacks/grafana-lgtm/grafana/provisioning/alerting/peepbot.yaml`
in a new `peepbot-info` group. All `severity: info`, silent.

| UID | Title | Expression | For |
|---|---|---|---|
| `peepbot-app-down` | Peep-bot scrape absent ≥5m | `absent_over_time(application_ready_time_milliseconds{service_namespace="peep-bot"}[5m])` | 5m |
| `peepbot-restart-spike` | JVM restart spike | `changes(process_start_time_seconds{service_namespace="peep-bot"}[1h]) > 2` | (instant) |
| `peepbot-log-error-rate` | Log ERROR rate elevated | Loki: `sum(rate({service_namespace="peep-bot"} \|= "ERROR" [5m])) > 0.5` | 10m |
| `peepbot-listener-failure-rate` | Listener invocation failure ratio | `sum(rate(listener_invocation_total{status="FAILED"}[10m])) / sum(rate(listener_invocation_total[10m])) > 0.05` *(verify metric name during implementation against peep-bot's actual Micrometer exports)* | 10m |
| `peepbot-otel-collector-down` | OTel collector down | `up{job="otelcol-contrib"} == 0` | 5m |

`peepbot-app-down` is deliberately `info`, not critical: a quick restart isn't
actionable, and `host-down` will already catch a 5m absence at higher severity.
This rule earns its keep as a correlation aid — when peep-bot rules show
`NoData`, the info-tier history tells you whether the app or just the metric
was the issue.

Note that `peepbot-app-down` and `host-down` overlap (both fire when peep-bot's
scrape stops). That's intentional — `host-down` pages, `peepbot-app-down` adds
component context to the history.

## Out of scope (follow-up exporters)

These alerts were discussed but data isn't exposed yet. Tracked for a separate
spec:

- **Backup freshness** — no backup metrics scraped. Would want `restic_*` or
  equivalent emitting "last successful run timestamp". Critical-tier when wired
  up. (`ssd/backups` at 100% suggests a backup process is doing *something*
  but we have no visibility into success/failure.)
- **Traefik cert expiry** — Traefik isn't scraped (no `traefik_*` metrics).
  Needs `--metrics.prometheus=true` on Traefik and a scrape config.
  Warning-tier when wired up.
- **`node_reboot_required`** — needs a textfile-collector script writing a
  metric when `/var/run/reboot-required` is present. Warning-tier when wired up.
- **UPS** — none configured; skip unless one is added.

**Independent finding worth flagging:** `node_textfile_scrape_error == 1`
already today. The textfile collector path is mounted but failing to read. Fix
this independently of the alerts spec — it's a precondition for the
reboot-required follow-up.

## Files touched

| File | Change |
|---|---|
| `stacks/grafana-lgtm/grafana/provisioning/alerting/homelab.yaml` | New file. Three rule groups: `homelab-critical`, `homelab-warning`, `homelab-info`. |
| `stacks/grafana-lgtm/grafana/provisioning/alerting/peepbot.yaml` | Append `peepbot-info` group with five new rules. |
| `stacks/grafana-lgtm/grafana/provisioning/alerting/notification-policies.yaml` | Add `severity = info` child route to a silent receiver. |
| `stacks/grafana-lgtm/grafana/provisioning/alerting/contact-points.yaml` | Add `null-receiver` (webhook to discard URL) for info routing. |
| `stacks/grafana-lgtm/docker-compose.yml` | Verify the alerting provisioning dir mount already covers the new `homelab.yaml`; no change expected. |

## Validation

After provisioning reloads:

1. Confirm 15+ new rules visible in Grafana → Alerting (folder: Homelab + Peep Bot).
2. `host-fs-full` should be **firing** (`/hdd` at 99.98%). Use this as the
   smoke test for the critical path.
3. Trigger a synthetic info alert (e.g. temporarily lower `host-load-high`
   threshold to 0) and confirm it reaches `Firing` in the UI **without**
   producing a Discord message.
4. Existing peep-bot rules continue to fire/resolve as before — no regression.

## Open implementation questions

These don't block the design but the planner should resolve them before writing
the implementation plan:

1. **Container restart-loop metric.** The exact metric name from the current
   cAdvisor/OTel export wasn't confirmed during design. Run
   `list_prometheus_metric_names regex=container_.*restart.*` against the live
   Prometheus before finalising `host-container-restart-loop`.
2. **Listener invocation failure ratio.** Confirm `listener_invocation_total`
   (or its actual Micrometer export name and label scheme) exists before
   finalising `peepbot-listener-failure-rate`.
3. **Silent-receiver mechanism.** Confirm the discard-URL webhook approach
   doesn't produce ongoing error logs in Grafana. If it does, fall back to a
   dedicated low-traffic Discord channel.
