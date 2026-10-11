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

variable "pairing_url_base" {
  description = "Address shown on the TV's pairing screen; `/?pair=<code>` is appended. Empty means the family app's own CloudFront address. Set it when a shorter domain fronts the family app. §4.2."
  type        = string
  default     = ""
}

variable "household_id" {
  description = "The household the ops console's status page counts rows for (services/edge-ring/lambda/status.mjs). Nothing else reads it: the MCP server, pairing and the television take a household from a token, a ring takes it from the doorbell that rang (services/agent/src/store/ringDevices.ts), and the weekly Narrator writes for every household with a television."
  type        = string
  default     = "margaret"
}

variable "family_name" {
  description = "The family member as the resident knows them, used on the television: \"What Sarah sees\", \"Sarah can see this.\" Empty means \"your family\"."
  type        = string
  default     = "Sarah"
}

variable "household_time_zone" {
  description = "The household's IANA time zone. The weekly narrative says \"Wednesday evening\" in the resident's time, not UTC (services/agent/src/agents/narrator/weekFacts.ts). Margaret lives in England."
  type        = string
  default     = "Europe/London"
}

variable "demo_accounts" {
  description = "Offer a \"Try the demo\" button that makes an anonymous guest account and a demo home in one click: no email, no password. On for the hackathon, so a judge can try Wick without signing up. A guest is held to the same rules as anyone (AGENTS.md INV-8, INV-9) and guests are made at a bounded rate; turn it off for a deployment that is not a demo."
  type        = bool
  default     = true
}

variable "mcp_issuer_url" {
  description = "S4a. The MCP server's own public URL, baked into its OAuth metadata at startup (auth.ts's createAuthRouter). Set to the real App Runner service_url once known — see infra/mcp.tf's header comment for the two-apply reason it starts empty. Stays stable across redeploys unless the App Runner service itself is destroyed and recreated (a new service gets a new *.awsapprunner.com hostname)."
  type        = string
  default     = "https://tqcu7pa3ip.us-east-1.awsapprunner.com"
}

variable "agent_image_tag" {
  # No default: a missing pin must fail the plan, not quietly roll the live
  # bridge back to whatever `latest` was last pushed as.
  description = "Tag of the wick-agents and wick-live-bridge images in ECR, pinned in images.auto.tfvars. scripts/push-agent-image.sh pushes the git SHA and rewrites that file."
  type        = string
}

variable "chime_slot_event" {
  description = "M1. Which of the app's Ring Chime audio slots the hallway chime plays (configurations.audio.customizable_slots[].event)."
  type        = string
  default     = "ring-appstore-event-1"
}
