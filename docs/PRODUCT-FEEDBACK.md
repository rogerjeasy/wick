# Product feedback

Wick is a Fire TV app for an older person living alone, with a Ring doorbell at
the door and an Alexa+ add-on for the distant family. It was built between
2026-09-14 and 2026-10-23 by one developer, with no Fire TV, no Ring device and
no Echo: the television is the **Vega Virtual Device** and an **Android TV
emulator** running the Fire OS build, the doorbell is **Ring's Developer
Playground**, and Alexa+ is a simulated surface in front of a real MCP server.
Everything between them is deployed on AWS in `us-east-1`.

This page answers the five questions for each tool, API and SDK Wick used. The
evidence is in [`FRICTION.md`](../FRICTION.md): 31 entries written at the moment
each problem was hit, cited here by id (FL-0xx). Each entry has the exact steps,
error text and a numbered suggestion. Versions are the ones in
`package-lock.json` and the apps' `package.json` files.

The feature requests drawn from all of this, with a priority for each, are in
[Feature requests](#feature-requests) at the end.

## Contents

- [AWS services used, and how](#aws-services-used-and-how) (the AWS Builder answer)
- Amazon devices and Alexa
  1. [Vega OS SDK, Vega CLI and the Vega Virtual Device](#1-vega-os-sdk-vega-cli-and-the-vega-virtual-device)
  2. [Fire OS (React Native for TV on the Android TV emulator)](#2-fire-os-react-native-for-tv-on-the-android-tv-emulator)
  3. [Ring Partner API, Developer Playground and partner OAuth](#3-ring-partner-api-developer-playground-and-partner-oauth)
  4. [Alexa+ add-ons (MCP Toolkit) and the Model Context Protocol](#4-alexa-add-ons-mcp-toolkit-and-the-model-context-protocol)
- AI on AWS
  5. [Amazon Bedrock](#5-amazon-bedrock)
  6. [Amazon Bedrock AgentCore Runtime](#6-amazon-bedrock-agentcore-runtime)
  7. [Strands Agents SDK (TypeScript)](#7-strands-agents-sdk-typescript)
  8. [Amazon Rekognition](#8-amazon-rekognition)
  9. [Amazon Polly](#9-amazon-polly)
  10. [Amazon Translate](#10-amazon-translate)
  11. [Amazon Transcribe (streaming)](#11-amazon-transcribe-streaming)
- The rest of the AWS stack
  12. [AWS Lambda](#12-aws-lambda)
  13. [Amazon API Gateway (HTTP and WebSocket)](#13-amazon-api-gateway-http-and-websocket)
  14. [AWS IoT Core](#14-aws-iot-core)
  15. [Amazon EventBridge and EventBridge Scheduler](#15-amazon-eventbridge-and-eventbridge-scheduler)
  16. [AWS App Runner and Amazon ECR](#16-aws-app-runner-and-amazon-ecr)
  17. [Amazon DynamoDB](#17-amazon-dynamodb)
  18. [Amazon S3 and Amazon CloudFront](#18-amazon-s3-and-amazon-cloudfront)
  19. [AWS Secrets Manager](#19-aws-secrets-manager)
  20. [Amazon Cognito](#20-amazon-cognito)
  21. [Amazon CloudWatch Logs, AWS IAM and GitHub OIDC](#21-amazon-cloudwatch-logs-aws-iam-and-github-oidc)
- [Other tools used](#other-tools-used)
- [Feature requests](#feature-requests)

---

## AWS services used, and how

Every service below is defined in Terraform under [`infra/`](../infra) (AWS
provider `~> 6.0`) and called with the AWS SDK for JavaScript v3. There are 22
Lambda functions, one AgentCore Runtime, one App Runner service and one
DynamoDB table. CI deploys with GitHub OIDC and holds no AWS keys.

| Service | What Wick does with it | Where |
|---|---|---|
| **Amazon Bedrock** | **Nova Lite** (`amazon.nova-lite-v1:0`) looks at the doorbell's picture and writes one plain sentence about who is there, or nothing; a deterministic validator decides whether that sentence is shown. **Claude Sonnet 4.5** through the `us.` cross-region inference profile writes the weekly narrative from facts already counted in code, and runs the family app's assistant, which chooses which of Wick's MCP tools to call. Nova Lite also wrote the calm-point map's sentences, offline. **Stable Image Ultra** made the stand-in doorbell's four pictures, once. | `services/agent/src/agents/door/describe.ts`, `services/agent/src/graphs/doorDescribe.ts`, `services/agent/src/agents/narrator/prose.ts`, `services/mcp-server/src/assistant/bedrock.ts`, `scripts/calm-points/describe.ts`, `docs/demo-door/NOTICE.md`; IAM in `infra/agentcore.tf`, `infra/narrator.tf`, `infra/mcp.tf` |
| **Amazon Bedrock AgentCore Runtime** | One arm64 container (`wick_agents`) runs the agent plane as Strands graphs: the door's description, the gate before the hallway chime, and the start and stop of Watch live. The runtime session is the household, so each household's graphs run in their own microVM. | `infra/agentcore.tf`, `services/agent/src/runtime/` (`server.ts`, `invoke.ts`), `services/agent/src/graphs/` |
| **AWS Lambda** | 22 functions, Node.js 22 on arm64: the Ring webhook (HMAC check, idempotency, EventBridge put, 200 inside Ring's five seconds), Ring OAuth and the hourly token refresh, television pairing, the WebSocket and MQTT handlers, the IoT custom authorizer, the Door agent, card presses, the weekly Narrator, and the Watch live bridge (a container image: Ring WHEP → werift → ffmpeg → HLS). | `infra/edge.tf`, `pairing.tf`, `transport.tf`, `iot.tf`, `agent.tf`, `card-action.tf`, `narrator.tf`, `live.tf`, `status.tf`; code in `services/edge-ring/lambda`, `services/edge-device/lambda`, `services/agent/src` |
| **Amazon API Gateway** | An **HTTP API** for Ring (`/ring/webhook`, `/ring/token`, `/ring/link`, `/ring/authorize`), pairing (`/pair/start`, `/pair/claim`, `/pair/status`, `/pair/refresh`), Watch live (`/live/sessions`) and `/status`. A **WebSocket API** that every television can fall back to, and that the Vega background service uses. | `infra/edge.tf`, `infra/pairing.tf`, `infra/live.tf`, `infra/transport.tf` |
| **AWS IoT Core** | The television's first-choice channel: MQTT over WSS from `mqtt.js` 5.16. A **custom authorizer** checks the device-bound JWT the television already holds and grants its own three topics. Two topic rules: presence (lifecycle events) and the television's events. | `infra/iot.tf`, `services/edge-device/lambda/iot-authorize.mjs`, `iot-policy.mjs`, `iot-events.mjs`; client `apps/tv-vega/src/transport/MqttChannel.ts` |
| **Amazon EventBridge** | A custom bus, `wick`: Ring events go to the Door agent, card presses to the card-action function. Two scheduled rules: the weekly Narrator (Sundays 20:00 UTC) and the hourly Ring token refresh. | `infra/core.tf`, `agent.tf`, `card-action.tf`, `narrator.tf`, `edge.tf` |
| **Amazon EventBridge Scheduler** | "Hold for Sarah": the three minutes before the next person is asked are a one-time schedule that calls the card-action function back and deletes itself. It carries a request id and a step, never a name. | `infra/reach.tf`, `services/agent/src/agents/reach/timer.ts` |
| **AWS App Runner** | The Wick server: the MCP server (22 tools, Streamable HTTP, OAuth 2.1), the family app's API, the assistant, photo upload and the voice route. Stateless, so a redeploy signs nobody out. | `infra/mcp.tf`, `services/mcp-server/` |
| **Amazon ECR** | Three image repositories with lifecycle policies: the AgentCore agents, the Watch live bridge Lambda and the Wick server. Images are arm64. | `infra/agentcore.tf`, `infra/mcp.tf`, `scripts/push-agent-image.sh` |
| **Amazon DynamoDB** | One table, `wick`: households, televisions, cards, the timeline, the rhythm, weeks, OAuth clients and tokens, memberships, and webhook idempotency. Every MCP tool answers from one `GetItem` or `Query` over precomputed rows, so no model runs inside a tool call. | `infra/core.tf`, `services/mcp-server/src/accounts/store.ts`, `services/mcp-server/src/tools/` |
| **Amazon S3** | The door's media bucket, whose lifecycle deletes Ring imagery after one day (the rule is in the bucket, not in code), and Polly readings under `tts/` after one day; a photos bucket whose lifecycle follows a tag the resident's press sets; the films' HLS; the static family app and the browser television. | `infra/core.tf`, `infra/photos.tf`, `infra/programmes.tf`, `infra/sim-alexa.tf`, `infra/ops-console.tf` |
| **Amazon CloudFront** | HTTPS in front of four private buckets through Origin Access Control: the films (Blender's open films), the Watch live HLS, the family app and the browser television. | `infra/programmes.tf`, `infra/agentcore.tf`, `infra/sim-alexa.tf`, `infra/ops-console.tf` |
| **AWS Secrets Manager** | Each household's Ring tokens in a secret of its own (`wick/ring/tokens/<householdId>`), with one writer for refresh; the pairing signing key; the Web Push (VAPID) key pair. | `infra/core.tf`, `infra/edge.tf`, `infra/pairing.tf`, `infra/push.tf`, `services/connectors/ring/src/secrets.ts` |
| **Amazon Cognito** | A user pool holds each family member's email and password. The MCP server stays the OAuth authorization server that Alexa+ needs and hands sign-in to Cognito. | `infra/accounts.tf`, `services/mcp-server/src/accounts/identity.ts` |
| **Amazon Rekognition** | `DetectModerationLabels` checks a family photo before it is stored, and refuses it if the check cannot be made. Offline, video **segment detection** found every shot, fade and the start of the end credits in each film, from which the "calm points" a note may wait for are chosen. | `services/mcp-server/src/photos/moderation.ts`, `infra/photos.tf`; `scripts/calm-points/measure.sh`, `build.ts` |
| **Amazon Polly** | "Read to me": the Play key reads the card on screen aloud, with neural voices (Amy, en-GB; Lupe, es-US) and SSML built at the edge. Each reading is kept a day. | `services/edge-device/lambda/speech.mjs`, `infra/speech.tf`, `packages/contracts/src/speech.ts` |
| **Amazon Translate** | Free text (a family note, the door's sentence, the week's paragraph) is translated into the resident's language on its way to her television, and nowhere else. | `services/agent/src/language/translate.ts`, `services/agent/src/egress.ts`; IAM in `infra/agent.tf`, `agentcore.tf`, `card-action.tf`, `mcp.tf` |
| **Amazon Transcribe** (streaming) | Ask by voice: one spoken question from the family app, ten seconds at most, is streamed to `StartStreamTranscription` and asked as if typed. Nothing is stored. | `services/mcp-server/src/hear/`, `infra/mcp.tf` |
| **Amazon CloudWatch Logs** | A log group per function, with retention; the record used to diagnose Ring linking (FL-002) and the Vega background service (FL-026). | every `infra/*.tf` with a Lambda; `infra/core.tf` |
| **AWS IAM + GitHub OIDC** | One role per function, scoped to the actions and resources it calls. GitHub Actions deploys through an OIDC role, with no static keys. | `infra/github-oidc.tf`, `.github/workflows/deploy-*.yml` |

---

## 1. Vega OS SDK, Vega CLI and the Vega Virtual Device

**Versions:** Vega SDK 0.24.12044, Vega CLI 1.3.4, Vega Virtual Device on Apple
silicon (`sim_tv_aarch64`), React Native 0.83.0 with
`@amazon-devices/react-native-kepler` 4.0.1 (+rn0.83.0),
`@amazon-devices/kepler-cli-platform` 0.22.14.

#### Which developer tools, apis and SDKs did you use and for what?

`apps/tv-vega` is the resident's television: a home screen of films, a player,
the cards (door, notes, the week, questions), and a background service.

| Package / tool | Version | What Wick uses it for |
|---|---|---|
| `react-native-kepler` | 4.0.1 | Components, `useTVEventHandler` for the remote, `AccessibilityInfo`, `Linking.openURL('pkg://…')` to start the background service, `useToastKepler`'s toast shape |
| `headless-task-manager` | 1.2.8 | The background card service (`com.wick.tv.card.service`) and two tasks (`apps/tv-vega/service.js`, `task.js`) |
| `NotificationManager` TurboModule, via `keplerscript-turbomodule-api` 1.2.5 | — | A system toast over another app when someone is at the door (`apps/tv-vega/src/notify/doorToast.ts`) |
| `kepler-content-personalization` | 1.3.3 | Playback events and `creditsPositionMs` for Continue Watching and for the Natural-Break Engine (`apps/tv-vega/src/personalization/`) |
| `kepler-media-controls` | 1.0.25 | The film as a media session, so "Alexa, pause" and the system's transport controls reach it (`apps/tv-vega/src/watch/mediaControls.ts`) |
| `react-native-w3cmedia` | 2.3.2 | `VideoPlayer` for the films and Watch live (HLS); `AudioPlayer` for "Read to me" |
| `kepler-file-system` | 0.0.7 | The pairing token, device id and sync cursor (`PairingFlow.ts`, `OnInstallTask.ts`, `RhythmSyncTask.ts`) |
| `@amazon-devices/webview` | 4.0.2 | Tried for a WebRTC view of the Ring camera; removed (FL-015) |
| Vega CLI | 1.3.4 | `vega project generate/doctor`, `react-native build-vega`, `vpt validate`, `vega device` (`install-app`, `running-apps`, `start-log-stream`, `run-cmd`), `inputd-cli` on the device |

#### What worked well?

- **The SDK is on npm.** `npm install @amazon-devices/react-native-kepler` works,
  so the Vega app sits in an ordinary npm workspace with type checking and
  tests (FL-007).
- **The `helloWorld` template** built, installed and launched on the VVD first
  time. It was what we bisected against when our own package would not install
  (FL-011).
- **`vega project doctor`** found real manifest errors before any build (FL-011).
- **`inputd-cli button_press --holdDuration`** on the device. A real key hold
  from the shell made the Vega half of "hold OK for two seconds" a five-minute
  test (FL-028).
- **`vega device start-log-stream`.** Every hard problem here was solved by
  reading it (FL-013, FL-018, FL-022, FL-026).
- **`w3cmedia` playback over HTTPS** worked on the simulator, and a card drawn
  by the app over its own playing film stayed legible with the film running
  (SP-1).
- **Background service plus toast.** Once found, it is a good design: the app
  starts its own service with `Linking.openURL('pkg://<service id>')`, the
  service outlives the app's time on screen, and a toast posted from it is
  drawn over whatever app is in front, with a button that brings Wick forward.
  It worked on the simulator for the five minutes we watched (FL-022).
- **Media controls.** Registering our own handler with
  `MediaControlServerComponentAsync` let every platform command go through the
  same rules as the remote's keys. The system's Stop reached the session on
  the simulator and paused the film (FL-031).
- **`mqtt.js` 5.16 over WSS** ran inside Vega's React Native 0.83 at the first
  attempt, with no change to the library, the bundler or the manifest (FL-009
  update).

#### What needs work?

The pattern across these: **an accepted call that silently does nothing.**
Most of the time lost on Vega went on calls that were accepted, validated or
installed and then did nothing, with the reason only in the device log or the
SDK's source.

- **Showing something outside your app is undocumented, and the docs say it
  cannot be done** (FL-022, Critical). The expo-notifications page says it
  "doesn't work on the Vega Virtual Device". The headless overview's "Manually
  launch with this command:" is followed by nothing in every version from 0.21
  to 0.24. A toast whose channel `name` is not a render template
  (`SimpleToastRenderTemplate`) is accepted, returns an id and draws nothing.
  Other notification kinds fail with a bare `No Permission Error`.
- **Starting a service.** Nothing says what launches a `[[components.service]]`.
  Declaring it, offering it and passing `vpt validate` is not enough, and
  `running-apps` gives no sign that it was even considered (FL-014). `vpt`'s
  advice to use the headless runtime loader fails its own rule that all
  runtime modules use one version, for any app that also has a UI (FL-014,
  step 8).
- **A service's start is killed after about eight seconds** (`lcm-transition-
  monitor: Transition timed out … AppNotResponding`). The package README does
  not mention a limit, and from the app's side the failure is silent (FL-026).
- **A service cannot be handed anything** (FL-029). There is no launch data on
  `onStartService`, a query on the `pkg://` URI is lost, and a second `openURL`
  to a running service does not call `onStart` again. `AsyncLocalStorage` is
  not shared between the app and its service. `Linking` in the service aborts
  the process (signal 6) inside a try/catch.
- **`kepler-file-system` on the VVD keeps nothing** (FL-013, Critical). Every
  write fails with a bare `com.amazon.kepler.io.IoError` ("Application data
  root path is not set"), in `/data` and `/tmp`, after reboot and reinstall,
  with a manifest that validates with 0 errors. Together with FL-029, this
  forced a security trade-off in our code: a token refresh without proof of
  possession, written up as an accepted exception in `AGENTS.md` (INV-1).
- **Remote key names** (FL-021). `HWEvent` documents `playpause`, `select` and
  `skip_forward`, but the VVD sends `play`, `enter` and `forward`.
  `eventType` is typed `… | string`, so a wrong name compiles and the remote
  silently does nothing.
- **Video** (FL-016, FL-018). A cleartext HLS URL makes no request and raises no
  error: the screen stays black. If the manifest lacks
  `com.amazon.mediatransform.service`, every decode fails as `MediaError 3`, and
  the real cause is one `Binder … Missing the permissions` line far up the log.
  Manifest validation passes either way.
- **Media controls** (FL-031). With a session registered, Play/Pause arrives
  twice, about 60 ms apart: as a key event and as `handleTogglePlayPause`. A
  `startTime` of zero fails with `time instant cannot be represented in
  epoch-us`, and `updateMediaSessionStates([])` fails with `Array of
  MediaSessionState is empty`; neither error names the field. The simulator
  cannot send a voice or media-session command, so "Alexa, pause" itself
  cannot be tried without a Fire TV. The guide's `useComponentInstance()` is
  deprecated.
- **WebView 4.0.2 segfaults on mount on the VVD**, Amazon's own `vegaWebview`
  template unmodified included. There is also no WebRTC module for Vega React
  Native, so Ring's live video (WebRTC) needs a server in between (FL-015).
- **Tooling disagreements** (FL-011, FL-012). `vpt validate` calls a missing
  icon a warning; `vpm install` rejects the same package with a bare `Package is
  invalid`, and a manifest bisection was needed to find it.
  `[package].build_number` in `manifest.toml` is ignored. A custom Metro
  `resolveRequest` silently replaces the SDK's own redirection to
  `react-native-kepler`, and the app then crashes on every launch with
  `Cannot read property 'select' of undefined`.
- **Packaging** (FL-007, FL-011). `react-native-kepler` ships 49 `.ts` files
  beside their `.d.ts`, and the `react-native-strict-api` export condition
  points at `types_generated/`, which is not in the tarball. Five sibling
  `@amazon-devices/*` packages declare a loose `react-native` peer that
  resolves to 0.87.1, so `react-native` had to be pinned to 0.83.0 with a root
  `overrides`.
- **Content Personalization.** Importing the package's value exports does a
  native TurboModule lookup as a side effect, which throws outside a Vega
  runtime, so we import it lazily
  (`apps/tv-vega/src/personalization/handlers.ts`). We built the handlers
  against the installed types, but never confirmed that Continue Watching
  updates: the simulator offers no way to see it (SP-7, not run).

#### How was your onboarding experience (getting from zero to hello world)

The `helloWorld` template was quick: generated, built, installed and running on
the VVD with no changes. Getting from there to our own app running took the
five days from installing the SDK (2026-09-15) to the first real pairing on the
VVD (2026-09-19), because the problems came one at a time and each was silent. A
command registered by a devDependency (`kepler-cli-platform`) that the docs did
not name, a `react-native` version drift, the ignored `build_number`, the icon,
the Metro resolver (FL-011, FL-012). Then the pairing screen hung on a file
write that could never succeed (FL-013). With a template that has one
interactive component and one service that really starts, and the icon and
resolver traps documented, the second half would have been much shorter.

#### Would you build with these devices and services again?

**Yes.** Headless services, Content Personalization's `creditsPositionMs` and
media sessions are exactly what a calm, ambient television app needs. We would want two things first: the
"outside your app" route documented and supported (FL-022), and storage that
persists on the simulator (FL-013). The simulator is the only Vega device most
developers will have.

---

## 2. Fire OS (React Native for TV on the Android TV emulator)

**Versions:** `react-native-tvos` 0.83.0-0 (installed as `react-native`),
`react-native-video` 6.19 (ExoPlayer), Android TV emulator image API 34, arm64,
Java 17. See [`apps/tv-fireos/README.md`](../apps/tv-fireos/README.md).

#### Which developer tools, apis and SDKs did you use and for what?

The Fire OS build is the Vega app's own source with Android stand-ins for four
Amazon packages: `react-native-kepler` → React Native's own (media keys
renamed), `w3cmedia` → ExoPlayer through `react-native-video`,
`kepler-file-system` → the app's key-value storage, `kepler-media-controls` → a
stand-in that does nothing yet (`apps/tv-fireos/adapters.config.js`). It runs on
the **Android TV emulator**, the one the hackathon FAQ names; Amazon publishes
no Fire OS emulator. `useTVEventHandler` handles the remote. Amazon's
`react-native-multi-tv-app-sample` was our reference, and we contributed to it
(see `docs/SUBMISSION.md`).

#### What worked well?

- On the emulator, pairing, the home screen and playback worked the first time
  (FL-025).
- One codebase for two platforms is real. A parity test fails when the Vega
  source imports a name an adapter does not offer
  (`apps/tv-fireos/src/__tests__/parity.test.ts`), and `npm run typecheck`
  compiles the Vega source against the adapters.
- On the emulator, against the deployed stack (2026-10-11): MQTT and the
  WebSocket fallback, a door card over a playing film with a Ring Playground
  picture, Watch live, and still paired after a reinstall
  (`apps/tv-fireos/README.md`).
- CI builds the APK on every change (`.github/workflows/tv-fireos.yml`).

#### What needs work?

- **No Fire OS emulator** (FL-025). Everything here was found on a stock
  Android TV image, and whether a Fire TV Stick behaves the same is unknown.
- **The remote is dead until something has focus** (FL-025). A full-screen
  player with no focusable control gets no key events at all.
- **One button, three event shapes** (FL-028). A short OK press reaches
  JavaScript as a key-up only, because `ReactFeatureFlags.enableKeyDownEvents`
  defaults to false. A held key is reported as `longSelect`, never `select`.
  Play/pause arrives only as the key coming up. None of this is in the Fire TV
  React Native guidance beside `useTVEventHandler`. Our first "hold OK for two
  seconds" took a short press for a hold, and unit tests passed throughout.
- **`adb shell input` cannot hold a key.** Finding FL-028 took a virtual
  remote built on the kernel's `uinput`. Vega's `inputd-cli --holdDuration`
  already does this.

#### How was your onboarding experience (getting from zero to hello world)

Fast for a React Native developer: the first build bundled the Vega source and
ran on the Android TV emulator the day it was started (2026-10-11). The time
went on input and focus (FL-025 the same day, FL-028 two days later), which only
show up on a device or emulator with a real remote.

#### Would you build with these devices and services again?

**Yes.** Most Fire TVs in homes today run Fire OS, and building it from the
same source as Vega took one day for the first version. We would want a Fire OS emulator image,
or a written list of how the Android TV emulator differs from a Fire TV for
input, focus and notifications.

---

## 3. Ring Partner API, Developer Playground and partner OAuth

**What:** Ring Partner API (`api.amazonvision.com`), the Ring Developer Console
(private app), partner-initiated OAuth 2.0 with PKCE, webhooks, and the
Developer Playground (released 2026-05-28).

#### Which developer tools, apis and SDKs did you use and for what?

- **Webhooks** (`button_press`, `motion_detected`): put the door card on the
  television. Verified with HMAC-SHA256 and made idempotent on `request_id`,
  inside Ring's five seconds (`services/edge-ring/lambda/webhook.mjs`).
- **`POST /v1/devices/{id}/media/image/download`**: the still on the door card
  (`services/connectors/ring/src/media.ts`).
- **WHEP live view**: Watch live, bridged to HLS in a Lambda for the
  television's own player (`infra/live.tf`, `services/agent/src/live/`).
- **Event history and the device list**, with capabilities
  (`services/connectors/ring/src/jsonapi.ts`).
- **Chimes, `POST /v1/devices/{id}/media/audio/playback`**: "Ring the hallway
  chime", built and contract-tested (`services/connectors/ring/src/chime.ts`).
- **Partner-initiated OAuth**, PKCE S256, with a token per household in
  Secrets Manager and an hourly refresh (`services/edge-ring/lambda/`).
- **The Developer Playground**: the simulated camera and its access token.

#### What worked well?

- **The Playground's camera and live view are a real API behind a real
  account.** A Playground token works against every Ring endpoint, so we built
  against real responses from the first day (FL-004 workaround).
- **WHEP is a clean standard.** Ring answered our offer `201` in about 1.5 s,
  and 1280×720 H.264 played in desktop Chromium in 5.6 s (SP-3).
- **Specific validation errors.** Naming the valid enum values in the error
  (`valid values: at_timestamp, latest_in_range`) is better than most APIs
  manage (FL-005).
- **Token refresh** rotates reliably once a link exists
  (`ring_token_refreshed`, `rotatedRefreshToken: true`; FL-010).
- **Clear answers in the hackathon forum.** Amazon confirmed the Playground's
  limits and that an entrant's own event source is acceptable (topics 45309,
  45511), which let us build a documented stand-in rather than guess.

#### What needs work?

- **The Playground sends no doorbell or motion webhook** (FL-027) and has no
  chime (FL-019). So the event half of the Partner API, the half a care product
  is built on, cannot be exercised without buying hardware. A developer learns
  this only after building the webhook receiver. We sign Ring's documented
  payload with the real HMAC key and post it to our real webhook
  (`scripts/visit-sighting.sh`, `scripts/test-ring-webhook.sh`). Demo homes
  have a stand-in doorbell of Wick's own, labelled as one.
- **Linking: four silent failures in a row.**
  - "1/10 accounts connected" in the console means an allowlist, not a token,
    and none of our three URLs was ever called (FL-002, Critical).
    `client_credentials` gets `401 unsupported_grant_type` with no guidance.
  - Partner-initiated OAuth: the authorize endpoint accepts an invented
    `client_id` with a byte-identical 302, then shows "Something went wrong"
    with no error code, no correlation id and no redirect back. The allowlist
    requirement is one line in the prerequisites (FL-004, Critical).
  - After a successful code exchange the integration stays dormant until a
    `PATCH /v1/accounts/me/app-integrations`, which is only in the endpoint
    reference (FL-003).
  - That PATCH is then refused: `400 Invalid Status Transition — "Status change
    not allowed"`, with no from/to state. The console's separate "Sign in" flow
    changes nothing on the API side (FL-010).
- **Media** (FL-005, FL-008). "Snapshot" is historical retrieval with an
  undocumented body: it took six requests to discover
  `{"type":"at_timestamp","timestamp":…}`, and a malformed body gets `403
  Cannot authorize`, which sends you to check scopes. Three of five first
  attempts after an event returned `422 GRECO_NO_VALID_KEY` as a JSON body from
  a URL the client expects image bytes from. Budget about 3.2 s end to end.
- **Capabilities** (FL-006). A device without chime controls returns `400
  Validation Error` with nothing naming the capability. The fix is
  `audio.supported_actions` ∋ `chime.play`, now documented in the Early Access
  Chimes page, but no camera-side page says the endpoint is for chimes only.

#### How was your onboarding experience (getting from zero to hello world)

Zero to a first real API call was short: create the app, paste a Playground
token, call `/v1/users/me` (`scripts/set-ring-token.sh` does exactly this). Zero
to "a doorbell press reaches my server" never happened. The console's link
issues no credential (FL-002), the partner flow is gated without saying so
(FL-004), and the Playground sends no events (FL-027). Linking alone produced
four friction entries (FL-002, FL-003, FL-004, FL-010) before it was clear that
none of the levers we had could work for a private app.

#### Would you build with these devices and services again?

**Yes.** A doorbell is the one sensor every home already accepts, and Ring's
Partner API has what this product needs: live view, recorded frames and a
chime, which let a television app act at the front door, not only watch it. But the Playground needs "press the doorbell" and "person detected" buttons
that send the signed webhook, and the linking flow needs real errors, before a
second project should be asked to go through what this one did.

---

## 4. Alexa+ add-ons (MCP Toolkit) and the Model Context Protocol

**Versions:** MCP spec 2025-11-25, Streamable HTTP;
`@modelcontextprotocol/sdk` 1.30.0 (TypeScript); the Alexa+ MCP Toolkit docs at
developer.amazon.com/docs/alexaplus/add-ons, read 2026-09-14 and 2026-10-11.

#### Which developer tools, apis and SDKs did you use and for what?

- **The MCP server** (`services/mcp-server`): 22 tools through which the family
  reads the week, today, visitors, notes and replies, the door, the light, and
  so on. It uses the SDK's `McpServer`, `StreamableHTTPServerTransport` in
  stateless mode, and `mcpAuthRouter` for OAuth 2.1 (authorization code +
  PKCE S256, dynamic client registration, Protected Resource Metadata). It is
  deployed on App Runner.
- **The add-on package** (`addon-package/addon.json`, icons, carousel image,
  privacy and terms pages), held to the quickstart's field table in CI.
  `npm run addon:check -- --live` runs the checks a deploy is documented to
  need against the deployed stack (`scripts/addon/preflight.ts`).
- **A simulated Alexa+ surface** (`apps/sim-alexa`, the "family app"), which the
  hackathon rules allow, because the add-on toolkit is partner-gated.

#### What worked well?

- **The quickstart's hard requirements are precise and testable**: spec
  version, Streamable HTTP, OAuth 2.1 + PKCE, round trip under 500 ms. That
  last one shaped the architecture for the better. The weekly narrative is
  written ahead of time by a scheduled Lambda, and every tool is one DynamoDB
  read (`services/mcp-server/src/server.ts` header).
- **The TypeScript MCP SDK's OAuth router** covers metadata, dynamic client
  registration and PKCE, so our code only decides who a person is (Cognito)
  and what they may read.
- **Stateless Streamable HTTP**: a redeploy interrupts no conversation, and a
  second instance can answer any client.
- **The manifest schema is documented in full**, and that is why our package
  can be checked without Amazon.

#### What needs work?

- **The toolkit is restricted to select partners, and the pages describing the
  workflow do not say so** (FL-001, Critical). The restriction is only on the
  docs home page; Overview, QuickStart, Certification and Account Linking read
  as self-serve. There is no criterion, form or waitlist. Amazon staff
  confirmed in the forum (topics 45262, 45482) that hackathon participants
  will not get access, so `alexa-ai deploy` was never run (SP-4). The toolkit
  is also US-only.
- **Two protocol versions** (FL-023). The quickstart requires 2025-11-25; the
  client lifecycle page shows the Alexa+ client sending `2025-03-26`. Nothing
  says which versions a server must accept, or whether the `resources`
  capability in the example response is required. Our server answers both.
- **Our server does not meet the 500 ms target on every call.** Calls take
  either about 0.25 s or about 1 s, in bursts, on every tool (our issue
  [#47](https://github.com/rogerjeasy/wick/issues/47)). This is ours to fix,
  and the cause is not yet known. We mention it because a real add-on would be
  judged on it.

#### How was your onboarding experience (getting from zero to hello world)

MCP itself was straightforward: the SDK provides the server, the transport and
the OAuth router, MCP Inspector exercised it before any client of ours existed,
and it was deployed on App Runner on 2026-09-19, five days after the first
commit. Alexa+ never reached hello world. We built to the QuickStart's
requirements and prepared every asset the manifest asks for, and only then
found the partner restriction (FL-001).

#### Would you build with these devices and services again?

**Yes, the day there is a way in.** A distant daughter asking her own Echo "how's
Mum been this week?" is the most natural interface Wick has, and MCP makes the
server portable. Until then, a development sandbox open to any registered
developer, as Ring's Partner API already has, is what would make it buildable.

---

## 5. Amazon Bedrock

**Models:** `amazon.nova-lite-v1:0` (on demand, us-east-1);
`us.anthropic.claude-sonnet-4-5-20250929-v1:0` (cross-region inference
profile); `stability.stable-image-ultra-v1:1` (us-west-2, once). Clients:
`@aws-sdk/client-bedrock-runtime` 3.1136 (`ConverseCommand`, `InvokeModel`) and
Strands' `BedrockModel`.

#### Which developer tools, apis and SDKs did you use and for what?

- **Nova Lite, vision.** One sentence about who is at the door, from the
  doorbell's still (`services/agent/src/agents/door/describe.ts`, as a Strands
  Agent in `graphs/doorDescribe.ts`). A validator decides whether the sentence
  is shown, and an empty answer is allowed ("silence beats a wrong
  description"). Also used offline, for the calm-point map's "From … to …"
  sentences (`scripts/calm-points/describe.ts`).
- **Claude Sonnet 4.5.** The weekly narrative, from fact lines that code has
  already counted (`services/agent/src/agents/narrator/prose.ts`). It also runs
  the family app's assistant, which picks Wick's MCP tools on each step
  (`services/mcp-server/src/assistant/`).
- **Stable Image Ultra**, once, for the stand-in doorbell's four pictures of
  nobody real (`docs/demo-door/NOTICE.md`).

#### What worked well?

- **The Converse API** gave one call shape for Nova and Claude, with images, so
  swapping models is one id.
- **Nova Lite is fast and cheap enough to describe every door event.** With
  the still, the sentence reaches the card about ten seconds after the press in
  our simulator tests, after the card itself is already on screen (README).
- **Cross-region inference profiles**, once the IAM shape was right: grant
  `InvokeModel` on both the profile ARN and the foundation-model ARN in any
  region (`infra/narrator.tf`). One Terraform local now feeds both the
  Lambda's model id and its grant, so they cannot drift.
- **Third-party image models on Bedrock** filled a gap the same day (FL-030).

#### What needs work?

- **Amazon's own image models are past end of life, and the model list does
  not say so** (FL-030). `amazon.nova-canvas-v1:0` and
  `amazon.titan-image-generator-v2:0` answer `ResourceNotFoundException: This
  model version has reached the end of its life.` in us-east-1, and `The
  provided model identifier is invalid.` in us-west-2. Neither appears in
  `ListFoundationModels --by-output-modality IMAGE`, and no successor is named.
  An entry that wanted to say "made with Amazon Nova" cannot.
- **A model can be listed and still refused.** Claude Sonnet 5 and its `us.`
  inference profile were listed for our account, but every call failed with
  `AccessDeniedException` ("not available for this account"). The weekly
  narrative failed silently from deploy until 2026-10-01, when we moved to
  Sonnet 4.5 (commit `04b55bd`). We did not write a friction entry at the time.
  Our request: a field in `ListFoundationModels` or `GetFoundationModel` that
  says whether *this* account can invoke a model.

#### How was your onboarding experience (getting from zero to hello world)

Short: one Converse call with an image block. The time went on the Sonnet 5
refusal above and on the inference-profile IAM grant.

#### Would you build with these devices and services again?

**Yes.** One API across vendors, IAM instead of API keys, and data that stays in
the account matter for a product that handles a stranger's face at someone's
door.

---

## 6. Amazon Bedrock AgentCore Runtime

**What:** one AgentCore Runtime (`aws_bedrockagentcore_agent_runtime`,
`network_mode = "PUBLIC"`, HTTP protocol, arm64 container from ECR), invoked
with `@aws-sdk/client-bedrock-agentcore` 3.1144 (`InvokeAgentRuntimeCommand`).

#### Which developer tools, apis and SDKs did you use and for what?

The agent plane: the door's describe graph (Nova Lite → validator), the door's
action graph (gate → Ring chime → patch the card; no model) and the live view's
start and stop (gate → start the bridge). The container serves `GET /ping` and
`POST /invocations` (`services/agent/src/runtime/server.ts`). **The runtime
session is the household** (`runtime/invoke.ts`), so each household's graphs
run in their own microVM, and the product's trust boundary is the platform's
isolation boundary. We did not use AgentCore Memory, Identity or Gateway.

#### What worked well?

- **Session = microVM isolation** is exactly the right primitive for one-home-
  per-session data. It needed one line of design and no code.
- **The container contract is small** (`/ping`, `/invocations`) and easy to run
  and test locally.
- **Terraform support** in the AWS provider, so the runtime is in the same plan
  as everything else (`infra/agentcore.tf`).
- **HTTPS egress** to Ring, Bedrock, S3 and DynamoDB from inside the runtime
  was fine (FL-017).

#### What needs work?

- **No outbound UDP in PUBLIC network mode, and nothing says so** (FL-017).
  Ring's WHEP answered `201`, but the peer had only `host` candidates and never
  connected. ffmpeg timed out after 10 s with 0 segments. A plain Lambda in the
  same account got a STUN answer in 202 ms. Nothing fails loudly: the packet
  is simply not answered. The live bridge moved to a Lambda.
- **EventBridge, Scheduler and API Gateway cannot target a runtime directly**,
  so every way in is a small Lambda shim (`services/agent/src/runtime/invoke.ts`,
  `infra/card-action.tf`).
- **A session keeps the image it started with for up to eight hours**, so a
  deploy does not reach a warm household. We put the runtime version into the
  session id (which must be at least 33 characters) to force a fresh microVM
  (`runtime/invoke.ts`). A documented "drain sessions on update" option would
  replace the trick.

#### How was your onboarding experience (getting from zero to hello world)

The runtime, its Lambda shims and the Strands graphs landed together on
2026-10-01 (PR #3). The one ordering trap is that the runtime needs an image
before it can be created, so the first deploy is apply ECR, push, apply
(`infra/agentcore.tf` header). The UDP finding (FL-017) surfaced the same day
as a ten-second silence two layers away from its cause.

#### Would you build with these devices and services again?

**Yes.** For per-tenant agent work, session-level microVM isolation is worth
more than anything else on offer. Real-time media goes elsewhere until egress is
documented.

---

## 7. Strands Agents SDK (TypeScript)

**Version:** `@strands-agents/sdk` 1.18.0.

#### Which developer tools, apis and SDKs did you use and for what?

`Graph`, `Agent`, `BedrockModel`, `ImageBlock` and the `multiagent` `Node` base
class (`services/agent/src/graphs/`). Each AgentCore invocation runs one graph.
A vision `Agent` with no tools describes the visitor. The parts that must never
be a model's decision (the Guardian policy, the gate before a chime makes a
sound, starting a live session) are deterministic nodes in the same graph,
with conditional edges (`graphs/step.ts`).

#### What worked well?

- **A node is any `Node` subclass.** That let us put deterministic steps and
  model steps in one graph, with the graph's ordering, tracing and conditional
  edges around both. This is the right shape for "a model may describe, only
  code may decide".
- **`BedrockModel`** needs only a model id, region, `maxTokens` and
  `temperature` here, and takes Nova's vision input through `ImageBlock`.
- **Tests run without AWS**: graphs take a `Model`, so tests pass a stand-in.

#### What needs work?

Nothing was logged against it. One wish: a built-in "function node", so a
deterministic step does not need its own `Node` subclass with an async
generator (`StepNode`, about 40 lines in `graphs/step.ts`). A TypeScript example
of a graph that mixes deterministic and model nodes would also help.

#### How was your onboarding experience (getting from zero to hello world)

Short. The graphs went from nothing to running in AgentCore within one pull
request (2026-10-01), and the same graph code runs in tests with a stand-in
model and in AgentCore unchanged.

#### Would you build with these devices and services again?

**Yes.** It is the lightest way we found to keep models and rules in one
traceable flow, in TypeScript.

---

## 8. Amazon Rekognition

**Client:** `@aws-sdk/client-rekognition` 3.1150 (`DetectModerationLabels`); the
AWS CLI for video segment detection.

#### Which developer tools, apis and SDKs did you use and for what?

- **`DetectModerationLabels`** (taxonomy version 7) on every family photo before
  it is stored. A photo is refused at 80 % confidence in Explicit, Violence,
  Visually Disturbing or Hate Symbols. **The check fails closed**: an error,
  or no answer within 2 s, means the photo is not sent
  (`services/mcp-server/src/photos/moderation.ts`).
- **Video segment detection**, offline, on each published film: shots, fades
  through black and the start of the end credits. With ffmpeg's silences,
  these are what the "calm points" are chosen from
  (`scripts/calm-points/measure.sh`; [the map](https://rogerjeasy.github.io/wick/calm-points/)).

#### What worked well?

- The **parent/level structure of the moderation taxonomy** let us refuse four
  top-level categories and let the rest through (a glass of wine at Christmas
  is a mantelpiece photo).
- **Segment detection's `TechnicalCueFilter`** (black-frame thresholds) and
  `ShotFilter` were precise enough to drive a product rule. It cost about ten
  cents a film.

#### What needs work?

No friction-log entry. One cost of the workflow: video analysis reads only from
S3, so each film had to be copied into a bucket for the length of its job and
removed again (`measure.sh`).

#### How was your onboarding experience (getting from zero to hello world)

Short for both: one call for moderation, and `start-segment-detection` /
`get-segment-detection` from the CLI for the films.

#### Would you build with these devices and services again?

**Yes.** "Calm points are measured, never guessed" is one of Wick's rules, and
segment detection is what makes it true.

---

## 9. Amazon Polly

**Client:** `SynthesizeSpeech` from the edge Lambda
(`services/edge-device/lambda/speech.mjs`), `Engine: 'neural'`.

#### Which developer tools, apis and SDKs did you use and for what?

"Read to me": the Play key reads the card on screen aloud, in the resident's
language (Amy, en-GB; Lupe, es-US), from SSML built from exactly what the screen
shows. The mp3 is kept in S3 under `tts/` for one day, keyed by a hash of the
language, voice and words, so the same card is made once (`infra/speech.tf`).

#### What worked well?

Neural voices in both languages with one call. SSML gave pauses between a
card's sentences and its buttons. Readings were made, and played to their end
on the Vega simulator, the Fire OS emulator and the browser television
(README). On the simulators the sound itself cannot be listened to.

#### What needs work?

No friction-log entry. `SynthesizeSpeech` has no resource type to scope an IAM
grant to, so the grant is `*` (`infra/speech.tf`).

#### How was your onboarding experience (getting from zero to hello world)

Short: one call returns the mp3.

#### Would you build with these devices and services again?

**Yes.** Being read to is an accessibility feature, not a novelty, for someone
whose eyesight is going.

---

## 10. Amazon Translate

**Client:** `@aws-sdk/client-translate` 3.1150 (`TranslateText`).

#### Which developer tools, apis and SDKs did you use and for what?

The resident's television can speak Spanish. Wick's own sentences come from a
hand-written phrasebook. Only free text (a family note, the door's sentence,
the week's paragraph) goes to Translate, on its way to her television, after
the English checks have passed. The translation is never stored in the card
(`services/agent/src/language/translate.ts`, called only from `egress.ts`).

#### What worked well?

Fast and accurate for short, plain sentences, which is all Wick sends. Seen
working on the Fire OS emulator and the browser television against the
deployed stack (README).

#### What needs work?

**`<span translate="no">` changes the grammar around the protected word.** A
name marked "do not translate" comes back with an article, as if it were a
thing: "con el Rose". The same sentence sent unmarked comes back right, with
the name untouched. We saw both live on 2026-10-13, and they are kept as test
cases in `translate.test.ts`. So Wick sends text plain, and marks names only if
a name did not survive. A do-not-translate that keeps a proper noun's grammar
would remove the second call.

#### How was your onboarding experience (getting from zero to hello world)

Short: one call per text.

#### Would you build with these devices and services again?

**Yes.** With a phrasebook for anything she consents by, and Translate only for
free text.

---

## 11. Amazon Transcribe (streaming)

**Client:** `@aws-sdk/client-transcribe-streaming` 3.1150
(`StartStreamTranscriptionCommand`).

#### Which developer tools, apis and SDKs did you use and for what?

Ask by voice in the family app. The page records one utterance (ten seconds at
most) as 16 kHz 16-bit PCM and POSTs it to `/api/hear`. The server streams it to
Transcribe in 8 KB `AudioEvent`s and asks the words exactly as if typed. Nothing
is stored or logged (`services/mcp-server/src/hear/`).

#### What worked well?

The SDK's async-iterable audio stream is simple to feed from a buffer, and a
streaming transcription keeps nothing, which matters here. The route is built
and tested, and was seen working in a local browser against a stand-in for
Transcribe. **It has not yet been seen working against the deployed stack**
(README).

#### What needs work?

- (FL-032) The natural design (browser streams over a socket, partial
  transcripts while she speaks) is not possible behind App Runner, which has
  no WebSockets (see §16). Transcribe accepts a presigned WebSocket URL a
  browser could use directly, but the browser would then have to frame audio
  in AWS's binary event-stream encoding itself, and the docs leave that to the
  SDK. A small browser reference for that framing would open the direct path.
- `StartStreamTranscription` has no resource type in the Service Authorization
  Reference, so the IAM grant is `*` (`infra/mcp.tf`).

#### How was your onboarding experience (getting from zero to hello world)

Short: the route was built and tested in one day (2026-10-14). The design time
went on App Runner (FL-032).

#### Would you build with these devices and services again?

**Yes.** For a family member typing on a phone, speaking a question is the
easier way in.

---

## 12. AWS Lambda

**What:** 22 functions, `nodejs22.x` on arm64; one container image (the Watch
live bridge). The hand-written edge functions are `.mjs` zips; the agent
functions are esbuild bundles (`npm run build:lambda`).

#### Which developer tools, apis and SDKs did you use and for what?

Everything at the edge: the Ring webhook and OAuth, the hourly Ring refresh,
pairing, the WebSocket and IoT handlers, the IoT custom authorizer, the Door
agent, card presses, the Narrator, the `/status` page, the shims into
AgentCore, and the live bridge (Ring WHEP → werift → ffmpeg → HLS to S3).

#### What worked well?

- **Ring's five-second budget is easy to meet**: verify HMAC, one idempotency
  write, `PutEvents`, `200` (`infra/edge.tf`).
- **Outbound UDP works.** That is why the live bridge runs in Lambda and not in
  AgentCore (FL-017).
- **Container images** carried ffmpeg and werift for the bridge with no layer
  juggling.
- **The SDK v3 is in the Node.js 22 runtime**, so `@aws-sdk/*` stays external
  and the bundles stay small.

#### What needs work?

No friction-log entry. The first invocation after a deploy includes a cold
start: the first door card on the VVD took about 4.9 s end to end in that case
(FL-014).

#### How was your onboarding experience (getting from zero to hello world)

Familiar. Terraform replaced CDK on the second day (2026-09-15), and every
function since has been one resource block.

#### Would you build with these devices and services again?

**Yes.**

---

## 13. Amazon API Gateway (HTTP and WebSocket)

#### Which developer tools, apis and SDKs did you use and for what?

An **HTTP API** for Ring's webhook and OAuth URLs, pairing, Watch live and
`/status` (`infra/edge.tf`, `pairing.tf`, `live.tf`). A **WebSocket API**
(`$connect`, `$disconnect`, `$default`) as every television's fallback channel,
and the only one the Vega background service uses. The server pushes cards with
`@aws-sdk/client-apigatewaymanagementapi` (`infra/transport.tf`,
`services/edge-device/lambda/route.mjs`).

#### What worked well?

- The WebSocket API was the first channel that put a real card on the VVD
  (2026-09-30, FL-014), and it has stayed the dependable fallback since.
- The device token travels in the `$connect` query string, which every
  JavaScript WebSocket client can send.
- The HTTP API's access log proved, without doubt, that Ring had never called
  our URLs (FL-002).

#### What needs work?

No friction-log entry.

#### How was your onboarding experience (getting from zero to hello world)

Short for both. The WebSocket API and its three Lambdas were deployed on
2026-09-16, the third day.

#### Would you build with these devices and services again?

**Yes.**

---

## 14. AWS IoT Core

**What:** custom authorizer (Lambda), MQTT over WSS, two topic rules (presence
lifecycle events and the television's events), `iot:Publish` from the senders;
client `mqtt.js` 5.16 (`infra/iot.tf`).

#### Which developer tools, apis and SDKs did you use and for what?

The television's first-choice channel. It connects with the one credential it
holds, a device-bound JWT, which the custom authorizer checks before granting
that television its own three topics (`iot-authorize.mjs`, `iot-policy.mjs`).
Presence events mark which channel each television is on, so the senders know
whether to publish or to use the WebSocket.

#### What worked well?

- **A custom authorizer means no certificates on the television**, which
  matters on a device with no documented hardware keystore. The policy it
  returns can name exactly three topics.
- `mqtt.js` connected from Vega and from Fire OS at the first attempt. Cards
  went down, replies went up, and with MQTT refused the app fell back to the
  WebSocket (FL-009 update).

#### What needs work?

- **The ALPN rule is one sentence on one page** (FL-024). "If you pass
  credentials through the MQTT connect message, the ALPN and SNI TLS extensions
  are required" means that no browser, React Native or Vega client can use
  username/password over WSS, because a JavaScript WebSocket cannot set ALPN.
  Our first client could never have connected, and a refused connection gives
  no reason. The token has to go in the query string.
- **Presence: which field identifies a connection?** (FL-009 update). A client
  that reconnects into its persistent session keeps its `sessionIdentifier`,
  and connect/disconnect events "might be sent out of order". So the guard
  "clear the row only if it still names the session that ended" does nothing.
  `versionNumber` is what tells two connections apart, but it is documented as
  a way to order events, and `timestamp` is "an approximation".

#### How was your onboarding experience (getting from zero to hello world)

IoT Core was built and run on both simulators on one day (2026-10-11), once
FL-024 was understood. With the token in the query string, the authorizer, the
rules and the publish worked as documented.

#### Would you build with these devices and services again?

**Yes.** With the two documentation fixes above.

---

## 15. Amazon EventBridge and EventBridge Scheduler

#### Which developer tools, apis and SDKs did you use and for what?

**EventBridge**: a custom bus (`wick`) carrying Ring events to the Door agent
and card presses to the card-action function. A scheduled rule runs the weekly
Narrator (`cron(0 20 ? * SUN *)`) and another the hourly Ring refresh.
**Scheduler**: one-time schedules for "Hold for Sarah". A schedule calls the
card-action function three minutes later and deletes itself
(`ActionAfterCompletion = DELETE`). It carries a request id and a step, never a
name (`infra/reach.tf`, `services/agent/src/agents/reach/timer.ts`).

#### What worked well?

- Event patterns on `source` keep the stand-in doorbell honest: the Door
  agent's rule passes `wick.ring` and nothing else, so nothing on the bus can
  put a demo ring in front of it (`infra/agent.tf`).
- **Self-deleting one-time schedules** are the right tool for "if nobody
  answers in three minutes": nothing of ours runs during the wait.

#### What needs work?

Neither can target an AgentCore Runtime, so a press that needs the agent plane
goes bus → Lambda shim → `InvokeAgentRuntime` (`infra/card-action.tf`, "a shim,
because EventBridge cannot target an AgentCore Runtime").

#### How was your onboarding experience (getting from zero to hello world)

Short for both. The Scheduler's execution role and `ActionAfterCompletion` were
clear from the API reference.

#### Would you build with these devices and services again?

**Yes.**

---

## 16. AWS App Runner and Amazon ECR

#### Which developer tools, apis and SDKs did you use and for what?

**App Runner** runs the Wick server (`services/mcp-server`): the MCP endpoint,
the family app's API, OAuth, the assistant, photo upload and `/api/hear`. It has
an instance role for DynamoDB, Bedrock, Rekognition, Translate, Transcribe and
two Lambda invocations (`infra/mcp.tf`). **ECR** holds three arm64 images (the
agents, the live bridge and the server), with lifecycle policies.

#### What worked well?

- One container behind a public HTTPS URL with no load balancer, VPC or
  certificate to manage. That suited a stateless MCP server.
- An environment-variable change redeploys automatically.
- ECR lifecycle policies kept three repositories tidy with no attention.

#### What needs work?

- **No WebSockets, and the developer guide does not say so** (FL-032). The
  answer is in a closed roadmap issue (`aws/apprunner-roadmap#13`, "We don't
  have native support for web sockets at this point"). No request-body limit is
  documented anywhere we could find. The same thread says App Runner closed to
  new customers on 2026-04-30; a line on the service's own pages saying so
  would help anyone choosing it.
- **The service URL cannot be passed to the service itself.** OAuth metadata
  needs the issuer URL at start-up, and App Runner assigns `service_url` only
  once the service exists. So the first deploy is two `terraform apply` runs
  (`infra/mcp.tf` header). A custom domain avoids it, but not for a first
  deploy.

#### How was your onboarding experience (getting from zero to hello world)

The MCP server was deployed on App Runner on 2026-09-19, five days after the
first commit. The issuer-URL step and FL-032 came later.

#### Would you build with these devices and services again?

**App Runner: no, not for a new project**, since it is closed to new customers
and has no WebSockets. We would start on Amazon ECS or on Lambda with a
function URL. **ECR: yes.**

---

## 17. Amazon DynamoDB

#### Which developer tools, apis and SDKs did you use and for what?

One table, `wick`, single-table design: households and televisions
(`HH#…`/`DEV#…`, `FTV#…`), cards, the timeline, the rhythm baseline, weeks
(`NARR#…`), OAuth clients, codes and tokens, memberships, and webhook
idempotency. Every MCP tool is one `GetItem` or `Query` (`infra/core.tf`).

#### What worked well?

Single-digit-millisecond reads made a sub-500 ms tool possible without a cache.
A conditional write (`attribute_not_exists`) gives idempotency on Ring's
`request_id` (`services/edge-ring/lambda/webhook.mjs`). `prevent_destroy` and
point-in-time recovery in Terraform protect the one table that matters.

#### What needs work?

No friction-log entry.

#### How was your onboarding experience (getting from zero to hello world)

Immediate.

#### Would you build with these devices and services again?

**Yes.**

---

## 18. Amazon S3 and Amazon CloudFront

#### Which developer tools, apis and SDKs did you use and for what?

- **S3**: the door's media bucket, with lifecycle deletion of Ring imagery after
  one day, so the privacy rule is kept by the bucket and not by code
  (`infra/core.tf`, `AGENTS.md` INV-3). Polly readings under `tts/` for one day.
  A photos bucket whose lifecycle follows a `state` tag the resident's press
  sets (`infra/photos.tf`). The films' HLS, and two static sites. Presigned URLs
  for photos (an hour) and readings (five minutes).
- **CloudFront** with Origin Access Control in front of four private buckets:
  the films, Watch live's HLS, the family app and the browser television.

#### What worked well?

- **Lifecycle rules, including tag-filtered ones**, let privacy promises ("door
  imagery is gone within a day", "a photo she let go of is gone within a day")
  be enforced by infrastructure.
- **OAC with HTTPS-only behaviours.** Vega's player refuses cleartext HLS
  silently (FL-016), so serving everything through CloudFront over HTTPS was
  the fix.

#### What needs work?

No friction-log entry. One gotcha worth a line in the docs: without
`s3:ListBucket`, a missing object answers `403`, not `404`, so "is this reading
cached?" has to treat any failure as "not there" (`infra/speech.tf`).

#### How was your onboarding experience (getting from zero to hello world)

Familiar.

#### Would you build with these devices and services again?

**Yes.**

---

## 19. AWS Secrets Manager

#### Which developer tools, apis and SDKs did you use and for what?

Each household's Ring tokens in its own secret (`wick/ring/tokens/<householdId>`),
read only for the home being acted for. Refresh has one owner, the hourly
`wick-ring-refresh` Lambda, because Ring may rotate the refresh token and two
writers would unlink an account. Also the pairing JWT signing key and the Web
Push (VAPID) key pair (`services/connectors/ring/src/secrets.ts`, `infra/edge.tf`,
`pairing.tf`, `push.tf`).

#### What worked well?

Per-secret IAM let each function read exactly the secrets it needs. Terraform
manages the containers and never the contents, which are seeded once by
`infra/bootstrap/*.sh`.

#### What needs work?

No friction-log entry.

#### How was your onboarding experience (getting from zero to hello world)

Immediate.

#### Would you build with these devices and services again?

**Yes.**

---

## 20. Amazon Cognito

#### Which developer tools, apis and SDKs did you use and for what?

A user pool holds each family member's email and password. The Wick server's
sign-in pages hand them to Cognito (`services/mcp-server/src/accounts/identity.ts`),
and everything it issues afterwards names the person Cognito vouched for. The
resident has no account at all: her paired television is her identity
(`infra/accounts.tf`).

#### What worked well?

Sign-up, email confirmation and password checks are someone else's problem,
behind one SDK client (`@aws-sdk/client-cognito-identity-provider` 3.1146).

#### What needs work?

No friction-log entry. Our design choice explains a gap, though: the MCP server
is still its own OAuth authorization server, because an Alexa+ add-on (and MCP
clients generally) expect dynamic client registration and Protected Resource
Metadata, which we did not find in Cognito user pools. If Cognito offered both,
an MCP server could use it as its authorization server directly.

#### How was your onboarding experience (getting from zero to hello world)

Short. A pool and a client in Terraform, and `SignUp`, `ConfirmSignUp` and
`InitiateAuth`.

#### Would you build with these devices and services again?

**Yes.**

---

## 21. Amazon CloudWatch Logs, AWS IAM and GitHub OIDC

#### Which developer tools, apis and SDKs did you use and for what?

**CloudWatch Logs**: a log group per function, with retention set in
Terraform; structured logs that never carry a photo's labels, a voice's words
or a household's data. **IAM**: one role per function, written by hand, scoped
to exactly the actions and resources it calls. **GitHub OIDC**: CI deploys
through `aws-actions/configure-aws-credentials` with a role that trusts only
tokens GitHub signed for this repository (`infra/github-oidc.tf`).

#### What worked well?

- CloudWatch was the evidence behind several friction entries. For example,
  zero calls from Ring to any of our URLs, across every log group, while the
  console read "1/10 accounts connected" (FL-002).
- OIDC means **no AWS key exists in CI**: nothing to leak or rotate.

#### What needs work?

- Three of the AI services we call have no resource type for their main action
  (`polly:SynthesizeSpeech`, `translate:TranslateText`,
  `transcribe:StartStreamTranscription`), so those grants are `*`. Resource-
  or condition-level scoping (for example by language pair or voice) would
  let least privilege go all the way down.
- When we add a new AWS service, the CI role needs new permissions first, and
  CI cannot grant itself those. So every new service starts with a laptop
  `terraform apply` of `infra/github-oidc.tf`. That is correct, but it is a
  step to plan for.

#### How was your onboarding experience (getting from zero to hello world)

OIDC was set up on the second day (2026-09-15), and has changed since only to
add permissions for new services.

#### Would you build with these devices and services again?

**Yes.**

---

## Other tools used

Not Amazon's, listed so the picture is complete.

| Tool | What for |
|---|---|
| Terraform (`>= 1.10`, AWS provider `~> 6.0`) | All infrastructure (`infra/`) |
| GitHub Actions | CI (`npm run verify`, property tests), deploys, the Fire OS APK |
| `mqtt.js` 5.16 | The MQTT client on both television builds |
| werift 0.24.4 + ffmpeg | Ring WHEP → HLS in the live bridge Lambda |
| `react-native-tvos`, `react-native-video` | The Fire OS build |
| MCP Inspector | Exercising the MCP server before the family app existed |
| Claude Code | The coding agent used to build Wick (design notes under `docs/superpowers/`); Ring's Appstore Knowledge MCP server was configured for it at project scope (`.mcp.json`) |

Kiro was not used.

---

## Feature requests

Fifteen requests, each from a friction-log entry's "Suggestion". Priority is how
much it matters to Wick: **Critical** (blocks a core part of the product),
**Important** (costs a feature or forces a workaround with a cost),
**Nice-to-have** (saves time or removes a trap).

| # | Request | Priority |
|---|---|---|
| 1 | Alexa+ MCP Toolkit: a development sandbox for any registered developer | Critical |
| 2 | Vega: a supported way for an app to show something while another app is in front, and a documented service lifetime | Critical |
| 3 | Vega Virtual Device: storage that persists | Critical |
| 4 | Ring partner linking that says what failed | Critical |
| 5 | Ring Developer Playground: "press the doorbell" and "person detected" buttons | Important |
| 6 | Ring Developer Playground: a simulated Chime | Important |
| 7 | Vega: hand a value to a service you start | Important |
| 8 | Ring media: a published request schema and a "not ready yet" error | Important |
| 9 | Fire OS: an emulator image, and a key-event table for React Native | Important |
| 10 | Vega Media Controls: a test client and a rule for keys heard twice | Important |
| 11 | Vega: WebRTC for React Native, and a WebView that runs on the simulator | Important |
| 12 | AgentCore Runtime: documented egress, and UDP as an opt-in | Important |
| 13 | Bedrock: keep retired models visible, and name the successor | Nice-to-have |
| 14 | App Runner: document WebSockets and the request-body limit | Nice-to-have |
| 15 | IoT Core: say which clients can authenticate which way, and which field identifies a connection | Nice-to-have |

**4 Critical, 8 Important, 3 Nice-to-have.**

### 1. Alexa+ MCP Toolkit: a development sandbox for any registered developer (Critical)

**Description.** Let any registered Amazon developer run `alexa-ai configure →
new mcp → deploy` against a development-stage add-on that only their own
account can reach, and gate certification and publishing instead. Until then,
put "select partners only" at the top of the Overview and QuickStart, and
publish an eligibility criterion and a request form (FL-001).

**Why it matters to Wick.** Alexa+ is how the distant family is meant to reach
Wick: "Alexa, how's Mum been this week?". The MCP server is built and deployed
to the toolkit's published requirements and the add-on package passes its
checks, but no family member can use it from an Echo. Today it is reached
through a simulated surface.

### 2. Vega: a supported way to show something while another app is in front, and a documented service lifetime (Critical)

**Description.** Document the route that works on the simulator: start your own
service with `Linking.openURL('pkg://<service id>')` and post a toast from it,
naming the render template as the channel. Fail a toast whose channel name is
not a template instead of returning an id and drawing nothing. Name the
privilege in `No Permission Error`. Correct the "doesn't work on the VVD"
statement, and fill in the empty "Manually launch with this command:" line.
State whether a service is restarted after a reboot or after the platform
reclaims it, and give an app a way to ask for that (FL-022, FL-014, FL-026).

**Why it matters to Wick.** "Someone is at the front door" must reach her while
she watches another app. Today it does, on the simulator, by a route found in
the device log. Nothing restarts the service after a reboot until Wick is opened
once, and how long the platform keeps it alive is unknown beyond the five
minutes we watched.

### 3. Vega Virtual Device: storage that persists (Critical)

**Description.** Make `kepler-file-system` writes succeed on the VVD (or say
which provisioning step is missing). Turn "Application data root path is not
set" into an install or launch error, not a buried runtime log line (FL-013).

**Why it matters to Wick.** Nothing on the simulator survives a restart: the
pairing token, the device id, the sync cursor. A family member's television
has to be paired again on every launch. Worse, it forced an accepted security
exception: a token refresh without proof of possession, bounded by a short TTL
and a cooldown (`AGENTS.md`, INV-1). On the only Vega device most developers
have, a platform bug became a security trade-off in application code.

### 4. Ring partner linking that says what failed (Critical)

**Description.** Return a real OAuth error (`error=unauthorized_client`,
redirected to the registered URI) when an app is not allowlisted for
partner-initiated OAuth, and validate `client_id` before the sign-in wall.
Show allowlist status in the console with a way to request it. Say what "1/10
accounts connected" counts. Put the completion `PATCH` in the linking
walkthrough, and when it is refused, return the from/to status and the reason
(FL-002, FL-003, FL-004, FL-010).

**Why it matters to Wick.** Each home links its own Ring account from the family
app. Four silent failures became four friction entries, and the
integration still cannot be completed for a private app. So Ring never sends a real webhook to
Wick, and every door event in the demo comes from a signed stand-in.

### 5. Ring Developer Playground: "press the doorbell" and "person detected" buttons (Important)

**Description.** On each Playground device, buttons that send the real, signed
`button_press` and `motion_detected` webhook (with a chosen `sub_type`) to the
registered URL. Failing that, a signed-event CLI
(`ring webhook send --type button_press --device <id>`). And one line on the
Playground page listing what it does not simulate (FL-027).

**Why it matters to Wick.** The door is Wick's first pillar, and "the visit,
witnessed" is built from a press on arrival and a person seen on leaving. None
of it can be shown on anything Ring provides. We sign Ring's documented payloads
ourselves, and have to explain that in the README and the video.

### 6. Ring Developer Playground: a simulated Chime (Important)

**Description.** Add a simulated Chime to Playground accounts, with app audio
slots populated and a visible "played" indication, and document how audio gets
into an app's slot (FL-019, FL-006).

**Why it matters to Wick.** "Ring the hallway chime" (one button on the door
card, so whoever else is home knows someone is at the door) is built and
contract-tested, but cannot be demonstrated. It is the one Partner API
capability that lets a television act in the home rather than only watch it.

### 7. Vega: hand a value to a service you start (Important)

**Description.** Pass the `pkg://` URI's query (or explicit launch data) to
`onStartService` and document its size limit. Deliver a second launch to a
running singleton service as a message. Document which storage an app and its
service share. Make `Linking` in a headless runtime fail as a catchable error.
State `onStartService`'s time limit (about eight seconds today) in the README
(FL-029, FL-026).

**Why it matters to Wick.** The background service needs the token the app
already holds. With no way to pass it, Wick hands it over through its own server
with a 90-second, single-use, address-bound window: a second accepted security
exception (`AGENTS.md`, INV-1).

### 8. Ring media: a published request schema and a "not ready yet" error (Important)

**Description.** Publish the request body of `POST /media/image/download` with an
example, and say plainly that it retrieves recorded history. Return `400`, not
`403 Cannot authorize`, for a malformed body. Replace `422 GRECO_NO_VALID_KEY`
with a documented `MEDIA_NOT_READY` and a `Retry-After`, and publish the
settling time after an event (FL-005, FL-008).

**Why it matters to Wick.** The doorbell's still is the most important picture
on the door card. Three of five first attempts fail, so Wick retries four times,
two seconds apart, and checks magic bytes so a JSON error is never shown as a
picture.

### 9. Fire OS: an emulator image, and a key-event table for React Native (Important)

**Description.** Publish a Fire OS emulator image, or document how the Android TV
emulator differs from a Fire TV for input, focus and notifications. In the Fire
TV React Native guidance, add a per-button table of `eventType` and
`eventKeyAction` for a short press, a long press and a repeat, on Fire OS and
on Vega, with the focus requirement. Document `enableKeyDownEvents`. Give
`adb shell input` a real key hold (FL-025, FL-028).

**Why it matters to Wick.** "Hold OK for two seconds to ask someone to ring you"
first shipped on Fire OS taking a short press for a hold, and the film's pause
key did nothing until the player was given focus. Both failed silently, and
both were found on an emulator that is not Fire OS.

### 10. Vega Media Controls: a test client and a rule for keys heard twice (Important)

**Description.** Ship `vega device media-control <appId> play|pause|toggle|seek`,
or a sample client. Document, per key, whether the remote's media keys arrive
as key events, session commands or both, with a flag for "this app handles its
own media keys". Name the field in conversion errors, and accept an empty list
as "no session" (FL-031).

**Why it matters to Wick.** Her film obeys "Alexa, pause" through the media
session, and a pause is when a waiting note may appear. We could not send a
voice command to the simulator, so that path is built but unexercised, and
every key press is filtered against an echo 60 ms later.

### 11. Vega: WebRTC for React Native, and a WebView that runs on the simulator (Important)

**Description.** Fix (or document) the `@amazon-devices/webview` 4.0.2 crash on
mount on the VVD, which also happens with the unmodified `vegaWebview` template,
and add `com.amazon.webview.renderer_service` to the setup page. Ship a WebRTC
module for Vega React Native, or confirm `RTCPeerConnection` in WebView on
hardware (FL-015).

**Why it matters to Wick.** Ring's live view is WebRTC. Without a client on the
television, Watch live goes through a cloud bridge (WHEP → HLS) that adds about
five seconds and a Lambda per session.

### 12. AgentCore Runtime: documented egress, and UDP as an opt-in (Important)

**Description.** Document which protocols and ports PUBLIC network mode permits.
If UDP is blocked, fail the send with an error rather than dropping it silently.
Offer UDP egress as an opt-in, or document VPC mode with NAT as the way to get
it (FL-017).

**Why it matters to Wick.** The live view was designed to run beside the graph
that gates it, in the household's own microVM. It had to move to a separate
Lambda, so the session's isolation no longer covers the media.

### 13. Bedrock: keep retired models visible, and name the successor (Nice-to-have)

**Description.** Keep retired models in `ListFoundationModels` with
`modelLifecycle.status` (`LEGACY`/`EOL`) and a date. Name the successor in the
end-of-life error and in the model's documentation. Related: say in the model
list whether the calling account can actually invoke a model, since Claude
Sonnet 5 was listed for us and refused every call (FL-030; commit `04b55bd`).

**Why it matters to Wick.** The stand-in doorbell's pictures were meant to be made
with Amazon Nova Canvas. A third-party model did the job, but finding out cost
time, and the weekly narrative failed silently for days on a listed model.

### 14. App Runner: document WebSockets and the request-body limit (Nice-to-have)

**Description.** Say in the developer guide, beside "HTTP 1.0 and HTTP 1.1",
that WebSocket upgrades and HTTP/2 to the container are not supported, and
publish the largest request body the front end passes (FL-032).

**Why it matters to Wick.** Ask by voice was designed around these two facts,
and found them only in a closed GitHub issue and from our own 1.5 MB uploads.
A family member sees her words only after she stops speaking.

### 15. IoT Core: say which clients can authenticate which way, and which field identifies a connection (Nice-to-have)

**Description.** On the custom-authentication page: "From a browser, React
Native or any WebSocket API that does not expose ALPN, pass credentials in the
query string or headers." Let the authorizer's refusal reach the client with a
reason, at least in development. On the lifecycle-events page, say which field
identifies a connection as opposed to a session, and show the rule a presence
table needs (FL-024, FL-009 update).

**Why it matters to Wick.** Our first television client could never have
connected. Our first presence rule could clear a live television's row after a
quick reconnect, which would send its cards to a channel it is no longer on.
