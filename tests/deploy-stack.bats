#!/usr/bin/env bats
# Tests for scripts/deploy-stack.sh
# Requires: bats-core (https://github.com/bats-core/bats-core)

SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/scripts/deploy-stack.sh"

setup() {
  TEST_DIR="$(mktemp -d)"
  MOCK_BIN="$TEST_DIR/bin"
  CALL_LOG="$TEST_DIR/calls.log"
  mkdir -p "$MOCK_BIN"

  export PATH="$MOCK_BIN:$PATH"
  export PORTAINER_URL="http://portainer.local:9000"
  export PORTAINER_TOKEN="test-token"
  export PORTAINER_ENDPOINT_ID="1"
  unset SOPS_AGE_KEY

  # Create a minimal stack fixture
  mkdir -p "$TEST_DIR/stacks/mystack"
  cat > "$TEST_DIR/stacks/mystack/docker-compose.yml" <<'EOF'
version: '3'
services:
  app:
    image: nginx
EOF

  # Default curl mock: GET returns empty stack list, POST/PUT succeed
  cat > "$MOCK_BIN/curl" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "$CALL_LOG"
# Parse -o output file
output_file=""
prev=""
for arg in "\$@"; do
  [ "\$prev" = "-o" ] && output_file="\$arg"
  prev="\$arg"
done
# GET /api/stacks — return empty list
for arg in "\$@"; do
  if [[ "\$arg" == *"/api/stacks" && "\$arg" != *"create"* && "\$arg" != *"endpointId"* ]]; then
    [ -n "\$output_file" ] && echo '[]' > "\$output_file"
    echo "200"
    exit 0
  fi
done
# POST/PUT — return success
[ -n "\$output_file" ] && echo '{}' > "\$output_file"
echo "200"
EOF
  chmod +x "$MOCK_BIN/curl"

  cd "$TEST_DIR"
}

teardown() {
  rm -rf "$TEST_DIR"
}

# --- Argument / file validation ---

@test "exits with error when no stack name is given" {
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
}

@test "exits with error when compose file does not exist" {
  run bash "$SCRIPT" nonexistent-stack
  [ "$status" -eq 1 ]
  [[ "$output" == *"not found"* ]]
}

# --- Create path (stack does not exist) ---

@test "calls POST to create stack when it does not exist" {
  run bash "$SCRIPT" mystack
  [ "$status" -eq 0 ]
  grep -q "create/standalone/string" "$CALL_LOG"
}

@test "includes stack name in POST body" {
  run bash "$SCRIPT" mystack
  [ "$status" -eq 0 ]
  grep -q "mystack" "$CALL_LOG"
}

@test "prints 'created' on success for new stack" {
  run bash "$SCRIPT" mystack
  [ "$status" -eq 0 ]
  [[ "$output" == *"created"* ]]
}

# Helper: write a curl mock that returns an existing stack on GET and 200 on PUT
make_update_mock() {
  cat > "$MOCK_BIN/curl" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "$CALL_LOG"
# Find the -o output file argument
output_file=""
prev=""
for arg in "\$@"; do
  [ "\$prev" = "-o" ] && output_file="\$arg"
  prev="\$arg"
done
# GET /api/stacks — return existing stack
for arg in "\$@"; do
  if [[ "\$arg" == *"/api/stacks" && "\$arg" != *"create"* && "\$arg" != *"endpointId"* ]]; then
    [ -n "\$output_file" ] && echo '[{"Id":42,"Name":"mystack","Status":1}]' > "\$output_file"
    echo "200"
    exit 0
  fi
done
# PUT — write body to -o file, return 200
[ -n "\$output_file" ] && echo '{}' > "\$output_file"
echo "200"
EOF
  chmod +x "$MOCK_BIN/curl"
}

# --- Update path (stack already exists) ---

@test "calls PUT to update stack when it already exists" {
  make_update_mock
  run bash "$SCRIPT" mystack
  [ "$status" -eq 0 ]
  grep -q "\-X PUT" "$CALL_LOG"
}

@test "includes stack ID in PUT URL when updating" {
  make_update_mock
  run bash "$SCRIPT" mystack
  [ "$status" -eq 0 ]
  grep -q "/api/stacks/42" "$CALL_LOG"
}

@test "prints 'updated' on success for existing stack" {
  make_update_mock
  run bash "$SCRIPT" mystack
  [ "$status" -eq 0 ]
  [[ "$output" == *"updated"* ]]
}

