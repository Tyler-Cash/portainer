# Handover: wire up Peep Bot alert rules

You're picking this up from a prior session. The alert rules are written and
sitting in this directory; they're not yet wired into the running Grafana
instance. Your job is to mount them, verify they load, and add the contact
point + notification policy so they actually page someone.

## Current state

```
stacks/grafana-lgtm/grafana/provisioning/alerting/
├── peepbot.yaml      # 11 alert rules across two groups (critical, warning)
├── TODO.md           # follow-up alerts blocked on upstream metric work
└── HANDOVER.md       # this file
```

The Grafana service is provisioned via `stacks/grafana-lgtm/docker-compose.yml`
using the `grafana/otel-lgtm` bundled image. Dashboards are already mounted
at `/otel-lgtm/grafana/conf/provisioning/dashboards/`. Alerts use the same
mechanism but at `…/provisioning/alerting/`.

The alert rules target the `peepbot` Grafana folder (created by the dashboard
provisioning), with `prometheus` and `loki` datasource UIDs. Both are
confirmed to exist in the running instance.

## What needs doing

### 1. Mount the alerting directory (required)

Edit `stacks/grafana-lgtm/docker-compose.yml`, in the `grafana-lgtm` service's
`volumes:` block (around line 196–199, where the dashboards are mounted), add:

```yaml
- ./grafana/provisioning/alerting/peepbot.yaml:/otel-lgtm/grafana/conf/provisioning/alerting/peepbot.yaml:ro
```

Mount the file (not the directory) so `HANDOVER.md` and `TODO.md` aren't
exposed inside the container and Grafana doesn't choke trying to parse them
as YAML.

### 2. Apply and verify

Standard portainer redeploy flow for this stack (see `Taskfile.yml` /
`README.md` at the repo root — there's usually a `task` target, or
`docker compose up -d` on the host).

After redeploy, verify in Grafana UI:

- Navigate to **Alerting → Alert rules**. The "Peep Bot" folder should show
  two groups: `peepbot-critical` (6 rules) and `peepbot-warning` (5 rules).
- Each rule should evaluate to a state (`Normal`, `Pending`, or
  `Firing` — not `Error`). An `Error` state usually means a label selector
  doesn't match anything; check the Loki/Prometheus query manually in
  Explore.
- The `peepbot-discord-10062` rule is Loki-backed; the rest are Prometheus.

### 3. Contact point + notification policy (required for the alerts to do anything)

This was deliberately scoped out of the prior session because the
destination (Slack channel, email, PagerDuty, ntfy, etc.) is operational
context that belongs to you, not me. Pick one and create a sibling file:

```yaml
# stacks/grafana-lgtm/grafana/provisioning/alerting/contact-points.yaml
apiVersion: 1
contactPoints:
  - orgId: 1
    name: peepbot-default
    receivers:
      - uid: peepbot-default-receiver
        type: <slack|email|webhook|...>
        settings:
          # provider-specific
        secureSettings:
          # secrets — pull from env or .env.secret, don't inline
```

And a policy that routes the alerts:

```yaml
# stacks/grafana-lgtm/grafana/provisioning/alerting/notification-policies.yaml
apiVersion: 1
policies:
  - orgId: 1
    receiver: peepbot-default
    group_by: [alertname, component]
    routes:
      - receiver: peepbot-default
        matchers:
          - severity = critical
        group_wait: 30s
        group_interval: 5m
        repeat_interval: 1h
      - receiver: peepbot-default
        matchers:
          - severity = warning
        group_wait: 2m
        group_interval: 10m
        repeat_interval: 4h
```

Mount both files the same way as `peepbot.yaml`. Secrets (Slack webhook URL,
SMTP password, etc.) should come from the existing `.env.secret` pattern
this stack already uses — see the `GRAFANA_ADMIN_PASSWORD` env var in
`docker-compose.yml` for the convention.

### 4. Smoke test

Easiest end-to-end check: temporarily lower a threshold so an alert fires,
redeploy, confirm the notification arrives, revert the threshold.

Good candidate is `peepbot-jvm-heap` — drop `params: [0.85]` to `[0.01]` and
it'll fire almost immediately if the JVM has any heap allocated. Don't pick
the `peepbot-discord-10062` Loki rule; matching log lines may genuinely not
exist, making it impossible to distinguish "alert wired up but no firing
condition" from "wiring broken".

## Things to know

- **Don't edit `peepbot.yaml` to add the followup alerts in `TODO.md`.**
  Those are blocked on changes to the peep-bot backend (exporting
  `resilience4j_*` metrics, adding a Postgres exporter, etc.). Reread
  `TODO.md` before assuming anything is in scope.

- **Datasource UIDs are `prometheus` and `loki`.** They're hardcoded in
  every rule. If someone later changes the datasource provisioning UIDs,
  this file breaks silently — Grafana shows the rules in `Error` state.

- **Folder UID is `peepbot`.** Set by `peepbot.yaml` in the
  `provisioning/dashboards/` directory. The alert rules' `folder: Peep Bot`
  field has to match the *title* of that folder — if the dashboard
  provisioning is ever renamed, update both.

- **The otel-lgtm image bundles a specific Grafana version.** Provisioning
  YAML schemas occasionally shift between major versions. The current
  ruleset uses the v1 `apiVersion` syntax with `threshold` expression nodes,
  which is stable from Grafana 9 onward. If you upgrade the image tag and
  rules go red, check the changelog for the alert provisioning schema.

- **Don't commit a working `contact-points.yaml` with secrets inline.**
  The repo's pattern is `.env.secret` + variable substitution. Follow it.

## When you're done

Update `TODO.md` to remove any items you addressed. If you add new
followups (e.g. flaky alerts that need tuning), append them there.
The prior session intentionally left this file in place — it's
the inventory of what's still missing.
