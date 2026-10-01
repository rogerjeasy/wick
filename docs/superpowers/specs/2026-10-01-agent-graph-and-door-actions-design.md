# Agent graph on Strands + AgentCore, and the Door Card's buttons — design

**Date:** 2026-10-01 · **Status:** approved decisions, awaiting plan review
**Evidence:** every "measured" figure below was taken this session against the live Ring
Partner API and the Vega Virtual Device (SDK 0.24.12044). FRICTION.md FL-015, FL-016,
SP-1, SP-3.

## 1. What this changes, in one paragraph

Today the Door Card's three buttons only write a timeline row, and the agent plane that the
README describes as "Strands Agents + Bedrock AgentCore" is two empty files. After this work:
**Door, Day and Narrator are real Strands agents in real Strands graphs, running in one
AgentCore Runtime, remembering visits and weeks in AgentCore Memory, with the Guardian as a
deterministic graph node on every path out.** Pressing **"Ring the hallway chime"** sounds a
real Ring Chime and tells the resident whether it rang. Pressing **"Watch live"** shows the
doorbell's live picture full-screen on the television for as long as Ring allows, and Back
returns to what was on screen.

## 2. Decisions (made with the user, 2026-10-01)

| # | Decision | Why |
|---|---|---|
| D1 | The chime button is a **hallway signal**, labelled **"Ring the hallway chime"** (id `hallway_chime`), not "Just a moment". | Ring's only audio command is `POST /media/audio/playback` on a **Chime** — an indoor plug-in speaker — playing the audio in the app's slot. There is no doorbell speaker or two-way audio endpoint. An indoor chime cannot tell a visitor anything; it can tell the rest of the house. Claiming otherwise would be caught. |
| D2 | The user will provide a physical Ring Chime / Chime Pro with the Chimes **Audio controls** scope. | Playground has no chime. Code is contract-tested against Ring's documented shapes regardless. |
| D3 | **Full graph**: Door, Day and Narrator all move onto Strands + AgentCore. | User's choice. |
| D4 | **No model ever decides to make a sound in a house.** The chime is a deterministic action handler, not a Strands tool an agent can call. | Ring's own best practice #6: "Gate [playback] behind an explicit user action … never behind a retry loop or a polling side effect." |
| D5 | Watch Live = **Ring WHEP → cloud bridge (werift + ffmpeg) → HLS over HTTPS → the app's own `w3cmedia` player.** | Vega has no WebRTC module; its WebView segfaults on the VVD even in Amazon's own template (FL-015). `w3cmedia` plays HLS on the VVD (SP-1). Cleartext is refused silently (FL-016), so HTTPS only. |

## 3. Measured facts the design rests on

- Ring WHEP: `201` in **~1.5s**; first RTP **~3.2s** after the request; H.264 1280x720 from the
  Playground camera; Ring's GOP ≈ **1.67s** (PLI does not shorten it).
- Bridge (werift → UDP → ffmpeg `-c:v copy` → HLS, MPEG-TS, `hls_time 1`): first playlist
  **6.0–6.8s** after the start request.
- Session ceiling (Ring docs): **30s** battery, **60s** line-powered; server-terminated.
- `w3cmedia` on the VVD: HLS (H.264 + AAC, MPEG-TS) over HTTPS plays; a DOOR card overlays it
  cleanly (SP-1 closed).
- Chime (Ring docs, Early Access): discover by `capabilities.audio.supported_actions` ∋
  `chime.play`; check `status.online` and `status.audio.snooze.active`; take `audio_ref` from
  `configurations.audio.customizable_slots[event=…]`; `POST` JSON:API `{data:{type:'audio',
  attributes:{audio_ref}}}`; synchronous `200` with `attributes.status: 'completed'`.
- The real linked Ring account currently lists **zero devices** (FL-010); the Playground
  identity has one camera and no chime. The chime path cannot be demonstrated until D2's
  hardware is on an account the app can see.

## 4. Architecture

```
                        ┌──────────────── AgentCore Runtime "wick_agents" (arm64 container) ───────────────┐
EventBridge ─ door ─▶ λ door (Phase 1, local) ──invoke──▶ door graph:  describe(Nova Lite, vision) ─▶ guardian ─▶ egress ─▶ TV
Scheduler  ─ 30m ──▶ λ day  (shim) ─────────────invoke──▶ day graph:   select(rubric) ─▶ phrase(Nova Lite) ─▶ guardian ─▶ egress
Scheduler  ─ week ─▶ λ narrator (shim) ─────────invoke──▶ week graph:  narrator(Claude, TOOLS) ─▶ guardian ─▶ NARR# + WeekCard
                        │  AgentCore Memory "wick_household": door visits, week narratives → semantic recall  │
                        └──────────────────────────────────────────────────────────────────────────────────┘
TV ─ card_action ─▶ ws route ─▶ EventBridge wick.device ─▶ λ card-action ─▶ hallway_chime ─▶ Ring Chime playback ─▶ patch ─▶ TV
TV ─ POST /live/sessions (JWT) ─▶ λ live-start ─async─▶ λ live-bridge (container: werift+ffmpeg) ─▶ S3 ─▶ CloudFront HTTPS ─▶ TV player
```

