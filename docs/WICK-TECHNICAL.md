# WICK — Technical Implementation Document

**Companion to `WICK.md` (product definition).** That document says *what* and *why*. This one says *how*.

| | |
|---|---|
| **Version** | 1.0 |
| **Date** | 14 September 2026 |
| **Target** | Build, Ship, Shape — Fire TV Track, 1st Place |
| **Deadline** | 23 October 2026, 12:00 PT |
| **Audience** | The engineer building it. Assumes deep AWS and distributed-systems fluency. Nothing is explained twice. |
| **Authority** | Where this document and `WICK.md` disagree on *behaviour*, `WICK.md` wins. Where they disagree on *mechanism*, this one does. |

---

## 0. How to read this document

### 0.1 Verification markers

Every API claim carries a marker. This matters: a plausible-looking but invented signature costs you a day.

| Marker | Meaning |
|---|---|
| **✅ V** | **Verified** against live Amazon documentation or the real source of an `AmazonAppDev` sample app on 2026-09-14. Cited inline. |
| **⚠️ C** | **Confirm.** Structurally correct but the exact signature/field was not read. Check before use. |
| **🔬 S** | **Spike.** Unknown. Must be answered by a timeboxed experiment before design depends on it. |

### 0.2 The three facts that shaped every decision below

1. **Vega exposes no camera, microphone, Bluetooth or presence sensor to third-party apps.** ✅ V — verified against the complete dependency manifests of `vega-video-sample`, `vega-sports-app`, `vega-audio-sample`, `vega-tv-interfaces-sample`, `vega-epg-sample`. Consequence: all sensing is off-device. Ring is the eye, Bee is the ear.
2. **Alexa+ requires MCP round-trip latency under 500ms.** ✅ V — Alexa+ MCP Toolkit quickstart. Consequence: the weekly narrative **must be precomputed**. You cannot generate it inside the tool call.
3. **Ring requires a webhook ACK inside 5 seconds and blocks browser-origin requests entirely.** ✅ V — Ring Partner API docs. Consequence: verify-and-enqueue only at the edge; the TV never holds a Ring credential.

### 0.3 Non-negotiable invariants

These are enforced by code and by test, not by convention. Violating any of them is a build break.

| # | Invariant |
|---|---|
| **INV-1** | No Ring, Bee, or AWS long-lived credential ever resides on the television. The device holds exactly one device-bound JWT. |
| **INV-2** | Every string that leaves the system toward the family passes through the Guardian. There is no second path. Enforced by a single egress module and a lint rule. |
| **INV-3** | No inbound Ring video or image is persisted beyond the S3 lifecycle window (24h). Enforced by bucket lifecycle policy, not by application code. |
| **INV-4** | No verbatim Bee utterance is ever transmitted to a family surface. Only derived, typed facts. |
| **INV-5** | Deferred cards are never rendered during `IN_SCENE`. The only immediate class is `DOOR`. |
| **INV-6** | Every agent tool call is idempotent and carries a correlation id that survives to CloudWatch. |
| **INV-7** | The resident's weekly narrative is written to the TV surface before it is readable by any family tool. Ordering is enforced by the write path. |

---

## 1. ARCHITECTURE

### 1.1 Context

```
                      ┌──────────────────────────────────────────┐
   Margaret's house   │                                          │   Sarah, anywhere
                      │                                          │
  ┌────────────┐      │      ┌─────────────────────────┐         │      ┌──────────┐
  │ Fire TV    │◀────WSS────▶│                         │◀──MCP/HTTPS────│ Alexa+   │
  │ (Vega OS)  │      │      │      WICK CLOUD         │         │      │ (Echo)   │
  │  Wick app  │      │      │                         │         │      └──────────┘
  └────────────┘      │      │  ┌──────────────────┐   │         │
                      │      │  │ Agent plane      │   │         │
  ┌────────────┐      │      │  │  Door · Day      │   │         │
  │ Ring       │──webhook───▶│  │  Narrator        │   │         │
  │ doorbell   │◀────REST────│  │  ─────────────   │   │         │
  │ + Chime    │      │      │  │  GUARDIAN (gate) │   │         │
  └────────────┘      │      │  └──────────────────┘   │         │
                      │      │                         │         │
  ┌────────────┐      │      │  ┌──────────────────┐   │         │
  │ Bee        │      │      │  │ Memory plane     │   │         │
  │ + local    │──facts only▶│  │ DDB·Timestream·KB│   │         │
  │   proxy    │      │      │  └──────────────────┘   │         │
  └────────────┘      │      └─────────────────────────┘         │
                      └──────────────────────────────────────────┘
```

**Four planes, and the boundaries are load-bearing:**

| Plane | Responsibility | Explicitly NOT responsible for |
|---|---|---|
| **Device** | Render cards, play video, emit playback state, capture D-pad intent | Any decision about *what* or *when* to show. Any credential. Any inference. |
| **Edge** | Terminate Ring webhooks, terminate MCP, terminate device WSS. Authn/authz. Sub-5s ACK. | Business logic. Model calls. |
| **Agent** | All reasoning. Door description, day extraction, narrative writing, policy enforcement. | Persistence decisions. Transport. |
| **Memory** | Timeline, rhythm series, household knowledge, policy state | Interpretation |

**The rule that keeps this clean:** the device is a dumb, fast, beautiful renderer. If you find yourself writing an `if` about *whether* to show something in the TV app, it belongs in the agent plane.

### 1.2 Why the thinking is off-device

Three reasons, in order of weight:

1. **INV-1.** A £30 stick in a stranger's front room is not a credential store. Vega has no documented hardware-backed keystore (see L10 in `WICK.md`).
2. **The agent must run when the TV is off.** Most of Margaret's day. Vega headless services run only while the app package is alive; they are not a substitute for a 24/7 process.
3. **Iteration speed.** Changing a prompt should not require a device deploy. During a five-week build this is worth more than it sounds.

### 1.3 Runtime topology

| Component | Service | Why |
|---|---|---|
| Ring webhook receiver | API Gateway HTTP API → Lambda | Sub-5s ACK; scales to zero |
| Event bus | EventBridge (custom bus `wick`) | Fan-out, replay via archive, DLQ per rule |
| Agent runtime | **Bedrock AgentCore Runtime** | Managed session isolation, long-running, direct AWS Builder mini-challenge alignment |
| Agent orchestration | **Strands Agents SDK** | Multi-agent graph; judges explicitly reward this over single-model calls |
| Long-horizon memory | **AgentCore Memory** | The Rhythm pillar. Episodic + semantic. |
| Credential custody | **AgentCore Identity** | Ring OAuth token lifecycle, outside our code |
| Tool surface for Alexa+ | **AgentCore Gateway** ⚠️ C / custom MCP server | See §7.3 — decision gate |
| Device channel | API Gateway WebSocket **or** AWS IoT Core | See §4.1 — spike decision |
| Timeline store | DynamoDB (single table) | Access patterns are known and narrow |
| Rhythm store | Amazon Timestream | Purpose-built; `INTERPOLATE`/binned aggregates give baselines cheaply |
| Household knowledge | Bedrock Knowledge Base over S3 + S3 Vectors | Natural-language recall over derived facts |
| Media scratch | S3 with 24h lifecycle | INV-3 |
| Async work | SQS FIFO per household | Ordering matters for the timeline |

### 1.4 The four agents

Implemented as Strands agents with explicit, narrow tool sets. **Do not let these collapse into one.** The separation is the architecture and it is also the demo.

| Agent | Trigger | Tools | Output |
|---|---|---|---|
| **Door** | `ring.event` on EventBridge | `get_snapshot`, `describe_image`, `match_roster`, `get_expected_visitors` | `DoorCard` |
| **Day** | Bee SSE delta, or 30-min timer | `list_facts`, `list_todos`, `get_daily`, `search_neural` | `DayCard` (≤3 items) |
| **Narrator** | Weekly cron + on-demand precompute | `query_timeline`, `query_rhythm`, `compare_baseline` | `WeekNarrative` |
| **Guardian** | **Synchronously, on every egress** | `get_policy`, `get_resident_exclusions` | Redacted payload, or refusal |

