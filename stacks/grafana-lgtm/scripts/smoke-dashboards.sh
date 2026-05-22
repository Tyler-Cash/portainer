#!/usr/bin/env bash
# Smoke-test every PromQL expr in the peepbot dashboards.
# Usage: GRAFANA_TOKEN=<service-account-token> ./smoke-dashboards.sh
# Exit non-zero on any parse error.

set -euo pipefail

GRAFANA_URL="${GRAFANA_URL:-https://grafana.tylercash.dev}"
DASHBOARD_DIR="$(cd "$(dirname "$0")/.." && pwd)/grafana/dashboards/peepbot"

if [[ -z "${GRAFANA_TOKEN:-}" ]]; then
  echo "GRAFANA_TOKEN env var required" >&2
  exit 2
fi

fail=0
total=0
for f in "$DASHBOARD_DIR"/*.json; do
  base="$(basename "$f")"
  exprs=$(jq -r '
    .. | objects
    | select(.expr? != null)
    | select((.datasource.type? // "prometheus") == "prometheus")
    | .expr
  ' "$f")

  while IFS= read -r expr; do
    [[ -z "$expr" ]] && continue
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
      echo "  -> $(echo "$response" | jq -c '.error // .')"
      fail=$((fail + 1))
    fi
  done <<< "$exprs"
done

echo "---"
echo "$((total - fail))/$total queries OK ($fail failed)"
exit "$fail"
