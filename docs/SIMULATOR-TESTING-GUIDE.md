# Wick — Simulator Testing Guide

**Purpose.** You don't have the real hardware yet (Fire TV Stick, Ring doorbell in
place, Bee wearable). The hackathon rules explicitly allow simulators as a
substitute — Ring's own Developer Playground for doorbell events, MCP Inspector
and a purpose-built web client for Alexa+, and a raw WebSocket connection
standing in for the Fire TV. This guide walks every piece, in the order that
proves the most first.

**What this proves, and what it doesn't.** Every step below drives the *real*
deployed AWS pipeline — the real webhook receiver, the real Door agent, the real
MCP server, the real Guardian, the real DynamoDB table. Nothing here is a mock
of Wick's own code; only the *edges* (the physical devices) are stood in for.
That distinction matters for the submission: this is "simulated input, real
system," not "simulated system."

**Everything runs on real, deployed AWS infrastructure — nothing here is
"start it on your laptop and call that the demo."** That includes the MCP
server (§4b: AWS App Runner, not a local `npm run dev` process) and the
simulated Alexa+ surface (§4d: S3 + CloudFront, not a local static file
server). Local-process versions of both still work and are documented as
the faster inner loop for active development, but the URLs you'd actually
put in a submission or a live demo are real HTTPS endpoints that keep
running whether or not your laptop is on.

**Do not skip §1.** Every other section depends on getting the same
`WICK_HOUSEHOLD_ID` and `TABLE_NAME` used everywhere — the single most common
way this goes wrong is one terminal quietly reading/writing a different,
empty household partition than the others.

---

## 0. Prerequisites

```bash
cd wick
nvm use                 # Node 22 — see .nvmrc
npm install
npm run verify           # typecheck + lint + no-mocks guard + tests — confirm green before testing live
```

You'll also want, in a second terminal tab kept open for the whole session:

```bash
export AWS_PROFILE=wick-dev
export WICK_HOUSEHOLD_ID=margaret     # matches infra/variables.tf's household_id default
export TABLE_NAME=wick
```

Every command below assumes these three are exported in whatever shell runs it.
**If a step returns nothing when you expect data, the first thing to check is
whether this terminal actually has them set.**

> **Every section below opens a new terminal tab.** Exported env vars do not
> carry to a new tab — each section that says "in a new tab" starts with a
> `# new tab —` block restating exactly what that tab needs. Run it verbatim,
> even if you're sure you already exported it somewhere else. This is the
> single most common way a fresh command fails with something like `TABLE_NAME
> must be set` or a query that silently returns nothing.

---

## 1. Capture your deployed URLs (one-time)

```bash
cd infra
terraform output
```

You'll see something like this (yours will differ in the random ID segments):

| Output | What it's for |
|---|---|
| `ring_authorize_url` | Starts the Ring OAuth link flow |
| `ring_webhook_url` | Where Ring (or your synthetic test) posts doorbell events |
| `pairing_api_url` | `/pair/start`, `/pair/claim`, `/pair/status` — how a "device" joins a household |
| `websocket_url` | Where a paired device connects to receive cards |
| `table_name` | Should read `wick` |
| `event_bus_name` | The EventBridge bus everything flows through |
| `media_bucket` | Door snapshot storage (24h lifecycle) |

Save the three you'll type most often:

```bash
cd ..   # back to wick/
export RING_WEBHOOK_URL=$(terraform -chdir=infra output -raw ring_webhook_url)
export PAIRING_API_URL=$(terraform -chdir=infra output -raw pairing_api_url)
export WEBSOCKET_URL=$(terraform -chdir=infra output -raw websocket_url)
```

---

## 2. Simulate Ring — the eyes at the door

You have two levels of simulation here. Do both; they prove different things.

### 2a. Get a working Ring credential — do this once, permanently

**Preferred: link the real account.** This repo already ships a fully
deployed, hourly auto-refresh Lambda (`wick-ring-refresh`) that keeps a real
OAuth-linked account's access token warm forever using its refresh token —
you never touch this again after linking once:

```bash
open "$(cd infra && terraform output -raw ring_authorize_url)"
```

Complete Ring's OAuth consent in the browser. Confirm it worked:

```bash
./scripts/ring-link-status.sh
```

Look for `refresh token present` — that's what makes this permanent.
`scripts/env.ts`'s `ringToken()` (used by every demo script) now reads this
same Secrets-Manager-backed credential automatically, first — no `.env`
editing required, ever, once this is linked.

