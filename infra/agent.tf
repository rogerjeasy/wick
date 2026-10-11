# ---------------------------------------------------------------------------
# The agent plane's door path, Phase 1 and Phase 2. See docs/WICK-TECHNICAL.md
# §15 (S1).
#
#   webhook.mjs -> EventBridge "wick" bus (source wick.ring)
#     -> agent-door-event (this)
#     -> Phase 1: handleDoorEvent -> egress.sendToDevice   -> the paired TV
#     -> Phase 2: runDoorPhase2  -> egress.sendPatchToDevice -> the paired TV
#        (2b, the sentence: the Strands describe graph in the household's
#         AgentCore session — agentcore.tf, describeRemote.ts)
#
# Unlike edge-ring/edge-device's hand-written .mjs Lambdas, this one needs
# @wick/agent, @wick/ring, @wick/policy and @wick/contracts at runtime, so it
# ships as an esbuild bundle (`npm run build:lambda`) rather than a raw
# source_dir zip. @aws-sdk/* stays external — the nodejs22.x runtime
# provides it, same assumption every other Lambda here already makes.
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
    # Each household's own Ring link; which one is read is the household
    # the code is acting for (services/connectors/ring/src/secrets.ts).
    sid       = "ReadAHouseholdsRingToken"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.ring_token_secrets_arn]
  }

  statement {
    sid = "QueueLocateAndPatchTheCard"
    # sendToDevice: PutItem writes the CARD#<id> queue item. sendPatchToDevice
    # (Phase 2): GetItem reads it back, UpdateItem merges the patch in. Both:
    # Query finds the household's paired device to learn its live connection.
    # GetItem is also how a ring finds its household: RINGDEV#<deviceId>
    # (store/ringDevices.ts).
    # UpdateItem is also S6's ADD counter onto RHYTHM#door_activity/presence
    # bucket items (rhythm/writeClient.ts) — same table, same action, no
    # separate grant needed.
    actions   = ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.wick.arn]
  }

  statement {
    sid       = "PushToTheDevice"
    actions   = ["execute-api:ManageConnections"]
    resources = ["${aws_apigatewayv2_api.transport.execution_arn}/*/*"]
  }

  # A television on MQTT is reached by publishing to its own topic
  # (infra/iot.tf); one on the WebSocket, by the statement above.
  statement {
    sid       = "PublishToTelevisionsOnMqtt"
    actions   = ["iot:Publish"]
    resources = [local.device_topics_arn]
  }

}

# Phase 2b runs in the agent plane now; this Lambda only invokes it.
resource "aws_iam_role_policy" "agent_door_event_invoke_agents" {
  name   = "${local.prefix}-agent-door-event-invoke-agents"
  role   = aws_iam_role.agent_door_event.id
  policy = data.aws_iam_policy_document.invoke_agents.json
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

  # Phase 1's own local budget is 900ms (index.ts) and already returns to the
  # device long before this Lambda does — the handler keeps running because
  # Lambda freezes the container the instant it returns, and Phase 2 has to
  # finish (or hit its own internal timeout) first. Worst case: a cold
  # device-list fetch, imageForEvent's retries (up to 4 attempts, 2s apart —
  # FL-008's GRECO_NO_VALID_KEY settling delay), then describe.ts's
  # DESCRIBE_TIMEOUT_MS (2.5s). None of this is Ring's 5s webhook budget —
  # webhook.mjs already spent that getting the event onto the bus.
  # Plus a possibly cold AgentCore session for 2b.
  timeout     = 30
  memory_size = 256

  environment {
    variables = {
      TABLE_NAME               = aws_dynamodb_table.wick.name
      RING_TOKEN_SECRET_PREFIX = local.ring_token_secret_prefix
      AGENT_RUNTIME_ARN        = aws_bedrockagentcore_agent_runtime.agents.agent_runtime_arn
      AGENT_RUNTIME_VERSION    = aws_bedrockagentcore_agent_runtime.agents.agent_runtime_version
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
