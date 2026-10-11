# ---------------------------------------------------------------------------
# What the television plays (apps/tv-vega/src/catalog/catalog.ts).
#
# The Blender Foundation's open films (CC BY 3.0), transcoded to HLS by
# scripts/publish-programmes.sh and served from here — so the player's
# position and credits marker, which decide when Wick may speak (§3.4), come
# from an encode this repository made and measured, on a host that will
# still be there when the judges press play.
#
# Not the media bucket: that one holds Ring imagery and discards it within a
# day (INV-3). These files are public works and are kept.
#
# The bucket stays private; CloudFront's Origin Access Control is the only
# reader. HTTPS only — the Vega player drops cleartext HLS silently (FL-016).
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "programmes" {
  bucket = "${local.prefix}-programmes-${local.account_id}"
}

resource "aws_s3_bucket_public_access_block" "programmes" {
  bucket                  = aws_s3_bucket.programmes.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "programmes" {
  bucket = aws_s3_bucket.programmes.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_cloudfront_origin_access_control" "programmes" {
  name                              = "${local.prefix}-programmes"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "programmes" {
  enabled = true
  comment = "Wick — programmes (Blender open films, HLS)"

  origin {
    domain_name              = aws_s3_bucket.programmes.bucket_regional_domain_name
    origin_id                = "programmes-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.programmes.id
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "programmes-s3"
    viewer_protocol_policy = "https-only"
    compress               = true

    # Watching together: the family member's player runs in a browser, on the
    # family app's origin, and a browser's HLS player (hls.js) fetches the
    # playlist and each segment with a cross-origin request. Without this
    # header it is refused. The films are public (CC BY 3.0) and carry no
    # cookie or credential, so any origin may read them: AWS's own
    # Managed-SimpleCORS policy, named by its fixed id.
    response_headers_policy_id = "60669652-455b-4ae9-85a4-c4c02393f86c"

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

resource "aws_s3_bucket_policy" "programmes_cloudfront_only" {
  bucket = aws_s3_bucket.programmes.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontOAC"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.programmes.arn}/*"
      Condition = {
        StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.programmes.arn }
      }
    }]
  })
}
