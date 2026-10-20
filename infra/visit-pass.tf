# ---------------------------------------------------------------------------
# The visit pass (packages/contracts visitPass.ts).
#
#   visitor's phone (the family app's visit.html, the token after "#")
#     -> POST /visit/status, POST /visit/say on the edge HTTP API
#     -> wick-visit-pass (services/edge-device visit-pass.mjs)
#          the token's hash finds the visit; what was said is kept on it
#     -> EventBridge, one PutEvents:
#          wick.device / home.changed  -> agent-card-action -> every television's home screen (card-action.tf)
#          wick.visit  / visit.said    -> agent-card-action -> the member is nudged; a door card already up is told
#
# The only routes on the edge that somebody with no account may change
# anything through, so each has a limit of its own, lower than a pairing
# route's (edge.tf edge_route_limits): three buttons, pressed by one person.
# No new AWS service: a Lambda from the edge's own zip, two routes, one rule.
# ---------------------------------------------------------------------------

resource "aws_iam_role" "visit_pass" {
  name               = "${local.prefix}-visit-pass"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "visit_pass_basic" {
  role       = aws_iam_role.visit_pass.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "visit_pass" {
  statement {
    sid = "ReadThePassAndItsVisitKeepWhatWasSaid"
    # GetItem: the VPASS#<hash> row, the visit's ERRAND# row and its author's
    # MEM# row. UpdateItem: the press counted on the pass, and the word kept
    # on the visit and beside its roster entry — each under a condition, so
    # nothing is ever made. Query: the home's own rows and its roster, for
    # her home screen, whole, as device-event.mjs reads it (home.mjs).
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.wick.arn]
  }

  statement {
    sid       = "SayOnTheBusWhatTheVisitorSaid"
    actions   = ["events:PutEvents"]
    resources = [aws_cloudwatch_event_bus.wick.arn]
  }
}

resource "aws_iam_role_policy" "visit_pass" {
  name   = "${local.prefix}-visit-pass"
  role   = aws_iam_role.visit_pass.id
  policy = data.aws_iam_policy_document.visit_pass.json
}

resource "aws_cloudwatch_log_group" "visit_pass" {
  name              = "/aws/lambda/${local.prefix}-visit-pass"
  retention_in_days = 14
}

resource "aws_lambda_function" "visit_pass" {
  function_name = "${local.prefix}-visit-pass"
  role          = aws_iam_role.visit_pass.arn
  handler       = "visit-pass.handler"
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
    }
  }

  depends_on = [aws_cloudwatch_log_group.visit_pass]
}

locals {
  visit_pass_routes = toset(["POST /visit/status", "POST /visit/say"])
}

resource "aws_apigatewayv2_integration" "visit_pass" {
  api_id                 = aws_apigatewayv2_api.edge.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.visit_pass.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "visit_pass" {
  for_each = local.visit_pass_routes

  api_id    = aws_apigatewayv2_api.edge.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.visit_pass.id}"
}

resource "aws_lambda_permission" "visit_pass" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.visit_pass.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.edge.execution_arn}/*/*"
}

# ---------------------------------------------------------------------------
# What the visitor said, heard by the agent plane.
#
#   wick-visit-pass -> EventBridge (wick.visit / visit.said)
#     -> agent-card-action -> services/agent agents/visit/said.ts
#          the member who arranged the visit: a nudge (egress.ts nudgeFamily, push.tf)
#          "I'm at the door" around a ring already carded: that card patched (egress.ts sendPatchToDevice)
#
# Everything it does is what the card-action function already may: read the
# errand and the member's MEM# row, put the once-only VSAID# claim, patch a
# card, find the televisions, push, nudge (card-action.tf, push.tf).
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "visit_said" {
  name           = "${local.prefix}-visit-said"
  description    = "A visitor pressed a button on their visit pass: the member who arranged the visit is told, and a door card already up says who is there"
  event_bus_name = aws_cloudwatch_event_bus.wick.name

  event_pattern = jsonencode({
    source        = ["wick.visit"]
    "detail-type" = ["visit.said"]
  })
}

resource "aws_cloudwatch_event_target" "visit_said" {
  rule           = aws_cloudwatch_event_rule.visit_said.name
  event_bus_name = aws_cloudwatch_event_bus.wick.name
  arn            = aws_lambda_function.agent_card_action.arn

  # Each press is claimed once for its nudge (said.ts visitSaidClaim) and a
  # patch puts a card where it already is, so a retry is harmless. Not
  # replayed late: "I'm at the door" counts for ten minutes either side of
  # a ring, and a nudge about it after that is about a moment that is over.
  retry_policy {
    maximum_retry_attempts       = 2
    maximum_event_age_in_seconds = 300
  }
}

resource "aws_lambda_permission" "visit_said" {
  statement_id  = "AllowExecutionFromVisitSaid"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.agent_card_action.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.visit_said.arn
}
