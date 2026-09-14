# AGENTS.md — the invariants contract

Rules for any coding agent (or human) working in this repository. These are not
style preferences. They are enforced by tests, lint rules and infrastructure
policy. Breaking one is a build break, not a review comment.

Source of truth: `docs/WICK-TECHNICAL.md` §0.3.

---

## The seven invariants

### INV-1 — No long-lived credential ever reaches the television
The device holds exactly one device-bound JWT, scoped to: receive cards for one
household, post playback events. It grants nothing over Ring, Bee, AWS or any
family surface. Assume it is extractable (Vega documents no hardware-backed
keystore) and scope accordingly.

**Never** put a Ring token, Bee session, AWS key or Bedrock credential in
`apps/tv-vega` or `apps/tv-fireos`.

### INV-2 — Every family-bound string passes through the Guardian
`services/agent/src/egress.ts` is the *only* module permitted to import a
transport client. Everything else calls `sendToFamily()` / `sendToDevice()`.
Enforced by an ESLint `no-restricted-imports` rule. There is no second path.

### INV-3 — No Ring media is persisted beyond 24 hours
Enforced by S3 bucket lifecycle policy in `infra/`, not by application code.
Do not add an application-level copy, cache or backup of a snapshot or clip.

### INV-4 — No verbatim Bee utterance ever leaves the house
The Bee bridge (`services/connectors/bee`) drops raw utterance content at the
household boundary and emits only typed, derived `Fact` objects. Cloud code must
never be in a position to leak what it never received.

### INV-5 — Deferred cards never render during IN_SCENE
The only immediate urgency class is `DOOR`. Enforced by property tests in
`apps/tv-vega/src/break/__tests__`.

### INV-6 — Every agent tool call is idempotent and correlated
Carry `correlationId` from ingress (Ring webhook / Bee delta / MCP request)
through EventBridge, the agent, persistence, the card payload, and back from the
device on `card_shown` / `card_action`.

### INV-7 — The resident sees their week before the family can read it
`NARR#<isoWeek>.residentSeenAt` gates family readability. Ordering is enforced on
the write path, not by convention.

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

## Data rules

- **Runtime code uses real data.** Fixtures live under `__tests__` and never ship.
  `npm run check:no-mocks` fails the build if Vega runtime code imports anything
  matching `/mock/i`. Do not weaken this check.
- **Never commit real household data.** No captures, no HAR files, no raw Bee
  exports, no Ring snapshots. `.gitignore` covers the common cases; you are still
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