The Guardian is not an agent in the autonomous sense. It is a **deterministic policy engine with a model-assisted classifier**, and the deterministic half runs first. See §6.

---

## 2. REPOSITORY LAYOUT

Single repository. Public. MIT or Apache-2.0, licence detectable in the About panel (this is a rules requirement and a common fatal omission).

```
wick/
├── LICENSE                      # ← must render in GitHub About panel
├── README.md                    # landing page: demo video first
├── FRICTION.md                  # started day 1, not day 30
├── AGENTS.md                    # invariants contract for coding agents
├── docs/
│   ├── WICK.md                  # product definition
│   ├── WICK-TECHNICAL.md        # this file
│   └── architecture/            # diagrams (source + rendered)
│
├── apps/
│   ├── tv-vega/                 # the Vega OS application
│   │   ├── manifest.toml
│   │   ├── index.js             # interactive entry
│   │   ├── task.js              # headless TASK registrations
│   │   ├── service.js           # headless SERVICE registrations
│   │   └── src/
│   │       ├── cards/           # Card renderer + the three card types
│   │       ├── break/           # NaturalBreakEngine
│   │       ├── player/          # w3cmedia wrapper
│   │       ├── personalization/ # ContentPersonalization handlers (REAL, not mocks)
│   │       ├── transport/       # device channel client
│   │       ├── pairing/         # 6-digit device pairing
│   │       ├── a11y/            # focus + screen-reader hints
│   │       └── headless/        # service/task implementations
│   │
│   └── tv-fireos/               # Fire OS companion (build LAST)
│
├── services/
│   ├── edge-ring/               # webhook receiver (Lambda)
│   ├── edge-device/             # WS connect/disconnect/route
│   ├── mcp-server/              # Alexa+ MCP add-on backend
│   ├── agent/                   # Strands graph, AgentCore deployment
│   │   ├── agents/{door,day,narrator,guardian}/
│   │   ├── tools/
│   │   └── prompts/             # versioned, tested
│   ├── connectors/
│   │   ├── ring/                # OAuth, devices, snapshot, WHEP, chime, history
│   │   └── bee/                 # proxy client, SSE consumer, fact normaliser
│   └── policy/                  # Guardian engine — its own package, heavily tested
│
├── packages/
│   ├── contracts/               # shared types: Card, DoorEvent, Fact, Narrative
│   └── vega-calm-ui/            # ← THE OPEN-SOURCE EXTRACTION (see §13.4)
│
├── infra/                       # CDK (TypeScript)
├── addon-package/               # Alexa+ addon.json + media assets
└── .github/workflows/
```

**One deliberate choice:** `services/policy` is a standalone package with no AWS dependencies. It is pure functions over typed inputs, which means it is exhaustively testable, and its test suite is a demo artefact.

---

## 3. THE VEGA APPLICATION

### 3.1 Component model

Vega's `manifest.toml` declares components of three kinds — `interactive`, `service`, `task` — each bound to a runtime module, optionally grouped into processes. ✅ V (`vega-video-sample/manifest.toml`)

Wick declares:

| Component | Kind | Id suffix | Purpose |
|---|---|---|---|
| Main UI | `interactive` | `.main` | Cards, player, all rendering |
| Card service | `service` | `.card.service` | Holds the device channel; receives cards while app is alive |
| Personalization refresh | `service` | `.content.dataRefresh.provider` | Serves Watch Activity to the platform |
| Nightly rhythm push | `task` | `.rhythmSyncTask` | Batch-uploads local playback events |
| Install bootstrap | `task` | `.onInstallTask` | First-run pairing state |

Manifest skeleton, using only structures verified in the sample: ✅ V

```toml
schema-version = 1

[package]
id      = "com.wick.tv"
title   = "Wick"
version = "0.1.0"
icon    = "@image/Wick.png"

[os.version]
min    = "1.2"
target = "1.2"

[components]
[[components.interactive]]
id             = "com.wick.tv.main"
runtime-module = "/com.amazon.kepler.runtime.react_native_kepler_4@IReactNativeKepler_0"
categories     = ["com.amazon.category.main", "com.amazon.category.kepler.media"]
launch-type    = "singleton"

[[components.service]]
id             = "com.wick.tv.content.dataRefresh.provider"
runtime-module = "/com.amazon.kepler.runtime.react_native_kepler_4@IReactNativeKepler_0"
launch-type    = "singleton"

[[components.service]]
id             = "com.wick.tv.card.service"
runtime-module = "/com.amazon.kepler.runtime.react_native_kepler_4@IReactNativeKepler_0"
launch-type    = "singleton"

[[components.task]]
id             = "com.wick.tv.rhythmSyncTask"
runtime-module = "/com.amazon.kepler.runtime.react_native_kepler_4@IReactNativeKepler_0"

[[components.task]]
id             = "com.wick.tv.onInstallTask"
runtime-module = "/com.amazon.kepler.runtime.react_native_kepler_4@IReactNativeKepler_0"

[processes]
[[processes.group]]
component-ids = ["com.wick.tv.main"]
[[processes.group]]
component-ids = ["com.wick.tv.card.service"]
[[processes.group]]
component-ids = ["com.wick.tv.content.dataRefresh.provider"]

[wants]
[[wants.service]]   ; personalization data service
id = "com.amazon.tv.developer.dataservice"
[[wants.privilege]] ; content personalization
id = "com.amazon.tv.content-personalization.privilege.provide-data"
[[wants.privilege]] ; accessibility APIs
id = "com.amazon.devconf.privilege.accessibility"
[[wants.service]]   ; media session / transport controls
id = "com.amazon.media.playersession.service"
[[wants.service]]   ; remote button events
id = "com.amazon.inputd.service"
[[wants.service]]   ; audio ducking
id = "com.amazon.audio.control"
[[wants.service]]
id = "com.amazon.network.service"

[needs]
[[needs.privilege]]
id = "com.amazon.network.privilege.net-info"
[[needs.module]]
id = "/com.amazon.vega.os@IVega_1_2"

[tasks]
[[tasks.work]]
component-id = "com.wick.tv.onInstallTask"
mode         = "install"

[[extras]]
key          = "interface.provider"
component-id = "com.wick.tv.main"

[extras.value.application]
[[extras.value.application.interface]]
interface_name    = "com.amazon.kepler.media.IContentPersonalizationServer"
attribute_options = ["SupportedCustomerLists", "DataRefreshComponentId"]

[extras.value.application.interface.static_values]
SupportedCustomerLists = ["Watchlist"]
DataRefreshComponentId = "com.wick.tv.content.dataRefresh.provider"

[[extras.value.application.interface]]
interface_name  = "com.amazon.kepler.media.IMediaPlaybackServer"
command_options = ["Play", "Pause", "StartOver", "Previous", "Next"]
```

> **Do not declare** `IContentLauncherServer` or `IAccountLoginServer`. Both are select-partner-gated (`WICK.md` L4). Declaring what you cannot exercise is worse than omitting it.

### 3.2 Headless registration

Tasks and services register through `HeadlessEntryPointRegistry`, with entry-point names of the form `<component-id>::<hook>`. ✅ V (`vega-video-sample/task.js`, `service.js`)

```js
// task.js
import { HeadlessEntryPointRegistry } from '@amazon-devices/headless-task-manager';
import doRhythmSync from './src/headless/RhythmSyncTask';
import doOnInstall   from './src/headless/OnInstallTask';

HeadlessEntryPointRegistry.registerHeadlessEntryPoint(
  'com.wick.tv.rhythmSyncTask::doTask', () => doRhythmSync);
HeadlessEntryPointRegistry.registerHeadlessEntryPoint(
  'com.wick.tv.onInstallTask::doTask', () => doOnInstall);
```

