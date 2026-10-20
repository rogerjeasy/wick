# ---------------------------------------------------------------------------
# Her television in a browser tab (apps/ops-console/tv.html), which is where
# someone with no Fire TV is sent to try Wick, and is the site's front page;
# beside it, a browser-based virtual device for engineers (device.html,
# replacing docs/*.md's curl/wscat sequences with clicks). Production's
# health report is not here: it is the operator's (`npm run ops:status`). Same pattern as sim-alexa (infra/sim-alexa.tf): private S3
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
  # The placeholder substitutions live here, once, rather than duplicated
  # per aws_s3_object resource below.
  # The browser television itself (tv-core.js), which both pages that are a television load: device.html, the
  # console, and tv.html, the resident's television and nothing else.
  ops_console_tv_core_js = replace(
    replace(
      replace(
        replace(
          replace(
            file("${path.module}/../apps/ops-console/tv-core.js"),
            "PAIRING_API_URL_PLACEHOLDER",
            aws_apigatewayv2_api.edge.api_endpoint,
          ),
          "WEBSOCKET_URL_PLACEHOLDER",
          aws_apigatewayv2_stage.transport.invoke_url,
        ),
        # The cards come by IoT Core first, as on the Vega app; the WebSocket above is behind it (infra/iot.tf).
        "MQTT_WSS_URL_PLACEHOLDER",
        "wss://${data.aws_iot_endpoint.data.endpoint_address}/mqtt?x-amz-customauthorizer-name=${aws_iot_authorizer.device.name}",
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

resource "aws_s3_object" "ops_console_tv_core_js" {
  bucket        = aws_s3_bucket.ops_console.id
  key           = "tv-core.js"
  content       = local.ops_console_tv_core_js
  etag          = md5(local.ops_console_tv_core_js)
  content_type  = "application/javascript; charset=utf-8"
  cache_control = "no-cache"
}

# The console around the television: no placeholders of its own.
resource "aws_s3_object" "ops_console_device_js" {
  bucket        = aws_s3_bucket.ops_console.id
  key           = "device.js"
  source        = "${path.module}/../apps/ops-console/device.js"
  etag          = filemd5("${path.module}/../apps/ops-console/device.js")
  content_type  = "application/javascript; charset=utf-8"
  cache_control = "no-cache"
}

# Her television, alone (tv.html): the screen and nothing else, drawn as the Vega app draws it, with the
# keyboard as the remote. Its rules and its films' calm points are generated from the Vega app's source
# (`npm run tv:build`) and served as they are; the posters are the Vega app's own, from where it bundles them.
resource "aws_s3_object" "ops_console_tv_html" {
  bucket        = aws_s3_bucket.ops_console.id
  key           = "tv.html"
  source        = "${path.module}/../apps/ops-console/tv.html"
  etag          = filemd5("${path.module}/../apps/ops-console/tv.html")
  content_type  = "text/html; charset=utf-8"
  cache_control = "no-cache"
}

resource "aws_s3_object" "ops_console_tv_css" {
  bucket        = aws_s3_bucket.ops_console.id
  key           = "tv.css"
  source        = "${path.module}/../apps/ops-console/tv.css"
  etag          = filemd5("${path.module}/../apps/ops-console/tv.css")
  content_type  = "text/css; charset=utf-8"
  cache_control = "no-cache"
}

resource "aws_s3_object" "ops_console_tv_js" {
  bucket        = aws_s3_bucket.ops_console.id
  key           = "tv.js"
  source        = "${path.module}/../apps/ops-console/tv.js"
  etag          = filemd5("${path.module}/../apps/ops-console/tv.js")
  content_type  = "application/javascript; charset=utf-8"
  cache_control = "no-cache"
}

resource "aws_s3_object" "ops_console_tv_engine_js" {
  bucket        = aws_s3_bucket.ops_console.id
  key           = "tv-engine.generated.js"
  source        = "${path.module}/../apps/ops-console/tv-engine.generated.js"
  etag          = filemd5("${path.module}/../apps/ops-console/tv-engine.generated.js")
  content_type  = "application/javascript; charset=utf-8"
  cache_control = "no-cache"
}

# How the page reaches home: the Vega app's own transport, IoT Core's MQTT first (scripts/tv-page/build.ts).
resource "aws_s3_object" "ops_console_tv_channels_js" {
  bucket        = aws_s3_bucket.ops_console.id
  key           = "tv-channels.generated.js"
  source        = "${path.module}/../apps/ops-console/tv-channels.generated.js"
  etag          = filemd5("${path.module}/../apps/ops-console/tv-channels.generated.js")
  content_type  = "application/javascript; charset=utf-8"
  cache_control = "no-cache"
}

resource "aws_s3_object" "ops_console_tv_catalog_json" {
  bucket        = aws_s3_bucket.ops_console.id
  key           = "tv-catalog.json"
  source        = "${path.module}/../apps/ops-console/tv-catalog.json"
  etag          = filemd5("${path.module}/../apps/ops-console/tv-catalog.json")
  content_type  = "application/json; charset=utf-8"
  cache_control = "no-cache"
}

resource "aws_s3_object" "ops_console_tv_posters" {
  for_each      = fileset("${path.module}/../apps/tv-vega/assets/image", "*.jpg")
  bucket        = aws_s3_bucket.ops_console.id
  key           = "posters/${each.value}"
  source        = "${path.module}/../apps/tv-vega/assets/image/${each.value}"
  etag          = filemd5("${path.module}/../apps/tv-vega/assets/image/${each.value}")
  content_type  = "image/jpeg"
  cache_control = "no-cache"
}

# The web's libraries (`npm run web:vendor`, scripts/web-vendor.mjs): the typeface, the icons, Motion's
# `animate` and the open-props easings and shadows. Served from this site's own origin, because the policy
# (csp/ops-console.csp) loads nothing from anywhere else; apps/ops-console/__tests__/tv-build.test.ts holds
# this list to what the script writes.
locals {
  ops_console_vendor = {
    "fonts.css"                                                    = "text/css; charset=utf-8"
    "fonts/atkinson-hyperlegible-next-latin-wght-normal.woff2"     = "font/woff2"
    "fonts/atkinson-hyperlegible-next-latin-ext-wght-normal.woff2" = "font/woff2"
    "fonts/OFL.txt"                                                = "text/plain; charset=utf-8"
    "icons.generated.js"                                           = "application/javascript; charset=utf-8"
    "motion.generated.js"                                          = "application/javascript; charset=utf-8"
    "open-props.css"                                               = "text/css; charset=utf-8"
  }
}

resource "aws_s3_object" "ops_console_vendor" {
  for_each      = local.ops_console_vendor
  bucket        = aws_s3_bucket.ops_console.id
  key           = "vendor/${each.key}"
  source        = "${path.module}/../apps/ops-console/vendor/${each.key}"
  etag          = filemd5("${path.module}/../apps/ops-console/vendor/${each.key}")
  content_type  = each.value
  cache_control = "no-cache"
}

# The door in "How Wick works" (tv.js, tour/tour.ts): the stand-in doorbell's made picture of a parcel at the
# door (docs/demo-door/NOTICE.md), copied beside the page so the tour sends for nothing.
resource "aws_s3_object" "ops_console_tour_parcel" {
  bucket        = aws_s3_bucket.ops_console.id
  key           = "parcel.jpg"
  source        = "${path.module}/../apps/ops-console/parcel.jpg"
  etag          = filemd5("${path.module}/../apps/ops-console/parcel.jpg")
  content_type  = "image/jpeg"
  cache_control = "no-cache"
}

# ---------------------------------------------------------------------------
# What the browser is told about these pages, on every answer: the same
# headers as the family app's (infra/sim-alexa.tf, where each is explained),
# with infra/csp/ops-console.csp for the policy. A television in a tab talks
# to the edge API to pair, to IoT Core and its WebSocket for the cards, to the Wick server
# for a family member's own television, and to the films; it plays Read to
# me from the media bucket (a presigned address). It has no microphone.
# ---------------------------------------------------------------------------

locals {
  ops_console_csp = replace(trimspace(templatefile("${path.module}/csp/ops-console.csp", {
    edge_api  = aws_apigatewayv2_api.edge.api_endpoint
    websocket = replace(aws_apigatewayv2_stage.transport.invoke_url, "/^(wss://[^/]+).*$/", "$1")
    # IoT Core's address for the cards, tried before the WebSocket (tv-core.js).
    iot = "wss://${data.aws_iot_endpoint.data.endpoint_address}"
    # The issuer setting, not the service's own address: the service is told this site's address
    # (WICK_VIRTUAL_TV_URL), so naming it here would make each wait for the other.
    wick_server = var.mcp_issuer_url != "" ? var.mcp_issuer_url : "https://*.awsapprunner.com"
    films       = "https://${aws_cloudfront_distribution.programmes.domain_name}"
    speech      = "https://${aws_s3_bucket.media.bucket}.s3.${local.region}.amazonaws.com"
  })), "\n", " ")
}

resource "aws_cloudfront_response_headers_policy" "ops_console" {
  name    = "${local.prefix}-ops-console-security"
  comment = "Wick ops console and virtual television: CSP, HSTS, no framing, no sniffing, no referrer"

  security_headers_config {
    content_security_policy {
      content_security_policy = local.ops_console_csp
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
      value    = "microphone=(), camera=(), geolocation=(), payment=(), usb=()"
      override = true
    }
  }
}

resource "aws_cloudfront_origin_access_control" "ops_console" {
  name                              = "${local.prefix}-ops-console"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "ops_console" {
  enabled             = true
  default_root_object = "tv.html"
  comment             = "Wick — her television in a browser tab (+ engineers' virtual device)"

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
    # The security headers above, on every answer.
    response_headers_policy_id = aws_cloudfront_response_headers_policy.ops_console.id

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
