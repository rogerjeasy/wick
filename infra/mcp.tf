# ---------------------------------------------------------------------------
# S4a — the MCP server, deployed. See docs/WICK-TECHNICAL.md §7.3.
#
# App Runner, not Lambda: the server holds in-memory OAuth session state
# (services/mcp-server/src/auth.ts's clients/tokens maps, and one McpServer
# instance per MCP session) across a Streamable HTTP connection. Lambda's
# per-invocation isolation has no guarantee two requests in the same OAuth
# or MCP session land on the same execution environment; App Runner is one
# long-running container, so that in-memory state actually persists across
# the requests that need it to.
#
# Exactly one instance, on purpose (max_concurrency effectively pins this to
# a single container under hackathon-scale traffic): a second instance would
# hold a *different* copy of that same in-memory state, and a client whose
# requests get load-balanced across both would see registrations and tokens
# vanish unpredictably. Horizontal scaling here needs the OAuth store moved
# to DynamoDB first — out of scope for this pass.
#
# The issuer URL problem: mcpAuthRouter() bakes `issuerUrl` into the OAuth
# metadata it serves at startup (auth.ts's createAuthRouter), but App
# Runner only assigns `service_url` once the service exists — a resource
# cannot reference its own computed attribute. So this is a two-apply
# resource on purpose: first apply with `var.mcp_issuer_url` empty (the app
# falls back to its own http://127.0.0.1:PORT default, which is wrong but
# harmless — nothing depends on the issuer being correct until a real OAuth
# client shows up), read the assigned URL from `terraform output`, then
# apply again with that URL set. App Runner redeploys automatically on an
# environment variable change.
# ---------------------------------------------------------------------------

resource "aws_ecr_repository" "mcp_server" {
  name                 = "${local.prefix}-mcp-server"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_ecr_lifecycle_policy" "mcp_server" {
  repository = aws_ecr_repository.mcp_server.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the 10 most recent images; this is a hackathon project's build history, not a compliance archive."
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}

data "aws_iam_policy_document" "apprunner_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["build.apprunner.amazonaws.com"]
    }
  }
}

# The ECR access role: lets App Runner pull the image. Separate from the
# instance role below on purpose — one authenticates the pull, the other is
# what the running application itself can do, and conflating them would
# hand the application AWS's own ECR-read credential for no reason.
resource "aws_iam_role" "apprunner_ecr_access" {
  name               = "${local.prefix}-apprunner-ecr-access"
  assume_role_policy = data.aws_iam_policy_document.apprunner_assume.json
}

resource "aws_iam_role_policy_attachment" "apprunner_ecr_access" {
  role       = aws_iam_role.apprunner_ecr_access.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess"
}

data "aws_iam_policy_document" "apprunner_instance_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["tasks.apprunner.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "apprunner_instance" {
  name               = "${local.prefix}-apprunner-mcp-instance"
  assume_role_policy = data.aws_iam_policy_document.apprunner_instance_assume.json
}

data "aws_iam_policy_document" "apprunner_instance" {
  statement {
    sid = "ReadHouseholdDataAndQueueCards"
    # get_today / did_visitor_come / get_week_narrative / get_resident_shared_view:
    # GetItem + Query. send_note_to_tv -> egress.ts's sendToDevice: PutItem
    # (queue), GetItem + UpdateItem (mark delivered), Query (find the paired
    # device's live connection).
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.wick.arn]
  }

  statement {
    sid       = "PushNotesToTheDevice"
    actions   = ["execute-api:ManageConnections"]
    resources = ["${aws_apigatewayv2_api.transport.execution_arn}/*/*"]
  }
}

resource "aws_iam_role_policy" "apprunner_instance" {
  name   = "${local.prefix}-apprunner-mcp-instance"
  role   = aws_iam_role.apprunner_instance.id
  policy = data.aws_iam_policy_document.apprunner_instance.json
}

resource "aws_apprunner_service" "mcp_server" {
  service_name = "${local.prefix}-mcp-server"

  source_configuration {
    authentication_configuration {
      access_role_arn = aws_iam_role.apprunner_ecr_access.arn
    }

    # auto_deployments_enabled defaults to true, which would redeploy on
    # every ECR push to :latest with no review step. A hackathon-paced
    # rebuild-and-push cycle wants that; flip to false if this needs to
    # stabilize later.
    image_repository {
      image_identifier      = "${aws_ecr_repository.mcp_server.repository_url}:latest"
      image_repository_type = "ECR"

      image_configuration {
        port = "3300"
        # MCP_ISSUER_URL is omitted entirely (not set to "") when
        # var.mcp_issuer_url is empty: index.ts's `?? fallback` only
        # triggers on undefined, not on an empty string — `new URL("")`
        # would throw and crash the container at startup on the first apply.
        runtime_environment_variables = merge(
          {
            TABLE_NAME        = aws_dynamodb_table.wick.name
            WICK_HOUSEHOLD_ID = var.household_id
          },
          var.mcp_issuer_url != "" ? { MCP_ISSUER_URL = var.mcp_issuer_url } : {},
        )
      }
    }
  }

  instance_configuration {
    cpu               = "1024"
    memory            = "2048"
    instance_role_arn = aws_iam_role.apprunner_instance.arn
  }

  # TCP, not HTTP: the app has no handler for a bare GET / (its real routes
  # are /.well-known/*, /authorize, /token, /mcp), so an HTTP health check
  # would need a path guaranteed to 2xx that doesn't otherwise exist. TCP
  # only asks "does something answer on the port," which is what actually
  # matters here.
  health_check_configuration {
    protocol = "TCP"
  }

  lifecycle {
    prevent_destroy = true
  }
}
