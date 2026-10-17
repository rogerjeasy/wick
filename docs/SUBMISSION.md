# Devpost submission: Wick

The text for each field of the Devpost form, ready to paste. Placeholders
still to fill are marked **`VIDEO_URL_PLACEHOLDER`**.

---

## Project name

Wick

## Tagline

The television as the care surface for the person being cared for: who is at
the door, on the screen she already watches, and a family kept close without
anyone watching her.

## Track and mini-challenges

- **Track:** Fire TV
- **Mini-challenges:** AWS Builder · Open Source

## Links

| | |
|---|---|
| Repository | https://github.com/rogerjeasy/wick (MIT) |
| Try it (no account, no hardware) | https://d2sbabcft8sm3m.cloudfront.net/tv.html (her television in a browser tab) and https://dmaz25jvryojp.cloudfront.net/ (the family app) |
| The calm-point map | https://rogerjeasy.github.io/wick/calm-points/ |
| Product feedback (every tool, and 15 feature requests) | [`docs/PRODUCT-FEEDBACK.md`](PRODUCT-FEEDBACK.md) |
| Friction log (45 entries) | [`FRICTION.md`](../FRICTION.md) |
| Video | `VIDEO_URL_PLACEHOLDER` |

---

## About the project

### What it is

Every product built for ageing at home is built for the *caregiver*: a phone
app full of alerts, checked by a daughter three hundred miles away. Wick turns
that around. It puts the intelligence inside the home, on the one screen a
78-year-old already looks at for hours a day, and asks her to install nothing,
learn nothing, wear nothing and change nothing. Everything she does, she does
with the remote's D-pad and OK.

### What it does

**The door.** A Ring doorbell press puts a card on her television within
seconds. A still from the doorbell, and one plain sentence from a vision model
about who is there, are added when they are ready. Measured on 16 October 2026
from the demo's stand-in doorbell (five rings, `npm run latency:door`), the
card came in 2.3 s, the picture in 2.7 s and the sentence in 2.9 s (medians;
4.8 s at most, and one ring had no sentence). That path skips Ring's own hop
to Wick's webhook, which has not been measured. If the model is unsure, it says nothing. If she is in another
app, Wick's background service puts a system toast over it ("Someone's at the
front door.") with one button that brings Wick forward. In a home linked to
Ring, one button on the card opens the doorbell camera live, and Back returns
to the card. The demo's stand-in doorbell has no camera, so its card does not
offer it: live view is shown in the video, from Ring's Developer Playground.

**The family.** A daughter asks "how's Mum been this week?" and gets a short,
truthful paragraph, written from counts the code made, never from a model's
guess. Notes go the other way and wait for a natural break: the credits, a
pause, or a *calm point* inside the film (a cut that falls in silence, measured
on each film with Amazon Rekognition and ffmpeg). The film holds on the cut
while the note is read. She replies with one button.

**The rhythm.** Wick learns what a normal week looks like in this house, so it
can stay silent when nothing is wrong, and say "that's up from last week" and
mean it.

Built on those three, each with one button on her remote:

- **Ask Sarah to look**: someone unexpected at the door; one press asks a
  family member to look at the same picture and answer with one of three fixed
  sentences.
- **Shall I tell Sarah?**: when a day is unlike her usual, Wick asks *her*,
  showing the very sentence that would be told. "Keep it to myself" looks, to
  the family, exactly like nothing having happened.
- **Watch together**: a family member invites her to a film; her press on
  "Start the film" lets the other screen follow hers.
- **The light in the window**: the family sees one fact, whether her day has
  begun. She can put it out, and an unlit light never says why. Her home screen
  says who looked in.
- **Hold for Sarah**: OK held for two seconds asks one person to ring her; if
  nobody answers in three minutes, the next person in her circle is asked.
  Wick itself calls nobody and sounds nothing.
- **The visit, witnessed**: the carer's arrival and leaving, from the door, are
  put to her ("Is this right?"). Only her "Yes" confirms a visit.
- **Sarah's television**: the same app, on a family member's own television,
  showing only what that member may already see.
- **Her language**: the television speaks Spanish once *she* says yes. Wick's
  own sentences come from a hand-written phrasebook; only free text is
  machine-translated.
- **The mantelpiece**: the family sends a photo; she keeps it or says thank
  you, and the family sees the same thing either way.
