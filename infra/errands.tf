# ---------------------------------------------------------------------------
# Visit errands — "The plumber is coming Thursday at ten, let Mum know."
#
#   family app -> Wick server arrange_visit (App Runner)
#     -> DynamoDB ERRAND# + roster PER#errand:<id>, one transaction
#     -> Step Functions StartExecution (named by the errand: started once)
#
#   the errand state machine (errand.asl.json), STANDARD:
#     wait until the reminder -> errand-step remind (a note on her television, deferred)
#     -> errand-step arm (.waitForTaskToken, until the end of the window)
#     -> rang | no_show (the member told by Web Push, with a kind and nothing else)
#
#   door Lambda -> EventBridge (wick.door / door.rang) -> errand-door
#     -> SendTaskSuccess({ rangAt, cardId }) on the errand waiting at that door
#
# Code decides every step; no model is asked anything (AGENTS.md INV-5).
# Cost: an execution is about eight state transitions, USD 0.025 per
# thousand; two small Lambdas run a handful of times per errand.
#
# A new service type (Step Functions) for this stack: the first apply is the
# user's own, from a laptop, after a `plan` (memory: laptop apply).
# ---------------------------------------------------------------------------

locals {
  errand_state_machine_name = "${local.prefix}-errand"
  # Every execution of the machine: what StopExecution and DescribeExecution name.
  errand_executions_arn = "arn:aws:states:${local.region}:${local.account_id}:execution:${local.errand_state_machine_name}:*"
}

# --- the two Lambdas -------------------------------------------------------
# One bundle source (services/agent/src/agents/errand/lambda.ts), built twice
# by scripts/build-lambda.mjs, each with its own handler and its own role.

data "archive_file" "errand_step" {
  type        = "zip"
  source_dir  = "${path.module}/../services/agent/.build/errand-step"
  output_path = "${path.module}/.build/errand-step.zip"
}

data "archive_file" "errand_door" {
  type        = "zip"
  source_dir  = "${path.module}/../services/agent/.build/errand-door"
  output_path = "${path.module}/.build/errand-door.zip"
}

resource "aws_iam_role" "errand_step" {
  name               = "${local.prefix}-errand-step"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "errand_step_basic" {
  role       = aws_iam_role.errand_step.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "errand_step" {
  statement {
    sid = "ReadAndMoveTheErrandAndSendHerReminder"
    # GetItem: the ERRAND# row, the author's MEM# row (INV-9, asked again at
    # every step), and the household's language before her reminder is sent
    # (egress.ts). UpdateItem: the errand moved on, conditionally.
    # DeleteItem: the visitor taken off the door (PER#errand:<id>), and a
    # browser the push service says is gone (push/nudge.ts). PutItem: her
    # reminder's CARD# row (egress.ts sendToDevice). Query: the household's
    # televisions (DEV#) and the author's browsers (USER#<id> / PUSH#).
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:PutItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.wick.arn]
  }

  statement {
    sid       = "PushTheReminderToTheDevice"
    actions   = ["execute-api:ManageConnections"]
    resources = ["${aws_apigatewayv2_api.transport.execution_arn}/*/*"]
  }

  statement {
    sid       = "PublishToTelevisionsOnMqtt"
    actions   = ["iot:Publish"]
    resources = [local.device_topics_arn]
  }

  # The member is told how it went by a nudge (infra/push.tf): a kind, and
  # nothing about the house. No Translate: her reminder is the phrasebook's
  # whole sentence, never free text.
  statement {
    sid       = "ReadThePushSigningKey"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.push_vapid.arn]
  }

  # The door step hands its own token back when the errand ended while it
  # was being armed (called off, or its author no longer allowed).
  statement {
    sid       = "HandBackItsOwnTaskToken"
    actions   = ["states:SendTaskSuccess"]
    resources = [aws_sfn_state_machine.errand.arn]
  }
}

resource "aws_iam_role_policy" "errand_step" {
  name   = "${local.prefix}-errand-step"
  role   = aws_iam_role.errand_step.id
  policy = data.aws_iam_policy_document.errand_step.json
}

resource "aws_cloudwatch_log_group" "errand_step" {
  name              = "/aws/lambda/${local.prefix}-errand-step"
  retention_in_days = 14
}

