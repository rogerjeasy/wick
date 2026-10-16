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
| Friction log (31 entries) | [`FRICTION.md`](../FRICTION.md) |
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
front door.") with one button that brings Wick forward. One button on the card
opens the doorbell camera live, and Back returns to the card.

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

The family reaches all of it through the Wick server's 22 MCP tools, from a
family app that stands in for Alexa+. Every tool asks again, on every call,
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
Gateway and AWS IoT Core. An agent plane of Strands graphs on Amazon Bedrock
AgentCore Runtime (Nova Lite for the door, Claude Sonnet 4.5 for the week). One
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
and stubs, and all of its more than 440 commits are dated between 2026-09-14 and
2026-10-14. Everything in it (the Vega and Fire OS apps, the AWS stack, the
agents, the MCP server, the family app, the friction log) was built in the
window. The two open-source contributions below were made in the window too:
`vega-calm-ui`'s first commit is 2026-09-14, and the pull request to Amazon's
sample was opened on 2026-10-14.

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
   **Try the demo**, and enter the television's code. You get a guest account
   and a demo home of your own, with six weeks of simulated history.
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
7. For the family's side on a television, open
   [the console's television](https://d2sbabcft8sm3m.cloudfront.net/device.html),
   press **Pair & connect**, and answer *"Whose television is it?"* with
   **Mine**.

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

Wick is not one model call behind an API: it runs on twenty AWS services
(counting IAM), every one defined in Terraform. A Ring press reaches a Lambda behind API
Gateway, which verifies it and puts it on an EventBridge bus. The Door agent,
a Strands graph on **Bedrock AgentCore Runtime** with one microVM per
household, has **Nova Lite** describe the picture, and a deterministic
validator decide whether that sentence may be shown. The card reaches the
television over **AWS IoT Core** (MQTT, with a custom authorizer checking the
television's own token) or an API Gateway WebSocket. **Claude Sonnet 4.5**
writes the weekly paragraph from counts made in code, on an EventBridge
schedule, so every MCP tool can answer from one **DynamoDB** read.
**EventBridge Scheduler** holds the three minutes between one person being
asked to ring and the next. **Rekognition** measured each film's calm points
and checks every family photo; **Polly** reads a card aloud; **Translate**
carries free text into her language; **Transcribe** hears a family member's
spoken question. **S3** lifecycle rules, not application code, delete door
imagery within a day. Per-household Ring tokens live in **Secrets Manager**,
family accounts in **Cognito**, and CI deploys through **GitHub OIDC** with no
AWS keys.

The table of every service, what Wick does with it, and the files where it is
defined is in [`docs/PRODUCT-FEEDBACK.md` → AWS services used, and how](PRODUCT-FEEDBACK.md#aws-services-used-and-how).
The same page has the five product-feedback answers for each service.

---

## Open Source

**GitHub username:** `rogerjeasy`
**Project repository URL:** https://github.com/rogerjeasy/wick

### Contribution 1: a new open-source library, `vega-calm-ui`

**Contribution URL:** https://github.com/rogerjeasy/vega-calm-ui (MIT)

**What we did.** We extracted Wick's card components into a standalone library
of accessible, low-arousal 10-foot components for Vega OS, with an ESLint
plugin. It has its own CI, a README written for a stranger, a CHANGELOG, and 92
tests. It installs from GitHub (`npm install github:rogerjeasy/vega-calm-ui`;
npm builds it on install). It is not published to the npm registry.

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

### Contribution 2: accessibility settings for Amazon's own multi-TV sample

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

The rules: under three minutes, and it must show the project running on a Fire
TV device or the Fire TV/Vega simulator. The shot list opens on the Vega Virtual
Device and says on screen what is simulated.

| Time | Shot | What it shows |
|---|---|---|
| 0:00–0:12 | **Vega Virtual Device**, full screen: Wick's home screen, a film playing | The product on the required simulator, from the first frame. Caption: "Vega Virtual Device. No hardware was used." |
| 0:12–0:25 | Title over the film: one sentence of the idea | Built for the person being cared for, not the caregiver |
| 0:25–0:55 | A doorbell ring → the door card over the film within seconds → the picture → the vision model's sentence → **Watch live** → Back | The door. Caption naming the source (Ring Developer Playground camera; the ring from Wick's signed stand-in, FL-027) |
| 0:55–1:10 | On the VVD, another app in front → the system toast "Someone's at the front door." → **Open Wick** | The background service and toast (FL-022) |
| 1:10–1:40 | **Voice, D-pad and visual in one flow.** Family app: a note sent mid-film → it does not appear → the system's transport control reaches her film through the Vega media session (its Stop, which Wick obeys as a pause; seen on the VVD) → at that pause the note comes on screen → **Play** reads it aloud (Amazon Polly) → **OK** sends her reply → the reply in the family app. Then, for a second, the same note waiting for a measured calm point instead, holding the film on the cut | The rubric's "multi-modal UX combining voice + D-pad + visual in a single flow", said in a caption. Caption: "On a Fire TV this is 'Alexa, pause'. The simulator takes no voice, so the system's own transport control stands in for it (FL-031)." The calm-point map for a second |
| 1:40–1:55 | Family app: "How has Mum been this week?" → the week card on the TV first, then the paragraph in the family app | INV-7: she sees her week first; the model never counts |
| 1:55–2:10 | OK held for two seconds → "Ask Sarah to ring you?" → Yes → the family member's answer appears on her TV | Hold for Sarah |
| 2:10–2:25 | Fire OS build on the Android TV emulator, same card; then on the VVD, **Easier to see**: Larger text, then Higher contrast, on the door card | One source, two Fire TV platforms; her television adapts to what she can see |
| 2:25–2:45 | Architecture diagram: Vega/Fire OS ↔ IoT Core ↔ AgentCore (Strands, Nova Lite) ↔ DynamoDB ↔ MCP server ↔ family app | AWS Builder: twenty services, all Terraform |
| 2:45–2:55 | The repo, `FRICTION.md`, `vega-calm-ui`, PR #135 | Product feedback and Open Source |

Total: 2:55. Captions say *simulated* wherever something is (the stand-in
doorbell, the demo home's history, the Alexa+ surface).

---

## Built with

`vega-os` `react-native-kepler` `fire-tv` `fire-os` `react-native-tvos`
`ring-partner-api` `model-context-protocol` `amazon-bedrock` `amazon-nova`
`claude` `bedrock-agentcore` `strands-agents` `aws-lambda` `amazon-api-gateway`
`aws-iot-core` `amazon-eventbridge` `amazon-dynamodb` `amazon-s3`
`amazon-cloudfront` `aws-app-runner` `amazon-ecr` `amazon-cognito`
`aws-secrets-manager` `amazon-rekognition` `amazon-polly` `amazon-translate`
`amazon-transcribe` `terraform` `typescript` `github-actions`
