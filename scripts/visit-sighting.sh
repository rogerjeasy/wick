#!/usr/bin/env bash
#
# One sighting at the door, for "The visit, witnessed" (packages/contracts/
# src/visit.ts): a regular visitor arriving, or somebody seen later — which
# Wick takes as that visitor leaving.
#
#   RING_TEST_DEVICE_ID=<the household's doorbell> ./scripts/visit-sighting.sh arrive [minutes ago]
#   RING_TEST_DEVICE_ID=<the household's doorbell> ./scripts/visit-sighting.sh leave  [minutes ago]
#
# Why this exists: Ring's Developer Playground simulates live-view sessions
# only. It sends no `button_press` and no `motion_detected` webhook, so the
# two events a visit is made of cannot come from it (FRICTION.md FL-027, and
# Amazon's answer in the hackathon forum, topic 45309). This posts the same
# JSON Ring documents, signed with the real HMAC key, to the real webhook.
# Everything after the webhook is the deployed path and nothing else:
# signature check, idempotency, EventBridge, the Door agent, the roster
# match, the VISIT# row, and — when the resident is next at the television —
# the question "Is this right?".
#
# It is a stand-in for the doorbell and is labelled as one wherever it is
# shown. It writes nothing itself and invents no visit: whether a sighting
# is a visit is decided by the household's own roster, as always. `arrive`
# only opens a visit when the moment falls inside a regular visitor's usual
# time (list_regular_visitors); `leave` only closes one that is at least
# five minutes old and at most four hours.
#
# The resident is asked once the leaving has stood for ten minutes, so for a
# rehearsal pass the minutes: `arrive 50`, then `leave 12`, then bring the
# television to the front.
#
set -uo pipefail
export AWS_PROFILE="${AWS_PROFILE:-wick-dev}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

KIND="${1:-}"
AGO_MIN="${2:-0}"
case "$KIND" in
  arrive) EVENT_TYPE="button_press"; SUB_TYPE="" ;;
  leave)  EVENT_TYPE="motion_detected"; SUB_TYPE="human" ;;
  *) echo "usage: RING_TEST_DEVICE_ID=<id> $0 arrive|leave [minutes ago]" >&2; exit 2 ;;
esac
case "$AGO_MIN" in ''|*[!0-9]*) echo "minutes ago must be a whole number" >&2; exit 2 ;; esac
DEVICE_ID="${RING_TEST_DEVICE_ID:-}"
[ -n "$DEVICE_ID" ] || { echo "set RING_TEST_DEVICE_ID to the doorbell the household holds (npm run ring:check lists it)" >&2; exit 2; }

BASE="${WICK_EDGE_URL:-$(terraform -chdir="$ROOT/infra" output -raw ring_webhook_url 2>/dev/null)}"
[ -n "$BASE" ] || { echo "cannot resolve the webhook url" >&2; exit 1; }
# The signing key and nothing else, read as text: .env is never run as shell,
# so a value with a `$` or a quote in it (a pasted token, say) cannot break
# this or be evaluated.
HMAC_KEY_RING="${HMAC_KEY_RING:-$(python3 - "$ROOT/.env" <<'PY'
import re, sys, pathlib
path = pathlib.Path(sys.argv[1])
value = ''
if path.exists():
    for line in path.read_text().splitlines():
        m = re.match(r'\s*HMAC_KEY_RING\s*=\s*(.*)', line)
        if m:
            value = m.group(1).strip().strip('"').strip("'")
print(value)
PY
)}"
[ -n "$HMAC_KEY_RING" ] || { echo "HMAC_KEY_RING is not set in .env" >&2; exit 1; }
export HMAC_KEY_RING

BODY=$(python3 -c "
import json,sys,time
body = {
  'request_id': 'visit-%s-%d' % (sys.argv[1], int(time.time()*1000)),
  'event_type': sys.argv[2],
  'device_id': sys.argv[4],
  'occurred_at': int(time.time()*1000) - int(sys.argv[5]) * 60000,
}
if sys.argv[3]: body['sub_type'] = sys.argv[3]
print(json.dumps(body))" "$KIND" "$EVENT_TYPE" "$SUB_TYPE" "$DEVICE_ID" "$AGO_MIN")

SIG=$(python3 -c "
import hmac,hashlib,os,sys
print(hmac.new(os.environ['HMAC_KEY_RING'].encode(), sys.argv[1].encode(), hashlib.sha256).hexdigest())
" "$BODY")

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST "$BASE" \
        -H 'Content-Type: application/json' -H "X-Ring-Signature: $SIG" -d "$BODY")
echo "$KIND, $AGO_MIN minutes ago ($EVENT_TYPE${SUB_TYPE:+ / $SUB_TYPE}) -> $code"
[ "$code" = "200" ] || exit 1
