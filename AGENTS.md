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

**A family member's own television holds one token too, of another kind.**
"Sarah's television" (`packages/contracts/src/familyTelevision.ts`) is the
same app, connected by a member as theirs. Its token carries
`kind: 'family'` and that member's `userId`, and it is good for exactly one
thing: asking the Wick server what that one member's television should show
— its home screen, the seat beside a film that member arranged with the
resident, what is waiting for them — and telling it of a press
(`services/mcp-server/src/accounts/familyTelevision.ts`). The
server answers with what that one member may already read through the
family's tools, and takes only the answers they may already give — a fixed
list, never a tool name from the request — checking the circle again on
every call (INV-9) and that the television is still connected. It is never
used on the resident's card channel: a family television has no `DEV#` row,
which is what every card for the resident and every press that counts as
hers is keyed on, so those paths refuse it without having to know it
exists. Assume this token is extractable as well: what it can reach is one
member's view of one home, and it ends when the television is disconnected,
the member is removed, or the resident stops allowing them.

**Never** key anything of the resident's on a family television's row
(`FTV#`), never send a family television a card meant for the resident, and
never let a family television's token call a tool by name.

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

**A second known accepted exception, smaller than the first:** a family
television's background service is handed a token without proof, once, by
`POST /pair/refresh`. The app and its service are two processes that can
share nothing on the device — no launch data, no storage, no message
(FRICTION.md FL-013, FL-029) — so the app, proving itself with the token it
holds, opens a window on its own `FTV#` row, and inside that window one
unproven request for that television is answered. What bounds it: only the
app's own proof opens it; it lasts 90 seconds and is used once; the request
must come from the address that opened it (kept on the row as a keyed
fingerprint, never the address); and the token it yields carries
`scope: 'waiting'`, which the Wick server accepts on `GET /tv/waiting` and
refuses everywhere else. That one route says, in one sentence each, what
is waiting for that member's answer — never the picture from the door, the
light, the week or where a film is. A scoped token is only ever exchanged
for another scoped token, and never once it has expired. It belongs to one
session, named on the television's row: there is one at a time, each time
the app comes on screen the session before it is over — at the pairing
service and at the Wick server, which checks it on every call — and none
lasts past seven days. And its refreshes are counted apart from the app's,
so the least trusted token on a television cannot lock its app out.

**Never** widen that scope, never let a scoped token reach `/tv/home`,
`/tv/press` or `/tv/seat`, and never answer `/tv/waiting` with anything a
person would have to be looking to be told.

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
television, and the taking back of ones it still holds that were answered on
another television in the home; nothing bound for the family goes that way.
Taking a card off the *other* televisions the moment it is answered is not
the edge's to do: it says so on the bus (`card.retired`), and `egress.ts`
sends the `revoke`. The same goes for a home screen changed by a press on
one television — the light put out or lit again, or what is shared changed:
the edge tells the television that was pressed, says so on the bus
(`home.changed`), and `egress.ts` tells the others. And a card its sender
takes back before it is answered (an invitation to watch a film) leaves the
televisions through `egress.ts` too (`takeBackFromDevices`).

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
- **A press answers only what she has had time to see.** A card's buttons
  take no press for one second after that card comes on screen
  (`apps/tv-vega/src/press/settle.ts`), on her television and on a family
  member's: a double press, a bouncing key or a thumb already on its way
  down must never answer the next question — some of those questions are
  her consent. And nothing acts by being handed the focus: on a family
  television the wave is sent only after a D-pad move to it
  (`family/presses.ts`). A swallowed press does nothing at all.
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
- **The light says one thing.** The light in the window
  (`packages/contracts/src/light.ts`) tells the family whether the
  resident's day has begun, and nothing else: `get_light` returns lit or not
  lit — no time, no count, no television, no programme. The resident can put
  it out for the day (`services/edge-device/lambda/light.mjs`), and a light
  that is out must look exactly like one not yet lit, in the same words:
  otherwise putting it out would itself tell the family something (the same
  reasoning as INV-10). It is not answered at all when the resident keeps
  the shape of their week private. And it goes both ways: a question that
  asks after the resident is noted (`gated`'s `looksIn`,
  `services/mcp-server/src/tools/lookIn.ts`) and the resident's home screen
  says who looked in. **Never** add a time, a reason or a second fact to the
  light, never tell "out" from "not lit", and never hide a look from the
  resident.