- **Read to me**: the Play key reads the card on screen aloud, in her language.
- **Visit errands**: Sarah says *"The plumber is coming Thursday at ten — let
  Mum know."* Wick's agent shows her the plan and waits for her yes; then a
  note waits for Margaret's natural break, the door is told whom to expect (the
  card later says "Sarah arranged this visit"), Margaret is reminded that
  morning, and Sarah is told when the door rang or that nobody came. It runs
  for days as one Step Functions execution, and never claims the plumber came:
  only that someone rang around then.
- **The Sunday brief**: each home's week is written by agents from counted
  facts, checked by the Guardian and a Bedrock Guardrail's grounding check,
  and ends with one thing Sarah could do, with one button: write a note,
  arrange a visit, or watch a film together. Margaret still sees her week
  first.

The family reaches all of it through the Wick server's 25 MCP tools, from a
family app that stands in for Alexa+, and through Wick's own agent on Amazon
Bedrock AgentCore, which calls those same tools with the family member's own
token and asks before every write. Every tool asks again, on every call,
whether she still allows that person.

### What is real, and what is simulated

Wick was built with no hardware, which the hackathon allows. The television is
the **Vega Virtual Device** and an **Android TV emulator** running the Fire OS
build, plus a browser-tab television for anyone with neither. The doorbell is
**Ring's Developer Playground** (a simulated camera behind Ring's real Partner
API). The Playground sends no doorbell webhooks, so a demo home has a stand-in
doorbell of Wick's own, rung from the family app, whose four visitors are
generated pictures of nobody real. **Alexa+** is a simulated surface, because
the add-on toolkit is open to select partners only. The demo home's six weeks
of history are simulated and marked as such everywhere. Everything in between
is deployed and real: the AWS stack, the MCP server, the agents and the models
they call, the policy engine, accounts and pairing, and the channel to the
television.

### How we built it

A Vega OS app (React Native 0.83, `react-native-kepler`, headless services,
Content Personalization, Media Controls, W3C media) and the same source built
for Fire OS on `react-native-tvos`. An edge of Lambda functions behind API
Gateway and AWS IoT Core. An agent plane on Amazon Bedrock AgentCore Runtime:
the door's Strands graphs (Nova Lite), the family assistant as a Strands agent
with an MCP client, interrupts for approval and AgentCore Memory, and the
Sunday brief as a Strands Graph (Claude Sonnet 4.5), all behind a Bedrock
Guardrail. Visit errands on AWS Step Functions; the brief's fan-out on SQS. One
DynamoDB table. An MCP server (spec 2025-11-25, Streamable HTTP, OAuth 2.1) on
App Runner. All of it in Terraform, deployed by GitHub Actions through OIDC.

A model may describe, but only code may decide. No model chooses when a note
appears, whether the chime rings, or what the family is told about her: those
are deterministic rules, enforced by tests (`AGENTS.md`).

### Challenges

They are in [`FRICTION.md`](../FRICTION.md), written as they happened. The
biggest: showing anything outside the app on Vega (FL-022), storage that
never persists on the simulator (FL-013), and a service that cannot be handed
its token (FL-029). Others were Ring linking that fails silently four
different ways (FL-002, FL-003, FL-004, FL-010), a Playground that sends no
events (FL-027), and no outbound UDP in AgentCore Runtime (FL-017).

### What's next

