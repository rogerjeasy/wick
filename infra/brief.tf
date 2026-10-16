# ---------------------------------------------------------------------------
# The Sunday brief: each home's week written by Wick's agents on AgentCore.
# See services/agent/src/graphs/weeklyBrief.ts and agents/brief/fanout.ts.
#
#   EventBridge, Sunday 20:00 UTC (narrator.tf's rule, now aimed here)
#     -> brief-dispatch: one SQS message per home with a television
#     -> brief-worker (batch 1, at most two at once, partial batch failures)
#     -> AgentCore Runtime kind "brief.weekly", in that home's own session:
#          analyst -> writer (Sonnet) -> check (Guardian + Bedrock Guardrail)
#          -> suggester (structured output) -> validate -> store
#     -> if the agents could not write it: the Narrator, in the worker, for
#        that one home (so every home with a television has its week)
#   a message that fails three times -> brief-dead-letters -> an alarm
#
# A demo home's newest week takes the same queue when the home is made
# (the Wick server, services/mcp-server/src/accounts/demoHome.ts).
#
# Her press of OK on the week card (INV-7) puts wick.device / week.seen on
# the bus; the card-action Lambda then nudges the family (week_ready).
#
# The Narrator's own Lambda (narrator.tf) is kept: the worker runs its code
# in-process as the fallback, and an operator can still run it by hand to
# write every home's week in one go. Only the rule's target moved here.
#
# Cost: one Sonnet write and at most one retry, one suggester call and two
# ApplyGuardrail calls per home per week; SQS and Lambda round to nothing.
# ---------------------------------------------------------------------------

# --- the queue ---------------------------------------------------------------

resource "aws_sqs_queue" "brief_dead_letters" {
  name                      = "${local.prefix}-brief-dead-letters"
  message_retention_seconds = 1209600 # 14 days, the most SQS keeps anything
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "brief" {
  name = "${local.prefix}-brief"
  # Six times the worker's timeout, as Lambda asks of a queue it reads: a
  # message is never handed to a second worker while the first still has it.
  visibility_timeout_seconds = 6 * 300
  # A week not written by Thursday is a week nobody is waiting for any more.
  message_retention_seconds = 4 * 24 * 3600
  sqs_managed_sse_enabled   = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.brief_dead_letters.arn
    maxReceiveCount     = 3
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "brief_dead_letters" {
  queue_url = aws_sqs_queue.brief_dead_letters.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.brief.arn]
  })
}

