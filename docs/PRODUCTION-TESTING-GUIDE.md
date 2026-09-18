# Wick — Production Verification Guide

**Purpose.** `docs/SIMULATOR-TESTING-GUIDE.md` teaches you how to drive the
system when you don't have physical hardware. This document is different:
it's a health-check and verification runbook for the **real, deployed AWS
production stack** — the thing that's actually live right now, independent
of whatever's running on your laptop. Run this before a demo, before a
submission, or any time you want to know "is production actually healthy?"
without guessing.

**Scope.** Every URL and resource below is real AWS infrastructure managed
by Terraform in `infra/`. Nothing here is `npm run dev` or `python -m
http.server`. Where a check needs simulated *input* (no physical Ring
doorbell, no Fire TV Stick), that's noted explicitly — the *system* being
tested is never simulated, only the edge device triggering it.

> **Prefer clicking over curl?** Most of this guide now has a web UI
> equivalent — `apps/ops-console`, deployed at:
>
> ```bash
> cd infra && terraform output -raw ops_console_url && cd ..
> ```
>
> - **`/` (Dashboard)** — §1's entire health check, live, auto-refreshing,
>   color-coded. Same underlying `GET /status` data, no terminal required.
> - **`/device.html` (Virtual Device)** — §3's pairing + WebSocket dance,
>   as one button. Renders real cards as they arrive, mimicking the
>   television's own large-type calm design, and has buttons for the
>   telemetry §3 sends by hand.
>
> The terminal commands below still work exactly as documented — they're
> what the UI is built on top of, and they're the better choice for
> scripting or CI. This is the faster path for a live demo.

---

## 0. Prerequisites

```bash
cd wick
export AWS_PROFILE=wick-dev
export WICK_HOUSEHOLD_ID=margaret
export TABLE_NAME=wick
```

All commands below assume these three are exported in whatever shell runs
them, and that `cd infra && terraform output -raw <name>` resolves the
current values (they're written as live lookups, not hardcoded, since a
future redeploy could change hostnames/IDs).

---

## 1. One-shot health check

Run this first, every time. It hits every deployed HTTP surface and checks
for the *expected* status code — not just "200 somewhere," since some of
these correctly return 4xx by design (an unsigned webhook, a WS endpoint hit
over plain HTTPS).

```bash
cd infra

MCP_URL=$(terraform output -raw mcp_server_url)
SIM_URL=$(terraform output -raw sim_alexa_url)
RING_AUTH=$(terraform output -raw ring_authorize_url)
RING_WEBHOOK=$(terraform output -raw ring_webhook_url)
PAIRING_URL=$(terraform output -raw pairing_api_url)
WS_URL=$(terraform output -raw websocket_url)
cd ..

echo "MCP server (App Runner):"
curl -s -o /dev/null -w "  %{http_code} (want 200)\n" "$MCP_URL/.well-known/oauth-authorization-server"

echo "sim-alexa (CloudFront):"
curl -s -o /dev/null -w "  index.html: %{http_code} (want 200)\n" "$SIM_URL/"
curl -s -o /dev/null -w "  main.js:    %{http_code} (want 200)\n" "$SIM_URL/main.js"

echo "Ring edge:"
curl -s -o /dev/null -w "  /ring/authorize: %{http_code} (want 302 — redirects to Ring)\n" "$RING_AUTH"
curl -s -o /dev/null -w "  /ring/webhook (unsigned): %{http_code} (want 401 — correctly rejected)\n" -X POST "$RING_WEBHOOK" -d '{}'

echo "Pairing API:"
curl -s -o /dev/null -w "  /pair/status?code=x: %{http_code} (want 404 — no such code, correctly refused)\n" "$PAIRING_URL/pair/status?code=x"

echo "WebSocket transport:"
HTTPS_WS=$(echo "$WS_URL" | sed 's/^wss:/https:/')
curl -s -o /dev/null -w "  %{http_code} (want 426 Upgrade Required — confirms it's alive, just not speaking HTTP)\n" "$HTTPS_WS"
```

