#!/usr/bin/env bash
#
# Load a Ring Developer Playground token into wick/ring/tokens.
#
#   ./scripts/set-ring-token.sh
#
# The Playground (https://developer.amazon.com/ring/console/playground) issues a
# ~30-minute access token that works against every Ring API with no OAuth, no
# client credentials and no account linking. For a private app it is currently
# the only way to hold a working token — "Connect Ring account" allowlists an
# account, it does not issue a credential. See FL-002.
#
# The token is read from a silent prompt, never from argv, so it stays out of
# shell history and out of the process table.
#
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-wick-dev}"

SECRET_ID="${RING_TOKEN_SECRET:-wick/ring/tokens}"
API="https://api.amazonvision.com"

# Prefer RING_OAUTH_TOKEN from .env — the Playground hands you a token to paste
# somewhere, and .env is where the rest of the Ring credentials already live.
# Fall back to a silent prompt so the script still works without one.
if [ -f .env ] && grep -q '^[[:space:]]*RING_OAUTH_TOKEN[[:space:]]*=' .env; then
  TOKEN=$(python3 -c "
import re, pathlib
env = dict(re.match(r'\s*([A-Za-z0-9_]+)\s*=\s*(.*)', l).groups()
           for l in pathlib.Path('.env').read_text().splitlines()
           if re.match(r'\s*[A-Za-z0-9_]+\s*=', l))
print(env['RING_OAUTH_TOKEN'].strip().strip('\"').strip(\"'\"))
")
  echo "── using RING_OAUTH_TOKEN from .env ──"
else
  printf 'Paste the Playground access token (input hidden): '
  read -rs TOKEN
  printf '\n\n'
fi

[ -n "${TOKEN:-}" ] || { echo "No token given."; exit 1; }

# Prove it works before storing it. A token that 401s is worse than no token:
# it turns "not linked" into "mysteriously broken".
echo "── verifying against ${API}/v1/users/me ──"
body=$(mktemp)
status=$(curl -sS -o "$body" -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" "$API/v1/users/me")

if [ "$status" != "200" ]; then
  echo "   HTTP $status — token rejected. Not stored."
  echo "   $(head -c 300 "$body")"
  rm -f "$body"
  exit 1
fi

account=$(python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
print(d.get('account_id') or d.get('id') or d.get('email') or '')
" "$body")
rm -f "$body"

echo "   HTTP 200 — token is live${account:+ (account ${account})}"

# Playground tokens carry no refresh token. Stamping the expiry we were told to
# expect keeps ring-token.mjs honest: needsRefresh() will fire, isRefreshable()
# will say no, and the caller gets 'refresh_expired' rather than a silent 401.
echo
echo "── writing $SECRET_ID ──"
python3 -c "
import json, sys, time, base64
tok, acct = sys.argv[1], sys.argv[2]
now = int(time.time() * 1000)

# The token states its own expiry. Trust that over a documented average.
exp_ms = now + 1800 * 1000
try:
    p = tok.split('.')[1]; p += '=' * (-len(p) % 4)
    claims = json.loads(base64.urlsafe_b64decode(p))
    if 'exp' in claims:
        exp_ms = int(claims['exp']) * 1000
except Exception:
    pass

print(json.dumps({
    'access_token': tok,
    'accountId': acct or None,
    'expires_in': max(0, (exp_ms - now) // 1000),
    'obtainedAt': now,
    'expiresAt': exp_ms,
    'source': 'playground',
}))
" "$TOKEN" "$account" \
| aws secretsmanager put-secret-value \
    --secret-id "$SECRET_ID" --secret-string file:///dev/stdin \
    --query VersionId --output text >/dev/null

echo "   stored — no refresh token (Playground tokens carry none)"
echo
echo "Check it with: ./scripts/ring-link-status.sh"
