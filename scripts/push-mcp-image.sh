#!/usr/bin/env bash
# Build the Wick server's image (services/mcp-server/Dockerfile) for App
# Runner, which runs linux/amd64, and push it to the ECR repository
# infra/mcp.tf creates:
#
#   AWS_PROFILE=wick-dev scripts/push-mcp-image.sh
#
# deploy-agent.yml does this on every push to main that changes what the
# image holds. This is the same thing from a laptop: for a new stack, or when
# CI cannot run.
#
# Tags the image with the current short git SHA, then pins that tag in the
# SSM parameter /wick/images/mcp-server (infra/images.tf). The next apply,
# yours or CI's, points App Runner at exactly this image, and that apply is
# the deployment.
set -euo pipefail

cd "$(dirname "$0")/.."
REGION="${AWS_REGION:-us-east-1}"
PARAMETER="${WICK_MCP_IMAGE_PARAMETER:-/wick/images/mcp-server}"
REPO_URL="${REPO_URL:-$(aws sts get-caller-identity --query Account --output text).dkr.ecr.${REGION}.amazonaws.com/wick-mcp-server}"
REGISTRY="${REPO_URL%%/*}"
TAG="$(git rev-parse --short=7 HEAD)$(git diff --quiet || echo -dirty)"

# Terraform makes the parameter (images.tf). Writing one it has not made
# would make its next apply fail on a parameter that already exists.
if ! aws ssm get-parameter --region "$REGION" --name "$PARAMETER" >/dev/null 2>&1; then
  echo "$PARAMETER does not exist yet: run terraform -chdir=infra apply -target=aws_ssm_parameter.mcp_server_image first" >&2
  exit 1
fi

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"
docker build --platform linux/amd64 --build-arg WICK_COMMIT="$TAG" -f services/mcp-server/Dockerfile -t "$REPO_URL:$TAG" . >&2
docker push "$REPO_URL:$TAG" >&2

aws ssm put-parameter --region "$REGION" --name "$PARAMETER" --value "$TAG" --overwrite >/dev/null
echo "pinned $TAG in $PARAMETER: terraform -chdir=infra apply deploys it" >&2

echo "$TAG"