```js
// service.js — note registerHeadlessEntryPoint2 for SERVICES (not tasks)
import { HeadlessEntryPointRegistry } from '@amazon-devices/headless-task-manager';
import { onStartCardService, onStopCardService }   from './src/headless/CardService';
import { onStartDataRefresh, onStopDataRefresh }   from './src/headless/DataRefreshService';

HeadlessEntryPointRegistry.registerHeadlessEntryPoint2(
  'com.wick.tv.card.service::onStartService', () => onStartCardService);
HeadlessEntryPointRegistry.registerHeadlessEntryPoint2(
  'com.wick.tv.card.service::onStopService',  () => onStopCardService);
HeadlessEntryPointRegistry.registerHeadlessEntryPoint2(
  'com.wick.tv.content.dataRefresh.provider::onStartService', () => onStartDataRefresh);
HeadlessEntryPointRegistry.registerHeadlessEntryPoint2(
  'com.wick.tv.content.dataRefresh.provider::onStopService',  () => onStopDataRefresh);
```

Services implement `{ onStart(componentInstance), onStop(componentInstance) }` returning `Promise<void>`, where `componentInstance: IComponentInstance` comes from `@amazon-devices/react-native-kepler`. ✅ V (`src/headless/HeadlessInterface.ts`)

### 3.3 Content Personalization — the Rhythm pillar's real input

This is the least-used Vega surface and it is doing double duty for us: the platform gets correct Continue Watching behaviour, and Wick gets a genuine behavioural signal with **no new sensor**.

The API is a pull model: the platform invokes your handlers, you push chunks into a provider, then `commit()`. ✅ V (`src/headless/DataRefreshService.ts`)

```ts
import {
  ContentPersonalizationServer,
  IPlaybackEventsHandler, IPlaybackEventsProvider,
  ICustomerListEntriesHandler, ICustomerListEntriesProvider, CustomerListType,
  IContentEntitlementsHandler, IContentEntitlementsProvider,
} from '@amazon-devices/kepler-content-personalization';

const playbackEventsHandler: IPlaybackEventsHandler = {
  getPlaybackEventsSince: (since: Date, provider: IPlaybackEventsProvider) => {
    // REAL events from local store — never mocks. See §12.3.
    for (const chunk of localStore.playbackEventsSince(since, { chunk: 200 })) {
      provider.addPlaybackEventChunk(chunk);
    }
    provider.commit();
  },
};
```

`IPlaybackEvent` is built with `PlaybackEventBuilder`, carrying `contentId`, `profileId`, `playbackState`, `playbackPositionMs`, `durationMs`, **`creditsPositionMs`**, `eventTimestamp`, optional `channelDescriptor`, terminated by `buildActiveEvent()`. ✅ V (`ContentPersonalizationMocks.ts`)

> **`creditsPositionMs` is the single most useful field in this API for Wick.** It is the platform's own model of "the episode is ending" — which is exactly the `AT_BREAK` signal the Natural-Break Engine needs. You get end-of-episode detection for free, from a field you must populate anyway.

**Critical build note.** The sample ships `ContentPersonalizationMocks.ts` and wires it into `DataRefreshService`. **Delete that wiring on day one.** Shipping the sample's mocks would violate the "no simulated data" constraint in the most embarrassing possible place, and a judge reading the repo will find it.

### 3.4 The Natural-Break Engine (S2)

The product's defining behaviour, and it is entirely deterministic. No model involved.

**States**, derived from the player and the content metadata:

| State | Condition | Deferred cards? |
|---|---|---|
| `IN_SCENE` | playing, `position < creditsPositionMs − 30s` | **No** |
| `NEAR_BREAK` | playing, within 30s of `creditsPositionMs` | No — but prefetch and pre-render |
| `AT_BREAK` | `position ≥ creditsPositionMs`, or paused > 5s, or content ended | **Yes** |
| `TV_SETTLED` | app foregrounded ≥ 20s with no playback started | **Yes** |
| `IDLE` | app not foregrounded | No — queue persists |

```ts
type Urgency = 'DOOR' | 'DEFERRED';          // exactly two. INV-5.

interface QueuedCard {
  id: string;                                 // idempotency key
  urgency: Urgency;
  card: DoorCard | DayCard | MessageCard;
  queuedAt: number;
  expiresAt?: number;                         // DOOR only; DEFERRED never expires (Principle 9)
  shownCount: number;                         // release at most twice, ever
}
```

**Release rules, verbatim:**
1. `DOOR` renders immediately in the lower third, regardless of state. Never pauses, never ducks below −6dB, never plays a sound.
2. `DEFERRED` renders full-screen only in `AT_BREAK` or `TV_SETTLED`.
3. A `DEFERRED` card ignored once returns at the *next* break, once. After the second showing it drops to a passive home-screen row. It never returns a third time.
4. Queue survives restart — persisted via `@amazon-devices/kepler-file-system` ⚠️ C.

**This engine is the Design score.** Give it a real test suite over a synthetic playback timeline (§12.2), and show that suite in the video.

### 3.5 Card rendering and accessibility

Three card types, one renderer. All three obey the same spec.

| Constraint | Value | Source |
|---|---|---|
| Minimum type | 32pt | `WICK.md` Principle 7 |
| Contrast | ≥ 7:1 | WCAG AAA |
| Actions per card | ≤ 3 | Principle 6 |
| Reachability | D-pad + OK only; zero text entry | Principle 3 |
| Auto-dismiss | Never | Principle 9 |
| Animation | ≤ 200ms, ease-out, no flash, no red | Principle 7 |
| Safe area | Honour TV overscan via `react-native-safe-area-context` | — |

Screen-reader state is readable via the accessibility privilege ✅ V (`com.amazon.devconf.privilege.accessibility`); `vega-sports-app` ships a `useScreenReaderEnabled` hook and a `HintBuilder` for list-navigation hints — **read that code before writing yours.** ✅ V

Focus: use the platform focus engine plus `FocusGuideView` patterns from `vega-sports-app/src/services/focusGuide`. ✅ V Do not hand-roll spatial navigation.

### 3.6 Player

`@amazon-devices/react-native-w3cmedia` gives W3C MSE/EME. ✅ V Owning playback is what makes §3.4 possible — this is not incidental.

For the demo, content is the household's own library or public-domain material (`WICK.md` §Real data). Consider the out-of-process player (`kepler-player-client` / `kepler-player-server`, as used by `vega-sports-app`) ⚠️ C — it survives UI crashes, which is a nice robustness note but is **not** worth the complexity in v1. Defer.

Audio ducking for spoken cards via `@amazon-devices/keplerscript-audio-lib` ⚠️ C, requesting `com.amazon.audio.control`. Duck to −6dB, never mute.

---

## 4. DEVICE ↔ CLOUD

### 4.1 Transport — a decision gate, not a decision

**🔬 S — resolve in the first 72 hours.**

| Option | Pro | Con |
|---|---|---|
| **A. AWS IoT Core**, MQTT over WSS | Per-device identity and policy; **persistent sessions with QoS 1 deliver cards queued while the TV was off, on reconnect** — the Natural-Break Engine's "the card is waiting" requirement solved at the transport layer. Device Shadow gives free state reconciliation. | Requires `mqtt.js` (or similar) to work over WebSocket inside Vega's RN 0.83 fork. Unproven. |
| **B. API Gateway WebSocket API** | Zero library risk — RN ships a standard `WebSocket`. Trivial to reason about. | Connection state in DynamoDB; you implement catch-up yourself (`GET /cards/pending` on connect). |

**Recommendation:** spike A for four hours. If `mqtt.js` over WSS connects and survives a reconnect cycle on real hardware, take A — it is materially better engineering and it demonstrates depth. If it fights you at all, take B and move on the same day. B is not a compromise; it is a smaller correct answer.

Either way the **application-level contract is identical**, so build against this interface and swap the implementation:

```ts
interface DeviceChannel {
  connect(token: DeviceToken): Promise<void>;
  onCard(handler: (c: QueuedCard) => void): Unsubscribe;
  onControl(handler: (m: ControlMessage) => void): Unsubscribe;
  send(e: DeviceEvent): Promise<void>;          // playback state, card actions, acks
  readonly state: 'connecting' | 'open' | 'backoff' | 'closed';
}
```

Reconnect: exponential backoff 1s → 30s with full jitter. On `open`, always reconcile: send `lastSeenCardId`, receive everything after it.

### 4.2 Pairing (INV-1)

Sarah pairs the device once, in about eight minutes. The TV never sees an account password.

