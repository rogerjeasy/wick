#!/usr/bin/env bash
#
# End-to-end test of the Ring webhook, using the real HMAC key.
#
# Proves the whole path before Ring ever sends anything:
#   signed request -> 200 -> idempotency record -> EventBridge -> log group
# and that an unsigned request is rejected, and a replay is absorbed.
#
#   ./scripts/test-ring-webhook.sh
#
set -uo pipefail
export AWS_PROFILE="${AWS_PROFILE:-wick-dev}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${WICK_EDGE_URL:-$(terraform -chdir="$ROOT/infra" output -raw ring_webhook_url 2>/dev/null)}"
[ -n "$BASE" ] || { echo "cannot resolve webhook url" >&2; exit 1; }

set -a; . "$ROOT/.env"; set +a
REQ_ID="test-$(date +%s)-$RANDOM"

BODY=$(python3 -c "
import json,sys,time
print(json.dumps({
  'request_id': sys.argv[1],
  'event_type': 'motion_detected',
  'sub_type': 'human',
  'device_id': 'synthetic-doorbell-0001',
  'occurred_at': int(time.time()*1000),
}))" "$REQ_ID")

SIG=$(python3 -c "
import hmac,hashlib,os,sys
print(hmac.new(os.environ['HMAC_KEY_RING'].encode(), sys.argv[1].encode(), hashlib.sha256).hexdigest())
" "$BODY")

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
        -H 'Content-Type: application/json' -H "X-Ring-Signature: deadbeef" -d "$BODY")
check "wrong signature rejected" 401 "$code"

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST "$BASE" \
        -H 'Content-Type: application/json' -H "X-Ring-Signature: $SIG" -d "$BODY")
check "valid signature accepted" 200 "$code"

ms=$(curl -s -o /dev/null -w '%{time_total}' --max-time 20 -X POST "$BASE" \
      -H 'Content-Type: application/json' -H "X-Ring-Signature: $SIG" -d "$BODY" \
      | python3 -c "import sys;print(int(float(sys.stdin.read())*1000))")
check "replay absorbed (idempotent)" 200 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST "$BASE" \
      -H 'Content-Type: application/json' -H "X-Ring-Signature: $SIG" -d "$BODY")"
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

echo
printf "  %d passed, %d failed\n" "$pass" "$fail"
[ "$fail" -eq 0 ]
