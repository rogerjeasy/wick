# ---------------------------------------------------------------------------
# Device transport, option B (§4.1): an API Gateway WebSocket.
#
# The channel every television can fall back to, and the only one the
# background card service uses. Option A — MQTT over IoT Core, tried first —
# is infra/iot.tf. Both end at the same event handler
# (services/edge-device/lambda/device-event.mjs).
# ---------------------------------------------------------------------------

resource "aws_iam_role" "ws_connect" {
  name               = "${local.prefix}-ws-connect"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "ws_disconnect" {
  name               = "${local.prefix}-ws-disconnect"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "ws_route" {
  name               = "${local.prefix}-ws-route"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "ws_basic" {
  for_each = {
    connect    = aws_iam_role.ws_connect.name
    disconnect = aws_iam_role.ws_disconnect.name
    route      = aws_iam_role.ws_route.name
  }
  role       = each.value
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "ws_connect" {
  statement {
    sid = "ReadWriteDeviceAndConnection"
    # GetItem: fast-path denylist check. UpdateItem: the device item's
    # connection fields (connect.mjs uses UpdateItem, not PutItem, so a
    # full-item replace can't clobber pairedAt/denylisted — see the file's
    # own comment). PutItem: the CONN#<id>/META reverse-lookup item.
    # dynamodb:Query is NOT needed here — reconcile moved to route.mjs's
    # $default handler (see route.mjs and the Task 7 fix-round notes in
    # .superpowers/sdd/2026-09-16-s1-device-wiring/progress.md).
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.wick.arn]
  }
  statement {
    sid       = "ReadSigningKey"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.pairing_signing_key.arn]
  }
}

data "aws_iam_policy_document" "ws_disconnect" {
  statement {
    sid       = "ReadUpdateDeleteConnection"
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.wick.arn]
  }
}

data "aws_iam_policy_document" "ws_route" {
  statement {
    sid = "ReadConnectionWriteTimelineAndReconcile"
    # GetItem: CONN#<id>/META lookup, and the television's own DEV# item —
    # a revoked television is refused on every message (device-standing.mjs).
    # PutItem: EVT#<ts>#<uuid> timeline
    # rows. Query: reconcile's bounded CARD# range scan (see the
    # `sk BETWEEN :since AND :max` query in route.mjs). UpdateItem: S6's ADD
    # counter onto RHYTHM#tv_activity bucket items (route.mjs's
    # recordTvActivity) — same table, no separate grant needed.
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.wick.arn]
  }
  statement {
    sid       = "PushReconcileCards"
    actions   = ["execute-api:ManageConnections"]
    resources = ["${aws_apigatewayv2_api.transport.execution_arn}/*/*"]
  }
  statement {
    # M1: a hallway_chime press is handed to the agent plane as
    # wick.device / card.action (route.mjs, card-action-event.mjs).
    sid       = "HandCardActionsToTheAgentPlane"
    actions   = ["events:PutEvents"]
    resources = [aws_cloudwatch_event_bus.wick.arn]
  }
}

resource "aws_iam_role_policy" "ws_connect" {
  name   = "${local.prefix}-ws-connect"
  role   = aws_iam_role.ws_connect.id
  policy = data.aws_iam_policy_document.ws_connect.json
}

resource "aws_iam_role_policy" "ws_disconnect" {
  name   = "${local.prefix}-ws-disconnect"
  role   = aws_iam_role.ws_disconnect.id
  policy = data.aws_iam_policy_document.ws_disconnect.json
}

resource "aws_iam_role_policy" "ws_route" {
  name   = "${local.prefix}-ws-route"
  role   = aws_iam_role.ws_route.id
  policy = data.aws_iam_policy_document.ws_route.json
}

resource "aws_cloudwatch_log_group" "ws_connect" {
  name              = "/aws/lambda/${local.prefix}-ws-connect"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "ws_disconnect" {
  name              = "/aws/lambda/${local.prefix}-ws-disconnect"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "ws_route" {
  name              = "/aws/lambda/${local.prefix}-ws-route"
  retention_in_days = 14
}

resource "aws_lambda_function" "ws_connect" {
  function_name = "${local.prefix}-ws-connect"
  role          = aws_iam_role.ws_connect.arn
  handler       = "connect.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.edge_device.output_path
  source_code_hash = data.archive_file.edge_device.output_base64sha256

  timeout     = 10
  memory_size = 256

  environment {
    variables = {
      TABLE_NAME                     = aws_dynamodb_table.wick.name
      PAIRING_SIGNING_KEY_SECRET_ARN = aws_secretsmanager_secret.pairing_signing_key.arn
    }
  }

  depends_on = [aws_cloudwatch_log_group.ws_connect]
}

resource "aws_lambda_function" "ws_disconnect" {
  function_name = "${local.prefix}-ws-disconnect"
  role          = aws_iam_role.ws_disconnect.arn
  handler       = "disconnect.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.edge_device.output_path
  source_code_hash = data.archive_file.edge_device.output_base64sha256

  timeout     = 10
  memory_size = 256

  environment {
    variables = { TABLE_NAME = aws_dynamodb_table.wick.name }
  }

  depends_on = [aws_cloudwatch_log_group.ws_disconnect]
}

resource "aws_lambda_function" "ws_route" {
  function_name = "${local.prefix}-ws-route"
  role          = aws_iam_role.ws_route.arn
  handler       = "route.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.edge_device.output_path
  source_code_hash = data.archive_file.edge_device.output_base64sha256

  timeout     = 10
  memory_size = 256

  environment {
    variables = {
      TABLE_NAME     = aws_dynamodb_table.wick.name
      EVENT_BUS_NAME = aws_cloudwatch_event_bus.wick.name
      # The light in the window: what "today" means where the house is (light.mjs).
      WICK_HOUSEHOLD_TZ = var.household_time_zone
    }
  }

  depends_on = [aws_cloudwatch_log_group.ws_route]
}

resource "aws_apigatewayv2_api" "transport" {
  name                       = "${local.prefix}-transport"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.action"
}

resource "aws_apigatewayv2_stage" "transport" {
  api_id      = aws_apigatewayv2_api.transport.id
  name        = "prod"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 50
    throttling_rate_limit  = 100
  }
}

locals {
  transport_routes = {
    "$connect"    = aws_lambda_function.ws_connect
    "$disconnect" = aws_lambda_function.ws_disconnect
    "$default"    = aws_lambda_function.ws_route
  }
}

resource "aws_apigatewayv2_integration" "transport" {
  for_each = local.transport_routes

  api_id                    = aws_apigatewayv2_api.transport.id
  integration_type          = "AWS_PROXY"
  integration_uri           = each.value.invoke_arn
  content_handling_strategy = "CONVERT_TO_TEXT"
}

resource "aws_apigatewayv2_route" "transport" {
  for_each = local.transport_routes

  api_id    = aws_apigatewayv2_api.transport.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.transport[each.key].id}"
}

resource "aws_lambda_permission" "transport" {
  for_each = local.transport_routes

  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = each.value.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.transport.execution_arn}/*/*"
}
