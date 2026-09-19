# ---------------------------------------------------------------------------
# Device pairing. §4.2. Deployed and confirmed live 2026-09-19: a real Vega
# app on the Vega Virtual Device successfully called POST /pair/start and
# received a real code + claim URL from this stack. The claim URL points at
# docs/pair/ (GitHub Pages) — see that page and docs/404.html for how a
# per-code path is served with no server-side routing.
# ---------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "pairing_signing_key" {
  name        = "${local.prefix}/pairing/signing-key"
  description = "RS256 keypair used to mint and verify device-bound JWTs (INV-1, §4.2)"

  recovery_window_in_days = 7

  lifecycle {
    prevent_destroy = true
  }
}

data "archive_file" "edge_device" {
  type        = "zip"
  source_dir  = "${path.module}/../services/edge-device/lambda"
  output_path = "${path.module}/.build/edge-device.zip"
  excludes    = ["__tests__"]
}

resource "aws_iam_role" "pair_start" {
  name               = "${local.prefix}-pair-start"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "pair_claim" {
  name               = "${local.prefix}-pair-claim"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "pair_status" {
  name               = "${local.prefix}-pair-status"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "pairing_basic" {
  for_each = {
    start  = aws_iam_role.pair_start.name
    claim  = aws_iam_role.pair_claim.name
    status = aws_iam_role.pair_status.name
  }
  role       = each.value
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "pair_start" {
  statement {
    sid       = "WriteNonce"
    actions   = ["dynamodb:PutItem"]
    resources = [aws_dynamodb_table.wick.arn]
  }
}

data "aws_iam_policy_document" "pair_claim" {
  statement {
    sid       = "ReadUpdateNonceAndDevice"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.wick.arn]
  }
  statement {
    sid       = "ReadSigningKey"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.pairing_signing_key.arn]
  }
}

data "aws_iam_policy_document" "pair_status" {
  statement {
    sid       = "ReadDeleteNonce"
    actions   = ["dynamodb:GetItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.wick.arn]
  }
}

resource "aws_iam_role_policy" "pair_start" {
  name   = "${local.prefix}-pair-start"
  role   = aws_iam_role.pair_start.id
  policy = data.aws_iam_policy_document.pair_start.json
}

resource "aws_iam_role_policy" "pair_claim" {
  name   = "${local.prefix}-pair-claim"
  role   = aws_iam_role.pair_claim.id
  policy = data.aws_iam_policy_document.pair_claim.json
}

resource "aws_iam_role_policy" "pair_status" {
  name   = "${local.prefix}-pair-status"
  role   = aws_iam_role.pair_status.id
  policy = data.aws_iam_policy_document.pair_status.json
}

resource "aws_cloudwatch_log_group" "pair_start" {
  name              = "/aws/lambda/${local.prefix}-pair-start"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "pair_claim" {
  name              = "/aws/lambda/${local.prefix}-pair-claim"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "pair_status" {
  name              = "/aws/lambda/${local.prefix}-pair-status"
  retention_in_days = 14
}

resource "aws_lambda_function" "pair_start" {
  function_name = "${local.prefix}-pair-start"
  role          = aws_iam_role.pair_start.arn
  handler       = "pair-start.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.edge_device.output_path
  source_code_hash = data.archive_file.edge_device.output_base64sha256

  timeout     = 10
  memory_size = 256

  environment {
    variables = {
      TABLE_NAME       = aws_dynamodb_table.wick.name
      PAIRING_URL_BASE = var.pairing_url_base
    }
  }

  depends_on = [aws_cloudwatch_log_group.pair_start]
}

resource "aws_lambda_function" "pair_claim" {
  function_name = "${local.prefix}-pair-claim"
  role          = aws_iam_role.pair_claim.arn
  handler       = "pair-claim.handler"
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

  depends_on = [aws_cloudwatch_log_group.pair_claim]
}

resource "aws_lambda_function" "pair_status" {
  function_name = "${local.prefix}-pair-status"
  role          = aws_iam_role.pair_status.arn
  handler       = "pair-status.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.edge_device.output_path
  source_code_hash = data.archive_file.edge_device.output_base64sha256

  timeout     = 10
  memory_size = 256

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.wick.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.pair_status]
}

locals {
  pairing_routes = {
    "POST /pair/start" = aws_lambda_function.pair_start
    "POST /pair/claim" = aws_lambda_function.pair_claim
    "GET /pair/status" = aws_lambda_function.pair_status
  }
}

resource "aws_apigatewayv2_integration" "pairing" {
  for_each = local.pairing_routes

  api_id                 = aws_apigatewayv2_api.edge.id
  integration_type       = "AWS_PROXY"
  integration_uri        = each.value.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "pairing" {
  for_each = local.pairing_routes

  api_id    = aws_apigatewayv2_api.edge.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.pairing[each.key].id}"
}

resource "aws_lambda_permission" "pairing" {
  for_each = local.pairing_routes

  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = each.value.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.edge.execution_arn}/*/*"
}
