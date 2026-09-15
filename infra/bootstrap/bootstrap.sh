#!/usr/bin/env bash
#
# Creates the S3 bucket that holds Terraform state.
#
# This is the one resource in the project Terraform does not manage, because
# something has to hold the state before state exists. Run once, per account.
#
#   ./infra-tf/bootstrap/bootstrap.sh
#
set -euo pipefail

PROFILE="${AWS_PROFILE:-wick-dev}"
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT="$(aws sts get-caller-identity --profile "$PROFILE" --query Account --output text)"
BUCKET="wick-tfstate-${ACCOUNT}"

if aws s3api head-bucket --bucket "$BUCKET" --profile "$PROFILE" 2>/dev/null; then
  echo "state bucket already exists: $BUCKET"
  exit 0
fi

echo "creating state bucket: $BUCKET"
if [ "$REGION" = "us-east-1" ]; then
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" --profile "$PROFILE" >/dev/null
else
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" --profile "$PROFILE" \
    --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
fi

# Versioning is the safety net for a corrupted or truncated state file.
aws s3api put-bucket-versioning --bucket "$BUCKET" --profile "$PROFILE" \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption --bucket "$BUCKET" --profile "$PROFILE" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

# State contains resource metadata and must never be public.
aws s3api put-public-access-block --bucket "$BUCKET" --profile "$PROFILE" \
  --public-access-block-configuration \
  'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'

echo "done: $BUCKET"
