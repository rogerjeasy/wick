# ---------------------------------------------------------------------------
# The agent plane's Phase 1 door path. See docs/WICK-TECHNICAL.md §15 (S1).
#
#   webhook.mjs -> EventBridge "wick" bus (source wick.ring)
#     -> agent-door-event (this)
#     -> handleDoorEvent -> egress.sendToDevice -> the paired TV
#
# Unlike edge-ring/edge-device's hand-written .mjs Lambdas, this one needs
# @wick/agent, @wick/ring, @wick/policy and @wick/contracts at runtime, so it
# ships as an esbuild bundle (`npm run build:lambda`) rather than a raw
# source_dir zip. @aws-sdk/* stays external — the nodejs22.x runtime
# provides it, same assumption every other Lambda here already makes.
#
# Phase 2 (image + description patches) is not wired here yet — egress.ts
# has no patch-delivery path. See lambda.ts's own header comment.
# ---------------------------------------------------------------------------

data "archive_file" "agent_door_event" {
  type        = "zip"
  source_dir  = "${path.module}/../services/agent/.build/door-event"
  output_path = "${path.module}/.build/agent-door-event.zip"
}

resource "aws_iam_role" "agent_door_event" {
  name               = "${local.prefix}-agent-door-event"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "agent_door_event_basic" {
  role       = aws_iam_role.agent_door_event.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "agent_door_event" {
  statement {
    sid       = "ReadRingToken"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.ring_tokens.arn]
  }

  statement {
    sid = "QueueAndLocateTheCard"
    # sendToDevice (egress.ts): PutItem writes the CARD#<id> queue item,
    # unconditionally, before any push attempt — Query then finds the
    # household's paired device to learn its live connection, if any.
    actions   = ["dynamodb:PutItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.wick.arn]
  }

  statement {
    sid       = "PushToTheDevice"
    actions   = ["execute-api:ManageConnections"]
    resources = ["${aws_apigatewayv2_api.transport.execution_arn}/*/*"]
  }
}

resource "aws_iam_role_policy" "agent_door_event" {
  name   = "${local.prefix}-agent-door-event"
  role   = aws_iam_role.agent_door_event.id
  policy = data.aws_iam_policy_document.agent_door_event.json
}

resource "aws_cloudwatch_log_group" "agent_door_event" {
  name              = "/aws/lambda/${local.prefix}-agent-door-event"
  retention_in_days = 14
}

resource "aws_lambda_function" "agent_door_event" {
  function_name = "${local.prefix}-agent-door-event"
  role          = aws_iam_role.agent_door_event.arn
  handler       = "index.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.agent_door_event.output_path
  source_code_hash = data.archive_file.agent_door_event.output_base64sha256

  # Phase 1's own local budget is 900ms (index.ts); this timeout covers a
  # cold container's device-list fetch (deviceCache.ts's single miss) with
  # headroom, not Ring's 5s webhook budget — webhook.mjs already spent that
  # getting the event onto the bus.
  timeout     = 10
  memory_size = 256

  environment {
    variables = {
      TABLE_NAME           = aws_dynamodb_table.wick.name
      RING_TOKEN_SECRET_ID = aws_secretsmanager_secret.ring_tokens.name
      WICK_HOUSEHOLD_ID    = var.household_id
    }
  }

  depends_on = [aws_cloudwatch_log_group.agent_door_event]
}

# No detail-type filter: every accepted Ring event lands here, and
# parseEvent.ts's isDoorWorthy() decides what's a visitor versus a vehicle,
# a package, or account-lifecycle noise. Keeping that decision in tested code
# (parseEvent.test.ts) rather than duplicating it as an EventBridge pattern
# means it only has to be right once.
resource "aws_cloudwatch_event_rule" "ring_door_events" {
  name           = "${local.prefix}-ring-door-events"
  description    = "Every accepted Ring event; door-worthiness is decided in parseEvent.ts"
  event_bus_name = aws_cloudwatch_event_bus.wick.name

  event_pattern = jsonencode({
    source = ["wick.ring"]
  })
}

resource "aws_cloudwatch_event_target" "ring_door_events" {
  rule           = aws_cloudwatch_event_rule.ring_door_events.name
  event_bus_name = aws_cloudwatch_event_bus.wick.name
  arn            = aws_lambda_function.agent_door_event.arn
}

resource "aws_lambda_permission" "ring_door_events" {
  statement_id  = "AllowExecutionFromEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.agent_door_event.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.ring_door_events.arn
}