### 4.1 Agent plane

- **One runtime, one container, three graphs.** `services/agent/Dockerfile` builds an arm64
  image whose entrypoint (`src/runtime/server.ts`) serves AgentCore's contract: `GET /ping`,
  `POST /invocations` on `0.0.0.0:8080`. Payload `{ kind: 'door.describe' | 'day.compose' |
  'week.compose', householdId, … }` selects a graph.
- **Session = household.** Every invocation uses `runtimeSessionId = wick-household-<id>-…`
  (≥33 chars), so AgentCore keeps one warm, isolated microVM per household — the isolation
  model is the product's own trust boundary.
- **Lambdas stay as shims** because EventBridge and Scheduler cannot target AgentCore
  directly. Door Phase 1 stays in its Lambda: it is local, deterministic and has a 900ms
  budget; only Phase 2 crosses into the runtime.
- **Graphs** (`@strands-agents/sdk` `Graph`, custom `Node` subclasses for deterministic steps):
  - **door**: `describe` (Agent, BedrockModel `amazon.nova-lite-v1:0`, structured output
    `{ personVisible: boolean|null, description: string|null }`, **no tools** — a vision agent
    with roster access could name a stranger) → `guardian` (validator + policy) →
    `remember` (AgentCore Memory event). The frame is fetched deterministically before the
    graph (it is also the image patch); the graph input is `[ImageBlock, TextBlock]`.
  - **day**: `select` (the existing tested rubric, as a node) → `phrase` (Agent, Nova Lite,
    rewrites ≤3 items as offers; structured output; validator: ≤14 words, no imperative
    opener, no verbatim quote) → `guardian`.
  - **week**: `narrator` (Agent, Claude Sonnet 5 inference profile) **with tools**:
    `get_week_timeline(isoWeek)`, `compare_rhythm(isoWeek)` (deterministic counts vs prior
    weeks — "the model never counts"), `recall_past_weeks(query)` (AgentCore Memory
    `RetrieveMemoryRecords`) → `guardian` → write `NARR#` + `WeekCard`.
- **Guardian as provenance, not prose-scanning.** Every tool stamps the `FactClass`es it
  returned into `invocationState.classesSeen`. The guardian node evaluates each class
  against the audience with `@wick/policy` `evaluate()` and refuses the whole output if any
  class is denied. The Narrator's tools can only return DOOR_EVENT / PRESENCE / RHYTHM — it
  cannot leak a health fact because it cannot see one (capability-based privacy), and the
  guardian proves it on every run.
- **Memory**: `aws_bedrockagentcore_memory` "wick_household" with a semantic strategy.
  Door writes one event per described visit (actor `household-<id>`, session `door-<isoDay>`);
  Narrator writes its finished week (session `week-<isoWeek>`) and recalls prior weeks.
  Event expiry 90 days.

### 4.2 M1 — hallway chime

- **Discovery** from the device list already cached for Phase 1 (`listDevices` with
  `include=status,capabilities,configurations`): a household *has a hallway chime* when some
  device has `chime.play`, is `online`, and is not snoozed. Phase 1 offers the button only
  then — still zero extra Ring calls in Phase 1.
- `RingCapabilities.chime` changes meaning from "any audio action" to "this device is a
  playable chime" (`supported_actions` ∋ `chime.play`). The doorbell no longer needs it.
- **Press** → TV keeps the card (only `dismiss` removes it) and sends `card_action` → ws
  `route.mjs` also `PutEvents` `{source:'wick.device', detail-type:'card.action'}` →
  `agent-card-action` Lambda → `ringHallwayChimes()`:
  re-read status (snooze can change), read configurations, pick slot
  `WICK_CHIME_SLOT_EVENT` (default `ring-appstore-event-1`), `POST` playback to **every**
  playable chime; → `sendPatchToDevice` with `notice` and the chime action removed.
- **Feedback copy** (D6, say plainly what happened): "The hallway chime rang." /
  "The hallway chime is snoozed, so it stayed quiet." / "The hallway chime didn't answer."