1. TV boots unpaired → displays a 6-digit code and a short URL. Code is a Lambda-generated nonce in DynamoDB, TTL 15 minutes, single use.
2. Sarah authenticates on her own device and enters the code.
3. Backend binds `deviceId ↔ householdId`, mints a **device-bound JWT** (RS256, 30-day expiry, rotating via refresh on each successful connect).
4. Token stored on device via `@amazon-devices/kepler-file-system` ⚠️ C. **Because Vega documents no hardware-backed keystore (L10), assume this token is extractable and scope it accordingly:** it grants exactly the ability to receive cards for one household and post playback events. It grants nothing over Ring, Bee, or the family surfaces.
5. Revocation: a `deviceId` denylist checked on every WS connect. Instant.

### 4.3 Device → cloud events

```ts
type DeviceEvent =
  | { t: 'playback';   state: PlaybackState; positionMs: number; durationMs: number;
                       creditsPositionMs?: number; contentId: string; at: number }
  | { t: 'break_state'; state: 'IN_SCENE'|'NEAR_BREAK'|'AT_BREAK'|'TV_SETTLED'|'IDLE'; at: number }
  | { t: 'card_action'; cardId: string; action: string; at: number }
  | { t: 'card_shown';  cardId: string; at: number }
  | { t: 'app_lifecycle'; state: 'fg'|'bg'; at: number };
```

`playback` and `app_lifecycle` are the **entire** Rhythm pillar input from the device side. Batch them: 10-second coalescing window, flush on state change. There is no reason to be chatty here.

---

## 5. THE AGENT PLANE

### 5.1 Strands graph

Four agents, narrow tools, explicit handoffs. Deployed to **AgentCore Runtime**; **AgentCore Memory** holds household state across weeks; **AgentCore Identity** holds Ring tokens.

```
  EventBridge ─┬─▶ Door agent ────┐
               │                  │
  Bee SSE ─────┼─▶ Day agent ─────┼──▶ GUARDIAN ──▶ egress
               │                  │      (sync)      ├─▶ DeviceChannel  (TV)
  cron ────────┴─▶ Narrator ──────┘                  └─▶ MCP tool result (Alexa+)
```

**Model selection** — do not use one model for everything:

| Job | Model | Why |
|---|---|---|
| Door image → one sentence | **Nova Lite/Pro (vision)** | Latency-critical (§9.1). Cheap. The task is description, not reasoning. |
| Day fact triage (pick 3 of N) | **Nova Pro** or **Claude Haiku-class** | Structured selection under a rubric |
| Weekly narrative | **Claude (Sonnet-class or better)** | Prose quality is the product here. Runs weekly, offline. Cost is irrelevant. |
| Reply drafting | **Claude** | Register and tone matter (`WICK.md` M3) |
| Guardian classification | **Nova Lite** + deterministic rules | Rules first; model only for residual classification |

### 5.2 Door agent

**Two-phase emission. This is the key latency decision.**

A single-shot card that waits for vision blows the 3-second budget when Bedrock is slow. Instead:

```
Phase 1  (target ≤ 900ms)  ─▶ DoorCard{ image, "Someone's at the front door.", actions }
Phase 2  (target ≤ 2200ms) ─▶ CardPatch{ cardId, description: "A man in a delivery uniform…" }
```

The TV renders Phase 1 immediately and patches the description in when it arrives. **The useful half of the card is never blocked by the interesting half.** If Phase 2 fails or times out at 2.5s, the card simply stays as Phase 1 — which is still better than any competitor.

**Description prompt constraints** (these are product requirements, enforced in the prompt and in an output validator):
- Present tense, one sentence, ≤ 14 words.
- Observable facts only. No inference about intent, mood, or purpose.
- Never name a person unless matched against the household's own explicit roster.
- On low confidence, emit nothing — Phase 1 stands. Principle 11.

Roster matching: start **schedule-based**, not biometric (`WICK.md` decision D3) — "Maria usually comes Tuesdays at nine" delivers most of the value with none of the weight. If you later add face matching, it is opt-in, household-curated, deletable, and never applied to unknown visitors.

### 5.3 Day agent

Input: Bee facts/todos/daily (§7.2). Output: ≤ 3 items.

Selection rubric, in priority order:
1. **A commitment with a near deadline that nothing else has surfaced.** ("The surgery rang about Thursday.")
2. **A self-referential health or wellbeing mention whose frequency changed.** Frequency delta is computed from Timestream, not guessed.
3. **Anything queued from the family.**

Hard rules: never more than three; never the same item twice in seven days unless its deadline moved; never a verbatim quote (INV-4); phrase as an offer, never an instruction.

### 5.4 Narrator — and why it must be precomputed

**Alexa+ requires MCP round trips under 500ms.** ✅ V You cannot generate a week's narrative inside a tool call.

Therefore:
- A weekly EventBridge Schedule (Sunday 06:00 local) generates the narrative.
- A secondary trigger regenerates it on material change (a deviation, a carer no-show).
- The narrative is **written to the TV surface first** (INV-7), then marked family-readable.
- The MCP tool does a single DynamoDB `GetItem` and returns. Sub-100ms p99, comfortably.

Narrative construction: retrieve the week's timeline + the rhythm baseline, compute deltas deterministically, then hand *numbers and facts* to the model for prose. **The model never counts.** It writes. Anything it could get arithmetically wrong is computed before it sees it.

### 5.5 Prompts are code

`services/agent/prompts/` — versioned files, not string literals. Each has a golden-output test (§12.4). A prompt change that alters golden outputs fails CI until the goldens are consciously updated.

---

## 6. THE GUARDIAN

The most important component in the system and the one most likely to be under-built. It is what makes the product's central claim defensible rather than rhetorical.

### 6.1 Shape

A pure package — no AWS imports, no network. Input: a typed payload plus household policy. Output: a redacted payload or a typed refusal.

```ts
type Audience = 'RESIDENT' | 'FAMILY' | 'AGENCY';

type FactClass =
  | 'DOOR_EVENT' | 'PRESENCE' | 'COMMITMENT' | 'RHYTHM'
  | 'HEALTH' | 'FINANCIAL' | 'RELATIONSHIP' | 'LOCATION' | 'VERBATIM';

interface Decision {
  allow: boolean;
  transform?: 'summarise' | 'redact_specifics';
  reason: string;               // human-readable; surfaced in the refusal
}

function evaluate(
  item: { class: FactClass; content: string; sourceIds: string[] },
  audience: Audience,
  policy: HouseholdPolicy,
): Decision;
```

### 6.2 The default policy table

| Class | RESIDENT | FAMILY | AGENCY |
|---|---|---|---|
| `DOOR_EVENT` | allow | allow | own visits only |
| `PRESENCE` (arrived/left) | allow | allow | own visits only |
| `RHYTHM` | allow | **summarise** (narrative only, never raw logs) | deny |
| `COMMITMENT` | allow | **summarise** | deny |
| `HEALTH` | allow | **deny unless explicitly permitted** | deny |
| `FINANCIAL` | allow | deny | deny |
| `RELATIONSHIP` | allow | deny | deny |
| `LOCATION` | allow | deny | deny |
| `VERBATIM` | allow | **deny — always, unconditionally** (INV-4) | deny |

Resident exclusions are applied **after** the table and can only ever narrow. There is no path by which an exclusion widens access.

### 6.3 Enforcement

- **One egress module.** `services/agent/egress.ts` is the sole exporter of `sendToFamily` and `sendToDevice`. Every other module is forbidden from importing the transport clients directly.
- **A lint rule enforces that** (`no-restricted-imports` on the transport packages outside `egress.ts`). A rule you can actually run beats a convention you can only remember.
- **Property-based tests** (`fast-check`): for any generated item classed `HEALTH`/`FINANCIAL`/`RELATIONSHIP`/`VERBATIM` and any policy, `evaluate(..., 'FAMILY')` never returns `allow: true` with the original content intact. Run 10,000 cases in CI.

### 6.4 Refusal is a feature

When the Guardian denies, the family surface says so plainly and warmly:

> *"That's something Margaret's keeping to herself. I'm not able to share it."*

