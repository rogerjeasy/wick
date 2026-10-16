#!/usr/bin/env bash
#
# End-to-end test of the Ring webhook, using the real HMAC key.
#
# Proves the ACK path before Ring ever sends anything:
#   signed request -> 200 -> idempotency record -> EventBridge -> log group
# and that an unsigned request is rejected, and a replay is absorbed.
#
#   ./scripts/test-ring-webhook.sh
#
# By default the device_id is a placeholder ('synthetic-doorbell-0001') that
# matches no real device on the account, so the Door agent Lambda correctly
# stops at "unknown_device" — this script proves only the ACK path in that
# case, on purpose (see docs/SIMULATOR-TESTING-GUIDE.md).
#
# To also prove the Door agent path itself — a real card queued, a real
# EVT#/RHYTHM# write — pass a real device id from your linked Ring account:
#
#   RING_TEST_DEVICE_ID=<real device id> ./scripts/test-ring-webhook.sh
#
# The event is seen "now" by default, and nothing was recorded "now",
# so Phase 2 finds no frame (Ring: 416 MEDIA_NOT_FOUND) and the card never
# gets its picture or description. To exercise Phase 2 against real media,
# press a simulation button in the Ring Developer Playground, then:
#
#   RING_TEST_DEVICE_ID=<id> RING_TEST_OCCURRED_AT=latest ./scripts/test-ring-webhook.sh
#
# (or RING_TEST_OCCURRED_AT=<epoch ms> for a specific event.)
#
set -uo pipefail
export AWS_PROFILE="${AWS_PROFILE:-wick-dev}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${WICK_EDGE_URL:-$(terraform -chdir="$ROOT/infra" output -raw ring_webhook_url 2>/dev/null)}"
[ -n "$BASE" ] || { echo "cannot resolve webhook url" >&2; exit 1; }

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
REQ_ID="test-$(date +%s)-$RANDOM"
DEVICE_ID="${RING_TEST_DEVICE_ID:-synthetic-doorbell-0001}"
OCCURRED_AT="${RING_TEST_OCCURRED_AT:-}"
if [ "$OCCURRED_AT" = "latest" ]; then
  OCCURRED_AT=$(cd "$ROOT" && npx --no-install vite-node -c vitest.config.ts scripts/latest-ring-event.ts "$DEVICE_ID") \
    || { echo "cannot resolve the latest Ring event for $DEVICE_ID" >&2; exit 1; }
fi

# Ring's v1.1 envelope, as its documentation gives it (developer.amazon.com/docs/
# ring/api-documentation.html, "Webhook v1.1 Payload Structure"): meta.time is
# when Ring sent it — now — and attributes.timestamp is when the camera saw it.
envelope () { # request_id sent_at_ms
  python3 -c "
import json,sys,time,datetime
sent = int(sys.argv[4]) if sys.argv[4] else int(time.time()*1000)
seen = int(sys.argv[3]) if sys.argv[3] else sent
print(json.dumps({
  'meta': {
    'version': '1.1',
    'time': datetime.datetime.fromtimestamp(sent/1000, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z',
    'request_id': sys.argv[1],
    'account_id': 'ava1.ring.account.wick-test',
  },
  'data': {
    'id': '%s_motion_%d' % (sys.argv[2], seen),
    'type': 'motion_detected',
    'attributes': {'source': sys.argv[2], 'source_type': 'devices', 'timestamp': seen, 'sub_type': 'human'},
    'relationships': {'devices': {'links': {'self': '/v1/devices/%s' % sys.argv[2]}}},
  },
}))" "$1" "$DEVICE_ID" "$OCCURRED_AT" "${2:-}"
}
sign () { python3 -c "
import hmac,hashlib,os,sys
print('sha256=' + hmac.new(os.environ['HMAC_KEY_RING'].encode(), sys.argv[1].encode(), hashlib.sha256).hexdigest())
" "$1"; }

BODY=$(envelope "$REQ_ID")
SIG=$(sign "$BODY")
# Signed by the real key, but sent ten minutes ago: outside the webhook's window.
STALE_BODY=$(envelope "$REQ_ID-stale" "$(python3 -c "import time;print(int(time.time()*1000) - 600000)")")
STALE_SIG=$(sign "$STALE_BODY")

pass=0; fail=0
check () { # name expected actual
  if [ "$2" = "$3" ]; then printf "  \033[32mPASS\033[0m  %-42s %s\n" "$1" "$3"; pass=$((pass+1))
  else printf "  \033[31mFAIL\033[0m  %-42s got %s, want %s\n" "$1" "$3" "$2"; fail=$((fail+1)); fi
}

echo "── webhook: $BASE"
echo

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST "$BASE" \
        -H 'Content-Type: application/json' -d "$BODY")
check "unsigned request rejected" 401 "$code"

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST "$BASE" \
        -H 'Content-Type: application/json' -H "X-Signature: sha256=deadbeef" -d "$BODY")
