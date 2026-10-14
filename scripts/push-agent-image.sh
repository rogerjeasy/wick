#!/usr/bin/env bash
# Build the two arm64 images and push them to the ECR repositories
# infra/agentcore.tf creates:
#   wick-agents       the AgentCore Runtime      services/agent/Dockerfile
#   wick-live-bridge  the live bridge Lambda     services/agent/bridge.Dockerfile
#
#   AWS_PROFILE=wick-dev scripts/push-agent-image.sh
#
# deploy-agent.yml does this on every push to main that changes what the
# images hold. This is the same thing from a laptop: for a new stack, or when
# CI cannot run.
#
# Tags both images with the current short git SHA, then pins that tag in the
# SSM parameter /wick/images/agents (infra/images.tf). The next apply, yours
# or CI's, deploys exactly these images.
set -euo pipefail

cd "$(dirname "$0")/.."
REGION="${AWS_REGION:-us-east-1}"
PARAMETER="${WICK_AGENTS_IMAGE_PARAMETER:-/wick/images/agents}"
REPO_URL="$(terraform -chdir=infra output -raw agents_ecr_repository_url)"
BRIDGE_URL="${REPO_URL%/*}/wick-live-bridge"
REGISTRY="${REPO_URL%%/*}"
TAG="$(git rev-parse --short=7 HEAD)$(git diff --quiet || echo -dirty)"

# Terraform makes the parameter (images.tf). Writing one it has not made
# would make its next apply fail on a parameter that already exists.
if ! aws ssm get-parameter --region "$REGION" --name "$PARAMETER" >/dev/null 2>&1; then
  echo "$PARAMETER does not exist yet: run terraform -chdir=infra apply -target=aws_ssm_parameter.agents_image first" >&2
  exit 1
fi

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"

# AgentCore Runtime is arm64-only. Legacy builder: no buildx needed on an
# arm64 host; on x86 use `docker buildx build --platform linux/arm64`.
for pair in "services/agent/Dockerfile $REPO_URL" "services/agent/bridge.Dockerfile $BRIDGE_URL"; do
  set -- $pair
  DOCKER_BUILDKIT=0 docker build -f "$1" -t "$2:$TAG" . >&2
  docker push "$2:$TAG" >&2
done

aws ssm put-parameter --region "$REGION" --name "$PARAMETER" --value "$TAG" --overwrite >/dev/null
echo "pinned $TAG in $PARAMETER: terraform -chdir=infra apply deploys it" >&2

echo "$TAG"
