#!/usr/bin/env bash
#
# Generates the RS256 keypair used to sign and verify device-bound JWTs
# (§4.2) and seeds it into Secrets Manager. Run once per environment, after
# `terraform apply` has created the secret.
#
set -euo pipefail

PROFILE="${AWS_PROFILE:-wick-dev}"
SECRET="${1:-wick/pairing/signing-key}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

openssl genrsa -out "$TMP_DIR/private.pem" 2048 >/dev/null 2>&1
openssl rsa -in "$TMP_DIR/private.pem" -pubout -out "$TMP_DIR/public.pem" >/dev/null 2>&1

python3 -c "
import json, sys
json.dump({
    'privateKeyPem': open(sys.argv[1]).read(),
    'publicKeyPem':  open(sys.argv[2]).read(),
}, open(sys.argv[3], 'w'))
" "$TMP_DIR/private.pem" "$TMP_DIR/public.pem" "$TMP_DIR/secret.json"

aws secretsmanager put-secret-value \
  --secret-id "$SECRET" \
  --secret-string "file://$TMP_DIR/secret.json" \
  --profile "$PROFILE" \
  --query 'Name' --output text

echo "populated: privateKeyPem, publicKeyPem"
