# ---------------------------------------------------------------------------
# What the account spends, watched.
#
# The judges' demo is public until the end of judging (20 November 2026):
# anyone can make a guest home, and every question asks Claude on Bedrock.
# The per-member limits (mcp-server assistant/turn.ts) keep one visitor from
# running it up; this is the backstop for the whole account. Two emails to
# var.alarm_email: when the month's actual spend passes 80% of the budget,
# and when AWS forecasts it will pass 100%. Nothing is switched off: a budget
# only tells someone.
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
