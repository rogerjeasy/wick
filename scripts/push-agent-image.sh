#!/usr/bin/env bash
# Build the two arm64 images and push them to the ECR repositories
# infra/agentcore.tf creates:
#   wick-agents       the AgentCore Runtime      services/agent/Dockerfile
#   wick-live-bridge  the live bridge Lambda     services/agent/bridge.Dockerfile
#
#   AWS_PROFILE=wick-dev scripts/push-agent-image.sh
#
# Tags the image with the current git SHA and `latest`, and prints the SHA:
# pass it to Terraform as -var agent_image_tag=<sha> so both pick up the new
# version (a moving `latest` tag alone doesn't change the resources).
set -euo pipefail

cd "$(dirname "$0")/.."
REGION="${AWS_REGION:-us-east-1}"
REPO_URL="$(terraform -chdir=infra output -raw agents_ecr_repository_url)"
BRIDGE_URL="${REPO_URL%/*}/wick-live-bridge"
REGISTRY="${REPO_URL%%/*}"
TAG="$(git rev-parse --short HEAD)$(git diff --quiet || echo -dirty)"

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"

# AgentCore Runtime is arm64-only. Legacy builder: no buildx needed on an
# arm64 host; on x86 use `docker buildx build --platform linux/arm64`.
for pair in "services/agent/Dockerfile $REPO_URL" "services/agent/bridge.Dockerfile $BRIDGE_URL"; do
  set -- $pair
  DOCKER_BUILDKIT=0 docker build -f "$1" -t "$2:$TAG" -t "$2:latest" . >&2
  docker push "$2:$TAG" >&2
  docker push "$2:latest" >&2
done

echo "$TAG"
