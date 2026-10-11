# ---------------------------------------------------------------------------
# S4a — the MCP server, deployed. See docs/WICK-TECHNICAL.md §7.3.
#
# App Runner: one long-running container behind a public URL. It was chosen
# over Lambda when the server held one McpServer per MCP session in memory.
# It no longer does.
#
# Nothing a request needs is in this process's memory. OAuth clients, codes,
# tokens and the sign-in cookie are in DynamoDB
# (services/mcp-server/src/accounts), and there are no MCP sessions at all:
# every request is answered by a server built for the person its own token
# names (the SDK's stateless mode, services/mcp-server/src/server.ts). So a
# redeploy signs nobody out and interrupts no conversation — which the
# hackathon's "must stay live through judging" ruling needs — and a second
# instance would answer any client the first one could.
#
# What is still per-process: the family assistant's rate budgets
# (assistant/router.ts). They reset on a restart and would be counted per
# instance; that is a looser limit, not a wrong answer.
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
    #
    # Accounts (services/mcp-server/src/accounts/store.ts): the same four,
    # plus DeleteItem — an authorization code and a refresh token are
    # *taken*, with one atomic delete, so each works exactly once.
    # ConditionCheckItem: add_regular_visitor's one transaction checks, at the
    # moment it writes, that an entry it is clearing away still belongs to
    # someone the resident no longer allows.
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:ConditionCheckItem"]
    resources = [aws_dynamodb_table.wick.arn]
  }

  statement {
    sid = "ListAPersonsHouseholds"
    # listMemberships: gsi1 (USER#<id> -> the households they belong to).
    actions   = ["dynamodb:Query"]
    resources = ["${aws_dynamodb_table.wick.arn}/index/gsi1"]
  }

  statement {
    sid = "AskTheAssistantsModel"
    # The stand-in assistant's model (services/mcp-server/src/assistant/):
    # one Converse call per step of a conversation. The same model the
    # Narrator writes with, through its cross-region inference profile —
    # so, as there, InvokeModel on the profile and on the foundation model
    # it routes to, in whichever US region it picks.
    actions = ["bedrock:InvokeModel"]
    resources = [
      "arn:aws:bedrock:${local.region}:${local.account_id}:inference-profile/${local.narrative_model_profile}",
      "arn:aws:bedrock:*::foundation-model/${local.narrative_model}",
    ]
  }

  # A home's own Ring link. This server holds no Ring token and reads no
  # Ring secret; it may call the one function that does, and nothing else
  # may (services/mcp-server/src/accounts/ringLinks.ts).
  statement {
    sid       = "AskForAHouseholdsRingLink"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.household_link.arn]
  }

  statement {
    sid       = "PushNotesToTheDevice"
    actions   = ["execute-api:ManageConnections"]
    resources = ["${aws_apigatewayv2_api.transport.execution_arn}/*/*"]
  }

  # A television on MQTT is reached by publishing to its own topic
  # (infra/iot.tf); one on the WebSocket, by the statement above.
  statement {
    sid       = "PublishToTelevisionsOnMqtt"
    actions   = ["iot:Publish"]
    resources = [local.device_topics_arn]
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
            TABLE_NAME = aws_dynamodb_table.wick.name
            # INV-8: no household here. A request's household is the one
            # its token was approved for.
            WICK_COGNITO_CLIENT_ID = aws_cognito_user_pool_client.wick.id
            WICK_COGNITO_REGION    = var.region
            # Where a television's six-digit code is confirmed (pairing.tf).
            WICK_PAIRING_API_URL = aws_apigatewayv2_api.edge.api_endpoint
            WICK_HOUSEHOLD_TZ    = var.household_time_zone
            # One-click guest accounts, so nobody has to give an email
            # address to try Wick (services/mcp-server/src/accounts/demo.ts).
            WICK_DEMO_ACCOUNTS = var.demo_accounts ? "on" : "off"
            # A television in a browser tab, offered to anyone with no Fire
            # TV to hand: it pairs with a code and shows the same cards.
            WICK_VIRTUAL_TV_URL = "https://${aws_cloudfront_distribution.ops_console.domain_name}/device.html"
            # The model behind the family app's conversation. Unset, the
            # app answers by its rules and says nothing it was not told.
            WICK_ASSISTANT_MODEL_ID = local.narrative_model_profile
            WICK_ASSISTANT_REGION   = local.region
            # The function with custody of each home's Ring link
            # (infra/edge.tf household_link). Unset, the family app is told
            # the doorbell cannot be reached.
            WICK_RING_LINK_FUNCTION = aws_lambda_function.household_link.function_name
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
