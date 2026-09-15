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

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
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
    }]
  })
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

resource "aws_secretsmanager_secret" "ring_tokens" {
  name        = "${local.prefix}/ring/tokens"
  description = "Ring OAuth access and refresh tokens, written at account linking"

  recovery_window_in_days = 7

  lifecycle {
    prevent_destroy = true
  }
}
