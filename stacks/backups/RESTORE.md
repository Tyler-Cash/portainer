# Restoring from Restic Backups

Backups are stored in Google Cloud Storage. Each ZFS dataset gets its own restic repo named `<pool>-<leaf>` (e.g., `ssd/services/plex` -> `ssd-plex`, `hdd/photos` -> `hdd-photos`).

## Setup

Decode the GCS credentials and set the shared variables:

```bash
# Decode GCS credentials (one-time)
task decrypt STACK=backups
grep GCS_CREDS stacks/backups/.env.secret.dec | cut -d= -f2 | base64 -d > /tmp/gcp.json

# Set these for all commands below
export RESTIC_PASSWORD="<from .env.secret>"
export GCS_BASE_URL="<from .env.secret>"
```

Then for each restore, set the dataset you want:

```bash
# Pool and leaf name match the ZFS dataset path: <pool>/<...>/<leaf>
export POOL=ssd
export LEAF=plex
export REPO="${GCS_BASE_URL}:docker-backups/${POOL}-${LEAF}"
```

## Commands

All commands use a throwaway container. Adjust the `-v` mount to point at your restore target.

### List snapshots

```bash
sudo docker run --rm \
  -v /tmp/gcp.json:/gcp.json:ro \
  -e RESTIC_PASSWORD \
  -e GOOGLE_APPLICATION_CREDENTIALS="/gcp.json" \
  restic/restic -r "$REPO" \
  snapshots
```

### Browse files

```bash
sudo docker run --rm \
  -v /tmp/gcp.json:/gcp.json:ro \
  -e RESTIC_PASSWORD \
  -e GOOGLE_APPLICATION_CREDENTIALS="/gcp.json" \
  restic/restic -r "$REPO" \
  ls latest
```

### Restore (full dataset)

```bash
docker stop <container>

sudo docker run --rm \
  -v /ssd/services/plex:/restore \
  -v /tmp/gcp.json:/gcp.json:ro \
  -e RESTIC_PASSWORD \
  -e GOOGLE_APPLICATION_CREDENTIALS="/gcp.json" \
  restic/restic -r "$REPO" \
  restore latest --target /restore -v

docker start <container>
```

### Restore specific files

```bash
sudo docker run --rm \
  -v /tmp/restore:/restore \
  -v /tmp/gcp.json:/gcp.json:ro \
  -e RESTIC_PASSWORD \
  -e GOOGLE_APPLICATION_CREDENTIALS="/gcp.json" \
  restic/restic -r "$REPO" \
  restore latest --target /restore --include "**/vaultwarden" -v
```

### Restore a specific snapshot

```bash
# Pick a snapshot ID from the snapshots list, then:
sudo docker run --rm \
  -v /ssd/services/plex:/restore \
  -v /tmp/gcp.json:/gcp.json:ro \
  -e RESTIC_PASSWORD \
  -e GOOGLE_APPLICATION_CREDENTIALS="/gcp.json" \
  restic/restic -r "$REPO" \
  restore <snapshot_id> --target /restore -v
```

## Retention Policy

- **30 daily** snapshots
- **156 weekly** snapshots (~3 years)

## Notes

- `ssd-services` contains all service data *except* child datasets (plex, ollama). Those have their own repos.
- `ssd-signoz` excludes `clickhouse/` and `zookeeper/` — only config and `signoz.db`.
- `ssd-databases` is mostly empty (all databases are child datasets).
- Ollama is not backed up.
