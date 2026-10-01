# ---------------------------------------------------------------------------
# M1 — "Ring the hallway chime".
#
#   TV card_action -> ws route.mjs -> EventBridge (wick.device / card.action)
#     -> agent-card-action (this shim) -> AgentCore door-action graph
#     -> Ring Chime playback -> patch -> TV
#
# A shim because EventBridge cannot target an AgentCore Runtime. No model in
# this path (spec D4): the graph's nodes are deterministic.
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
      AGENT_RUNTIME_ARN = aws_bedrockagentcore_agent_runtime.agents.agent_runtime_arn
    }
  }

  depends_on = [aws_cloudwatch_log_group.agent_card_action]
}

resource "aws_cloudwatch_event_rule" "card_actions" {
  name           = "${local.prefix}-card-actions"
  description    = "Door Card presses the agent plane carries out (M1)"
  event_bus_name = aws_cloudwatch_event_bus.wick.name

  event_pattern = jsonencode({
    source        = ["wick.device"]
    "detail-type" = ["card.action"]
    detail        = { action = ["hallway_chime"] }
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
