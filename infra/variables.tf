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

variable "ring_operator_link" {
  description = "Serve the old, unauthenticated way to link Ring (GET /ring/authorize and Ring's own POST /ring/token), which links whoever signs in to the operator's household (var.household_id). Off by default: those addresses ask nobody who they are, and a home's organiser now connects Ring from the family app, where they are checked at the start and again at the finish. Turn it on only while setting up the operator's own link, and off again after."
  type        = bool
  default     = false
}

variable "ring_playground_link" {
  description = "Let a home's organiser connect Ring by pasting a token from Ring's Developer Playground — Ring's simulator. On for the hackathon, where the simulator is all that can be shown without a doorbell; the family app says it is the simulator wherever it names the link. Turn it off for a deployment with real doorbells: a pasted token is a developer's tool, not a customer's."
  type        = bool
  default     = true
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

variable "household_time_zone" {
  description = "The time zone a home is read in when it was set up before homes had one of their own. Each home's own zone is `timeZone` on its META row (packages/contracts/src/clock.ts), given when it is set up; only the assistant agent's fallback still reads this."
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
  # Null: the tag is read from /wick/images/agents (images.tf), which CI
  # writes after each push. Set it only to override that from a laptop.
  description = "Emergency override of the wick-agents and wick-live-bridge image tag. Unset, the tag in SSM parameter /wick/images/agents is deployed."
  type        = string
  default     = null
}

variable "mcp_image_tag" {
  description = "Emergency override of the wick-mcp-server image tag. Unset, the tag in SSM parameter /wick/images/mcp-server is deployed."
  type        = string
  default     = null
}

variable "chime_slot_event" {
  description = "M1. Which of the app's Ring Chime audio slots the hallway chime plays (configurations.audio.customizable_slots[].event)."
  type        = string
  default     = "ring-appstore-event-1"
}

variable "alarm_email" {
  description = "An address to email when an alarm fires (infra/alarms.tf). Null or empty, the default, subscribes nobody: the alarms still change state and the topic still receives them. AWS emails a confirmation first. CI sets it from the repository secret ALARM_EMAIL (TF_VAR_alarm_email in deploy-edge.yml and deploy-agent.yml), so every apply keeps the subscription; a laptop apply must export TF_VAR_alarm_email too, or it removes it. Never write it in this repository: it is a person's address."
  type        = string
  default     = null
  sensitive   = true

  validation {
    condition     = var.alarm_email == null || var.alarm_email == "" || can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alarm_email))
    error_message = "alarm_email must be an email address, or null or empty for no subscription."
  }
}

variable "ring_webhook_reserved_concurrency" {
  description = "Concurrency kept for the Ring webhook alone, so a busy agent plane can never starve Ring's five-second acknowledgement. 20, on an account whose Lambda quota is 1,000 (raised from the new-account 10 on 2026-10-14). Null reserves none: on an account still at 10, AWS refuses any reservation that leaves fewer than 10 unreserved."
  type        = number
  default     = 20

  validation {
    condition     = var.ring_webhook_reserved_concurrency == null || try(var.ring_webhook_reserved_concurrency >= 1, false)
    error_message = "ring_webhook_reserved_concurrency must be null or at least 1. Zero would refuse every webhook."
  }
}

variable "monthly_budget_usd" {
  description = "The account's monthly spend, in US dollars, above which var.alarm_email is told (infra/budget.tf): at 80% actual and 100% forecast. Nothing is switched off."
  type        = number
  default     = 150

  validation {
    condition     = var.monthly_budget_usd > 0
    error_message = "monthly_budget_usd must be more than zero."
  }
}
