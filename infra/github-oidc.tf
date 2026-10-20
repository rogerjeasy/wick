# ---------------------------------------------------------------------------
# GitHub Actions -> AWS, by OIDC. No static keys, anywhere, ever.
#
# GitHub signs a short-lived token describing the workflow that asked for it;
# AWS trusts that signature and mints credentials valid for one job. There is
# no secret to leak, rotate, or accidentally print.
#
# APPLY THIS FROM A LAPTOP, ONCE, BEFORE CI CAN DEPLOY. It is the bootstrap
# that lets CI exist — CI cannot create the role it needs to authenticate.
# ---------------------------------------------------------------------------

variable "github_repository" {
  # GitHub's OIDC `sub` claim embeds the immutable owner/repo numeric IDs
  # alongside the names (login@ownerId/repo@repoId), not just the names — a
  # hardening against repo-rename/transfer hijacking. StringEquals against the
  # name-only form never matches; this is the literal value GitHub issues for
  # rogerjeasy/wick, confirmed 2026-09-15 by decoding the token in CI.
  description = "owner@ownerId/name@repoId of the repository allowed to assume the deploy role."
  type        = string
  default     = "rogerjeasy@58919295/wick@1370269826"
}

variable "github_deploy_ref" {
  description = "The single git ref allowed to deploy. A branch, not a wildcard: any ref that can deploy is a ref that can reach production."
  type        = string
  default     = "refs/heads/main"
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]

  # AWS validates GitHub's certificate against its own trust store and ignores
  # these, but the API still requires the field. Both published values are
  # listed so a rotation of either does not break the apply.
  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fcd",
  ]
}

data "aws_iam_policy_document" "github_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    # Both conditions matter. Without the audience check any GitHub workflow in
    # the world presents a valid token; without the subject check any repository
    # does. StringEquals, never StringLike — a wildcard here is how these roles
    # get taken over.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:ref:${var.github_deploy_ref}"]
    }
  }
}

