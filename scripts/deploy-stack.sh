#!/usr/bin/env bash
# Usage: deploy-stack.sh <stack-name>
# Env: PORTAINER_URL, PORTAINER_TOKEN, PORTAINER_ENDPOINT_ID, SOPS_AGE_KEY
set -euo pipefail

STACK_NAME="$1"
STACK_DIR="stacks/$STACK_NAME"
COMPOSE_FILE="$STACK_DIR/docker-compose.yml"
SECRET_FILE="$STACK_DIR/.env.secret"

# Stacks that should never be deployed via CI (e.g. the runner itself)
SKIP_STACKS=(
  "github-runner"
)
for skip in "${SKIP_STACKS[@]}"; do
  if [ "$STACK_NAME" = "$skip" ]; then
    echo "Skipping stack '$STACK_NAME' — in skip list."
    exit 0
  fi
done

# Redact secrets from any error output
sanitize() {
  local msg="$1"
  for secret in "${PORTAINER_TOKEN:-}" "${SOPS_AGE_KEY:-}"; do
    [ -n "$secret" ] && msg="${msg//$secret/[REDACTED]}"
  done
  echo "$msg"
}

# Validate required env vars (names only, never values)
for var in PORTAINER_URL PORTAINER_TOKEN PORTAINER_ENDPOINT_ID; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: Required environment variable $var is not set"
    exit 1
  fi
done

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "ERROR: $COMPOSE_FILE not found"
  exit 1
fi

# Build env vars array for Portainer API from SOPS-encrypted secrets
ENV_JSON="[]"
if [ -f "$SECRET_FILE" ] && [ -n "${SOPS_AGE_KEY:-}" ]; then
  echo "Decrypting secrets for $STACK_NAME..."
  decrypted=$(SOPS_AGE_KEY="$SOPS_AGE_KEY" sops --decrypt "$SECRET_FILE")
  ENV_JSON=$(echo "$decrypted" | grep -v '^#' | grep '=' | while IFS='=' read -r key val; do
    # Strip surrounding quotes from value if present
    val="${val%\"}"
    val="${val#\"}"
    printf '{"name":"%s","value":"%s"}\n' "$key" "$val"
  done | jq -s '.')
fi

COMPOSE_CONTENT=$(cat "$COMPOSE_FILE")

# Check if stack already exists
echo "Checking if stack '$STACK_NAME' exists..."
RESPONSE_FILE=$(mktemp)
trap 'rm -f "$RESPONSE_FILE"' EXIT

HTTP_CODE=$(curl -s -o "$RESPONSE_FILE" -w "%{http_code}" \
  -H "x-api-key: $PORTAINER_TOKEN" \
  "$PORTAINER_URL/api/stacks")

if [ "$HTTP_CODE" != "200" ]; then
  BODY=$(cat "$RESPONSE_FILE")
  echo "ERROR: Failed to list stacks (HTTP $HTTP_CODE): $(sanitize "$BODY")"
  exit 1
fi

EXISTING=$(jq -r ".[] | select(.Name == \"$STACK_NAME\")" < "$RESPONSE_FILE")

if [ -n "$EXISTING" ]; then
  STACK_ID=$(echo "$EXISTING" | jq -r '.Id')
  STACK_STATUS=$(echo "$EXISTING" | jq -r '.Status')

  if [ "$STACK_STATUS" = "2" ]; then
    echo "Skipping stack '$STACK_NAME' — limited (externally deployed, not managed by Portainer)."
    exit 0
  fi

  echo "Updating existing stack (id=$STACK_ID)..."
  HTTP_CODE=$(curl -s -o "$RESPONSE_FILE" -w "%{http_code}" -X PUT \
    -H "x-api-key: $PORTAINER_TOKEN" \
    -H "Content-Type: application/json" \
    "$PORTAINER_URL/api/stacks/$STACK_ID?endpointId=$PORTAINER_ENDPOINT_ID" \
    -d "$(jq -n \
      --arg content "$COMPOSE_CONTENT" \
      --argjson env "$ENV_JSON" \
      '{stackFileContent: $content, env: $env, prune: false}')")

  if [ "$HTTP_CODE" = "200" ]; then
    echo "Stack '$STACK_NAME' updated."
  else
    BODY=$(cat "$RESPONSE_FILE")
    if echo "$BODY" | grep -qi "limited\|not managed\|cannot be modified"; then
      echo "Skipping stack '$STACK_NAME' — limited: $(sanitize "$BODY")"
      exit 0
    fi
    echo "ERROR: Failed to update '$STACK_NAME' (HTTP $HTTP_CODE): $(sanitize "$BODY")"
    exit 1
  fi
else
  echo "Creating new stack '$STACK_NAME'..."
  HTTP_CODE=$(curl -s -o "$RESPONSE_FILE" -w "%{http_code}" -X POST \
    -H "x-api-key: $PORTAINER_TOKEN" \
    -H "Content-Type: application/json" \
    "$PORTAINER_URL/api/stacks/create/standalone/string?endpointId=$PORTAINER_ENDPOINT_ID" \
    -d "$(jq -n \
      --arg name "$STACK_NAME" \
      --arg content "$COMPOSE_CONTENT" \
      --argjson env "$ENV_JSON" \
      '{name: $name, stackFileContent: $content, env: $env}')")

  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
    echo "Stack '$STACK_NAME' created."
  else
    BODY=$(cat "$RESPONSE_FILE")
    echo "ERROR: Failed to create '$STACK_NAME' (HTTP $HTTP_CODE): $(sanitize "$BODY")"
    exit 1
  fi
fi
