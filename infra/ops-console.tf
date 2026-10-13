# ---------------------------------------------------------------------------
# The ops console — apps/ops-console. Two dev/demo tools, not part of the
# product submission itself: a production status dashboard and a
# browser-based virtual device (replaces docs/*.md's curl/wscat sequences
# with clicks). Same pattern as sim-alexa (infra/sim-alexa.tf): private S3
# behind CloudFront, no server-side code of its own — everything dynamic
# happens against the real deployed APIs (infra/status.tf, infra/pairing.tf,
# infra/transport.tf).
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "ops_console" {
  bucket = "${local.prefix}-ops-console-${local.account_id}"
}

resource "aws_s3_bucket_public_access_block" "ops_console" {
  bucket                  = aws_s3_bucket.ops_console.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "ops_console" {
  bucket = aws_s3_bucket.ops_console.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

locals {
  # Both placeholder substitutions live here, once, rather than duplicated
  # per aws_s3_object resource below.
  ops_console_status_js = replace(
    file("${path.module}/../apps/ops-console/status.js"),
    "STATUS_API_BASE_URL_PLACEHOLDER",
    aws_apigatewayv2_api.edge.api_endpoint,
  )

  ops_console_device_js = replace(
    replace(
      replace(
        replace(
          file("${path.module}/../apps/ops-console/device.js"),
          "PAIRING_API_URL_PLACEHOLDER",
          aws_apigatewayv2_api.edge.api_endpoint,
        ),
        "WEBSOCKET_URL_PLACEHOLDER",
        aws_apigatewayv2_stage.transport.invoke_url,
      ),
      # Watching together: the virtual television plays the same films from the same place (infra/programmes.tf).
      "PROGRAMMES_ORIGIN_PLACEHOLDER",
      "https://${aws_cloudfront_distribution.programmes.domain_name}",
    ),
    # A family member's own television asks the Wick server for its home screen (GET /tv/home), as sim-alexa.tf names it.
    "WICK_SERVER_URL_PLACEHOLDER",
    "https://${aws_apprunner_service.mcp_server.service_url}",
  )
}

# Every file is revalidated on each load (`no-cache`), as the family app's
# are. With no header at all a browser guesses how long a copy stays fresh,
# and a virtual television that had been opened before went on running last
# week's script: it was sent a card it had since been taught and said it did
# not recognise it.
resource "aws_s3_object" "ops_console_index" {
  bucket        = aws_s3_bucket.ops_console.id
  key           = "index.html"
  source        = "${path.module}/../apps/ops-console/index.html"
  etag          = filemd5("${path.module}/../apps/ops-console/index.html")
  content_type  = "text/html; charset=utf-8"
  cache_control = "no-cache"
}

resource "aws_s3_object" "ops_console_device_html" {
  bucket        = aws_s3_bucket.ops_console.id
  key           = "device.html"
  source        = "${path.module}/../apps/ops-console/device.html"
  etag          = filemd5("${path.module}/../apps/ops-console/device.html")
  content_type  = "text/html; charset=utf-8"
  cache_control = "no-cache"
}

resource "aws_s3_object" "ops_console_styles_css" {
  bucket        = aws_s3_bucket.ops_console.id
  key           = "styles.css"
  source        = "${path.module}/../apps/ops-console/styles.css"
  etag          = filemd5("${path.module}/../apps/ops-console/styles.css")
  content_type  = "text/css; charset=utf-8"
  cache_control = "no-cache"
}

resource "aws_s3_object" "ops_console_device_css" {
  bucket        = aws_s3_bucket.ops_console.id
  key           = "device.css"
  source        = "${path.module}/../apps/ops-console/device.css"
  etag          = filemd5("${path.module}/../apps/ops-console/device.css")
  content_type  = "text/css; charset=utf-8"
  cache_control = "no-cache"
}

resource "aws_s3_object" "ops_console_status_js" {
  bucket        = aws_s3_bucket.ops_console.id
  key           = "status.js"
  content       = local.ops_console_status_js
  etag          = md5(local.ops_console_status_js)
  content_type  = "application/javascript; charset=utf-8"
  cache_control = "no-cache"
}

resource "aws_s3_object" "ops_console_device_js" {
  bucket        = aws_s3_bucket.ops_console.id
  key           = "device.js"
  content       = local.ops_console_device_js
  etag          = md5(local.ops_console_device_js)
  content_type  = "application/javascript; charset=utf-8"
  cache_control = "no-cache"
}

resource "aws_cloudfront_origin_access_control" "ops_console" {
  name                              = "${local.prefix}-ops-console"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "ops_console" {
  enabled             = true
  default_root_object = "index.html"
  comment             = "Wick — ops console (status dashboard + virtual device)"

  origin {
    domain_name              = aws_s3_bucket.ops_console.bucket_regional_domain_name
    origin_id                = "ops-console-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.ops_console.id
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "ops-console-s3"
    viewer_protocol_policy = "redirect-to-https"

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

resource "aws_s3_bucket_policy" "ops_console_cloudfront_only" {
  bucket = aws_s3_bucket.ops_console.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontOAC"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.ops_console.arn}/*"
      Condition = {
        StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.ops_console.arn }
      }
    }]
  })
}
