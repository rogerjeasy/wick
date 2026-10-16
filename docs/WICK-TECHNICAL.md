# WICK — Technical Document

**Companion to `WICK.md` (product definition).** That document says *what* and *why*. This one says *how*, as the system is built today.

| | |
|---|---|
| **Version** | 2.0 — rewritten to match the code |
| **Date** | 14 October 2026 (version 1.0, 14 September 2026, was the plan written before the build) |
| **Hackathon** | Build, Ship, Shape — Fire TV track; AWS Builder and Open Source mini challenges |
| **Deadline** | 23 October 2026, 12:00 PT |
| **Audience** | An engineer reading the repository. Assumes AWS and distributed-systems fluency. |
| **Authority** | Where this document and `WICK.md` disagree on *behaviour*, `WICK.md` wins. Where they disagree on *mechanism*, this one does. Where either disagrees with the code, the code is right and the document is a bug. |

What is simulated in this submission — the televisions, the doorbell, Alexa+ and the household — is set out in the README, [*What is real, and what is simulated*](../README.md#what-is-real-and-what-is-simulated). This document describes the deployed system behind them. Ideas that were planned and not built are collected in [§17](#17-considered-and-not-built), not mixed in with what exists.

---

## 0. How to read this document

### 0.1 Verification markers

API claims about Amazon's platforms carry a marker.

| Marker | Meaning |
|---|---|
| **✅ V** | **Verified** against Amazon documentation, the source of an `AmazonAppDev` sample app, or the running system. |
| **⚠️ C** | **Confirm.** Structurally correct but the exact signature or field was not read. |
| **🔬 S** | **Spike.** Was unknown; §14 says how it was answered. |

### 0.2 The three facts that shaped every decision below

1. **Vega exposes no camera, microphone, Bluetooth or presence sensor to third-party apps.** ✅ V — the dependency manifests of `vega-video-sample`, `vega-sports-app`, `vega-audio-sample`, `vega-tv-interfaces-sample`, `vega-epg-sample`. Consequence: all sensing is off the television. Ring is the eye.
2. **Alexa+ asks for MCP round trips under 500 ms, and the Alexa+ MCP Toolkit is open to select partners only.** ✅ V (add-ons docs home: *"At this time, Category SDK and MCP Toolkit are available to select partners only."*). Consequence: the MCP server is built to the published spec — the weekly narrative is precomputed so no tool waits on a model — and it is exercised through an MCP client and a simulated Alexa+ surface, the alternative the rules permit. Measured against the deployed server, about half of all calls miss 500 ms today (§9.3, GitHub issue #47).
3. **Ring requires a webhook acknowledgement inside 5 seconds and blocks browser-origin requests.** ✅ V — Ring Partner API docs. Consequence: the edge verifies and hands on, nothing more; the television never holds a Ring credential.

### 0.3 Non-negotiable invariants

Enforced by code and by tests. Breaking one is a build break. These are the short forms; [`AGENTS.md`](../AGENTS.md) holds the full text, the accepted exceptions and the files that enforce each one.

| # | Invariant |
|---|---|
| **INV-1** | No Ring or AWS long-lived credential ever resides on the television. It holds one device-bound JWT. A family member's own television holds one token of another kind, good for that one member's view. |
| **INV-2** | Every string a family member is handed passes through the Guardian, at the Wick server where the family reads it: one guarded tool server, guarded family-television routes, and a test that nothing answers the family any other way. `services/agent/src/egress.ts` is the only module that may import a transport client, the push sender or the translation client; a lint rule enforces it. |
| **INV-3** | No Ring video or image is kept beyond one day. Enforced by S3 lifecycle rules, not application code. |
| **INV-4** | Nothing protected (health, money, relationships, location) and nothing verbatim is ever sent to a family surface. Enforced by the Guardian, after generation: a class table no policy can widen, and a deterministic lexicon over free text, held by property tests on the runtime path. A lexicon catches what it lists (§6.5). |
| **INV-5** | Deferred cards are never shown during `IN_SCENE`. The only immediate class is `DOOR`. |
| **INV-6** | Every agent tool call is idempotent and carries a correlation id from ingress to the card and back. |
| **INV-7** | The resident's weekly narrative reaches their television before any family tool can read it. |
| **INV-8** | A request's household comes from a verified token, never from a request body, a URL or an environment variable. |
| **INV-9** | Nobody reads a household before the resident has allowed them, on the television, with one press. Checked on every tool call. |
| **INV-10** | Nothing different leaves the house before the resident says so. Wick asks *"Shall I tell Sarah?"*, and only *"Tell"* makes that one difference readable. |

---

## 1. ARCHITECTURE

### 1.1 Context

```
   Margaret's house                                                Sarah, anywhere
  ┌──────────────┐  MQTT (IoT Core)  ┌──────────────────────────┐  MCP / HTTPS  ┌───────────────────┐
  │ Television   │◀─────────────────▶│ Edge                     │◀────────────▶│ Family app         │
  │ Vega app or  │  or WebSocket     │  API Gateway · IoT Core  │  OAuth 2.1   │ (simulated Alexa+  │
  │ Fire OS build│  (API Gateway)    │  Lambda                  │              │  surface, browser) │
  └──────────────┘                   ├──────────────────────────┤              └───────────────────┘
  ┌──────────────┐  webhook (HMAC)   │ Wick server (App Runner) │  Web Push           ▲
  │ Ring doorbell│──────────────────▶│  MCP · accounts · /api   │─────────────────────┘
  │ (Playground) │◀────── REST ──────├──────────────────────────┤
  └──────────────┘                   │ Agent plane              │
                                     │  Door · Narrator · Tell  │
                                     │  Visit · Reach · Guardian│
                                     │  Lambda + AgentCore      │
                                     ├──────────────────────────┤
                                     │ Memory plane             │
                                     │  DynamoDB · S3 · Secrets │
                                     └──────────────────────────┘
```

Rendered diagrams are in [`docs/architecture/`](architecture/).

**Four planes, and the boundaries are load-bearing:**

| Plane | Responsibility | Explicitly NOT responsible for |
|---|---|---|
| **Device** | Render cards, play films, report playback state, turn D-pad presses into events | Any decision about *what* to show. Any credential. Any inference. The one decision it does make is *when*: the Natural-Break Engine (§3.4) runs on the television because only the player knows where the film is. |
| **Edge** | Terminate Ring webhooks, the device channels, MCP. Authentication, authorisation. Sub-5 s acknowledgement. Answer the television that just spoke. | Model calls. Anything bound for the family. |
| **Agent** | All reasoning and every outbound card: the door's description, the week, "Shall I tell…?", the visit question, the request to be rung. | Transport details, which live in `egress.ts`. |
| **Memory** | Timeline, rhythm counts, weeks, cards, memberships, policy state | Interpretation |

**The rule that keeps this clean:** if you find yourself writing an `if` about *whether* to show something in the TV app, it belongs in the agent plane.

### 1.2 Why the thinking is off-device

1. **INV-1.** A £30 stick in a stranger's front room is not a credential store. Vega documents no hardware-backed keystore (L10 in `WICK.md`).
2. **The agent must run when the TV is off.** Vega headless services run only while the app package is alive; they are not a 24/7 process.
3. **Iteration speed.** Changing a prompt should not require a device deploy.

### 1.3 Runtime topology, as deployed

Everything below is in `infra/*.tf` and runs in one AWS account, `us-east-1`.

| Component | Service | Where |
|---|---|---|
| Ring webhook, Ring link and token exchange, hourly token refresh | API Gateway HTTP API → Lambda; EventBridge rule `rate(1 hour)` | `infra/edge.tf` |
| Event bus | EventBridge custom bus `wick` | `infra/core.tf` |
| Door agent, phase 1 and 2 | Lambda `wick-agent-door-event` on the bus | `infra/agent.tf` |
| Door description, hallway chime, live view | Strands graphs in one **Bedrock AgentCore Runtime** container; session = household | `infra/agentcore.tf` |
| Live view bridge (Ring WHEP → HLS) | Lambda from a container image (WebRTC needs outbound UDP, which the AgentCore microVM lacks — FL-017); segments in S3 behind CloudFront | `infra/live.tf` |
| Card presses, "Ask … to look", "Shall I tell…?", the visit, hold for Sarah | Lambda `wick-agent-card-action` on bus rules | `infra/card-action.tf`, `infra/reach.tf` |
| The three-minute wait in hold for Sarah | **EventBridge Scheduler**, a one-time schedule that deletes itself | `infra/reach.tf` |
| Weekly narrative | Lambda `wick-agent-narrator-weekly`, EventBridge schedule `cron(0 20 ? * SUN *)` (Sunday 20:00 UTC) | `infra/narrator.tf` |
| Television channel, option A | **AWS IoT Core**, MQTT over WSS, custom authorizer on the device token, two topic rules | `infra/iot.tf` |
| Television channel, option B | API Gateway WebSocket API → Lambda | `infra/transport.tf` |
| Pairing | API Gateway → Lambda (start, claim, status, refresh); RS256 signing key in Secrets Manager | `infra/pairing.tf` |
| The Wick server: MCP endpoint, OAuth authorization server, family app's `/api`, the assistant | **App Runner**, one container (1 vCPU, 2 GB) | `infra/mcp.tf` |
| Family members' accounts | **Amazon Cognito** user pool | `infra/accounts.tf` |
| Family app, television in a browser tab, films | S3 + **CloudFront** (Origin Access Control, HTTPS only) | `infra/sim-alexa.tf`, `infra/ops-console.tf`, `infra/programmes.tf` |
| Notifications to a family member's browser | Web Push (VAPID), key pair in Secrets Manager | `infra/push.tf` |
| Pictures for the mantelpiece | S3 bucket of its own, lifecycle by object tag; **Amazon Rekognition** moderation before sending | `infra/photos.tf` |
| Cards read aloud | **Amazon Polly**, readings cached one day under `tts/` | `infra/speech.tf` |
| A spoken question in the family app | **Amazon Transcribe** streaming, from the Wick server | `infra/mcp.tf` |
| Free text into the resident's language | **Amazon Translate**, from `egress.ts` | `infra/agent.tf`, `infra/card-action.tf` |
| Timeline, rhythm, weeks, cards, accounts | **DynamoDB**, one table `wick` | `infra/core.tf` |
| Ring imagery, live segments, readings | S3 media bucket, one-day lifecycle on `snapshots/`, `live/`, `tts/` | `infra/core.tf` |
| Ring tokens | **Secrets Manager**, one secret per household, `wick/ring/tokens/<householdId>` | `infra/core.tf` |
| Ops dashboard | Lambda `wick-status` behind the edge API | `infra/status.tf` |
| CI to AWS | GitHub OIDC provider and a deploy role; no static keys | `infra/github-oidc.tf` |

Counted from the Terraform: 22 Lambda functions, 1 AgentCore runtime, 1 App Runner service, 1 DynamoDB table, 5 S3 buckets, 4 CloudFront distributions, 4 Secrets Manager secrets, 2 API Gateway APIs, 1 IoT authorizer, 8 EventBridge rules and 1 Scheduler group.

### 1.4 The agents

Each is a folder under `services/agent/src/agents/`, with narrow inputs and its own tests. Only two jobs call a model.

| Agent | Trigger | What it does | Model |
|---|---|---|---|
| **Door** (`door/`) | `wick.ring` event on the bus; or the Wick server's stand-in ring for a demo home | Phase 1 card; Phase 2 picture and one sentence; roster match by schedule; "Ask … to look"; the hallway chime and live view through AgentCore graphs | **Amazon Nova Lite** (`amazon.nova-lite-v1:0`) describes the frame, inside a Strands Agent |
| **Narrator** (`narrator/`) | Weekly schedule, for every household with a paired television | Counts the week deterministically, compares it with the household's own baseline, has the model write prose from those numbers | **Claude Sonnet 4.5** (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`, a cross-region inference profile) |
| **Tell** (`tell/`) | A difference found in the rhythm (`rhythm/different.ts`) | Asks the resident "Shall I tell …?"; only "Tell" writes the `TELL#` row the family's tool reads (INV-10) | none |
| **Visit** (`visit/`) | Door sightings of a regular visitor | Opens a visit, asks "Is this right?" at a natural break; only her "Yes" confirms it | none |
| **Reach** (`reach/`) | Her press on "Ask Sarah to ring you?" | Asks one person; three minutes later, if nobody answered, the next; a neighbour last | none |
| **Guardian** (`services/policy`, run by the Wick server: `services/mcp-server/src/guardian.ts`) | Synchronously, on every answer to the family | Allows or withholds, by class and by content; see §6 | none — rules only |

The family app's assistant is not an agent of the house: it runs in the Wick server (`services/mcp-server/src/assistant`) and uses **Claude Sonnet 4.5** on Bedrock to choose which of the family's tools to call for a question. It never sees anything the tool did not return.

---

## 2. REPOSITORY LAYOUT

Public, MIT, licence detected in GitHub's About panel.

```
wick/
├── LICENSE                      # MIT
├── README.md                    # landing page
├── AGENTS.md                    # the invariants contract
├── FRICTION.md                  # friction log, written as it happened
├── docs/
│   ├── WICK.md                  # product definition
│   ├── WICK-TECHNICAL.md        # this file
│   ├── SETUP.md                 # running and deploying it
│   ├── architecture/            # diagrams
│   ├── screenshots/             # from live checks
│   ├── calm-points/             # the published calm-point map
│   └── demo-door/               # the stand-in doorbell's pictures and their notice
│
├── apps/
│   ├── tv-vega/                 # the Vega OS application (React Native for Vega)
│   ├── tv-fireos/               # the same source on Fire OS, through four adapters
│   ├── sim-alexa/               # the family app — a simulated Alexa+ surface, a client of the real MCP server
│   └── ops-console/             # a television in a browser tab, and a status page
│
├── services/
│   ├── edge-ring/               # Ring webhook, link, token, refresh, status (Lambda)
│   ├── edge-device/             # pairing, both device channels, presses (Lambda)
│   ├── mcp-server/              # the Wick server: MCP, OAuth, accounts, /api, assistant (App Runner)
│   ├── agent/                   # agents, Strands graphs, live bridge, egress.ts (Lambda + AgentCore)
│   ├── connectors/ring/         # Ring Partner API client
│   └── policy/                  # the Guardian — pure, AWS-free, property-tested
│
├── packages/
│   ├── contracts/               # shared types, the phrasebook, key prefixes
│   └── vega-calm-ui/            # the open-source extraction (§13.4)
│
├── infra/                       # Terraform (one root, S3 state)
├── addon-package/               # Alexa+ add-on manifest and assets
├── scripts/                     # build, check and operator scripts
└── .github/workflows/           # ci, deploy-edge, deploy-agent, tv-fireos
```

**One deliberate choice:** `services/policy` is a standalone package with no AWS dependencies. It is pure functions over typed inputs, so it is exhaustively testable.

---

## 3. THE TELEVISION

### 3.1 Vega component model

Vega's `manifest.toml` declares components of three kinds — `interactive`, `service`, `task` — each bound to a runtime module. ✅ V (`vega-video-sample/manifest.toml`)

The real manifest is [`apps/tv-vega/manifest.toml`](../apps/tv-vega/manifest.toml). It declares:

| Component | Kind | Purpose |
|---|---|---|
| `com.wick.tv.main` | `interactive` | Cards, player, every screen |
| `com.wick.tv.card.service` | `service` | Keeps a background connection while another app is in front, and posts a system toast for a door card (FL-022, FL-026). The app starts it by its `pkg://` address. |
| `com.wick.tv.content.dataRefresh.provider` | `service` | Serves Watch Activity to the platform (§3.3) |
| `com.wick.tv.rhythmSyncTask` | `task` | Batch upload of local playback events |
| `com.wick.tv.onInstallTask` | `task` | First-run pairing state |

Two interfaces are provided on `com.wick.tv.main`:

- `IContentPersonalizationServer`, with `DataRefreshComponentId = "com.wick.tv.content.dataRefresh.provider"`.
- `IMediaPlaybackServer`, with `command_options = ["StartOver", "SkipForward", "SkipBackward"]`. Play, Pause, Play/Pause and Stop are the platform's core commands and arrive without being named. There is no Next or Previous, because there is no playlist.

> **Not declared:** `IContentLauncherServer` and `IAccountLoginServer`. Both are select-partner gated (`WICK.md` L4). Declaring what cannot be exercised is worse than omitting it.

The manifest needs an icon file that exists: `vpt validate` treats a missing icon as a warning, `vpm install` rejects the package without saying why (FL-011; fixed with `assets/image/Wick.png`).

### 3.2 Headless registration

Tasks and services register through `HeadlessEntryPointRegistry`, with entry-point names of the form `<component-id>::<hook>`. ✅ V — `apps/tv-vega/task.js` and `service.js` do exactly this:

```js
// task.js
HeadlessEntryPointRegistry.registerHeadlessEntryPoint(
  'com.wick.tv.rhythmSyncTask::doTask', () => doRhythmSync);
HeadlessEntryPointRegistry.registerHeadlessEntryPoint(
  'com.wick.tv.onInstallTask::doTask', () => doOnInstall);

// service.js — registerHeadlessEntryPoint2 for SERVICES (not tasks)
HeadlessEntryPointRegistry.registerHeadlessEntryPoint2(
  'com.wick.tv.card.service::onStartService', () => onStartCardService);
HeadlessEntryPointRegistry.registerHeadlessEntryPoint2(
  'com.wick.tv.card.service::onStopService',  () => onStopCardService);
HeadlessEntryPointRegistry.registerHeadlessEntryPoint2(
  'com.wick.tv.content.dataRefresh.provider::onStartService', () => onStartDataRefresh);
HeadlessEntryPointRegistry.registerHeadlessEntryPoint2(
  'com.wick.tv.content.dataRefresh.provider::onStopService',  () => onStopDataRefresh);
```

Offering a service in the manifest starts nothing (FL-014). The app starts the card service itself (`src/headless/launchCardService.ts`), and the app and its service share no storage on the Vega simulator (FL-013), which is why the service learns its token through `POST /pair/refresh` (an accepted exception, `AGENTS.md` INV-1).

### 3.3 Content Personalization

The platform invokes Wick's handlers, Wick pushes chunks into a provider, then `commit()`. ✅ V (`src/headless/DataRefreshService.ts`)

`IPlaybackEvent` is built with `PlaybackEventBuilder`, carrying `contentId`, `profileId`, `playbackState`, `playbackPositionMs`, `durationMs`, **`creditsPositionMs`**, `eventTimestamp`. `creditsPositionMs` is the platform's own model of "the episode is ending", which is the `AT_BREAK` signal the Natural-Break Engine needs.

The Vega sample ships `ContentPersonalizationMocks.ts` wired into its data service. Wick does not: `npm run check:no-mocks` fails the build if Vega runtime code imports anything matching `/mock/i`. Whether the events reach Continue Watching on a device was not checked (SP-7, §14).

### 3.4 The Natural-Break Engine

The product's defining behaviour, entirely deterministic, with no model anywhere in it (`apps/tv-vega/src/break/NaturalBreakEngine.ts`).

**States**, from the player and the programme's metadata:

| State | Condition | Deferred cards? |
|---|---|---|
| `IN_SCENE` | playing, more than 30 s before `creditsPositionMs`, and not at a calm point | **No** |
| `NEAR_BREAK` | playing, within 30 s of `creditsPositionMs` | No |
| `AT_BREAK` | within 8 s after one of the programme's calm points; or paused for more than 5 s; or at or past the credits; or the content ended | **Yes** |
| `TV_SETTLED` | Wick in front for 20 s or more with nothing playing | **Yes** |
| `IDLE` | Wick not in front | No — the queue persists |

**Release rules:**

1. `DOOR` shows at once, in any state. It never pauses the film and never plays a sound.
2. `DEFERRED` shows only in `AT_BREAK` or `TV_SETTLED` (INV-5, property-tested).
3. A deferred card shown in the middle of a programme — at a calm point, or in a pause — **holds the programme on the cut** and lets it go on when the card is answered (`holdsProgramme`). At the credits nothing is held: the story is over.
4. A card ignored is shown again at a later break; the server counts showings, and after the second it waits in a row on the home screen instead of returning.

**Calm points** are measured, never guessed. `scripts/calm-points` runs **Amazon Rekognition** segment detection (shots, fades, end credits) and ffmpeg's silence detection over the published encode of each film, and keeps a cut that falls in a quiet stretch. `npm run calm:build` writes `apps/tv-vega/src/catalog/calmPoints.ts` from those measurements; nobody edits it by hand. Each calm point's before-and-after frames are described for the public map by Nova Lite (`npm run calm:describe`); that sentence is for the page, and plays no part in choosing the point. The map: <https://rogerjeasy.github.io/wick/calm-points/>.

**Media controls.** On Vega the film is a media session (`kepler-media-controls`, `src/watch/mediaControls.ts`), so the system's transport controls and "Alexa, pause" reach it. Each command obeys the rule the same remote key obeys (`src/watch/mediaSession.ts`): a pause is a pause, and so a break; Play over a held note carries on with the film; Stop is a pause. On the Vega simulator the system's Stop reached the session and became a break; a spoken command could not be tried there, because the simulator takes no voice (FL-031). Fire OS has no media session yet.

### 3.5 Cards and accessibility

Every resident card obeys the same floor, enforced at render by `packages/vega-calm-ui` and by four ESLint rules run over `apps/tv-vega/src`:

| Constraint | Value | Enforced by |
|---|---|---|
| Minimum type | 32 pt | `CalmCard` throws below it; `min-font-size` |
| Contrast | ≥ 7:1 | `CalmCard`, tests |
| Actions per card | ≤ 3 | `CalmCard`; `max-actions` |
| Colour | No alarm red | `no-alarm-colour` |
| Auto-dismiss | Never | `no-auto-dismiss` |
| Reachability | D-pad + OK only; no text entry | Design rule; every flow |
| Settle time | A card takes no press for one second after it appears | `src/press/settle.ts` |

**Read to me.** While a card is on screen, the Play key asks for it to be read aloud in her language: its sentences, then what she can press. The voice is **Amazon Polly**'s, made at the edge when she asks (`services/edge-device/lambda/speech.mjs`), kept a day so the same card is made once, and answered only to the television that asked. A card never reads itself.

**Her language.** The organiser can ask for Spanish from the family app; only her press on a card that asks in both languages sets it. Wick's own sentences come from a hand-written phrasebook (`packages/contracts/src/phrasebook`), held to the English builders by tests; only free text — a family note, the door's sentence, the week's paragraph — is machine-translated by **Amazon Translate**, in `egress.ts`, and never stored in the card.

### 3.6 Player

`@amazon-devices/react-native-w3cmedia` plays HLS. ✅ V Owning playback is what makes §3.4 possible. The films are the Blender Foundation's open films (Big Buck Bunny, Sintel, Tears of Steel, CC BY 3.0), transcoded to HLS by `scripts/publish-programmes.sh` and served from CloudFront over HTTPS — the Vega player drops cleartext HLS silently (FL-016).

**Watch together.** A family member invites the resident to one of these films at a time. After her press on *"Start the film"*, her player reports where it is (`src/watch/togetherReporter.ts`), the edge keeps only positions that match the session (`watch-together.mjs`), and only the person who sent the invitation can read them back (`mcp-server/src/tools/watchSession.ts`). Their player — in the family app or on their own television — follows hers, with no pause and no skip.

### 3.7 The Fire OS build

`apps/tv-fireos` has no screens of its own. It bundles `apps/tv-vega/src` and gives it Android in place of four Amazon packages (`react-native-kepler` → `react-native-tvos`; `react-native-w3cmedia` → ExoPlayer through `react-native-video`; `kepler-file-system` → key-value storage; `kepler-media-controls` → nothing yet). Amazon publishes no Fire OS emulator; it runs on the **Android TV emulator** (API 34), the alternative the hackathon FAQ names. It has no background service, so no toast over another app. See [`apps/tv-fireos/README.md`](../apps/tv-fireos/README.md) for what has and has not been seen on the emulator.

### 3.8 Other televisions

- **A television in a browser tab** (`apps/ops-console/device.html`) pairs with the same code and is sent the same cards over the same WebSocket. It exists so a judge with no Fire TV and no simulator can try Wick.
- **A family member's own television** ("Sarah's television", `apps/tv-vega/src/family`) is the same app connected by a member as *Mine*. Its row is `FTV#`, never `DEV#`, and its token reaches only the Wick server's `/tv/*` routes for that member's view (`AGENTS.md` INV-1).

---

## 4. DEVICE ↔ CLOUD

### 4.1 Transport — both, decided 2026-10-11

A television tries **A** and falls back to **B** (`apps/tv-vega/src/transport/createDeviceChannel.ts`).

- **A — AWS IoT Core, MQTT over WSS** (`infra/iot.tf`). A custom authorizer checks the television's own device token and returns a policy naming its own three topics and nothing else. The token travels in the address, not the MQTT password (FL-024). Two topic rules: presence, and events, which end at the same handler as the WebSocket's (`device-event.mjs`). A reconnect keeps its IoT session id, so a disconnect is matched to its connection by the event's version number (FL-009, update).
- **B — API Gateway WebSocket** (`infra/transport.tf`). The fallback, and the only channel the background card service uses.

`egress.ts` sends down whichever channel the television's own row names. Run on 2026-10-11 on the Vega simulator and the Android TV emulator: connected over A, cards down and replies up, and with A refused it was on B. Not run: hours, a network drop, hardware.

The reasoning that led there: IoT Core gives per-device identity and policy at the transport, and B is a smaller correct answer with zero library risk. Spike SP-5 showed `mqtt.js` over WSS works inside Vega's React Native, so both were kept.

```ts
interface DeviceChannel {
  connect(token: DeviceToken): Promise<void>;
  onCard(handler: (c: QueuedCard) => void): Unsubscribe;
  onControl(handler: (m: ControlMessage) => void): Unsubscribe;
  send(e: DeviceEvent): Promise<void>;          // playback state, card actions, acks
  readonly state: 'connecting' | 'open' | 'backoff' | 'closed';
}
```

On open, the television asks for the cards it is owed, and the edge answers that one television on the channel the request came in on.

### 4.2 Pairing (INV-1, INV-8, INV-9)

1. The television shows a 6-digit code and a link. The code lives 15 minutes and is single use (`pairing-code.mjs`).
2. The household's organiser, signed in to the family app, enters it. The Wick server calls `POST /pair/claim` with the organiser's own token; `pair-claim.mjs` checks it against the grant the server stored, so the two services share no secret.
3. The edge binds `deviceId ↔ householdId` and mints a device-bound **RS256** JWT, valid 30 days, signed with a key in Secrets Manager.
4. The token is stored with `kepler-file-system`. The Vega simulator keeps nothing on disk (FL-013), so on the simulator the app re-proves itself through `POST /pair/refresh`, which mints a one-hour token from the device id alone — an accepted exception, bounded by TTL and cooldown (`AGENTS.md` INV-1).
5. The first thing the paired television shows is the Circle card: the resident allows, or does not allow, each person who asked (INV-9).
6. Revocation: a disconnected television's row is marked, and every connect checks it.

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

The exact shapes are in `packages/contracts/src/device.ts`. A press reaches the bus as `wick.device / card.action`; the agent plane decides what it means.

---

## 5. THE AGENT PLANE

### 5.1 Graphs and models

```
  Ring webhook ─▶ EventBridge "wick" ─▶ door-event Lambda ─┬─ Phase 1 card ──────────┐
  Wick server (demo home stand-in ring) ──────────────────▶│                         │
                                                           └─ AgentCore: door.describe│
  TV press ─▶ edge ─▶ EventBridge ─▶ card-action Lambda ─┬─ AgentCore: door.action   ├─▶ GUARDIAN ─▶ egress.ts
                                                         ├─ tell / visit / reach     │                ├─▶ MQTT or WebSocket (TV)
                                                         └─ Scheduler (reach.due)    │                ├─▶ Web Push (family browser)
  Sunday schedule ─▶ narrator-weekly Lambda ─────────────────────────────────────────┘                └─▶ DynamoDB rows the family's tools read
```

AgentCore Runtime runs one container with four Strands graphs (`services/agent/src/graphs`):

| Graph | Nodes | Model |
|---|---|---|
| `door.describe` | vision Agent → validate | Nova Lite |
| `door.action` | gate → ring → notify | none — no model decides to make a sound in someone's home |
| `live.start` | gate → start bridge | none |
| `live.stop` | stop | none |

The session id is the household (`runtime/invoke.ts`), so each household's graphs run in their own microVM.

**Model selection:**

| Job | Model | Why |
|---|---|---|
| Door frame → one sentence | **Amazon Nova Lite** (`amazon.nova-lite-v1:0`) | Latency-critical and cheap. The task is description, not reasoning. |
| Weekly narrative | **Claude Sonnet 4.5** (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`) | Prose quality is the product. Runs once a week, offline. |
| Family app: which tool answers this question | **Claude Sonnet 4.5** (same id, `mcp-server/src/assistant/bedrock.ts`) | Tool choice over twenty-two tools; it only ever words what a tool returned. |
| Calm-point frame descriptions for the public map | Nova Lite | Offline, once per film. |
| Guardian | none | Rules only. |

Both model ids can be overridden by environment (`WICK_VISION_MODEL`, `WICK_NARRATIVE_MODEL`, `WICK_ASSISTANT_MODEL_ID`).

### 5.2 Door agent

**Two-phase emission.** A card that waits for vision is a slow card. So:

```
Phase 1 ─▶ DoorCard{ "Someone's at the front door.", actions }           — at once, no picture
Phase 2 ─▶ CardPatch{ picture }  then  CardPatch{ description }            — as each is ready
```

Phase 1 has no picture because Ring has no live-capture call: `media/image/download` fetches a *recorded* frame and took 3.15 s end to end when measured (SP-2, FL-005). The description is cancelled at **2.5 s** (`DESCRIBE_TIMEOUT_MS`, `door/describe.ts`): a description that arrives after that is worse than none, and the card stays as it was. Time from press to card on a television has not been measured end to end.

**Description constraints**, in the prompt and in an output validator (`judgeDescribeReply`): present tense, one sentence, short; observable facts only; never a name unless matched from the household's own roster; on low confidence, nothing.

**Roster matching** is schedule-based, not biometric (`door/roster.ts`): "Maria usually comes Tuesdays at nine". No face is ever matched.

**The buttons.** *Watch live* (a door card under five minutes old) starts the live bridge: Ring WHEP → werift → ffmpeg → one-second HLS segments in S3 → CloudFront → the television's own player. *Ring the hallway chime* (M1) calls Ring's `media/audio/playback` on a Chime — built and contract-tested for every outcome, but Ring's Playground has no chime, so it is not in the demo and its button is drawn only when a household has one (FL-019). *Ask … to look* writes a `LOOK#` row for the family's tools and nudges their browser by Web Push; the nudge carries a kind and no words.

**The stand-in doorbell.** Ring's Playground sends no doorbell or motion webhook (FL-027). A member of a demo home can ring a stand-in from the family app (`POST /api/demo/doorbell`). Only the Wick server's role may invoke the Door agent with that source (`wick.demo-door`); the agent checks again that the home is a demo home and runs its own path with Ring's parts stood in (`door/demoDoor.ts`): one of four pictures made with an image model, of nobody real ([`docs/demo-door/NOTICE.md`](demo-door/NOTICE.md)), and a sentence from the vision model. Every row it writes carries `simulated`; the card says *stand-in doorbell* and offers no live view.

### 5.3 (removed)

The Day agent chose up to three things from a wearable's record of the day. Wick has no such data source, so the agent and its card were removed. The section number is kept so references to §5.4 and §5.5 still hold.

### 5.4 Narrator — and why it is precomputed

Alexa+ asks for MCP round trips under 500 ms, so a week's narrative cannot be generated inside a tool call. Therefore:

- An EventBridge schedule runs `wick-agent-narrator-weekly` on Sundays at 20:00 UTC, for every household with a paired television (`narrator/everyHousehold.ts`).
- It reads the week's timeline and the household's `RHYTHM#` counts, computes the comparisons deterministically (`comparisons.ts`, `weekFacts.ts`), and gives *numbers and facts* to Claude Sonnet 4.5 to write prose (`prose.ts`). **The model never counts.**
- The week is written to the resident's television first. `NARR#<isoWeek>.residentSeenAt` is set only by her press on the week card (`edge-device route.mjs`), and the family's tool reads nothing until it is set (INV-7).
- `get_week_narrative` does one DynamoDB `GetItem`.

A demo home's six weeks are written by `mcp-server/src/accounts/demoHome.ts` as the Door agent's own event rows and counted by the Narrator's own code; every such row, week and household is marked `simulated`.

### 5.5 Prompts

The prompts that run are constants beside the code that calls them: `DESCRIBE_SYSTEM_PROMPT` in `door/describe.ts`, the narrative brief in `narrator/prose.ts`. Each model reply passes a validator before it is used. `services/agent/prompts/` holds the early briefs those were written from; it is not loaded at run time, and `day-select.md` belongs to the removed Day agent.

### 5.6 Something's Different, and "Shall I tell Sarah?"

`rhythm/different.ts` looks for three things against the household's own last six weeks: a regular visitor who did not come on one of their days; somebody at the door in the night in a house where nobody comes at night; a day at the door unlike the same weekday by this hour. Nothing is called different from fewer than three observed weeks. Pure code, no model.

A difference is never sent to the family. `agents/tell/ask.ts` puts the very sentence on the resident's television — *"Shall I tell Sarah?"* — and only her *"Tell"* writes `TELL#<differenceId>`, which is all `get_whats_different` reads (INV-10).

### 5.7 The visit, witnessed

The door's first sighting of a regular visitor opens a `VISIT#` row; the last sighting before she is asked is taken as the leaving. At a natural break the television asks *"Is this right? Maria was here on Tuesday from 9:02 am to 9:47 am."* Only her *"Yes"* confirms it. To the family, unasked, waiting and disputed look the same (`get_visits`). Ring's Playground sends no motion events, so the two sightings in a test come from a signed stand-in, `scripts/visit-sighting.sh` (FL-027).

### 5.8 Hold for Sarah

OK held two seconds brings *"Ask Sarah to ring you?"* (`edge-device reach.mjs`). Her press is the consent. `agents/reach/ask.ts` writes `REACH#<id>`, puts a card on her television and nudges one person. `timer.ts` creates a one-time **EventBridge Scheduler** schedule three minutes on, carrying the request and the step, never a name, and set to delete itself after it runs. When it fires, `due.ts` reads the circle again and asks the next person, a neighbour last. Wick calls nobody and sounds nothing.

### 5.9 egress.ts

`services/agent/src/egress.ts` is the single exit (INV-2): `sendToDevice` (MQTT through the IoT data plane, or the WebSocket management API), `nudgeFamily` (Web Push, a kind and no words), and the Amazon Translate call for free text into her language. Nothing in it sends words to the family: the family reads, through the Wick server, behind the Guardian (§6.3). A lint rule (`no-restricted-imports`) keeps those clients out of every other module.

### 5.10 Prompt-free features

The light in the window, watch together, the mantelpiece, waves from a family member's television and read-to-me involve no model at all. They are edge handlers in `services/edge-device/lambda/` and Wick-server routes, with rules in `packages/contracts` and in `AGENTS.md`'s data rules.

---

## 6. THE GUARDIAN

The most important component in the system and the one most likely to be under-built. It is what makes the product's central claim defensible rather than rhetorical.

### 6.1 Shape

A pure package, `services/policy` — no AWS imports, no network, no model. Two functions, one built on the other.

`evaluate` decides by class: may this kind of fact reach this audience, under this household's policy?

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

`clearForFamily` decides by content: which class is this sentence about, and may the family read it?

```ts
function clearForFamily(text: string, policy?: HouseholdPolicy):
  | { cleared: true; text: string }
  | { cleared: false; classes: FactClass[] };   // never sent: for the log
```

It reads the string with a hand-written lexicon (`services/policy/src/lexicon.ts`): clinical roles and places, treatment and medication, illness and the body ("Dr Patel", "medication box", "her hip"); money, benefits, banks and amounts ("pension", "£40"); partners, marriage and estrangement; street addresses, postcodes and coordinates. Every class it finds is put to `evaluate` for the FAMILY audience. All four are in `NEVER_TO_FAMILY`, which no policy can widen, so the household's policy cannot change the answer. Before reading, the text is folded to plain lower-case letters — accents off, full-width forms folded, typographic quotes straightened — and a string that still holds something the lexicon cannot read (another script, a look-alike letter, an invisible character, an emoji) is not cleared. Fail closed.

`VERBATIM` has no entry in the lexicon. Her own words never become text: her television has no microphone, and her replies are keys to sentences Wick wrote. The class is refused by `evaluate`.

Whether a whole class is shown to the family at all — the weekly narrative, who visits by name — is asked of `evaluate` too (`isSharedWithFamily`, `services/agent/src/store/household.ts`), so the class check and the content check are one decision function.

### 6.2 The default policy table

| Class | RESIDENT | FAMILY | AGENCY |
|---|---|---|---|
| `DOOR_EVENT` | allow | allow | own visits only |
| `PRESENCE` (arrived/left) | allow | allow | own visits only |
| `RHYTHM` | allow | **summarise** (narrative only, never raw logs) | deny |
| `COMMITMENT` | allow | **summarise** | deny |
| `HEALTH` | allow | **deny — always** | deny |
| `FINANCIAL` | allow | **deny — always** | deny |
| `RELATIONSHIP` | allow | **deny — always** | deny |
| `LOCATION` | allow | **deny — always** | deny |
| `VERBATIM` | allow | **deny — always, unconditionally** | deny |

A family opt-in (`familyPermitted`) may widen a class, but never one in `NEVER_TO_FAMILY`. Resident exclusions are applied **after** the table and can only ever narrow. There is no path by which an exclusion widens access.

"Summarise" is kept by what the family is given of those classes: the week's narrative and its counts, never the rows they were counted from. No code transforms a string to summarise it.

### 6.3 Enforcement

The family is never sent words: they read. So the gate stands where they read, on the Wick server.

- **Every MCP tool.** All of them are registered on the one server `server.ts` makes, through `guardTools` (`services/mcp-server/src/guardian.ts`). Each tool's answer — whatever helper built it, a sentence or structured data — is read string by string before it leaves. Ids and picture addresses are not read as words; an id made from a name is. The SDK's older `tool()` is refused, so it is not a way round.
- **Every route of a family member's own television** (`/tv/home`, `/tv/press`, `/tv/seat`, `/tv/waiting`) answers through `guardTelevision`.
- **The family app's assistant** says only what the tools returned, and its own reply is read in `checkReply` (`assistant/brain.ts`): one it cannot clear is asked for again, then replaced by the tools' own sentences.
- **Field rules, so that holding back says nothing** (the reasoning of INV-10). The door's sentence the gate cannot clear is left out, as when the vision model was unsure (`get_door_request.ts`). A week's paragraph, timeline entry or comparison it cannot clear is dropped and the week told from its counts, as when the Narrator's model failed (`get_week_narrative.ts familyWeek`). A visitor's name it cannot clear is refused when it is typed (`add_regular_visitor.ts`). A note's words go back only to the person who wrote them (`sentBy` on the note's row, never on the card); everyone else is given null for every note of somebody else's, whatever it says (`get_replies.ts`).
- **Anything else is not sent.** An answer that still holds a string the gate cannot clear is replaced by the sentence any failed answer gets, and `guardian_withheld` is logged with where and which classes — never the words.
- **Tests.** `guardian.test.ts` holds that every tool the family is offered is behind the gate, that there is one MCP server in the source and it is made behind it, and that only the guarded endpoints serve `/tv/`. Property tests (`fast-check`) put every phrase the lexicon lists — in any case, with accents, in full-width letters, anywhere in a string — through the real tool server, a family television's home and waiting routes, and the assistant, and find it in nothing the family is handed (`services/mcp-server/src/__tests__/guardian.property.test.ts`). Over the reading itself: 10,000 cases that no such string is ever cleared under any policy (`services/policy/src/__tests__/guardian.property.test.ts`), and 10,000 that `evaluate` never lets a `NEVER_TO_FAMILY` class reach the family under any policy (`evaluate.property.test.ts`). CI runs them as their own job.
- **One egress module** (`services/agent/egress.ts`) is the only importer of a transport client, by a lint rule. Nothing it sends carries words to the family: a push nudge carries a kind and no string.

The resident's own television is not gated. Everything on it is about her, and she sees it as it was written.

### 6.4 Refusal is a feature

When a whole class is kept — the resident chose it on "What Sarah sees", which the family can always ask about — the family surface says so plainly and warmly:

> *"That's something Margaret's keeping to herself. I'm not able to share it."*

Never a generic error. Never silence — silence is indistinguishable from "nothing happened", which is a lie. **Film this.** Ten seconds of Alexa declining is one of the most memorable things in the submission.

The content gate is the other way round. What it holds back is a sentence, not a choice she made, and saying "something was held back from the door's description" would tell the family the sentence was about her health. So it is held back in a shape that already happens and says nothing, as INV-10 holds back a difference she kept.

### 6.5 What the gate cannot do

A lexicon catches what it lists. "How was Tuesday at St Mary's?" names no word in it and passes; "d0ctor" and "p e n s i o n" pass. It stops Wick being the way a protected fact reaches the family by accident — a vision model naming a uniform, a family member's question, a name typed as a role — not a person set on spelling one past it, who could as easily telephone. When a real sentence slips through, its word goes into `lexicon.ts` with a test that it is caught, and a test for the ordinary sentence the word must not catch.

It also catches more than it should, and fails closed when it does: "a man on crutches" at the door loses its sentence, a family adding "Dr Patel" to the roster is asked for "Raj Patel" instead, and a name in a script the lexicon does not read is refused for the roster.

---

## 7. CONNECTORS

### 7.1 Ring

**Auth** ✅ V — OAuth 2.0 + PKCE (S256). Access tokens ~4 h, refresh ~30 d. All calls are server to server; `api.amazonvision.com` and `oauth.ring.com` block browser origins.

**Token custody.** Each household's tokens are one Secrets Manager secret, `wick/ring/tokens/<householdId>`. There is no Ring client without a household (`ringClientsByHousehold`, `services/connectors/ring/src/secrets.ts`). A home's organiser links Ring from the family app, and the link is finished only for the same organiser who started it (`edge-ring authorization.mjs`). The Wick server never holds a Ring token: it asks `wick-ring-household-link`, which has custody. **Refresh has one owner**, the hourly `wick-ring-refresh` Lambda, which walks every household's link in turn. Ring's app credentials (client id, secret, webhook HMAC key) are a separate secret, seeded once by `infra/bootstrap/put-ring-secret.sh`.

**Endpoints used:**

| Purpose | Call |
|---|---|
| Discovery | `GET /v1/devices?include=status,capabilities,location,configurations` |
| Picture for the card ⚠️ **not a live snapshot** | `POST /v1/devices/{id}/media/image/download` — body `{"type":"at_timestamp","timestamp":<ms>}`, returns **303** to a presigned URL. Measured 2026-09-15 at 3.15 s end to end (FL-005). |
| Watch live (M2) | `POST /v1/devices/{id}/media/streaming/whep/sessions` (`Content-Type: application/sdp`) |
| Ring the hallway chime (M1) | `POST /v1/devices/{chimeId}/media/audio/playback` — the app's own audio slot, on a device whose `audio.supported_actions` ∋ `chime.play` |
| Multi-module cameras | append `?component_id=N` |

**Webhook receiver — the whole design is the 5-second budget** (`services/edge-ring/lambda/webhook.mjs`):

```
API Gateway HTTP API → Lambda:
  1. Verify HMAC-SHA256 signature          (constant-time compare)
  2. Idempotency: conditional PutItem on IDEM#<request_id>, TTL 24h
  3. PutEvents → EventBridge bus "wick" (source wick.ring)
  4. return 200
  ── nothing else. No Ring calls, no model calls.
```

A ring takes its household from the doorbell: the Door agent reads which household holds that device from `RINGDEV#<deviceId>`, and a device nobody holds reaches no television (INV-8). An operator hands a device to a household with `scripts/assign-ring-device.ts`.

**Event types** ✅ V: `motion_detected` (with `sub_type`), `button_press`, `device_added`, `device_removed`, `device_online`, `device_offline`, `app_integration_added`, `app_integration_removed`, `subscription_activated`, `subscription_deactivated`.

**What Ring's Playground gives** (the only Ring simulator): a simulated camera behind the real Partner API, real OAuth, real recorded frames and real WHEP live view. It has no chime (FL-019), sends no doorbell or motion webhook (FL-027), and its token lasts 30 minutes with no refresh (FL-010). `npm run ring:check` says whether a household's link can reach the camera before any recording.

**Known gaps** (in `FRICTION.md`): no two-way audio, siren or light endpoints; no event replay or dead-letter queue on Ring's side; no sandbox that emits events on demand.

### 7.2 (removed)

The wearable connector was removed with the Day agent (§5.3). The section number is kept so references to §7.3 still hold.

### 7.3 The Wick server: MCP endpoint (S4a) and the Alexa+ add-on (S4b)

**Access reality first.** The Alexa+ MCP Toolkit is **partner-gated** ✅ V, with no published application path, and US-only. So this splits:

| | Status | What exists |
|---|---|---|
| **S4a — the MCP server** | **Built and deployed** | `services/mcp-server`, on App Runner. Exercised by MCP Inspector and by the family app (`apps/sim-alexa`), a simulated Alexa+ surface — the alternative the hackathon rules allow. |
| **S4b — Alexa+ registration** | **Gated** — staff confirmed in the week of 2026-10-05 that no participant will be given access (FL-001) | `addon-package/addon.json` is complete. `npm run addon:check` holds it to the quickstart's field table in CI; `-- --live` runs the rest of what a deploy is documented to need (the 401, PKCE, the tool list, a round trip) against the deployed stack. It has not been uploaded to Amazon, and cannot be. |

**What the server is:**

- MCP spec **2025-11-25**, **Streamable HTTP**, in the SDK's **stateless** mode: every request is answered by a server built for the person its own token names, and nothing a request needs is held in process memory. OAuth clients, codes, tokens and the sign-in cookie are in DynamoDB.
- Its own **OAuth 2.1 authorization server** (PKCE S256, dynamic client registration, metadata at `/.well-known/oauth-authorization-server`), because an Alexa+ add-on needs one. It does not decide who anyone is: its sign-in pages hand the email and password to an **Amazon Cognito** user pool (`accounts/identity.ts`), and everything it issues names the person Cognito vouched for.
- Unauthenticated requests get `401` with no `WWW-Authenticate`, as the quickstart asks.
- Every token is bound to this server's resource (RFC 8707): a client that names another resource is refused at `/authorize` and `/token` (`invalid_target`), one that names none gets this server's, and a token bound to anything else is refused on every request (`accounts/oauthProvider.ts`).
- Every tool declares an **output schema** (`tools/result.ts` `answerSchema`): its own fields, or `{ say }` alone for a sentence such as a refusal. The Guardian's wrapper checks each answer against it before it leaves; a wrong one fails as any answer does. The SDK's client checks the same schema on the way in (`__tests__/outputSchema.test.ts` calls every tool on a demo home).
- A write sent twice acts once (INV-6): `send_note_to_tv` claims each call with one conditional write (`tools/once.ts`), so a retried call, or the same note sent again within two minutes, is answered with the first note and sends nothing; a client may pass `idempotencyKey` instead. An answer retried by the same person is the answer already given.
- Each request is answered as one JSON body with a `Server-Timing` header — `auth` (the token's check), `build` (this request's server), `gate` (INV-9), `handler`, `guard` (the Guardian), `total` — and logged as one `mcp_request` line with the method, the tool's name, the status and the milliseconds, and nothing about anyone (`timing.ts`). `tools/list` is the same for everyone, so it is made once per process.
- It runs as one esbuild bundle under plain `node` (`services/mcp-server/build.mjs`, `Dockerfile`: Node 22.23.3 pinned by digest, no `node_modules` in the image, user `node`). `GET /health` reads nothing and says the version and commit; App Runner's health check asks it over HTTP (`infra/mcp.tf`), and it answers 503 while the server drains. On SIGTERM the server stops accepting, lets requests in flight finish within ten seconds, and exits 0 (`lifecycle.ts`).
- Every tool is wrapped in `gated` (`tools/context.ts`): the household comes from the token (INV-8), and the resident's allowance is checked on every call (INV-9). A neighbour is refused every tool not marked `neighbour: true`.
- No tool calls a model. The week is precomputed (§5.4); every other tool reads rows.
- The same process serves the family app's `/api` (televisions, Ring link, language, pictures, the stand-in doorbell, voice), a family member's television's `/tv/*` routes, and the assistant.

**The twenty-two tools** (`services/mcp-server/src/tools`):

| Area | Tools |
|---|---|
| The week and today | `get_week_narrative`, `get_today`, `get_resident_shared_view` ("What Sarah sees"), `get_whats_different` (only what she chose to tell), `get_light` |
| Visitors | `did_visitor_come`, `get_visits` (confirmed or not, never why), `list_regular_visitors`, `add_regular_visitor`, `expect_visit` |
| Notes | `send_note_to_tv`, `get_replies` |
| The door | `get_door_request`, `answer_door_request` — both open to a neighbour |
| Being asked to ring | `get_reach_request`, `answer_reach_request` — both open to a neighbour |
| Watching together | `invite_to_watch`, `get_watch_together`, `answer_watch_together`, `join_watch_together`, `withdraw_watch_invitation` |
| Pictures | `get_pictures` (only that she has seen one) |

**The family app** (`apps/sim-alexa`, on CloudFront) signs in to a real account, and for each question the assistant — **Claude Sonnet 4.5** on Bedrock, in the Wick server — chooses which tool to call; the page then calls that tool on the real MCP server and shows what it returned. *Try the demo* makes a guest account and a demo home with six weeks of simulated history. A family member can also ask by voice: the page sends one utterance of at most ten seconds to `POST /api/hear`, which streams it to **Amazon Transcribe** and asks the words as if typed; nothing of the recording is kept or logged. Built and tested, and seen working locally against a stand-in for Transcribe; not yet seen against the deployed stack.

**Alexa+ routes by intent**, so the name "Wick" is rarely spoken. `examplePhrases` are natural questions (*"how's my mum been this week"*), not invocation patterns.

**CLI** ✅ V — documented, but gated; kept for the moment access opens.

```bash
alexa-ai configure                       # LWA OAuth → ~/.alexa-ai/credentials
alexa-ai new mcp --name "Wick" --locale en-US \
                 --mcp-server-url "https://<the mcp_server_url output>"
alexa-ai deploy                          # dev stage
alexa-ai submit                          # certification
```

**`addon-package/addon.json`** ✅ V — `manifestVersion: "1.0"`; `storeListing.distributionCountries: ["US"]`; per-locale `name.value` ≤30 chars, `shortDescription` ≤123, `fullDescription` ≤4000, `examplePhrases` 3–4 items ≤200 chars, live `privacyPolicyUrl` and `termsOfUseUrl` (`docs/privacy.html`, `docs/terms.html`), `mediaAssets.icons.light` in all six sizes (72, 64, 88, 126, 180, 241), a 600×900 carousel image; `integrations[].type: "MCP"` with `config.endpoints.default.uri`.

### 7.4 Other AWS services, by feature

| Service | Used for | Where |
|---|---|---|
| Amazon Rekognition | Moderation of a family picture before it is sent (`DetectModerationLabels`; a check that cannot be made refuses); calm-point measurement (segment detection, offline) | `mcp-server/src/photos/moderation.ts`, `scripts/calm-points/measure.sh` |
| Amazon Polly | Read to me | `edge-device/lambda/speech.mjs` |
| Amazon Translate | Free text into her language | `agent/src/language/translate.ts`, called from `egress.ts` |
| Amazon Transcribe (streaming) | Ask by voice, in the family app | `mcp-server/src/hear/transcribe.ts` |
| Amazon EventBridge Scheduler | The three minutes in hold for Sarah | `agent/src/agents/reach/timer.ts` |
| AWS IoT Core | The television's MQTT channel | `infra/iot.tf` |
| Amazon Cognito | Family members' sign-in | `mcp-server/src/accounts/identity.ts` |

---

## 8. DATA MODEL

### 8.1 DynamoDB — single table `wick`

PK/SK overloaded. On-demand capacity. The main entities:

| Entity | PK | SK | Notes |
|---|---|---|---|
| Household | `HH#<id>` | `META` | timezone, language, policy, `simulated` for a demo home |
| Resident's television | `HH#<id>` | `DEV#<deviceId>` | channel (MQTT or WebSocket), last seen, revoked flag |
| Family member's television | `HH#<id>` | `FTV#<deviceId>` | the member's `userId`; never counted with `DEV#` |
| Membership | `HH#<id>` | `MEM#<userId>` | role (family or neighbour); `pending` until the resident allows (INV-9) |
| Roster person | `HH#<id>` | `PER#<personId>` | name, usual days, an expected visit; no face is ever matched (an optional `photoRef` field exists in the type and is not used to match) |
| Timeline event | `HH#<id>` | `EVT#<ts>#<id>` | door, presence, card shown and answered |
| Rhythm count | `HH#<id>` | `RHYTHM#<dimension>#…` | `(dimension, day of week, hour)` buckets with a count |
| Card | `HH#<id>` | `CARD#<id>` | queue state, server-side showing count |
| Week | `HH#<id>` | `NARR#<isoWeek>` | `residentSeenAt` gates the family's read (INV-7) |
| Feature rows | `HH#<id>` | `LOOK#`, `TELL#`, `VISIT#`, `REACH#`, `WATCH#`, `LIGHT`, `LOOKIN#`, `PHOTO#`, `MANTEL#`, `WAVE#`, `PUSH#`, `LIVE#` | one prefix per feature; the rules for each are in `AGENTS.md` |
| Account | `USER#<userId>` | … | Cognito holds the password; this holds Wick's view |
| OAuth state, clients, codes, tokens | `OAUTH#…` | … | the stateless MCP server's memory |
| Pairing code | `PAIR#<code>` | `META` | TTL 15 min |
| Ring device holder | `RINGDEV#<deviceId>` | … | which household a doorbell belongs to |
| Webhook idempotency | `IDEM#<requestId>` | `META` | TTL 24 h |
| Configuration | `CONFIG#pairing`, `CONFIG#push` | … | public halves of keys |

### 8.2 The Rhythm

The rhythm is counts in DynamoDB, not a time-series database. Each door event and each television session increments a `RHYTHM#` bucket keyed by dimension, day of week and hour (`rhythm/records.ts`). Baselines are the household's own last six weeks (`BASELINE_WEEKS = 6`), and **nothing is called different from fewer than three observed weeks** (`MIN_BASELINE_WEEKS = 3`, `rhythm/baseline.ts`). A false "something's different" is worse than the feature's absence.

### 8.3 S3

| Bucket / prefix | Contents | Lifecycle |
|---|---|---|
| media `snapshots/` | Ring frames, before description | **1 day** — INV-3, bucket rule |
| media `live/` | Live-view HLS segments | **1 day**; the bridge also deletes its session's prefix |
| media `tts/` | Readings made by Polly, keyed by a hash of language, voice and words | **1 day** |
| media `voice/` | Rule from the plan for voice notes; nothing writes there | 30 days |
| photos | The family's pictures, tagged `sent`, `kept` or `gone` | by tag: `gone` after a day, `kept` kept, `sent` 400 days |
| programmes | The films, HLS | kept |
| family app, ops console | Static pages | kept |

INV-3 is a **bucket lifecycle rule**, not application code, with `noncurrent_version_expiration` beside it so versioning cannot keep a deleted frame alive.

### 8.4 Withdrawal

A household's members can be removed and its televisions disconnected, and each takes effect on the next call (INV-9). A single "delete this household and everything about it" operation is **not built**; see §17.

---

## 9. PERFORMANCE

What has been measured, and what has not.

### 9.1 The door

| Segment | What is known |
|---|---|
| Ring press → webhook | Not measured: the Playground sends no webhook (FL-027). |
| Webhook: verify, idempotency, put | Does no network call but one conditional write and one `PutEvents`. Not instrumented. |
| Ring recorded frame | **3.15 s** end to end, n = 3, 2026-09-15 (SP-2, FL-005). This is why Phase 1 ships with no picture. |
| Nova Lite description | **Cancelled at 2.5 s** (`DESCRIBE_TIMEOUT_MS`). A late description is worse than none. |
| Live view | The bridge writes one-second HLS segments; the first picture follows the press by several seconds. Ring allows 30 s on a battery doorbell, 60 s on a wired one. |
| Press → card on a television | **Not measured end to end.** "Within a few seconds" in the README is what was seen on the simulators, not a figure. |

### 9.2 The television app

Not instrumented: `kepler-performance-api` and a Perfetto trace were planned and not done (§17). What is held by tests: the break engine's decisions, the one-second settle on every card, and that a deferred card never shows `IN_SCENE`.

### 9.3 MCP latency

Alexa+ asks for a round trip under 500 ms ✅ V. No tool calls a model, and the week is one `GetItem`. Measured against the deployed server (13 October, and again on 16 October with `npm run latency:mcp`, from a laptop in Europe), calls take **either about 0.2–0.3 s or about 0.75–1.15 s**. On 16 October every slow call was the first on a new connection: App Runner's front end ends a kept-alive connection with `Connection: close` after anything from 2 s to 40 s, and a new TLS connection from Europe costs about 0.5–0.8 s more (FRICTION.md FL-033). At one call a second, 54 calls on a reused connection had p50 201 ms and p95 296 ms, none over 500 ms; the 6 on a new connection all were (p50 780 ms). Back to back, 100 calls had p50 190 ms and p95 217 ms, with one call over 500 ms. Those guest calls stop at the access gate (no television had allowed the guest), so they measure the token check, the server and the gate, not a tool's own reads. The server's own work is small: against the local dev server (in-memory store) its `Server-Timing` total is about 1–2.5 ms at the median, the request's server about 1 ms of it. Since this change the server keeps idle connections 65 s, so it is not the side that closes them, and every answer carries `Server-Timing`; whether App Runner then closes fewer connections has not been measured, because that image is not deployed yet. `npm run addon:check -- --live` reports a **median** over five calls, which hides the slow mode; `npm run latency:mcp` reports p50/p95/p99. Issue [#47](https://github.com/rogerjeasy/wick/issues/47) has the figures.

---

## 10. SECURITY

### 10.1 Credential map

| Secret | Lives in | Reachable from device? |
|---|---|---|
| Ring OAuth access/refresh | AWS Secrets Manager, one secret per household (`wick/ring/tokens/<householdId>`), read at runtime only for the home being acted for | Never |
| Alexa+ LWA credentials | CI secret store / `~/.alexa-ai` | Never |
| Bedrock / AWS | Task roles, no static keys anywhere | Never |
| Device JWT | Device (`kepler-file-system` on Vega, the app's key-value storage on Fire OS, `sessionStorage` in the browser television) | **Yes — and it is scoped to be worthless if stolen**. It says how it was earned (`proof`: `pairing`, `secret`, `none`) |
| Device secret (proof of possession) | Device, beside its id (`apps/tv-vega/src/deviceId.ts`); the server keeps only its SHA-256 (`proofHash`). Made only by a cryptographic generator: Android `SecureRandom` on Fire OS, Web Crypto in the browser television, and `node:crypto` on the server for a Vega television that keeps a file (handed over once with the token by `pair-status.mjs`). Never for the Vega Virtual Device | **Yes** — it renews that one television's token, and nothing else |
| Device id | Device; the table | A label, not a credential. Random, never sent to the family app (it gets a random `televisionRef`), never logged, and new at every new pairing |
| Six-digit pairing code | The television's screen; the nonce (`PAIR#`), fifteen minutes | It is how the television collects its token and, where the server made it, its secret — once |

### 10.2 Threat model, briefly

| Threat | Control |
|---|---|
| Stolen Fire TV stick | Device JWT grants card receipt + playback posting for one household. No Ring access, no history, no family data. The organiser disconnects it from the family app, which removes its row: every path that serves a television refuses it from then on. |
| A copied device token | Good until it runs out (thirty days from pairing, an hour from a refresh). Where the row keeps a secret, it cannot be renewed without the secret. On a row with no secret yet, an unexpired pairing token can enrol a secret — whoever holds one could get in first; disconnecting the television ends it. |
| Someone who knows a television's id | Where the television keeps a file, `POST /pair/refresh` mints its token only for its secret, compared in constant time; a wrong or missing secret is refused before the refresh is counted, so it cannot use up the television's share either (`edge-device/lambda/proof.mjs`). A token minted without proof says so (`proof: 'none'`), can never enrol a secret, and is refused everywhere once the row keeps one. The family app is never told an id, no log carries one, and a television paired again takes a new id, its old row removed. **Open:** Vega has no cryptographic generator in its JavaScript runtime, so no Vega television keeps a secret; the Vega Virtual Device's id is also the constant `wick-tv` — anyone can mint a one-hour token for the home it is paired to and press any card there, consent included. It is only ever paired to a demo home (AGENTS.md INV-1). |
| Someone who reads the table | Finds hashes, not secrets: the secret's SHA-256 (256 random bits, so a plain hash is enough), the address fingerprint keyed with a key only the pairing Lambda holds. A server-made secret sits on the nonce, next to the thirty-day token, only until the television's poll collects it (at most fifteen minutes). |
| Someone who watches the screen, or guesses a code | A code is worth something only once the home's organiser, signed in, enters it in the family app; it then hands over its token (and secret) to one poll, and is gone. Somebody else's code entered by mistake connects their television to the home, as the organiser asked — the family app lists every television, and it can be disconnected. |
| A request that names a television it replaces | The old row is removed only in the organiser's own home, and only if it keeps the hash of the secret the request shows (`pair-claim.mjs` `removeReplaced`). |
| A television that loses its secret | Storage cleared or the app reinstalled: its next refresh is refused (`401 proof_required`), it forgets its token and shows the pairing screen with a code. The organiser enters it; it is a new television, and the old entry is disconnected by hand. |
| Locking a television out from outside | A request without the secret is refused before anything on the row is written. Mints from the id alone are counted in a share of their own, so they cannot use up the share a television proving itself is counted in. Adversarial tests: `edge-device/lambda/__tests__/pair-refresh.test.ts` (TAKEOVER, LOCKOUT). |
| Logs | No device id in any log line, enforced by a test that reads every logger call (`scripts/__tests__/no-device-id-in-logs.test.ts`). |
| Forged Ring webhook | HMAC-SHA256 verify, constant-time; reject unknown `device_id`; idempotency on `request_id`. |
| Prompt injection via a family note or a visitor's clothing/signage | Guardian runs **after** every generation, deterministically, on typed classes. A model that is talked into emitting a health fact still cannot get it past the policy table. This is the main reason the Guardian is rules-first. |
| Family over-reach | Policy table + resident exclusions; exclusions can only narrow (§6.2). |
| Data exfil via KB retrieval | Retrieval-time `FactClass` filtering, before the prompt (§8.4). |
| Replay of a card action | Card ids are ULIDs, single-use, server-side `shownCount` and action idempotency. |

### 10.3 `AGENTS.md`

Ship an `AGENTS.md` at the repo root encoding INV-1…INV-9 as rules for any coding agent working in the repo. It is genuinely useful, and it is also visible evidence to a judge that the invariants are enforced rather than aspirational.

---

## 11. OBSERVABILITY

**Correlation id** (INV-6): minted at the Ring webhook or the MCP request and carried through the EventBridge detail, the agent, the rows it writes and the card payload; the television echoes it back on `card_shown` and `card_action`.

**Logs.** Every Lambda and the App Runner service log to CloudWatch Logs with a retention set in Terraform. API access logs carry no request body and no headers. A spoken question is never logged, nor its length (`AGENTS.md`, ask by voice).

**Status page.** `GET /status` (`services/edge-ring/lambda/status.mjs`, read-only) feeds the ops console's dashboard: the Ring link, the last events, the televisions.

Metrics, dashboards and alarms are **not built** (§17).

---

## 12. TESTING

### 12.1 Real and simulated, resolved

| Layer | Rule |
|---|---|
| **Unit and property tests** | Fixtures are expected. They live under `__tests__`, redacted, and never ship. |
| **The running product** | No mock path is reachable at run time. `npm run check:no-mocks` fails the build if Vega runtime code imports anything matching `/mock/i`. |
| **The demo** | The devices are simulators and the household is a marked demo home; everything between them is the deployed stack. The README's [*What is real, and what is simulated*](../README.md#what-is-real-and-what-is-simulated) is the authority. |

`npm run verify` runs typecheck (twice: the workspace and `scripts/`), lint, the no-mocks guard and every test. CI (`.github/workflows/ci.yml`) runs it on every push and pull request, plus a separate job for the property tests.

### 12.2 Natural-Break Engine

`apps/tv-vega/src/break/__tests__` drives synthetic playback timelines (positions, credits, calm points, pauses, foreground and background) and asserts, with fast-check:

- No `DEFERRED` card ever shows in `IN_SCENE` (INV-5).
- `DOOR` shows at once in any state.
- A card shown mid-programme holds the film, and the film goes on when it is answered.

### 12.3 Guardian

`services/policy/src/__tests__/evaluate.property.test.ts`: for any generated item of a protected class and any policy, `evaluate(…, 'FAMILY')` never allows the content through intact. `services/policy/src/__tests__/guardian.property.test.ts`: every phrase the lexicon lists, however it is written, is never cleared. `services/mcp-server/src/__tests__/guardian.property.test.ts`: the same phrases through the real tool server, a family television's routes and the assistant reach nothing the family is handed. CI runs all three as their own job (`npm run test:property`).

### 12.4 Model output

No golden-file suite. Each model reply passes a validator before it is used (the door's `judgeDescribeReply`; the narrative's checks in `prose.ts`), and the validators are unit-tested. A reply that fails is dropped: the door card keeps its Phase 1 sentence, the week keeps its counted facts.

### 12.5 Contract tests

Ring responses recorded from the Playground, redacted, replayed against the client (`services/connectors/ring`); the chime is tested against Ring's documented contract for every outcome (rang, snoozed, no audio in the slot, offline, failed), since the Playground has no chime. The tool handlers are tested against an in-memory table; `server.test.ts`, `api.test.ts`, `pair-claim.test.ts` and `pair-refresh.test.ts` hold INV-8 (no household id is accepted from a request).

### 12.6 Device testing

There is no physical Fire TV or Ring device in this project. Live checks ran on the Vega Virtual Device, the Fire OS build on the Android TV emulator, and the television in a browser tab, against the deployed stack; screenshots are in [`docs/screenshots/`](screenshots/). What cannot be checked on a simulator — legibility at three metres, contrast on a real panel, sound — has not been checked.

---

## 13. BUILD, DEPLOY, EXTRACT

### 13.1 Infrastructure

**Terraform** (≥ 1.10, AWS provider ~> 6.0), one root in `infra/`, state in S3 with native locking. One file per concern (§1.3). The state bucket is created by `infra/bootstrap/bootstrap.sh`, and three more scripts seed what Terraform makes the containers for: the pairing signing key, the Web Push key pair, Ring's app credentials. Every stateful resource carries `prevent_destroy`. The first apply, and any apply that adds a new AWS service to the deploy role, is run from a laptop. See [`infra/README.md`](../infra/README.md) and [`docs/SETUP.md`](SETUP.md).

### 13.2 CI

GitHub Actions, OIDC to AWS — no static keys in the repository.

| Workflow | Does |
|---|---|
| `ci.yml` | `npm run verify`, and the property tests as their own job. Touches no AWS. |
| `deploy-edge.yml` | On `main` (edge, infra, family app, add-on paths): verify, `npm run build:lambda`, `terraform apply` |
| `deploy-agent.yml` | On `main` (agent, policy, MCP server paths): property tests, verify, build and push the images the push changes (the Wick server's linux/amd64, with `WICK_COMMIT` set to the short SHA), pin their tags in SSM, build the agent bundle, `terraform apply`, and wait for App Runner to run the pinned image. |
| `tv-fireos.yml` | Typecheck the Vega source against the Fire OS adapters, build the APK, upload it |

The container images are built on a push to `main` by `deploy-agent.yml`, and can be pushed from a laptop: `scripts/push-agent-image.sh` builds the AgentCore and live-bridge images (arm64) and pins their tag in SSM (`infra/images.tf`); the Wick server's image (`services/mcp-server/Dockerfile`, linux/amd64: an esbuild bundle and a pinned Node runtime, nothing else) is built by `deploy-agent.yml`, or by `scripts/push-mcp-image.sh` from a laptop, tagged with the short SHA and pinned in `/wick/images/mcp-server`; the next apply deploys it. The Vega app is built with the Vega SDK (`npm run build` in `apps/tv-vega` → `react-native build-vega`) on a developer machine; CI does not build the `.vpkg`.

### 13.3 Environments

One deployed stack (`dev`), used for every live check. There is no real household on it: the only households are test and demo homes.

### 13.4 The Open Source extraction

`packages/vega-calm-ui` — MIT. An accessible-TV component set for Vega: large-type, high-contrast cards of at most three actions that throw at render below the floor; a two-phase card primitive that reserves its space; screen-reader and reduced-motion hooks on Vega's `AccessibilityInfo`; and four ESLint rules (`min-font-size`, `no-alarm-colour`, `max-actions`, `no-auto-dismiss`). A focus-order rule was planned and dropped: Vega's focus engine decides focus at run time. The canonical repository is <https://github.com/rogerjeasy/vega-calm-ui>; this folder is Wick's workspace copy, and Wick's own ESLint config runs the rules over `apps/tv-vega/src`. It is **not published to npm**; it installs from GitHub (`npm install github:rogerjeasy/vega-calm-ui`).

---

## 14. THE SPIKES, AND WHAT THEY FOUND

Each was a decision gate before design depended on it.

| # | Spike | Outcome |
|---|---|---|
| **SP-1** | Can anything render over another app's playback? | **Partly.** A third-party Vega app cannot draw over another app, but its background service can post a **system toast** with a button that brings Wick forward (FL-022, FL-026). The door uses it; nothing else interrupts another app. Fire OS: not built. |
| **SP-2** | Ring snapshot latency | **3.15 s** end to end (n = 3), and the call returns a *recorded* frame, not a live one (FL-005). Phase 1 ships without a picture. |
| **SP-3** | Ring WHEP on Vega | Vega has no WebRTC and its WebView crashed on the simulator (FL-015). Bridged instead: WHEP → werift → ffmpeg → HLS in a Lambda, because the AgentCore microVM has no outbound UDP (FL-017). Works on both simulators with the Playground camera. |
| **SP-4** | Alexa+ add-on access | Partner-gated, no application path (FL-001). The MCP server was built to the spec anyway and exercised through MCP Inspector and the family app. |
| **SP-5** | `mqtt.js` over WSS inside Vega's React Native | Works: connects, reconnects on reopening the app, falls back to the WebSocket when refused (FL-009, update). Hours and hardware not run. |
| **SP-7** | Content Personalization round trip to Continue Watching | **Not run.** The data service is implemented; whether a real device's Continue Watching shows the events is unchecked. |
| **SP-8** | A Vega build running on real Fire TV hardware | **Not run.** There is no hardware in this project; the Vega Virtual Device is the Stage One evidence, which the rules allow. |

---

## 15. BUILD ORDER, AS IT HAPPENED

The plan was spine first (S1 door, S4a family line, S5 Guardian, S2 break engine, S6 rhythm), then the multipliers. It held, with these changes:

| Step | Built | Note |
|---|---|---|
| 1 | **S1 Door Card** — webhook → EventBridge → Door agent → Phase 1 → television | Measured against the Playground camera; a webhook from a press is stood in (FL-027). |
| 2 | **S4a Family Line** — the MCP server | Then accounts, Cognito, the stateless server, the family app. |
| 3 | **S5 Guardian** — policy, egress, lint rule, property tests | |
| 4 | **S2 Natural-Break Engine**, later calm points and the hold | |
| 5 | **S6 Rhythm** — `RHYTHM#` counts in DynamoDB, the six-week baseline, the three-week floor | Not Timestream (§17). |
| 6 | **M1 hallway chime**, **M2 Watch live**, **M3 one-button reply**, **M4 known visitors** (schedule-based), **M5 the visit, witnessed** | M1 is built and contract-tested, not demonstrated (FL-019). |
| 7 | **D1 Something's Different** as "Shall I tell Sarah?"; **D2 What Sarah sees** | D1 asks the resident first, by INV-10. |
| 8 | The Fire OS build; the television in a browser tab | |
| 9 | Ask Sarah to look; the light in the window; watch together; hold for Sarah; Sarah's television; her language; the mantelpiece; read to me; the stand-in doorbell; media controls; ask by voice | Each is a row in the README's table of eleven things, and each has its rules in `AGENTS.md`. |

**M6**, the week rendered as a panel inside the Alexa+ conversation, was not built (§17).

---

## 16. OPEN TECHNICAL QUESTIONS

| # | Question | State |
|---|---|---|
| **Q1** | Can a Vega app or headless service composite over another app's playback? | **Answered:** no overlay; a system toast from a background service, yes (SP-1). |
| **Q2** | Are Ring WHEP sessions duration- or concurrency-limited? | Duration: 30 s battery, 60 s wired, as Ring reports. Concurrency: undocumented, untested. |
| **Q3** | Does `mqtt.js` work over WSS in Vega's React Native? | **Answered:** yes, on the simulator (SP-5). |
| **Q4** | Does `kepler-file-system` give any at-rest protection, or is the device JWT plaintext? | Undocumented. Assumed plaintext, and the token is scoped accordingly (INV-1). On the Vega simulator, nothing written persists at all (FL-013). |
| **Q5** | AgentCore Gateway or a custom Streamable HTTP server for MCP? | **Answered:** custom server, because it has to be its own OAuth authorization server with dynamic client registration for Alexa+, and Cognito decides identity. |
| **Q6** | Audio ducking API, and whether it ducks another app's audio | Not pursued; Wick plays no sound of its own except a reading she asked for. |
| **Q7** | Does the accessibility privilege expose contrast or reduced-motion preferences? | Reduced motion and screen-reader state are read through `AccessibilityInfo` (`vega-calm-ui`). No text-size or contrast preference API was found (L11). |
| **Q8** | Which MCP client makes the most legible demo? | The family app (`apps/sim-alexa`), which shows the tool call and its answer. |
| **Q9** | Why is the deployed MCP server two-speed? | Open — issue #47 (§9.3). |

---

## 17. CONSIDERED AND NOT BUILT

Everything here was in version 1.0 of this document, or was proposed later, and does not exist in the code. It is listed so nobody reads it as built.

| Idea | Why not, or what replaced it |
|---|---|
| **Amazon Timestream** for the rhythm | Counts in DynamoDB `RHYTHM#` rows were enough for a six-week baseline by weekday and hour. |
| **Bedrock Knowledge Bases over S3 Vectors** for natural-language recall | No free-text facts are stored to recall. The family's questions are answered by fixed tools over rows. |
| **AgentCore Memory** | The household's memory is the DynamoDB table; nothing needed a second store. |
| **AgentCore Identity** for Ring tokens | Ring tokens are in Secrets Manager, one secret per household, refreshed by one Lambda (§7.1). |
| **AgentCore Gateway** as the MCP front door | Replaced by the custom server (Q5). |
| **SQS FIFO per household**, **a DLQ per EventBridge rule**, an EventBridge archive | Not built. EventBridge's and Lambda's own retries are the only retries; an event that exhausts them is not kept anywhere. |
| **EMF metrics, dashboards and alarms** (`door.glass_to_glass_ms`, `mcp.roundtrip_ms`, …) | Not built. Latency has been measured by hand (§9). |
| **M6 — the week as a panel in the Alexa+ conversation (MCP Apps)** | Not built. The family app shows the week as text. |
| **A household withdrawal cascade** (`DELETE /household/{id}`) | Not built. Members can be removed and televisions disconnected; whole-household deletion is a manual operation. |
| **Voice notes from the family** (Transcribe into a note, `voice/` prefix) | Not built as a note. Transcribe is used only to turn a family member's spoken *question* into words. The `voice/` lifecycle rule exists with nothing writing to it. |
| **Replies drafted by a model** | Not built as planned. Two of a note's three replies are *chosen* — by the assistant, from a fixed list of sentences Wick wrote (`REPLY_CHOICES`) — and the third is always *"Not right now."* No model writes words the resident would be pressing (`send_note_to_tv.ts`). |
| **A model-assisted classifier in the Guardian** | Not built. The Guardian is rules only. |
| **Golden-file tests for prompts** | Replaced by output validators (§12.4). |
| **Audio ducking**, the out-of-process player | Not built. |
| **`kepler-performance-api` and a Perfetto trace in the README** | Not done (§9.2). |
| **Face matching for known visitors** | Rejected for v1: the roster is schedule-based (decision D3 in `WICK.md`). |
| **A `home` environment with a real household** | There is no real household. Everything runs on test and demo homes. |
| **Testing on a Fire TV Stick** | No hardware. The simulators are the evidence. |
| **Content Personalization round trip verified on a device** | SP-7 not run. |
| **A focus-order lint rule** | Dropped: Vega decides focus at run time. |

---

## APPENDIX A — Verified Vega identifiers

All ✅ V from `AmazonAppDev/vega-video-sample/manifest.toml` (2026-09-14). This is the research list, not what Wick declares; Wick's own manifest is `apps/tv-vega/manifest.toml`.

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
          POST /v1/devices/{id}/media/image/download            (303 -> JPEG)
          body {"type":"at_timestamp"|"latest_in_range","timestamp":<ms>}
          historical retrieval, NOT live capture · ~3.2s end to end
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

## APPENDIX C (removed)

The wearable cheat sheet was removed with the connector (§7.2).

## APPENDIX D — Alexa+ add-on cheat sheet ✅ V

```
Spec      MCP 2025-11-25 · Streamable HTTP (not legacy SSE)
Latency   round trip < 500ms  (from Europe, missed on calls that open a new connection — §9.3)
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
Access    PARTNER-GATED — "Category SDK and MCP Toolkit are available to
          select partners only." No published application path. See FL-001.
```

## APPENDIX E — Friction

Every platform gap found while building is written up in [`FRICTION.md`](../FRICTION.md), with the six fields the rules ask for, at the time it was hit.

---

*Wick — Technical Document · Version 2.0 · 14 October 2026*
*Companion to `WICK.md`. Build, Ship, Shape: Amazon Developer Hackathon — Fire TV track.*
