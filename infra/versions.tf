terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
  }

  # State lives in S3 with native locking (Terraform >= 1.10 — no DynamoDB lock
  # table needed). The bucket is created once by bootstrap/bootstrap.sh; it is the
  # only resource in this project not managed by Terraform, because something has
  # to hold the state before state exists.
  backend "s3" {
    bucket       = "wick-tfstate-707938860881"
    key          = "wick/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region  = var.region
  profile = var.aws_profile

  default_tags {
    tags = {
      project     = "wick"
      environment = var.environment
      managed_by  = "terraform"
      repo        = "github.com/rogerjeasy/wick"
    }
  }
}