A real Fire TV and a real Ring doorbell in a real home; the Alexa+ add-on the
day access opens (the package is ready: `npm run addon:check -- --live`); the
connections kept open in front of the MCP server, so no call pays a new TLS
connection (issue #47 found that cause; the server's own p95 is 18 ms).

---

## What was built during the submission window

Wick did not exist before the hackathon. The repository was created on
**2026-09-14**, two weeks into the submission window (which opened on
2026-08-31). Its first commit is a scaffold of design documents, shared types
and stubs, and every one of its more than 700 commits is dated from 2026-09-14
on. Everything in it (the Vega and Fire OS apps, the AWS stack, the
agents, the MCP server, the family app, the friction log) was built in the
window. The three open-source contributions below were made in the window too:
`vega-calm-ui`'s first commit is 2026-09-14 and it was published to npm on
2026-10-16, the pull request to Amazon's AgentCore SDK was opened on
2026-10-16, and the one to Amazon's sample on 2026-10-14.

---

## Testing instructions for judges

### The hosted demo: no account, no hardware

1. Open [her television in a browser tab](https://d2sbabcft8sm3m.cloudfront.net/tv.html).
   It is the television and nothing else, drawn as the Vega app draws it, and
   it shows a six-digit code. The keyboard is the remote: the arrows move,
   **Enter** is OK, **Backspace** or **Esc** is Back, **Space** or **P** is
   Play/Pause, and **Enter** held for two seconds is Hold for Sarah. **?**
   shows or hides the keys.
2. Open the [family app](https://dmaz25jvryojp.cloudfront.net/), choose
   **Try the demo**, and enter the television's code. You are Sarah, Margaret's
   daughter, in a demo home of your own with six weeks of simulated history:
   no email, no password.
3. On the television, allow yourself: the question comes up once it has sat on
   its home screen for twenty seconds, as on Vega. Then ask the family app
   anything, such as *"How has my mum been this week?"* or *"Is the light
   on?"*, and answer on the television.
4. The natural break: choose a film with **Enter**, then ask the family app to
   *"Send a note to her television"*. The note waits while the film plays.
   Press **Space** to pause and it comes on screen five seconds later — or let
   Big Buck Bunny reach 1:29, a measured calm point, where the film holds on
   the cut while the note is shown. **Space** over the note reads it aloud;
   **Enter** answers it, and from a calm point the film goes on by itself.
5. The door: press the **Ring the stand-in doorbell** chip and choose who is
   there. The door card comes up at once, over the playing film and without
   pausing it, then the picture, then the vision model's sentence.
6. **Easier to see**, on the home screen, sets larger text or higher contrast.
7. **A visit errand, end to end.** In the family app, ask *"The window cleaner
   is coming in five minutes — let Mum know"*. Wick's agent shows what it will
   do and asks for your yes on each step; say yes. The note waits on the
   television for a break; after the visit's time, ring the stand-in doorbell
   and choose **The visitor you arranged**: the door card says you arranged it,
   and the family app's errand card turns to "Someone rang at …". Ask *"Did
   the window cleaner come?"* to see it again.
8. **The Sunday brief.** Ask *"How has my mum been this week?"*: the week was
   written by the agents, and its card ends with *One thing you could do*, with
   one button.
9. For the family's side on a television, open
   [the console's television](https://d2sbabcft8sm3m.cloudfront.net/device.html)
   and press **Pair & connect**: it shows a code. In the family app, choose
   **Connect a television**, answer *"Whose television is it?"* with **Mine**,
   and enter that code.

### On the Vega Virtual Device or the Android TV emulator

Building and running the television apps, and deploying the stack, is in
[`docs/SETUP.md`](SETUP.md). The Fire OS build's own steps are in
[`apps/tv-fireos/README.md`](../apps/tv-fireos/README.md). The Vega app pairs with
the same deployed back end as the browser television, with the same code in the
family app.

### Tests

```bash
nvm use && npm install
npm run verify     # typecheck, lint, the no-mocks guard, and every test
```

---

## AWS Builder

Wick is not one model call behind an API. It is three agents on **Amazon
Bedrock AgentCore**, built with **Strands**, on a pipeline of twenty-three AWS
services, every one in Terraform.

- **The family assistant** is a Strands `Agent` in **AgentCore Runtime**. It is
  an MCP client of Wick's own server, calling its 25 tools with the family
  member's own token, so it can do nothing the member could not. Every write
  pauses through a **Strands interrupt** until the member says yes in the app;
  one yes covers one call. The token is checked against the Wick server before
  any session is loaded. Conversations, including a write waiting for a yes,
  persist in **AgentCore Memory** through a Strands session storage Wick wrote
  and contributed to Amazon's AgentCore TypeScript SDK (Open Source, below);
  a user-preference strategy remembers the member's own words long-term.
- **Visit errands** run for days as **AWS Step Functions** executions: wait for
  the reminder time, remind her, then wait for the doorbell with a task token
  that the door's **EventBridge** event redeems, or time out, and tell the
  member by Web Push.
- **The Sunday brief** is a **Strands Graph** in AgentCore Runtime: an analyst
  (code), a writer (**Claude Sonnet 4.5** on **Amazon Bedrock**), a check (the
  Guardian, the number check, and a **Bedrock Guardrail** with contextual
  grounding against the counted facts), and a suggester with structured
  output, whose one suggestion code validates. **SQS** fans it out, one home
  per message, with a dead-letter queue and alarms.
- **The door** is a Strands graph in AgentCore Runtime with one microVM per
  household: **Nova Lite** describes the picture and a validator decides
  whether that sentence may be shown. A Ring press reaches a Lambda behind
  **API Gateway**, which verifies it and puts it on an **EventBridge** bus; the
  card reaches the television over **AWS IoT Core** (MQTT with a custom
  authorizer) or an API Gateway WebSocket.
- And: **EventBridge Scheduler** (the three minutes of Hold for Sarah),
  **Rekognition** (calm points, family photos), **Polly** (Read to me),
  **Translate**, **Transcribe**, **DynamoDB**, **S3** and **CloudFront**,
  **Secrets Manager** (per-household Ring tokens), **Cognito**, **App Runner**,
  **CloudWatch** alarms with **SNS**, and **GitHub OIDC** deploys with no AWS
  keys.

The table of every service, what Wick does with it, and the files where it is
defined is in [`docs/PRODUCT-FEEDBACK.md` → AWS services used, and how](PRODUCT-FEEDBACK.md#aws-services-used-and-how),
with the five product-feedback answers for each. How the agents work is in
[`docs/WICK-TECHNICAL.md`](WICK-TECHNICAL.md) §18–§21.

---

## Open Source

**GitHub username:** `rogerjeasy`
**Project repository URL:** https://github.com/rogerjeasy/wick

### Contribution 1: AgentCore Memory session storage for Strands TypeScript, a pull request to Amazon's AgentCore SDK

**Contribution URL:** https://github.com/aws/bedrock-agentcore-sdk-typescript/pull/287
(branch [`rogerjeasy:feat/strands-session-storage`](https://github.com/rogerjeasy/bedrock-agentcore-sdk-typescript/tree/feat/strands-session-storage))

**What we did.** Amazon's official AgentCore TypeScript SDK
(`aws/bedrock-agentcore-sdk-typescript`) had no way to keep a Strands
TypeScript agent's session in AgentCore Memory; Python's SDK has had
`AgentCoreMemorySessionManager` for months, and two issues there ask for the
TypeScript one (#160, and #214 from an AWS engineer for the AgentCore CLI's
TypeScript template). We wrote it: `AgentCoreMemorySnapshotStorage` and
`createAgentCoreMemorySessionStorage`, so `new SessionManager({ storage })`
persists a Strands agent's conversation in AgentCore Memory. 60 unit tests
(including a real Strands `SessionManager` and `Agent` restoring a
conversation after a simulated cold start, against a fake that enforces the
service's limits), 98 % statement coverage of the new file, documentation,
and five integration tests that run against a real AgentCore Memory. We ran
them on 2026-10-16 against a new memory in our account: all five pass, twice
in a row (save and replace, a 330 KB snapshot split and reassembled, listing,
a second Strands agent restoring the first one's conversation, and delete).
The pull request is open, awaiting the maintainers' review.

**How it works.** Each Strands snapshot and manifest is a set of AgentCore
Memory `blob` events tagged with metadata (kind, location, snapshot id,
"latest", part numbers). Reads filter on that metadata, so the storage never
touches the conversational events other integrations write into the same
session. Snapshots larger than one payload item are chunked and reassembled;
a failed multi-part write is rolled back; an older "latest" is deleted once a
newer one is written. One turn costs one `CreateEvent`, one `ListEvents` and
one `DeleteEvent`.

**Why it matters.** It unblocks every TypeScript developer building Strands
agents on AgentCore Runtime: their agents lose their conversation on every
cold start without it. Wick runs on it today: the family assistant's
conversations, including a write waiting for the member's yes, live in
AgentCore Memory through the same code (`packages/strands-agentcore-session`).

### Contribution 2: a new open-source library, `vega-calm-ui`

**Contribution URL:** https://github.com/rogerjeasy/vega-calm-ui (MIT), on npm as
[`vega-calm-ui`](https://www.npmjs.com/package/vega-calm-ui)

**What we did.** We extracted Wick's card components into a standalone library
of accessible, low-arousal 10-foot components for Vega OS, with an ESLint
plugin. It has its own CI, a README written for a stranger, a CHANGELOG, and 131
tests. It is on npm: `npm install vega-calm-ui`. Versions 0.1.0 to 0.1.2 were
published on 2026-10-16 by the repository's own release workflow, each with a
provenance statement, so npm shows the commit and the workflow run that built
it. Since 0.1.2 it publishes through npm's trusted publishing (OIDC): no npm
token is stored anywhere, and the package refuses tokens.

**How it works.**
- `CalmCard` is a headline, optional detail, up to three actions and an
  optional picture. **At render time** it throws a `CalmViolation` if any text
  is below 32 pt, any text (including every button's words on that button) is
  below 7:1 contrast (WCAG AAA, computed, not assumed), there is a fourth
  action, a colour is a saturated red, or the card would not fit a 960×540 dp
  screen with its margins.
- `TwoPhaseCard` reserves space for the slow part (a description, a picture) so
  it can arrive later without moving anything on screen, with no spinner.
- `useScreenReaderEnabled` and `useReduceMotionEnabled` read Vega's
  `AccessibilityInfo`.
- `vega-calm-ui/eslint` has four rules that catch the same mistakes in the
  editor: `max-actions`, `min-font-size`, `no-alarm-colour` and
  `no-auto-dismiss` (no `setTimeout`/`setInterval` inside a component that
  renders a calm card, because a calm card stays until it is answered).
- The limits are constants, not options: a floor that can be configured is not
  a floor. The components use only `View`, `Text`, `Pressable`, `Animated`,
  `StyleSheet` and `AccessibilityInfo`, so they also run on react-native-tvos
  (Wick's Fire OS build uses them).

**Why it matters.** Most television UI assumes good eyesight, quick reactions
and a tolerance for motion: small captions, animated tiles, toasts that vanish
after five seconds, red badges. For many of the people who watch the most
television (older viewers, people with low vision, cataracts or a tremor) that
is the difference between a screen they can use and one that startles them.
We found no Vega library that makes the accessible choice the default. This
one makes the inaccessible choice fail, in the editor and at render time.

### Contribution 3: accessibility settings for Amazon's own multi-TV sample

**Contribution URL:** https://github.com/AmazonAppDev/react-native-multi-tv-app-sample/pull/135
(branch [`rogerjeasy:feat/accessibility-preset`](https://github.com/rogerjeasy/react-native-multi-tv-app-sample/tree/feat/accessibility-preset),
commit `ebb8a76`)

**What we did.** Amazon's `react-native-multi-tv-app-sample` is the template for
one React Native TV app on Android TV, Fire TV (Fire OS and Vega), Apple TV and
the web. Its issue #7, "Improve Accessibility Features", asks for a
high-contrast mode, among other things. We added an **Accessibility** section to
the sample's Settings screen with three independent switches (**high
contrast**, **larger text** and **reduce motion**) and documented them in the
README. The change is 16 files (+867/−169), with three new test files (42 tests,
all passing).

**How it works.**
- An `AccessibilityProvider` (wrapping `AppNavigator` and `VegaAppNavigator`)
  starts from what the device reports and follows it live. That means
  `AccessibilityInfo.isReduceMotionEnabled` on every platform that has it and
  `isHighTextContrastEnabled` on Android TV and Fire OS. A platform that cannot
  answer leaves the switch off. A choice made in Settings wins until the
  viewer picks **Use device settings**.
- `useTheme()` returns a theme built from those preferences.
  - **High contrast** is a palette in which every text colour is at least 7:1
    against its surface, a 6 px yellow focus ring around a white button with
    black text (so focus is shown by shape, not colour alone), and visible
    edges on resting buttons and cards.
  - **Larger text** scales themed text by 25 %.
  - **Reduce motion** stops focused items from growing.
- `FocusablePressable`, both drawers, Settings and Details use the theme.
  WCAG contrast helpers (`contrastRatio`, `blend`) let a test check every
  high-contrast pair, so a token edited below 7:1 fails CI.

**Why it matters.** The sample is where Fire TV developers start. Accessibility
that is in the template, with a theme hook and tests, is accessibility that
ships in the apps built from it, on Vega and Fire OS alike. The README section
also records which platform reports which setting.

---

## Video

**URL:** `VIDEO_URL_PLACEHOLDER`

The rules: under three minutes, in English, public on YouTube or Vimeo, and it
must show the project running on a Fire TV device or the Fire TV/Vega
simulator. Judges need not watch past three minutes.

**One story, Margaret first.** Not a tour of features: one evening at her
house, told from her armchair, with Sarah's side cut in only when Margaret
hands something to her. The Vega Virtual Device is in the first frame.

| Time | Shot | What it shows | Caption on screen |
|---|---|---|---|
| 0:00–0:10 | **Vega Virtual Device**, full screen: Wick's home screen, then Big Buck Bunny starting | Her television, on the required simulator, from the first frame | "Vega Virtual Device · demo home, simulated history · no hardware" |
| 0:10–0:20 | The film playing. Voice: "Margaret is 78 and lives alone. Care technology is built for her daughter's phone. Wick is built for her." | The idea, in one sentence | "Big Buck Bunny © Blender Foundation, CC BY 3.0" (kept while any film is on screen) |
| 0:20–0:55 | A ring at the door → the door card over the film, which keeps playing → the picture → the sentence → **Ask Sarah to look** → cut to Sarah's family app: the same picture, three answers → Sarah picks *"Please don't open the door. I'll ring you now."* → back on the VVD, it appears under Sarah's name | The door, and the one moment Margaret chooses to bring Sarah in | "Stand-in doorbell (Ring's Developer Playground sends no webhooks, FL-027) · vision: Amazon Nova Lite" |
| 0:55–1:25 | Sarah asks the family app to send a note → the agent shows the note and asks for her yes → back on the VVD, the film plays on and nothing appears → at 1:29 in the film, a quiet cut: the film holds, the note comes up → **Play** reads it aloud → **OK** sends her reply → Sarah's app shows it | Notes wait for a natural break: a calm point measured in the film itself | "Calm point measured with Amazon Rekognition and ffmpeg · read aloud by Amazon Polly" |
| 1:25–1:55 | On the VVD: *"Shall I tell Sarah? Maria usually comes on Friday mornings. There was no visit on Friday."* → Margaret presses **Tell Sarah** → Sarah asks *"Is everything alright at Mum's?"* → *"Margaret asked Wick to tell you: …"* | Nothing about her reaches the family unless she says so | "If she keeps it to herself, Sarah sees exactly what she would see if nothing had happened." |
| 1:55–2:15 | Another app in front on the VVD → the system toast *"Someone's at the front door."* → **Open Wick** → the card. Three seconds of the Fire OS build on the Android TV emulator: the same card | Outside Wick, only the door interrupts. One source, both Fire TV platforms | "A note never interrupts another app: it waits, quietly, until she opens Wick." |
| 2:15–2:35 | The architecture diagram, built up in three steps: television ↔ IoT Core / WebSocket; Ring webhook → Lambda → AgentCore (Strands, Nova Lite); family app → MCP server (25 tools) → the same agents | How it works, in twenty seconds | "Bedrock AgentCore · Strands · Guardrail · Step Functions · all Terraform" |
| 2:35–2:50 | A single line of montage, about one second each: Hold for Sarah, Watch together, the visit witnessed, her language, Easier to see. Close on her home screen | Everything else, once | "Wick. For the person being cared for." |

Total: 2:50. Rules for the edit:

- Every shot of a film keeps its attribution on screen. Before recording,
  confirm at office hours #2 (Monday 19 October, 09:00 PT) that CC BY Blender
  films with attribution are acceptable.
- No Alexa+ logo (forum topic 45450). The family app is "a simulated Alexa+
  surface", in those words.
- Every simulated thing is labelled where it appears: the stand-in doorbell,
  the demo home's history, the family app.
- Voice-over in English, plain, at the pace of the cards. Let the door card
  and the calm point sit on screen long enough to read.

## Built with

`vega-os` `react-native-kepler` `fire-tv` `fire-os` `react-native-tvos`
`ring-partner-api` `model-context-protocol` `amazon-bedrock` `amazon-nova`
`claude` `bedrock-agentcore` `strands-agents` `aws-lambda` `amazon-api-gateway`
`aws-iot-core` `amazon-eventbridge` `amazon-dynamodb` `amazon-s3`
`amazon-cloudfront` `aws-app-runner` `amazon-ecr` `amazon-cognito`
`aws-secrets-manager` `amazon-rekognition` `amazon-polly` `amazon-translate`
`amazon-transcribe` `terraform` `typescript` `github-actions`
