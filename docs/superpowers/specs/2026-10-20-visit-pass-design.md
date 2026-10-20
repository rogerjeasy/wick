# The visit pass — design

2026-10-20. From a real conversation (README, "A real door"): a 79-year-old
with memory loss; a different doctor each time she is ill; she does not
recognise them, sometimes keeps the door shut, and the doctor phones her
daughter in Italy. The user approved the feature as written in chat and asked
Claude to make every other call. Calls Claude made are marked **(call)**.

## Intent

An expected stranger and an unknown stranger look the same at her door. The
visit pass lets the visitor a family member arranged prove they are that
visitor, from their own phone, around the ring. Her television can then say
who is at the door — the first thing in Wick that can (PR #159 made the door
say only who is due, because a ring near the time proves nothing).

## The flow

1. The member arranges the visit as today (`arrange_visit`): "Doctor Rossi,
   Thursday at 10".
2. The member asks for a link (`make_visit_pass`, family app button "Send a
   link to Doctor Rossi"). They forward it by WhatsApp, SMS or email.
3. The visitor opens `https://<family app>/visit.html#<token>`: three big
   buttons — **On my way · Running late · I'm at the door** — and nothing
   about the house.
4. Her television:
   - on my way — her day: "Doctor Rossi is on the way. Sarah arranged it."
   - running late — her day: "Doctor Rossi will be about 15 minutes late."
   - I'm at the door, within 10 minutes either side of a ring — the door card:
     headline "Doctor Rossi is at your door.", notice "They confirmed it on
     their phone just now. Sarah arranged this visit."
   - a ring when nobody is expected — the door card's notice: "Nobody is
     expected at the door now. You don't have to open." (headline unchanged,
     "Ask Sarah to look" offered as today).
   - a ring inside an arranged visit's window with no confirmation — exactly
     today's card ("… is expected around now", "Sarah arranged a visit for
     about now.").
5. The member who arranged it gets a nudge for each press (push kinds
   `visitor_on_way`, `visitor_late`, `visitor_at_door`) and sees it on the
   visit's card in the family app.

## Goals, non-goals, anti-goals

- Goal: her exact story, end to end, live on the deployed stack and in the
  demo home with the stand-in doorbell, before the 2026-10-23 deadline.
- Non-goal: identity proof stronger than "holds the link". Whoever the member
  forwarded it to can press it; a forwarded link is the member's choice.
- Non-goal: telling anyone but the arranger (and her television).
- Anti-goal: Wick ever saying "you can open", "it is safe", or letting a model
  decide anything here. Anti-goal: the page naming the resident, the address,
  the member or the household. Anti-goal: the token in any server log.

## Shared contract (done, `packages/contracts/src/visitPass.ts`)

`VISITOR_SAYS`, `VISIT_PASS_LIMITS` (opens 3 h before, late step 15 min,
at-door fresh ±10 min, 30 presses per pass), `VISIT_PASS_PK_PREFIX`/`SK`,
`isVisitPassToken` (32 lower-case hex), `VISIT_PAGE_PATH`, `passStateAt`,
`nextLateMinutes`, `VisitorWord` + `readVisitorWord`, `visitorSaidFresh`,
`pushKindForVisitor`, `VISIT_EVENTS` (`wick.visit` / `visit.said`),
`VisitSaidDetail` + `readVisitSaidDetail`, and Wick's sentences:
`visitorArrivedLine`, `visitorConfirmedNotice`, `NOBODY_EXPECTED_NOTICE`,
`visitorDayLine`. Push kinds added to `PUSH_KINDS`.

## Storage **(call)**

- Pass row: `pk = VPASS#<sha256(token) hex>`, `sk = VPASS`; attributes
  `householdId`, `errandId`, `presses` (N), `ttl` = window end + 1 day.
  Found by hash only. The token itself is never stored.
- The errand row (`ERRAND#<id>`) gains `passHash` (to replace/revoke: making
  a new pass deletes the old row) and `visitorWord` (S, JSON `VisitorWord`).
- The roster row (`PER#errand:<id>`) gains `visitorWord` (S, JSON) as a
  separate attribute, not inside `data`, so a write never rewrites the entry.

## Pieces

### A. Policy and the Wick server (`packages/policy`, `services/mcp-server`)

- **The doctor word (narrow).** `clearVisitorForFamily(who)` in policy: a
  visitor's description clears if it clears as text or as a name today, or if,
  with general clinician titles set aside, the rest clears as text. Set aside
  only: doctor(s), dr(s), gp, g.p, nurse(s), district nurse, physio(therapist),
  podiatrist, chiropodist, optician **(call)**. Titles that say what for —
  psychiatrist, psychologist, therapist, counsellor, midwife, paramedic,
  dentist? (kept refused **(call)**) — and any other protected word
  ("Dr Patel about her dialysis") stay refused. The lexicon is unchanged:
  the door's vision sentences are still refused for "a nurse".
- `arrange_visit` uses it for `who`. Its error text stays for what is still
  refused.
- What the arranger is shown back (`arrange_visit`, `get_errands`,
  `cancel_errand`, `make_visit_pass`): the errand's `who` and the sentences
  built around it are marked as the reader's own words (`theirOwnWords`) only
  when the reader is the errand's author. Errands are already shown only to
  their author.
- Fail-soft where others read it: `get_door_request` passes the card's `line`
  through `familyText` and falls back to "Someone's at the front door."
  (`DOOR_LINE`); `get_today` drops a presence row's name the gate cannot clear
  ("Someone came to the door when a visitor was expected"). Week narratives
  already fall back to counts when the gate refuses.