| Check | Expected | Means |
|---|---|---|
| MCP server OAuth metadata | `200` | App Runner container is up and serving |
| sim-alexa `/` and `/main.js` | `200` / `200` | CloudFront + S3 origin serving |
| `/ring/authorize` | `302` | Edge API Gateway + Lambda routing correctly |
| `/ring/webhook` unsigned | `401` | HMAC verification actually runs, doesn't fail open |
| `/pair/status?code=x` | `404` | Pairing Lambda + DynamoDB reachable |
| WebSocket over HTTPS | `426` | API Gateway WebSocket route exists and answers |

Any deviation from this table is the first thing to chase — it tells you
*which* layer broke before you go looking inside it.

### 1a. App Runner's own reported status

The health check above proves the container answers HTTP; this confirms
AWS's own view of the service:

```bash
SERVICE_ARN=$(cd infra && terraform output -raw mcp_service_arn)
aws apprunner describe-service --service-arn "$SERVICE_ARN" \
  --query 'Service.{Status:Status,UpdatedAt:UpdatedAt}' --output table
```

Want `RUNNING`. Anything else (`OPERATION_IN_PROGRESS`, `CREATE_FAILED`,
`DELETED`) means don't trust the curl check above even if it happened to
return 200 moments ago.

---

## 2. Ring — the door, in production

### 2a. What's real here right now

```bash
./scripts/ring-link-status.sh 60
```

Expect: `access token present`, `refresh token present`, `account id
present`, and a non-zero `expires in` — that's `wick-ring-refresh` (an
hourly EventBridge-scheduled Lambda) keeping the real linked account's OAuth
token alive automatically. Confirm the schedule itself is actually enabled:

```bash
aws events describe-rule --name wick-ring-refresh --region us-east-1 --query State
```

Want `"ENABLED"`.

### 2b. The known limitation — read this before assuming something's broken

`ring-link-status.sh` will show `integration NOT COMPLETED — webhooks will
stay silent`. **This is expected, documented, and not something to try to
fix mid-demo.** See `FRICTION.md` FL-003 and FL-010 for the full account:
Ring's own "mark this integration active" API call rejects with an
undocumented `Invalid Status Transition`, and the console's parallel
"Sign in" flow (which looks like it should help) is a dead end confirmed
both by testing and by this repo's own code. **Practical consequence: a
real, physical Ring doorbell press will not reach the webhook right now.**
The workaround below fully substitutes for it.

### 2c. Prove the Door agent's production path end to end

This is the real test that matters — not "does Ring send a webhook" (it
won't, see above) but "does our own deployed pipeline correctly turn a
webhook into a card and a Rhythm write."

```bash
# Get a real device id once (from whichever Ring identity currently has one —
# see docs/SIMULATOR-TESTING-GUIDE.md §2 if you need to refresh this)
RING_TEST_DEVICE_ID=<real device id> ./scripts/test-ring-webhook.sh
```

Expect **7 passed, 0 failed**, including `Door agent queued a real card
(CARD# exists)`. This signs a synthetic payload with the real HMAC key and
posts it to the real webhook endpoint — simulating exactly the webhook Ring
itself won't send (§2b), while every downstream system (EventBridge, the
Door agent Lambda, DynamoDB, the Rhythm bucket writer) is 100% the real,
deployed thing.

Confirm what actually landed:

```bash
aws dynamodb query --table-name wick \
  --key-condition-expression "pk = :pk AND begins_with(sk, :prefix)" \
  --expression-attribute-values "{\":pk\":{\"S\":\"HH#$WICK_HOUSEHOLD_ID\"},\":prefix\":{\"S\":\"EVT#\"}}" \
  --region us-east-1

aws dynamodb query --table-name wick \
  --key-condition-expression "pk = :pk AND begins_with(sk, :prefix)" \
  --expression-attribute-values "{\":pk\":{\"S\":\"HH#$WICK_HOUSEHOLD_ID\"},\":prefix\":{\"S\":\"RHYTHM#door_activity\"}}" \
  --region us-east-1
```