Never a generic error. Never silence — silence is indistinguishable from "nothing happened", which is a lie. **Film this.** Ten seconds of Alexa declining is one of the most memorable things in the submission.

---

## 7. CONNECTORS

### 7.1 Ring

**Auth** ✅ V — OAuth 2.0 + PKCE (S256). Access tokens ~4h, refresh ~30d. Token custody in **AgentCore Identity**. Never on device (INV-1). All calls server-to-server; `api.amazonvision.com` and `oauth.ring.com` block browser origins.

**Endpoints used:**

| Purpose | Call |
|---|---|
| Discovery | `GET /v1/devices?include=status,capabilities,location,configurations` |
| Snapshot (Phase 1 + vision) | `POST /v1/devices/{id}/media/image/download` |
| Live view (M2) | `POST /v1/devices/{id}/media/streaming/whep/sessions` (`Content-Type: application/sdp`) |
| Live view fallback | `rtsps://video.rtsp.amazonvision.com:322/v1/devices/{id}/stream` |
| **"Just a moment" (M1)** | `POST /v1/devices/{chimeId}/media/audio/playback` |
| Carer verification (M5) | `GET /v1/history/devices/{id}/events` |
| Multi-module cameras | append `?component_id=N` |

**Webhook receiver — the whole design is the 5-second budget:** ✅ V

```
API GW HTTP API → Lambda:
  1. Verify HMAC-SHA256 signature          (constant-time compare)
  2. Idempotency: conditional PutItem on request_id, TTL 24h
  3. PutEvents → EventBridge bus "wick"
  4. return 200
  ── nothing else. No Ring calls, no model calls, no DynamoDB writes beyond (2).
```

Everything downstream is async. Target p99 under 150ms.

**Event types** ✅ V: `motion_detected` (carries `sub_type`, e.g. `"human"`), `button_press`, `device_added`, `device_removed`, `device_online`, `device_offline`, `app_integration_added`, `app_integration_removed`, `subscription_activated`, `subscription_deactivated`.

**Rate limit** 100 rps ✅ V — irrelevant at household scale, but honour `Retry-After` anyway.

**Known gaps** (→ friction log, §14): no two-way audio / siren / light endpoints; no event replay or DLQ on Ring's side; no sandbox that emits synthetic events on demand — which makes CI awkward and is worth writing up properly.

### 7.2 Bee

**Local proxy** ✅ V — `bee login`, then `bee proxy`; binds `127.0.0.1:8787` (auto-increments), also a Unix socket at `~/.bee/proxy.sock`. Only `/v1/*` forwards. Default idle timeout 120s (`--idle-timeout`).

| Purpose | Call |
|---|---|
| Real-time deltas | `GET /v1/stream` (SSE, optional event-type filter) |
| Incremental sync | `GET /v1/changes` (cursor over changed entity ids) |
| Facts / todos | `GET /v1/facts`, `GET /v1/todos` |
| Day summary | `GET /v1/daily`, `GET /v1/daily/:id` |
| Conversations | `GET /v1/conversations[/:id]` |
| Recall | `POST /v1/search/conversations`, `.../neural` |

**Deployment.** The proxy runs on a small always-on machine in the household — a Pi or a mini PC beside the router. A thin **Bee bridge** process next to it consumes SSE, normalises to `Fact`, classifies against `FactClass`, **drops verbatim content**, and posts only derived facts over mTLS to the cloud.

> **INV-4 lives here, at the household boundary.** Raw utterances must never leave the house. Enforce it in the bridge, where it is one function, not in the cloud, where it is an ongoing act of discipline.

The 120s idle timeout will fight a long-lived SSE consumer. Expect to implement heartbeat + reconnect. That is friction-log entry material.

### 7.3 Alexa+ MCP add-on (S4)

**Hard requirements** ✅ V (Alexa+ MCP Toolkit quickstart):

- MCP spec **2025-11-25**, **Streamable HTTP** (migrate off legacy SSE).
- Public HTTPS endpoint. `cloudflared` is the documented local-dev tunnel.
- **Round-trip latency under 500ms.** Architectural constraint, not a target (§5.4).
- Auth is mandatory: return `401` (no `WWW-Authenticate`) when unauthenticated; host Protected Resource Metadata at `/.well-known/oauth-authorization-server`; advertise `code_challenge_methods_supported: ["S256"]`; OAuth 2.1 auth-code + PKCE; `resource` set to the server's canonical URI; Bearer token on authenticated calls.
- Tools are discovered by **introspection at deploy time** — *"Alexa+ refreshes tool information only on deployment."* **Redeploy after any tool change.** This will bite you at least once; write it down when it does.

**CLI** ✅ V

```bash
alexa-ai configure                       # LWA OAuth → ~/.alexa-ai/credentials
alexa-ai new mcp --name "Wick" --locale en-US \
                 --mcp-server-url "https://mcp.wick.example"
alexa-ai deploy                          # dev stage
alexa-ai submit                          # certification
```

**`addon-package/addon.json`** ✅ V — `manifestVersion: "1.0"`; `storeListing.distributionCountries: ["US"]`; per-locale `name.value` ≤30 chars, `shortDescription` ≤123, `fullDescription` ≤4000, `examplePhrases` 3–4 items ≤200 chars each, `privacyPolicyUrl` + `termsOfUseUrl` (both must be live HTTPS), `mediaAssets.icons.light` with **all six sizes** (72, 64, 88, 126, 180, 241), ≥1 carousel image at 600×900; `integrations[].type: "MCP"` with `config.endpoints.default.uri`.

> Two things here consume real time and are always underestimated: **six icon sizes** and **two live legal URLs**. Generate the icons and stand up the two pages in week one. They gate `deploy`.

**Tool surface** — keep it small and boring. Every tool is a `GetItem` against precomputed state.

| Tool | Returns | Guardian audience |
|---|---|---|
| `get_week_narrative` | Precomputed prose + timeline | FAMILY |
| `get_today` | Today's events, summarised | FAMILY |
| `did_visitor_come` | Carer/visitor verification (M5) | FAMILY / AGENCY |
| `send_note_to_tv` | Enqueues a `MessageCard` (M3) | — (inbound) |
| `get_resident_shared_view` | Exactly what the resident sees is shared | FAMILY |

**MCP Apps extension** (M6) ✅ V renders the week timeline in the conversation view. Build it after the five tools work. It is a genuine differentiator — very few submissions will touch it — but it is not the spine.

**Alexa+ routes by intent**, so the name "Wick" is rarely spoken. Write `examplePhrases` as natural questions (*"how's my mum been this week"*), not invocation patterns.

---

## 8. DATA MODEL

### 8.1 DynamoDB — single table `wick`

PK/SK overloaded; one GSI. Access patterns are narrow and known.

| Entity | PK | SK | Notes |
|---|---|---|---|
| Household | `HH#<id>` | `META` | policy, timezone, config |
| Device | `HH#<id>` | `DEV#<deviceId>` | pairing, last seen, denylist flag |
| Person (roster) | `HH#<id>` | `PER#<personId>` | name, schedule, photo ref |
| Timeline event | `HH#<id>` | `EVT#<ts>#<ulid>` | door, presence, card shown/actioned |
| Fact (derived) | `HH#<id>` | `FACT#<class>#<ulid>` | never verbatim (INV-4) |
| Card | `HH#<id>` | `CARD#<ulid>` | queue state, shownCount |
| Narrative | `HH#<id>` | `NARR#<isoWeek>` | `residentSeenAt` gates family read (INV-7) |
| Pairing nonce | `PAIR#<code>` | `META` | TTL 15m |
| Webhook idempotency | `IDEM#<requestId>` | `META` | TTL 24h |

**GSI-1** (`gsi1pk` = `HH#<id>#<entityType>`, `gsi1sk` = timestamp) covers "recent events of type X".

On-demand capacity. At one household this is effectively free; at scale the access patterns stay flat.

### 8.2 Timestream — the Rhythm pillar

One database, three tables. Content-free by construction: these are **measures about behaviour, never about content**.

