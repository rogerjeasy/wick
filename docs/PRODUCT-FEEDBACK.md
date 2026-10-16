# Product feedback

Wick is a Fire TV app for an older person living alone, with a Ring doorbell at
her door and an Alexa+ add-on for her family. One developer built it from
14 September 2026, without any hardware: the television is the Vega Virtual
Device and an Android TV emulator running the Fire OS build, the doorbell is
Ring's Developer Playground, and Alexa+ is a simulated surface in front of a
real MCP server. Everything in between runs on AWS in `us-east-1`.

Below, each tool gets the five answers Devpost asks for. The evidence is in
[`FRICTION.md`](../FRICTION.md): 44 entries, each written when the problem
happened, cited here as FL-0xx. Feature requests, with a priority for each, are
at the end.

**Contents.** [AWS services used, and how](#aws-services-used-and-how) ·
[Vega OS](#1-vega-os) · [Fire OS](#2-fire-os) · [Ring](#3-ring-partner-api-and-developer-playground) ·
[Alexa+ and MCP](#4-alexa-add-ons-and-mcp) · [Bedrock](#5-amazon-bedrock) ·
[AgentCore](#6-amazon-bedrock-agentcore-runtime) · [Strands](#7-strands-agents-sdk) ·
[AI services](#8-rekognition-polly-translate-and-transcribe) ·
[The rest of AWS](#9-the-rest-of-the-aws-stack) · [Other tools](#other-tools) ·
[Feature requests](#feature-requests)

---

## AWS services used, and how

Everything is in Terraform under [`infra/`](../infra) and called with the AWS SDK
for JavaScript v3. CI deploys over GitHub OIDC and holds no AWS keys.

| Service | What Wick does with it |
|---|---|
| **Amazon Bedrock** | **Nova Lite** writes one sentence about who is at the door, or nothing. **Claude Sonnet 4.5** is the family's assistant and writes the Sunday brief from numbers the code already counted. A **Bedrock Guardrail** (denied topics, PII, contextual grounding) checks both, and the brief calls `ApplyGuardrail` with the counted facts as the grounding source. **Stable Image Ultra** made the stand-in doorbell's four pictures, once. |
| **Bedrock AgentCore Runtime** | Three agents: the door's Strands graphs (one session per household, each home in its own microVM), the family assistant (a Strands agent, one session per member per home), and the Sunday brief (a Strands Graph). |
| **Bedrock AgentCore Memory** | The family assistant's conversations, including a write waiting for the member's yes, as Strands snapshots (Wick's own session storage, also a pull request to Amazon's AgentCore SDK); and the member's own words long-term, through a user-preference strategy. Deleted with the member's account. |
| **AWS Step Functions** | A visit errand as one execution over days: wait for the reminder, remind her, wait for the doorbell on a task token the door's event redeems, or time out; then tell the member. |
| **Amazon SQS** | The Sunday brief's fan-out: one message per home, a dead-letter queue, partial batch failures. |
| **AWS Lambda** | 22 functions: the Ring webhook and OAuth, pairing, both television channels, the IoT authorizer, the door agent, card presses, the weekly narrator, and the live-view bridge. |
| **Amazon API Gateway** | An HTTP API for Ring, pairing and Watch live, and a WebSocket API that every television can fall back to. |
| **AWS IoT Core** | The television's main channel, MQTT over WSS, with a custom authorizer that checks the television's own token. |
| **Amazon EventBridge and Scheduler** | The event bus, the weekly and hourly schedules, and the three-minute wait in Hold for Sarah. |
| **AWS App Runner and Amazon ECR** | The Wick server: the MCP endpoint, OAuth, the family app's API and the assistant. ECR holds the three container images. |
| **Amazon DynamoDB** | One table for everything, so every family tool is a single read. |
| **Amazon S3 and CloudFront** | Door pictures deleted after one day by bucket rule, family photos, the films, and the static sites. |
| **AWS Secrets Manager** | Each home's Ring tokens in a secret of its own, plus the pairing and push keys. |
| **Amazon Cognito** | Family members' email and password. |
| **Amazon Rekognition** | Checks a family photo before it is sent; measured the quiet cuts in each film for calm points. |
| **Amazon Polly** | Reads the card on screen aloud when she presses Play. |
| **Amazon Translate** | Turns a family note, the door's sentence and the week into her language. |
| **Amazon Transcribe** | Turns a family member's spoken question into words. |
| **CloudWatch, IAM and OIDC** | Logs and alarms, one least-privilege role per function, and keyless deploys. |

---

## 1. Vega OS

*Vega SDK 0.24, Vega CLI 1.3.4, the Vega Virtual Device on Apple silicon, React
Native 0.83 with `react-native-kepler` 4.0.1.*

**Used for:** her television (`apps/tv-vega`): the home screen, the player, the
cards, and a background service. We used `headless-task-manager` for the
service, the parts of react-native-kepler's `useToastKepler` for a toast over
another app, `kepler-media-controls` so a platform pause counts as a natural
break, `react-native-w3cmedia` for films and the door's live view,
`kepler-content-personalization` to report what she watches as she watches it,
and `kepler-file-system` for the pairing token.

**Worked well:**
- The SDK is on npm, so the Vega app lives in an ordinary workspace with type
  checks and tests (FL-007).
- The `helloWorld` template built and ran on the simulator first time, and
  `vega project doctor` caught real manifest errors early (FL-011).
- `vega device start-log-stream` solved every hard problem we had.
- `inputd-cli button_press --holdDuration` made testing a two-second hold of
  OK a five-minute job (FL-028).
- Once found, the background service and system toast are a good design: the
  door reaches her even when another app is in front (FL-022).
- `mqtt.js` ran inside Vega's React Native with no changes (FL-009).

**Needs work:** the common thread is calls that are accepted and then silently
do nothing.
- Showing anything outside your app is undocumented, and the docs say it can't
  be done. A toast with the wrong channel name returns an id and draws nothing
  (FL-022, Critical).
- Nothing says what starts a service, a service's start is killed after about
  eight seconds, and you can't hand it any value (FL-014, FL-026, FL-029).
- On the simulator, `kepler-file-system` keeps nothing, so every launch starts
  unpaired. That forced a security trade-off in our own code (FL-013, Critical).
- Remote key names on the simulator differ from the documented ones, and a
  wrong name compiles fine (FL-021).
- A cleartext video URL shows a black screen with no error, and a missing
  manifest service fails every decode with a vague error (FL-016, FL-018).
- Media sessions deliver Play/Pause twice, and the simulator can't send a voice
  command, so "Alexa, pause" can't be tried without a Fire TV (FL-031).
- WebView crashes on the simulator, and there's no WebRTC module, so Ring's
  live video needs a cloud bridge (FL-015).
- Content Personalization's reports are easy to see taken (the platform logs
  `reportNewPlaybackEvent called` and `completed successfully`), but not where
  they go: Continue Watching needs a catalogue integration, and an app whose
  films are in no Amazon catalogue gets no row and no error. The guide's
  `vega exec loggingctl` command fails; `vega device start-log-stream` works
  (FL-043).
- The only documented toast API is a React hook, `useToastKepler`, and the
  one place a toast is needed, a background service, has no React tree. We post
  with the hook's own parts from react-native-kepler's ToastKepler directory
  (FL-044).

**Onboarding:** hello world was quick. Getting our own app running took five
days, because each problem was silent and came one at a time: a missing icon, a
Metro resolver trap, a `react-native` version drift, and a file write that could
never succeed (FL-011 to FL-013).

**Build with it again?** Yes. Headless services, media sessions and the
credits position are exactly what a calm television app needs. We'd want the
"outside your app" route documented and simulator storage that persists first.

---

## 2. Fire OS

*`react-native-tvos` 0.83, `react-native-video` 6.19 (ExoPlayer), Android TV
emulator API 34.*

**Used for:** the same app on Fire OS. It bundles the Vega source with four
small adapters, adds an Android foreground service so the door can reach
her behind another app, and makes her film Android's `MediaSession`, so
"Alexa, pause" and the remote's media keys pass through the same rules as on
Vega. Amazon's `react-native-multi-tv-app-sample` was our
reference, and we contributed to it.

**Worked well:**
- Pairing, the home screen and playback worked first time on the emulator
  (FL-025).
- One codebase for two platforms is real: a parity test fails if the Vega code
  uses something an adapter doesn't offer.
- Headless JS inside a foreground service ran the Vega app's channel code
  unchanged.
- Android's `MediaSession` and `cmd media_session dispatch` made her film's
  session easy to prove on the emulator, and the same remote-key echo seen on
  Vega appeared and was handled by the same shared filter.
- CI builds the APK on every change.

**Needs work:**
- There is no Fire OS emulator, so we can't know whether a Fire TV Stick
  behaves like the Android TV image (FL-025).
- The remote does nothing until something has focus (FL-025).
- One OK button arrives in three different shapes, which isn't in the Fire TV
  React Native guide. Our first two-second hold mistook a short press for a hold
  (FL-028).
- Fire TV's Alexa and Vega's media controls send the same words as different
  commands: absolute seeks against relative skips, and no explicit start over.
  Neither can be sent without a device (FL-042).
- The no-heads-up-over-another-app rule is only in a 2021 blog post, with no
  exception for a doorbell. The emulator draws no third-party notifications, so
  we could only check ours in the system log (FL-035, FL-036).

**Onboarding:** fast for a React Native developer. It ran on the emulator the
day we started. The time went on input and focus.

**Build with it again?** Yes. Most Fire TVs in homes run Fire OS, and the first
version took one day from the same source. A Fire OS emulator image would help
most.

---

## 3. Ring Partner API and Developer Playground

**Used for:** the door. Webhooks put the door card on the television; a recorded
frame gives the card its picture; WHEP live view, bridged to HLS, gives Watch
live; the chime endpoint powers "Ring the hallway chime"; partner OAuth links
each home's account.

**Worked well:**
- The Playground's camera sits behind the real API, so we built against real
  responses from day one.
- WHEP is a clean standard: Ring answered in about 1.5 s and video played
  (SP-3).
- Validation errors that name the valid values are better than most APIs
  manage (FL-005).
- Amazon answered our Playground questions clearly in the hackathon forum.

**Needs work:**
- The Playground sends no doorbell or motion webhook and has no chime, so the
  event side of the API, the side a care product is built on, can't be tried
  without hardware (FL-027, FL-019). We sign Ring's documented payload
  ourselves, and demo homes use a labelled stand-in doorbell.
- A webhook's signature covers only the body, with no signed timestamp or
  documented replay window. We drop bodies older than five minutes, but the
  docs don't say whether Ring's late retries are stamped afresh (FL-041).
- Linking failed silently four times in a row: an unclear "1/10 accounts
  connected", an authorize page that accepts any client id and then shows
  "Something went wrong", an undocumented completion call, and a refusal that
  doesn't say why (FL-002 to FL-004, FL-010).
- The picture call has an undocumented request body, and a malformed one gets
  `403 Cannot authorize`. Three of five first attempts after an event fail with
  a JSON error where an image was expected (FL-005, FL-008).

**Onboarding:** the first API call took minutes with a Playground token. A
doorbell press reaching our server never happened, because nothing available to
us sends one.

**Build with it again?** Yes. A doorbell is the one sensor every home already
accepts, and live view, frames and the chime let a television act at the door.
The Playground needs "press the doorbell" and "person detected" buttons first.

---

## 4. Alexa+ add-ons and MCP

*MCP spec 2025-11-25, Streamable HTTP, `@modelcontextprotocol/sdk` 1.32.1.*

**Used for:** the family's side. An MCP server with 22 tools, its own OAuth 2.1
(PKCE, dynamic client registration), on App Runner. A complete add-on package
(`addon-package/`), checked in CI. A simulated Alexa+ surface (the family app),
because the add-on toolkit is partner-only.

**Worked well:**
- The quickstart's requirements are precise and testable. The 500 ms target
  shaped the design for the better: the week is written ahead, and every tool
  is one read.
- The SDK's OAuth router covers metadata, client registration and PKCE.
- Stateless Streamable HTTP means a redeploy interrupts no one.
- The manifest schema is documented in full, so we could check our package
  without Amazon.

**Needs work:**
- The toolkit is for select partners only, but only the docs home page says so.
  The rest reads as self-serve, with no criteria or waitlist (FL-001, Critical).
- The quickstart requires 2025-11-25, while the client page shows `2025-03-26`.
  Nothing says which versions a server must accept (FL-023).
- Our own miss: calls on an open connection meet 500 ms, but a new connection
  from Europe takes 0.7 to 1.1 s, because App Runner closes idle connections
  (issue #47, FL-033).

**Onboarding:** MCP itself was easy, with MCP Inspector working before any
client of ours existed. It was deployed five days after the first commit.
Alexa+ never reached hello world: we found the partner restriction only after
building to the quickstart.

**Build with it again?** Yes, the day there's a way in. A daughter asking
"How's Mum been this week?" is the most natural way into Wick. A sandbox for any
registered developer would make it buildable.

---

## 5. Amazon Bedrock

*`amazon.nova-lite-v1:0`, `us.anthropic.claude-sonnet-4-5-20250929-v1:0`,
`stability.stable-image-ultra-v1:1`; the Converse API.*

**Used for:** Nova Lite for the door's sentence, run as a Strands agent with a
validator that can drop it. Claude Sonnet 4.5 for the family's assistant and
the Sunday brief's writer and suggester. A Bedrock Guardrail on both, with
contextual grounding for the brief. Stable Image Ultra, once, for
the stand-in doorbell's pictures of nobody real.

**Worked well:**
- One Converse call shape for Nova and Claude, images included.
- Nova Lite is fast and cheap enough for every door event: the sentence arrived
  2.9 s after the ring (median of five, stand-in doorbell).
- Cross-region inference profiles, once the IAM grant covered both the profile
  and the model.
- Guardrails' contextual grounding is exactly the check a care product needs
  for a model-written paragraph: "is every sentence supported by these counted
  facts?" as one `ApplyGuardrail` call, with a threshold, in Terraform.

**Needs work:**
- Amazon's own image models (Nova Canvas, Titan Image v2) have reached end of
  life, vanished from the model list, and name no successor (FL-030).
- A Guardrail on Converse reads the user's question as well as the answer, and
  there is no switch to read the answer only: our "guessing her mood" topic
  refused "How has my mum been this week?". We guard each agent's reply with
  `ApplyGuardrail` instead. And the grounding threshold had to be measured:
  faithful paraphrase scored 0.68 to 1.00, invented facts 0.00 to 0.04, so 0.75
  refused honest prose. The relevance filter scored honest answers 0.07 to 0.15:
  "what the house saw" reads as not answering "how has she been", so we turned
  it off (FL-048).
- A Guardrail's denied topics and the grounding check are configured together
  but fail with one undifferentiated "intervened"; we read the assessment to
  tell a refused topic from an ungrounded sentence. A summary reason would help.
- A model can be listed and still refused: Claude Sonnet 5 was listed for our
  account and every call failed with `AccessDeniedException`. The weekly summary
  failed silently until we moved to Sonnet 4.5. The model list should say
  whether this account can call a model.

**Onboarding:** one Converse call with an image. The time went on the Sonnet 5
refusal and the inference-profile grant.

**Build with it again?** Yes. One API across vendors, IAM instead of API keys,
and data that stays in the account matter when the input is a stranger at
someone's door.

---

## 6. Amazon Bedrock AgentCore Runtime

**Used for:** one runtime with three kinds of work: the door's Strands graphs
(the session is the household, so each home runs in its own microVM), the
family assistant (one session per member per home), and the Sunday brief.
**AgentCore Memory** keeps the assistant's conversations and the member's own
words. We didn't use Identity or Gateway: Gateway's per-user OAuth flow has an
open bug in the TypeScript SDK (#37 there), and Wick's tools already take the
member's own token.

**Worked well:**
- Session-level microVM isolation is exactly right for one-home-per-session
  data, and cost one line of design.
- The container contract (`/ping`, `/invocations`) is small and easy to test
  locally.
- It's in the Terraform AWS provider, alongside everything else, Memory and its
  strategies included.
- AgentCore Memory's metadata filters on `ListEvents` let one session hold both
  the conversation and the agent's saved state without either reading the
  other.

**Needs work:**
- There's no outbound UDP, and nothing says so. Ring's live view connected and
  then sat silent for ten seconds before we found why. The live bridge moved to
  Lambda (FL-017).
- EventBridge and API Gateway can't target a runtime, so every way in is a
  small Lambda shim.
- A session keeps its old image for up to eight hours after a deploy. We put the
  version in the session id to force a fresh one.
- The TypeScript SDK had no session storage for Strands on AgentCore Memory,
  which Python has had for months. We wrote it and opened a pull request
  (issues #160 and #214 there).
- A memory strategy's namespace can name only `{actorId}`, `{sessionId}` and
  `{memoryStrategyId}`, so "a member in a home" had to be spelled as the
  session being the home (FL-046).

**Onboarding:** the runtime and its graphs landed in one pull request. The one
trap is ordering: the runtime needs an image before it can be created.

**Build with it again?** Yes, for per-tenant agent work. Real-time media goes
elsewhere until egress is documented.

---

## 7. Strands Agents SDK

*`@strands-agents/sdk` 1.18 (TypeScript).*

**Used for:** the door's graphs, which mix one vision agent with deterministic
steps; the family assistant, an `Agent` with an `McpClient` on Wick's own MCP
server, hooks that interrupt every write for the member's yes, and a
`SessionManager`; and the Sunday brief, a `Graph` with an analyst, a writer, a
check and a suggester using structured output. The parts a model must never
decide, such as whether to sound a chime or which suggestion may stand, are
plain code in the same graphs.

**Worked well:** any `Node` subclass can be a node, so model steps and rule steps
share one traceable graph. `BedrockModel` needs only an id and a couple of
settings. Graphs take a model, so tests run without AWS.

- Interrupts from a `BeforeToolCallEvent` hook are the right shape for "ask
  the person before any write": one interrupt per call, resumed with
  `InterruptResponseContent`, and the paused call runs without asking the model
  again.
- `McpClient` takes headers, so an agent can call an MCP server as the person
  it acts for.

**Needs work:**
- A built-in "function node" would save a 40-line subclass for each plain
  step, and a TypeScript example mixing model and rule nodes would help.
- A TypeScript `Graph` cannot loop back into a node that also has an edge from
  outside the loop: the run ends after the first node with status COMPLETED and
  no error (FL-047).
- An agent built per request (one per invocation, as on AgentCore Runtime)
  meets interrupts, sessions and memory that each assume one long-lived agent
  (FL-046).

**Onboarding:** short. The same graph code ran in tests and in AgentCore
unchanged.

**Build with it again?** Yes. It's the lightest way we found to keep models and
rules in one flow.

---

## 8. Rekognition, Polly, Translate and Transcribe

**Rekognition.**
- **Used for:** moderating a family photo before it's sent (it fails closed),
  and, offline, finding every shot, fade and credit start in each film for calm
  points.
- **Worked well:** the moderation categories let us refuse four and allow the
  rest; segment detection was precise enough to drive a product rule, at about
  ten cents a film.
- **Needs work:** video analysis reads only from S3, so each film had to be
  copied in for its job.
- **Onboarding:** one call, and two CLI commands for the films.
- **Again?** Yes. "Calm points are measured, never guessed" depends on it.

**Polly.**
- **Used for:** "Read to me", in English and Spanish, with SSML built from
  exactly what the screen shows. Each reading is cached for a day.
- **Worked well:** neural voices in both languages from one call. Seen playing
  on the Vega simulator and the browser television; not confirmed on Fire OS.
- **Needs work:** `SynthesizeSpeech` can't be scoped in IAM, so the grant is
  `*`.
- **Onboarding:** one call returns the MP3.
- **Again?** Yes. For someone whose eyesight is going, being read to is an
  accessibility feature.

**Translate.**
- **Used for:** free text only, a family note, the door's sentence and the week,
  on its way to her screen. Wick's own sentences come from a hand-written
  phrasebook.
- **Worked well:** fast and accurate for short, plain sentences.
- **Needs work:** marking a name "do not translate" changes the grammar around
  it ("con el Rose"). We now send text plain and mark names only if one didn't
  survive.
- **Onboarding:** one call.
- **Again?** Yes, alongside a phrasebook for anything she consents to.

**Transcribe (streaming).**
- **Used for:** a family member asking a question out loud in the family app. The
  server streams one utterance to Transcribe and keeps nothing.
- **Worked well:** the SDK's audio stream is simple to feed. A recorded question
  sent to the deployed server came back as words in about a second. We haven't
  yet tried the Ask-by-voice button itself in a real browser.
- **Needs work:** the natural design, streaming from the browser with words
  appearing as she speaks, isn't possible behind App Runner, which has no
  WebSockets (FL-032). A browser example of Transcribe's audio framing would
  open the direct route. The IAM grant is `*`.
- **Onboarding:** built and tested in a day.
- **Again?** Yes. Speaking is easier than typing on a phone.

---

## 9. The rest of the AWS stack

**AWS Lambda.**
- **Used for:** every edge handler, the agent shims and the live bridge.
- **Worked well:** Ring's five-second budget is easy to meet, outbound UDP works,
  and a container image carried ffmpeg for the bridge with no fuss.
- **Needs work:** nothing logged. The first call after a deploy pays a cold start.
- **Onboarding:** familiar.
- **Again?** Yes.

**Amazon API Gateway.**
- **Used for:** the HTTP API for Ring, pairing and live view, and a WebSocket API
  as every television's fallback.
- **Worked well:** the WebSocket API put the first real card on the simulator and
  has stayed dependable. The access log proved Ring had never called us (FL-002).
- **Needs work:** nothing logged.
- **Onboarding:** deployed on day three.
- **Again?** Yes.

**AWS IoT Core.**
- **Used for:** the television's main channel, with a custom authorizer that
  checks the television's own token.
- **Worked well:** no certificates on the television, and a policy that names
  exactly three topics.
- **Needs work:** the rule that browser and React Native clients can't send
  credentials in the MQTT connect is one sentence on one page, and a refused
  connection gives no reason (FL-024). Which field identifies a connection isn't
  documented (FL-009).
- **Onboarding:** one day, once FL-024 was understood.
- **Again?** Yes.

**Amazon EventBridge and EventBridge Scheduler.**
- **Used for:** the event bus, the weekly and hourly schedules, and the
  three-minute wait in Hold for Sarah.
- **Worked well:** a one-time schedule that deletes itself is the right tool for
  "if nobody answers in three minutes". Matching on source keeps the stand-in
  doorbell off the real door path.
- **Needs work:** neither can target AgentCore directly.
- **Onboarding:** short.
- **Again?** Yes.

**AWS Step Functions.**
- **Used for:** a visit errand, as one Standard execution over days: a Wait for
  the reminder, a Lambda task, then a `.waitForTaskToken` task the door's
  `door.rang` event redeems, with a timeout at the end of the visit's window.
- **Worked well:** a multi-day wait costs nothing while it waits, retries and
  catches are declarative, and the execution graph shows a judge exactly where
  an errand is. Naming the execution after the errand makes a retried start
  harmless.
- **Needs work:** a Wait can take an absolute timestamp, but a task's
  `TimeoutSecondsPath` only takes seconds from when the task starts, which a
  state machine cannot compute in JSONPath; we pass it in the input (FL-045).
- **Onboarding:** one afternoon, with the States Language reference open.
- **Again?** Yes, for anything that waits on people.

**Amazon SQS.**
- **Used for:** the Sunday brief's fan-out: one message per home, a dead-letter
  queue after three tries, and partial batch failures, with Lambda's maximum
  concurrency at two so Bedrock is never asked for more than the account allows.
- **Worked well:** `ReportBatchItemFailures` and an event source mapping's
  maximum concurrency turn a fan-out into one line of Terraform each.
- **Needs work:** nothing logged.
- **Onboarding:** familiar.
- **Again?** Yes.

**AWS App Runner and Amazon ECR.**
- **Used for:** the Wick server, and three images: the agents and the live bridge
  on arm64, the server on amd64.
- **Worked well:** one container behind HTTPS, with nothing else to manage.
- **Needs work:** there are no WebSockets and no documented request-body limit,
  and we found both only in a closed GitHub issue (FL-032). The service can't be
  told its own URL on the first deploy, so that takes two applies. Idle
  connections are closed after a few seconds (FL-033).
- **Onboarding:** deployed five days after the first commit.
- **Again?** App Runner, no. It's closed to new customers and has no WebSockets,
  so we'd start on ECS or Lambda. ECR, yes.

**Amazon DynamoDB.**
- **Used for:** one table holding everything.
- **Worked well:** single-digit-millisecond reads made sub-500 ms tools possible
  without a cache, and a conditional write makes the Ring webhook idempotent.
- **Needs work:** nothing logged.
- **Onboarding:** immediate.
- **Again?** Yes.

**Amazon S3 and CloudFront.**
- **Used for:** door pictures, family photos, the films and the static sites.
- **Worked well:** lifecycle rules, including tag-based ones, keep our privacy
  promises in the infrastructure. Serving over HTTPS through CloudFront fixed
  Vega's silent refusal of cleartext video (FL-016).
- **Needs work:** without `s3:ListBucket`, a missing object returns 403, not 404.
- **Onboarding:** familiar.
- **Again?** Yes.

**AWS Secrets Manager.**
- **Used for:** each home's Ring tokens, plus the pairing and push keys.
- **Worked well:** IAM per secret, and Terraform manages the secrets without ever
  seeing what's in them.
- **Needs work:** nothing logged.
- **Onboarding:** immediate.
- **Again?** Yes.

**Amazon Cognito.**
- **Used for:** family members' sign-in.
- **Worked well:** sign-up, email confirmation and passwords are handled for us.
- **Needs work:** there's no dynamic client registration or protected-resource
  metadata, so the MCP server has to be its own OAuth server. With both, it could
  use Cognito directly.
- **Onboarding:** short.
- **Again?** Yes.

**CloudWatch, IAM and GitHub OIDC.**
- **Used for:** logs and alarms, one role per function, and keyless deploys.
- **Worked well:** the logs were the evidence behind several friction entries,
  and there's no AWS key in CI to leak.
- **Needs work:** Polly, Translate and Transcribe can't be scoped below `*`. A new
  AWS service always needs a laptop apply first, because CI can't widen its own
  role.
- **Onboarding:** set up on day two.
- **Again?** Yes.

---

## Other tools

Terraform for all infrastructure, GitHub Actions for CI and deploys, `mqtt.js`
for MQTT on both televisions, werift and ffmpeg for the live bridge, MCP
Inspector for testing the server, Playwright for recording the site's videos, and
Claude Code as the coding agent, with Ring's Appstore Knowledge MCP server
configured for it. Kiro was not used.

---

## Feature requests

Each comes from a friction entry. Priority is how much it matters to Wick:
**Critical** blocks a core part of the product, **Important** costs a feature or
forces a workaround, **Nice-to-have** saves time.

| # | Request | Priority |
|---|---|---|
| 1 | Alexa+ MCP Toolkit: a sandbox for any registered developer | Critical |
| 2 | Vega: a supported way to show something over another app, and a documented service lifetime | Critical |
| 3 | Vega Virtual Device: storage that persists | Critical |
| 4 | Ring linking that says what failed | Critical |
| 5 | Ring Playground: "press the doorbell" and "person detected" buttons | Important |
| 6 | Ring Playground: a simulated chime | Important |
| 7 | Vega: pass a value to a service you start | Important |
| 8 | Ring media: a published request body and a "not ready yet" error | Important |
| 9 | Fire OS: an emulator image and a key-event table for React Native | Important |
| 10 | Vega media controls: a test client and one rule for keys heard twice | Important |
| 11 | Vega: WebRTC for React Native, and a WebView that runs on the simulator | Important |
| 12 | AgentCore Runtime: documented egress, with UDP as an option | Important |
| 13 | Bedrock: keep retired models visible and name the successor | Nice-to-have |
| 14 | App Runner: document WebSockets and the request-body limit | Nice-to-have |
| 15 | IoT Core: say which clients can authenticate which way | Nice-to-have |

**1. Alexa+ sandbox (Critical).** Let any registered developer deploy a
development add-on only their own account can reach, and gate certification
instead. Until then, say "select partners only" on the Overview and QuickStart
(FL-001). *Why:* the family is meant to reach Wick by asking Alexa. The server
and package are ready, but no one can use them from an Echo.

**2. Showing something over another app (Critical).** Document the toast route
that works, fail a toast with a wrong channel name instead of drawing nothing,
and say how long a service lives and whether it restarts after a reboot (FL-022,
FL-014, FL-026). *Why:* "Someone is at the front door" must reach her in any app.
Today it works through a route we found in the device log.

**3. Persistent storage on the simulator (Critical).** Make file writes succeed
on the Vega Virtual Device, or turn the buried error into an install error
(FL-013). *Why:* every launch loses the pairing, and it forced a security
exception in our code.

**4. Ring linking errors (Critical).** Return real OAuth errors when an app isn't
allowlisted, explain the console's account count, document the completion call,
and say why a status change is refused (FL-002 to FL-004, FL-010). *Why:* each home
should link its own Ring account. It still can't for a private app.

**5. Playground event buttons (Important).** Buttons that send the real, signed
`button_press` and `motion_detected` webhooks, or a CLI that does (FL-027).
*Why:* the door is Wick's first pillar, and none of it can be shown on anything
Ring provides.

**6. A simulated chime (Important).** A Playground chime with a visible "played"
state (FL-019, FL-006). *Why:* "Ring the hallway chime" is built and tested but
can't be demonstrated.

**7. Passing a value to a service (Important).** Pass the launch URI's query to
`onStartService`, and document which storage an app and its service share
(FL-029, FL-026). *Why:* the service needs the app's token. We hand it over
through our own server, a second security exception.

**8. Ring media (Important).** Publish the picture call's request body, return
400 for a malformed one, and replace `422 GRECO_NO_VALID_KEY` with a documented
"not ready yet" and `Retry-After` (FL-005, FL-008). *Why:* the door's picture
matters most, and we retry four times to get it.

**9. Fire OS emulator and key table (Important).** An emulator image, or a list
of how the Android TV image differs, plus a per-button table of key events
(FL-025, FL-028). *Why:* our hold for Sarah first shipped mistaking a short press
for a hold.

**10. Media-controls test client (Important).** A CLI to send play, pause and seek
to an app, and one documented rule for keys heard twice (FL-031). *Why:* "Alexa,
pause" is built but can't be exercised on the simulator.

**11. WebRTC and WebView (Important).** Fix WebView on the simulator and ship a
WebRTC module (FL-015). *Why:* Ring's live view is WebRTC, so ours goes through a
cloud bridge that adds about five seconds.

**12. AgentCore egress (Important).** Document which protocols PUBLIC mode allows,
fail blocked UDP loudly, and offer UDP as an option (FL-017). *Why:* the live
view had to leave the household's microVM.

**13. Retired Bedrock models (Nice-to-have).** Keep retired models in the list
with a status and date, name the successor, and say whether this account can call
a model (FL-030). *Why:* we lost time on two image models and a listed model that
refused every call.

**14. App Runner limits (Nice-to-have).** Say in the guide that WebSockets aren't
supported, and publish the request-body limit (FL-032). *Why:* we found both in a
closed GitHub issue.

**15. IoT Core authentication (Nice-to-have).** Say that browser and React Native
clients must send credentials in the query string, and document the field that
identifies a connection (FL-024, FL-009). *Why:* our first client could never have
connected.
