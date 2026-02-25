terraform {
  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.0"
    }
  }

  backend "gcs" {
    bucket = "tf-state-portainer"
    prefix = "github"
  }
}

provider "github" {
  token = var.github_token
  owner = var.github_owner
}
