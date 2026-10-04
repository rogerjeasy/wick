# AGENTS.md — the invariants contract

Rules for any coding agent (or human) working in this repository. These are not
style preferences. They are enforced by tests, lint rules and infrastructure
policy. Breaking one is a build break, not a review comment.

Source of truth: `docs/WICK-TECHNICAL.md` §0.3.

---

## The nine invariants

### INV-1 — No long-lived credential ever reaches the television
The device holds exactly one device-bound JWT, scoped to: receive cards for one
household, post playback events. It grants nothing over Ring, AWS or any
family surface. Assume it is extractable (Vega documents no hardware-backed
keystore) and scope accordingly.

**Never** put a Ring token, AWS key or Bedrock credential in
`apps/tv-vega` or `apps/tv-fireos`.

**Known accepted exception:** `POST /pair/refresh` (`services/edge-device/
lambda/pair-refresh.mjs`) mints a device-bound JWT from `{deviceId}` alone —
no proof of possession. (The household is looked up from the device id; it is
no longer taken from the request — INV-8.) It exists because the Vega
Virtual Device's `/data` never actually persists a write (FRICTION.md
FL-013/FL-014), so `CardService.ts`'s separate process has no other way to
learn it's already paired. Real proof-of-possession would need the client to
hold a secret, which this device can't reliably store *and* this repo can't
keep confidential (open source). Mitigated, not eliminated: a 1-hour TTL
(`REFRESH_TOKEN_TTL_SEC`, versus `DEVICE_TOKEN_TTL_SEC`'s 30 days) and a
per-device cooldown (`REFRESH_MIN_INTERVAL_MS`) bound exposure and throttle
abuse; they do not stop a single unauthenticated mint. Revisit if SP-8 (real
Fire TV hardware) shows on-device storage actually works there.

### INV-2 — Every family-bound string passes through the Guardian
`services/agent/src/egress.ts` is the *only* module permitted to import a
transport client. Everything else calls `sendToFamily()` / `sendToDevice()`.
Enforced by an ESLint `no-restricted-imports` rule. There is no second path.

### INV-3 — No Ring media is persisted beyond 24 hours
Enforced by S3 bucket lifecycle policy in `infra/`, not by application code.
Do not add an application-level copy, cache or backup of a snapshot or clip.

### INV-4 — Nothing protected, and nothing verbatim, reaches the family
Health, money, relationships, location and verbatim speech are refused for a
family audience under every policy (`NEVER_TO_FAMILY`, `packages/contracts`).
Enforced by the Guardian's property tests in `services/policy`, after
generation — not by the good intentions of a model.

### INV-5 — Deferred cards never render during IN_SCENE
The only immediate urgency class is `DOOR`. Enforced by property tests in
`apps/tv-vega/src/break/__tests__`.

### INV-6 — Every agent tool call is idempotent and correlated
Carry `correlationId` from ingress (Ring webhook / MCP request)
through EventBridge, the agent, persistence, the card payload, and back from the
device on `card_shown` / `card_action`.

### INV-7 — The resident sees their week before the family can read it
`NARR#<isoWeek>.residentSeenAt` gates family readability. Ordering is enforced on
the write path, not by convention.

### INV-8 — The household comes from a verified token, never from a request
A family request's household is the one its access token was approved for
(`services/mcp-server/src/accounts/oauthProvider.ts`); a television's is the
one in its device-bound JWT. No tool, route or Lambda takes a household id
from a request body, a URL or an environment variable, so there is no request
a person can write to reach a household that is not theirs.

**Never** add a `householdId` parameter to an MCP tool, an `/api` route or a
pairing endpoint. Enforced by `server.test.ts`, `api.test.ts`,
`pair-claim.test.ts` and `pair-refresh.test.ts`.

**Known gap:** the Door agent and the weekly Narrator still read one household
from `WICK_HOUSEHOLD_ID` (`infra/variables.tf` `household_id`), because there
is one Ring link per deployment and no Ring-device → household registry yet.

### INV-9 — Nobody reads a household before the resident allows them
A membership starts `pending`. The only thing that makes it `allowed` is the
resident's press on the Circle card on their own television
(`services/edge-device/lambda/circle.mjs`), and that press can only answer a
question still open. Every MCP tool call asks again (`tools/context.ts`
`gated`), so the answer — and a removal — counts on the very next question.

**Never** write `status: 'allowed'` from the family side, and never answer a
tool call without `gated`. The resident has no account: the paired television
is their identity, and the remote is their consent.

---

## Product rules that constrain code

From `docs/WICK.md` Part 5. The ones that most often get violated by accident:

- **Three items, never four.** DayCard holds at most 3. DoorCard has at most 3 actions.
- **No auto-dismiss, no timers.** Nothing disappears on a countdown.
- **No red, no badges, no beeps.** Not in any component, not ever.
- **Minimum 32pt type, ≥7:1 contrast.** `packages/vega-calm-ui` enforces this; use it.
- **One button.** Every resident action is reachable with D-pad + OK. No text entry anywhere.
- **When unsure, say so.** Never emit a confident guess. Silence beats a wrong description.
- **No mood or sentiment inference is ever reported to anyone.**

---

## Credential rules

**`.env` is a local-development file and nothing else.** It is gitignored, so it
cannot reach a deployed runtime except by being baked into an image — which is
the thing to never do. Exactly one module reads it: `scripts/env.ts`.

| Where | How a Ring token is obtained |
|---|---|
| Lambda / container / AgentCore | `secretsManagerTokenProvider()` — reads `wick/ring/tokens` |
| The `wick-ring-*` lambdas | Secrets Manager directly (`RING_SECRET_ARN`, `RING_TOKEN_SECRET_ARN`) |
| A laptop | `scripts/env.ts`, from `.env` |

- **Refresh has exactly one owner:** the hourly `wick-ring-refresh` lambda. Do not
  add a second refresh path — Ring may rotate the refresh token, and two writers
  racing over one rotation is how an account silently unlinks.
- **CI holds no AWS keys.** Deploy workflows authenticate by OIDC
  (`aws-actions/configure-aws-credentials` with `vars.AWS_DEPLOY_ROLE_ARN`). A
  role ARN is not a credential; it names a role that will only mint one for a
  token GitHub signed for this repository.
- **A deploy never carries Ring credentials.** They are seeded once by
  `infra/bootstrap/put-ring-secret.sh` and read at runtime.

---

## Data rules

- **Runtime code uses real data.** Fixtures live under `__tests__` and never ship.
  `npm run check:no-mocks` fails the build if Vega runtime code imports anything
  matching `/mock/i`. Do not weaken this check.
- **Never commit real household data.** No captures, no HAR files, no Ring
  snapshots. `.gitignore` covers the common cases; you are still
  responsible.
- **Redact before using a real payload as a fixture.**

---

## Before you open a PR

```
npm run verify     # typecheck + lint + check:no-mocks + tests
```

If you hit a platform limitation, **write it into `FRICTION.md` immediately**,
with all six fields. It is worth up to 10% of the hackathon score and it is
worthless if written retrospectively.
