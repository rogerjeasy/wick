# ---------------------------------------------------------------------------
# The agent plane on Bedrock AgentCore Runtime: one container, Strands graphs.
#
#   door.describe  vision Agent (Nova Lite) -> validate       Phase 2b
#   door.action    gate -> ring -> notify (no model)          M1 hallway chime
#   live.start     gate -> start bridge (no model)            M2 Watch live
#   live.stop      the resident pressed Back
#
# Session = household (services/agent/src/runtime/invoke.ts): AgentCore runs
# each session in its own microVM, so the household is the isolation boundary.
# The M2 live bridge (werift + ffmpeg) runs inside that session after
# live.start answers; /ping says HealthyBusy until it ends.
#
# Deploy order (the runtime needs an image to exist):
#   1. terraform apply -target=aws_ecr_repository.agents
#   2. scripts/push-agent-image.sh   (builds services/agent/Dockerfile, arm64)
#   3. terraform apply
# ---------------------------------------------------------------------------

resource "aws_ecr_repository" "agents" {
  name                 = "${local.prefix}-agents"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "agents" {
  repository = aws_ecr_repository.agents.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the 10 most recent runtime images."
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}

data "aws_iam_policy_document" "agentcore_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["bedrock-agentcore.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "agents_runtime" {
  name               = "${local.prefix}-agents-runtime"
  assume_role_policy = data.aws_iam_policy_document.agentcore_assume.json
}

data "aws_iam_policy_document" "agents_runtime" {
  statement {
    sid       = "PullTheImage"
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    resources = [aws_ecr_repository.agents.arn]
  }

  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
    resources = ["arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/bedrock-agentcore/runtimes/*"]
  }

  statement {
    sid       = "Metrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["bedrock-agentcore"]
    }
  }

  statement {
    sid       = "ReadRingToken"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.ring_tokens.arn]
  }

  statement {
    sid = "CardsClaimsAndPatches"
    # GetItem: the CARD# a press or a live view is for. PutItem: M1's
    # CHIME#<cardId> once-only claim. UpdateItem + Query: sendPatchToDevice's
    # merge and its device-connection lookup.
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.wick.arn]
  }

  statement {
    sid       = "PushPatchesToTheTv"
    actions   = ["execute-api:ManageConnections"]
    resources = ["${aws_apigatewayv2_api.transport.execution_arn}/*/*"]
  }

  statement {
    sid = "DescribeTheDoorFrame"
    # Strands' BedrockModel streams (ConverseStream).
    actions   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
    resources = ["arn:aws:bedrock:${local.region}::foundation-model/amazon.nova-lite-v1:0"]
  }

  statement {
    sid       = "PublishLiveHls"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.media.arn}/live/*"]
  }

  statement {
    sid       = "ListLiveHlsForCleanup"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.media.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["live/*"]
    }
  }
}

resource "aws_iam_role_policy" "agents_runtime" {
  name   = "${local.prefix}-agents-runtime"
  role   = aws_iam_role.agents_runtime.id
  policy = data.aws_iam_policy_document.agents_runtime.json
}

resource "aws_bedrockagentcore_agent_runtime" "agents" {
  agent_runtime_name = "${replace(local.prefix, "-", "_")}_agents"
  description        = "Wick's Strands graphs: door describe, hallway chime, live view"
  role_arn           = aws_iam_role.agents_runtime.arn

  agent_runtime_artifact {
    container_configuration {
      container_uri = "${aws_ecr_repository.agents.repository_url}:${var.agent_image_tag}"
    }
  }

  # Ring's API, Bedrock, and WebRTC to Ring's media servers (STUN/UDP) all
  # leave from here — PUBLIC is the mode with internet egress.
  network_configuration {
    network_mode = "PUBLIC"
  }

  protocol_configuration {
    server_protocol = "HTTP"
  }

  lifecycle_configuration {
    # A household's session stays warm between the door event and the press
    # that follows it; nothing in it needs to outlive an evening.
    idle_runtime_session_timeout = 900
    max_lifetime                 = 28800
  }

  environment_variables = {
    TABLE_NAME            = aws_dynamodb_table.wick.name
    MEDIA_BUCKET          = aws_s3_bucket.media.id
    LIVE_ORIGIN           = "https://${aws_cloudfront_distribution.live.domain_name}"
    RING_TOKEN_SECRET_ID  = aws_secretsmanager_secret.ring_tokens.name
    WICK_CHIME_SLOT_EVENT = var.chime_slot_event
  }

  depends_on = [aws_iam_role_policy.agents_runtime]
}

# What the shims (door, card-action, live) may call.
data "aws_iam_policy_document" "invoke_agents" {
  statement {
    sid     = "InvokeTheAgentPlane"
    actions = ["bedrock-agentcore:InvokeAgentRuntime"]
    resources = [
      aws_bedrockagentcore_agent_runtime.agents.agent_runtime_arn,
      "${aws_bedrockagentcore_agent_runtime.agents.agent_runtime_arn}/*",
    ]
  }
}

# ---------------------------------------------------------------------------
# M2 delivery: CloudFront in front of the media bucket's live/ prefix only.
# HTTPS is not optional — the TV's player refuses cleartext HLS silently
# (FL-016). The playlist is served uncached (the bridge rewrites it every
# second) and segments for at most a minute: both follow the Cache-Control
# the bridge sets on upload.
# ---------------------------------------------------------------------------

resource "aws_cloudfront_origin_access_control" "live" {
  name                              = "${local.prefix}-live"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "live" {
  enabled = true
  comment = "Wick — live view HLS (live/*), M2"

  origin {
    domain_name              = aws_s3_bucket.media.bucket_regional_domain_name
    origin_id                = "media-live"
    origin_access_control_id = aws_cloudfront_origin_access_control.live.id
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "media-live"
    viewer_protocol_policy = "https-only"

    min_ttl     = 0
    default_ttl = 0
    max_ttl     = 60

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
