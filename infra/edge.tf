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

  # The lambda sources are plain .mjs and ship as written; their tests sit
  # beside them and must not.
  excludes = ["__tests__"]
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

resource "aws_iam_role" "refresh" {
  name               = "${local.prefix}-ring-refresh"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "basic" {
  for_each = {
    webhook   = aws_iam_role.webhook.name
    token     = aws_iam_role.token.name
    link      = aws_iam_role.link.name
    authorize = aws_iam_role.authorize.name
    refresh   = aws_iam_role.refresh.name
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

  # Ring calls this itself, with no household: the link it makes is the
  # operator household's, and that is the only secret it may touch. It is on
  # a public route; no other home's link is within its reach.
  statement {
    sid       = "WriteTheOperatorHouseholdsTokens"
    actions   = ["secretsmanager:PutSecretValue", "secretsmanager:GetSecretValue", "secretsmanager:CreateSecret"]
    resources = [local.ring_operator_token_secret_arn]
  }

  statement {
    sid       = "ClaimDevicesAndRecordTheLink"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem"]
    resources = [aws_dynamodb_table.wick.arn]
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
    sid = "ConsumePkceStateClaimDevicesAndRecordTheLink"
    # GetItem/DeleteItem: the state row, which says whose link this is.
    # PutItem: the doorbells that link can see, and the household's link row.
    actions   = ["dynamodb:GetItem", "dynamodb:DeleteItem", "dynamodb:PutItem"]
    resources = [aws_dynamodb_table.wick.arn]
  }

  statement {
    sid       = "ReadClientCredentials"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.ring_credentials.arn]
  }

  # The callback finishes only the operator's own link (where that is allowed
  # at all). A household's link is finished by household-link, below, so this
  # public function needs no other home's secret and has none.
  statement {
    sid       = "ReadWriteTheOperatorHouseholdsTokens"
    actions   = ["secretsmanager:PutSecretValue", "secretsmanager:GetSecretValue", "secretsmanager:CreateSecret"]
    resources = [local.ring_operator_token_secret_arn]
  }
}

# The family app's way to a home's Ring link (household-link.mjs). It has
# the widest rights of the Ring functions — it makes a link and unmakes one —
# and the narrowest door: no route, no schedule, one caller (infra/mcp.tf).
data "aws_iam_policy_document" "household_link" {
  statement {
    sid       = "StatePkceLinkRowAndDeviceClaims"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.wick.arn]
  }

  statement {
    sid       = "ReadClientCredentials"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.ring_credentials.arn]
  }

  statement {
    sid = "MakeAndUnmakeAHouseholdsLink"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:PutSecretValue",
      "secretsmanager:CreateSecret",
      "secretsmanager:DeleteSecret",
    ]
    resources = [local.ring_token_secrets_arn]
  }
}

data "aws_iam_policy_document" "refresh" {
  statement {
    sid       = "ReadClientCredentials"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.ring_credentials.arn]
  }

  statement {
    sid       = "ReadWriteEveryHouseholdsTokens"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"]
    resources = [local.ring_token_secrets_arn]
  }

  statement {
    sid = "FindEveryLinkAndRecordItsExpiry"
    # Scan: the households that have a link (their RING rows).
    actions   = ["dynamodb:Scan", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.wick.arn]
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

resource "aws_iam_role_policy" "refresh" {
  name   = "${local.prefix}-ring-refresh"
  role   = aws_iam_role.refresh.id
  policy = data.aws_iam_policy_document.refresh.json
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

resource "aws_cloudwatch_log_group" "refresh" {
  name              = "/aws/lambda/${local.prefix}-ring-refresh"
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

  # Reserved so a downstream problem can never starve the ACK path: 20 of the
  # account's 1,000 (var.ring_webhook_reserved_concurrency). An account still
  # at the new-account quota of 10 sets it to null, since AWS refuses a
  # reservation that leaves fewer than 10 unreserved.
  reserved_concurrent_executions = var.ring_webhook_reserved_concurrency

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
      TABLE_NAME               = aws_dynamodb_table.wick.name
      RING_SECRET_ARN          = aws_secretsmanager_secret.ring_credentials.arn
      RING_TOKEN_SECRET_PREFIX = local.ring_token_secret_prefix
      RING_REDIRECT_URI        = local.ring_redirect_uri
      # Ring's own call names no household; it can only be the operator's —
      # and it is answered at all only where the deployment says so.
      WICK_HOUSEHOLD_ID  = var.household_id
      RING_OPERATOR_LINK = var.ring_operator_link ? "true" : "false"
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
      CONSENT_PAGE_URL         = var.consent_page_url
      TABLE_NAME               = aws_dynamodb_table.wick.name
      RING_SECRET_ARN          = aws_secretsmanager_secret.ring_credentials.arn
      RING_TOKEN_SECRET_PREFIX = local.ring_token_secret_prefix
      RING_REDIRECT_URI        = local.ring_redirect_uri
      # A callback whose state names no household can only be the operator's,
      # and is taken only where the deployment allows that link.
      WICK_HOUSEHOLD_ID  = var.household_id
      RING_OPERATOR_LINK = var.ring_operator_link ? "true" : "false"
      # A household's own sign-in is not finished by the callback: the browser
      # is sent here, and the family app finishes it as the organiser.
      FAMILY_APP_URL = "https://${aws_cloudfront_distribution.sim_alexa.domain_name}"
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
      # This unauthenticated address links the operator's household and no
      # other — and only where the deployment turns it on.
      WICK_HOUSEHOLD_ID  = var.household_id
      RING_OPERATOR_LINK = var.ring_operator_link ? "true" : "false"
    }
  }

  depends_on = [aws_cloudwatch_log_group.authorize]
}

