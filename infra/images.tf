# ---------------------------------------------------------------------------
# Which image each container service runs: an exact tag, kept in SSM
# Parameter Store, never a moving `latest`.
#
#   /wick/images/agents       wick-agents (AgentCore) and wick-live-bridge (Lambda)
#   /wick/images/mcp-server   wick-mcp-server (App Runner)
#
# deploy-agent.yml builds an image on a push to main, pushes it under the
# commit's short SHA, writes that SHA here, and only then applies. Every
# apply, CI's or a laptop's, reads the tag from here, so a laptop apply from
# an older checkout cannot roll a service back to the image that checkout
# knew. The pin used to live in git (images.auto.tfvars), which CI cannot
# commit to: main takes pull requests only.
#
# Terraform makes each parameter once, with the tag running when this file
# was written, and from then on never writes the value (ignore_changes): the
# parameter belongs to whoever pushed last.
#
# var.agent_image_tag and var.mcp_image_tag override what is read, for an
# emergency rollback from a laptop. Unset, they change nothing.
# ---------------------------------------------------------------------------

resource "aws_ssm_parameter" "agents_image" {
  name        = "/${local.prefix}/images/agents"
  description = "Tag of the wick-agents and wick-live-bridge images that AgentCore and the live bridge run. Written by deploy-agent.yml or scripts/push-agent-image.sh after a push."
  type        = "String"
  # The tag both services ran on 2026-10-14 (get-agent-runtime, lambda
  # get-function). Only ever the starting value.
  insecure_value = "6c16ea0"

  lifecycle {
    ignore_changes = [insecure_value]
  }
}

resource "aws_ssm_parameter" "mcp_server_image" {
  name        = "/${local.prefix}/images/mcp-server"
  description = "Tag of the wick-mcp-server image that App Runner runs. Written by deploy-agent.yml or scripts/push-mcp-image.sh after a push."
  type        = "String"
  # `latest` keeps the service exactly as it was until the first pinned push:
  # same image identifier, same automatic deployments (mcp.tf).
  insecure_value = "latest"

  lifecycle {
    ignore_changes = [insecure_value]
  }
}

# The value as it is in SSM now, not as written above: every plan refreshes
# the parameter, and ignore_changes keeps what it read. A data source would
# say the same, except on the apply that makes the parameter, where it could
# not be read until apply and would mark every image as changing.
locals {
  agent_image_tag      = coalesce(var.agent_image_tag, aws_ssm_parameter.agents_image.insecure_value)
  mcp_server_image_tag = coalesce(var.mcp_image_tag, aws_ssm_parameter.mcp_server_image.insecure_value)
}