| Table | Dimensions | Measures |
|---|---|---|
| `tv_activity` | householdId, deviceId | `power_on`, `session_minutes`, `foreground` |
| `door_activity` | householdId, deviceId, subType | `motion`, `button_press` |
| `presence` | householdId, personId | `arrival`, `departure`, `dwell_minutes` |

Baselines come from binned aggregates over a trailing 4–6 weeks, bucketed by day-of-week and hour. Deviation detection (D1) is a z-score against that baseline with a hard floor on sample count — **do not emit a deviation from fewer than three weeks of data.** A false "something's different" is worse than the feature's absence.

### 8.3 S3

| Bucket / prefix | Contents | Lifecycle |
|---|---|---|
| `wick-media/snapshots/` | Ring stills, pre-description | **Expire 24h** — INV-3, enforced by bucket policy |
| `wick-media/voice/` | Family voice notes | 30d |
| `wick-media/tts/` | Polly output, cached by hash | 30d |
| `wick-kb/facts/` | Derived facts for the Knowledge Base | Retained; deleted on withdrawal |

INV-3 is a **bucket lifecycle rule**, not application code. Storage enforces the promise; that is the difference between a claim and a guarantee.

### 8.4 Knowledge Base

Bedrock Knowledge Base over `wick-kb/facts/` with **S3 Vectors** as the store. Powers natural-language recall ("when did she last mention her knee?"). Ingestion is incremental from the fact stream. Every document is pre-classified with its `FactClass` so the Guardian can filter retrievals **before** they reach a prompt — retrieval-time filtering, not post-hoc redaction.

### 8.5 Withdrawal

One operation, no negotiation (`WICK.md` §6.4). `DELETE /household/{id}` cascades: DynamoDB partition scan-and-delete, Timestream record deletion, S3 prefix purge, KB document deletion, AgentCore Memory namespace deletion, Alexa+ account unlink, device denylist. **Write this in week two and test it**, not in week five. It is also thirty seconds of extremely credible demo footage.

---

## 9. PERFORMANCE

### 9.1 The Door Card budget — 3000ms, glass to glass

The product promise is "under 3 seconds" (`WICK.md` §13). Budget it, instrument it, and put the measured number on screen in the demo.

| Segment | Target | p99 ceiling | Owner |
|---|---|---|---|
| Ring press → webhook arrives | 200–500ms | — | **Ring. Uncontrollable. Measure it and say so.** |
| HMAC verify + idempotency + EventBridge put | 30ms | 150ms | Us |
| EventBridge → Door agent invoke | 50ms | 200ms | AWS |
| Ring snapshot fetch | **300–800ms** 🔬 S | 1200ms | Ring — **measure on day one** |
| **Phase 1 emit** (image + generic line) | — | **≤ 900ms** from webhook | Us |
| Bedrock Nova vision | 400–900ms | 1500ms | AWS |
| Guardian | < 20ms | 50ms | Us |
| Push to device | 50–150ms | 400ms | Transport |
| Render | < 100ms | 200ms | Vega |
| **Phase 2 patch** | — | **≤ 2200ms** from webhook | Us |

**Phase 2 hard-cancels at 2500ms.** A late description is worse than none: the resident has already decided.

**Pre-warm.** On `button_press`, fire the snapshot fetch and the model warm-up concurrently, before the agent has finished routing. The two-phase design (§5.2) exists precisely so the slow leg never gates the useful leg.

### 9.2 App performance

Instrument with `@amazon-devices/kepler-performance-api` ✅ V, then profile with the **Amazon Devices Builder Tools MCP** Perfetto tooling ✅ V and **commit the trace and the numbers to the README.** Very few submissions will show a measured app. It is disproportionately persuasive to a Tech Implementation judge.

| Metric | Target |
|---|---|
| Cold launch to first frame | < 2.5s |
| Card render (queue → visible) | < 100ms |
| Skeleton/overlay frame rate | 60fps sustained |
| JS thread blocked | Never > 16ms during playback |

Keep animation on `react-native-reanimated` + `react-native-worklets` ✅ V so card transitions never touch the JS thread while video is playing.

### 9.3 MCP latency

Under 500ms round trip ✅ V — non-negotiable. Every tool is a single `GetItem` over precomputed state. **No model call ever runs inside a tool handler.** If you find yourself wanting one, you have mis-sited the work: precompute it upstream.

---

## 10. SECURITY

### 10.1 Credential map

| Secret | Lives in | Reachable from device? |
|---|---|---|
| Ring OAuth access/refresh | **AgentCore Identity** | Never |
| Bee session | Household bridge only, on-prem | Never |
| Alexa+ LWA credentials | CI secret store / `~/.alexa-ai` | Never |
| Bedrock / AWS | Task roles, no static keys anywhere | Never |
| Device JWT | Device (`kepler-file-system`) | **Yes — and it is scoped to be worthless if stolen** |

### 10.2 Threat model, briefly

| Threat | Control |
|---|---|
| Stolen Fire TV stick | Device JWT grants card receipt + playback posting for one household. No Ring access, no history, no family data. Revoke by `deviceId`. |
| Forged Ring webhook | HMAC-SHA256 verify, constant-time; reject unknown `device_id`; idempotency on `request_id`. |
| Prompt injection via Bee content or a visitor's clothing/signage | Guardian runs **after** every generation, deterministically, on typed classes. A model that is talked into emitting a health fact still cannot get it past the policy table. This is the main reason the Guardian is rules-first. |
| Family over-reach | Policy table + resident exclusions; exclusions can only narrow (§6.2). |
| Data exfil via KB retrieval | Retrieval-time `FactClass` filtering, before the prompt (§8.4). |
| Replay of a card action | Card ids are ULIDs, single-use, server-side `shownCount` and action idempotency. |

### 10.3 `AGENTS.md`

Ship an `AGENTS.md` at the repo root encoding INV-1…INV-7 as rules for any coding agent working in the repo. It is genuinely useful, and it is also visible evidence to a judge that the invariants are enforced rather than aspirational.

---

## 11. OBSERVABILITY

**Correlation id** minted at the Ring webhook (or at the Bee delta, or at the MCP request) and threaded through EventBridge detail, agent context, DynamoDB writes, and the card payload. The TV echoes it back on `card_shown` and `card_action`, which closes the loop **end to end, including the device**. That closed loop is unusual and worth showing.

**Structured logs**, JSON, one line per decision. Every Guardian decision logs `{class, audience, allow, transform, reason}` — **with no content**. The Guardian's audit trail must itself be safe to read.

**Metrics (EMF → CloudWatch):**

| Metric | Why |
|---|---|
| `door.glass_to_glass_ms` (p50/p99) | The product promise |
| `door.phase2_timeout_rate` | Health of the vision leg |
| `card.deferred_queue_depth` | Is the break engine starving? |
| `card.dismissed_without_action` | **The most important product metric** (`WICK.md` §13) |
| `guardian.denials` by class | Is the policy doing anything? |
| `mcp.roundtrip_ms` p99 | Must stay under 500ms |
| `bee.sse_reconnects` | The 120s idle-timeout fight |
| `device.ws_reconnects` | Transport health |

**Alarms** on p99 breaches and on any `guardian.error` — a Guardian that throws must **fail closed**, and the alarm must fire.

---

## 12. TESTING

### 12.1 The real-data tension, resolved

The submission constraint is **no simulated data in the product or the demo**. That is not the same as "no fixtures in tests" — and conflating them produces an untestable system.

| Layer | Rule |
|---|---|
| **Unit / property tests** | Fixtures are correct and expected. Derived from real captured payloads, redacted. |
| **The running product** | Real Ring events, real Bee data, real playback. No mock path may be reachable at runtime. |
| **The demo** | 100% real. Every frame. |

Enforce it: **delete the sample's `ContentPersonalizationMocks` wiring on day one** (§3.3), and add a CI check that no module under `apps/tv-vega/src/**` imports from a path matching `mock`. Say all of this in the README — a judge who sees "mock" in the repo and no explanation will assume the worst.

### 12.2 Natural-Break Engine

The highest-value test suite in the project, because the engine is the Design score and it is entirely deterministic.