- **Where a film has got to is the resident's.** Watching together
  (`packages/contracts/src/watch.ts`) lets one family member's player follow
  the resident's. The position of a film leaves the television only after the
  resident's own press on "Start the film" — on a card that says who will see
  it — only for the one film named in the invitation they accepted, only
  until they leave that film and never past the invitation's window, and it
  is read back only to the person who sent the invitation. Three places keep it, and none trusts another: the
  television says nothing without the press
  (`apps/tv-vega/src/watch/togetherReporter.ts`), the edge keeps nothing that
  does not match the session's row — and nothing at all once her player has
  stopped: that position stamps `leftAt`, and no later one is kept
  (`services/edge-device/lambda/watch-together.mjs`), and the tools answer
  nobody else (`services/mcp-server/src/tools/watchSession.ts` `mySession`).
  The ordinary `playback` event carries a programme's id for the week's
  rhythm and is never read by a family tool. **Never** add a tool, a route or
  a field that tells the family what is playing, or where it has got to,
  outside a session the resident started. And the family member's player has
  no pause and no skip: nobody reaches the resident's remote. The seat can
  be taken on that member's own television too (`GET /tv/seat`,
  `services/mcp-server/src/accounts/familyTvWatch.ts`): the same one person,
  by the same rule — anybody else's television is answered exactly as if
  there were no film — and that television's player follows, has no pause
  and no skip, and reports its own playback to nobody.
- **A request to be rung reaches one person at a time, and calls nobody.**
  Hold for Sarah (`packages/contracts/src/reach.ts`): OK held for two seconds
  brings a card that offers to ask someone to ring the resident. Holding the
  button files nothing and tells nobody — it only brings the offer
  (`services/edge-device/lambda/reach.mjs`). Her press on the card is the
  consent, and what it sets going is deterministic
  (`services/agent/src/agents/reach`): the first person in her circle as it
  stands at the press is told, by a nudge that carries a kind and nothing
  else (INV-2); three minutes on, if nobody has answered, the next person is
  — the family first, a neighbour last — and the circle is read again each
  time, so somebody she has removed is passed over and never named as asked
  (INV-9). The timer in between carries which request and which step, never
  who. Somebody not yet asked is told nothing: `get_reach_request` gives
  them the very words it gives when there is no request, and never says who
  else was asked, how many, or who is next. An answer is a key from
  `REACH_ANSWERS`, shown under the name of the person the resident allowed;
  the first answer is the answer. **Never** have Wick place a call, name an
  emergency service, sound anything, or word this as an alarm; never tell
  anyone a request exists before their turn; never carry a reason with it —
  she is not asked for one, and none may be guessed.
- **A wave carries no words, and its fate is hers.** A family member's
  television has one button that sends a wave
  (`services/mcp-server/src/accounts/familyTvWave.ts`). What the resident's
  television then says is Wick's own sentence, naming the television it
  came from — whoever is in that room may have pressed it, a grandchild
  included — and it waits for a quiet moment like any note (INV-5). She can
  wave back or put it away. Only a wave back is told. A wave she put away
  must look, on the family's television, exactly like a wave she has not
  seen yet — the same sentence, the same button returning at the same ten
  minutes — or putting it away would itself say something (the reasoning of
  INV-10). One wave of a member's is on her television at a time, and a
  wave never appears among the notes and replies. **Never** let a wave
  carry text from the family, never tell "put away" from "not yet seen",
  and never send one for anybody: it is a press on a remote.
