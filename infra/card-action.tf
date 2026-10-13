# ---------------------------------------------------------------------------
# The Door Card's two server-side buttons.
#
#   TV card_action -> ws route.mjs -> EventBridge (wick.device / card.action)
#     -> agent-card-action (this function)
#
#   M1 "Ring the hallway chime": a shim, because EventBridge cannot target an
#     AgentCore Runtime -> AgentCore door-action graph -> Ring Chime playback
#     -> patch -> TV
#
#   "Ask Sarah to look": answered in this function (services/agent door/
#     askFamily.ts) -> the LOOK#<cardId> row the family's tools read
#     -> patch -> TV
#
#   "Hold for Sarah" (ring_me / say_hello): answered in this function too
#     (services/agent agents/reach) -> see infra/reach.tf
#
# No model in either path (spec D4): every step is deterministic.
# ---------------------------------------------------------------------------

data "archive_file" "agent_card_action" {
  type        = "zip"
  source_dir  = "${path.module}/../services/agent/.build/card-action"
  output_path = "${path.module}/.build/agent-card-action.zip"
}

resource "aws_iam_role" "agent_card_action" {
  name               = "${local.prefix}-agent-card-action"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "agent_card_action_basic" {
  role       = aws_iam_role.agent_card_action.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "agent_card_action" {
  name   = "${local.prefix}-agent-card-action"
  role   = aws_iam_role.agent_card_action.id
  policy = data.aws_iam_policy_document.invoke_agents.json
}

# "Ask Sarah to look" is carried out here, not in the runtime, so this
# function reads the card and the family circle, files the request, and
# patches the card itself — the same reach the door function has for Phase 2,
# and nothing over Ring.
data "aws_iam_policy_document" "agent_card_action_ask_family" {
  statement {
    sid = "ReadTheCardAndCircleFileTheRequestPatchTheCard"
    # GetItem: the CARD#<id> the press is about (and again inside
    # sendPatchToDevice). Query: MEM# — who the resident allows right now —
    # and DEV#, to find the television's live connection. PutItem: the
    # once-only LOOK#<cardId> row. UpdateItem: the patch merged into the card.
    # The same four cover Hold for Sarah: its REACH#<id> row is put once, read
    # and updated by the timer, and its card is put like any other.
    actions   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.wick.arn]
  }

  statement {
    sid       = "PushToTheDevice"
    actions   = ["execute-api:ManageConnections"]
    resources = ["${aws_apigatewayv2_api.transport.execution_arn}/*/*"]
  }

  statement {
    sid       = "PublishToTelevisionsOnMqtt"
    actions   = ["iot:Publish"]
    resources = [local.device_topics_arn]
  }
}

resource "aws_iam_role_policy" "agent_card_action_ask_family" {
  name   = "${local.prefix}-agent-card-action-ask-family"
  role   = aws_iam_role.agent_card_action.id
  policy = data.aws_iam_policy_document.agent_card_action_ask_family.json
}

resource "aws_cloudwatch_log_group" "agent_card_action" {
  name              = "/aws/lambda/${local.prefix}-agent-card-action"
  retention_in_days = 14
}

resource "aws_lambda_function" "agent_card_action" {
  function_name = "${local.prefix}-agent-card-action"
  role          = aws_iam_role.agent_card_action.arn
  handler       = "index.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.agent_card_action.output_path
  source_code_hash = data.archive_file.agent_card_action.output_base64sha256

  # The graph's own ceiling is 12s (graphs/doorAction.ts) plus a possible
  # cold runtime session.
  timeout     = 30
  memory_size = 256

  environment {
    variables = {
      AGENT_RUNTIME_ARN     = aws_bedrockagentcore_agent_runtime.agents.agent_runtime_arn
      AGENT_RUNTIME_VERSION = aws_bedrockagentcore_agent_runtime.agents.agent_runtime_version
      # "Ask Sarah to look" reads and writes the household's own rows.
      TABLE_NAME = aws_dynamodb_table.wick.name
      # "Shall I tell Sarah?" reads the night on the household's own clock (rhythm/different.ts).
      WICK_HOUSEHOLD_TZ = var.household_time_zone
      # And nudges the family's own browsers (infra/push.tf). Unset keys mean no nudge, never a failure.
      PUSH_VAPID_SECRET_ARN = aws_secretsmanager_secret.push_vapid.arn
      # Hold for Sarah: where the three-minute timer calls back, as whom, and
      # in which group (infra/reach.tf). The function's own ARN is spelt out
      # because a function cannot refer to itself.
      REACH_TIMER_TARGET_ARN = "arn:aws:lambda:${local.region}:${local.account_id}:function:${local.prefix}-agent-card-action"
      REACH_TIMER_ROLE_ARN   = aws_iam_role.reach_timer.arn
      REACH_TIMER_GROUP      = aws_scheduler_schedule_group.reach.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.agent_card_action]
}

resource "aws_cloudwatch_event_rule" "card_actions" {
  name           = "${local.prefix}-card-actions"
  description    = "Presses the agent plane carries out: the chime, asking the family to look, the answer to 'Shall I tell ...?', and asking to be rung"
  event_bus_name = aws_cloudwatch_event_bus.wick.name

  event_pattern = jsonencode({
    source        = ["wick.device"]
    "detail-type" = ["card.action"]
    detail        = { action = ["hallway_chime", "ask_family", "tell_family", "keep_private", "ring_me", "say_hello"] }
  })
}

resource "aws_cloudwatch_event_target" "card_actions" {
  rule           = aws_cloudwatch_event_rule.card_actions.name
  event_bus_name = aws_cloudwatch_event_bus.wick.name
  arn            = aws_lambda_function.agent_card_action.arn

  # Playback makes a sound in someone's home: never let EventBridge replay a
  # press minutes later. The CHIME# claim makes a retry harmless; this makes
  # it not happen.
  retry_policy {
    maximum_retry_attempts       = 0
    maximum_event_age_in_seconds = 60
  }
}

resource "aws_lambda_permission" "card_actions" {
  statement_id  = "AllowExecutionFromEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.agent_card_action.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.card_actions.arn
}

# ---------------------------------------------------------------------------
# "Shall I tell Sarah?" — the asking.
#
#   TV connects / comes to the front / is being watched
#     -> edge television-active.mjs -> EventBridge (wick.device / television.active)
#     -> agent-card-action -> tell/ask.ts: anything different? -> TELL#<id> -> card -> TV
#
# A question for the resident can only be put while they are at the
# television, so that is when one is looked for — not on a timer over every
# household. The edge sends at most one signal every two minutes per
# television; the question itself is filed once per difference.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "television_active" {
  name           = "${local.prefix}-television-active"
  description    = "A television says its resident is there: the agent plane looks for anything to ask them"
  event_bus_name = aws_cloudwatch_event_bus.wick.name

  event_pattern = jsonencode({
    source        = ["wick.device"]
    "detail-type" = ["television.active"]
  })
}

resource "aws_cloudwatch_event_target" "television_active" {
  rule           = aws_cloudwatch_event_rule.television_active.name
  event_bus_name = aws_cloudwatch_event_bus.wick.name
  arn            = aws_lambda_function.agent_card_action.arn

  # A look that failed is made again at the next signal, two minutes on at
  # the latest. A late replay would only ask about a moment that has passed.
  retry_policy {
    maximum_retry_attempts       = 0
    maximum_event_age_in_seconds = 60
  }
}

resource "aws_lambda_permission" "television_active" {
  statement_id  = "AllowExecutionFromTelevisionActive"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.agent_card_action.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.television_active.arn
}

# ---------------------------------------------------------------------------
# A card finished on one television comes off the others.
#
#   TV press that finishes a card (a note answered, a week read)
#     -> edge card-action-event.mjs -> EventBridge (wick.device / card.retired)
#     -> agent-card-action -> egress.ts withdrawFromDevices -> revoke -> every TV in the home
#
# Without it a second television in the home goes on showing a note that has
# been answered. A television that is off at the time is told when it next
# connects instead (edge device-event.mjs reconcile).
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "card_retired" {
  name           = "${local.prefix}-card-retired"
  description    = "A press finished a card on one television: the agent plane takes it off the home's others"
  event_bus_name = aws_cloudwatch_event_bus.wick.name

  event_pattern = jsonencode({
    source        = ["wick.device"]
    "detail-type" = ["card.retired"]
  })
}

resource "aws_cloudwatch_event_target" "card_retired" {
  rule           = aws_cloudwatch_event_rule.card_retired.name
  event_bus_name = aws_cloudwatch_event_bus.wick.name
  arn            = aws_lambda_function.agent_card_action.arn

  # Not replayed late: a television that missed it is put right when it next
  # connects, and a card sent again in the meantime must not be taken away.
  retry_policy {
    maximum_retry_attempts       = 0
    maximum_event_age_in_seconds = 60
  }
}

resource "aws_lambda_permission" "card_retired" {
  statement_id  = "AllowExecutionFromCardRetired"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.agent_card_action.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.card_retired.arn
}

# ---------------------------------------------------------------------------
# A home screen changed on one television is told to the others.
#
#   TV press that puts the light out, lights it again, or changes what is shared
#     -> edge light.mjs -> EventBridge (wick.device / home.changed)
#     -> agent-card-action -> egress.ts sendHomeToDevices -> every other TV in the home
#
# Without it a second television goes on saying "Light out" after the light
# was lit again in another room. One that is off at the time is told when it
# next connects (edge device-event.mjs reconcile).
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "home_changed" {
  name           = "${local.prefix}-home-changed"
  description    = "The home screen changed on one television: the agent plane tells the home's others"
  event_bus_name = aws_cloudwatch_event_bus.wick.name

  event_pattern = jsonencode({
    source        = ["wick.device"]
    "detail-type" = ["home.changed"]
  })
}

resource "aws_cloudwatch_event_target" "home_changed" {
  rule           = aws_cloudwatch_event_rule.home_changed.name
  event_bus_name = aws_cloudwatch_event_bus.wick.name
  arn            = aws_lambda_function.agent_card_action.arn

  # Not replayed late: a later change would be overwritten by an older one,
  # and a television that missed it is put right when it next connects.
  retry_policy {
    maximum_retry_attempts       = 0
    maximum_event_age_in_seconds = 60
  }
}

resource "aws_lambda_permission" "home_changed" {
  statement_id  = "AllowExecutionFromHomeChanged"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.agent_card_action.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.home_changed.arn
}
