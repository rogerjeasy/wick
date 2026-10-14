# ---------------------------------------------------------------------------
# GET /status — the ops-console dashboard's one data source. See
# services/edge-ring/lambda/status.mjs's header for the full reasoning.
#
# Read-only, narrowly scoped: this Lambda can look at things, never change
# them. It shares edge.tf's Ring webhook zip (archive_file.edge_ring) rather
# than getting its own — see status.mjs's header for why.
# ---------------------------------------------------------------------------

resource "aws_iam_role" "status" {
  name               = "${local.prefix}-status"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "status_basic" {
  role       = aws_iam_role.status.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "status" {
  statement {
    sid       = "CountTimelineAndRhythmRows"
    actions   = ["dynamodb:Query"]
    resources = [aws_dynamodb_table.wick.arn]
  }

  # That the operator household's Ring secret exists and when it last
  # changed — never its value. This function answers a public,
  # unauthenticated route; it used to hold GetSecretValue on the household's
  # Ring tokens to work out an expiry. The expiry is on the household's RING
  # row now (Query, above), and DescribeSecret covers a token stored from a
  # laptop, which writes no row.
  statement {
    sid       = "SeeThatTheRingLinkExistsNeverItsValue"
    actions   = ["secretsmanager:DescribeSecret"]
    resources = [local.ring_operator_token_secret_arn]
  }

  statement {
    sid       = "CountTheDeadLetters"
    actions   = ["sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.dead_letters.arn]
  }

  statement {
    sid       = "ReadRefreshScheduleState"
    actions   = ["events:DescribeRule"]
    resources = [aws_cloudwatch_event_rule.ring_refresh.arn]
  }

  statement {
    sid       = "ReadMcpServiceState"
    actions   = ["apprunner:DescribeService"]
    resources = [aws_apprunner_service.mcp_server.arn]
  }
}

resource "aws_iam_role_policy" "status" {
  name   = "${local.prefix}-status"
  role   = aws_iam_role.status.id
  policy = data.aws_iam_policy_document.status.json
}

resource "aws_cloudwatch_log_group" "status" {
  name              = "/aws/lambda/${local.prefix}-status"
  retention_in_days = 14
}

resource "aws_lambda_function" "status" {
  function_name = "${local.prefix}-status"
  role          = aws_iam_role.status.arn
  handler       = "status.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.edge_ring.output_path
  source_code_hash = data.archive_file.edge_ring.output_base64sha256

  # Seven outbound HTTPS checks run in parallel (Promise.all), each with its
  # own 5s internal timeout — 15s covers the worst case plus the AWS API
  # calls alongside them.
  timeout     = 15
  memory_size = 256

  environment {
    variables = {
      TABLE_NAME               = aws_dynamodb_table.wick.name
      WICK_HOUSEHOLD_ID        = var.household_id
      RING_TOKEN_SECRET_PREFIX = local.ring_token_secret_prefix
      MCP_SERVICE_ARN          = aws_apprunner_service.mcp_server.arn
      RING_REFRESH_RULE_NAME   = aws_cloudwatch_event_rule.ring_refresh.name
      MCP_SERVER_URL           = "https://${aws_apprunner_service.mcp_server.service_url}"
      SIM_ALEXA_URL            = "https://${aws_cloudfront_distribution.sim_alexa.domain_name}"
      RING_AUTHORIZE_URL       = "${aws_apigatewayv2_api.edge.api_endpoint}/ring/authorize"
      # What /ring/authorize should answer: 404 in the edge's words when off.
      RING_OPERATOR_LINK  = var.ring_operator_link ? "true" : "false"
      DOOR_DLQ_URL        = aws_sqs_queue.dead_letters.url
      RING_WEBHOOK_URL    = "${aws_apigatewayv2_api.edge.api_endpoint}/ring/webhook"
      PAIRING_API_URL     = aws_apigatewayv2_api.edge.api_endpoint
      WEBSOCKET_HTTPS_URL = replace(aws_apigatewayv2_stage.transport.invoke_url, "wss://", "https://")
    }
  }

  depends_on = [aws_cloudwatch_log_group.status]
}
