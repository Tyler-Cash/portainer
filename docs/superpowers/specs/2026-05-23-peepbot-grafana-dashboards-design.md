# Peep Bot Grafana Dashboards — Design

**Date:** 2026-05-23
**Status:** Draft (awaiting review)
**Author:** tcash (with Claude)

## Goal

Build a set of seven Grafana dashboards for peep-bot, provisioned as JSON via the `grafana/otel-lgtm` bundle in this repo. The dashboards must let you (a) see firing alerts and golden signals at a glance and (b) drill into any subsystem (HTTP API, Discord listener, scheduled jobs, data layer, JVM, external deps) without leaving Grafana.

This is greenfield — there are no peep-bot dashboards today.

## Non-goals

- Authoring alert rules. The Overview's alert-list panel will render whatever Grafana-managed alert rules exist; defining the rules themselves is a follow-up.
- Profiling. Pyroscope is available but peep-bot is not currently profiled. Not in scope.
- Frontend (Next.js) RUM dashboards. Server-side only.
- Migrating SigNoz to Grafana, or vice versa.

## Architecture & data plane

peep-bot exports telemetry via OpenTelemetry to the `grafana/otel-lgtm:0.11.10` bundle running in `stacks/grafana-lgtm/`. Verified live:

- **Metrics** — Micrometer (`micrometer-registry-otlp`) → OTLP → Mimir. Datasource UID `prometheus`. Note: **all Micrometer timers export with `_milliseconds` suffix**, not `_seconds`. The bundle's Prometheus datasource is named `prometheus`, uid `prometheus`.
- **Logs** — Logback → OTLP → Loki. Datasource UID `loki`. Loki carries only two labels: `service_name`, `service_instance_id`. Everything else (`trace_id`, `severity_text`, `requestId`, etc.) is structured metadata.
- **Traces** — OTel Java agent → OTLP → Tempo. Datasource UID `tempo`. Tempo's spanmetrics processor emits `traces_spanmetrics_*` and `traces_service_graph_*` in Prometheus — useful for cross-service views, not for service-scoped RED (these series lack `service_name`).

### Standard selector

Every panel scopes via three template variables:

```promql
{service_namespace="peep-bot", service_name=~"$service", deployment_environment_name=~"$env"}
```

- `service_namespace="peep-bot"` is a fixed filter (excludes `otelcol-contrib` and other noise).
- `$service` — multi-value, options `peepbot-backend|peepbot-staging-backend`, default `peepbot-backend`.
- `$env` — multi-value, options `production|staging`, default `production`.

Confirmed live: `service_namespace=peep-bot`, `service_name=peepbot-backend` (and `peepbot-staging-backend`), `deployment_environment_name=production` (and `staging`). No backend change required — peep-bot already sets these.

## Delivery: provisioning via the otel-lgtm bundle

The `grafana/otel-lgtm` image stores Grafana state at `/data/grafana`. Grafana scans `<grafana_dir>/conf/provisioning/dashboards/*.yaml` at startup for dashboard providers.

Mechanism:

1. New repo directory: `stacks/grafana-lgtm/grafana/dashboards/peepbot/` — one JSON per dashboard.
2. New repo file: `stacks/grafana-lgtm/grafana/provisioning/dashboards/peepbot.yaml` — provider config:
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
3. `stacks/grafana-lgtm/docker-compose.yml` gets two new bind mounts on the `grafana-lgtm` service:
   ```yaml
   - ./grafana/dashboards/peepbot:/etc/grafana/provisioning/peepbot:ro
   - ./grafana/provisioning/dashboards/peepbot.yaml:/otel-lgtm/grafana/conf/provisioning/dashboards/peepbot.yaml:ro
   ```
   The exact provisioning path inside the otel-lgtm image is `/otel-lgtm/grafana/conf/provisioning/`; verify before merge by `docker exec grafana-lgtm find / -name "provisioning" -type d 2>/dev/null`.
