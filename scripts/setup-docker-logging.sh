#!/usr/bin/env bash
# Configures the Docker daemon to include Docker Compose labels in JSON log output.
# This enables the OTel agent to extract service.name and service.namespace from log metadata.
#
# Run once on the host, then restart Docker: sudo systemctl restart docker
# Note: existing containers must be recreated to pick up the new log format.
set -euo pipefail

DAEMON_JSON="/etc/docker/daemon.json"
COMPOSE_LABELS="com.docker.compose.service,com.docker.compose.project"

if [ ! -f "$DAEMON_JSON" ]; then
  echo "Creating $DAEMON_JSON..."
  echo '{}' | sudo tee "$DAEMON_JSON" > /dev/null
fi

current=$(cat "$DAEMON_JSON")

# Check if labels are already configured
if echo "$current" | grep -q "com.docker.compose.service"; then
  echo "Docker daemon already configured with compose labels."
  exit 0
fi

echo "Updating $DAEMON_JSON to include compose labels in log output..."

updated=$(echo "$current" | python3 -c "
import json, sys
d = json.load(sys.stdin)
d.setdefault('log-driver', 'json-file')
opts = d.setdefault('log-opts', {})
existing_labels = opts.get('labels', '')
new_labels = '$COMPOSE_LABELS'
if existing_labels:
    labels_set = set(existing_labels.split(',')) | set(new_labels.split(','))
    opts['labels'] = ','.join(sorted(labels_set))
else:
    opts['labels'] = new_labels
print(json.dumps(d, indent=2))
")

echo "$updated" | sudo tee "$DAEMON_JSON" > /dev/null
echo "Done. Restart Docker to apply: sudo systemctl restart docker"
echo "Then recreate all containers to pick up the new log format."