Drive a synthetic playback timeline (positions, `creditsPositionMs`, pause/resume, foreground/background) and assert:
- No `DEFERRED` card ever renders in `IN_SCENE`. **INV-5.** Property-based, 10k cases.
- `DOOR` always renders within one tick regardless of state.
- A card ignored twice never returns a third time.
- Queue survives a simulated restart.

### 12.3 Guardian

Property-based, as §6.3. Plus a table-driven suite over the full policy matrix (9 classes × 3 audiences × exclusions). This suite going green on camera is a demo asset.

### 12.4 Prompts

Golden-file tests. Each prompt has a set of real, redacted inputs and an expected-shape output (JSON schema + assertions on constraints: word count, tense, no names, no inference verbs). Models drift; goldens catch it.

### 12.5 Connector contract tests

Recorded real responses (redacted) replayed against the client. Ring in particular has **no sandbox that emits synthetic events on demand** — so record real ones early and keep them. This gap is itself a friction-log entry.

### 12.6 Device testing

Run on the real Fire TV Stick 4K Select, not only the Vega Virtual Device. Keep a manual checklist for what cannot be automated: focus order with a real remote, legibility at 3 metres, contrast on a real panel, audio ducking by ear.

---

## 13. BUILD, DEPLOY, EXTRACT

### 13.1 Infrastructure

**AWS CDK (TypeScript)** — shares the language and the `packages/contracts` types with the services. Stacks: `WickCore` (DDB, Timestream, S3, EventBridge), `WickEdge` (API GW, Lambdas), `WickAgent` (AgentCore, Bedrock, KB), `WickMcp`.

### 13.2 CI

GitHub Actions, path-filtered per service. OIDC to AWS — **no static keys in the repo, and say so in the README.**

```
lint → typecheck → unit → property (guardian, break engine) → build → deploy(dev)
```

Vega app builds via the Vega CLI ✅ V in a separate job; artefact the `.vpkg`.

### 13.3 Environments

