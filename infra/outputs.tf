# ---------------------------------------------------------------------------
# The three values the Ring developer console needs, plus what the agent plane
# will consume next.
# ---------------------------------------------------------------------------

output "ring_account_link_url" {
  description = "Paste into Ring console -> Account linking -> Account Link URL"
  value       = "${aws_apigatewayv2_api.edge.api_endpoint}/ring/link"
}

output "ring_token_exchange_url" {
  description = "Paste into Ring console -> Account linking -> Token Exchange URL"
  value       = "${aws_apigatewayv2_api.edge.api_endpoint}/ring/token"
}

output "ring_webhook_url" {
  description = "Paste into Ring console -> Account linking -> Webhook URL"
  value       = "${aws_apigatewayv2_api.edge.api_endpoint}/ring/webhook"
}

output "app_homepage_url" {
  description = "Paste into Ring console -> Account linking -> App Homepage URL"
  value       = "https://rogerjeasy.github.io/wick/"
}

output "table_name" {
  value = aws_dynamodb_table.wick.name
}

output "event_bus_name" {
  value = aws_cloudwatch_event_bus.wick.name
}

output "media_bucket" {
  value = aws_s3_bucket.media.bucket
}

output "ring_credentials_secret" {
  description = "Populate with scripts/put-ring-secret.sh — never in code, never in the repo."
  value       = aws_secretsmanager_secret.ring_credentials.name
}

output "ring_tokens_secret" {
  value = aws_secretsmanager_secret.ring_tokens.name
}
