#!/usr/bin/env bash
#
# Loads the Ring app credentials from .env into Secrets Manager.
#
# Values are piped through a temporary file and never echoed, so they do not end
# up in shell history, terminal scrollback, or an agent transcript.
#
set -euo pipefail

PROFILE="${AWS_PROFILE:-wick-dev}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SECRET="${1:-wick/ring/credentials}"

[ -f "$ROOT/.env" ] || { echo "no .env at $ROOT" >&2; exit 1; }

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

set -a; . "$ROOT/.env"; set +a
python3 -c "
import json, os, sys
json.dump({
    'clientId':     os.environ['CLIENT_ID_RING'],
    'clientSecret': os.environ['CLIENT_SECRET_RING'],
    'hmacKey':      os.environ['HMAC_KEY_RING'],
}, open(sys.argv[1], 'w'))
" "$TMP"

aws secretsmanager put-secret-value \
  --secret-id "$SECRET" \
  --secret-string "file://$TMP" \
  --profile "$PROFILE" \
  --query 'Name' --output text

echo "populated: clientId, clientSecret, hmacKey"
