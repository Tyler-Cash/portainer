variable "github_token" {
  description = "GitHub personal access token with repo and admin:org scope"
  type        = string
  sensitive   = true
}

variable "github_owner" {
  description = "GitHub username or organisation that owns the repo"
  type        = string
}

variable "github_repo" {
  description = "Name of the GitHub repository"
  type        = string
  default     = "portainer"
}

variable "portainer_url" {
  description = "Internal URL of the Portainer instance"
  type        = string
}

variable "portainer_token" {
  description = "Portainer API token"
  type        = string
  sensitive   = true
}

variable "portainer_endpoint_id" {
  description = "Portainer Docker environment ID"
  type        = string
}

variable "sops_age_key" {
  description = "age private key used by the runner to decrypt .env.secret files"
  type        = string
  sensitive   = true
}
