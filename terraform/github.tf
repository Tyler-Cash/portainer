data "github_repository" "this" {
  name = var.github_repo
}

# --- Actions secrets ---

resource "github_actions_variable" "portainer_url" {
  repository    = data.github_repository.this.name
  variable_name = "PORTAINER_URL"
  value         = var.portainer_url
}

resource "github_actions_secret" "portainer_token" {
  repository      = data.github_repository.this.name
  secret_name     = "PORTAINER_TOKEN"
  plaintext_value = var.portainer_token
}

resource "github_actions_variable" "portainer_endpoint_id" {
  repository    = data.github_repository.this.name
  variable_name = "PORTAINER_ENDPOINT_ID"
  value         = var.portainer_endpoint_id
}

resource "github_actions_secret" "sops_age_key" {
  repository      = data.github_repository.this.name
  secret_name     = "SOPS_AGE_KEY"
  plaintext_value = var.sops_age_key
}

# --- Branch protection ---

resource "github_branch_protection" "master" {
  repository_id = data.github_repository.this.node_id
  pattern       = "master"

  required_status_checks {
    strict   = true
    contexts = ["test"]
  }

  enforce_admins = false
  allows_force_pushes = true
}
