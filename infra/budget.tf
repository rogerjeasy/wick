# ---------------------------------------------------------------------------
# What the account spends, watched.
#
# The judges' demo is public until the end of judging (20 November 2026):
# anyone can make a guest home, and every question asks Claude on Bedrock.
# The per-member limits (mcp-server assistant/turn.ts) keep one visitor from
# running it up; this is the backstop for the whole account. Two emails to
# var.alarm_email: when the month's actual spend passes 80% of the budget,
# and when AWS forecasts it will pass 100%. And a brake: when the month's
# actual spend passes the whole budget, AWS itself attaches a policy that
# denies Bedrock and Transcribe to the roles that call them (var.budget_brake,
# default on). Email cannot stop a bill; the family's own allowances
# (services/mcp-server/src/budget.ts) bound what one visitor spends, and this
# bounds what the month does. The app answers by its rules while the brake is
# on, and the door, the television and the week's counted facts do not use a
# model at all. Lifting it: detach the policy, or apply with budget_brake=false.
#
# Email straight from AWS Budgets, not through the alarms topic: Budgets may
# publish to a topic only under a topic policy naming it, and that policy
# would replace the one CloudWatch publishes under. Without an address there
# is no one to tell, and no budget is made.
# ---------------------------------------------------------------------------

resource "aws_budgets_budget" "monthly" {
  count = nonsensitive(var.alarm_email == null ? false : var.alarm_email != "") ? 1 : 0

  name         = "${local.prefix}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alarm_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alarm_email]
  }
}

# --- the brake -------------------------------------------------------------------

locals {
  brake_on = nonsensitive(var.alarm_email == null ? false : var.alarm_email != "") && var.budget_brake

  # Every role that asks a model or Transcribe for something. The deploy role
  # is not one: it never calls either.
  brake_roles = {
    mcp_server = aws_iam_role.apprunner_instance
    agents     = aws_iam_role.agents_runtime
    narrator   = aws_iam_role.agent_narrator_weekly
  }
}

data "aws_iam_policy_document" "spend_brake" {
  statement {
    sid    = "NoModelsAndNoTranscriptionOverBudget"
    effect = "Deny"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
      "bedrock:Converse",
      "bedrock:ConverseStream",
      "bedrock:ApplyGuardrail",
      "transcribe:StartStreamTranscription",
    ]
    resources = ["*"]
  }
}

# Attached to nobody until the budget says so.
resource "aws_iam_policy" "spend_brake" {
  count = local.brake_on ? 1 : 0

  name        = "${local.prefix}-spend-brake"
  description = "Denies Bedrock and Transcribe. Attached by AWS Budgets when the month's spend passes the budget (infra/budget.tf)."
  policy      = data.aws_iam_policy_document.spend_brake.json
}

data "aws_iam_policy_document" "budget_actions_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

# What AWS Budgets runs the brake as: it may attach this one policy to these
# roles, detach it, and nothing else.
resource "aws_iam_role" "budget_brake" {
  count = local.brake_on ? 1 : 0

  name               = "${local.prefix}-budget-brake"
  description        = "Assumed by AWS Budgets to attach the spend brake to the roles that call models."
  assume_role_policy = data.aws_iam_policy_document.budget_actions_assume.json
}

data "aws_iam_policy_document" "budget_brake" {
  count = local.brake_on ? 1 : 0

  statement {
    sid       = "AttachTheBrakeToTheModelCallersOnly"
    actions   = ["iam:AttachRolePolicy", "iam:DetachRolePolicy"]
    resources = [for role in local.brake_roles : role.arn]
    condition {
      test     = "ArnEquals"
      variable = "iam:PolicyARN"
      values   = [aws_iam_policy.spend_brake[0].arn]
    }
  }
}

resource "aws_iam_role_policy" "budget_brake" {
  count = local.brake_on ? 1 : 0

  name   = "attach-the-brake"
  role   = aws_iam_role.budget_brake[0].id
  policy = data.aws_iam_policy_document.budget_brake[0].json
}

resource "aws_budgets_budget_action" "brake" {
  count = local.brake_on ? 1 : 0

  budget_name        = aws_budgets_budget.monthly[0].name
  action_type        = "APPLY_IAM_POLICY"
  approval_model     = "AUTOMATIC"
  notification_type  = "ACTUAL"
  execution_role_arn = aws_iam_role.budget_brake[0].arn

  action_threshold {
    action_threshold_type  = "PERCENTAGE"
    action_threshold_value = 100
  }

  definition {
    iam_action_definition {
      policy_arn = aws_iam_policy.spend_brake[0].arn
      roles      = [for role in local.brake_roles : role.name]
    }
  }

  subscriber {
    subscription_type = "EMAIL"
    address           = var.alarm_email
  }

  depends_on = [aws_iam_role_policy.budget_brake]
}
