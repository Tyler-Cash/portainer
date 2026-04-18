# Backups Stack

Restic backup to Google Cloud Storage using a dedicated service account.

## GCS Service Account

The backup uses service account `restic-backup@homelab-backups.iam.gserviceaccount.com`,
scoped to `roles/storage.objectAdmin` on the `homelab-backups-k8s` bucket only.

## Rotating the GCS Credentials

Run all of these steps in your terminal. Do not paste the key into any tool,
script, or chat — handle it only in your shell.

### 1. Create a new key

```bash
gcloud iam service-accounts keys create ~/restic-backup-key.json \
  --iam-account restic-backup@homelab-backups.iam.gserviceaccount.com \
  --project homelab-backups
```

### 2. Update the secret

```bash
# Base64-encode the key and write directly into the secret via SOPS
GCS_CREDS=$(base64 -w 0 ~/restic-backup-key.json) \
  sops --set '["data"]["GCS_CREDS"] '"$(base64 -w 0 ~/restic-backup-key.json | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read().strip()))')" \
  stacks/backups/.env.secret
```

Or use the interactive editor (recommended — nothing touches the shell):

```bash
task edit STACK=backups
```

Paste the base64-encoded key as the value of `GCS_CREDS`:

```bash
base64 -w 0 ~/restic-backup-key.json
```

### 3. Delete the old key from GCP

List existing keys to find the old one:

```bash
gcloud iam service-accounts keys list \
  --iam-account restic-backup@homelab-backups.iam.gserviceaccount.com \
  --project homelab-backups
```

Delete it (replace `KEY_ID`):

```bash
gcloud iam service-accounts keys delete KEY_ID \
  --iam-account restic-backup@homelab-backups.iam.gserviceaccount.com \
  --project homelab-backups
```

### 4. Remove the local key file

```bash
rm ~/restic-backup-key.json
```

### 5. Push to deploy

```bash
git add stacks/backups/.env.secret && git commit -m "chore(backups): rotate GCS service account key" && git push
```
