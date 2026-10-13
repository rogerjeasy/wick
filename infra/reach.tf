# ---------------------------------------------------------------------------
# Hold for Sarah — the three minutes (packages/contracts/src/reach.ts).
#
#   TV: OK held two seconds -> edge reach.mjs -> the card "Ask Sarah to ring you?"
#   TV press ring_me / say_hello -> EventBridge (wick.device / card.action)
#     -> agent-card-action -> reach/ask.ts: REACH#<id> -> card -> TV
#        -> nudge ONE person -> a one-time schedule, three minutes on
#   schedule fires -> agent-card-action (reach.due) -> reach/due.ts:
#     nobody answered? -> the next person is asked -> card -> TV -> schedule again
#
# Nothing of Wick's runs during the wait. The wait is a one-time schedule in
# Amazon EventBridge Scheduler that calls the card-action function back and
# then deletes itself (ActionAfterCompletion = DELETE). It carries which
# request and which step, never who (services/agent/src/agents/reach/timer.ts).
#
# The rule that hands the two presses to the function is the one the other
# card presses already use (card-action.tf); the function's environment is
# set there too.
# ---------------------------------------------------------------------------

resource "aws_scheduler_schedule_group" "reach" {
  name = "${local.prefix}-reach"
}

data "aws_iam_policy_document" "reach_timer_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }

    # Only this account's schedules may take the role (the confused-deputy
    # guard the Scheduler documentation asks for).
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

# What a timer may do when it fires: call the card-action function, and
# nothing else.
resource "aws_iam_role" "reach_timer" {
  name               = "${local.prefix}-reach-timer"
  assume_role_policy = data.aws_iam_policy_document.reach_timer_assume.json
}

data "aws_iam_policy_document" "reach_timer" {
  statement {
    sid       = "CallTheCardActionFunction"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.agent_card_action.arn]
  }
}

resource "aws_iam_role_policy" "reach_timer" {
  name   = "${local.prefix}-reach-timer"
  role   = aws_iam_role.reach_timer.id
  policy = data.aws_iam_policy_document.reach_timer.json
}

# What the card-action function may do about timers: set one, in this group,
# under a name that begins `reach-`, handing it the one role above. It can
# neither read nor delete a schedule, and can set none anywhere else.
data "aws_iam_policy_document" "agent_card_action_reach" {
  statement {
    sid       = "SetTheThreeMinutes"
    actions   = ["scheduler:CreateSchedule"]
    resources = ["arn:aws:scheduler:${local.region}:${local.account_id}:schedule/${aws_scheduler_schedule_group.reach.name}/reach-*"]
  }

  statement {
    sid       = "HandTheTimerItsRole"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.reach_timer.arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "agent_card_action_reach" {
  name   = "${local.prefix}-agent-card-action-reach"
  role   = aws_iam_role.agent_card_action.id
  policy = data.aws_iam_policy_document.agent_card_action_reach.json
}
