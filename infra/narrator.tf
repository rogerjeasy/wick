# ---------------------------------------------------------------------------
# The Narrator — the weekly narrative. See docs/WICK-TECHNICAL.md §5.4 and
# services/agent/src/agents/narrator/index.ts's own header comment for why
# residentSeenAt is never set here (INV-7 — the resident sees the week on
# their own television first: the WeekCard's one button sets it, in
# edge-device's route.mjs).
#
# Runs on a weekly schedule, not per-request: Alexa+ requires MCP round
# trips under 500ms (§9.3), so get_week_narrative.ts does a single GetItem
# over what this Lambda precomputes.
#
# Same reason as agent.tf's door-event Lambda: this needs @wick/agent,
# @wick/contracts and the Bedrock SDK at runtime, so it ships as an esbuild
# bundle (`npm run build:lambda`) rather than a raw source_dir zip.
# ---------------------------------------------------------------------------

locals {
  # Claude Sonnet 4.5. Sonnet 5 is listed for this account but refuses
  # every call as "not available for this account" (FRICTION.md FL-020).
  # One source for both the Lambda's WICK_NARRATIVE_MODEL and its IAM grant.
  narrative_model         = "anthropic.claude-sonnet-4-5-20250929-v1:0"
  narrative_model_profile = "us.${local.narrative_model}"
}

data "archive_file" "agent_narrator_weekly" {
  type        = "zip"
  source_dir  = "${path.module}/../services/agent/.build/narrator-weekly"
  output_path = "${path.module}/.build/agent-narrator-weekly.zip"
}

resource "aws_iam_role" "agent_narrator_weekly" {
  name               = "${local.prefix}-agent-narrator-weekly"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "agent_narrator_weekly_basic" {
  role       = aws_iam_role.agent_narrator_weekly.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "agent_narrator_weekly" {
  statement {
    sid = "ReadTimelineQueueAndLocateTheWeekCard"
    # Scan: which households have a paired television (lambda.ts's
    # listHouseholds) — there is no index of households. Query: the week's
    # EVT# rows (timeline.ts) and, inside sendToDevice, the household's
    # paired-device connection. PutItem: the NARR#<isoWeek> item
    # get_week_narrative.ts reads, and (via sendToDevice) the CARD#<id>
    # queue item for the WeekCard itself (weekCard.ts).
    actions   = ["dynamodb:Scan", "dynamodb:Query", "dynamodb:PutItem"]
    resources = [aws_dynamodb_table.wick.arn]
  }

  statement {
    sid       = "PushTheWeekCardToTheDevice"
    actions   = ["execute-api:ManageConnections"]
    resources = ["${aws_apigatewayv2_api.transport.execution_arn}/*/*"]
  }

  statement {
    sid = "WriteTheWeek"
    # prose.ts's ConverseCommand — the model never counts, only narrates
    # what timeline.ts already computed. Invoked through the "us." cross-
    # region inference profile: AWS requires InvokeModel on both the
    # profile ARN and the foundation-model ARN it routes to, in whichever
    # US region the profile picks — hence the wildcard region.
    actions = ["bedrock:InvokeModel"]
    resources = [
      "arn:aws:bedrock:${local.region}:${local.account_id}:inference-profile/${local.narrative_model_profile}",
      "arn:aws:bedrock:*::foundation-model/${local.narrative_model}",
    ]
  }
}

resource "aws_iam_role_policy" "agent_narrator_weekly" {
  name   = "${local.prefix}-agent-narrator-weekly"
  role   = aws_iam_role.agent_narrator_weekly.id
  policy = data.aws_iam_policy_document.agent_narrator_weekly.json
}

resource "aws_cloudwatch_log_group" "agent_narrator_weekly" {
  name              = "/aws/lambda/${local.prefix}-agent-narrator-weekly"
  retention_in_days = 14
}

resource "aws_lambda_function" "agent_narrator_weekly" {
  function_name = "${local.prefix}-agent-narrator-weekly"
  role          = aws_iam_role.agent_narrator_weekly.arn
  handler       = "index.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.agent_narrator_weekly.output_path
  source_code_hash = data.archive_file.agent_narrator_weekly.output_base64sha256

  # Not latency-sensitive at all — this runs offline, once a week, one
  # household after another: a full-week Query plus one Claude call each.
  # The Lambda maximum, so the number of households it can serve in one
  # run is as large as a single function allows.
  timeout     = 900
  memory_size = 256

  environment {
    variables = {
      TABLE_NAME           = aws_dynamodb_table.wick.name
      WICK_NARRATIVE_MODEL = local.narrative_model_profile
      WICK_HOUSEHOLD_TZ    = var.household_time_zone
      WICK_FAMILY_NAME     = var.family_name
    }
  }

  depends_on = [aws_cloudwatch_log_group.agent_narrator_weekly]
}

# Sunday evening UTC — the week (Monday-Sunday, ISO 8601) is complete by
# then, matching the docs/WICK.md §3.3 demo narrative's "Sunday, 10:00,
# Sarah asks" moment landing shortly after a fresh run.
resource "aws_cloudwatch_event_rule" "narrator_weekly" {
  name                = "${local.prefix}-narrator-weekly"
  description         = "Compute and write the week's narrative"
  schedule_expression = "cron(0 20 ? * SUN *)"
}

resource "aws_cloudwatch_event_target" "narrator_weekly" {
  rule = aws_cloudwatch_event_rule.narrator_weekly.name
  arn  = aws_lambda_function.agent_narrator_weekly.arn
}

resource "aws_lambda_permission" "narrator_weekly" {
  statement_id  = "AllowExecutionFromEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.agent_narrator_weekly.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.narrator_weekly.arn
}