# --- Limited stack handling ---

@test "skips stack with Status 2 without calling PUT" {
  cat > "$MOCK_BIN/curl" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "$CALL_LOG"
output_file=""
prev=""
for arg in "\$@"; do
  [ "\$prev" = "-o" ] && output_file="\$arg"
  prev="\$arg"
done
for arg in "\$@"; do
  if [[ "\$arg" == *"/api/stacks" && "\$arg" != *"create"* && "\$arg" != *"endpointId"* ]]; then
    [ -n "\$output_file" ] && echo '[{"Id":42,"Name":"mystack","Status":2}]' > "\$output_file"
    echo "200"
    exit 0
  fi
done
echo "200"
EOF
  chmod +x "$MOCK_BIN/curl"

  run bash "$SCRIPT" mystack
  [ "$status" -eq 0 ]
  [[ "$output" == *"limited"* ]]
  ! grep -q "\-X PUT" "$CALL_LOG"
}

@test "skips stack when PUT response body contains 'limited'" {
  cat > "$MOCK_BIN/curl" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "$CALL_LOG"
output_file=""
prev=""
for arg in "\$@"; do
  [ "\$prev" = "-o" ] && output_file="\$arg"
  prev="\$arg"
done
for arg in "\$@"; do
  if [[ "\$arg" == *"/api/stacks" && "\$arg" != *"create"* && "\$arg" != *"endpointId"* ]]; then
    [ -n "\$output_file" ] && echo '[{"Id":42,"Name":"mystack","Status":1}]' > "\$output_file"
    echo "200"
    exit 0
  fi
done
[ -n "\$output_file" ] && echo '{"message":"this stack is limited"}' > "\$output_file"
echo "400"
EOF
  chmod +x "$MOCK_BIN/curl"

  run bash "$SCRIPT" mystack
  [ "$status" -eq 0 ]
  [[ "$output" == *"limited"* ]]
}

# --- Secret handling ---

@test "sends empty env array when no .env.secret file" {
  run bash "$SCRIPT" mystack
  [ "$status" -eq 0 ]
  # env:[] should appear in the curl -d payload (jq pretty-prints with a space)
  grep -q '"env": \[\]' "$CALL_LOG"
}

@test "decrypts .env.secret and sends env vars when SOPS_AGE_KEY is set" {
  cat > "$MOCK_BIN/sops" <<'EOF'
#!/usr/bin/env bash
# Simulate sops --decrypt output
echo 'DB_PASSWORD=secret123'
echo 'API_KEY=mykey'
EOF
  chmod +x "$MOCK_BIN/sops"

  touch "$TEST_DIR/stacks/mystack/.env.secret"
  export SOPS_AGE_KEY="AGE-SECRET-KEY-FAKE"

  run bash "$SCRIPT" mystack
  [ "$status" -eq 0 ]
  grep -q "DB_PASSWORD" "$CALL_LOG"
  grep -q "API_KEY" "$CALL_LOG"
}

@test "skips decryption when SOPS_AGE_KEY is not set" {
  # sops should never be called
  cat > "$MOCK_BIN/sops" <<'EOF'
#!/usr/bin/env bash
echo "sops was called unexpectedly" >&2
exit 1
EOF
  chmod +x "$MOCK_BIN/sops"

  touch "$TEST_DIR/stacks/mystack/.env.secret"
  unset SOPS_AGE_KEY

  run bash "$SCRIPT" mystack
  [ "$status" -eq 0 ]
  [[ "$output" != *"sops was called"* ]]
}

@test "strips quotes from secret values" {
  cat > "$MOCK_BIN/sops" <<'EOF'
#!/usr/bin/env bash
echo 'QUOTED="hello world"'
EOF
  chmod +x "$MOCK_BIN/sops"

  touch "$TEST_DIR/stacks/mystack/.env.secret"
  export SOPS_AGE_KEY="AGE-SECRET-KEY-FAKE"

  run bash "$SCRIPT" mystack
  [ "$status" -eq 0 ]
  grep -q "hello world" "$CALL_LOG"
  # Quotes should be stripped from the value
  ! grep -q '"value":"\"hello' "$CALL_LOG"
}

# --- Auth header ---

@test "sends x-api-key header with token" {
  run bash "$SCRIPT" mystack
  [ "$status" -eq 0 ]
  grep -q "x-api-key: test-token" "$CALL_LOG"
}