# A message names a household. Only over TLS, whoever sends or reads it.
data "aws_iam_policy_document" "brief_queues" {
  for_each = {
    brief        = aws_sqs_queue.brief.arn
    dead_letters = aws_sqs_queue.brief_dead_letters.arn
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["sqs:*"]
    resources = [each.value]

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

resource "aws_sqs_queue_policy" "brief" {
  queue_url = aws_sqs_queue.brief.id
  policy    = data.aws_iam_policy_document.brief_queues["brief"].json
}

resource "aws_sqs_queue_policy" "brief_dead_letters" {
  queue_url = aws_sqs_queue.brief_dead_letters.id
  policy    = data.aws_iam_policy_document.brief_queues["dead_letters"].json
}

resource "aws_cloudwatch_metric_alarm" "brief_dead_letters" {
  alarm_name        = "${local.prefix}-brief-dead-letters-not-empty"
  alarm_description = "A home's week could not be written three times over and is waiting in ${aws_sqs_queue.brief_dead_letters.name}. Search /aws/lambda/${local.prefix}-agent-brief-worker for brief_message_failed, fix the cause, then redrive."

  namespace   = "AWS/SQS"
  metric_name = "ApproximateNumberOfMessagesVisible"
  dimensions  = { QueueName = aws_sqs_queue.brief_dead_letters.name }
  statistic   = "Maximum"
  period      = 300

  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# --- brief-dispatch: one message per home ------------------------------------

data "archive_file" "agent_brief_dispatch" {
  type        = "zip"
  source_dir  = "${path.module}/../services/agent/.build/brief-dispatch"
  output_path = "${path.module}/.build/agent-brief-dispatch.zip"
}

resource "aws_iam_role" "agent_brief_dispatch" {
  name               = "${local.prefix}-agent-brief-dispatch"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "agent_brief_dispatch_basic" {
  role       = aws_iam_role.agent_brief_dispatch.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "agent_brief_dispatch" {
  statement {
    # Which households have a paired television: a Scan of DEV# keys, paged
    # (agents/brief/loaders.ts). There is no index of households.
    sid       = "FindTheHomesWithATelevision"
    actions   = ["dynamodb:Scan"]
    resources = [aws_dynamodb_table.wick.arn]
  }

  statement {
    sid       = "QueueOneMessagePerHome"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.brief.arn]
  }
}

resource "aws_iam_role_policy" "agent_brief_dispatch" {
  name   = "${local.prefix}-agent-brief-dispatch"
  role   = aws_iam_role.agent_brief_dispatch.id
  policy = data.aws_iam_policy_document.agent_brief_dispatch.json
}

resource "aws_cloudwatch_log_group" "agent_brief_dispatch" {
  name              = "/aws/lambda/${local.prefix}-agent-brief-dispatch"
  retention_in_days = 14
}

resource "aws_lambda_function" "agent_brief_dispatch" {
  function_name = "${local.prefix}-agent-brief-dispatch"
  role          = aws_iam_role.agent_brief_dispatch.arn
  handler       = "index.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.agent_brief_dispatch.output_path
  source_code_hash = data.archive_file.agent_brief_dispatch.output_base64sha256

  # A Scan of the table and a batch of ten messages at a time.
  timeout     = 120
  memory_size = 256

  environment {
    variables = {
      TABLE_NAME      = aws_dynamodb_table.wick.name
      BRIEF_QUEUE_URL = aws_sqs_queue.brief.url
    }
  }

  depends_on = [aws_cloudwatch_log_group.agent_brief_dispatch]
}

# The weekly rule (narrator.tf) now starts the brief, not the Narrator.
resource "aws_cloudwatch_event_target" "brief_dispatch_weekly" {
  rule = aws_cloudwatch_event_rule.narrator_weekly.name
  arn  = aws_lambda_function.agent_brief_dispatch.arn
}

resource "aws_lambda_permission" "brief_dispatch_weekly" {
  statement_id  = "AllowExecutionFromTheWeeklyRule"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.agent_brief_dispatch.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.narrator_weekly.arn
}

# --- brief-worker: one home's week -------------------------------------------

data "archive_file" "agent_brief_worker" {
  type        = "zip"
  source_dir  = "${path.module}/../services/agent/.build/brief-worker"
  output_path = "${path.module}/.build/agent-brief-worker.zip"
}

resource "aws_iam_role" "agent_brief_worker" {
  name               = "${local.prefix}-agent-brief-worker"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "agent_brief_worker_basic" {
  role       = aws_iam_role.agent_brief_worker.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "agent_brief_worker" {
  statement {
    # What the event source mapping does as this function.
    sid       = "ReadTheBriefQueue"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
    resources = [aws_sqs_queue.brief.arn]
  }
}

resource "aws_iam_role_policy" "agent_brief_worker" {
  name   = "${local.prefix}-agent-brief-worker"
  role   = aws_iam_role.agent_brief_worker.id
  policy = data.aws_iam_policy_document.agent_brief_worker.json
}

# brief.weekly on the agent plane — the same grant the other shims have (agentcore.tf).
resource "aws_iam_role_policy" "agent_brief_worker_invoke" {
  name   = "${local.prefix}-agent-brief-worker-invoke"
  role   = aws_iam_role.agent_brief_worker.id
  policy = data.aws_iam_policy_document.invoke_agents.json
}

# The fallback is the Narrator's own code, so it is the Narrator's own grant
# (narrator.tf): the week's rows, Sonnet, her television, nothing more.
resource "aws_iam_role_policy" "agent_brief_worker_narrator" {
  name   = "${local.prefix}-agent-brief-worker-narrator"
  role   = aws_iam_role.agent_brief_worker.id
  policy = data.aws_iam_policy_document.agent_narrator_weekly.json
}

resource "aws_cloudwatch_log_group" "agent_brief_worker" {
  name              = "/aws/lambda/${local.prefix}-agent-brief-worker"
  retention_in_days = 14
}

resource "aws_lambda_function" "agent_brief_worker" {
  function_name = "${local.prefix}-agent-brief-worker"
  role          = aws_iam_role.agent_brief_worker.arn
  handler       = "index.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.agent_brief_worker.output_path
  source_code_hash = data.archive_file.agent_brief_worker.output_base64sha256

  # The agents' graph has 150 seconds (graphs/weeklyBrief.ts; the call
  # gives up at 170, workerLambda.ts), and the Narrator then needs room to
  # write the week if they could not.
  timeout     = 300
  memory_size = 512

  environment {
    variables = {
      TABLE_NAME            = aws_dynamodb_table.wick.name
      AGENT_RUNTIME_ARN     = aws_bedrockagentcore_agent_runtime.agents.agent_runtime_arn
      AGENT_RUNTIME_VERSION = aws_bedrockagentcore_agent_runtime.agents.agent_runtime_version
      # The Narrator's, for the fallback (narrator.tf).
      WICK_NARRATIVE_MODEL = local.narrative_model_profile
      WICK_HOUSEHOLD_TZ    = var.household_time_zone
    }
  }

  depends_on = [aws_cloudwatch_log_group.agent_brief_worker]
}

resource "aws_lambda_event_source_mapping" "brief_worker" {
  event_source_arn = aws_sqs_queue.brief.arn
  function_name    = aws_lambda_function.agent_brief_worker.arn

  # One home per invocation, so one home's failure is retried on its own.
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]

  # Two at a time: this account's Lambda concurrency quota is 10 (alarms.tf),
  # and a Sunday evening must not starve the door.
  scaling_config {
    maximum_concurrency = 2
  }

  depends_on = [aws_iam_role_policy.agent_brief_worker]
}

# --- alarms -------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "brief_lambda_errors" {
  for_each = {
    dispatch = aws_lambda_function.agent_brief_dispatch.function_name
    worker   = aws_lambda_function.agent_brief_worker.function_name
  }

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

# The Narrator run as the fallback logs a home it could not write the same
# way the Narrator's own Lambda does: counted into the same metric, so the
# alarm in alarms.tf ("narrator-week-not-written") covers both.
resource "aws_cloudwatch_log_metric_filter" "brief_worker_household_failed" {
  name           = "${local.prefix}-brief-worker-household-failed"
  log_group_name = aws_cloudwatch_log_group.agent_brief_worker.name
  pattern        = "{ $.msg = \"narrative_household_failed\" }"

  metric_transformation {
    name      = "NarratorHouseholdFailed"
    namespace = "Wick/${local.prefix}"
    value     = "1"
    unit      = "Count"
  }
}

# --- the agent plane: Sonnet and the Guardrail ---------------------------------

# Its own policy on the runtime's role (agentcore.tf), so the brief's grant
# reads as the brief's: the writer and the suggester stream from Sonnet
# through Strands' BedrockModel (ConverseStream), through the same "us."
# inference profile the Narrator uses, and the check applies the published
# Guardrail with contextual grounding (guardrail.tf).
data "aws_iam_policy_document" "agents_runtime_brief" {
  statement {
    sid     = "WriteTheWeekWithSonnet"
    actions = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
    resources = [
      "arn:aws:bedrock:${local.region}:${local.account_id}:inference-profile/${local.narrative_model_profile}",
      "arn:aws:bedrock:*::foundation-model/${local.narrative_model}",
    ]
  }

  statement {
    sid       = "CheckTheWeekWithTheGuardrail"
    actions   = ["bedrock:ApplyGuardrail"]
    resources = [aws_bedrock_guardrail.wick.guardrail_arn]
  }
}

resource "aws_iam_role_policy" "agents_runtime_brief" {
  name   = "${local.prefix}-agents-runtime-brief"
  role   = aws_iam_role.agents_runtime.id
  policy = data.aws_iam_policy_document.agents_runtime_brief.json
}

# --- the Wick server: a demo home's week ---------------------------------------

data "aws_iam_policy_document" "apprunner_brief" {
  statement {
    sid       = "AskTheAgentsForADemoHomesWeek"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.brief.arn]
  }
}

resource "aws_iam_role_policy" "apprunner_brief" {
  name   = "${local.prefix}-apprunner-brief"
  role   = aws_iam_role.apprunner_instance.id
  policy = data.aws_iam_policy_document.apprunner_brief.json
}

# --- she has read her week: the family is told (week_ready) ---------------------

resource "aws_cloudwatch_event_rule" "week_seen" {
  name           = "${local.prefix}-week-seen"
  description    = "She has read her week on her television: the agent plane nudges the family that it is there"
  event_bus_name = aws_cloudwatch_event_bus.wick.name

  event_pattern = jsonencode({
    source        = ["wick.device"]
    "detail-type" = ["week.seen"]
  })
}

resource "aws_cloudwatch_event_target" "week_seen" {
  rule           = aws_cloudwatch_event_rule.week_seen.name
  event_bus_name = aws_cloudwatch_event_bus.wick.name
  arn            = aws_lambda_function.agent_card_action.arn

  # A nudge an hour late says nothing wrong (the week is still there to
  # read), but one a day late is noise: a few tries, then let it go.
  retry_policy {
    maximum_retry_attempts       = 2
    maximum_event_age_in_seconds = 3600
  }
}

resource "aws_lambda_permission" "week_seen" {
  statement_id  = "AllowExecutionFromWeekSeen"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.agent_card_action.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.week_seen.arn
}

output "brief_queue_url" {
  value = aws_sqs_queue.brief.url
}
