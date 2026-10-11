# A Ring link for each household — design

**Date:** 2026-10-11 · **Status:** awaiting review
**Item 4 of 4** (add-on package → Fire OS build → MQTT / IoT Core → per-household Ring link).
**Evidence:** "checked today" means read on 2026-10-11 in the repo at `a4ee162`.

## 1. What this changes, in one paragraph

A deployment of Wick holds one Ring credential, in one secret, and an operator hands each
doorbell on that account to a household by script. `AGENTS.md` records it as a known gap:
"A household cannot connect its own Ring account". After this work **each household holds
its own Ring credential**. The home's organiser connects it from the family app; the door,
the chime, live view and the hourly refresh each use the credential of the household
they are acting for, and never another's. No physical doorbell is used: it is shown with
the Ring Developer Playground, and the route through Ring's real sign-in is built and
tested against Ring's documented contract.

## 2. Facts the design rests on

### 2.1 Checked today
- One secret, `wick/ring/tokens`, holds one record. Seven roles read it
  (`infra/edge.tf`, `agent.tf`, `agentcore.tf`, `live.tf`, `status.tf`).
- `secretsManagerTokenProvider()` (`services/connectors/ring/src/secrets.ts`) takes no
  household. The door Lambda, the AgentCore runtime and the live bridge each build one
  `RingClient` for the process.
- `GET /ring/authorize` is unauthenticated and its state row names no household.
  `GET /ring/link` and `POST /ring/token` store whatever they receive in the one secret.
- A doorbell's household comes from `RINGDEV#<deviceId>`, written only by
  `scripts/assign-ring-device.ts`. The write is conditional: a device held by one
  household cannot be taken by another.
- The family app has no Ring route or screen.
- Membership has roles: `organiser` and `family`.
- The record already says where it came from: `source: 'playground'` (pasted, about 30
  minutes, no refresh token) or `source: 'oauth'` (four hours, refreshed hourly).
- "Refresh has exactly one owner" (`AGENTS.md`): the hourly `wick-ring-refresh` Lambda.

### 2.2 What cannot be shown, recorded in FRICTION.md
- FL-004: Ring's partner-initiated sign-in is allow-listed for private apps.
- FL-002, FL-003, FL-010: the console's own link issues no usable token, and the
  completing PATCH is refused.
- The linked developer account lists no devices; the Playground's one camera is reachable
  only with a pasted Playground token (resolved 2026-10-11).
- Staff, 2026-10-06 (forum topic 45462): "you won't be penalized for building only on the
  Playground."

So the Ring sign-in route can be built and contract-tested, and the Playground route can
be shown working end to end.

## 3. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | One secret per household, `wick/ring/tokens/<householdId>`, holding the record as it is today. A row `HH#<householdId>/RING` holds what is safe to read — source, Ring account id, when linked, when it expires — and no token. | INV-1 and the credential rules stand: tokens stay in Secrets Manager. The row lets the app show a status and the refresh job find every link without listing secrets. |
| D2 | **Only the home's organiser** connects or disconnects Ring, from the family app. The household is the one in their access token. | INV-8: never from a request. Connecting a camera to a home is the organiser's act, as inviting and pairing a television are. |
| D3 | Two ways to connect. **Ring sign-in:** the app starts it, the state row is bound to the household and the person, and the callback stores the tokens for that household only. **Playground token:** the organiser pastes one; it is stored as `playground` and the app says, wherever it shows the link, that this is Ring's simulator. | The first is the real product; the second is the only one that can be shown (§2.2), and the rules allow it. |
| D4 | The Playground route exists only where a deployment switches it on (`ring_playground_link`, on for the hackathon). | A pasted token is a developer's tool, not a customer's. |
| D5 | Connecting **claims the devices** that credential can see: each becomes `RINGDEV#<id>` for that household, unless another household already holds it — then it is left alone and the app says so. Disconnecting releases them and deletes the secret. | A household gets its own cameras without an operator. Two homes can never both hold one doorbell. |
| D6 | Everything that calls Ring takes the household first: `ringClientFor(householdId)`. There is no client without one. A process caches a client per household. | The type system, not care, keeps one home's credential away from another's doorbell. |
| D7 | Refresh keeps one owner. The hourly job walks the `RING` rows and refreshes each refreshable link, one at a time per household. | The rule about two writers racing over one rotation holds per household. |
| D8 | The existing single link becomes the link of the household named by `var.household_id`, moved once by a script that the user runs. Ring's own console-driven callbacks, which carry no household, keep landing there. | Nothing that works today stops working. |
| D9 | The resident is told, not asked: the next time the television is idle it shows one card saying the doorbell is connected and by whom. | The resident stays the one who knows what their home is connected to. Asking permission is a larger change to the trust model than this item. **Open to the user's view.** |

