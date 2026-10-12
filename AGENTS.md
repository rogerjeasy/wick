# AGENTS.md — the invariants contract

Rules for any coding agent (or human) working in this repository. These are not
style preferences. They are enforced by tests, lint rules and infrastructure
policy. Breaking one is a build break, not a review comment.

Source of truth: `docs/WICK-TECHNICAL.md` §0.3.

---

## The ten invariants

### INV-1 — No long-lived credential ever reaches the television
The device holds exactly one device-bound JWT, scoped to: receive cards for one
household, post playback events. It grants nothing over Ring, AWS or any
family surface. On the MQTT channel that same token is what IoT Core's custom
authorizer checks (`services/edge-device/lambda/iot-authorize.mjs`); the
television holds no certificate and no AWS credential, and the policy it is
given names its own three topics and nothing else (`iot-policy.mjs`). Assume it is extractable (Vega documents no hardware-backed
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

`egress.ts` is also the only module that may reach a family member's own
browser (`nudgeFamily`, Web Push). A nudge carries a kind from a fixed set
(`packages/contracts` `PUSH_KINDS`) and no string at all — nothing about the
house — so there is nothing in it for the Guardian to pass or refuse. The
words a notification shows are the service worker's own
(`apps/sim-alexa/sw.js`). **Never** put a name, a sentence, a picture address
or a household in a push payload: what the family is told still comes only
through the gated tools.

A television is on one of two channels — MQTT over IoT Core, or the API
Gateway WebSocket it falls back to — and `egress.ts` sends down whichever the
television's own row names. Adding a channel means adding it there.

**The one accepted exception** is a reply to the television that just spoke:
when a television asks for the cards it is owed, or turns a page of "What
Sarah sees", the edge answers on the channel the request came in on
(`services/edge-device/lambda/route.mjs` for the WebSocket, `iot-events.mjs`
for MQTT). Those answers are cards already stored for the resident's own
television; nothing bound for the family goes that way.

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

A doorbell's ring takes its household from the doorbell itself: the Door
agent looks up which household holds that Ring device
(`services/agent/src/store/ringDevices.ts`), and a device nobody holds reaches
no television. The weekly Narrator writes for every household with a paired
television (`services/agent/src/agents/narrator/everyHousehold.ts`).

**Each household has its own Ring link.** Its tokens are one secret,
`wick/ring/tokens/<householdId>`, and there is no Ring client without a
household (`ringClientsByHousehold`, `services/connectors/ring/src/secrets.ts`):
the door, the chime, live view and the refresh each read the link of the home
they are acting for. A home's organiser connects it from the family app. The
household is the one in their access token at the start, and again at the
finish — coming back from Ring's sign-in links nothing by itself, because that
address can be sent to anyone (`services/edge-ring/lambda/authorization.mjs`).

**Never** add a way to reach Ring that does not name a household, and never
finish a link for anyone but the organiser who started it.

### INV-9 — Nobody reads a household before the resident allows them
A membership starts `pending`. The only thing that makes it `allowed` is the
resident's press on the Circle card on their own television
(`services/edge-device/lambda/circle.mjs`), and that press can only answer a
question still open. Every MCP tool call asks again (`tools/context.ts`
`gated`), so the answer — and a removal — counts on the very next question.

**Never** write `status: 'allowed'` from the family side, and never answer a
tool call without `gated`. The resident has no account: the paired television
is their identity, and the remote is their consent.

### INV-10 — Nothing different leaves the house before the resident says so
Wick notices when a day is unlike this household's usual
(`services/agent/src/rhythm/different.ts`). It does not tell the family. It
asks the resident, on their own television, "Shall I tell Sarah?", showing
the very sentence that would be told (`agents/tell/ask.ts`), and only the
press on "Tell" makes that one difference readable (`agents/tell/answer.ts`,
`TELL#<differenceId>`).

`get_whats_different` reads the rows answered "tell" and nothing else. A
question still open and one answered "Keep it to myself" must look exactly
like no difference at all, and the summary says only that nothing has been
told — otherwise keeping something would itself tell the family there was
something. Enforced by `get_whats_different.test.ts`.

**Never** compute a difference on the family side, never return, count or
hint at one the resident has not told, and never say "nothing is different"
to the family: Wick cannot know what was kept.

---

## Product rules that constrain code

From `docs/WICK.md` Part 5. The ones that most often get violated by accident:

- **Three items, never four.** DayCard holds at most 3. DoorCard has at most 3 actions.
- **No auto-dismiss, no timers.** Nothing disappears on a countdown.
- **A note never talks over the story.** A deferred card shown in the middle of
  a programme — at one of its calm points, or in a pause — holds the programme
  on the cut, and the programme goes on when the card has gone
  (`NaturalBreakEngine.holdsProgramme`). At the credits nothing is held: the
  story is over. The door never holds anything.
- **Calm points are measured, never guessed.** `apps/tv-vega/src/catalog/
  calmPoints.ts` is generated by `npm run calm:build` from what Rekognition
  and ffmpeg measured on the published encode (`scripts/calm-points`). Do not
  edit it by hand, and do not let a model choose one.
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
| Lambda / container / AgentCore | `ringClientsByHousehold()(householdId)` — reads `wick/ring/tokens/<householdId>` |
| The `wick-ring-*` lambdas | `ring-token.mjs`, which takes the household first (`RING_SECRET_ARN`, `RING_TOKEN_SECRET_PREFIX`) |
| The Wick server (family app) | Never. It invokes `wick-ring-household-link`, which has custody, and is told only what is linked |
| A laptop | `scripts/env.ts`, from `.env` |

- **Refresh has exactly one owner:** the hourly `wick-ring-refresh` lambda, which
  walks every household's link in turn. Do not add a second refresh path — Ring
  may rotate the refresh token, and two writers racing over one rotation is how
  an account silently unlinks.
- **Only a link creates a household's secret.** A refresh writes to one that
  exists and fails if it does not (`writeTokens`' `create`): otherwise a refresh
  in flight during a disconnect would bring the removed link back.
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
- **One exception, and it is marked: the demo home.** A guest's demo home
  (`services/mcp-server/src/accounts/demo.ts`) starts with a simulated history,
  written by `accounts/demoHome.ts` — six weeks of the Door agent's own event
  rows, and each week counted from them by the Narrator's own code. A product
  about the shape of a week cannot be tried on a home with no weeks. Every such
  row, week and household carries `simulated`, and the family app says so
  wherever it names the home. **Never** write simulated rows to a household a
  person set up, and never show a simulated week without saying it is one.
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
