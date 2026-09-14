<h1 align="center">Wick</h1>

<p align="center">
  <em>The television as the care surface for the person being cared for.</em>
</p>

<p align="center">
  <strong><a href="#">▶ Demo video (3 min)</a></strong> ·
  <a href="docs/WICK.md">Product definition</a> ·
  <a href="docs/WICK-TECHNICAL.md">Technical document</a> ·
  <a href="FRICTION.md">Friction log</a>
</p>

> **Submitted to:** Build, Ship, Shape — Amazon Developer Hackathon · **Track:** Fire TV
> **Mini challenges:** AWS Builder · Open Source

---

## The idea in two sentences

Every product built for ageing at home is built for the *caregiver* — a phone app,
full of alerts, checked by a daughter three hundred miles away. Wick inverts that:
it puts the intelligence **inside the home**, on the one screen a 78-year-old
already looks at for seven hours a day, and asks them to install nothing, learn
nothing, wear nothing and change nothing.

## What it does

| Pillar | What happens |
|---|---|
| **The Door** | A Ring doorbell press puts a card on the television in under three seconds — a live still and one plain sentence describing who is actually there. One button plays *"Just a moment"* out of the Ring Chime in the hallway, so nobody has to rush to the door. |
| **The Day** | Wick reads the day's real context from a Bee wearable and surfaces at most three things worth remembering — at the end of an episode, never mid-scene. |
| **The Family** | A distant daughter asks her own Echo *"how's Mum been this week?"* and gets a truthful, unsensational narrative. Notes go back the other way; the resident replies with one button. |
| **The Rhythm** | Wick learns what a normal week looks like in this house, so it can stay silent when nothing is wrong — and so the weekly narrative can say *"that's up from last week"* and mean it. |

## Why this needs Amazon

Wick requires a trusted screen in the room, eyes at the door with a real developer
API, a record of what was actually said during the day, and a voice endpoint the
distant family already owns.

| | Screen | Doorbell API | Wearable context | Assistant | Can build Wick? |
|---|---|---|---|---|---|
| **Amazon** | Fire TV | **Ring** | **Bee** | **Alexa+** | **Yes** |
| Google | Google TV | Nest (limited 3P) | Fitbit (no conversation) | Gemini | No |
| Apple | Apple TV | — | Watch (no conversation capture) | Siri | No |
| Roku | Roku | — | — | — | No |

Wick is not an app that happens to run on Fire TV. It is an argument for why Fire
TV sits at the centre of the Amazon home.

## Architecture

```
   Margaret's house                                          Sarah, anywhere
 ┌────────────┐          ┌─────────────────────────┐          ┌──────────┐
 │ Fire TV    │◀──WSS───▶│  Agent plane            │◀─MCP────▶│ Alexa+   │
 │ (Vega OS)  │          │   Door · Day · Narrator │  HTTPS   │ (Echo)   │
 └────────────┘          │   ───────────────────   │          └──────────┘
 ┌────────────┐          │   GUARDIAN  (policy)    │
 │ Ring       │─webhook─▶│   ───────────────────   │
 │ + Chime    │◀──REST───│  Memory plane           │
 └────────────┘          │   DynamoDB · Timestream │
 ┌────────────┐          │   Knowledge Base        │
 │ Bee bridge │─facts───▶│                         │
 └────────────┘          └─────────────────────────┘
      ▲ raw utterances never leave the house (INV-4)
```

Four planes with load-bearing boundaries: the **device** renders and never
decides; the **edge** authenticates and acknowledges inside Ring's 5-second
budget; the **agent** plane does all reasoning; the **memory** plane holds the
household's rhythm. Full detail in [`docs/WICK-TECHNICAL.md`](docs/WICK-TECHNICAL.md).

### Why these technologies