**Fallback: a Playground token**, if you haven't linked a real account yet,
or want to test as a different Ring identity. Ring's
[Developer Playground](https://developer.amazon.com/ring/console/playground)
issues a ~30-minute access token with no OAuth dance:

```bash
./scripts/set-ring-token.sh
```

Paste the Playground token when prompted (or put it in `.env` as
`RING_OAUTH_TOKEN` first and the script will pick it up automatically). It
verifies the token against `/v1/users/me` before storing it — a rejected
token is never silently saved. **This overwrites whatever is currently in
Secrets Manager**, including a real linked account's refresh token — don't
run this once you have a real account linked and working, unless you
deliberately want to switch identities.

> **Two different Ring "accounts" are easy to conflate.** A real OAuth link
> and a Playground token can point at *different* device fleets even though
> both feel like "Ring." If a device id from one suddenly stops matching
> (`unknown_device` in the Door agent's logs), check which credential is
> actually in Secrets Manager right now with `ring-link-status.sh` before
> assuming anything else is broken.

Re-run whichever path you're using whenever `ring-link-status.sh` shows
`expires in 0 min` or worse — which, on the real-account path, should never
happen on its own.

> **Known gap — check this line in `ring-link-status.sh`'s output:**
> `integration NOT COMPLETED — webhooks will stay silent (FL-003)`. Ring
> requires a completion PATCH after the OAuth exchange to actually wake up
> device consents and webhooks; `link.mjs` sends it, but Ring may reject it
> with `400 Invalid Status Transition`. If you see this, **§2b and §2d below
> still work** (they call the Ring API directly, which only needs the access
> token) — but a *real* physical doorbell press will never reach
> `$RING_WEBHOOK_URL`, because Ring itself isn't sending anything yet. §2c
> (`test-ring-webhook.sh`) is unaffected either way, since it posts directly
> to your endpoint and never depends on Ring's integration state. See
> `FRICTION.md` FL-003 for the full account; this is a platform-side
> rejection, not a bug in this repo's OAuth code.

### 2b. Trigger a simulated doorbell event

In the Playground console, use **live-view event simulation** to raise a
**Package**, **Vehicle**, or **Motion (human)** event on your test device. This
is Ring's own simulator — the event lands in real device history exactly like
a physical doorbell press would.

Watch it arrive, end to end, with real timing numbers:

```bash
npm run demo:capture -- --watch
```

Trigger the event in the Playground *after* this prints "watching for a NEW
event." You'll see the real vision-model description Wick would put on the
card, and a JPEG saved to `/tmp/ring-*.jpg` you can open and eyeball.

### 2c. Prove the ingestion path itself (no Ring account needed at all)

This exercises your own webhook receiver — HMAC verification, idempotency,
EventBridge handoff — independent of whether Ring ever sends anything:

```bash
./scripts/test-ring-webhook.sh
```

Expect all six checks to pass (`unsigned rejected`, `wrong signature
rejected`, `valid signature accepted`, `replay absorbed`, `idempotency record
written`, `event reached EventBridge`). This is the fastest possible smoke
test if you only have a few minutes.

**With the default device id, this only proves the ACK path.** The payload's
`device_id` is a placeholder that matches nothing on your real account, so
the Door agent Lambda correctly stops at `unknown_device` and writes nothing
further — that's the gate working, not a failure of this test, but it means
no card gets queued and no `EVT#`/`RHYTHM#` row appears in DynamoDB.

To prove the Door agent's part of the path too — a real card queued, a real
`door_activity` Rhythm bucket written — pass a real device id from your
linked Ring account:

```bash
RING_TEST_DEVICE_ID=<real device id> ./scripts/test-ring-webhook.sh
```

This adds a seventh check (`Door agent queued a real card`) and is the
closest thing to a real doorbell press this repo can produce without Ring's
webhook delivery actually working end to end (see the `FL-003` callout in
§2a) — it simulates the webhook Ring *should* send, to a device that
genuinely exists, so the Door agent's device lookup succeeds instead of
gating.

### 2d. Confirm the full S1 pipeline end to end

```bash
npm run demo:door
```

This prints Phase 1 (the card, instantly), Phase 2a (the real snapshot fetch,
timed), and Phase 2b (the real vision description) against whatever the most
recent history event was. Every millisecond printed is real.

---

## 3. Simulate a Fire TV — pairing and receiving cards with no physical stick

**This section now also exists as a web page.** `apps/ops-console`'s
Virtual Device (`terraform output -raw ops_console_url` + `/device.html`)
does everything below with one click — pairing, connecting, and rendering
real cards as they arrive in a TV-like preview — and is the faster choice
for a live demo. The CLI walkthrough below is what that page is built on
top of, and is still the right tool for scripting.

The point of `WebSocketChannel.ts` is that *any* WebSocket client is a valid
device as far as the backend is concerned — a generic CLI client works just
as well as the page above.

Install a WebSocket CLI once:

```bash
npm install -g wscat
```

### 3a. Pair a fake device

```bash
# new tab —
export AWS_PROFILE=wick-dev
export WICK_HOUSEHOLD_ID=margaret
export PAIRING_API_URL=$(cd infra && terraform output -raw pairing_api_url)
export WEBSOCKET_URL=$(cd infra && terraform output -raw websocket_url)

DEVICE_ID="sim-tv-$(date +%s)"

# 1. The "TV" boots unpaired and requests a code
curl -s -X POST "$PAIRING_API_URL/pair/start" \
  -H 'Content-Type: application/json' \
  -d "{\"deviceId\":\"$DEVICE_ID\"}" | tee /tmp/pair-start.json
CODE=$(python3 -c "import json;print(json.load(open('/tmp/pair-start.json'))['code'])")
echo "code: $CODE"

# 2. "Sarah's phone" confirms the binding
curl -s -X POST "$PAIRING_API_URL/pair/claim" \
  -H 'Content-Type: application/json' \
  -d "{\"code\":\"$CODE\",\"householdId\":\"$WICK_HOUSEHOLD_ID\"}"

# 3. The TV polls until it's bound, and collects its token
curl -s "$PAIRING_API_URL/pair/status?code=$CODE" | tee /tmp/pair-status.json
JWT=$(python3 -c "import json;print(json.load(open('/tmp/pair-status.json'))['token']['jwt'])")
```

### 3b. Open the WebSocket exactly like the real app would

```bash
wscat -c "$WEBSOCKET_URL?token=$JWT"
```

You're now, as far as the backend is concerned, a paired Fire TV. Anything the
Door agent, the Guardian, or `send_note_to_tv` (§4) sends to this household
arrives in this terminal as raw JSON.

### 3c. Watch a real card arrive, live

Leave the `wscat` connection open, then repeat **§2b or §2c** in another
terminal. Within a few seconds a `DoorCard` JSON payload should print in the
`wscat` window — the full S1 pipeline, visualized, with no TV hardware
involved anywhere.

### 3d. Send simulated device telemetry (drives S2 and S6)

Paste these lines directly into the open `wscat` prompt (each is one message):

```json
{"t":"app_lifecycle","state":"fg","at":1234567890000}
```
```json
{"t":"playback","state":"PLAYING","positionMs":0,"durationMs":1500000,"contentId":"demo-1","at":1234567890000}
```

Use a real current timestamp (`date +%s000` gives you epoch milliseconds).
These feed the Rhythm baseline (§5) exactly like a real Fire TV's playback
events would.

---

## 4. Simulate Alexa+ — the family line

The Alexa+ MCP Toolkit is partner-gated with no application path (see
`FRICTION.md` FL-001) — the hackathon rules' named alternative is a simulated
Alexa+ surface, which `apps/sim-alexa` already is. **Say so on screen in any
demo** — never present this as a real Echo integration.

### 4a. Seed stub household data (optional, until real data exists)

If §2/§3 haven't produced a week's worth of real timeline data yet, seed
enough to exercise every MCP tool meaningfully:

```bash
# new tab —
export AWS_PROFILE=wick-dev
export WICK_HOUSEHOLD_ID=margaret
export TABLE_NAME=wick

npm run demo:mcp-seed
```

This writes to `HH#$WICK_HOUSEHOLD_ID` in the live table — make sure
`WICK_HOUSEHOLD_ID` is still `margaret` in this terminal, or you'll seed a
household nothing else reads from.

### 4b. The MCP server — deployed, not local

The MCP server and `apps/sim-alexa` are both genuinely deployed to AWS —
this is not a "run it on your laptop and call that done" setup. The MCP
server runs as an **App Runner** service (`infra/mcp.tf`), reachable at a
stable public HTTPS URL:

```bash
export AWS_PROFILE=wick-dev
cd infra && terraform output -raw mcp_server_url && cd ..
```

That URL is real, live, and answers OAuth metadata correctly right now —
confirm any time with:

```bash
curl -s "$(cd infra && terraform output -raw mcp_server_url)/.well-known/oauth-authorization-server"
```

**Why App Runner, not Lambda.** The server holds in-memory OAuth session
state (`auth.ts`'s client/token maps) and one `McpServer` instance per MCP
session across a Streamable HTTP connection — state that has to survive
across several requests in the same session. Lambda gives no guarantee two
requests in one session hit the same execution environment; App Runner is
one long-running container, so that assumption actually holds. See
`infra/mcp.tf`'s header comment for the full reasoning, including why this
is deliberately a single-instance deployment (a second instance would hold
a *different* copy of the same in-memory state).

**Redeploying after a code change** — there's no CI wired up for this yet,
so it's a manual build-and-push, same as any container service:

```bash
export AWS_PROFILE=wick-dev
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_URL="${ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com/wick-mcp-server"

aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com"
docker build --platform linux/amd64 -f services/mcp-server/Dockerfile -t "${ECR_URL}:latest" .
docker push "${ECR_URL}:latest"
```

App Runner's `auto_deployments_enabled` (the Terraform default) picks up the
new `:latest` push and redeploys on its own — no `terraform apply` needed
for a code-only change. Watch it land:

```bash
SERVICE_ARN=$(cd infra && terraform output -raw mcp_service_arn)
watch -n5 "aws apprunner describe-service --service-arn '$SERVICE_ARN' --query Service.Status --output text"
```

**No Docker locally?** This repo's build used
[`colima`](https://github.com/abiosoft/colima) (`brew install colima
docker && colima start`) rather than Docker Desktop — a scriptable,
non-interactive Docker daemon for exactly this kind of build-and-push step.

**If you'd rather iterate against a local process** (faster than a full
build/push/redeploy cycle while actively changing `services/mcp-server`
code), that still works exactly as before:

```bash
# new tab —
export AWS_PROFILE=wick-dev
export WICK_HOUSEHOLD_ID=margaret
export TABLE_NAME=wick

cd services/mcp-server
npm run dev
```

Every tool in this server (`get_today`, `did_visitor_come`, ...) reads a
single module-level `HOUSEHOLD_ID` constant fixed at process start from
`WICK_HOUSEHOLD_ID` — if this tab doesn't have it exported *before* `npm run
dev` starts, the whole server quietly serves `dev-household` for its entire
run. There is no way to fix this after the fact short of restarting the
process with the var set. It logs its own local URL (default
`http://127.0.0.1:3300`); `cloudflared tunnel --url http://127.0.0.1:3300`
gives it real HTTPS if a client needs that without deploying.

### 4c. Exercise it with MCP Inspector (the spec-compliance proof)

```bash
npx @modelcontextprotocol/inspector
```

Connect to `<mcp_server_url>/mcp` (the deployed URL from §4b, or
`http://127.0.0.1:3300/mcp` if you're running locally), Streamable HTTP
transport. Inspector will prompt an OAuth authorization in your browser —
the server is a real OAuth 2.1 + PKCE authorization server, so complete
that flow rather than looking for a bypass. Once connected, call each tool:

- `get_week_narrative`
- `get_today`
- `did_visitor_come`
- `send_note_to_tv` — **watch this one land in your open `wscat` window from §3b**
- `get_resident_shared_view`

### 4d. Exercise it with the actual simulated surface

`apps/sim-alexa` is deployed too — S3 behind CloudFront (`infra/sim-alexa.tf`),
no server-side code, so there's no process to run at all:

```bash
export AWS_PROFILE=wick-dev
cd infra && terraform output -raw sim_alexa_url && cd ..
```

Open that URL. Its "MCP server URL" field already defaults to the deployed
App Runner URL from §4b (baked in at upload time — see `infra/sim-alexa.tf`'s
`sim_alexa_index_html` local) — click through the four buttons as-is.
`get_week_narrative`'s response renders as a real panel (prose + timeline);
the others show raw JSON.

**Redeploying sim-alexa after an edit** to `index.html`/`main.js`:

```bash
export AWS_PROFILE=wick-dev
terraform -chdir=infra apply -target=aws_s3_object.sim_alexa_index -target=aws_s3_object.sim_alexa_main_js
aws cloudfront create-invalidation \
  --distribution-id "$(cd infra && terraform output -raw sim_alexa_distribution_id)" \
  --paths "/*"
```

CloudFront caches aggressively (its default TTL applies since S3 doesn't set
explicit `Cache-Control` headers) — a content change without that
invalidation can take up to 24h to become visible otherwise.

**Prefer the local, no-deploy version instead?** It still works:

```bash
# new tab —
cd apps/sim-alexa
npm run dev          # python3 -m http.server 5500
```

Open `http://127.0.0.1:5500` and paste in whichever MCP server URL you're
targeting (deployed or local) — the field is always editable regardless of
its default.

---

## 5. Verify the Rhythm baseline (S6) is actually recording

After doing any of §2b/§2c (door/presence) or §3d (TV activity), confirm real
buckets are accumulating. If this is yet another new tab:

```bash
export AWS_PROFILE=wick-dev
export WICK_HOUSEHOLD_ID=margaret
```

```bash
aws dynamodb query \
  --table-name wick \
  --key-condition-expression "pk = :pk AND begins_with(sk, :prefix)" \
  --expression-attribute-values "{\":pk\":{\"S\":\"HH#$WICK_HOUSEHOLD_ID\"},\":prefix\":{\"S\":\"RHYTHM#\"}}" \
  --region us-east-1
```

Each item is one `(dimension, day-of-week, hour)` bucket with a `count` that
increments by one every time you repeat the triggering action — press the
same simulated doorbell event twice and watch the same bucket's `count` go
from 1 to 2. That's the whole baseline mechanism, visible.

To see the full raw timeline (not just Rhythm buckets):

```bash
aws dynamodb query \
  --table-name wick \
  --key-condition-expression "pk = :pk AND begins_with(sk, :prefix)" \
  --expression-attribute-values "{\":pk\":{\"S\":\"HH#$WICK_HOUSEHOLD_ID\"},\":prefix\":{\"S\":\"EVT#\"}}" \
  --region us-east-1
```

---

## 6. Optional — the real Vega Virtual Device

**Check this before running anything else in this section:**

```bash
command -v kepler || echo "kepler CLI not installed — see the note below, skip this section"
```

`kepler` is the Vega OS build/run CLI. It is **not** a public npm package —
unlike `@amazon-devices/react-native-kepler` and the other Vega SDK libraries
`apps/tv-vega` already depends on (those install fine from the public
registry, per `FRICTION.md` FL-007). `kepler` itself ships only through
Amazon's Vega/Fire TV developer program enrollment. There is no
`npm install -g` that produces it, and nothing in this repo's own research
(`docs/WICK-TECHNICAL.md`, `FRICTION.md`) found a public download path either
— if you don't already have it from that program, **skip straight to §7**;
§3's WebSocket-simulated device already proved the real card-delivery
pipeline end to end without it.

If `command -v kepler` found something:

```bash
cd apps/tv-vega
npm run build      # kepler bundle
npm run start      # kepler run — launches the Vega Virtual Device or a real Fire TV
```

This is the closest thing to "real hardware" available without a physical
stick, and per §12.6 of `docs/WICK-TECHNICAL.md` it's still not a substitute
for testing focus order and legibility on a real panel eventually. **It is not
required** to prove the system works — §3 already demonstrates the full
card-delivery pipeline end to end at the transport level, which is what the
backend actually cares about. Treat this section as a bonus polish step, not
a blocker.

---

## 7. Suggested one-session run-through (~20 minutes)

Run these in order, each in its own terminal tab. **Every tab runs its own
`export` block first** — that's not optional boilerplate, it's the thing that
was skipped the one time this went wrong (a fresh tab defaulted silently to
`dev-household` instead of `margaret`).

1. **Tab A** — §0 prerequisites + §1 URL capture, keep it open all session.
2. **Tab A** — §2a link a Playground token.
3. **Tab B** — §3a/§3b (own export block) pair a simulated device and open
   `wscat`. Leave it open.
4. **Tab A** — §2b trigger a Playground event with `demo:capture -- --watch`
   running. **Watch the card print in Tab B.**
5. **Tab C** — §4b: the MCP server is already deployed and running (App
   Runner) — nothing to start. §4c connect MCP Inspector to the deployed URL
   and call `send_note_to_tv`. **Watch the message card print in Tab B.**
6. **Tab D** — §4d: `sim-alexa` is already deployed too (CloudFront) —
   open its URL directly and click through all four tools.
7. **Tab A** — §5, run both DynamoDB queries. Confirm at least one `RHYTHM#`
   item and one `EVT#` item exist under `HH#margaret`.

If all seven steps produce the output described, every pillar of the product
(Door, Family, Rhythm) has been driven end to end through real backend code
with only the physical devices simulated — which is exactly what the
hackathon rules permit you to submit.

---

## 8. Resetting between runs

Pairing codes expire on their own (15 minutes) and are single-use. To pair a
fresh simulated device, just repeat §3a with a new `DEVICE_ID` — no cleanup
needed. There is no destructive reset script for the timeline or Rhythm
buckets; if you want a clean household, use a different `WICK_HOUSEHOLD_ID`
for that experiment rather than deleting real data out of `margaret`'s
partition.