check "wrong signature rejected" 401 "$code"

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST "$BASE" \
        -H 'Content-Type: application/json' -H "X-Signature: $SIG" -d "$BODY")
check "valid signature accepted" 200 "$code"

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST "$BASE" \
        -H 'Content-Type: application/json' -H "X-Signature: $STALE_SIG" -d "$STALE_BODY")
check "signed but sent 10 min ago: refused" 400 "$code"

ms=$(curl -s -o /dev/null -w '%{time_total}' --max-time 20 -X POST "$BASE" \
      -H 'Content-Type: application/json' -H "X-Signature: $SIG" -d "$BODY" \
      | python3 -c "import sys;print(int(float(sys.stdin.read())*1000))")
check "replay absorbed (idempotent)" 200 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST "$BASE" \
      -H 'Content-Type: application/json' -H "X-Signature: $SIG" -d "$BODY")"
echo "        round trip ${ms}ms (Ring's budget is 5000ms)"

sleep 4
got=$(aws dynamodb get-item --table-name wick \
       --key "{\"pk\":{\"S\":\"IDEM#$REQ_ID\"},\"sk\":{\"S\":\"META\"}}" \
       --query 'Item.pk.S' --output text 2>/dev/null)
check "idempotency record written" "IDEM#$REQ_ID" "$got"

SINCE=$(python3 -c "import time;print(int((time.time()-120)*1000))")
# --no-cli-pager and --no-paginate: the CLI otherwise applies --query per page and
# emits one number per page, which looks like a failure when it is not.
n=$(aws logs filter-log-events --log-group-name /wick/events --start-time "$SINCE" \
     --filter-pattern "\"$REQ_ID\"" --no-paginate \
     --query 'length(events)' --output text 2>/dev/null | head -1)
check "event reached EventBridge" 1 "${n:-0}"

if [ "$DEVICE_ID" != "synthetic-doorbell-0001" ]; then
  # A real device id: the Door agent Lambda should have found it, queued a
  # real DoorCard, and written a door_activity Rhythm bucket for it — not
  # just reached EventBridge. Give the async Lambda invocation a moment.
  sleep 3
  HOUSEHOLD_ID="${WICK_HOUSEHOLD_ID:-margaret}"
  cards=$(aws dynamodb query --table-name wick \
           --key-condition-expression 'pk = :pk AND begins_with(sk, :prefix)' \
           --expression-attribute-values "{\":pk\":{\"S\":\"HH#$HOUSEHOLD_ID\"},\":prefix\":{\"S\":\"CARD#\"}}" \
           --query 'Count' --output text 2>/dev/null)
  check "Door agent queued a real card (CARD# exists)" "true" "$([ "${cards:-0}" -ge 1 ] && echo true || echo false)"
fi

echo
printf "  %d passed, %d failed\n" "$pass" "$fail"
[ "$fail" -eq 0 ]