| Choice | Reason |
|---|---|
| **Vega OS** (`@amazon-devices/react-native-kepler`) | The platform Amazon is actively investing in. Wick uses two of its least-exploited surfaces — headless services and Content Personalization — for exactly what they were built for. |
| **`kepler-content-personalization`** | Gives the platform correct Continue Watching behaviour *and* gives Wick a genuine behavioural signal with no new sensor. Its `creditsPositionMs` field is the platform's own model of "the episode is ending" — which is precisely the signal the Natural-Break Engine needs. |
| **`headless-task-manager`** | Keeps the card channel alive while the app is off screen. |
| **Ring Partner API** | Live WHEP video, snapshots, event history — and `media/audio/playback`, which lets a button on a TV remote make a voice come out of the hallway. |
| **Strands Agents + Bedrock AgentCore** | Four cooperating agents with real long-horizon memory, not a single model call. |
| **MCP server** (spec 2025-11-25, Streamable HTTP) | The family's endpoint, built to Alexa+'s own published requirements — including the sub-500ms round trip, which is why the weekly narrative is precomputed rather than generated in-request. The Alexa+ add-on surface is partner-gated ([FL-001](FRICTION.md)), so it is exercised through an MCP client and a simulated Alexa+ surface, the alternative the rules permit. |

## The trust model

Privacy here is the product, not a compliance section.

1. **No camera ever shows the inside of this house to anyone.** Ring is used for the front door and for the fact that someone arrived. Never to watch the resident.
2. **The resident can see everything the family can see** — on their own television, and can remove anything from it permanently with one button.
3. **Nothing about health, money or relationships leaves the house without explicit permission.** Enforced by a policy engine ([`services/policy`](services/policy)) with property-based tests, not by the good intentions of a model.
4. **Wick reports what was said and what happened, never what it thinks you felt.** No mood detection. No wellness scores.

Deliberately **not** built: indoor camera streaming, fall detection, a chatbot on
the television, a wellness score, gamification, location tracking, sentiment
inference. Reasoning in [`docs/WICK.md`](docs/WICK.md) §4.6.

## Real data only

Every figure, event and narrative in the demo comes from a real household with a
real Ring doorbell, a real Bee device and a real Fire TV — with the resident's
written, informed, revocable consent. Nothing is simulated.

Test fixtures exist (redacted, under `__tests__`) but no mock path is reachable at
runtime: `npm run check:no-mocks` fails the build if Vega runtime code imports
anything matching `/mock/i`.

## Repository layout

```
apps/tv-vega        Vega OS application — cards, player, break engine, headless services
apps/tv-fireos      Fire OS companion build
apps/sim-alexa      Simulated Alexa+ surface — a client of the real MCP server
services/edge-ring  Ring webhook receiver — HMAC verify, idempotency, sub-5s ACK
services/edge-device WebSocket connect/disconnect/route for the television
services/mcp-server Alexa+ MCP add-on backend
services/agent      Strands agent graph + the single egress module (INV-2)
services/connectors Ring and Bee clients
services/policy     The Guardian — pure, AWS-free, exhaustively tested
packages/contracts  Shared types
packages/vega-calm-ui  ← open-source extraction: accessible 10-foot components
infra               AWS CDK
addon-package       Alexa+ addon.json + media assets
```

## Getting started

```bash
nvm use && npm install
npm run verify            # typecheck + lint + no-mocks guard + tests

# Vega application
cd apps/tv-vega && npm run build && npm run start   # Vega Virtual Device or real Fire TV

# Infrastructure
cd infra && npx cdk deploy WickCore WickEdge
```

Full setup, including Ring OAuth, the Bee household bridge and the Alexa+ add-on,
is in [`docs/WICK-TECHNICAL.md`](docs/WICK-TECHNICAL.md) §13.

## Security

No static AWS keys anywhere — CI authenticates via GitHub OIDC. Ring tokens live
in Bedrock AgentCore Identity and never touch the television, which holds a single
device-bound JWT scoped to receiving cards for one household. Ring webhooks are
HMAC-SHA256 verified with constant-time comparison and idempotency on
`request_id`. Threat model in [`docs/WICK-TECHNICAL.md`](docs/WICK-TECHNICAL.md) §10.

## Licence

MIT — see [LICENSE](LICENSE).