### 2d. Watch the Door agent Lambda directly

```bash
aws logs tail /aws/lambda/wick-agent-door-event --since 10m --region us-east-1
```

A healthy run shows `{"level":"info","msg":"door_event_routed","result":"sent"}`.
`"result":"unknown_device"` means the device id used doesn't exist under
whichever Ring identity Secrets Manager currently holds — see the "two
identities" note in `docs/SIMULATOR-TESTING-GUIDE.md` §2a before assuming
the Lambda itself is broken.

---

## 3. Device pairing + card delivery, in production

No physical Fire TV needed — any WebSocket client is a valid "device" as
far as the backend is concerned.

```bash
export PAIRING_API_URL=$(cd infra && terraform output -raw pairing_api_url)
export WEBSOCKET_URL=$(cd infra && terraform output -raw websocket_url)

DEVICE_ID="prodcheck-$(date +%s)"
CODE=$(curl -s -X POST "$PAIRING_API_URL/pair/start" -H 'Content-Type: application/json' \
  -d "{\"deviceId\":\"$DEVICE_ID\"}" | python3 -c "import json,sys;print(json.load(sys.stdin)['code'])")

curl -s -X POST "$PAIRING_API_URL/pair/claim" -H 'Content-Type: application/json' \
  -d "{\"code\":\"$CODE\",\"householdId\":\"$WICK_HOUSEHOLD_ID\"}"

JWT=$(curl -s "$PAIRING_API_URL/pair/status?code=$CODE" | python3 -c "import json,sys;print(json.load(sys.stdin)['token']['jwt'])")

wscat -c "$WEBSOCKET_URL?token=$JWT"
```

Leave that `wscat` connection open, then repeat §2c in another terminal —
a `DoorCard` JSON payload should print within a few seconds. That's the
entire S1 pipeline (webhook → EventBridge → Door agent → device push),
proven against production infrastructure with a generic client standing in
for the Fire TV.

---

## 4. MCP server — production

### 4a. Spec compliance

```bash
MCP_URL=$(cd infra && terraform output -raw mcp_server_url)
npx @modelcontextprotocol/inspector
```

Connect to `$MCP_URL/mcp`, Streamable HTTP. Complete the OAuth prompt (real
OAuth 2.1 + PKCE, not a stub). Call each tool and confirm a real, non-error
response:

- `get_week_narrative`
- `get_today`
- `did_visitor_come`
- `send_note_to_tv` — watch it land in an open `wscat` session from §3
- `get_resident_shared_view`

### 4b. Auth is actually enforced, not decorative

```bash
curl -s -i -X POST "$MCP_URL/mcp" -H 'Content-Type: application/json' -d '{}' | head -5
```

Want `401`, and **no** `WWW-Authenticate` header (§7.3's spec requirement —
`requireAuth()` strips it deliberately; verify it's actually gone, not just
unset by accident).

### 4c. Watch it live

App Runner's log group name embeds the service ID, so look it up rather
than guessing it:

```bash
LOG_GROUP=$(aws logs describe-log-groups --log-group-name-prefix /aws/apprunner/wick-mcp-server \
  --region us-east-1 --query "logGroups[?ends_with(logGroupName, '/application')].logGroupName" --output text)
aws logs tail "$LOG_GROUP" --since 10m --region us-east-1 --follow
```

(There's a sibling `.../service` log group too — platform-level events
like deploys and health checks, as opposed to `.../application`'s stdout
from the container itself.)

---

## 5. sim-alexa — production

```bash
open "$(cd infra && terraform output -raw sim_alexa_url)"
```

Confirm: the "MCP server URL" field is already pre-filled with the real
App Runner URL (baked in at deploy time — if it says `127.0.0.1`, the S3
object is stale; see §7). Click through all four tools. `get_week_narrative`
should render as a real panel, not raw JSON.

