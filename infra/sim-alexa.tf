# ---------------------------------------------------------------------------
# The simulated Alexa+ surface (S4a's client — see apps/sim-alexa/README.md),
# deployed. It's a few static files that only ever talk to the real MCP server
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

# Visit errands: what the errand tools' answers say and show, imported by
# surface.js (apps/sim-alexa/__tests__/errands.test.ts).
resource "aws_s3_object" "sim_alexa_errands_js" {
  bucket        = aws_s3_bucket.sim_alexa.id
  key           = "errands.js"
  source        = "${path.module}/../apps/sim-alexa/errands.js"
  etag          = filemd5("${path.module}/../apps/sim-alexa/errands.js")
  content_type  = "application/javascript; charset=utf-8"
  cache_control = "no-cache"
}

# Ask by voice: what the page does with the sound of a question before it
# sends it — 16 kHz, 16-bit PCM — a separate module so it is tested without a
# browser (apps/sim-alexa/__tests__/voice.test.ts).
resource "aws_s3_object" "sim_alexa_voice_js" {
  bucket        = aws_s3_bucket.sim_alexa.id
  key           = "voice.js"
  source        = "${path.module}/../apps/sim-alexa/voice.js"
  etag          = filemd5("${path.module}/../apps/sim-alexa/voice.js")
  content_type  = "application/javascript; charset=utf-8"
  cache_control = "no-cache"
}

# The family app's service worker: turns a nudge into a notification when the
# page is closed (infra/push.tf). Served from the app's own root, which is
# what gives it the whole app as its scope.
resource "aws_s3_object" "sim_alexa_sw_js" {
  bucket        = aws_s3_bucket.sim_alexa.id
  key           = "sw.js"
  source        = "${path.module}/../apps/sim-alexa/sw.js"
  etag          = filemd5("${path.module}/../apps/sim-alexa/sw.js")
  content_type  = "application/javascript; charset=utf-8"
  cache_control = "no-cache"
}

# The look of the page, out of index.html so that no inline style needs
# allowing (the Content-Security-Policy below).
resource "aws_s3_object" "sim_alexa_styles_css" {
  bucket        = aws_s3_bucket.sim_alexa.id
  key           = "styles.css"
  source        = "${path.module}/../apps/sim-alexa/styles.css"
  etag          = filemd5("${path.module}/../apps/sim-alexa/styles.css")
  content_type  = "text/css; charset=utf-8"
  cache_control = "no-cache"
}

# Your own account: the file of what Wick holds, and deleting it — what is
# said, tested without a browser (apps/sim-alexa/__tests__/account.test.ts).
resource "aws_s3_object" "sim_alexa_account_js" {
  bucket        = aws_s3_bucket.sim_alexa.id
  key           = "account.js"
  source        = "${path.module}/../apps/sim-alexa/account.js"
  etag          = filemd5("${path.module}/../apps/sim-alexa/account.js")
  content_type  = "application/javascript; charset=utf-8"
  cache_control = "no-cache"
}

# Ask by voice's AudioWorklet, as a file of the page's own: the policy below
# runs no script from a blob: address.
resource "aws_s3_object" "sim_alexa_capture_worklet_js" {
  bucket        = aws_s3_bucket.sim_alexa.id
  key           = "capture-worklet.js"
  source        = "${path.module}/../apps/sim-alexa/capture-worklet.js"
  etag          = filemd5("${path.module}/../apps/sim-alexa/capture-worklet.js")
  content_type  = "application/javascript; charset=utf-8"
  cache_control = "no-cache"
}

# The web app manifest and its icons: what lets a telephone add the family
# app to its home screen — and an iPhone receives Web Push only from an app
# added there. The icons are made by scripts/make-brand-assets.py.
resource "aws_s3_object" "sim_alexa_manifest" {
  bucket        = aws_s3_bucket.sim_alexa.id
  key           = "manifest.webmanifest"
  source        = "${path.module}/../apps/sim-alexa/manifest.webmanifest"
  etag          = filemd5("${path.module}/../apps/sim-alexa/manifest.webmanifest")
  content_type  = "application/manifest+json; charset=utf-8"
  cache_control = "no-cache"
}

resource "aws_s3_object" "sim_alexa_icons" {
  for_each      = fileset("${path.module}/../apps/sim-alexa/icons", "*.png")
  bucket        = aws_s3_bucket.sim_alexa.id
  key           = "icons/${each.value}"
  source        = "${path.module}/../apps/sim-alexa/icons/${each.value}"
  etag          = filemd5("${path.module}/../apps/sim-alexa/icons/${each.value}")
  content_type  = "image/png"
  cache_control = "max-age=86400"
}

# ---------------------------------------------------------------------------
# What the browser is told about the page, on every answer CloudFront gives.
#
# Content-Security-Policy, from infra/csp/family-app.csp (one directive per
# line; the local dev server sends the same file with its own addresses, so
# the app is always run under it). Scripts and styles come from this site
# alone, and from one file on jsDelivr: hls.js 1.5.17, which is also loaded
# with Subresource Integrity. There is no 'unsafe-inline' and no
# 'unsafe-eval' anywhere. It connects to the Wick server and the films and
# nowhere else. The one wide directive is img-src https:, and on purpose: a
# door's picture comes from Ring's media host, which Ring does not name and
# reaches by a redirect (FRICTION.md FL-005), and an image runs no code.
# media-src and worker-src allow blob: because hls.js plays through Media
# Source Extensions and demuxes in a worker made from a Blob.
#
# Permissions-Policy: the microphone for this site only (Ask by voice asks
# for it on a press), and no camera, place or payment for anyone.
# Strict-Transport-Security for a year; the page is never framed, never
# sniffed, and sends no Referer — an invitation's code and an authorization
# code both arrive in its address.
# ---------------------------------------------------------------------------

locals {
  sim_alexa_wick_servers = distinct([
    "https://${aws_apprunner_service.mcp_server.service_url}",
    var.mcp_issuer_url,
  ])
  sim_alexa_csp = replace(trimspace(templatefile("${path.module}/csp/family-app.csp", {
    wick_server = join(" ", compact(local.sim_alexa_wick_servers))
    films       = "https://${aws_cloudfront_distribution.programmes.domain_name}"
  })), "\n", " ")
}

resource "aws_cloudfront_response_headers_policy" "sim_alexa" {
  name    = "${local.prefix}-sim-alexa-security"
  comment = "Wick family app: CSP, HSTS, no framing, no sniffing, no referrer, microphone for itself only"

  security_headers_config {
    content_security_policy {
      content_security_policy = local.sim_alexa_csp
      override                = true
    }
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = false
      preload                    = false
      override                   = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    content_type_options {
      override = true
    }
    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }
  }

  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = "microphone=(self), camera=(), geolocation=(), payment=(), usb=()"
      override = true
    }
  }
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
    # The security headers above, on every answer.
    response_headers_policy_id = aws_cloudfront_response_headers_policy.sim_alexa.id

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
