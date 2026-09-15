data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  name   = "wick"
  prefix = var.environment == "dev" ? "wick" : "wick-${var.environment}"

  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region

  # Ring validates redirect_uri by exact match against a pre-registered URI. The
  # Account Link URL is what is registered in the console, so it doubles as the
  # OAuth callback — which is why link.mjs branches on the parameters present.
  ring_redirect_uri = "${aws_apigatewayv2_api.edge.api_endpoint}/ring/link"
}