# --- token keep-alive ------------------------------------------------------
# Ring access tokens live ~4h. Lazy refresh inside getAccessToken() is the
# backstop; this schedule is what keeps a doorbell press at 3am from spending
# its five-second budget on an OAuth round trip.

resource "aws_lambda_function" "refresh" {
  function_name = "${local.prefix}-ring-refresh"
  role          = aws_iam_role.refresh.arn
  handler       = "refresh.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.edge_ring.output_path
  source_code_hash = data.archive_file.edge_ring.output_base64sha256

  timeout     = 15
  memory_size = 256

  environment {
    variables = {
      TABLE_NAME               = aws_dynamodb_table.wick.name
      RING_SECRET_ARN          = aws_secretsmanager_secret.ring_credentials.arn
      RING_TOKEN_SECRET_PREFIX = local.ring_token_secret_prefix
    }
  }

  depends_on = [aws_cloudwatch_log_group.refresh]
}

# --- a household's own link, for the family app ----------------------------
# Not on the HTTP API: the Wick server invokes it (infra/mcp.tf), having
# checked the organiser and taken the household from their token.

resource "aws_iam_role" "household_link" {
  name               = "${local.prefix}-ring-household-link"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "household_link_basic" {
  role       = aws_iam_role.household_link.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "household_link" {
  name   = "${local.prefix}-ring-household-link"
  role   = aws_iam_role.household_link.id
  policy = data.aws_iam_policy_document.household_link.json
}

resource "aws_cloudwatch_log_group" "household_link" {
  name              = "/aws/lambda/${local.prefix}-ring-household-link"
  retention_in_days = 14
}

resource "aws_lambda_function" "household_link" {
  function_name = "${local.prefix}-ring-household-link"
  role          = aws_iam_role.household_link.arn
  handler       = "household-link.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.edge_ring.output_path
  source_code_hash = data.archive_file.edge_ring.output_base64sha256

  # A new household's secret can take a few seconds to be nameable again
  # after a disconnect (ring-token.mjs writeTokens waits that out).
  timeout     = 20
  memory_size = 256

  environment {
    variables = {
      TABLE_NAME               = aws_dynamodb_table.wick.name
      RING_SECRET_ARN          = aws_secretsmanager_secret.ring_credentials.arn
      RING_TOKEN_SECRET_PREFIX = local.ring_token_secret_prefix
      RING_REDIRECT_URI        = local.ring_redirect_uri
      RING_SCOPE               = var.ring_scope
      RING_PLAYGROUND_LINK     = var.ring_playground_link ? "true" : "false"
    }
  }

  depends_on = [aws_cloudwatch_log_group.household_link]
}

# Hourly, not four-hourly: the handler refreshes only inside the skew window, so
# a tick that finds nothing to do costs one Secrets Manager read. Cheap ticks
# buy tolerance for a missed one.
resource "aws_cloudwatch_event_rule" "ring_refresh" {
  name                = "${local.prefix}-ring-refresh"
  description         = "Keep the Ring access token warm"
  schedule_expression = "rate(1 hour)"
}

resource "aws_cloudwatch_event_target" "ring_refresh" {
  rule = aws_cloudwatch_event_rule.ring_refresh.name
  arn  = aws_lambda_function.refresh.arn
}

resource "aws_lambda_permission" "ring_refresh" {
  statement_id  = "AllowExecutionFromEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.refresh.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.ring_refresh.arn
}

# --- HTTP API --------------------------------------------------------------

resource "aws_apigatewayv2_api" "edge" {
  name          = "${local.prefix}-edge"
  description   = "Ring account linking and event ingress"
  protocol_type = "HTTP"

  # Browser-facing routes on this API: GET /status (apps/ops-console's
  # dashboard) and POST /pair/start, POST /pair/claim, GET /pair/status
  # (apps/ops-console's virtual device — infra/pairing.tf). Everything else
  # here is server-to-server (Ring) and never reads a CORS header — API
  # Gateway HTTP APIs apply cors_configuration API-wide, so this is scoped
  # to the methods those browser routes actually use, not a blanket allow.
  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST"]
    allow_headers = ["content-type"]
    max_age       = 300
  }
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
    # apps/ops-console's dashboard data source. See infra/status.tf.
    "GET /status" = aws_lambda_function.status
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
