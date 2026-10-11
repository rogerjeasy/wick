# ---------------------------------------------------------------------------
# The memory plane. See docs/WICK-TECHNICAL.md §8.
#
# Everything here carries prevent_destroy. These hold the household's timeline,
# the Ring credentials and the door imagery — losing them to a stray
# `terraform destroy` is not a recoverable mistake.
# ---------------------------------------------------------------------------

# Single table. Access patterns are narrow and known (§8.1).
resource "aws_dynamodb_table" "wick" {
  name         = local.prefix
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  attribute {
    name = "gsi1pk"
    type = "S"
  }
  attribute {
    name = "gsi1sk"
    type = "S"
  }

  # Webhook idempotency records expire after 24h; card queues and nonces carry
  # their own TTLs.
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  global_secondary_index {
    name            = "gsi1"
    hash_key        = "gsi1pk"
    range_key       = "gsi1sk"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = true
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_cloudwatch_event_bus" "wick" {
  name = local.prefix
}

# ---------------------------------------------------------------------------
# Media. INV-3 IS ENFORCED HERE, NOT IN APPLICATION CODE.
#
# Storage enforcing the promise is the difference between a claim and a
# guarantee. Do not add an application-level copy, cache or backup of a snapshot.
# ---------------------------------------------------------------------------
resource "aws_s3_bucket" "media" {
  bucket = "${local.prefix}-media-${local.account_id}"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "media" {
  bucket = aws_s3_bucket.media.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  # INV-3 — door imagery is discarded within 24 hours.
  rule {
    id     = "snapshots-expire"
    status = "Enabled"

    filter {
      prefix = "snapshots/"
    }

    expiration {
      days = var.snapshot_retention_days
    }

    # Versioning is on, so the non-current version must expire too or the object
    # survives the rule that was supposed to delete it.
    noncurrent_version_expiration {
      noncurrent_days = var.snapshot_retention_days
    }
  }

  # INV-3 — M2's live HLS segments. The bridge deletes its session's prefix
  # when the session ends (services/agent/src/live/bridge.ts); this is the
  # backstop if it never got the chance. Versioning is on, so the delete
  # markers' non-current versions expire too.
  rule {
    id     = "live-expire"
    status = "Enabled"

    filter {
      prefix = "live/"
    }

    expiration {
      days = var.snapshot_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = var.snapshot_retention_days
    }
  }

  rule {
    id     = "voice-30d"
    status = "Enabled"

    filter {
      prefix = "voice/"
    }

    expiration {
      days = 30
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }

  rule {
    id     = "tts-30d"
    status = "Enabled"

    filter {
      prefix = "tts/"
    }

    expiration {
      days = 30
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.media]
}

resource "aws_s3_bucket_policy" "media_tls_only" {
  bucket = aws_s3_bucket.media.id

  # One policy per bucket, so M2's CloudFront grant lives here too — and only
  # for live/*: the door snapshots beside it are never reachable this way.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          aws_s3_bucket.media.arn,
          "${aws_s3_bucket.media.arn}/*",
        ]
        Condition = {
          Bool = { "aws:SecureTransport" = "false" }
        }
      },
      {
        Sid       = "AllowLiveViewThroughCloudFront"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.media.arn}/live/*"
        Condition = {
          StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.live.arn }
        }
      },
    ]
  })
}

locals {
  # Every household's Ring secret is "<prefix>/<householdId>".
  ring_token_secret_prefix = "${local.prefix}/ring/tokens"
  # Secrets Manager appends "-" and six characters to a name to make its ARN.
  # The "/" after "tokens" is what keeps this from matching the superseded
  # single secret, or anything else under ring/.
  ring_token_secrets_arn = "arn:aws:secretsmanager:${local.region}:${local.account_id}:secret:${local.ring_token_secret_prefix}/*"
}

# ---------------------------------------------------------------------------
# Secrets. INV-1: these never reach the television, which holds only a
# device-bound JWT scoped to one household.
#
# Values are populated out of band (scripts/put-ring-secret.sh) — never in code,
# never in the repository, never in Terraform state as plaintext input.
# ---------------------------------------------------------------------------
resource "aws_secretsmanager_secret" "ring_credentials" {
  name        = "${local.prefix}/ring/credentials"
  description = "Ring client id, client secret and HMAC signature key"

  # A short window, because during a hackathon a name collision after deletion is
  # a likelier problem than needing to undo one.
  recovery_window_in_days = 7

  lifecycle {
    prevent_destroy = true
  }
}

# Each household's Ring link is a secret of its own, `<this name>/<householdId>`,
# made by the linking functions when a home's organiser connects Ring
# (services/edge-ring/lambda/ring-token.mjs) — not by Terraform, which cannot
# know which homes will. Everything that reads or writes a link is granted
# that prefix (local.ring_token_secrets_arn) and never this secret.
#
# This one is the single link the deployment had before households had their
# own. Nothing reads it any more. It stays until its record has been moved to
# the operator household's secret (scripts/move-ring-link.sh) and checked.
resource "aws_secretsmanager_secret" "ring_tokens" {
  name        = "${local.prefix}/ring/tokens"
  description = "Superseded: the deployment's single Ring link, before each household had its own under this name."

  recovery_window_in_days = 7

  lifecycle {
    prevent_destroy = true
  }
}

# ---------------------------------------------------------------------------
# Event observability.
#
# Until the agent plane exists, events published to the bus vanish. A catch-all
# rule into a log group makes the whole path visible: a real doorbell press
# should appear here within a second of the webhook returning 200.
#
# This is also what makes the webhook testable end to end before Ring ever sends
# anything real.
# ---------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "events" {
  name              = "/wick/events"
  retention_in_days = 14
}

resource "aws_cloudwatch_event_rule" "all" {
  name           = "${local.prefix}-all-events"
  description    = "Catch-all: mirror every Wick event to CloudWatch Logs"
  event_bus_name = aws_cloudwatch_event_bus.wick.name

  event_pattern = jsonencode({
    source = [{ prefix = "wick." }]
  })
}

resource "aws_cloudwatch_event_target" "logs" {
  rule           = aws_cloudwatch_event_rule.all.name
  event_bus_name = aws_cloudwatch_event_bus.wick.name
  arn            = aws_cloudwatch_log_group.events.arn
}

# EventBridge needs an explicit resource policy to write to a log group.
resource "aws_cloudwatch_log_resource_policy" "events" {
  policy_name = "${local.prefix}-events-to-logs"

  policy_document = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = ["events.amazonaws.com", "delivery.logs.amazonaws.com"]
      }
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "${aws_cloudwatch_log_group.events.arn}:*"
      Condition = {
        ArnEquals = { "aws:SourceArn" = aws_cloudwatch_event_rule.all.arn }
      }
    }]
  })
}
