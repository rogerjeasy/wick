# ---------------------------------------------------------------------------
# Web Push — reaching a family member's own browser when the family app is
# closed ("Ask Sarah to look").
#
#   door card press -> agent-card-action -> egress.ts nudgeFamily
#     -> the browser's push service -> apps/sim-alexa/sw.js -> a notification
#
# What is sent is a kind and nothing about the house (packages/contracts
# push.ts). The request is signed with Wick's own key pair (VAPID, RFC 8292):
# the private half lives here, the public half is a row in the table that the
# Wick server hands to browsers (CONFIG#push / VAPID). Both are written once
# by infra/bootstrap/generate-push-keys.sh; Terraform manages the container
# and never the contents.
# ---------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "push_vapid" {
  name        = "${local.prefix}/push/vapid"
  description = "The key pair Wick signs Web Push requests with (VAPID), and the contact address a push service is given"

  recovery_window_in_days = 7

  lifecycle {
    prevent_destroy = true
  }
}

# Only the function that carries out "Ask Sarah to look" sends a nudge.
data "aws_iam_policy_document" "agent_card_action_push" {
  statement {
    sid       = "ReadThePushSigningKey"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.push_vapid.arn]
  }

  statement {
    sid = "ForgetABrowserThePushServiceSaysIsGone"
    # The subscriptions themselves are read with the Query the function
    # already has (infra/card-action.tf); a browser that has unsubscribed is
    # removed so it is not tried again.
    actions   = ["dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.wick.arn]
  }
}

resource "aws_iam_role_policy" "agent_card_action_push" {
  name   = "${local.prefix}-agent-card-action-push"
  role   = aws_iam_role.agent_card_action.id
  policy = data.aws_iam_policy_document.agent_card_action_push.json
}

output "push_vapid_secret" {
  description = "Populate with infra/bootstrap/generate-push-keys.sh"
  value       = aws_secretsmanager_secret.push_vapid.name
}
