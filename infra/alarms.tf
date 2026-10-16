# ---------------------------------------------------------------------------
# What pages someone, and where a failed event goes.
#
# Before this file nothing did either. Every Lambda could fail, be throttled
# (this account's concurrency quota is 10 for 22 functions), or time out, and
# the only trace was a log line nobody was reading. A door event that failed
# was retried by Lambda and then dropped. Now:
#
#   - every alarm below notifies one SNS topic, `<prefix>-alarms`, and
#     var.alarm_email (if set) is subscribed to it;
#   - a door event that fails every try, and a press the agent plane could not
#     carry out, is kept for 14 days in one dead-letter queue,
#     `<prefix>-dead-letters`, and that queue holding anything pages;
#   - the ops console's GET /status shows the same queue's depth (status.tf).
#
# The alarms are the ones worth waking for: something a resident or a family
# member would notice is broken. Each one names what it watches.
#
# Cost: about fifty alarms at USD 0.10 a month each after the free ten, one
# topic, one queue — a few dollars a month.
# ---------------------------------------------------------------------------

# --- where an alarm goes ---------------------------------------------------

# Not encrypted with KMS on purpose: CloudWatch can publish to a topic under
# the AWS-managed SNS key only if that key's policy lets it, and an
# AWS-managed key's policy cannot be changed. An alarm carries its name, its
# metric and its threshold — nothing about a household.
resource "aws_sns_topic" "alarms" {
  name = "${local.prefix}-alarms"
}

# AWS sends a confirmation email first; nothing arrives until it is clicked.
# The address is sensitive (it is a person's), so the plan never prints it;
# whether there is one is not.
resource "aws_sns_topic_subscription" "alarm_email" {
  count = nonsensitive(coalesce(var.alarm_email, "") != "") ? 1 : 0

  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  alarm_actions = [aws_sns_topic.alarms.arn]
}

# --- the dead-letter queue -------------------------------------------------
# Two kinds of message arrive here, in two shapes:
#   - from EventBridge, a door event it could not hand to the door Lambda at
#     all (agent.tf, the rule's target dead_letter_config): the event itself;
#   - from Lambda, an asynchronous invocation that failed every try (the
#     on_failure destinations in agent.tf, card-action.tf and live.tf): an
#     invocation record, with the event under requestPayload and the error
#     under responsePayload.
# These are a household's events. Only the functions above may send here,
# and nothing in this stack reads it but the status page, which reads the
# count and nothing else. A person reads one with the AWS console or
# `aws sqs receive-message`, from a laptop.

resource "aws_sqs_queue" "dead_letters" {
  name                      = "${local.prefix}-dead-letters"
  message_retention_seconds = 1209600 # 14 days, the most SQS keeps anything
  sqs_managed_sse_enabled   = true
}

data "aws_iam_policy_document" "dead_letters" {
  # EventBridge sends as itself, so the queue has to let it in — and only for
  # the door's rule.
  statement {
    sid       = "TheDoorRuleMayLeaveAnEventItCouldNotDeliver"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dead_letters.arn]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.ring_door_events.arn]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["sqs:*"]
    resources = [aws_sqs_queue.dead_letters.arn]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_sqs_queue_policy" "dead_letters" {
  queue_url = aws_sqs_queue.dead_letters.id
  policy    = data.aws_iam_policy_document.dead_letters.json
}

# A Lambda destination is sent with the function's own role (Lambda checks
# the grant when the destination is set, so each event_invoke_config depends
# on its role's copy of this).
data "aws_iam_policy_document" "send_dead_letters" {
  statement {
    sid       = "LeaveAFailedInvocationInTheDeadLetterQueue"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dead_letters.arn]
  }
}