`dev` (yours) and `home` (Margaret's, the real one). There is no staging. **The `home` environment carries real personal data about a real person** — treat deployments to it accordingly: no experiments, no debug logging of content, and a tested rollback.

### 13.4 The Open Source extraction

`packages/vega-calm-ui` — MIT. A genuinely reusable accessible-TV component set: large-type high-contrast single-action cards, safe-area-aware positioning, no-startle animation curves, a two-phase card primitive, and an ESLint rule set for `@amazon-devices/eslint-plugin-kepler` ✅ V that flags focus-order mistakes and auto-dismissing surfaces.

Publish it, then open a PR against `AmazonAppDev/react-native-multi-tv-app-sample` adding an accessibility preset theme. **PRs do not need to be merged.** Capture: contribution URL, repo URL, GitHub username, and the what/how/why.

This is downstream of work you must do anyway, which is exactly what makes it a real contribution rather than a hackathon by-product.

---

## 14. THE 72-HOUR SPIKE PLAN

Nothing here is product code. The purpose is to find out what is impossible before committing to it. **Every item is a decision gate with a written answer.**

| # | Spike | Timebox | Decides |
|---|---|---|---|
| **SP-1** | **Can anything render over active playback?** Run a Vega sample, start playback, attempt a lower-third overlay from the app and from a headless service. | 6h | The entire Door Card design. If no → the card waits for foreground, the demo script changes, and you write the headline feature request. **`WICK.md` R1.** |
| **SP-2** | **Ring snapshot latency.** `POST /media/image/download` in a loop against the real doorbell. Record p50/p99. | 2h | §9.1 feasibility. If > 1.5s p99, Phase 1 ships the generic card with no image and patches the image in too. |
| **SP-3** | **Ring WHEP on Vega.** Negotiate a session; render on the TV. Measure setup time and whether sessions are duration-limited. | 6h | M2 (Watch Live). Fallback: short clip via `media/video/download`. |
| **SP-4** | **Alexa+ add-on access.** `alexa-ai configure`, `new mcp`, `deploy` against a stub server behind `cloudflared`. | 4h | **S4, the highest-uncertainty dependency.** Do this before any product code. |
| **SP-5** | **Transport.** `mqtt.js` over WSS inside Vega RN 0.83, including a reconnect cycle. | 4h | §4.1 — IoT Core or API GW WebSocket. |
| **SP-6** | **Bee SSE longevity.** Hold `/v1/stream` open for two hours against the 120s idle timeout. | 2h | Bridge design + a friction-log entry. |
| **SP-7** | **Content Personalization round trip.** Publish one real playback event; confirm it lands in Continue Watching on the device. | 4h | The Rhythm pillar's device-side input. |
| **SP-8** | **Stage One insurance.** Get a Vega sample running on the real Fire TV Stick and **record it.** | 2h | Non-negotiable. Do it first. |

**Also in the first 72 hours, in parallel:**
- Request the **$150 AWS credits** (form closes 21 Oct, 12:00 PT).
- Create the repo with the licence rendering in the About panel.
- Open `FRICTION.md` and write SP-1's result into it, whatever it is.
- **Start real data collection in Margaret's household.** Ring events and Bee capture, running continuously. The Rhythm baseline needs ≥3 weeks and cannot be back-filled.
- Generate the six Alexa+ icon sizes and stand up the privacy/terms pages (§7.3) — they gate `alexa-ai deploy`.

---

## 15. IMPLEMENTATION SEQUENCE

Order is not arbitrary. Each step de-risks the next, and each has a binary exit criterion.

| Step | Build | Exit criterion |
|---|---|---|
| **0** | Spikes SP-1…SP-8; repo, CI, CDK core stack, contracts package | Every spike has a written answer in `FRICTION.md` |
| **1** | **S1 Door Card** — Ring webhook → EventBridge → Door agent → Phase 1 → device | A real doorbell press produces a real card on real hardware in < 3s, measured |
| **2** | **S4 Family Line** — MCP server, add-on deployed, `get_week_narrative` over stub data | A real Echo answers a real question. **Do this second — it is the likeliest surprise.** |
| **3** | **S5 Guardian** — policy engine, egress module, lint rule, property tests | 10k property cases green; a real refusal demonstrable on a real Echo |
| **4** | **S2 Natural-Break Engine** + Content Personalization (real events) | Deferred card provably never appears in `IN_SCENE`, on device |
| **5** | **S6 Rhythm** — Timestream, baselines, deviation floor | A real 3-week baseline produces a true "nothing unusual this week" |
| **6** | **S3 Day Card** — Bee bridge, SSE, fact normalisation, 3-item selection | Real Bee data produces a real card at a real break |
| **7** | **M1 "Just a moment"** | A remote button makes a real Chime speak. *Build this first among the multipliers — it is small and it is the best delight moment in the video.* |
| **8** | **M3 One-Button Reply** | Real note in, real reply out, one button |
| **9** | **M2 Watch Live** | Live doorbell full-screen on the TV, Back restores playback |
| **10** | **M5 Carer Verification** + **M4 Known Visitors** (schedule-based) | Real carer arrival verified from real history |
| **11** | **M6 MCP Apps timeline** | Timeline renders in the Alexa+ conversation |
| **12** | **Film.** Then `tv-fireos`, then Tier 2, in that order | — |

**Gate rule:** no Tier 1 work begins until steps 1–6 run on real hardware with real data. No Tier 2 work begins until the video is **shot**, not merely planned.

---

## 16. OPEN TECHNICAL QUESTIONS

| # | Question | Resolve by | Blocks |
|---|---|---|---|
| **Q1** | Can a Vega app or headless service composite over another app's playback? | SP-1 | Door Card scope; the headline feature request |
| **Q2** | Are Ring WHEP sessions duration- or concurrency-limited? Undocumented. | SP-3 | M2 |
| **Q3** | Does `mqtt.js` work over WSS in Vega's RN 0.83 fork? | SP-5 | §4.1 |
| **Q4** | Does `kepler-file-system` offer any at-rest protection, or is the device JWT plaintext? | Week 1 | §4.2 scoping; feature request L10 |
| **Q5** | Is AgentCore Gateway the right MCP front door, or is a custom Streamable HTTP server simpler given the OAuth 2.1 + PRM requirements? | SP-4 | §7.3 |
| **Q6** | Exact `keplerscript-audio-lib` ducking API and whether the duck applies to another app's audio. | Week 1 | Spoken cards |
| **Q7** | Does the accessibility privilege expose contrast/reduced-motion preferences, or only screen-reader state? | Week 1 | §3.5; feature request L11 |
| **Q8** | Alexa+ certification lead time — does `submit` need to complete before 23 Oct, or does dev-stage deployment suffice for judging? | SP-4 | Submission planning. **Assume dev stage suffices; confirm early.** |

---

## APPENDIX A — Verified Vega identifiers

All ✅ V from `AmazonAppDev/vega-video-sample/manifest.toml` (2026-09-14).

**Runtime module:** `/com.amazon.kepler.runtime.react_native_kepler_4@IReactNativeKepler_0`

**Categories:** `com.amazon.category.main` · `com.amazon.category.kepler.media`

**Services (`[[wants.service]]`):** `com.amazon.tv.developer.dataservice` · `com.amazon.alexa.datastore.service` · `com.amazon.media.server` · `com.amazon.media.playersession.service` · `com.amazon.mediabuffer.service` · `com.amazon.mediametrics.service` · `com.amazon.mediatransform.service` · `com.amazon.audio.stream` · `com.amazon.audio.control` · `com.amazon.audio.system` · `com.amazon.network.service` · `com.amazon.inputd.service` · `com.amazon.inputmethod.service` · `com.amazon.drm.key` · `com.amazon.drm.crypto`

**Privileges:** `com.amazon.tv.content-personalization.privilege.provide-data` · `com.amazon.devconf.privilege.accessibility` · `com.amazon.network.privilege.net-info` · `com.amazon.media.secureplayback` · `com.amazon.kepler.tv.privilege.data_provider`

**Interfaces (`[[extras.value.application.interface]]`):** `com.amazon.kepler.media.IContentPersonalizationServer` · `IMediaPlaybackServer` · `IChannelServer` · `IContentLauncherServer` *(partner-gated)* · `IAccountLoginServer` *(partner-gated)*

**OS module:** `/com.amazon.vega.os@IVega_1_2`

**Headless registration:** `HeadlessEntryPointRegistry.registerHeadlessEntryPoint(id::doTask, fn)` for **tasks**; `registerHeadlessEntryPoint2(id::onStartService | id::onStopService, fn)` for **services**.

**Content Personalization types:** `ContentPersonalizationServer`, `IPlaybackEventsHandler/Provider`, `ICustomerListEntriesHandler/Provider`, `IContentEntitlementsHandler/Provider`, `PlaybackEventBuilder`, `ContentIdBuilder`, `ProfileIdBuilder`, `CustomerListEntryBuilder`, `ContentEntitlementBuilder`, `ContentInteractionBuilder`, `PlaybackState`, `CustomerListType`, `EntitlementType`, `ContentInteractionType`, `ProfileIdNamespaces`. Builder terminates with `.buildActiveEvent()`.

## APPENDIX B — Ring Partner API cheat sheet ✅ V

```
Auth      OAuth 2.0 + PKCE (S256) · access ~4h · refresh ~30d
          POST https://oauth.ring.com/oauth/token
          GET  /v1/users/me
Devices   GET  /v1/devices[?include=status,capabilities,location,configurations]
          GET  /v1/devices/{id}/{status|capabilities|location|configurations}
Live      POST /v1/devices/{id}/media/streaming/whep/sessions   (Content-Type: application/sdp)
          DELETE /v1/devices/{id}/media/streaming/whep/sessions/{sid}
          rtsps://video.rtsp.amazonvision.com:322/v1/devices/{id}/stream
Media     POST /v1/devices/{id}/media/video/download            (MP4)
          POST /v1/devices/{id}/media/image/download            (JPEG/PNG)
Chime     POST /v1/devices/{id}/media/audio/playback            (body: audio_ref)
History   GET  /v1/history/devices/{id}/events
Multi-cam append ?component_id=N
Webhooks  HMAC-SHA256 signed · ACK 200 within 5s · idempotency via request_id
          motion_detected(sub_type) · button_press · device_added/removed
          device_online/offline · app_integration_added/removed
          subscription_activated/deactivated
Limits    100 rps · X-RateLimit-* · Retry-After
CORS      Server-to-server only. Browser and TV origins are blocked.
Absent    two-way audio · siren · lights · locks · event replay · event sandbox
```

## APPENDIX C — Bee cheat sheet ✅ V

```
Setup     bee login   →   bee proxy        (127.0.0.1:8787, or ~/.bee/proxy.sock)
          Only /v1/* forwards. Idle timeout 120s (--idle-timeout).
Endpoints GET  /v1/me
          GET  /v1/changes                  (cursor over changed entity ids)
          GET  /v1/facts            · GET/POST/PUT/DELETE /v1/facts/:id
          GET  /v1/todos            · GET/POST/PUT/DELETE /v1/todos/:id
          GET  /v1/journals[/:id]
          GET  /v1/conversations[/:id]
          GET  /v1/daily[/:id]
          POST /v1/search/conversations        (BM25)
          POST /v1/search/conversations/neural
          GET  /v1/stream                      (SSE, optional event-type filter)
Note      Todos take ISO 8601 in, return epoch millis out.
```

## APPENDIX D — Alexa+ add-on cheat sheet ✅ V

```
Spec      MCP 2025-11-25 · Streamable HTTP (not legacy SSE)
Latency   round trip < 500ms  ← architectural constraint
Auth      401 without WWW-Authenticate when unauthenticated
          PRM at /.well-known/oauth-authorization-server
          code_challenge_methods_supported: ["S256"]
          OAuth 2.1 auth-code + PKCE · resource = canonical server URI
Tools     discovered by introspection AT DEPLOY TIME — redeploy after any change
CLI       alexa-ai configure | new mcp --name --locale --mcp-server-url | deploy | submit
Manifest  addon-package/addon.json
          name.value ≤30 · shortDescription ≤123 · fullDescription ≤4000
          examplePhrases 3–4, ≤200 each · privacyPolicyUrl + termsOfUseUrl (live HTTPS)
          icons.light: 72,64,88,126,180,241 (ALL required) · carousel ≥1 @ 600x900
          integrations[].type = "MCP", config.endpoints.default.uri
Region    US only
Dev       cloudflared tunnel for local MCP server
```

## APPENDIX E — Friction-log seeds (technical)

Verified gaps found while researching this document. **Write each up properly the moment you hit it** — retrospective friction logs read as retrospective, and this is worth up to 10% of the final score.

| Severity | Gap |
|---|---|
| **Critical** | No third-party overlay/ambient surface on Vega (Q1 / L1) |
| **Critical** | No camera, microphone, BLE or presence API on Vega (L2) |
| **Critical** | No documented hardware-backed keystore on Vega (L10 / Q4) |
| Important | No public Ambient Experience / presence API (L3) |
| Important | Content Launcher and Account Login partner-gated with no sandbox (L4) |
| Important | Ring: no two-way audio / siren / light endpoints despite hardware support (L6) |
| Important | Ring: no webhook replay, DLQ, or synthetic-event sandbox → CI is hard (L8) |
| Important | Ring: WHEP session duration/concurrency limits undocumented (Q2) |
| Important | Alexa+ MCP add-on is US-only (L9) |
| Important | No accessibility-preference API on Vega beyond screen-reader state (L11 / Q7) |
| Nice-to-have | Ring `sub_type` taxonomy too coarse (L7) |
| Nice-to-have | Ring blocks browser/TV origins, forcing an extra hop (L5) |
| Nice-to-have | Bee proxy 120s idle timeout fights long-lived SSE (SP-6) |
| Nice-to-have | Amazon Kids/household profiles unavailable to third-party apps (L12) |
| Nice-to-have | Vega samples ship mock data wired into the real service path (§3.3) |

---

*Wick — Technical Implementation Document · Version 1.0 · 14 September 2026*
*Companion to `WICK.md`. Build, Ship, Shape: Amazon Developer Hackathon — Fire TV Track, 1st Place.*