# Deliberately NOT named wick-*. The policy below grants IAM control over
# wick-* roles only, so this role cannot rewrite its own trust policy or widen
# its own permissions — which is the escalation path that matters when anyone
# who can push to main can run it.
resource "aws_iam_role" "github_deploy" {
  name                 = "github-actions-wick-deploy"
  description          = "Assumed by GitHub Actions from ${var.github_repository} @ ${var.github_deploy_ref}"
  assume_role_policy   = data.aws_iam_policy_document.github_assume.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "github_deploy" {
  # Terraform state. Without this the run cannot even read what exists.
  statement {
    sid     = "TerraformState"
    actions = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
    resources = [
      "arn:aws:s3:::wick-tfstate-${local.account_id}",
      "arn:aws:s3:::wick-tfstate-${local.account_id}/*",
    ]
  }

  # Visit errands (infra/errands.tf): the state machine, by name, and never
  # an execution of it — CI cannot start, stop or read an errand. Without
  # these, every apply after the first (a laptop's) fails at refresh.
  statement {
    sid = "ManageTheErrandMachineNeverItsExecutions"
    actions = [
      "states:CreateStateMachine",
      "states:UpdateStateMachine",
      "states:DeleteStateMachine",
      "states:DescribeStateMachine",
      "states:ListStateMachineVersions",
      "states:ListTagsForResource",
      "states:TagResource",
      "states:UntagResource",
    ]
    resources = ["arn:aws:states:${local.region}:${local.account_id}:stateMachine:wick-*"]
  }

  # The agents' Bedrock Guardrail (infra/guardrail.tf): the guardrail and its
  # published versions, and nothing that applies or lists any other.
  statement {
    sid = "ManageTheAgentsGuardrail"
    actions = [
      "bedrock:CreateGuardrail",
      "bedrock:UpdateGuardrail",
      "bedrock:DeleteGuardrail",
      "bedrock:GetGuardrail",
      "bedrock:CreateGuardrailVersion",
      "bedrock:ListTagsForResource",
      "bedrock:TagResource",
      "bedrock:UntagResource",
    ]
    resources = ["arn:aws:bedrock:${local.region}:${local.account_id}:guardrail/*"]
  }

  # Creating a guardrail names no resource until it exists.
  statement {
    sid       = "CreateAGuardrail"
    actions   = ["bedrock:CreateGuardrail", "bedrock:ListGuardrails"]
    resources = ["*"]
  }

  # Checking a definition before it is written names no resource.
  statement {
    sid       = "ValidateAStateMachineDefinition"
    actions   = ["states:ValidateStateMachineDefinition"]
    resources = ["*"]
  }

  # Which image each service runs (infra/images.tf): deploy-agent.yml writes
  # the tag it just pushed, and every apply reads it and keeps the two
  # parameters themselves. Held to /wick/images/*, so a deploy can neither
  # read nor write any other parameter in the account. Both are plain
  # Strings, so no KMS grant.
  statement {
    sid = "PinTheImageTags"
    actions = [
      "ssm:GetParameter",
      "ssm:PutParameter",
      "ssm:DeleteParameter",
      "ssm:AddTagsToResource",
      "ssm:RemoveTagsFromResource",
      "ssm:ListTagsForResource",
    ]
    resources = ["arn:aws:ssm:${local.region}:${local.account_id}:parameter/${local.prefix}/images/*"]
  }

  # Terraform reads a parameter's type and description back with
  # DescribeParameters, which AWS does not let a policy scope to a
  # parameter: it names parameters and never returns a value.
  statement {
    sid       = "DescribeParameters"
    actions   = ["ssm:DescribeParameters"]
    resources = ["*"]
  }

  # Hold for Sarah (infra/reach.tf): the one group its three-minute timers
  # live in. NOT scheduler:* — the timers themselves are set by the
  # card-action function at a press, never by a deploy, and a deploy has no
  # business reading, setting or deleting one.
  statement {
    sid = "ManageTheReachTimerGroupNeverItsTimers"
    actions = [
      "scheduler:CreateScheduleGroup",
      "scheduler:GetScheduleGroup",
      "scheduler:DeleteScheduleGroup",
      "scheduler:ListTagsForResource",
      "scheduler:TagResource",
      "scheduler:UntagResource",
    ]
    resources = ["arn:aws:scheduler:${local.region}:${local.account_id}:schedule-group/wick*"]
  }

  # The MQTT channel (infra/iot.tf): one authorizer and two topic rules.
  #
  # NOT iot:*. That would also be the data plane — publishing a card to any
  # television, or reading what one sends — and every certificate and policy
  # in the account. The deploy role shapes the channel and never speaks on it.
  statement {
    sid = "ManageTheMqttChannelNeverItsMessages"
    actions = [
      "iot:CreateAuthorizer",
      "iot:UpdateAuthorizer",
      "iot:DeleteAuthorizer",
      "iot:DescribeAuthorizer",
      "iot:ListAuthorizers",
      "iot:CreateTopicRule",
      "iot:ReplaceTopicRule",
      "iot:DeleteTopicRule",
      "iot:GetTopicRule",
      "iot:ListTopicRules",
      "iot:EnableTopicRule",
      "iot:DisableTopicRule",
      "iot:DescribeEndpoint",
      "iot:ListTagsForResource",
      "iot:TagResource",
      "iot:UntagResource",
    ]
    resources = ["*"] # rule and authorizer ARNs exist only once created; DescribeEndpoint has none
  }

  # What pages someone, and where a failed event goes (infra/alarms.tf): one
  # SNS topic, one SQS queue, the alarms. Each is named wick-*, so each
  # grant is held to that name. The management verbs only — NOT sns:Publish,
  # sqs:SendMessage/ReceiveMessage/DeleteMessage or cloudwatch:SetAlarmState:
  # a deploy shapes these and never reads a household's dead letters, sends
  # a page, or silences one.
  statement {
    sid = "ManageTheAlarmTopicNeverItsMessages"
    actions = [
      "sns:CreateTopic",
      "sns:DeleteTopic",
      "sns:GetTopicAttributes",
      "sns:SetTopicAttributes",
      "sns:ListSubscriptionsByTopic",
      "sns:Subscribe",
      "sns:Unsubscribe",
      "sns:GetSubscriptionAttributes",
      "sns:SetSubscriptionAttributes",
      "sns:ListTagsForResource",
      "sns:TagResource",
      "sns:UntagResource",
    ]
    # A subscription's ARN is its topic's plus ":<id>", so this covers both.
    resources = ["arn:aws:sns:${local.region}:${local.account_id}:wick-*"]
  }

  # The account's monthly budget (infra/budget.tf), by name: made, changed,
  # read and tagged, and nothing else of the account's billing. CreateBudget
  # and DeleteBudget are authorised as ModifyBudget. Without this, every
  # apply after budget.tf merged failed at its creation (2026-10-17).
  statement {
    sid = "ManageTheBudgetNothingElseOfBilling"
    actions = [
      "budgets:ModifyBudget",
      "budgets:ViewBudget",
      "budgets:ListTagsForResource",
      "budgets:TagResource",
      "budgets:UntagResource",
    ]
    resources = ["arn:aws:budgets::${local.account_id}:budget/wick-*"]
  }

  statement {
    sid = "ManageTheDeadLetterQueueNeverItsMessages"
    actions = [
      "sqs:CreateQueue",
      "sqs:DeleteQueue",
      "sqs:GetQueueAttributes",
      "sqs:SetQueueAttributes",
      "sqs:GetQueueUrl",
      "sqs:ListQueueTags",
      "sqs:TagQueue",
      "sqs:UntagQueue",
    ]
    resources = ["arn:aws:sqs:${local.region}:${local.account_id}:wick-*"]
  }

  statement {
    sid = "ManageTheAlarmsNeverTheirState"
    actions = [
      "cloudwatch:PutMetricAlarm",
      "cloudwatch:DeleteAlarms",
      "cloudwatch:ListTagsForResource",
      "cloudwatch:TagResource",
      "cloudwatch:UntagResource",
    ]
    resources = ["arn:aws:cloudwatch:${local.region}:${local.account_id}:alarm:wick-*"]
  }

  # Read-only, and listed apart: Terraform reads alarms back by name, and a
  # read of an alarm's definition is harmless wherever it is allowed.
  statement {
    sid       = "ReadAlarms"
    actions   = ["cloudwatch:DescribeAlarms"]
    resources = ["*"]
  }

  # Family accounts (infra/accounts.tf): the user pool and its app client.
  # Without a grant the first deploy after accounts landed failed on
  # CreateUserPool with AccessDenied — after it had already updated the
  # pairing Lambdas and the family app, leaving the stack half-deployed.
  #
  # NOT cognito-idp:*. That would also be every Admin* and List* action on
  # the people in the pool: anyone who can push to main could read the
  # family's email addresses, reset a password, or delete an account. The
  # deploy role manages the pool's shape and never its users, so it gets the
  # verbs Terraform calls for those two resources and nothing else.
  statement {
    sid       = "CreateTheUserPool"
    actions   = ["cognito-idp:CreateUserPool", "cognito-idp:ListUserPools"]
    resources = ["*"] # no pool ARN exists before the pool does
  }

  statement {
    sid = "ManageTheUserPoolNeverItsUsers"
    actions = [
      "cognito-idp:DescribeUserPool",
      "cognito-idp:UpdateUserPool",
      "cognito-idp:DeleteUserPool",
      "cognito-idp:GetUserPoolMfaConfig",
      "cognito-idp:SetUserPoolMfaConfig",
      "cognito-idp:AddCustomAttributes",
      "cognito-idp:ListTagsForResource",
      "cognito-idp:TagResource",
      "cognito-idp:UntagResource",
      "cognito-idp:CreateUserPoolClient",
      "cognito-idp:DescribeUserPoolClient",
      "cognito-idp:UpdateUserPoolClient",
      "cognito-idp:DeleteUserPoolClient",
      "cognito-idp:ListUserPoolClients",
    ]
    resources = ["arn:aws:cognito-idp:${local.region}:${local.account_id}:userpool/*"]
  }

  # Secrets: Terraform manages the containers. It must never need the contents —
  # those are seeded once by infra/bootstrap/put-ring-secret.sh and read at
  # runtime by the lambdas. GetSecretValue is absent on purpose.
  statement {
    sid = "ManageSecretContainers"
    actions = [
      "secretsmanager:CreateSecret",
      "secretsmanager:DescribeSecret",
      "secretsmanager:TagResource",
      "secretsmanager:UpdateSecret",
      "secretsmanager:DeleteSecret",
      "secretsmanager:GetResourcePolicy",
    ]
    resources = ["arn:aws:secretsmanager:${local.region}:${local.account_id}:secret:wick/*"]
  }

  # IAM, narrowed to the roles this project owns.
  statement {
    sid = "ManageWickRolesOnly"
    actions = [
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:GetRole",
      "iam:UpdateRole",
      "iam:TagRole",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:GetRolePolicy",
      "iam:ListRolePolicies",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:ListAttachedRolePolicies",
    ]
    resources = ["arn:aws:iam::${local.account_id}:role/wick-*"]
  }

  # Lambda needs its execution role handed to it, and nothing else — plus,
  # since S4a's App Runner service, the two services App Runner itself
  # assumes roles as (build.* to pull from ECR, tasks.* to run the
  # container) — see infra/mcp.tf's apprunner_ecr_access/apprunner_instance
  # roles, both wick-* and so already covered by this statement's resource
  # scope.
  #
  # And apprunner.amazonaws.com itself. That is the service name App Runner
  # checks iam:PassRole against on UpdateService — it is what AWS's own
  # AWSAppRunnerFullAccess policy grants — and without it CI could never
  # change the MCP server's settings: the first time it tried (the demo
  # switch) both deploys failed with "not authorized to perform iam:PassRole
  # on wick-apprunner-ecr-access". Nothing had shown it before because every
  # earlier change to that service was applied from a laptop.
  statement {
    sid       = "PassOnlyWickRoles"
    actions   = ["iam:PassRole"]
    resources = ["arn:aws:iam::${local.account_id}:role/wick-*"]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values = [
        "lambda.amazonaws.com",
        "apprunner.amazonaws.com",
        "build.apprunner.amazonaws.com",
        "tasks.apprunner.amazonaws.com",
        "bedrock-agentcore.amazonaws.com",
        # The errand state machine's role (infra/errands.tf).
        "states.amazonaws.com",
      ]
    }
  }

  # App Runner's UpdateService passes its two roles without saying to which
  # service: the request carries no iam:PassedToService, so the statement
  # above can never match it. Seen on 2026-10-14, the first time CI changed
  # the MCP server (deploy-agent, after #73): "not authorized to perform
  # iam:PassRole on wick-apprunner-ecr-access"; the IAM policy simulator
  # agrees — allowed with the key, denied without it. So these two roles, by
  # their exact ARNs and nothing else, may be passed with no service named.
  statement {
    sid     = "PassAppRunnerRoles"
    actions = ["iam:PassRole"]
    resources = [
      aws_iam_role.apprunner_ecr_access.arn,
      aws_iam_role.apprunner_instance.arn,
    ]
  }

  # This resource lives in the same state as everything else CI manages, so
  # every apply must be able to REFRESH it — but the role that can create and
  # update every wick-* role must never be able to WRITE its own trust policy
  # or permissions. Hence read-only, and scoped to its own ARN, not wick-*.
  statement {
    sid = "ReadSelfOnly"
    actions = [
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListRolePolicies",
      "iam:ListAttachedRolePolicies",
      "iam:ListRoleTags",
    ]
    resources = [aws_iam_role.github_deploy.arn]
  }

  # Its two managed policies, to refresh them and never to change them.
  statement {
    sid = "ReadItsOwnPoliciesOnly"
    actions = [
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:ListPolicyVersions",
    ]
    resources = [
      "arn:aws:iam::${local.account_id}:policy/github-actions-wick-deploy-stack",
      "arn:aws:iam::${local.account_id}:policy/github-actions-wick-deploy-denials",
    ]
  }

  statement {
    sid       = "ReadOnlyLookups"
    actions   = ["iam:ListOpenIDConnectProviders", "iam:GetOpenIDConnectProvider", "sts:GetCallerIdentity"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "deploy"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy.json
}

# The deploy role's permissions are three documents, because IAM allows an
# inline policy 10,240 characters and a managed one 6,144: a short inline
# policy of what the stack needs by service (above), a managed policy of the
# grants held to this project's own names, and a managed policy of every
# explicit denial. A Deny wins over every Allow in all three, whatever is
# added to them later. The role can READ all of them and write none of them
# (ReadSelfOnly): changing what CI may do is a laptop's apply.
data "aws_iam_policy_document" "github_deploy_stack" {
  # The stack itself, held to this project's own names. What an apply can touch
  # is `wick*` and nothing else in the account (which holds other projects),
  # and what it can never touch is the household's data: the statements below
  # allow the verbs Terraform needs on those names, and the three after them
  # DENY, for the whole account, every way a deploy could read or write a
  # household's rows, pictures, logs or events, or run a function.
  #
  # This is evidence-based: the verbs were checked against what the role really
  # called over twenty-one applies (CloudTrail, 17 to 19 October 2026): reads of
  # every resource, UpdateFunctionCode/Configuration, UpdateService,
  # UpdateAgentRuntime, UpdateDistribution, the image push, the image pins.
  # Nothing it called is refused here. A resource whose name AWS chooses (a
  # CloudFront distribution, an API Gateway API, an event-source mapping) is
  # held to its type and this account.

  statement {
    sid     = "ManageTheFunctionsNeverRunThem"
    actions = ["lambda:*"]
    resources = [
      "arn:aws:lambda:${local.region}:${local.account_id}:function:${local.prefix}-*",
      # A mapping's own tags are read under its own ARN, which carries an id AWS chose.
      "arn:aws:lambda:${local.region}:${local.account_id}:event-source-mapping:*",
    ]
  }

  # An event-source mapping has an id AWS chooses, and the verbs that make one
  # name no function until they have; each one only joins a function of the
  # project's to a queue of the project's.
  statement {
    sid = "MapQueuesToFunctions"
    actions = [
      "lambda:CreateEventSourceMapping",
      "lambda:UpdateEventSourceMapping",
      "lambda:DeleteEventSourceMapping",
      "lambda:GetEventSourceMapping",
      "lambda:ListEventSourceMappings",
      "lambda:ListFunctions",
      "lambda:GetAccountSettings",
    ]
    resources = ["*"]
  }

  # The table's shape, and nothing of what is in it: the verbs Terraform calls to
  # read it back and to change its settings. Not dynamodb:* (that would also be
  # PartiQL and stream reads), and not CreateTable or DeleteTable: a table is made
  # and removed from a laptop, behind deletion protection.
  statement {
    sid = "ManageTheTableNeverItsRows"
    actions = [
      "dynamodb:Describe*",
      "dynamodb:ListTagsOfResource",
      "dynamodb:UpdateTable",
      "dynamodb:UpdateContinuousBackups",
      "dynamodb:UpdateTimeToLive",
      "dynamodb:TagResource",
      "dynamodb:UntagResource",
    ]
    resources = [
      "arn:aws:dynamodb:${local.region}:${local.account_id}:table/${local.prefix}",
      "arn:aws:dynamodb:${local.region}:${local.account_id}:table/${local.prefix}/*",
    ]
  }

  # The buckets as buckets (policy, lifecycle rules, encryption, the public
  # access block): these name no object.
  statement {
    sid     = "ManageTheBucketsNotWhatIsInThem"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.media.arn,
      aws_s3_bucket.photos.arn,
      aws_s3_bucket.programmes.arn,
      aws_s3_bucket.ops_console.arn,
      aws_s3_bucket.sim_alexa.arn,
    ]
  }

  # The two static sites Terraform fills (infra/ops-console.tf, sim-alexa.tf):
  # her television in a browser tab and the family app. Public pages, and the
  # only objects a deploy writes. Not the films, not a household's pictures.
  statement {
    sid = "PutTheStaticSites"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:GetObjectTagging",
      "s3:PutObjectTagging",
      "s3:DeleteObjectTagging",
      "s3:ListBucket",
    ]
    resources = [
      aws_s3_bucket.ops_console.arn,
      "${aws_s3_bucket.ops_console.arn}/*",
      aws_s3_bucket.sim_alexa.arn,
      "${aws_s3_bucket.sim_alexa.arn}/*",
    ]
  }

  statement {
    sid     = "ManageTheLogGroupsNeverReadThem"
    actions = ["logs:*"]
    resources = [
      "arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/${local.prefix}-*",
      "arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/apigateway/${local.prefix}-*",
      "arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/vendedlogs/states/${local.prefix}-*",
      "arn:aws:logs:${local.region}:${local.account_id}:log-group:/${local.prefix}/*",
    ]
  }

  # Listing log groups and the account's log resource policies (the bus's
  # delivery, infra/core.tf) name no group.
  statement {
    sid = "ListLogGroupsAndResourcePolicies"
    actions = [
      "logs:DescribeLogGroups",
      "logs:DescribeResourcePolicies",
      "logs:PutResourcePolicy",
      "logs:DeleteResourcePolicy",
      "logs:ListTagsForResource",
    ]
    resources = ["*"]
  }

  statement {
    sid     = "ManageTheBusAndItsRulesNeverSendToIt"
    actions = ["events:*"]
    resources = [
      "arn:aws:events:${local.region}:${local.account_id}:event-bus/${local.prefix}*",
      "arn:aws:events:${local.region}:${local.account_id}:rule/${local.prefix}*",
      "arn:aws:events:${local.region}:${local.account_id}:rule/${local.prefix}*/*",
    ]
  }

  statement {
    sid       = "ListTheBusesAndRules"
    actions   = ["events:ListEventBuses", "events:ListRules", "events:DescribeEventBus"]
    resources = ["*"]
  }

  # API Gateway's own names are verbs, and its HTTP and WebSocket APIs are
  # everything under /apis (and their tags); there is no REST API here.
  statement {
    sid     = "ManageTheHttpAndWebSocketApis"
    actions = ["apigateway:*"]
    resources = [
      "arn:aws:apigateway:${local.region}::/apis",
      "arn:aws:apigateway:${local.region}::/apis/*",
      "arn:aws:apigateway:${local.region}::/tags/*",
    ]
  }

  statement {
    sid     = "ManageTheImageRepositories"
    actions = ["ecr:*"]
    resources = [
      "arn:aws:ecr:${local.region}:${local.account_id}:repository/${local.prefix}-*",
    ]
  }

  statement {
    sid       = "LogInToTheRegistry"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  # CloudFront ids are chosen by AWS, and the account holds other projects'
  # distributions: this is as narrow as the type allows.
  statement {
    sid     = "ManageTheDistributions"
    actions = ["cloudfront:*"]
    resources = [
      "arn:aws:cloudfront::${local.account_id}:distribution/*",
      "arn:aws:cloudfront::${local.account_id}:origin-access-control/*",
      "arn:aws:cloudfront::${local.account_id}:response-headers-policy/*",
    ]
  }

  # CloudFront's create verbs name no resource, because none exists yet.
  statement {
    sid = "CreateAndListTheDistributions"
    actions = [
      "cloudfront:CreateDistribution",
      "cloudfront:CreateDistributionWithTags",
      "cloudfront:CreateOriginAccessControl",
      "cloudfront:CreateResponseHeadersPolicy",
      "cloudfront:List*",
      "cloudfront:GetCachePolicy",
      "cloudfront:GetOriginRequestPolicy",
    ]
    resources = ["*"]
  }

  # The MCP server and its scaling configuration, by name. The account holds
  # other projects' App Runner services.
  statement {
    sid     = "ManageTheServer"
    actions = ["apprunner:*"]
    resources = [
      "arn:aws:apprunner:${local.region}:${local.account_id}:service/${local.prefix}-*",
      "arn:aws:apprunner:${local.region}:${local.account_id}:autoscalingconfiguration/${local.prefix}-*",
      # The configuration every service had before it had its own: a request that still names it is not refused.
      "arn:aws:apprunner:${local.region}:${local.account_id}:autoscalingconfiguration/DefaultConfiguration/*",
    ]
  }

  statement {
    sid       = "ListTheServices"
    actions   = ["apprunner:ListServices", "apprunner:ListAutoScalingConfigurations"]
    resources = ["*"]
  }

  # The agent plane (infra/agentcore.tf): the runtime, the workload identity
  # AgentCore creates with it, and the memory. Their ids are AWS's; the data
  # plane is denied by name just below.
  statement {
    sid = "ManageTheAgentPlane"
    actions = [
      "bedrock-agentcore:*AgentRuntime*",
      "bedrock-agentcore:*Memory",
      "bedrock-agentcore:*WorkloadIdentity",
      "bedrock-agentcore:ListTagsForResource",
      "bedrock-agentcore:TagResource",
      "bedrock-agentcore:UntagResource",
    ]
    resources = [
      "arn:aws:bedrock-agentcore:${local.region}:${local.account_id}:runtime/*",
      "arn:aws:bedrock-agentcore:${local.region}:${local.account_id}:memory/*",
      "arn:aws:bedrock-agentcore:${local.region}:${local.account_id}:workload-identity-directory/*",
    ]
  }

  # Its create verbs name no resource, because none exists yet.
  statement {
    sid = "CreateAndListTheAgentPlane"
    actions = [
      "bedrock-agentcore:CreateAgentRuntime",
      "bedrock-agentcore:CreateAgentRuntimeEndpoint",
      "bedrock-agentcore:CreateMemory",
      "bedrock-agentcore:CreateWorkloadIdentity",
      "bedrock-agentcore:ListAgentRuntimes",
      "bedrock-agentcore:ListMemories",
      "bedrock-agentcore:ListWorkloadIdentities",
    ]
    resources = ["*"]
  }

  # The spend brake (infra/budget.tf): one managed policy and one budget action.
  # CI can READ them, to refresh them, and never change them: what stops a bill
  # is not a thing the code that runs on a merge should be able to switch off.
  # Making or changing the brake is a laptop's apply, like the deploy role's
  # own policy. Nor may CI pass the role it runs as to AWS Budgets.
  statement {
    sid = "ReadTheSpendBrake"
    actions = [
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:ListPolicyVersions",
      "iam:ListPolicyTags",
      "budgets:DescribeBudgetAction",
      "budgets:DescribeBudgetActionsForBudget",
    ]
    resources = [
      "arn:aws:iam::${local.account_id}:policy/${local.prefix}-spend-brake",
      "arn:aws:budgets::${local.account_id}:budget/${local.prefix}-*",
    ]
  }
}

data "aws_iam_policy_document" "github_deploy_denials" {
  # --- what a deploy can never do, whatever it is allowed above -------------------
  #
  # Anyone who can merge to main runs this role, and a merge deploys code that
  # the functions' own roles run with. These denials are the other half: the
  # deploy role's own credentials never read, write or run what a household has
  # put into Wick. Each is explicit, so no allow above — present or added later —
  # can grant it.

  statement {
    sid    = "NeverReadOrWriteAHouseholdsRows"
    effect = "Deny"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:BatchGetItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:TransactGetItems",
      "dynamodb:TransactWriteItems",
      "dynamodb:ExecuteStatement",
      "dynamodb:BatchExecuteStatement",
      "dynamodb:ExecuteTransaction",
      # PartiQL is authorised under these, not under the three above.
      "dynamodb:PartiQLSelect",
      "dynamodb:PartiQLInsert",
      "dynamodb:PartiQLUpdate",
      "dynamodb:PartiQLDelete",
      # A table's stream carries every change to it.
      "dynamodb:GetRecords",
      "dynamodb:GetShardIterator",
      "dynamodb:ListStreams",
      "dynamodb:ExportTableToPointInTime",
      "dynamodb:RestoreTableToPointInTime",
      "dynamodb:RestoreTableFromBackup",
      "dynamodb:CreateBackup",
      "dynamodb:ImportTable",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "NeverTouchADoorPictureOrAFamilyPhoto"
    effect = "Deny"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:GetObjectAcl",
      "s3:GetObjectTagging",
      "s3:PutObject",
      "s3:PutObjectAcl",
      "s3:PutObjectTagging",
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
      "s3:RestoreObject",
    ]
    # Objects only, never the bucket itself. s3:ListBucket is also the permission HeadBucket needs, and
    # a Terraform refresh that is refused it reads the bucket as deleted: on 2026-10-19 that made CI plan to
    # recreate both buckets and tear down their lifecycle rules, public access block and TLS-only policy.
    # Listing names an object (photos/<household>/<random id>.jpg, an accepted exposure: it says which homes hold
    # pictures and how many, not who is in them); reading or changing one stays denied.
    resources = [
      "${aws_s3_bucket.media.arn}/*",
      "${aws_s3_bucket.photos.arn}/*",
    ]
  }

  # Past versions of an object are never part of what a deploy needs, and the bucket-level refresh does not ask
  # for them, so listing them stays denied on the buckets themselves.
  statement {
    sid       = "NeverListAPastVersionOfADoorPictureOrAFamilyPhoto"
    effect    = "Deny"
    actions   = ["s3:ListBucketVersions"]
    resources = [aws_s3_bucket.media.arn, aws_s3_bucket.photos.arn]
  }

  statement {
    sid    = "NeverRunAFunctionNorSendItAnEvent"
    effect = "Deny"
    actions = [
      "lambda:InvokeFunction",
      "lambda:InvokeAsync",
      "lambda:InvokeFunctionUrl",
      "events:PutEvents",
      "events:PutPartnerEvents",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "NeverReadWhatTheFunctionsLog"
    effect = "Deny"
    actions = [
      "logs:GetLogEvents",
      "logs:GetLogRecord",
      "logs:GetLogGroupFields",
      "logs:FilterLogEvents",
      "logs:StartQuery",
      "logs:GetQueryResults",
      "logs:StartLiveTail",
    ]
    resources = ["*"]
  }

  # The deploy role manages AgentCore (the runtime, the memory and its
  # strategy) and never reads what is in them: no member's conversation, no
  # member's remembered words, and no invocation of the agents. Explicit, so
  # bedrock-agentcore:* above can never grant it.
  statement {
    sid    = "NeverReadAMembersMemoryNorInvokeTheAgents"
    effect = "Deny"
    actions = [
      "bedrock-agentcore:InvokeAgentRuntime",
      "bedrock-agentcore:InvokeAgentRuntimeForUser",
      "bedrock-agentcore:CreateEvent",
      "bedrock-agentcore:GetEvent",
      "bedrock-agentcore:ListEvents",
      "bedrock-agentcore:DeleteEvent",
      "bedrock-agentcore:ListActors",
      "bedrock-agentcore:ListSessions",
      "bedrock-agentcore:RetrieveMemoryRecords",
      "bedrock-agentcore:ListMemoryRecords",
      "bedrock-agentcore:GetMemoryRecord",
      "bedrock-agentcore:DeleteMemoryRecord",
      "bedrock-agentcore:BatchCreateMemoryRecords",
      "bedrock-agentcore:BatchUpdateMemoryRecords",
      "bedrock-agentcore:BatchDeleteMemoryRecords",
      "bedrock-agentcore:StartMemoryExtractionJob",
      "bedrock-agentcore:ListMemoryExtractionJobs",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "github_deploy_stack" {
  name        = "github-actions-wick-deploy-stack"
  description = "What the deploy role may manage, by Wick's own names (infra/github-oidc.tf)."
  policy      = data.aws_iam_policy_document.github_deploy_stack.json
}

resource "aws_iam_policy" "github_deploy_denials" {
  name        = "github-actions-wick-deploy-denials"
  description = "What the deploy role may never do to a household's data, whatever else it is allowed (infra/github-oidc.tf)."
  policy      = data.aws_iam_policy_document.github_deploy_denials.json
}

resource "aws_iam_role_policy_attachment" "github_deploy_stack" {
  role       = aws_iam_role.github_deploy.name
  policy_arn = aws_iam_policy.github_deploy_stack.arn
}

resource "aws_iam_role_policy_attachment" "github_deploy_denials" {
  role       = aws_iam_role.github_deploy.name
  policy_arn = aws_iam_policy.github_deploy_denials.arn
}

output "github_deploy_role_arn" {
  description = "Set this as the GitHub repository variable AWS_DEPLOY_ROLE_ARN."
  value       = aws_iam_role.github_deploy.arn
}