- **`make_visit_pass`** (tool 26, a WRITE): input `errandId`; only the
  errand's author, only while it is open (planned/reminded/waiting) and the
  pass not `over`. Makes a token (`randomBytes(16).toString('hex')`), writes
  the pass row, sets `passHash` on the errand and deletes the previous pass
  row. Answers `{ link, who, opensAt, closesAt }` — `link` is
  `${FAMILY_APP_URL}${VISIT_PAGE_PATH}#${token}`. `FAMILY_APP_URL` from the
  server's environment (the family app's origin, already known for CORS)
  **(call)**.
- `errandView` gains `visitor?: { says, at, lateMinutes? }` and
  `visitorSaid?: string` — "Doctor Rossi said at 9:41 am that they were on the
  way." / "… would be about 15 minutes late." / "… were at the door." — and
  `hasPass: boolean`.

### B. The agent plane, the edge and infra (`services/agent`, `services/edge-device`, `infra`)

- **Door (Phase 1, `door/route.ts`, `door/index.ts`).** For a `button_press`
  whose roster match is an errand (`errandIdOf`), read that roster row's
  `visitorWord` fresh (one consistent GetItem; the roster cache is 60 s). If
  `visitorSaidFresh(word, ring)`: headline `visitorArrivedLine(match.name)`,
  notice `visitorConfirmedNotice(arrangedByName)`. If there is no match at all
  on a `button_press`: notice `NOBODY_EXPECTED_NOTICE`. Otherwise unchanged.
  A failed read costs the confirmation, never the card. Phase 2 does not
  replace a confirmed card's headline with "The doorbell rang." **(call)**.
- **`visit.said` (`door/actionLambda.ts` + `agents/visit/said.ts`).** Nudge
  the errand's author with `pushKindForVisitor` when `tellMe`; for `at_door`,
  if the errand's `rangAt`/`cardId` is within ±10 min, patch that door card
  (`line`, `notice`) on every television. Ignore anything else.
- **Edge `visit-pass.mjs`** (new Lambda, plain .mjs like pairing):
  `POST /visit/status {token}` → `{ state, says?, at?, lateMinutes? }`;
  `POST /visit/say {token, says}` → the same after recording. Unknown token,
  bad token, cancelled/failed/no_show errand, author no longer allowed, past
  window — all answer `{ state: 'over' }` (no oracle). Before the pass opens:
  `not_yet`. On a press: conditional `ADD presses :one` under `maxPresses`
  (over → 429 `{ state: 'open', busy: true }`), write `visitorWord` to the
  errand row and the roster row (only if it still exists), then one
  PutEvents with two entries: `home.changed` (the full home, computed as
  device-event.mjs `tellHome` does, with `today` from `herDay`) and
  `visit.said`. Never logs the token or its hash; logs `errandId` + `says`.
- **Her day (`today.mjs`).** An errand line with a kept `visitorWord` uses
  `visitorDayLine` (inlined; `today.test.ts` holds it to the contract).
- **Phrasebook (es).** `NOBODY_EXPECTED_NOTICE` and
  `They confirmed it on their phone just now. {first} arranged this visit.`;
  the member's own words stay English, whole, as today. Regenerate
  `phrasebook.generated.mjs`.
- **Infra.** Lambda `wick-visit-pass` + role (`wick-*`; Get/Update on the
  table, Query the home's rows, PutEvents on the bus), log group, routes
  `POST /visit/status` and `POST /visit/say` with their own limits (rate 5,
  burst 10) **(call)**, rule `visit.said` → agent card-action. Family-app CSP
  `connect-src` gains the edge API. No new AWS service.

### C. The family app (`apps/sim-alexa`)

- `visit.html` + `visit.js`: reads the token from `location.hash`, never sends
  it anywhere but the edge API body; `POST /visit/status` on load; three large
  buttons; after a press, "Thank you. The house has been told." and what was
  said last; `not_yet` and `over` states; works on a phone, 48 px targets,
  light and dark, no external requests. Title "Your visit · Wick". No name,
  address, household or member anywhere.
- The visit's card: "Send a link to {who}" (open visits) → `make_visit_pass`
  → Web Share sheet (`navigator.share({ title, text, url })`), else copy to
  clipboard and show the link; the visitor's latest word under the steps.
- `sw.js`: words for the three kinds ("Your visitor is on the way.", "Your
  visitor is running late.", "Your visitor is at the door."); a nudge of those
  kinds refreshes the visits, as `errand_rang` does.
- The edge API's URL reaches `visit.js` the way the family app's other
  deployment values do.

### D. Docs (last)

README feature row, project page feature, 26 tools everywhere the count is
said, AGENTS.md data rule (what a pass can and cannot do), WICK-TECHNICAL
section, CHANGELOG, FRICTION if anything bites, SUBMISSION's judge path step.

## Testing

TDD in every piece. Server: the tool through the real gate; the carve-out's
yes/no table; the reader's-own-words marking only for the author. Agent:
Phase 1 for each of the four cases; `visit.said` handler. Edge: the handler
with an in-memory table (every refusal answers `over`), today lines. Family
app: errands.js view + share fallback; visit.js state machine. Live: demo
home, arrange "the doctor in five minutes", open the link in a second tab,
press "I'm at the door", ring the stand-in doorbell → confirmed card on the
browser TV and the Vega simulator; a ring with no visit → "Nobody is expected".

## Left to the builder

Exact copy on the visitor page beyond the three buttons and the thank-you;
layout; file names inside each package; how the edge API URL reaches the page.