4. Stable UIDs hand-assigned per dashboard (`peepbot-overview`, `peepbot-http`, …) so cross-dashboard links survive re-provisioning.
5. Folder UID `peepbot`, title `Peep Bot`.
6. `allowUiUpdates: false` — edits in the UI revert on next provisioner sweep. Source of truth is git.

## Template variables (shared by all seven dashboards)

| Var | Type | Datasource query | Default | Multi |
|---|---|---|---|---|
| `$datasource` | datasource | `prometheus` | `prometheus` | no |
| `$service` | query | `label_values(up{service_namespace="peep-bot"}, service_name)` | `peepbot-backend` | yes |
| `$env` | query | `label_values(up{service_namespace="peep-bot"}, deployment_environment_name)` | `production` | yes |

(`up` is a safe label-discovery target; substitute `application_started_time_milliseconds` if `up` doesn't carry these labels in OTLP-derived series — to be verified once the first dashboard is loaded.)

## The seven dashboards

Panel sizing assumes Grafana's 24-column grid.

### 1. Overview (`peepbot-overview`)

Landing page. Layout matches the sketch you approved:

| Row | Panels |
|---|---|
| Alerts | One full-width `alertlist` panel, height 8. Filter: `state=firing`, label match `service_namespace=peep-bot`. Empty state: "No firing alerts" (good). |
| Golden signals | Four `stat` panels (6 cols each, height 4) showing `Req/s`, `Error %`, `p95 (ms)`, `CPU`. |
| Service-up | Four `stat` panels (6 cols each, height 3): `backend`, `postgres`, `otel-collector`, `frontend` (frontend slot is a placeholder until RUM is wired — show a "Not yet wired" empty-state). |
| Dashboards | One `dashlist` panel, full width, height 6. Filter: `tag=peepbot`. Renders the other six as button-like cards. |

Panel queries:

- Req/s: `sum(rate(http_server_requests_milliseconds_count{service_namespace="peep-bot", service_name=~"$service", deployment_environment_name=~"$env"}[5m]))`
- Error %: `100 * sum(rate(http_server_requests_milliseconds_count{service_namespace="peep-bot", service_name=~"$service", deployment_environment_name=~"$env", outcome=~"SERVER_ERROR|CLIENT_ERROR"}[5m])) / clamp_min(sum(rate(http_server_requests_milliseconds_count{service_namespace="peep-bot", service_name=~"$service", deployment_environment_name=~"$env"}[5m])), 1)`
- p95 (ms): `histogram_quantile(0.95, sum by (le) (rate(http_server_requests_milliseconds_bucket{service_namespace="peep-bot", service_name=~"$service", deployment_environment_name=~"$env"}[5m])))`
- CPU: `process_cpu_usage{service_namespace="peep-bot", service_name=~"$service", deployment_environment_name=~"$env"}` (unit `percentunit`, thresholds 0.5/0.8)
- Service-up backend: `application_ready_time_milliseconds{service_namespace="peep-bot", service_name=~"$service", deployment_environment_name=~"$env"} > 0`
- Service-up postgres: until the postgres receiver is fixed, derive from HikariCP: `hikaricp_connections{service_namespace="peep-bot", service_name=~"$service", deployment_environment_name=~"$env"} > 0`. Replace with `postgresql_up` once the OTel postgres receiver is producing.
- Service-up otel-collector: `up{job="otel-agent"}` if a self-scrape exists, else the `otelcol_process_uptime_seconds` metric. Verify at build time.

All four stat panels use sparkline background, color thresholds (green/yellow/red), and `Refresh: 30s`.

Dashboard tags: `peepbot`, `overview`.

### 2. HTTP API RED (`peepbot-http`)

Per-endpoint RED, status-code mix, security-filter signal.

Rows:
1. **Top-line RED** — three timeseries (req/s, error %, p95 ms), each grouped by `uri`. `topk(10, ...)`.
2. **Per-endpoint table** — `uri`, req/s, error %, p50/p95/p99 ms, sorted by error % desc. Drill-down link: open Tempo Explore with `{ service.name="peepbot-backend" service.namespace="peep-bot" http.route="<uri>" }` (Tempo trace search uses `service.name`, not the underscore form).
3. **Status-code breakdown** — stacked area by `status` (2xx/3xx/4xx/5xx via `outcome` label).
4. **Top 5 failing endpoints** — bar gauge, `topk(5, sum by (uri)(rate(http_server_requests_milliseconds_count{...,outcome=~"SERVER_ERROR|CLIENT_ERROR"}[5m])))`.
5. **OAuth2 login funnel** — Loki count panels for `/oauth2/authorization/discord` → `/login/oauth2/code/discord` → "session created" log lines. Three stat panels in a row.
6. **Security filter chain** — req/s and latency from `spring_security_filterchains_*`, with one panel dedicated to `spring_security_filterchains_RateLimitFilter_*_total` since rate-limit blocking is operationally important.

Dashboard tags: `peepbot`, `http`.

### 3. Discord Listener Health (`peepbot-discord`)

The peep-bot–specific dashboard. **This dashboard is gap-heaviest** — half its panels need prerequisite instrumentation (see Prerequisites). Build all panels now; the gated ones render flat lines until the prereqs land.

Rows:
1. **3-second budget compliance** *(gated on Prereq A)* — single stat: `1 - (sum(rate(lifecycle_listener_invoke_milliseconds_bucket{le="3000", service_namespace="peep-bot", service_name=~"$service"}[5m])) / sum(rate(lifecycle_listener_invoke_milliseconds_count{service_namespace="peep-bot", service_name=~"$service"}[5m])))`. Threshold red ≥ 0.1%. Plus a histogram heatmap of `lifecycle_listener_invoke_milliseconds_bucket` with a horizontal red line at 3000ms.
2. **Listener executor pool** *(gated on Prereq B)* — four panels in a row: `executor_pool_size_threads{name="discordListenerExecutor"}`, `executor_active_threads{...}`, `executor_queued_tasks{...}`, `executor_completed_tasks_total{...}` (rate).
3. **`UNKNOWN_INTERACTION` (10062) errors** *(gated on Prereq C)* — timeseries of `rate(discord_interaction_error_total{code="UNKNOWN_INTERACTION"}[5m])`. Fallback panel using Loki count of `ErrorResponseException` log lines with `10062` substring, scoped to peep-bot — works today.
4. **Discord HTTP latency & error rate** — uses `discord_http_milliseconds_*` (this is `DiscordOkHttpObservationInterceptor`). p50/p95/p99 timeseries + error-rate bar gauge.
5. **Button / modal interaction latency** — p95 of `discord_button_interaction_milliseconds_*` and `discord_modal_interaction_milliseconds_*`. These exist today.
6. **Per-operation Discord RED table** — rows are observation names (`discord_channel_*`, `discord_message_*`, `discord_role_*`, `discord_archive_channel`, etc.). Columns: rate, error %, p95. Built from the `@Observed`-derived `<name>_milliseconds_*` family.
7. **JDA gateway** *(gated on Prereq D)* — `discord_gateway_ping_milliseconds` gauge + `discord_gateway_reconnect_total` rate. Until Prereq D lands, show a single stat "JDA gateway: not instrumented" empty-state panel.

Dashboard tags: `peepbot`, `discord`.

### 4. Jobs & Schedulers (`peepbot-jobs`)

Note: peep-bot does **not** use Spring Batch. All background work is `@Scheduled` + ShedLock.

Rows:
1. **Scheduled tasks RED** — per-method `tasks_scheduled_execution_milliseconds_*`. Group by the scheduled-method label (verify at build time which label name Spring emits; likely `class` + `method` or a single `name`). Rate, error % (`exception`/`outcome` labels), p95.
2. **Lifecycle dispatcher** — `rate(event_lifecycle_published_total[5m])` grouped by `type` (e.g. `EventCreated`, `EventCancelled`). Stacked area.
3. **Stuck listeners gauge** — `event_lifecycle_listener_stuck{service_namespace="peep-bot", service_name=~"$service"}` as a stat per `listener`. Threshold red ≥ 1.
4. **Retry poller activity** *(today: derived from existing observation)* — `rate(lifecycle_listener_invoke_milliseconds_count{listener_name=~".+", service_namespace="peep-bot", service_name=~"$service"}[5m])` grouped by `listener_name`. Watch cardinality of `event_id` label (high-cardinality — exclude from group-by).
5. **TfNSW poller** *(partially gated on Prereq E)* — until the poller exposes its own counter, use Loki: count of "TfNSW noteworthy" log lines per hour as a stat. Once Prereq E lands, swap to `rate(tfnsw_poller_runs_total[5m])` + a success/error split.

Dashboard tags: `peepbot`, `jobs`.

### 5. Data Layer (`peepbot-data`)

Built from HikariCP + `datasource-micrometer` until the OTel postgres receiver is fixed (Prereq F).

Rows:
1. **HikariCP pool** — five stat panels in a row: `hikaricp_connections_active`, `hikaricp_connections_idle`, `hikaricp_connections_pending` (threshold red ≥ 1), `hikaricp_connections_max`, `hikaricp_connections_timeout_total` (rate, red ≥ 0).
2. **Connection wait + usage** — p95 timeseries of `hikaricp_connections_acquire_milliseconds_bucket`, `hikaricp_connections_usage_milliseconds_bucket`, `hikaricp_connections_creation_milliseconds_bucket`.
3. **JDBC query timing** — `histogram_quantile(0.95, sum by (le)(rate(jdbc_query_milliseconds_bucket{service_namespace="peep-bot"}[5m])))`. Plus connection-acquired / commit / rollback rate.
4. **Per-repository latency** — table from `spring_data_repository_invocations_milliseconds_*` grouped by `repository`, columns: rate, error %, p95.
5. **Sessions** — `tomcat_sessions_active_current`, `tomcat_sessions_created_total` (rate), `tomcat_sessions_rejected_total` (rate, red ≥ 0). Anonymous-session-skip gauge *(gated on Prereq G)*.
6. **Postgres (server-side)** *(entire row gated on Prereq F)* — placeholder panels titled "Postgres OTel receiver not yet emitting — see prereq F". Once F lands: `postgresql_connections`, `postgresql_db_size`, `postgresql_blocks_hit` vs `_blocks_read` (cache hit ratio), `postgresql_commits_total` vs `_rollbacks_total`.

Dashboard tags: `peepbot`, `data`.

### 6. JVM & Host (`peepbot-jvm`)

Rows:
1. **Heap** — `jvm_memory_used_bytes{area="heap"}` stacked by `id` vs `jvm_memory_max_bytes{area="heap"}`. Plus heap utilization stat (used/max %).
2. **Non-heap** — same shape for `area="nonheap"`.
3. **GC** — `rate(jvm_gc_pause_milliseconds_count[5m])` by `action`+`cause`, `histogram_quantile(0.99, sum by (le)(rate(jvm_gc_pause_milliseconds_bucket[5m])))`, `rate(jvm_gc_memory_allocated_bytes_total[5m])`. The `jvm_gc_overhead` gauge as a stat with red ≥ 0.1.
4. **Threads** — `jvm_threads_live`, `jvm_threads_daemon`, `jvm_threads_peak`, `jvm_threads_started_total` (rate). Plus a `jvm_threads_states` stacked timeseries by `state`.
5. **Process** — `process_files_open` / `process_files_max`, `process_cpu_usage`, `system_load_average_1m`, `process_uptime_milliseconds`.
6. **Container** — from the otel-agent's `docker_stats` receiver: container CPU / memory / network for the `peepbot-backend` container. Scope via the docker container label.

Dashboard tags: `peepbot`, `jvm`.

### 7. External Dependencies (`peepbot-deps`)

Rows:
1. **Outbound HTTP RED** — `http_client_requests_milliseconds_*` grouped by `uri` host (use `client_name` or `method` label depending on what Spring emits; verify at build). Rate, error %, p95.
2. **Discord REST API** — uses `discord_http_milliseconds_*`. Latency p50/p95/p99 + rate. Already-instrumented via `DiscordOkHttpObservationInterceptor`.
3. **TfNSW** — `tfnsw_live_traffic_major_events_milliseconds_*` and `_hazards_*` (these are `@Observed` — render flat until exercised; do not block the dashboard on data presence). Circuit-breaker state for `name="tfnsw"` *(gated on Prereq H)*.
4. **Immich** — `immich_*_milliseconds_*` family per the `@Observed` set (`create-album`, `upload-asset`, etc.). p95 + rate.
5. **Google Places** — `places_fetch_coords_milliseconds_*`. Plus a stat: number of distinct `event_id` cache fills per day (count distinct, scoped by service).

Dashboard tags: `peepbot`, `deps`.

## Prerequisites

These eight items are peep-bot backend or otel-agent changes that gate specific panels. The dashboards ship with the panels in place; they render flat lines or empty-states until the prereqs land.

| ID | Prereq | Where | Gates |
|---|---|---|---|
| A | Add SLO histogram boundaries to the `lifecycle.listener.invoke` observation so its `_bucket` has a `le=3000` boundary | `PostCommitDispatcher` + a `MeterFilter` bean configuring `serviceLevelObjectives` for that meter name | Discord row 1 |
| B | Switch `discordListenerExecutor` to a `ThreadPoolTaskExecutor` bean **or** bind via `ExecutorServiceMetrics.monitor(meterRegistry, delegate, "discordListenerExecutor")` after `ContextExecutorService.wrap()` | `DiscordListenerExecutorConfig.java` | Discord row 2 |
| C | Add `Counter("discord.interaction.error", "code", ...)` in listener catch blocks where `ErrorResponseException` is caught | All `*Listener.java` files that catch `ErrorResponseException` | Discord row 3 (preferred path; Loki fallback works today) |
| D | Add a `JdaGatewayMetricsBinder` that binds `JDA.getGatewayPing()` as a gauge and listens for `ReconnectedEvent` to bump a counter | New file under `backend/src/main/java/dev/tylercash/event/discord/` | Discord row 7 |
| E | Add a `Counter` and `Timer` around `TfnswWeekBeforePoller.run()` and `GtfsStopsIndex.refresh()` | Those two files | Jobs row 5 (Loki fallback works today) |
| F | Fix the OTel collector's postgres receiver: ensure it's referenced under `service.pipelines.metrics.receivers` and that auth works | `stacks/grafana-lgtm/docker-compose.yml` — the heredoc'd `otel-agent-config.yaml` | Data Layer row 6, Overview "service-up postgres" |
| G | Add `Counter("session.anonymous_skip")` in `AnonymousSkippingSessionRepository` early-return branch | That file | Data Layer row 5 (one panel) |
| H | Add `io.github.resilience4j:resilience4j-micrometer` to peep-bot's `build.gradle` | `backend/build.gradle` | Deps row 3 (one panel) |

None of these block dashboard delivery. They block specific panels from showing real data.

## Testing strategy

1. **Schema validation** — each dashboard JSON is validated via `jsonschema` against Grafana's dashboard schema before commit (CI job, lightweight).
2. **Provisioning smoke test** — after deploying to staging, `curl https://grafana.tylercash.dev/api/search?folderUIDs=peepbot` should return all seven dashboard UIDs.
3. **Query smoke test** — for each dashboard JSON, parse out every PromQL target, run it against the live Mimir via `mcp__grafana__query_prometheus` (or the equivalent HTTP API), assert "no error" (data-presence not required, since some panels are gated). This catches typos and label mismatches before merge.
4. **Manual eyeball** — load each dashboard in the UI, click through the dashboard-list links from Overview, change `$env` from `production` to `staging` and confirm the prefix works.
5. **No alert rule changes** in this work — out of scope.

## Risks

- **Provisioning path inside otel-lgtm.** The image is opinionated about where Grafana state lives. The path `/otel-lgtm/grafana/conf/provisioning/` is inferred from the upstream Dockerfile; if the actual path differs in 0.11.10, the provider yaml won't be picked up. Mitigation: verify with `docker exec` before merging the docker-compose changes; alternatively bind-mount into `/data/grafana/provisioning/` which is the persistent path Grafana also scans on startup.
- **Template variable label discovery.** `up` may not carry `service_namespace` / `service_name` / `deployment_environment_name` when those series are OTLP-derived (Mimir's OTLP ingester surfaces metrics differently from a scrape). If `label_values(up{...}, ...)` returns empty, fall back to `label_values(process_uptime_milliseconds{service_namespace="peep-bot"}, service_name)` which we know carries the labels.
- **Cardinality bombs in `lifecycle_listener_invoke_*`.** The `event_id` MDC key gets attached to spans and may bleed into the metric labels. Any panel that groups by `event_id` will explode cardinality and could OOM Mimir. Mitigation: explicit `MeterFilter` in peep-bot that strips `event_id` from any meter tags (separate small change, listed under Prereq A's umbrella).
- **otel-lgtm image upgrade churn.** Renovate will bump the bundle. Provisioning paths are stable across minor versions but verify on each major.
- **No prod label discipline on logs.** Loki only carries `service_name`. Filtering Overview alerts by environment via Loki is not possible without re-labelling at the otel-agent. Acceptable: alerts are metric-based, not log-based.

## Out-of-scope follow-ups

These are deliberately not in this spec, but obvious next steps:

- Authoring the alert rules that the Overview's alert-list panel will render (`PeepBotHighErrorRate`, `PeepBotListenerSlow`, `PeepBotCircuitBreakerOpen`, `PeepBotPoolSaturation`, `PeepBotStuckListener`).
- A Frontend (Next.js) RUM dashboard once `@vercel/otel` or similar is wired.
- Pyroscope continuous profiling for peep-bot.
- Migrating the spec's prerequisites (A–H) into peep-bot — each one is small enough for a single PR; some are appropriate as one bundled PR ("instrument what's missing for dashboards").

## File layout (what this work will produce)

```
stacks/grafana-lgtm/
├── docker-compose.yml                          # modified: two bind mounts on grafana-lgtm service
├── grafana/
│   ├── dashboards/peepbot/
│   │   ├── overview.json
│   │   ├── http.json
│   │   ├── discord.json
│   │   ├── jobs.json
│   │   ├── data.json
│   │   ├── jvm.json
│   │   └── deps.json
│   └── provisioning/dashboards/
│       └── peepbot.yaml
```

No changes to `stacks/homepage/` — this work is Grafana-only. The Homepage entry for Grafana already exists.

## Decision log

- **Homepage vs Grafana.** "homepage dashboard" interpreted as a Grafana landing page, not a Homepage.io page — alerts/golden signals/dashboard-links aren't a Homepage primitive. Confirmed with user.
- **Seven dashboards in one pass.** User requested all seven up front. Trade-off accepted: more work now, less context switching, no half-built drill-downs.
- **Env-templated, default prod.** User asked for `$env` variable defaulting to prod.
- **JSON sidecar provisioning** (not Terraform, not UI-export). Lives in this repo, versioned alongside the stack it serves.
- **Prerequisites listed but not implemented in this spec.** Dashboards ship even though some panels start flat — preserves the "all seven now" decision without coupling to peep-bot PRs.
