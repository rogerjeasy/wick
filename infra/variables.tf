variable "region" {
  description = "AWS region. us-east-1 has the widest Bedrock and AgentCore availability, and Ring and Alexa+ are US-centric. See docs/WICK-TECHNICAL.md on data residency for the production caveat."
  type        = string
  default     = "us-east-1"
}

variable "aws_profile" {
  description = "Local AWS CLI profile. CI authenticates by OIDC instead and leaves this null."
  type        = string
  default     = null
}

variable "environment" {
  description = "dev (yours) or home (Margaret's, carrying real personal data about a real person). There is no staging."
  type        = string
  default     = "dev"

  validation {
    condition     = contains(["dev", "home"], var.environment)
    error_message = "environment must be dev or home. There is deliberately no staging (docs/WICK-TECHNICAL.md §13.3)."
  }
}

variable "consent_page_url" {
  description = "Where the Ring account-link redirect sends the user. A real page explaining what Wick will and will not be able to do."
  type        = string
  default     = "https://rogerjeasy.github.io/wick/link.html"
}

variable "snapshot_retention_days" {
  description = "INV-3. Door imagery is discarded within this window, enforced by bucket lifecycle rather than application code."
  type        = number
  default     = 1
}

variable "ring_scope" {
  description = "OAuth scope requested from Ring. ava.v1:read is currently the only supported value."
  type        = string
  default     = "ava.v1:read"
}
