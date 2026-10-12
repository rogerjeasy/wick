# ---------------------------------------------------------------------------
# Device transport, option A (§4.1): MQTT over AWS IoT Core.
#
# A television tries this first and falls back to the API Gateway WebSocket
# (infra/transport.tf), which stays exactly as it is. Nothing here issues a
# credential: a television proves itself with the device token it already
# holds (INV-1), which the custom authorizer checks.
#
#   television ──wss…/mqtt?x-amz-customauthorizer-name=…&token=…──▶ IoT Core
#     authorizer Lambda  → that television's own three topics, nothing else
#     presence rule      → the HH#/DEV# row says the television is on MQTT
#     events rule        → the same handler the WebSocket's $default runs
#   senders (egress.ts)  → iot:Publish to wick/device/<id>/cards | control
# ---------------------------------------------------------------------------

locals {
  # Every television's topics. A sender publishes to one television's; the
  # television itself is held to its own by the authorizer's policy
  # (services/edge-device/lambda/iot-policy.mjs).
  device_topics_arn = "arn:aws:iot:${local.region}:${local.account_id}:topic/wick/device/*"

  # IoT rule names take letters, digits and underscores only.
  iot_rule_prefix = replace(local.prefix, "-", "_")
}

data "aws_iot_endpoint" "data" {
  endpoint_type = "iot:Data-ATS"
}

# --- roles -----------------------------------------------------------------

