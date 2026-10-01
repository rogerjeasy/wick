#!/usr/bin/env bash
# Build the wick_agents AgentCore Runtime image (services/agent/Dockerfile)
# for arm64 and push it to the ECR repository infra/agentcore.tf creates.
#
#   AWS_PROFILE=wick-dev scripts/push-agent-image.sh
#
# Tags the image with the current git SHA and `latest`, and prints the SHA:
# pass it to Terraform as -var agent_image_tag=<sha> so the runtime picks up
# a new version (a moving `latest` tag alone doesn't change the resource).
set -euo pipefail

cd "$(dirname "$0")/.."
REGION="${AWS_REGION:-us-east-1}"
REPO_URL="$(terraform -chdir=infra output -raw agents_ecr_repository_url)"
REGISTRY="${REPO_URL%%/*}"
TAG="$(git rev-parse --short HEAD)$(git diff --quiet || echo -dirty)"

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"

# AgentCore Runtime is arm64-only. Legacy builder: no buildx needed on an
# arm64 host; on x86 use `docker buildx build --platform linux/arm64`.
DOCKER_BUILDKIT=0 docker build -f services/agent/Dockerfile -t "$REPO_URL:$TAG" -t "$REPO_URL:latest" .
docker push "$REPO_URL:$TAG"
docker push "$REPO_URL:latest"

echo "$TAG"
