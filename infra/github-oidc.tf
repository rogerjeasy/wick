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

  # The stack itself. Scoped by service rather than by resource: Terraform
  # creates and destroys these, so it needs the create verbs, and a resource
  # ARN cannot be pinned for something that does not exist yet.
  statement {
    sid = "ManageTheStack"
    actions = [
      "lambda:*",
      "apigateway:*",
      "logs:*",
      "events:*",
      "dynamodb:*",
      "s3:*",
    ]
    resources = ["*"]
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

  # Lambda needs its execution role handed to it, and nothing else.
  statement {
    sid       = "PassOnlyWickRoles"
    actions   = ["iam:PassRole"]
    resources = ["arn:aws:iam::${local.account_id}:role/wick-*"]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["lambda.amazonaws.com"]
    }
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

output "github_deploy_role_arn" {
  description = "Set this as the GitHub repository variable AWS_DEPLOY_ROLE_ARN."
  value       = aws_iam_role.github_deploy.arn
}
