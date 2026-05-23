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
  while IFS= read -r line; do
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
  done < <(python3 -c "
import sys, yaml, json
data = yaml.safe_load(open('$f'))
for group in data.get('groups', []):
    for rule in group.get('rules', []):
        for d in rule.get('data', []):
            if d.get('datasourceUid') in ('prometheus', 'loki'):
                expr = (d.get('model') or {}).get('expr')
                if expr:
                    print(json.dumps({'rule': rule['uid'], 'ds': d['datasourceUid'], 'expr': expr}))
")
done

echo "---"
echo "$((total - fail))/$total queries OK ($fail failed)"
exit "$fail"