## 4. What gets built

### 4.1 Credential custody (`services/connectors/ring`, `services/edge-ring/lambda`)
- `secrets.ts`: `secretsManagerTokenProvider(householdId)`; the constant becomes a
  function of the household. A cache per household.
- `ring-token.mjs`: `readTokens`, `writeTokens`, `getAccessToken`, `finishLink` each take
  the household; the in-flight refresh is per household.
- `link-store.mjs` (new): the `HH#/RING` row, device claims and releases.
- `refresh.mjs`: walks the links (D7).

### 4.2 Linking (`services/edge-ring/lambda`, `services/mcp-server/src/accounts`)
- `POST /api/ring/link` (family app, organiser only) → a one-time start address.
- `GET /ring/authorize?start=…` → binds state to the household, sends the browser to Ring.
- `GET /ring/link` → finds the household from the state, stores, claims devices, returns
  the browser to the family app. A callback with no known state goes to the operator
  household (D8).
- `POST /api/ring/playground` (organiser only, D4) → checks the token against Ring
  (`GET /v1/devices`) before storing it; a token Ring refuses is not stored.
- `GET /api/ring` → the status row and the claimed devices. `DELETE /api/ring` → disconnect.

### 4.3 Callers (D6)
`agents/door/lambda.ts`, `runtime/main.ts` (chimes), `live/bridgeLambda.ts` (the job
carries the household), `status.mjs`, and the laptop scripts (`ring:check` reports per
household).

### 4.4 The family app (`apps/sim-alexa`)
One card under "Connect a television": **Doorbell** — not connected / connected through
Ring, with the cameras found / connected to Ring's simulator, with the minutes left.
Buttons: Connect with Ring, Use a Playground token (where allowed), Disconnect.

### 4.5 Infrastructure
IAM moves from the one secret to `wick/ring/tokens/*`; the linking Lambdas may create and
delete under that prefix; routes for the new endpoints; the `ring_playground_link`
variable. The old secret is left in place until the move in D8 has been run and checked.

### 4.6 Words
`AGENTS.md`: INV-8's known gap is removed and the credential table updated.
`README.md`, `docs/WICK-TECHNICAL.md` §13, and FRICTION.md if Ring's behaviour differs
from its documentation.

## 5. Testing

- Unit tests for every changed module. The ones that matter most:
  a credential read for household A can never be returned to a caller acting for B;
  a callback's household comes only from its state row;
  a device held by one household is not claimed by another;
  a family member who is not the organiser is refused on every Ring route;
  disconnecting removes the secret, the row and the claims.
- `npm run verify` green.
- Against the deployed stack, with two test homes and a fresh Playground token from the
  user: home A connects, the app lists the Playground camera, a door card with a picture
  reaches A's television and Watch live plays; home B, not connected, gets neither, and
  B's organiser cannot see A's link. Disconnect A; its Watch live then says the doorbell
  is not connected.
- The Ring sign-in route: contract tests against Ring's documented requests and
  responses, and one manual start to confirm the browser reaches Ring's sign-in page with
  the right parameters. Its completion cannot be shown (§2.2), and the README says so.

## 6. Deployment and what it needs from the user

- New IAM and routes: the first apply is from the laptop, after the plan is read, on the
  user's go-ahead.
- D8's move of the existing link is a script the user runs once.
- A fresh Playground token for the live test.
- The test homes are made for the run and removed afterwards; `margaret` is not used.

## 7. Out of scope

A physical doorbell; Ring Appstore publication; per-household webhook signing keys (the
key belongs to the app, not the account); letting a family member who is not the
organiser connect Ring; asking the resident's permission on the television (D9).
