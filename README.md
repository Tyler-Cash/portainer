# Portainer Stack Management

Docker Compose stack definitions for services deployed via Portainer on `portainer.tylercash.dev`.

## Stacks

| Stack | Description |
|-------|-------------|
| `backups` | Backup services |
| `clawbot` | Clawbot application |
| `home-assistant` | Home Assistant with mDNS repeater and UDP proxy |
| `media` | Media services |
| `n8n` | n8n workflow automation |
| `peepbot` | Peepbot application |
| `romm` | ROM management |
| `unifi` | UniFi network controller |

## Repository Structure

```
stacks/<name>/docker-compose.yml    # Compose definition for each stack
stacks/<name>/.env.secret           # SOPS-encrypted secret env vars (optional)
hooks/pre-commit                    # Git hook preventing unencrypted secret commits
Taskfile.yml                        # Task runner definitions
.sops.yaml                         # SOPS encryption config (age key recipients)
```

## Prerequisites

- [Task](https://taskfile.dev/) — task runner
- [SOPS](https://github.com/getsops/sops) — secret encryption/decryption
- [age](https://github.com/FiloSottile/age) — encryption backend used by SOPS

Run `task setup` to verify all prerequisites are installed and configure the pre-commit hook.

## Secret Management

Secrets are managed with SOPS + age encryption. Sensitive environment variables live in `.env.secret` files (SOPS-encrypted). Decrypted versions use the `.dec` suffix and are gitignored.

**Never modify `.env.secret` files directly** — use `task edit STACK=<name>` to edit them safely through SOPS.

A pre-commit hook blocks commits containing unencrypted `.env.secret` files.

## CI/CD — Deploying to Portainer

Stacks are deployed automatically on push to `master` via a GitHub Actions workflow. Because Portainer is not internet-facing, a **self-hosted runner** on the same host handles all deployment API calls.

### Architecture

```
git push → GitHub Actions → self-hosted runner (homelab) → Portainer API (internal)
```

### 1. Provision the GitHub repo with Terraform

The `terraform/` directory manages repository secrets and branch protection via the [GitHub Terraform provider](https://registry.terraform.io/providers/integrations/github/latest).

State is stored in Google Cloud Storage. The GCS bucket must exist before running `terraform init` — create it once manually:

```bash
gcloud storage buckets create gs://tf-state-portainer \
  --location=australia-southeast1 \
  --uniform-bucket-level-access
```

Then apply the Terraform config. Ensure GCS credentials are configured first (`gcloud auth application-default login`).

You'll need four credentials — create them as follows before running `task terraform-init`:

**GitHub token** (`github_token`)
1. Go to GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens
2. Click **Generate new token**
3. Set repository access to this repo only
4. Under **Repository permissions**, grant:
   - **Secrets** → Read and write
   - **Administration** → Read and write *(required for branch protection)*
   - **Actions** → Read
5. Copy the generated `github_pat_...` token

**Portainer API token** (`portainer_token`)
1. Log in to Portainer → click your username (top right) → **My account**
2. Scroll to **Access tokens** → **Add access token**
3. Give it a name (e.g. `terraform`) and copy the `ptr_...` token

**Portainer endpoint ID** (`portainer_endpoint_id`)
1. In Portainer, go to **Environments**
2. Click on your Docker environment
3. The ID is in the URL: `.../endpoints/`**1**`/...`

**SOPS age key** (`sops_age_key`)
```bash
cat ~/.config/sops/age/keys.txt
# Copy the line starting with AGE-SECRET-KEY-...
```

Once you have all four, run:

```bash
task terraform-init   # prompts for each value, writes terraform/terraform.tfvars
task terraform-apply  # runs terraform init + apply
```

This creates the four Actions secrets (`PORTAINER_URL`, `PORTAINER_TOKEN`, `PORTAINER_ENDPOINT_ID`, `SOPS_AGE_KEY`) and enforces the `test` status check on `master`.

### 2. Set up the self-hosted runner

The runner is a Portainer stack in `stacks/github-runner/`. It uses a custom image with `sops`, `age`, `jq`, and `bats` pre-installed.

**First-time bootstrap** (chicken-and-egg — deploy manually once):

```bash
# Write .env.secret.dec using the GitHub PAT from terraform/terraform.tfvars:
task runner-env

# Then start the runner:
cd stacks/github-runner
docker compose --env-file .env.secret.dec up -d --build
```

After this first deploy the runner registers itself with GitHub and will pick up future jobs automatically. Subsequent changes to the `github-runner` stack can be deployed via the normal GitOps pipeline.

### 3. Deploy all stacks (first time)

The deploy workflow only triggers on changed files. For the initial deploy, run the script manually from the homelab host:

```bash
export PORTAINER_URL=https://portainer.tylercash.dev
export PORTAINER_TOKEN=<your-token>
export PORTAINER_ENDPOINT_ID=<id>
export SOPS_AGE_KEY=$(cat ~/.config/sops/age/keys.txt)

for stack in stacks/*/; do
  bash scripts/deploy-stack.sh "$(basename "$stack")"
done
```

## Common Commands

| Command | Description |
|---------|-------------|
| `task terraform-init` | Interactively generate `terraform/terraform.tfvars` |
| `task terraform-apply` | Run `terraform init` + `apply` |
| `task runner-env` | Write `stacks/github-runner/.env.secret.dec` from `terraform/terraform.tfvars` |
| `task setup` | First-time setup: installs pre-commit hook, checks for sops/age |
| `task encrypt` | Encrypt all `.env.secret.dec` → `.env.secret` |
| `task decrypt` | Decrypt all `.env.secret` → `.env.secret.dec` |
| `task edit STACK=<name>` | Edit a stack's secrets via SOPS |
| `task status` | Show encryption status of all secret files |
| `task clean` | Remove all decrypted `.dec` files |
| `task hook` | Install the pre-commit hook |
