# ---------------------------------------------------------------------------
# The simulated Alexa+ surface (S4a's client — see apps/sim-alexa/README.md),
# deployed. It's three static files that only ever talk to the real MCP server
# over HTTPS from the browser — no server-side logic, no AWS SDK, no
# credentials — so it needs nothing more than a bucket behind CloudFront for
# TLS. The bucket itself stays private; CloudFront's Origin Access Control is
# the only thing allowed to read from it.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "sim_alexa" {
  bucket = "${local.prefix}-sim-alexa-${local.account_id}"
}

resource "aws_s3_bucket_public_access_block" "sim_alexa" {
  bucket                  = aws_s3_bucket.sim_alexa.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "sim_alexa" {
  bucket = aws_s3_bucket.sim_alexa.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

locals {
  # The checked-in file defaults the MCP server URL field to localhost —
  # correct for `npm run dev`, wrong for this deployed copy. Rewritten here
  # rather than in the source file so local dev and the deployed static
  # site each get the default that's actually right for them. It is the
  # fallback only: the page takes the server from the add-on package
  # published beside it (addon.json, below; main.js serverFor), and this
  # default is what it has if that file cannot be read — a deploy that
  # stopped half way has left a page and its files out of step before.
  sim_alexa_index_html = replace(
    file("${path.module}/../apps/sim-alexa/index.html"),
    "http://127.0.0.1:3300",
    "https://${aws_apprunner_service.mcp_server.service_url}",
  )
}

resource "aws_s3_object" "sim_alexa_index" {
  bucket       = aws_s3_bucket.sim_alexa.id
  key          = "index.html"
  content      = local.sim_alexa_index_html
  etag         = md5(local.sim_alexa_index_html)
  content_type = "text/html; charset=utf-8"
  # A browser must ask again after every deploy, or it runs a stale page
  # against a newer server (observed: a cached main.js kept a new button off).
  cache_control = "no-cache"
}

# The Alexa+ add-on package, the same file `alexa-ai deploy` would be given.
# The page draws Wick's listing from it and links an account against the MCP
# server it names, so the address lives in one place. A test holds that
# address to var.mcp_issuer_url (scripts/__tests__/addon-package.test.ts).
resource "aws_s3_object" "sim_alexa_addon_json" {
  bucket        = aws_s3_bucket.sim_alexa.id
  key           = "addon.json"
  source        = "${path.module}/../addon-package/addon.json"
  etag          = filemd5("${path.module}/../addon-package/addon.json")
  content_type  = "application/json; charset=utf-8"
  cache_control = "no-cache"
}

resource "aws_s3_object" "sim_alexa_main_js" {
  bucket        = aws_s3_bucket.sim_alexa.id
  key           = "main.js"
  source        = "${path.module}/../apps/sim-alexa/main.js"
  etag          = filemd5("${path.module}/../apps/sim-alexa/main.js")
  content_type  = "application/javascript; charset=utf-8"
  cache_control = "no-cache"
}

# What the surface understands, says and shows — a separate module so it is
# tested without a browser (apps/sim-alexa/__tests__/surface.test.ts).
resource "aws_s3_object" "sim_alexa_surface_js" {
  bucket        = aws_s3_bucket.sim_alexa.id
  key           = "surface.js"
  source        = "${path.module}/../apps/sim-alexa/surface.js"
  etag          = filemd5("${path.module}/../apps/sim-alexa/surface.js")
  content_type  = "application/javascript; charset=utf-8"
  cache_control = "no-cache"
}

resource "aws_cloudfront_origin_access_control" "sim_alexa" {
  name                              = "${local.prefix}-sim-alexa"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "sim_alexa" {
  enabled             = true
  default_root_object = "index.html"
  comment             = "Wick — simulated Alexa+ surface"

  origin {
    domain_name              = aws_s3_bucket.sim_alexa.bucket_regional_domain_name
    origin_id                = "sim-alexa-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.sim_alexa.id
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "sim-alexa-s3"
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

resource "aws_s3_bucket_policy" "sim_alexa_cloudfront_only" {
  bucket = aws_s3_bucket.sim_alexa.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontOAC"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.sim_alexa.arn}/*"
      Condition = {
        StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.sim_alexa.arn }
      }
    }]
  })
}
