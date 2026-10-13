# ---------------------------------------------------------------------------
# The mantelpiece — the family's pictures (packages/contracts/src/mantel.ts).
#
# Someone in the family sends a picture from the family app; it reaches the
# resident's television as a card, and what she keeps lives on her
# mantelpiece. This is where the bytes are.
#
# Not the media bucket: that one holds Ring imagery and its promise is one
# day (INV-3, infra/core.tf). These are the family's own pictures, and how
# long each is kept is hers to decide — so they have a bucket of their own,
# as the films do (infra/programmes.tf).
#
# How long a picture is kept follows what she did with it, and it is the
# bucket that keeps the promise, not application code. Every object carries
# one tag, `state`:
#
#   sent   uploaded, and she has not answered yet (the Wick server writes it
#          with the object)                     -> four hundred days, then gone
#   kept   she pressed "Keep it"; it is on her mantelpiece   -> kept
#   gone   she pressed "Thank you", or took it down later    -> a day, then gone
#
# Four hundred days for a picture not yet answered, because its card does not
# expire: a deferred card waits for as long as it takes (Principle 9: no time
# limits), and a card must not outlive its picture. That is about the life of
# the picture's own row (`PHOTO#<photoId>`, written by the Wick server), so
# the bytes wait for her as long as anything knows the picture was sent.
# Should she answer after even that, there is nothing left to keep: "Keep it"
# then finishes the card and keeps nothing (services/edge-device/lambda
# device-event.mjs answerPhoto).
#
# The edge re-tags on her press (services/edge-device/lambda/mantel.mjs). An
# object's days are counted from when it was uploaded, so a picture she lets
# go of after its first day goes at the bucket's next pass.
#
# Nothing here is public and nothing is read from a browser: the Wick server
# uploads; a television reads one object through an address signed for it,
# good for an hour at most (mantel.ts MANTEL_URL_TTL_SEC) — minted by
# egress.ts when a card is sent and by the edge when the television asks
# (presign.mjs). So: no CORS, no CloudFront, no bucket-policy grant.
#
# Such an address is good for no longer than the credentials that signed it.
# Both signers run on temporary role credentials — App Runner's instance
# role and a Lambda's execution role — which are rotated on the platform's
# clock, not ours: an address signed late in a credential's life ends with
# it, sooner than its hour. Nothing can be done about that here; the
# television asks again when a picture will not load, and is handed a fresh
# one.
#
# Not versioned, on purpose: what she lets go of is to be gone, not kept as
# an earlier version of itself.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "photos" {
  bucket = "${local.prefix}-photos-${local.account_id}"

  # What she has kept is in here.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "photos" {
  bucket                  = aws_s3_bucket.photos.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# No ACLs at all: every object is the bucket owner's, and access is by policy.
resource "aws_s3_bucket_ownership_controls" "photos" {
  bucket = aws_s3_bucket.photos.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "photos" {
  bucket = aws_s3_bucket.photos.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "photos" {
  bucket = aws_s3_bucket.photos.id

  # Sent, and not answered. It waits as long as its card can reasonably be
  # answered — the card itself never expires — and about as long as the
  # picture's own row is kept: see this file's header.
  rule {
    id     = "sent-and-unanswered-400d"
    status = "Enabled"

    filter {
      and {
        prefix = "photos/"
        tags   = { state = "sent" }
      }
    }

    expiration {
      days = 400
    }
  }

  # "Thank you", or taken down: what she did not keep is gone within a day.
  rule {
    id     = "gone-1d"
    status = "Enabled"

    filter {
      and {
        prefix = "photos/"
        tags   = { state = "gone" }
      }
    }

    expiration {
      days = 1
    }
  }

  # `state = kept` has no rule: it is kept until she takes it down.

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_s3_bucket_policy" "photos_tls_only" {
  bucket = aws_s3_bucket.photos.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          aws_s3_bucket.photos.arn,
          "${aws_s3_bucket.photos.arn}/*",
        ]
        Condition = {
          Bool = { "aws:SecureTransport" = "false" }
        }
      },
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.photos]
}

locals {
  # Every picture is `photos/<household>/<id>.jpg` (mantel.ts photoObjectKey).
  # Each role below is given these objects and nothing else of the bucket —
  # not even a listing of it.
  photo_objects_arn = "${aws_s3_bucket.photos.arn}/photos/*"
}

# The Wick server takes a picture in and sends its card (services/mcp-server).
data "aws_iam_policy_document" "apprunner_photos" {
  statement {
    sid = "TakeInAPictureAndSendItsCard"
    # PutObject + PutObjectTagging: the upload, written with `state=sent`.
    # DeleteObject: its own undo, when the row or the card could not be
    # written after the bytes were. GetObject: only to sign the address the
    # card is pushed with (services/agent egress.ts) — the server reads no
    # picture back.
    actions   = ["s3:PutObject", "s3:PutObjectTagging", "s3:DeleteObject", "s3:GetObject"]
    resources = [local.photo_objects_arn]
  }

  statement {
    sid = "LookAtAPictureBeforeItIsSent"
    # Rekognition image moderation, on the bytes it was just handed.
    # DetectModerationLabels has no resource to scope to.
    actions   = ["rekognition:DetectModerationLabels"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "apprunner_photos" {
  name   = "${local.prefix}-apprunner-mcp-photos"
  role   = aws_iam_role.apprunner_instance.id
  policy = data.aws_iam_policy_document.apprunner_photos.json
}

# The two functions that answer a television (infra/transport.tf ws_route,
# infra/iot.tf iot_events) run the same handler and are given the same.
data "aws_iam_policy_document" "edge_photos" {
  statement {
    sid = "SignAPicturesAddressAndTellTheBucketWhatSheDid"
    # GetObject: only to sign an address for the television being answered
    # (presign.mjs) — the function reads no picture. PutObjectTagging: her
    # press — kept, or gone (mantel.mjs retagInput).
    #
    # No DeleteObject: the edge deletes no picture; the rules above do. And
    # no dynamodb:DeleteItem either — a thing taken down is marked and the
    # table clears its row away (mantel.mjs says why).
    actions   = ["s3:GetObject", "s3:PutObjectTagging"]
    resources = [local.photo_objects_arn]
  }
}

resource "aws_iam_role_policy" "ws_route_photos" {
  name   = "${local.prefix}-ws-route-photos"
  role   = aws_iam_role.ws_route.id
  policy = data.aws_iam_policy_document.edge_photos.json
}

resource "aws_iam_role_policy" "iot_events_photos" {
  name   = "${local.prefix}-iot-events-photos"
  role   = aws_iam_role.iot_events.id
  policy = data.aws_iam_policy_document.edge_photos.json
}

output "photos_bucket" {
  description = "Where the family's pictures are kept (PHOTOS_BUCKET)."
  value       = aws_s3_bucket.photos.bucket
}
