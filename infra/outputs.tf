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

output "ring_authorize_url" {
  description = "Open this in a browser to start the partner-initiated OAuth flow."
  value       = "${aws_apigatewayv2_api.edge.api_endpoint}/ring/authorize"
}

output "pairing_api_url" {
  description = "Set as apps/tv-vega/src/config.ts DEPLOYED.pairingApiUrl"
  value       = aws_apigatewayv2_api.edge.api_endpoint
}

output "cognito_user_pool_id" {
  description = "Where family accounts live (infra/accounts.tf)."
  value       = aws_cognito_user_pool.family.id
}

output "cognito_client_id" {
  description = "Set as WICK_COGNITO_CLIENT_ID to run services/mcp-server locally."
  value       = aws_cognito_user_pool_client.wick.id
}

output "pairing_signing_key_secret" {
  description = "Populate with infra/bootstrap/generate-pairing-key.sh"
  value       = aws_secretsmanager_secret.pairing_signing_key.name
}

output "websocket_url" {
  description = "Set as apps/tv-vega/src/config.ts DEPLOYED.websocketUrl"
  value       = aws_apigatewayv2_stage.transport.invoke_url
}

output "mqtt_wss_url" {
  description = "Option A (§4.1): where a television opens MQTT over WSS, with the custom authorizer named. The television adds &token=<its device token>. Goes in apps/tv-vega/src/config.ts as mqttWssUrl; absent there, a television never tries MQTT."
  value       = "wss://${data.aws_iot_endpoint.data.endpoint_address}/mqtt?x-amz-customauthorizer-name=${aws_iot_authorizer.device.name}"
}

output "mcp_server_url" {
  description = "The deployed MCP server (S4a). On first apply this is set from var.mcp_issuer_url's empty default — read this value, then re-apply with -var mcp_issuer_url=<this> so the app's own OAuth metadata matches its real URL. See infra/mcp.tf."
  value       = "https://${aws_apprunner_service.mcp_server.service_url}"
}

output "mcp_service_arn" {
  description = "For `aws apprunner describe-service --service-arn` while watching a redeploy."
  value       = aws_apprunner_service.mcp_server.arn
}

output "sim_alexa_url" {
  description = "The deployed simulated Alexa+ surface (apps/sim-alexa). Its 'MCP server URL' field is pre-filled with mcp_server_url at upload time."
  value       = "https://${aws_cloudfront_distribution.sim_alexa.domain_name}"
}

output "ops_console_url" {
  description = "Wick ops console — status dashboard (/) and virtual device (/device.html)."
  value       = "https://${aws_cloudfront_distribution.ops_console.domain_name}"
}

output "ops_console_distribution_id" {
  description = "For `aws cloudfront create-invalidation --distribution-id` after redeploying ops-console's files."
  value       = aws_cloudfront_distribution.ops_console.id
}

output "status_api_url" {
  description = "GET /status — raw JSON, for curl or a browser tab."
  value       = "${aws_apigatewayv2_api.edge.api_endpoint}/status"
}

output "sim_alexa_distribution_id" {
  description = "For `aws cloudfront create-invalidation --distribution-id` after redeploying sim-alexa's files."
  value       = aws_cloudfront_distribution.sim_alexa.id
}

output "agents_runtime_arn" {
  description = "The wick_agents AgentCore Runtime (Strands graphs: door describe, hallway chime, live view)"
  value       = aws_bedrockagentcore_agent_runtime.agents.agent_runtime_arn
}

output "agents_ecr_repository_url" {
  description = "Push services/agent/Dockerfile here (scripts/push-agent-image.sh)"
  value       = aws_ecr_repository.agents.repository_url
}

output "live_origin" {
  description = "M2: HTTPS origin the TV's player loads live HLS from"
  value       = "https://${aws_cloudfront_distribution.live.domain_name}"
}

output "programmes_origin" {
  description = "HTTPS origin the TV's player loads its programmes from. Goes in apps/tv-vega/src/catalog/catalog.ts (PROGRAMMES_ORIGIN)."
  value       = "https://${aws_cloudfront_distribution.programmes.domain_name}"
}

output "programmes_bucket" {
  description = "Where scripts/publish-programmes.sh uploads the transcoded films."
  value       = aws_s3_bucket.programmes.bucket
}