resource "aws_lambda_function" "errand_step" {
  function_name = "${local.prefix}-errand-step"
  role          = aws_iam_role.errand_step.arn
  handler       = "index.stepHandler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.errand_step.output_path
  source_code_hash = data.archive_file.errand_step.output_base64sha256

  # A few table reads, one card and one nudge. The state machine's own
  # TimeoutSeconds for a step is 60 (errand.asl.json).
  timeout     = 30
  memory_size = 256

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.wick.name
      # "this morning at ten" on the household's own clock.
      WICK_HOUSEHOLD_TZ = var.household_time_zone
      # Unset keys mean no nudge, never a failed step (egress.ts nudgeFamily).
      PUSH_VAPID_SECRET_ARN = aws_secretsmanager_secret.push_vapid.arn
    }
  }

  depends_on = [aws_cloudwatch_log_group.errand_step]
}

resource "aws_iam_role" "errand_door" {
  name               = "${local.prefix}-errand-door"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "errand_door_basic" {
  role       = aws_iam_role.errand_door.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "errand_door" {
  statement {
    sid = "FindTheErrandsWaitingAtThatDoor"
    # Query: the household's ERRAND# rows. GetItem: one errand's token.
    # UpdateItem: the token taken off once it has been handed back.
    actions   = ["dynamodb:Query", "dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.wick.arn]
  }

  statement {
    sid       = "WakeTheErrandThatWasWaiting"
    actions   = ["states:SendTaskSuccess"]
    resources = [aws_sfn_state_machine.errand.arn]
  }
}

resource "aws_iam_role_policy" "errand_door" {
  name   = "${local.prefix}-errand-door"
  role   = aws_iam_role.errand_door.id
  policy = data.aws_iam_policy_document.errand_door.json
}

resource "aws_cloudwatch_log_group" "errand_door" {
  name              = "/aws/lambda/${local.prefix}-errand-door"
  retention_in_days = 14
}

resource "aws_lambda_function" "errand_door" {
  function_name = "${local.prefix}-errand-door"
  role          = aws_iam_role.errand_door.arn
  handler       = "index.doorHandler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.errand_door.output_path
  source_code_hash = data.archive_file.errand_door.output_base64sha256

  timeout     = 15
  memory_size = 256

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.wick.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.errand_door]
}

# A ring handed over late is still a ring inside the window — the window is
# an hour either side — so Lambda's own retries are kept, within a quarter
# of an hour. A token already handed back is skipped on a retry (door.ts).
resource "aws_lambda_function_event_invoke_config" "errand_door" {
  function_name                = aws_lambda_function.errand_door.function_name
  maximum_retry_attempts       = 2
  maximum_event_age_in_seconds = 900
}

# --- every ring, from the door ---------------------------------------------

# The door Lambda says each ring on the bus (services/agent agents/door/
# announce.ts). Only that: this bus, and no other action.
data "aws_iam_policy_document" "agent_door_event_says_it_rang" {
  statement {
    sid       = "SayOnTheBusThatTheDoorRang"
    actions   = ["events:PutEvents"]
    resources = [aws_cloudwatch_event_bus.wick.arn]
  }
}

resource "aws_iam_role_policy" "agent_door_event_says_it_rang" {
  name   = "${local.prefix}-agent-door-event-says-it-rang"
  role   = aws_iam_role.agent_door_event.id
  policy = data.aws_iam_policy_document.agent_door_event_says_it_rang.json
}

resource "aws_cloudwatch_event_rule" "door_rang" {
  name           = "${local.prefix}-door-rang"
  description    = "Every ring at a door, real or stand-in: an errand waiting there is told"
  event_bus_name = aws_cloudwatch_event_bus.wick.name

  event_pattern = jsonencode({
    source        = ["wick.door"]
    "detail-type" = ["door.rang"]
  })
}

resource "aws_cloudwatch_event_target" "door_rang" {
  rule           = aws_cloudwatch_event_rule.door_rang.name
  event_bus_name = aws_cloudwatch_event_bus.wick.name
  arn            = aws_lambda_function.errand_door.arn

  retry_policy {
    maximum_retry_attempts       = 2
    maximum_event_age_in_seconds = 900
  }
}

resource "aws_lambda_permission" "door_rang" {
  statement_id  = "AllowExecutionFromDoorRang"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.errand_door.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.door_rang.arn
}

# --- the state machine -----------------------------------------------------

data "aws_iam_policy_document" "states_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "errand_machine" {
  name               = "${local.prefix}-errand-machine"
  assume_role_policy = data.aws_iam_policy_document.states_assume.json
}

data "aws_iam_policy_document" "errand_machine" {
  # The machine calls one function, errand-step, and nothing else.
  statement {
    sid       = "InvokeTheErrandSteps"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.errand_step.arn, "${aws_lambda_function.errand_step.arn}:*"]
  }

  # Step Functions writes its logs through CloudWatch Logs' log delivery,
  # whose actions take no resource but "*" (Step Functions developer guide,
  # "IAM policies for logging to CloudWatch Logs").
  statement {
    sid = "DeliverItsLogs"
    actions = [
      "logs:CreateLogDelivery",
      "logs:GetLogDelivery",
      "logs:UpdateLogDelivery",
      "logs:DeleteLogDelivery",
      "logs:ListLogDeliveries",
      "logs:PutResourcePolicy",
      "logs:DescribeResourcePolicies",
      "logs:DescribeLogGroups",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "errand_machine" {
  name   = "${local.prefix}-errand-machine"
  role   = aws_iam_role.errand_machine.id
  policy = data.aws_iam_policy_document.errand_machine.json
}

# Step Functions' own log groups are named under /aws/vendedlogs/ by convention.
resource "aws_cloudwatch_log_group" "errand_machine" {
  name              = "/aws/vendedlogs/states/${local.errand_state_machine_name}"
  retention_in_days = 14
}

resource "aws_sfn_state_machine" "errand" {
  name     = local.errand_state_machine_name
  type     = "STANDARD"
  role_arn = aws_iam_role.errand_machine.arn

  definition = templatefile("${path.module}/errand.asl.json", {
    errand_step_arn = aws_lambda_function.errand_step.arn
  })

  # Errors only, and never an execution's data: its input names a household
  # and an errand, and a step's output a door card. What happened to an
  # errand is on its row; the console's execution graph shows the path.
  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.errand_machine.arn}:*"
    include_execution_data = false
    level                  = "ERROR"
  }

  depends_on = [aws_iam_role_policy.errand_machine]
}

# --- the Wick server starts and stops errands ------------------------------
# A separate policy on the App Runner instance role (infra/mcp.tf), so the
# server may start an execution of this machine and stop one, and nothing
# else of Step Functions.
data "aws_iam_policy_document" "apprunner_instance_errands" {
  statement {
    sid       = "StartAnErrand"
    actions   = ["states:StartExecution"]
    resources = [aws_sfn_state_machine.errand.arn]
  }

  statement {
    sid       = "CallOffAnErrand"
    actions   = ["states:StopExecution"]
    resources = [local.errand_executions_arn]
  }
}

resource "aws_iam_role_policy" "apprunner_instance_errands" {
  name   = "${local.prefix}-apprunner-mcp-errands"
  role   = aws_iam_role.apprunner_instance.id
  policy = data.aws_iam_policy_document.apprunner_instance_errands.json
}

# --- what pages someone (alarms.tf) ----------------------------------------

resource "aws_cloudwatch_metric_alarm" "errand_executions_failed" {
  alarm_name        = "${local.errand_state_machine_name}-executions-failed"
  alarm_description = "An errand's execution failed: a step failed every try, and the errand was marked failed. Its execution history is in the Step Functions console; its log group is ${aws_cloudwatch_log_group.errand_machine.name}."

  namespace   = "AWS/States"
  metric_name = "ExecutionsFailed"
  dimensions  = { StateMachineArn = aws_sfn_state_machine.errand.arn }
  statistic   = "Sum"
  period      = 300

  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

locals {
  errand_functions = {
    errand_step = aws_lambda_function.errand_step.function_name
    errand_door = aws_lambda_function.errand_door.function_name
  }
}

resource "aws_cloudwatch_metric_alarm" "errand_lambda_errors" {
  for_each = local.errand_functions

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

resource "aws_cloudwatch_metric_alarm" "errand_lambda_throttles" {
  for_each = local.errand_functions

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

output "errand_state_machine_arn" {
  description = "Visit errands' state machine: the Wick server starts one execution per errand (ERRAND_STATE_MACHINE_ARN)."
  value       = aws_sfn_state_machine.errand.arn
}