resource "aws_iam_role" "iot_authorize" {
  name               = "${local.prefix}-iot-authorize"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "iot_presence" {
  name               = "${local.prefix}-iot-presence"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "iot_events" {
  name               = "${local.prefix}-iot-events"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "iot_basic" {
  for_each = {
    authorize = aws_iam_role.iot_authorize.name
    presence  = aws_iam_role.iot_presence.name
    events    = aws_iam_role.iot_events.name
  }
  role       = each.value
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "iot_authorize" {
  statement {
    sid       = "ReadTheTelevisionsStanding"
    actions   = ["dynamodb:GetItem"]
    resources = [aws_dynamodb_table.wick.arn]
  }
  statement {
    sid       = "ReadSigningKey"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.pairing_signing_key.arn]
  }
}

data "aws_iam_policy_document" "iot_presence" {
  statement {
    sid       = "FindTheHouseholdAndRecordTheConnection"
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.wick.arn]
  }
}

# The WebSocket route's rights (infra/transport.tf ws_route), with a publish
# to the television's own topic in place of a post to its connection.
data "aws_iam_policy_document" "iot_events" {
  statement {
    sid       = "ReadTheTelevisionWriteTimelineAndReconcile"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.wick.arn]
  }
  statement {
    sid       = "PushReconcileCards"
    actions   = ["iot:Publish"]
    resources = [local.device_topics_arn]
  }
  statement {
    sid       = "HandCardActionsToTheAgentPlane"
    actions   = ["events:PutEvents"]
    resources = [aws_cloudwatch_event_bus.wick.arn]
  }
}

resource "aws_iam_role_policy" "iot_authorize" {
  name   = "${local.prefix}-iot-authorize"
  role   = aws_iam_role.iot_authorize.id
  policy = data.aws_iam_policy_document.iot_authorize.json
}

resource "aws_iam_role_policy" "iot_presence" {
  name   = "${local.prefix}-iot-presence"
  role   = aws_iam_role.iot_presence.id
  policy = data.aws_iam_policy_document.iot_presence.json
}

resource "aws_iam_role_policy" "iot_events" {
  name   = "${local.prefix}-iot-events"
  role   = aws_iam_role.iot_events.id
  policy = data.aws_iam_policy_document.iot_events.json
}

# --- functions -------------------------------------------------------------

resource "aws_cloudwatch_log_group" "iot_authorize" {
  name              = "/aws/lambda/${local.prefix}-iot-authorize"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "iot_presence" {
  name              = "/aws/lambda/${local.prefix}-iot-presence"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "iot_events" {
  name              = "/aws/lambda/${local.prefix}-iot-events"
  retention_in_days = 14
}

resource "aws_lambda_function" "iot_authorize" {
  function_name = "${local.prefix}-iot-authorize"
  role          = aws_iam_role.iot_authorize.arn
  handler       = "iot-authorize.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.edge_device.output_path
  source_code_hash = data.archive_file.edge_device.output_base64sha256

  # IoT Core waits five seconds for an authorizer and refuses the connection
  # after that; stay well inside it.
  timeout     = 5
  memory_size = 256

  environment {
    variables = {
      TABLE_NAME                     = aws_dynamodb_table.wick.name
      PAIRING_SIGNING_KEY_SECRET_ARN = aws_secretsmanager_secret.pairing_signing_key.arn
    }
  }

  depends_on = [aws_cloudwatch_log_group.iot_authorize]
}

resource "aws_lambda_function" "iot_presence" {
  function_name = "${local.prefix}-iot-presence"
  role          = aws_iam_role.iot_presence.arn
  handler       = "iot-presence.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.edge_device.output_path
  source_code_hash = data.archive_file.edge_device.output_base64sha256

  timeout     = 10
  memory_size = 256

  environment {
    variables = { TABLE_NAME = aws_dynamodb_table.wick.name }
  }

  depends_on = [aws_cloudwatch_log_group.iot_presence]
}

resource "aws_lambda_function" "iot_events" {
  function_name = "${local.prefix}-iot-events"
  role          = aws_iam_role.iot_events.arn
  handler       = "iot-events.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.edge_device.output_path
  source_code_hash = data.archive_file.edge_device.output_base64sha256

  timeout     = 10
  memory_size = 256

  # The same three the WebSocket route is given: it runs the same handler.
  environment {
    variables = {
      TABLE_NAME       = aws_dynamodb_table.wick.name
      EVENT_BUS_NAME   = aws_cloudwatch_event_bus.wick.name
      WICK_FAMILY_NAME = var.family_name
      # The light in the window: what "today" means where the house is (light.mjs).
      WICK_HOUSEHOLD_TZ = var.household_time_zone
    }
  }

  depends_on = [aws_cloudwatch_log_group.iot_events]
}

# --- IoT Core --------------------------------------------------------------

# Token signing is off: the token IS a signed JWT, verified by the function
# with the pairing key. IoT Core's own signature would be a second signature
# over the same thing, made with a key the television would have to hold.
resource "aws_iot_authorizer" "device" {
  name                    = "${local.prefix}-device"
  authorizer_function_arn = aws_lambda_function.iot_authorize.arn
  signing_disabled        = true
  status                  = "ACTIVE"
}

resource "aws_lambda_permission" "iot_authorize" {
  statement_id  = "AllowIoTCoreToAuthorize"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.iot_authorize.function_name
  principal     = "iot.amazonaws.com"
  source_arn    = aws_iot_authorizer.device.arn
}

# What a television sends. The id comes from the topic — which only that
# television may publish to — and the body is passed through untouched
# (base64), so a body that is not JSON is the function's to refuse.
resource "aws_iot_topic_rule" "device_events" {
  name        = "${local.iot_rule_prefix}_device_events"
  description = "DeviceEvents from televisions on MQTT, to the handler the WebSocket shares."
  enabled     = true
  sql         = "SELECT encode(*, 'base64') AS payload, topic(3) AS deviceId FROM 'wick/device/+/events'"
  sql_version = "2016-03-23"

  lambda {
    function_arn = aws_lambda_function.iot_events.arn
  }
}

resource "aws_lambda_permission" "iot_events" {
  statement_id  = "AllowIoTRuleToInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.iot_events.function_name
  principal     = "iot.amazonaws.com"
  source_arn    = aws_iot_topic_rule.device_events.arn
}

# IoT Core's own connect and disconnect events, for every client in the
# account. The function ignores any client that is not a paired television.
resource "aws_iot_topic_rule" "device_presence" {
  name        = "${local.iot_rule_prefix}_device_presence"
  description = "Which televisions are on MQTT right now."
  enabled     = true
  sql         = "SELECT * FROM '$aws/events/presence/+/+'"
  sql_version = "2016-03-23"

  lambda {
    function_arn = aws_lambda_function.iot_presence.arn
  }
}

resource "aws_lambda_permission" "iot_presence" {
  statement_id  = "AllowIoTRuleToInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.iot_presence.function_name
  principal     = "iot.amazonaws.com"
  source_arn    = aws_iot_topic_rule.device_presence.arn
}