resource "aws_cloudwatch_metric_alarm" "dead_letters" {
  alarm_name        = "${local.prefix}-dead-letters-not-empty"
  alarm_description = "A door event or a card press failed every try and is waiting in ${aws_sqs_queue.dead_letters.name}. Read it, fix the cause, then purge the queue. See infra/README.md."

  namespace   = "AWS/SQS"
  metric_name = "ApproximateNumberOfMessagesVisible"
  dimensions  = { QueueName = aws_sqs_queue.dead_letters.name }
  statistic   = "Maximum"
  period      = 300

  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# --- every Lambda: errors and throttles ------------------------------------
# One error is worth a page here: none of these fail in normal use (a refusal
# is an answer, not an error), and over the week before this file was written
# every one of them reported zero. A throttle means the account's concurrency
# quota (10) was reached and something waited or was dropped.

locals {
  alarmed_functions = {
    ring_webhook        = aws_lambda_function.webhook.function_name
    ring_token          = aws_lambda_function.token.function_name
    ring_link           = aws_lambda_function.link.function_name
    ring_authorize      = aws_lambda_function.authorize.function_name
    ring_refresh        = aws_lambda_function.refresh.function_name
    ring_household_link = aws_lambda_function.household_link.function_name
    status              = aws_lambda_function.status.function_name
    agent_door_event    = aws_lambda_function.agent_door_event.function_name
    agent_card_action   = aws_lambda_function.agent_card_action.function_name
    agent_live          = aws_lambda_function.agent_live.function_name
    live_bridge         = aws_lambda_function.live_bridge.function_name
    narrator_weekly     = aws_lambda_function.agent_narrator_weekly.function_name
    ws_connect          = aws_lambda_function.ws_connect.function_name
    ws_disconnect       = aws_lambda_function.ws_disconnect.function_name
    ws_route            = aws_lambda_function.ws_route.function_name
    iot_authorize       = aws_lambda_function.iot_authorize.function_name
    iot_presence        = aws_lambda_function.iot_presence.function_name
    iot_events          = aws_lambda_function.iot_events.function_name
    pair_start          = aws_lambda_function.pair_start.function_name
    pair_claim          = aws_lambda_function.pair_claim.function_name
    pair_status         = aws_lambda_function.pair_status.function_name
    pair_refresh        = aws_lambda_function.pair_refresh.function_name
  }
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each = local.alarmed_functions

  alarm_name        = "${each.value}-errors"
  alarm_description = "${each.value} failed (an exception or a timeout). Its log group is /aws/lambda/${each.value}."

  namespace   = "AWS/Lambda"
  metric_name = "Errors"
  dimensions  = { FunctionName = each.value }
  statistic   = "Sum"
  period      = 300

  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "lambda_throttles" {
  for_each = local.alarmed_functions

  alarm_name        = "${each.value}-throttles"
  alarm_description = "${each.value} was throttled: the account's Lambda concurrency quota was reached. Ask for the quota to be raised (Service Quotas, Lambda, Concurrent executions)."

  namespace   = "AWS/Lambda"
  metric_name = "Throttles"
  dimensions  = { FunctionName = each.value }
  statistic   = "Sum"
  period      = 300

  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# --- the weekly narrative --------------------------------------------------
# The narrator does not throw when one household fails (narrator/lambda.ts:
# a throw would make every home's week be written again). It logs
# `narrative_household_failed` instead, so that line is what is counted. A
# thrown run, or a timeout, is the Errors alarm above; a run that never
# started is the rule's FailedInvocations, below.

resource "aws_cloudwatch_log_metric_filter" "narrator_household_failed" {
  name           = "${local.prefix}-narrator-household-failed"
  log_group_name = aws_cloudwatch_log_group.agent_narrator_weekly.name
  pattern        = "{ $.msg = \"narrative_household_failed\" }"

  metric_transformation {
    name      = "NarratorHouseholdFailed"
    namespace = "Wick/${local.prefix}"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "narrator_household_failed" {
  alarm_name        = "${local.prefix}-narrator-week-not-written"
  alarm_description = "The weekly narrative was not written for at least one household. Search /aws/lambda/${aws_lambda_function.agent_narrator_weekly.function_name} for narrative_household_failed."

  namespace   = "Wick/${local.prefix}"
  metric_name = "NarratorHouseholdFailed"
  statistic   = "Sum"
  period      = 300

  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions

  depends_on = [aws_cloudwatch_log_metric_filter.narrator_household_failed]
}

resource "aws_cloudwatch_metric_alarm" "narrator_not_invoked" {
  alarm_name        = "${local.prefix}-narrator-run-not-started"
  alarm_description = "EventBridge could not start the weekly narrator (rule ${aws_cloudwatch_event_rule.narrator_weekly.name})."

  namespace   = "AWS/Events"
  metric_name = "FailedInvocations"
  dimensions  = { RuleName = aws_cloudwatch_event_rule.narrator_weekly.name }
  statistic   = "Sum"
  period      = 300

  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# --- the front doors: the Wick server and the two APIs ---------------------
# A burst, not one: a single 5xx from a client that went away mid-request is
# not a page. Three or more in five minutes is something people are seeing.

resource "aws_cloudwatch_metric_alarm" "mcp_server_5xx" {
  alarm_name        = "${local.prefix}-mcp-server-5xx"
  alarm_description = "The Wick server (App Runner ${aws_apprunner_service.mcp_server.service_name}) answered 5xx. Its logs are under /aws/apprunner/${aws_apprunner_service.mcp_server.service_name}/."

  namespace   = "AWS/AppRunner"
  metric_name = "5xxStatusResponses"
  dimensions = {
    ServiceName = aws_apprunner_service.mcp_server.service_name
    ServiceID   = aws_apprunner_service.mcp_server.service_id
  }
  statistic = "Sum"
  period    = 300

  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 3
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "edge_api_5xx" {
  alarm_name        = "${local.prefix}-edge-api-5xx"
  alarm_description = "The edge HTTP API (Ring webhook, pairing, status, live view) answered 5xx: a Lambda behind it failed or was throttled. Its access log is ${aws_cloudwatch_log_group.api.name}."

  namespace   = "AWS/ApiGateway"
  metric_name = "5xx"
  dimensions  = { ApiId = aws_apigatewayv2_api.edge.id }
  statistic   = "Sum"
  period      = 300

  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 3
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# A WebSocket API has no 5xx metric. Its server-side failures are these two:
# a route's Lambda failing (IntegrationError) and API Gateway failing to run
# the route at all (ExecutionError).
resource "aws_cloudwatch_metric_alarm" "transport_errors" {
  for_each = toset(["IntegrationError", "ExecutionError"])

  alarm_name        = "${local.prefix}-transport-${lower(each.key)}"
  alarm_description = "The televisions' WebSocket API reported ${each.key}: televisions on the WebSocket fallback may not be getting their cards."

  namespace   = "AWS/ApiGateway"
  metric_name = each.key
  dimensions = {
    ApiId = aws_apigatewayv2_api.transport.id
    Stage = aws_apigatewayv2_stage.transport.name
  }
  statistic = "Sum"
  period    = 300

  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 3
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# The MQTT channel's custom authorizer is the iot_authorize Lambda: its
# errors and throttles are alarmed above with every other function, which is
# where an authorizer failure shows first. No separate IoT alarm.

# --- logs the platform makes for itself ------------------------------------
# App Runner and AgentCore create their own log groups, and create them to
# keep everything forever. Terraform did not make them, so it adopts them:
# each group under the two prefixes is imported the first time a plan sees
# it, then managed like any other. On a new account the lists are empty
# until the service has written its first line, and the next apply picks
# them up — nothing here has to exist first.

data "aws_cloudwatch_log_groups" "mcp_server" {
  log_group_name_prefix = "/aws/apprunner/${local.prefix}-mcp-server/"
}

data "aws_cloudwatch_log_groups" "agent_runtime" {
  log_group_name_prefix = "/aws/bedrock-agentcore/runtimes/${replace(local.prefix, "-", "_")}_agents-"
}

locals {
  platform_log_groups = setunion(
    data.aws_cloudwatch_log_groups.mcp_server.log_group_names,
    data.aws_cloudwatch_log_groups.agent_runtime.log_group_names,
  )
}

import {
  for_each = local.platform_log_groups
  to       = aws_cloudwatch_log_group.platform[each.key]
  id       = each.key
}

resource "aws_cloudwatch_log_group" "platform" {
  for_each = local.platform_log_groups

  name              = each.key
  retention_in_days = 30
}
