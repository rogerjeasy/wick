#!/usr/bin/env bash
#
# Move the deployment's old single Ring link to the household it belongs to.
#
#   ./scripts/move-ring-link.sh              # dry run: says what it would do
#   ./scripts/move-ring-link.sh --apply
#
# Before each household had its own link, a deployment held one, in the secret
# wick/ring/tokens. Each household's link is now wick/ring/tokens/<householdId>.
# This copies the old record to the household this deployment was set up
# around (WICK_HOUSEHOLD_ID, default: margaret), once.
#
# Run it once, after the per-household code is deployed. It:
#   - never prints a token, or any part of one;
#   - never overwrites a link the household already has;
#   - leaves the old secret exactly as it is (remove it by hand once checked).
#
# The cameras the household holds (RINGDEV# rows) are not touched: they were
# assigned to it already and stay assigned.
#
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-wick-dev}"

OLD_SECRET="${RING_OLD_TOKEN_SECRET:-wick/ring/tokens}"
HOUSEHOLD_ID="${WICK_HOUSEHOLD_ID:-margaret}"
case "$HOUSEHOLD_ID" in
  *[!A-Za-z0-9_-]*|"") echo "WICK_HOUSEHOLD_ID is not a household id: '$HOUSEHOLD_ID'" >&2; exit 1 ;;
esac
NEW_SECRET="$OLD_SECRET/$HOUSEHOLD_ID"
APPLY="${1:-}"

RECORD_FILE=$(mktemp)
chmod 600 "$RECORD_FILE"
trap 'rm -f "$RECORD_FILE"' EXIT

echo "── the old link ($OLD_SECRET) ──"
if ! aws secretsmanager get-secret-value --secret-id "$OLD_SECRET" --query SecretString --output text > "$RECORD_FILE" 2>/dev/null \
   || [ ! -s "$RECORD_FILE" ] || [ "$(cat "$RECORD_FILE")" = "None" ]; then
  echo "   nothing there to move."
  exit 0
fi
python3 - "$RECORD_FILE" <<'PY'
import json, sys, time
try:
    t = json.load(open(sys.argv[1]))
except Exception:
    print("   present but unreadable — not moving it."); raise SystemExit(1)
left = (t.get("expiresAt", 0) - time.time() * 1000) / 60000
print(f"   source         {t.get('source', 'unlabelled')}")
print(f"   access token   {'present' if t.get('access_token') else 'MISSING'}")
print(f"   refresh token  {'present' if t.get('refresh_token') else 'none'}")
print(f"   expiry         {'in %d min' % left if left > 0 else 'passed %d min ago' % -left}")
PY

echo
echo "── household $HOUSEHOLD_ID ($NEW_SECRET) ──"
if aws secretsmanager describe-secret --secret-id "$NEW_SECRET" >/dev/null 2>&1; then
  echo "   already has a link of its own. Nothing moved."
  exit 0
fi

if [ "$APPLY" != "--apply" ]; then
  echo "   has none. Would copy the old link here. Run again with --apply to do it."
  exit 0
fi

aws secretsmanager create-secret \
    --name "$NEW_SECRET" --secret-string "file://$RECORD_FILE" \
    --description "Ring tokens for household $HOUSEHOLD_ID. Moved from the deployment's single link." \
    --query ARN --output text >/dev/null
echo "   copied. The old secret is unchanged."
echo
echo "Check it with: WICK_HOUSEHOLD_ID=$HOUSEHOLD_ID ./scripts/ring-link-status.sh && npm run ring:check"