- **Her language changes what she is shown, and nothing else.** The
  television speaks her language (`packages/contracts/src/language.ts`). The
  organiser can ask for another from the family app; the only thing that
  sets a household's `language` is the resident's own press on the question
  on her television (`services/edge-device/lambda/language.mjs`), which is
  put to her in both languages at once. Her no is an answer: the same
  language is not asked for again within a week. Everything Wick itself
  writes reaches her through a hand-written phrasebook of whole sentences
  (`packages/contracts/src/phrasebook`), held to the builders' real output
  by tests; a sentence the phrasebook does not hold stays in English, whole.
  Only free text — a note the family wrote, the door's description, the
  week's paragraph — is machine-translated, after the English checks have
  passed, on its way to her television (`services/agent/src/egress.ts`),
  and kept beside the stored card, never in it. Stored rows stay in the
  English they were written in, her answers are keys, and a note's reply is
  the stored English words: nothing translated ever reaches the family.
  The edge Lambdas' copy of the phrasebook,
  `services/edge-device/lambda/phrasebook.generated.mjs`, is generated by
  `npm run phrasebook:build` and held to the source by a test: never edit
  it by hand. And `egress.ts` is the only module that may import the
  translation client, by the same lint rule that keeps the transports there.
  **Never** write `language` from the family side, never machine-translate
  a sentence she consents by (the Circle card, "Shall I tell Sarah?" and
  its sentence, "Start the film", "What Sarah sees", the request to be
  rung, the visit question), never translate into a stored card, and never
  show her half a sentence in each language.
- **A neighbour is asked two things, and shown nothing.** A member whose
  role is `neighbour` (`packages/contracts/src/circle.ts`) joins by an
  invitation that says so and is allowed by the resident's own press like
  anyone else (INV-9). A neighbour can be asked to look at who is at the
  door and to ring when asked, and that is all: `gated`
  (`services/mcp-server/src/tools/context.ts`) refuses a neighbour every
  tool that does not declare `neighbour: true`, so a tool written later
  refuses them without having to remember to. Wherever Wick says or decides
  who can *see* something — the light, "What Sarah sees", "Shall I tell
  Sarah?", the name on the week card — a neighbour is left out
  (`familyOnly`, and the edge's `light.mjs` / `sharing.mjs`). **Never** mark
  a tool `neighbour: true` unless it is the door or being asked to ring,
  and never count a neighbour among those who can see.
- **A visit is confirmed by the resident, or it is not confirmed.** The
  visit, witnessed (`packages/contracts/src/visit.ts`): the door's first
  sighting of a regular visitor opens a visit, the last sighting before she
  is asked is taken as the leaving, and the resident is asked, at a natural
  break, "Is this right?" (`services/agent/src/agents/visit`). The times are
  the door's reading and are never called a fact; her "Yes" is what makes a
  visit confirmed, and nothing else can — no model, no timer, no family
  member, no default. Her "No" confirms nothing, and whether the family
  hears that she disputed it is hers to decide through "Shall I tell
  Sarah?" (INV-10). So to the family a visit has one of two states:
  `get_visits` gives a visit she has not been asked about, one still
  waiting for her answer and one she said was not right the same word and
  the same fields, or disputing a visit would itself tell them. Only a
  regular visitor has a record — not a stranger, and not one of the family.
  **Never** write `answer: 'confirmed'` anywhere but from her press (the
  demo home's simulated rows aside, which are marked), never tell the three
  unconfirmed states apart on the family side, and never present the record
  as a clinical or billing document: it says who the door saw, when, and
  that she agreed.
- **Which kind of television it is comes from its row, never from a request.**
  The resident's television is `HH#<household>`/`DEV#<deviceId>`; a family
  member's own is `HH#<household>`/`FTV#<deviceId>` with the `userId` of the
  member who connected it (`services/edge-device/lambda/family-television.mjs`).
  Connecting one as a family television is for a member the resident has
  already allowed, and not for a neighbour. A refreshed token keeps the kind
  its row gives it, so no request can turn a family television into the
  resident's or the other way round. The resident's televisions and the
  family's are never counted or listed together.
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
