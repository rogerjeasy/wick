#!/usr/bin/env bash
#
# Generates the key pair Wick signs Web Push requests with (VAPID, RFC 8292)
# and puts each half where it is read. Run once per environment, after
# `terraform apply` has created the secret (infra/push.tf).
#
#   private + public + contact  ->  Secrets Manager  wick/push/vapid
#                                   (read by the agent plane's egress.ts)
#   public only                 ->  DynamoDB         CONFIG#push / VAPID
#                                   (handed to browsers by the Wick server)
#
# Running it again replaces both: every browser that had notifications on
# must then turn them on again, because a subscription is tied to the key it
# was made with.
#
#   ./infra/bootstrap/generate-push-keys.sh mailto:you@example.com
#
set -euo pipefail

SUBJECT="${1:-}"
if [[ "$SUBJECT" != mailto:* && "$SUBJECT" != https://* ]]; then
  echo "usage: $0 <mailto:address | https://address>   (who a push service may contact about this sender)" >&2
  exit 1
fi

# No pager: the first call's one line of output would otherwise sit on the
# screen until `q` is pressed, with the second half not yet written.
export AWS_PAGER=""

PROFILE="${AWS_PROFILE:-wick-dev}"
SECRET="${PUSH_VAPID_SECRET:-wick/push/vapid}"
TABLE="${TABLE_NAME:-wick}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# The same library that signs with them makes them.
(cd "$ROOT" && node -e "
const { generateVAPIDKeys } = require('web-push');
const keys = generateVAPIDKeys();
const fs = require('fs');
fs.writeFileSync(process.argv[1], JSON.stringify({ ...keys, subject: process.argv[3] }));
fs.writeFileSync(process.argv[2], JSON.stringify({
  pk: { S: 'CONFIG#push' }, sk: { S: 'VAPID' }, publicKey: { S: keys.publicKey },
}));
" "$TMP_DIR/secret.json" "$TMP_DIR/row.json" "$SUBJECT")

aws secretsmanager put-secret-value \
  --secret-id "$SECRET" \
  --secret-string "file://$TMP_DIR/secret.json" \
  --profile "$PROFILE" \
  --query 'Name' --output text

aws dynamodb put-item \
  --table-name "$TABLE" \
  --item "file://$TMP_DIR/row.json" \
  --profile "$PROFILE"

echo "populated: $SECRET (publicKey, privateKey, subject) and $TABLE CONFIG#push/VAPID (publicKey)"