---

## 6. Rhythm baseline — is it actually accumulating?

```bash
aws dynamodb query --table-name wick \
  --key-condition-expression "pk = :pk AND begins_with(sk, :prefix)" \
  --expression-attribute-values "{\":pk\":{\"S\":\"HH#$WICK_HOUSEHOLD_ID\"},\":prefix\":{\"S\":\"RHYTHM#\"}}" \
  --region us-east-1 --query 'Items[].{bucket:sk.S,count:count.N,lastSeenAt:lastSeenAt.N}' --output table
```

Each row is one `(dimension, day-of-week, hour)` bucket. `count` should be
monotonically increasing across repeated real test runs (§2c) — if it isn't
growing at all over several days of real usage, that's the signal the
baseline clock isn't actually running, not a cosmetic issue.

---

## 7. Redeploying a piece that's gone stale

**MCP server** (code change in `services/mcp-server`):
```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_URL="${ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com/wick-mcp-server"
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com"
docker build --platform linux/amd64 -f services/mcp-server/Dockerfile -t "${ECR_URL}:latest" .
docker push "${ECR_URL}:latest"
```
App Runner auto-deploys on the new `:latest` push — no `terraform apply`
needed. Watch it land with §1a's `describe-service` command.

**sim-alexa** (edit to `index.html`/`main.js`):
```bash
terraform -chdir=infra apply -target=aws_s3_object.sim_alexa_index -target=aws_s3_object.sim_alexa_main_js
aws cloudfront create-invalidation \
  --distribution-id "$(cd infra && terraform output -raw sim_alexa_distribution_id)" --paths "/*"
```

**ops-console** (edit to anything in `apps/ops-console`):
```bash
terraform -chdir=infra apply \
  -target=aws_s3_object.ops_console_index -target=aws_s3_object.ops_console_device_html \
  -target=aws_s3_object.ops_console_styles_css -target=aws_s3_object.ops_console_device_css \
  -target=aws_s3_object.ops_console_status_js -target=aws_s3_object.ops_console_device_js
aws cloudfront create-invalidation \
  --distribution-id "$(cd infra && terraform output -raw ops_console_distribution_id)" --paths "/*"
```
The two `.js` files have URLs baked in at upload time (`infra/ops-console.tf`'s
`replace()` locals) — editing them requires re-running `terraform apply`
even though nothing in the Terraform *config* changed, since the rendered
`content` is a function of a live resource attribute (the API's own URL).

**Lambdas** (Ring edge, Door agent, pairing, narrator, status): `terraform apply`
from `infra/` — CDC pipeline (`.github/workflows/`) does this automatically
on push to `main`; a local apply is only for testing a change before
pushing.

Full command reference for every service: `docs/SIMULATOR-TESTING-GUIDE.md`.

---

## 8. Go/no-go checklist

Run through this before a demo or a submission. Every row should be green.

- [ ] §1 one-shot health check — all 6 expected codes match
- [ ] §1a App Runner status is `RUNNING`
- [ ] §2a Ring token is linked, refreshing, `wick-ring-refresh` rule `ENABLED`
- [ ] §2c synthetic webhook test — 7/7 passed, real card queued
- [ ] §3 a `wscat`-simulated device receives a real card within seconds of §2c
- [ ] §4a MCP Inspector completes OAuth and all 5 tools respond
- [ ] §4b unauthenticated `/mcp` call returns 401 with no `WWW-Authenticate`
- [ ] §5 sim-alexa loads, MCP URL field is correct, all 4 buttons work
- [ ] §6 at least one `RHYTHM#` bucket exists and its count is growing over time

If everything above is green, the deployed production system — not a local
process, not a mock — is demonstrably working end to end, with only the
physical Ring doorbell and Fire TV Stick standing in for real hardware
(§2b's documented, unavoidable limitation aside).