- **Idempotency**: one ring per card (conditional write `CHIME#<cardId>`); a second press or a
  redelivered event never rings twice. Stale cards (past `expiresAt`) never ring.

### 4.3 M2 — Watch live

- **TV**: `watch_live` opens `LiveView` (full screen; the resident asked for it). It calls
  `POST {pairingApiUrl}/live/sessions` with `Authorization: Bearer <device JWT>` and
  `{ cardId }`, gets `{ sessionId, playlistUrl, endsAt }`, loads `playlistUrl` into a
  `VideoPlayer`, retrying the load while the first playlist is not yet there (≤12s), shows
  "Live from the front door" and the seconds left, and on Back (or at `endsAt`) calls
  `DELETE /live/sessions/{id}` and returns to the card. Never a spinner without words.
- **live-start** Lambda (HTTP API, edge): verifies the device JWT (`jwt.mjs`), requires the
  `cardId` to be a **DOOR card for that household, not expired, created < 5 min ago**, reads
  the Ring camera id from the server-only `ringDeviceId` attribute on its `CARD#` item, allows
  one live session per household at a time (conditional `LIVE#active`), writes
  `LIVE#<sessionId>`, async-invokes **live-bridge**, returns immediately.
- **live-bridge** (Lambda, arm64 **container image**, Node 22 + static ffmpeg): the SP-3 bridge,
  productionised: token from Secrets Manager, WHEP offer, RTP → ffmpeg → `/tmp`, each new
  segment then the playlist uploaded to `s3://<media>/live/<sessionId>/`, stops at the Ring
  limit or when `LIVE#<id>.stopRequested` is set, always `DELETE`s the Ring session, removes
  the S3 prefix after the session.
- **Delivery**: a CloudFront distribution in front of the media bucket (OAC), path `live/*`,
  `.m3u8` uncached, `.ts` cached 60s. The session id is 128 random bits.
- **Security bound (honest).** `/pair/refresh` mints device tokens without proof of
  possession (root cause FL-013). A live view is therefore only obtainable **while someone is
  actually at the door** (a DOOR card < 5 min old), for **≤60s**, one at a time per household,
  via an unguessable URL deleted afterwards. That bounds, not eliminates, the exposure; the
  threat model says so.

## 5. Contracts that change

```ts
// packages/contracts/src/card.ts
export interface CardPatch {
  // …existing…
  /** One plain sentence about something the resident just did — M1 feedback. */
  readonly notice?: string;
  /** Replaces the card's actions (e.g. the chime button once it has rung). ≤ 3. */
  readonly actions?: readonly CardAction[];
}
export interface DoorCard { /* …existing… */ readonly notice?: string }

// packages/contracts/src/live.ts (new)
export interface LiveSessionRequest { readonly cardId: string }
export interface LiveSessionResponse {
  readonly sessionId: string; readonly playlistUrl: string; readonly endsAt: number;
}
export const LIVE_MAX_MS = 60_000;          // Ring's line-powered ceiling
export const LIVE_CARD_MAX_AGE_MS = 5 * 60_000;
```

Action ids on a DOOR card: `watch_live`, `hallway_chime`, `dismiss`. Only `dismiss` removes a
card on press; `watch_live` opens LiveView; `hallway_chime` waits for the patch.

## 6. Failure behaviour (what the resident sees)

| Situation | Behaviour |
|---|---|
| Runtime cold / invoke fails | Door: Phase 1 stands (as today). Day: no card (silence is the default). Week: no narrative this run; logged, retried next schedule. |
| Guardian refuses | Nothing leaves; `guardian_decision allow:false` logged with class, never content. |
| Chime snoozed / offline / slot empty / 4xx | Patch with the plain sentence; button removed; nothing retried. |
| Live: Ring 503 (offline) / 400 HEVC-only / no media in 12s | LiveView says "The doorbell camera isn't answering right now." with one "Back" button. |
| Live: session hits Ring's limit | "Live view has ended." + "Back". |

## 7. Out of scope

AgentCore Identity for Ring OAuth (tokens stay in Secrets Manager — honest, documented);
AgentCore Gateway (the MCP server stays custom, §7.3); two-way audio (no Ring endpoint);
WebView/WebRTC live view (FL-015); fixing `/pair/refresh` proof-of-possession (FL-013).

## 8. Order

1. **Plan A — M1 hallway chime** (smallest; completes the button pipeline the others reuse).
2. **Plan B — M2 Watch live** (first task is a deploy-and-see gate: the bridge Lambda must
   produce playable HTTPS HLS on the VVD before anything else is built on it).
3. **Plan C — Agent graph on Strands + AgentCore** (largest; moves Phase 2, Day and Narrator).
