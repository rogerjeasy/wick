# ---------------------------------------------------------------------------
# The edge. Terminates Ring. See docs/WICK-TECHNICAL.md §7.1, §9.1.
#
# The webhook receiver exists to do four things inside Ring's five-second
# acknowledgement budget and nothing else:
#   verify HMAC -> idempotency write -> EventBridge put -> 200
# ---------------------------------------------------------------------------

data "archive_file" "edge_ring" {
  type        = "zip"
  source_dir  = "${path.module}/../services/edge-ring/lambda"
  output_path = "${path.module}/.build/edge-ring.zip"
}

# --- IAM -------------------------------------------------------------------
# Written tighter than a CDK grant would produce: each function gets exactly the
# actions it calls, on exactly the resources it touches.

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "webhook" {
  name               = "${local.prefix}-ring-webhook"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "token" {
  name               = "${local.prefix}-ring-token"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "link" {
  name               = "${local.prefix}-ring-link"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "authorize" {
  name               = "${local.prefix}-ring-authorize"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "basic" {
  for_each = {
    webhook   = aws_iam_role.webhook.name
    token     = aws_iam_role.token.name
    link      = aws_iam_role.link.name
    authorize = aws_iam_role.authorize.name
  }

  role       = each.value
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "webhook" {
  # Idempotency records only. The webhook never reads the timeline and never
  # writes anything else.
  statement {
    sid       = "IdempotencyWrite"
    actions   = ["dynamodb:PutItem"]
    resources = [aws_dynamodb_table.wick.arn]
  }

  statement {
    sid       = "PublishEvents"
    actions   = ["events:PutEvents"]
    resources = [aws_cloudwatch_event_bus.wick.arn]
  }

  statement {
    sid       = "ReadHmacKey"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.ring_credentials.arn]
  }
}

data "aws_iam_policy_document" "token" {
  statement {
    sid       = "ReadClientCredentials"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.ring_credentials.arn]
  }

  statement {
    sid       = "WriteTokens"
    actions   = ["secretsmanager:PutSecretValue", "secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.ring_tokens.arn]
  }
}

resource "aws_iam_role_policy" "webhook" {
  name   = "${local.prefix}-ring-webhook"
  role   = aws_iam_role.webhook.id
  policy = data.aws_iam_policy_document.webhook.json
}

resource "aws_iam_role_policy" "token" {
  name   = "${local.prefix}-ring-token"
  role   = aws_iam_role.token.id
  policy = data.aws_iam_policy_document.token.json
}

data "aws_iam_policy_document" "link" {
  statement {
    sid       = "ConsumePkceState"
    actions   = ["dynamodb:GetItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.wick.arn]
  }

  statement {
    sid       = "ReadClientCredentials"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.ring_credentials.arn]
  }

  statement {
    sid       = "WriteTokens"
    actions   = ["secretsmanager:PutSecretValue"]
    resources = [aws_secretsmanager_secret.ring_tokens.arn]
  }
}

data "aws_iam_policy_document" "authorize" {
  statement {
    sid       = "StorePkceState"
    actions   = ["dynamodb:PutItem"]
    resources = [aws_dynamodb_table.wick.arn]
  }

  statement {
    sid       = "ReadClientId"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.ring_credentials.arn]
  }
}

resource "aws_iam_role_policy" "link" {
  name   = "${local.prefix}-ring-link"
  role   = aws_iam_role.link.id
  policy = data.aws_iam_policy_document.link.json
}

resource "aws_iam_role_policy" "authorize" {
  name   = "${local.prefix}-ring-authorize"
  role   = aws_iam_role.authorize.id
  policy = data.aws_iam_policy_document.authorize.json
}

# --- log groups ------------------------------------------------------------
# Declared explicitly rather than letting Lambda create them implicitly, so
# retention is set from the start instead of defaulting to "never expire".

resource "aws_cloudwatch_log_group" "webhook" {
  name              = "/aws/lambda/${local.prefix}-ring-webhook"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "token" {
  name              = "/aws/lambda/${local.prefix}-ring-token"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "link" {
  name              = "/aws/lambda/${local.prefix}-ring-link"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "authorize" {
  name              = "/aws/lambda/${local.prefix}-ring-authorize"
  retention_in_days = 14
}

# --- functions -------------------------------------------------------------

resource "aws_lambda_function" "webhook" {
  function_name = "${local.prefix}-ring-webhook"
  role          = aws_iam_role.webhook.arn
  handler       = "webhook.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.edge_ring.output_path
  source_code_hash = data.archive_file.edge_ring.output_base64sha256

  # Ring's own budget. Never raise this: a slow ACK is a dropped event.
  timeout     = 5
  memory_size = 256

  # Reserved concurrency deliberately unset. The intent was to stop a downstream
  # problem starving the ACK path, but this account's total Lambda concurrency
  # quota is 10 (new-account default; mature accounts get 1000), so any
  # reservation drops unreserved below the service minimum. Set
  # reserved_concurrent_executions = 20 once the quota is raised.

  environment {
    variables = {
      TABLE_NAME      = aws_dynamodb_table.wick.name
      BUS_NAME        = aws_cloudwatch_event_bus.wick.name
      RING_SECRET_ARN = aws_secretsmanager_secret.ring_credentials.arn
      NODE_OPTIONS    = "--enable-source-maps"
    }
  }

  depends_on = [aws_cloudwatch_log_group.webhook]
}

resource "aws_lambda_function" "token" {
  function_name = "${local.prefix}-ring-token"
  role          = aws_iam_role.token.arn
  handler       = "token.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.edge_ring.output_path
  source_code_hash = data.archive_file.edge_ring.output_base64sha256

  timeout     = 15
  memory_size = 256

  environment {
    variables = {
      RING_SECRET_ARN       = aws_secretsmanager_secret.ring_credentials.arn
      RING_TOKEN_SECRET_ARN = aws_secretsmanager_secret.ring_tokens.arn
    }
  }

  depends_on = [aws_cloudwatch_log_group.token]
}

resource "aws_lambda_function" "link" {
  function_name = "${local.prefix}-ring-link"
  role          = aws_iam_role.link.arn
  handler       = "link.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.edge_ring.output_path
  source_code_hash = data.archive_file.edge_ring.output_base64sha256

  timeout     = 15
  memory_size = 256

  environment {
    variables = {
      CONSENT_PAGE_URL      = var.consent_page_url
      TABLE_NAME            = aws_dynamodb_table.wick.name
      RING_SECRET_ARN       = aws_secretsmanager_secret.ring_credentials.arn
      RING_TOKEN_SECRET_ARN = aws_secretsmanager_secret.ring_tokens.arn
      RING_REDIRECT_URI     = local.ring_redirect_uri
    }
  }

  depends_on = [aws_cloudwatch_log_group.link]
}

resource "aws_lambda_function" "authorize" {
  function_name = "${local.prefix}-ring-authorize"
  role          = aws_iam_role.authorize.arn
  handler       = "authorize.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.edge_ring.output_path
  source_code_hash = data.archive_file.edge_ring.output_base64sha256

  timeout     = 10
  memory_size = 256

  environment {
    variables = {
      TABLE_NAME        = aws_dynamodb_table.wick.name
      RING_SECRET_ARN   = aws_secretsmanager_secret.ring_credentials.arn
      RING_REDIRECT_URI = local.ring_redirect_uri
      RING_SCOPE        = var.ring_scope
    }
  }

  depends_on = [aws_cloudwatch_log_group.authorize]
}

# --- HTTP API --------------------------------------------------------------

resource "aws_apigatewayv2_api" "edge" {
  name          = "${local.prefix}-edge"
  description   = "Ring account linking and event ingress"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.edge.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 50
    throttling_rate_limit  = 100
  }

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api.arn

    # No request body, no headers — an access log for an endpoint carrying
    # household events must not become a second copy of the events.
    format = jsonencode({
      requestId      = "$context.requestId"
      routeKey       = "$context.routeKey"
      status         = "$context.status"
      responseLength = "$context.responseLength"
      latencyMs      = "$context.responseLatency"
      integrationMs  = "$context.integrationLatency"
    })
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/apigateway/${local.prefix}-edge"
  retention_in_days = 14
}

locals {
  routes = {
    "POST /ring/webhook"  = aws_lambda_function.webhook
    "POST /ring/token"    = aws_lambda_function.token
    "GET /ring/link"      = aws_lambda_function.link
    "GET /ring/authorize" = aws_lambda_function.authorize
  }
}

resource "aws_apigatewayv2_integration" "edge" {
  for_each = local.routes

  api_id                 = aws_apigatewayv2_api.edge.id
  integration_type       = "AWS_PROXY"
  integration_uri        = each.value.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "edge" {
  for_each = local.routes

  api_id    = aws_apigatewayv2_api.edge.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.edge[each.key].id}"
}

resource "aws_lambda_permission" "edge" {
  for_each = local.routes

  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = each.value.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.edge.execution_arn}/*/*"
}
