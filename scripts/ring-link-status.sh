#!/usr/bin/env bash
#
# Has Ring actually called us, and are we linked?
#
#   ./scripts/ring-link-status.sh [minutes]     (default 120)
#
# The API Gateway access log is the authoritative source: it records every
# request that reached the API, including ones that never got to a Lambda.
#
set -uo pipefail
export AWS_PROFILE="${AWS_PROFILE:-wick-dev}"
MINS="${1:-120}"
SINCE=$(python3 -c "import time,sys;print(int((time.time()-int(sys.argv[1])*60)*1000))" "$MINS")

echo "── every request that reached the API, last ${MINS} min ──"
aws logs filter-log-events --log-group-name /aws/apigateway/wick-edge \
  --start-time "$SINCE" --no-paginate --query 'events[].message' --output text 2>/dev/null \
| tr '\t' '\n' | python3 -c "
import sys, json
rows=[]
for line in sys.stdin:
    line=line.strip()
    if line.startswith('{'):
        try: rows.append(json.loads(line))
        except Exception: pass
if not rows:
    print('   no requests'); raise SystemExit
from collections import Counter
for (r,s),n in sorted(Counter((x.get('routeKey'),x.get('status')) for x in rows).items(), key=lambda x:-x[1]):
    print(f'   {n:>3}x  {r:<22} -> {s}')
"

echo
echo "── what Ring sent (values hashed, never plaintext) ──"
found=0
for f in link token; do
  out=$(aws logs filter-log-events --log-group-name "/aws/lambda/wick-ring-$f" \
        --start-time "$SINCE" --filter-pattern '{ $.msg = "*" }' --no-paginate \
        --query 'events[].message' --output text 2>/dev/null | tr '\t' '\n' | grep '^{' )
  [ -n "$out" ] && { echo "$out" | sed 's/^/   /'; found=1; }
done
[ "$found" -eq 0 ] && echo "   nothing"

echo
echo "── linked? ──"
# Shape only. Nothing here prints a token, or any prefix of one.
aws secretsmanager get-secret-value --secret-id wick/ring/tokens \
  --query SecretString --output text 2>/dev/null \
| python3 -c "
import sys, json, time
raw = sys.stdin.read().strip()
if not raw or raw == 'None':
    print('   no — token secret still empty'); raise SystemExit
try:
    t = json.loads(raw)
except Exception:
    print('   token secret present but unreadable'); raise SystemExit

print('   YES — tokens written to wick/ring/tokens')
print(f\"   access token   {'present' if t.get('access_token') else 'MISSING'}\")
print(f\"   refresh token  {'present' if t.get('refresh_token') else 'MISSING — re-link needed within the hour'}\")
print(f\"   account id     {'present' if t.get('accountId') else 'not resolved'}\")

exp = t.get('expiresAt') or (t.get('obtainedAt', 0) + t.get('expires_in', 14400) * 1000)
mins = int((exp - time.time() * 1000) / 60000)
print(f'   expires in     {mins} min')

# Tokens without this are valid and inert: device consents and webhooks stay
# dormant until Ring is told the integration is completed. See FL-003.
done = t.get('integrationCompletedAt')
print('   integration    completed' if done else '   integration    NOT COMPLETED — webhooks will stay silent (FL-003)')
"
