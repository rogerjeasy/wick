# ---------------------------------------------------------------------------
# M2 — "Watch live".
#
#   TV POST /live/sessions (device JWT) -> agent-live -> AgentCore live graph
#     -> async invoke -> live-bridge Lambda: Ring WHEP -> werift -> ffmpeg -> S3 live/
#     -> CloudFront (agentcore.tf) -> the TV's own HLS player
#
# The bridge is a Lambda because it has outbound UDP for WebRTC, and the
# AgentCore microVM doesn't (FRICTION.md FL-017).
#
# This Lambda authenticates (device JWT + DEV# not revoked) and forwards; the
# live graph decides whether that household may watch (a fresh DOOR card).
# ---------------------------------------------------------------------------

data "archive_file" "agent_live" {
  type        = "zip"
  source_dir  = "${path.module}/../services/agent/.build/live"
  output_path = "${path.module}/.build/agent-live.zip"
}

resource "aws_iam_role" "agent_live" {
  name               = "${local.prefix}-agent-live"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "agent_live_basic" {
  role       = aws_iam_role.agent_live.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "agent_live" {
  source_policy_documents = [data.aws_iam_policy_document.invoke_agents.json]

  statement {
    sid       = "VerifyDeviceTokens"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.pairing_signing_key.arn]
  }

  statement {
    sid       = "DeviceNotRevoked"
    actions   = ["dynamodb:GetItem"]
    resources = [aws_dynamodb_table.wick.arn]
  }
}

resource "aws_iam_role_policy" "agent_live" {
  name   = "${local.prefix}-agent-live"
  role   = aws_iam_role.agent_live.id
  policy = data.aws_iam_policy_document.agent_live.json
}

resource "aws_cloudwatch_log_group" "agent_live" {
  name              = "/aws/lambda/${local.prefix}-agent-live"
  retention_in_days = 14
}

resource "aws_lambda_function" "agent_live" {
  function_name = "${local.prefix}-agent-live"
  role          = aws_iam_role.agent_live.arn
  handler       = "index.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.agent_live.output_path
  source_code_hash = data.archive_file.agent_live.output_base64sha256

  # The live graph claims and hands off asynchronously, so this answers in
  # well under a second warm; a cold AgentCore session takes longer. API
  # Gateway's own integration ceiling is 30s.
  timeout     = 25
  memory_size = 256

  environment {
    variables = {
      TABLE_NAME                     = aws_dynamodb_table.wick.name
      PAIRING_SIGNING_KEY_SECRET_ARN = aws_secretsmanager_secret.pairing_signing_key.arn
      AGENT_RUNTIME_ARN              = aws_bedrockagentcore_agent_runtime.agents.agent_runtime_arn
    }
  }

  depends_on = [aws_cloudwatch_log_group.agent_live]
}

locals {
  live_routes = toset(["POST /live/sessions", "DELETE /live/sessions/{sessionId}"])
}

resource "aws_apigatewayv2_integration" "agent_live" {
  api_id                 = aws_apigatewayv2_api.edge.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.agent_live.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "agent_live" {
  for_each = local.live_routes

  api_id    = aws_apigatewayv2_api.edge.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.agent_live.id}"
}

resource "aws_lambda_permission" "agent_live" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.agent_live.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.edge.execution_arn}/*/*"
}

# ---------------------------------------------------------------------------
# The live bridge: arm64 container image (services/agent/bridge.Dockerfile).
# ---------------------------------------------------------------------------

resource "aws_iam_role" "live_bridge" {
  name               = "${local.prefix}-live-bridge"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "live_bridge_basic" {
  role       = aws_iam_role.live_bridge.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "live_bridge" {
  statement {
    sid       = "ReadRingToken"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.ring_tokens.arn]
  }

  statement {
    sid = "LiveClaim"
    # GetItem: poll Back's stop flag on LIVE#active. DeleteItem: give the
    # household's claim back when the stream ends.
    actions   = ["dynamodb:GetItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.wick.arn]
  }

  statement {
    sid       = "PublishLiveHls"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.media.arn}/live/*"]
  }

  statement {
    sid       = "ListLiveHlsForCleanup"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.media.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["live/*"]
    }
  }
}

resource "aws_iam_role_policy" "live_bridge" {
  name   = "${local.prefix}-live-bridge"
  role   = aws_iam_role.live_bridge.id
  policy = data.aws_iam_policy_document.live_bridge.json
}

resource "aws_cloudwatch_log_group" "live_bridge" {
  name              = "/aws/lambda/${local.prefix}-live-bridge"
  retention_in_days = 14
}

resource "aws_lambda_function" "live_bridge" {
  function_name = "${local.prefix}-live-bridge"
  role          = aws_iam_role.live_bridge.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.live_bridge.repository_url}:${var.agent_image_tag}"
  architectures = ["arm64"]

  # Ring's 60s ceiling, plus WHEP setup and cleanup.
  timeout = 120
  # werift is pure JS; ffmpeg only remuxes (-c:v copy). More memory is more CPU.
  memory_size = 1024

  ephemeral_storage {
    size = 1024
  }

  environment {
    variables = {
      TABLE_NAME           = aws_dynamodb_table.wick.name
      MEDIA_BUCKET         = aws_s3_bucket.media.id
      RING_TOKEN_SECRET_ID = aws_secretsmanager_secret.ring_tokens.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.live_bridge, aws_iam_role_policy.live_bridge]
}

# A live view is for someone at the door now: never retry it a minute later.
resource "aws_lambda_function_event_invoke_config" "live_bridge" {
  function_name                = aws_lambda_function.live_bridge.function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 60
}
