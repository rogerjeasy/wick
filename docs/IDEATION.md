# Build, Ship, Shape — 10 Project Ideas Engineered to Win Fire TV Track 1st Place

**Target:** Fire TV Track — 1st Place ($25,000 cash + $15,000 AWS credits + Amazon Developer team meeting + featured on Amazon Developer channels)
**Stacked on top:** AWS Builder Mini Challenge ($5,000) + Open Source Mini Challenge ($5,000) — both are additive, both are winnable with the same codebase.
**Submission deadline:** Friday, October 23, 2026, 12:00 PT · **Judging:** Nov 9–20, 2026 · **Winners:** ~Dec 3, 2026
**Document generated:** 2026-09-14

---

## 0. How to read this document

Every idea below is written to be *built*, not pitched. Each one carries:

| Field | Why it's here |
|---|---|
| Problem + audience with numbers | Feeds **Potential Impact** — judges want "a credible, specific case for solving customer needs" |
| The inversion | Feeds **Quality of the Idea** — judges are explicitly told to "distinguish creative ideas from obvious ones" |
| Architecture + exact Amazon API/package names | Feeds **Tech Implementation** — judges ask "does it effectively leverage the required APIs, SDKs, or device capabilities" |
| Three-scene interaction model | Feeds **Design** — "a complete, coherent product experience… intuitive for the target device" |
| Real data sources table | Your hard requirement: **zero simulated data** |
| Risks + mitigations | This is where hackathon projects actually die |
| Friction-log goldmine | The documented **+10% scoring bonus** almost nobody will bother to farm |
| 3-minute shot list | Judges are *not required to watch past 3:00* |

---

## 1. Platform ground truth (verified, 2026-09-14)

This section exists because three of the ten ideas below are only novel *because* of these constraints. Everything here was verified against live Amazon documentation and the real `package.json` dependency manifests of the official `AmazonAppDev` sample apps — not from memory.

### 1.1 Vega OS — what a third-party app actually gets

Vega is React Native 0.83 on Hermes with Fabric + TurboModules, TypeScript-first. The real SDK surface, extracted from `vega-video-sample`, `vega-sports-app`, `vega-audio-sample`, `vega-tv-interfaces-sample` and `vega-epg-sample`:

| Package | What it unlocks |
|---|---|
| `@amazon-devices/react-native-kepler` | RN 0.83 core for Vega |
| `@amazon-devices/react-native-w3cmedia` | **Real W3C MSE/EME playback** — HLS/DASH, DRM |
| `@amazon-devices/kepler-player-client` / `kepler-player-server` | Out-of-process player; UI survives player crashes |
| `@amazon-devices/kepler-media-controls` | Transport control from remote **and voice** ("Alexa, pause") |
| `@amazon-devices/kepler-channel` | **Linear channel tuning**, including `"Alexa, tune to…"` |
| `@amazon-devices/kepler-epg-provider` + `kepler-epg-sync-scheduler` | Publish your own EPG into the platform guide |
| `@amazon-devices/kepler-content-personalization` | **Watch Activity reporting → Continue Watching / "Next Up For You" rows on the Fire TV home screen** |
| `@amazon-devices/headless-task-manager` | **Headless JS tasks + long-running headless services** — the app's agent can run with no UI |
| `@amazon-devices/keplerscript-turbomodule-api` | Write your own native TurboModule |
| `@amazon-devices/keplerscript-netmgr-lib` | Network state, connectivity transitions |
| `@amazon-devices/keplerscript-audio-lib` | Audio focus / ducking / mixing |
| `@amazon-devices/kepler-ui-components` + `@amazon-devices/vega-carousel` | 10-foot UI primitives, focus engine |
| `@amazon-devices/keplerscript-appstore-iap-lib` | In-app purchase (same product IDs as Fire OS) |
| `@amazon-devices/kepler-file-system`, `security-manager-lib`, `kepler-performance-api` | Storage, secure store, perf markers |
| `@amazon-devices/kepler-media-content-launcher`, `kepler-media-account-login` | **Select partners only** — do not design a demo that depends on these |

**Hard "no" list on Vega for third-party apps:** camera, microphone, Bluetooth/BLE, ambient/presence sensors, arbitrary background network wake from a push. There is **no public Fire TV Ambient Experience / Omnisense API** (confirmed open question on the Amazon Developer Community forum).

### 1.2 Fire OS — what you get instead

Fire OS is Android-based, so you keep the whole Android surface: Camera2 + **UVC USB webcam** (Fire TV Cube supports UVC webcams at 720p30 minimum for two-way calling), microphone, BLE, foreground services, and **Amazon Device Messaging (ADM)** push. Plus Login with Amazon, Appstore SDK/IAP, and the Fire TV Integration SDK.

**Strategic call:** Vega is the newer, thinner ecosystem and demonstrates "genuine understanding of the developer ecosystem" more convincingly. Fire OS gives you sensors and push. Several ideas below specify **Vega for the TV experience + a Fire OS companion build** so you can claim both, from one React Native codebase (`react-native-multi-tv-app-sample` already targets Vega, Android TV, tvOS and web from one source).

### 1.3 Ring Partner API — the real capability set

Free Ring developer account → API access. Physical device not required (simulator is acceptable per the rules), but real hardware makes the "real data" claim unimpeachable.

- **Auth:** OAuth 2.0 + PKCE (S256). Access tokens ~4h, refresh ~30d. **Server-to-server only** — `api.amazonvision.com` and `oauth.ring.com` block browser-originated calls, so your Fire TV app must never hold Ring credentials.
- **Devices:** `GET /v1/devices`, `/v1/devices/{id}/status|capabilities|location|configurations`. Multi-camera rigs addressed via `?component_id=N`.
- **Live video:** WebRTC/WHEP — `POST /v1/devices/{id}/media/streaming/whep/sessions` (Content-Type `application/sdp`). Also **RTSP**: `rtsps://video.rtsp.amazonvision.com:322/v1/devices/{id}/stream`.
- **Media:** `POST /v1/devices/{id}/media/video/download` (MP4 clips), `POST /v1/devices/{id}/media/image/download` (JPEG/PNG snapshots).
- **Webhooks (HMAC-SHA256 signed):** `motion_detected` (carries `sub_type`, e.g. `"human"`), `button_press`, `device_added|removed`, `device_online|offline`, `app_integration_added|removed`, `subscription_activated|deactivated`. Must return **HTTP 200 within 5 seconds**; idempotency via `request_id`.
- **Event history:** `GET /v1/history/devices/{id}/events`.
- **Chimes:** `POST /v1/devices/{id}/media/audio/playback` — **you can play audio out of a Ring Chime.** Almost nobody uses this. Two ideas below do.
- **Rate limit:** 100 rps; `X-RateLimit-*` and `Retry-After` headers.
- **Not exposed:** two-way audio, siren, lights, locks control endpoints.

### 1.4 Alexa+ MCP Toolkit

MCP spec **2025-11-25**, **Streamable HTTP**, self-hosted server registered as an *add-on*. Architecture is MCP Server → Alexa+ MCP Add-on → Add-on Registry → Alexa+ AI Reasoning → Orchestrator. Supports the **MCP Apps extension** for rendering interactive UI inside the conversation view. Account linking supported. **US only.** Onboarding via the Alexa AI CLI or the Add-on Agent Skill (works with Claude Code / Kiro / Codex / Cursor).

### 1.5 Bee

Real objects: **conversations, facts, todos, insights, locations, photos, todoSuggestions, search** (fast + neural modes). Surfaces: `bee-cli` (`bee login`, `bee me`, `bee today`, `bee facts list`, `bee todos list`, `bee search`), a **local HTTP proxy on 127.0.0.1:8787**, an official MCP server, and the Bee Skill. Data stays on-machine, E2E encrypted. Requires a Bee device or an Apple Watch running Bee software for genuinely real data.

### 1.6 Amazon Devices Builder Tools

`@amazon-devices/amazon-devices-buildertools-mcp` (npm) + Agent Skills at `github.com/AmazonAppDev/amazon-devices-buildertools`. Gives your coding agent Amazon-device metadata, **AI-assisted crash analysis**, and **Perfetto-based performance profiling** for Vega. Full Vega support, limited Fire OS support. **Use it and write the friction log while you do** — that's the single highest-leverage +10% in this hackathon.

---

## 2. The thesis every winning idea here shares

> **Build the thing that is impossible on Roku, Google TV, and Apple TV.**

Only Amazon owns the doorbell, the assistant, the wearable, and the television. Judges from those four product teams are scoring you. A project that is merely *a nice TV app* competes with 6,300 other entrants. A project that **can only exist because Ring + Alexa+ + Bee + Fire TV are one ecosystem** competes with almost nobody — and it answers "could it realistically serve an audience beyond the hackathon?" with a roadmap instead of a hope.

Ideas 1, 2, 4, 5, 6 and 8 below are all in that category. Ideas 3, 7, 9 and 10 are strong but more replicable elsewhere.

---

# THE TEN IDEAS

---

## IDEA 1 — **HEARTH**
### *The television becomes the care surface for the person being cared for — not another dashboard for the family.*

> **One-line pitch:** Hearth turns the one screen an older adult already looks at for seven hours a day into a patient, non-nagging agentic companion that sees the front door through Ring, hears the day through Bee, speaks through Alexa+, and keeps a distant family honestly informed — without ever turning the living room into a surveillance feed.

| | |
|---|---|
| **Primary track** | Fire TV (Vega OS primary build, Fire OS companion build) |
| **Also qualifies** | Ring track ✅ · Bee track ✅ · Alexa+ track ✅ — but **enter Fire TV**; a project can win only one track prize, and Fire TV 1st is the largest |
| **Mini challenges** | AWS Builder ✅ · Open Source ✅ |
| **Priority categories hit** | Family entertainment, multi-modal UX, computer vision, AI-enhanced viewing |
| **Primary audience** | Adults 70+ living alone or with a partner, who are cognitively intact-to-mildly-impaired and already heavy TV users |
| **Secondary audience** | Their adult children (the buyer), and paid carers / care agencies (the enterprise wedge) |
| **Difficulty** | High — the highest surface area of any idea here |
| **Demo risk** | Medium-high (needs a believable day of real data) |
| **Strategic ceiling** | **Highest.** This is the project Amazon's four device teams would collectively want to ship. |

### The problem

Roughly **53 million Americans** are unpaid family caregivers, and the large majority of them care from a distance. The tooling they have splits badly in two:

1. **Cameras nobody watches.** Ring/Nest indoor cams generate motion alerts at a volume that guarantees alert fatigue within a week. The caregiver ends up with a folder of 400 clips and no idea whether Mum ate lunch.
2. **Apps the older adult won't use.** Every care product ships a phone app for the *caregiver* and expects the *older adult* to adopt a tablet, a pendant, or a voice routine. Adoption among 80+ adults is dismal, and the person being cared for experiences the product as surveillance.

Meanwhile the single highest-attention surface in that home — a television running roughly seven hours a day for adults 65+ — is used for exactly one thing: playing video.

> *(Verify and cite each figure in the Devpost writeup: AARP "Caregiving in the U.S." for the 53M; Nielsen Total Audience for 65+ viewing hours.)*

### The inversion

Every care product asks: *how do we get data out of the home to the caregiver?*

Hearth asks: **how do we get intelligence into the home, onto a screen the older adult already trusts, without them changing a single habit?**

The output channel is the TV. The input channels are devices already in the house. The older adult does not install anything, learn anything, wear anything, or adopt anything. They keep watching *Midsomer Murders*. Hearth is simply **there**, at the natural break between episodes.

That single inversion is what makes this "creative" rather than "obvious" under the judging guidance — and it is only buildable by Amazon.

### What it actually does — three scenes

**Scene A — The door (Ring → Fire TV, ~15 seconds).**
A Ring `button_press` webhook fires. In under three seconds the TV *does not* cut away from the show. Instead, a calm 10-foot card slides into the lower third: a live WHEP still from the doorbell, and one line of large type generated from the real snapshot by a Bedrock vision model against a known-faces roster the family curated:

> **"This looks like Maria — your carer. She usually comes Tuesday mornings."**
> `▶ Watch live` `✓ Let her in is fine` `✕ Not now`

Press-and-hold on the remote plays a pre-recorded "just a moment" prompt **out of the Ring Chime** via `POST /v1/devices/{id}/media/audio/playback`. Nobody has to get to the door before the visitor leaves.

**Scene B — The day (Bee → agent → TV, at a natural break).**
Hearth owns the player, so it knows exactly when an episode ends. *Only then* — never mid-scene — a full-screen, high-contrast card appears. The agent has been reading the real Bee stream (`GET /v1/stream` SSE, plus `/v1/facts` and `/v1/todos`) all day and noticed three things that mattered:

> **"A few things from today, Margaret."**
> • *Dr. Lee's office rang about Thursday. Want me to ask Sarah to call them back?*
> • *You mentioned your knee was sore again this morning.*
> • *Sarah sent you a message.* `▶ Play`

Sarah's note plays. Margaret picks a reply from three agent-drafted options with the D-pad — one button, no keyboard, no phone. Sarah gets it on her phone in London.

**Scene C — The week (agent → Alexa+ MCP, from anywhere).**
Sarah, at her kitchen Echo Show in London, says *"Alexa, how's Mum been this week?"* The Alexa+ add-on routes to Hearth's self-hosted MCP server, which answers with a **narrative, not a dashboard**:

> *"Steady week. She's been up around 7 every morning and out to the shops Tuesday and Friday. Maria came both her usual days. She mentioned her knee twice — that's up from once last week. One thing: Thursday she was up at 2am and the kitchen light was on for about forty minutes. Want me to show you that, or flag it for Dr. Lee?"*

An MCP Apps UI renders the week's timeline in the conversation view. **Nothing about this required Margaret to do anything.**

### Architecture

**On-device (Vega OS / Fire TV)**
- React Native 0.83 app built from `react-native-multi-tv-app-sample`, using `@amazon-devices/kepler-ui-components` + `vega-carousel` for the 10-foot surface and `@amazon-devices/react-native-w3cmedia` for playback (real content: the household's own Plex/Jellyfin library, Internet Archive public-domain catalogue, or a FAST channel — all real, all legally streamable).
- **`@amazon-devices/headless-task-manager`** runs a *headless service* that holds a persistent WebSocket to the Hearth backend. This is the load-bearing technical choice: the agent stays live while the app is backgrounded, so the door card can appear over whatever is playing.
- **`@amazon-devices/kepler-content-personalization`** reports Watch Activity so the platform's own Continue Watching row works — and, more interestingly, so the agent learns the household's real rhythm (when the TV goes on, when it goes off, what "an evening" looks like) as a genuine behavioural signal rather than a survey.
- **`@amazon-devices/kepler-media-controls`** so "Alexa, pause" works and so the agent can duck audio politely rather than interrupting.
- Design system: minimum 32pt type, ≥7:1 contrast, no time-limited interactions, every card dismissible with one button, zero red badges.

**Cloud (AWS — the Builder mini challenge)**
- **Amazon Bedrock AgentCore Runtime** hosts the Hearth agent; **AgentCore Memory** holds the household's long-horizon episodic memory (this is what makes "that's up from last week" possible); **AgentCore Identity** brokers the Ring OAuth tokens so no credential ever touches the TV; **AgentCore Gateway** exposes the tool surface that the Alexa+ MCP server proxies.
- **Strands Agents SDK** for the multi-agent graph: a *Door* agent (Ring events), a *Day* agent (Bee stream), a *Narrator* agent (writes the family summary), and a *Guardian* agent that holds the disclosure policy.
- **Amazon Bedrock (Nova / Claude)** for vision over real Ring snapshots and for narrative generation. **Amazon Rekognition** optionally for the family-curated known-faces roster (explicit opt-in, family-managed, deletable).
- **Amazon Polly** (neural, generative) for the TV's voice; **Amazon Transcribe** for Sarah's voice notes.
- **EventBridge** for the Ring webhook fan-out, **DynamoDB** for the timeline, **Timestream** for rhythm baselines, **S3 Vectors / Bedrock Knowledge Bases** over the household's accumulated facts.
- **API Gateway (HTTP API) + Lambda** terminating the Ring webhook — must return 200 inside 5 seconds, so the handler does signature verification + enqueue only.
- **AWS IoT Core** for the device WebSocket if you want managed MQTT over WSS to the TV.

**Cross-device**
- **Alexa+ MCP add-on** (spec 2025-11-25, Streamable HTTP), self-hosted on AgentCore Runtime behind API Gateway. Tools: `get_day_summary`, `get_week_narrative`, `ask_about_person`, `send_note_to_tv`, `get_door_events`, `escalate_to_family`. MCP Apps extension renders the timeline UI.
- **Bee** via the local proxy on a small always-on machine in the home (or the Bee Skill inside the agent), consuming `/v1/stream`, `/v1/facts`, `/v1/todos`, `/v1/daily`.

### Amazon & AWS surface — the table judges will read

| Capability | Exact API / package | What it does here |
|---|---|---|
| TV app runtime | `@amazon-devices/react-native-kepler` | Vega OS app |
| Background agent | `@amazon-devices/headless-task-manager` | Headless service keeps the agent live off-screen |
| Household rhythm signal | `@amazon-devices/kepler-content-personalization` | Watch Activity → real behavioural baseline |
| Polite interruption | `@amazon-devices/keplerscript-audio-lib`, `kepler-media-controls` | Duck, don't interrupt |
| Playback | `@amazon-devices/react-native-w3cmedia` | Real MSE/EME playback |
| Doorbell / motion | Ring webhooks `button_press`, `motion_detected` (`sub_type: human`) | Scene A trigger |
| Who's at the door | Ring `POST /media/image/download` + Bedrock vision | Plain-language description |
| Live view on TV | Ring `POST /media/streaming/whep/sessions` | `▶ Watch live` |
| Speak to the visitor | Ring `POST /media/audio/playback` (Chime) | "Just a moment" without reaching the door |
| Was the carer actually here | Ring `GET /v1/history/devices/{id}/events` | Visit verification, not surveillance |
| The day's real content | Bee `/v1/stream`, `/v1/facts`, `/v1/todos`, `/v1/daily` | Scene B content |
| Family voice access | Alexa+ MCP add-on, Streamable HTTP, MCP Apps | Scene C |
| Agent runtime + memory | Bedrock AgentCore Runtime / Memory / Identity / Gateway | The agent itself |
| Agent orchestration | Strands Agents SDK | Four-agent graph |
| Reasoning + vision | Amazon Bedrock (Nova, Claude) | Descriptions, narrative |
| Voice | Amazon Polly, Amazon Transcribe | TV speech, note transcription |

### Real data — no simulation anywhere

| Source | What's genuinely real | How you get it | Cost |
|---|---|---|---|
| Ring Video Doorbell + Indoor Cam | Real `button_press` / `motion_detected` events, real snapshots, real WHEP streams, real event history | Free Ring developer account → Partner API; devices ~$100 + ~$60 | ~$160 hardware |
| Bee device (or Apple Watch + Bee) | Real conversations, facts, todos, daily summaries from a real person's real day | `bee login`, `bee proxy` | Bee device cost |
| The TV itself | Real Watch Activity, real on/off rhythm, real content metadata | Vega Content Personalization API | £0 |
| Household content | Real Plex/Jellyfin library or Internet Archive public domain | Local network / `archive.org` API | £0 |
| Family notes | Real recorded audio from a real family member | Alexa+ / phone → Transcribe | £0 |

**Nothing is mocked.** For the demo you are the household: your own Ring, your own Bee, your own TV, one real week of data.

### Why it scores on all four criteria

- **Tech Implementation** — Uses six distinct Vega SDK packages *for what they are actually for*, including the two nobody will touch (`headless-task-manager`, `kepler-content-personalization`). Correct Ring server-to-server security posture. Real MCP 2025-11-25 add-on. Multi-agent AWS architecture, not a single Bedrock call.
- **Design** — The interaction model is the idea. Never interrupts mid-scene. One button. 32pt type. No red badges. This is a genuinely *considered* 10-foot experience for a user population that every other product designs past.
- **Potential Impact** — A real market with a real buyer (the adult child) and a real enterprise wedge (care agencies verifying visits). Fire TV Appstore + Ring Appstore distribution, subscription pricing, and a device bundle Amazon could literally sell.
- **Quality of the Idea** — The inversion is legible in one sentence and defensible for ten minutes. It demonstrates understanding of all four device ecosystems *and* of the end users within them.

### Novelty check

| What exists | Why Hearth is different |
|---|---|
| Ring/Nest alert apps | Alerts a distant caregiver. Hearth serves the *resident* and suppresses alert noise with context. |
| Medical alert pendants | Reactive, worn, stigmatised. Hearth is ambient and worn by nobody. |
| Care dashboards (CareZone, Papa, Birdie) | Caregiver-facing dashboards. Hearth's primary surface is the care recipient's TV. |
| Alexa Together (discontinued) | Amazon tried voice-only. Hearth adds the screen, the door, and the day. |
| "AI companion" TV apps | Chat on a TV. Hearth never asks the older adult to converse with a machine. |

### Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Vega app cannot be foregrounded from a background event | **High** | Design Scene A as an overlay from the *already-running* headless service while the app is the active foreground app (TV is on and Hearth is playing). Document this honestly — and file it as your headline **feature request** ("third-party ambient/overlay surface on Vega"). Judges reward the honest platform read. |
| Ring webhook 5-second budget | Medium | Lambda does HMAC verify + EventBridge put only; all inference is downstream and async. |
| Surveillance perception | **High** | Hard product stance: **no indoor camera streaming to family, ever.** Ring is used for the door and for arrival/departure *events*, never for watching the resident. Put this on screen in the demo. |
| Bee data is intimate and the TV is a shared screen | High | The Guardian agent enforces a written disclosure policy: facts tagged health/financial/relationship never render on the TV without the resident's own prior consent, and the family narrative is redacted by policy, not by vibes. |
| Scope | **High** | Three scenes. Nothing else. Cut the known-faces roster before you cut the polish. |

### Open Source mini-challenge play

Ship **`react-native-vega-a11y`** — a genuinely reusable MIT-licensed Vega OS component library for large-type, high-contrast, single-action 10-foot cards, with a focus-order linter rule for `@amazon-devices/eslint-plugin-kepler`. Then open a **PR to `AmazonAppDev/react-native-multi-tv-app-sample`** adding an accessibility-preset theme. That is precisely the "new integration pattern / meaningful feature addition" the rules call creative.

### Friction-log goldmine (+10%)

You will hit, and should document with severity, steps, expected-vs-actual and a suggested fix: (1) no ambient/overlay surface for third-party Vega apps; (2) `kepler-media-content-launcher` and `kepler-media-account-login` gated to select partners with no sandbox; (3) Ring's browser-CORS block forcing an extra backend hop for TV apps; (4) no Ring two-way audio endpoint despite the hardware supporting it; (5) Alexa+ MCP add-on being US-only; (6) Bee proxy's 120s idle timeout fighting a long-lived SSE consumer.

### Path to real customers

Consumer: $12–19/mo, bought by the adult child, bundled with a Fire TV Stick + Ring Doorbell starter kit. Enterprise: home-care agencies pay per-client for **verified visit attestation** (Ring event history is legally cleaner than a carer's self-reported timesheet — EVV compliance is a real, funded US requirement). Both are Appstore-distributable.

### 3-minute shot list

| Time | Shot |
|---|---|
| 0:00–0:12 | Real footage: a TV playing in a real living room. One line of text: *"The average 78-year-old looks at this screen for 7 hours a day. It has never once looked back."* |
| 0:12–0:35 | Scene A live — real doorbell press, real card on a real Fire TV, real Chime audio playing |
| 0:35–1:05 | Scene B live — real Bee data becoming the end-of-episode card; real one-button reply |
| 1:05–1:35 | Scene C live — real Echo Show, real Alexa+ answer, real MCP Apps timeline |
| 1:35–2:15 | Architecture in 40 seconds: the Vega packages, the Ring endpoints, the AgentCore graph — on screen, named |
| 2:15–2:40 | The privacy stance, stated plainly: no indoor camera ever leaves the house |
| 2:40–2:55 | The market and the bundle |
| 2:55–3:00 | Repo + licence card |

### Kill criteria

If by week 2 the headless service cannot reliably surface a card over playing content on real hardware, **drop Scene A to "card appears when the TV is on Hearth's home screen"** and keep everything else. Do not let the overlay problem eat the project.

---

## IDEA 2 — **STEADY**
### *The Ring camera becomes the physiotherapist's eyes; the Fire TV becomes their voice.*

> **One-line pitch:** Steady runs a real, evidence-based fall-prevention and rehab programme on the television, using the Ring Indoor Cam already in the living room as the computer-vision sensor — counting reps, correcting form, and administering genuinely validated clinical tests like the CDC's 30-Second Chair Stand, producing a score a physiotherapist can actually act on.

| | |
|---|---|
| **Primary track** | Fire TV (Vega OS) |
| **Also qualifies** | Ring track ✅ |
| **Mini challenges** | AWS Builder ✅ · Open Source ✅ |
| **Priority categories hit** | **Fitness ✅ · Computer vision ✅** — two of the six named Fire TV priorities, head-on |
| **Primary audience** | Adults 65+ prescribed a home exercise programme after a fall, a hip/knee replacement, or a Timed-Up-and-Go screening |
| **Secondary audience** | Outpatient physio clinics, Medicare Advantage plans, and the 55–70 "pre-hab" cohort |
| **Difficulty** | Medium-high |
| **Demo risk** | **Low — this is the most visually convincing demo of the ten** |
| **Strategic ceiling** | Very high. Cleanest "Tech Implementation" story in the document. |

### The problem

**One in four Americans aged 65+ falls each year.** Falls are the leading cause of injury death in that age group and drive tens of billions in annual US medical cost. The intervention works: structured programmes like the **Otago Exercise Programme** and the CDC's **STEADI** initiative reduce fall rates substantially in the trials.

They fail in the home. Adherence to unsupervised home exercise programmes collapses within weeks — the patient is handed a photocopied sheet of stick figures, does the exercises wrong or not at all, and nobody finds out until the next fall. The clinician has *no signal whatsoever* between appointments.

### The inversion — and the reason this is the strongest technical idea here

Everyone who has ever pitched "computer-vision fitness on the TV" hits the same wall: **Fire TV has no camera API.** Vega exposes none. It is the single most-requested thing that isn't there.

Steady's move: **the camera and the display don't have to be the same device.**

There is, statistically, already a camera pointed at the exact room where this exercise happens — a Ring Indoor Cam on the bookshelf. Ring's Partner API hands you that feed **server-to-server**, in real time, two ways:

```
POST /v1/devices/{id}/media/streaming/whep/sessions     # WebRTC/WHEP
rtsps://video.rtsp.amazonvision.com:322/v1/devices/{id}/stream   # RTSP
```

So the pipeline is: **Ring camera → your VPC → pose estimation → WebSocket → Fire TV coaching overlay.** The pixels never touch the television; only 33 pose landmarks come back. That is a better privacy story *and* a better engineering story than an on-TV camera would have been.

This is a genuinely new architecture for the Amazon ecosystem, it is impossible on any competing TV platform, and it turns the platform's biggest gap into the product's defining idea. Judges will notice.

### What it actually does — three scenes

**Scene A — Setup, once, in 30 seconds.**
Steady lists the household's Ring devices (`GET /v1/devices?include=capabilities,location`), and asks on the TV: *"Which camera can see where you'll be exercising?"* It pulls one snapshot per candidate (`POST /media/image/download`), shows them as a 10-foot picker, and the user presses OK. Steady then runs a real framing check — "step back until you're in the blue box" — using live landmarks, and tells them when they're good. **No phone involved at any point.**

**Scene B — The session.**
The TV plays the real Otago exercise (knee extension, sit-to-stand, heel-toe walk) with a large, slow demonstration. In the corner, a live skeleton overlay of the user, rendered from real landmarks streaming back at 15–30 fps. The agent coaches out loud through Polly:

> *"That's four. Try to stand without pushing off — hands crossed if you can."*
> *"Your left knee is drifting inward. Point it over your second toe."*

Rep counting is real (landmark-angle state machine). Form correction is real (joint-angle thresholds from the published protocol). It **stops the set** if it sees loss of balance, and offers to switch to the chair-supported variant.

**Scene C — The measurement that makes it medicine.**
Once a fortnight, Steady administers the **CDC STEADI 30-Second Chair Stand Test** — a genuinely validated clinical instrument — entirely by camera. It counts real stands in 30 real seconds, compares against the published age-and-sex-normed cut-offs, and produces:

> **"14 stands. That's above the cut-off for your age band — and up from 11 four weeks ago."**
> `📄 Send this to Dr. Okafor` `📈 See the trend`

That output is a **clinically legible longitudinal measure generated at home, for free, by a $60 camera and a $30 streaming stick.** That is the sentence that wins the Potential Impact criterion.

### Architecture

**On-device (Vega OS)**
- `@amazon-devices/react-native-w3cmedia` plays the real exercise videos.
- `@amazon-devices/react-native-svg` + `react-native-reanimated` + `react-native-worklets` render the live skeleton overlay at 60fps without blocking the JS thread.
- `@amazon-devices/headless-task-manager` holds the WebSocket to the landmark stream and pre-fetches the next session overnight.
- `@amazon-devices/kepler-ui-components` + strict D-pad focus order; **every single interaction is reachable with four arrows and OK**.
- `@amazon-devices/kepler-performance-api` markers around the render loop — then profile it with the **Amazon Devices Builder Tools MCP Perfetto tooling** and put the trace in the README. Judges love a measured app.

**Cloud (AWS)**
- **Ring ingest:** ECS Fargate task pulls RTSP (GStreamer/FFmpeg) or terminates a WHEP session; alternatively push into **Amazon Kinesis Video Streams** for a managed, replayable path.
- **Pose:** MoveNet Thunder / MediaPipe Pose on a **SageMaker real-time endpoint** (GPU) or a Fargate task with ONNX Runtime. Target end-to-end glass-to-glass under 400ms.
- **Coaching agent:** **Strands Agents SDK** on **Bedrock AgentCore Runtime** — a *Form* agent (geometric rules from the protocol), a *Coach* agent (Bedrock/Nova, chooses what to say and when to shut up), a *Safety* agent (stops the session on instability), and a *Clinician* agent (writes the progress note).
- **AgentCore Memory** holds the patient's programme history; **Timestream** the rep/angle time series; **DynamoDB** session state; **Polly (generative)** the voice; **S3** the clinician PDF.
- **AgentCore Identity** holds Ring OAuth tokens. **The TV never sees a Ring credential.**

### Amazon & AWS surface

| Capability | Exact API / package | Role |
|---|---|---|
| Camera feed | Ring WHEP `POST /media/streaming/whep/sessions` **or** RTSP `rtsps://video.rtsp.amazonvision.com:322/...` | The eyes |
| Camera selection | `GET /v1/devices` + `POST /media/image/download` | 30-second setup |
| Multi-camera rigs | `?component_id=N` | Ring Elite / multi-module support |
| Exercise playback | `@amazon-devices/react-native-w3cmedia` | Real video |
| Live overlay | `react-native-svg` + `reanimated` + `worklets` | Skeleton at 60fps |
| Background session prep | `@amazon-devices/headless-task-manager` | Pre-fetch, keep socket warm |
| Measured performance | `@amazon-devices/kepler-performance-api` + Builder Tools Perfetto | Proof of engineering rigour |
| Pose inference | Amazon SageMaker real-time endpoint | 33 landmarks |
| Video ingest | Amazon Kinesis Video Streams / ECS Fargate | Managed RTSP/WHEP pipeline |
| Agents | Strands Agents SDK on Bedrock AgentCore Runtime | Four-agent coaching graph |
| Memory / history | AgentCore Memory + Amazon Timestream | Longitudinal clinical signal |
| Voice | Amazon Polly generative | The coach's voice |
| Secrets | AgentCore Identity | Ring OAuth custody |

### Real data — no simulation anywhere

| Source | What's real | How |
|---|---|---|
| Ring Indoor Cam 2 (~$60) | Real live video of a real person doing real exercises | Ring Partner API, WHEP or RTSP |
| Pose landmarks | Computed from that real video in real time | MoveNet/MediaPipe |
| **Otago Exercise Programme** | A real, published, evidence-based protocol | Public clinical literature (ACC New Zealand / peer-reviewed) |
| **CDC STEADI 30-Second Chair Stand** | A real validated instrument with real published age/sex norms | CDC STEADI materials (public domain, US Government) |
| Exercise demonstration video | Film it yourself, or use CDC/NIH public-domain materials | Public domain |
| Progress trend | Real measurements of a real person over real weeks | Your own data — start recording now |

**Start collecting your own real baseline the week you begin building.** A four-week real trend line in the demo video is worth more than any amount of architecture narration.

### Why it scores on all four criteria

- **Tech Implementation** — This is the strongest in the document. It uses a Ring device capability (live WHEP/RTSP) in a way its designers plainly didn't have in mind, solves a real platform gap, and the whole thing is measurable: latency, fps, rep-count accuracy vs. hand count. Publish those numbers.
- **Design** — A complete product loop (set up → do → measure → share) with an interaction model honestly built for a D-pad and a person standing three metres away. No text entry anywhere.
- **Potential Impact** — Fall prevention is one of the best-quantified problems in public health, and the buyer set (patients, clinics, Medicare Advantage plans, home-care agencies) is real and funded. Fire TV Appstore + Ring Appstore distribution.
- **Quality of the Idea** — "The camera and the screen are different Amazon devices" is a genuinely creative read of the ecosystem, and the clinical-test framing shows real understanding of the end user, not just the platform.

### Novelty check

| What exists | Why Steady is different |
|---|---|
| Peloton / Apple Fitness+ / Fiit on TV | Zero sensing. Video plays at you. |
| Kaia Health, Hinge Health, Sword Health | Phone-camera based, phone-screen based; the 78-year-old cohort doesn't prop a phone against a vase. |
| Tempo, Tonal | £2,000+ dedicated hardware. |
| Ring "workout mode" | Does not exist. |
| Anything on Roku / Google TV / Apple TV | **Cannot exist** — none of them own a camera in your living room with a partner API. |

### Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Ring live-stream latency / session duration limits | **High** | Measure on day one. If WHEP sessions are short-lived, use RTSP; if both are constrained, pivot Scene B to **set-based capture** (record a 30s clip via `POST /media/video/download`, analyse, then coach between sets). Still excellent, still real. |
| Pose accuracy at living-room distance/lighting | Medium | Use MoveNet Thunder, not Lightning. Run the framing check in setup. Refuse to score if confidence is low — *refusing* is a feature for a clinical tool. |
| Clinical claims | **High** | Never say "diagnose" or "prescribe." Say: *"a home measurement tool that administers a published screening test and shares the result with your clinician."* Put a plain disclaimer on screen in the demo. |
| Privacy | High | Frames never persist; only landmarks leave the inference task; session is explicitly started by the user on the TV; a hard on-screen indicator when the camera is live. |
| Ring rate limits (100 rps) | Low | Trivially within budget. |

### Open Source mini-challenge play

Ship **`ring-rtsp-pose`** (MIT): a small, well-tested library that takes a Ring Partner API device id and yields a normalised pose-landmark stream, handling WHEP negotiation, RTSP fallback, token refresh via AgentCore Identity, and backpressure. **This is a genuinely missing piece of ecosystem infrastructure** and is exactly the "new integration pattern" the rules describe. Add a PR to `AmazonAppDev/ring-api-helloworld` demonstrating the streaming path.

### Friction-log goldmine (+10%)

(1) No documented WHEP session duration/concurrency limits; (2) no camera/vision API on Vega at all — file as a critical feature request; (3) RTSP endpoint undocumented re: codec/GOP/latency characteristics; (4) no way to query "is a person currently visible" without pulling full video; (5) Vega's lack of a GPU-accelerated overlay compositing path for high-frequency vector rendering; (6) Builder Tools Perfetto workflow friction.

### Path to real customers

B2C: $9.99/mo, sold alongside a Fire TV Stick + Ring Indoor Cam bundle. B2B2C: outpatient physio clinics pay per-patient for between-visit adherence and chair-stand trend data; Medicare Advantage plans fund fall-prevention because falls are a top cost driver. The clinician PDF is the wedge.

### 3-minute shot list

| Time | Shot |
|---|---|
| 0:00–0:10 | *"Fire TV has no camera. So we used the one already in the room."* — cut to the Ring Indoor Cam on a shelf |
| 0:10–0:30 | Real 30-second setup on a real Fire TV, D-pad only |
| 0:30–1:20 | **The money shot:** real person, real living room, real skeleton overlay on the TV, real audible coaching, real rep counter incrementing |
| 1:20–1:50 | Real 30-Second Chair Stand test, real score, real comparison to the real CDC norm table |
| 1:50–2:20 | The four-week real trend + the clinician PDF |
| 2:20–2:45 | Architecture: Ring WHEP → Fargate → SageMaker → WebSocket → Vega. Measured latency on screen. |
| 2:45–3:00 | Market, repo, licence |

### Kill criteria

If real-time streaming proves infeasible inside week 1, switch to the **clip-based** variant immediately — it preserves every claim except live coaching, and it is still a stronger demo than 90% of the field.

---

## IDEA 3 — **LEVERAGE**
### *An agent that watches every live game so you don't have to — and guarantees it will never spoil the one you're saving.*

> **One-line pitch:** Leverage ingests real-time play-by-play from every live game, computes how much each moment actually matters *to you*, and moves your Fire TV to the moment that's about to become great — while enforcing a rigorous per-user spoiler firewall that scrubs results out of the guide, the rows, and the agent's own mouth for any game you're time-shifting.

| | |
|---|---|
| **Primary track** | Fire TV (Vega OS) |
| **Mini challenges** | AWS Builder ✅ · Open Source ✅ |
| **Priority categories hit** | **Sports ✅ · AI-enhanced viewing ✅ · Multi-modal UX ✅** |
| **Primary audience** | Cord-cutting multi-sport fans, fantasy players, and the "I have four teams and two hours" viewer |
| **Secondary audience** | Anyone who has ever had a game spoiled by a push notification |
| **Difficulty** | Medium |
| **Demo risk** | Medium — you need live games during filming (schedule around a real slate) |
| **Strategic ceiling** | High. Sports is a named Fire TV priority and Amazon is spending billions on live sports rights. |

### The problem

Two distinct pains, both universal, both unsolved on any TV platform:

1. **You cannot be in ten places at once.** On a Sunday or a summer Tuesday there are 10–15 live games. Fans "doom-flip" — mashing the remote, arriving late to everything, missing the three moments that mattered. NFL RedZone solves exactly one league, is human-operated, is not personalised, and costs extra.
2. **The spoiler problem is worse than the discovery problem.** You recorded the match. Then the TV home screen shows you a thumbnail captioned "Stunning comeback," or the guide shows a final score, or you ask the assistant an unrelated question and it volunteers the result. The moment is destroyed by your own devices.

### The inversion

Every sports product optimises **discovery** — *what should I watch?* Leverage optimises **timing and integrity** — *when should I be watching, and what must I never be told?*

And the second half is the genuinely novel engineering: **spoiler integrity as a first-class, enforced system property.** Nobody has built it. It is hard, it is demoable in ten seconds, and it makes an audience laugh with recognition.

Crucially, Vega makes it *actually possible* rather than merely aspirational. Because you own `kepler-epg-provider`, you own what the guide shows. Because you own `kepler-content-personalization`, you control what lands in the Continue Watching and Next Up rows. You can genuinely enforce a **temporal knowledge horizon** per viewer across the platform's own surfaces — not just inside your app.

### What it actually does — three scenes

**Scene A — The routing.**
You're watching one game. Elsewhere, a real game enters a genuinely high-leverage state — bases loaded, two out, one-run game, bottom of the 8th; or 3 minutes left, 4-point game, ball on the 12. Leverage computes a **Moment Value** from real win-probability swing × your personal stake (your teams, your real fantasy roster) and surfaces a single, non-intrusive strip:

> **`⚾ Bases loaded, 2 out, Rodríguez up — 8th, 1-run game.  Win prob swing: 31%.  Your player.`**
> `▶ Take me there` (or just say *"Alexa, go"*)

One press, or one word, and the TV moves — via `@amazon-devices/kepler-channel` for a real linear channel, or a deep link for an app. When it's over, `↩ Back to where I was` restores your prior stream at the right timestamp.

**Scene B — The spoiler firewall.**
You have a recorded match you haven't watched. Leverage sets a **knowledge horizon** for that fixture. From that moment:
- The EPG entry Leverage publishes shows no score.
- The Next Up row shows no result thumbnail.
- The agent, asked *anything*, refuses precisely and charmingly: *"I'm keeping Arsenal–Spurs sealed. Ask me after you've watched."*
- If another household member has already watched it, **their** horizon differs and their view is unredacted. Per-viewer, not per-household.

Demo this by asking, on camera, *"Alexa, what was the score?"* and having it decline. That is a ten-second clip people will replay.

**Scene C — The catch-up cut.**
Joined late? Leverage assembles, from real play-by-play, a *why-you-should-care* card — not a highlight reel (you don't have the rights), but a genuinely useful state summary: the three plays that created the current situation, the current leverage index, and what's at stake. Then it drops you into the live feed.

### Architecture

**On-device (Vega OS)**
- `@amazon-devices/kepler-channel` — real channel tuning, including `"Alexa, tune to…"` voice entry.
- `@amazon-devices/kepler-epg-provider` + `kepler-epg-sync-scheduler` — you publish the guide, so you control the redaction.
- `@amazon-devices/kepler-content-personalization` — Watch Activity both feeds the platform rows *and* tells the agent what you've actually seen, which is how the knowledge horizon stays accurate without asking you.
- `@amazon-devices/headless-task-manager` — the routing agent runs headless so the strip can appear over any playback.
- `@amazon-devices/kepler-media-controls` — voice transport; `@amazon-devices/react-native-w3cmedia` — playback.
- Multi-modal by construction: **every action works by D-pad, by voice, or by both** — which is literally the judges' stated example of creative Fire TV UX.

**Cloud (AWS)**
- **Amazon Kinesis Data Streams** ingests normalised play events from all live games; **Lambda** consumers compute win-probability deltas and leverage; **Amazon Timestream** stores the moment-value time series.
- **Strands Agents SDK** on **Bedrock AgentCore Runtime**: a *Scout* agent (watches all games), a *Router* agent (decides whether interrupting you is worth it — this is the hard, tasteful part), a *Redactor* agent (enforces the horizon over every outbound string), and a *Narrator* agent (writes the catch-up card via Bedrock/Nova).
- **AgentCore Memory** holds per-viewer horizons and stake profiles. **DynamoDB** for fixtures, **EventBridge** for schedule triggers.
- The **Redactor is a real, testable component**: every string leaving the system passes through it, and you ship property-based tests proving no score leaks for a sealed fixture. Put that test suite in the README.

### Amazon & AWS surface

| Capability | Exact API / package | Role |
|---|---|---|
| Move the TV | `@amazon-devices/kepler-channel` | Real tuning, including by voice |
| Own the guide | `kepler-epg-provider` + `kepler-epg-sync-scheduler` | Where redaction is enforced |
| Own the rows | `kepler-content-personalization` | Watch Activity in, redacted rows out |
| Background agent | `headless-task-manager` | Routing while you watch |
| Voice + D-pad parity | `kepler-media-controls` + focus engine | The multi-modal claim |
| Real-time pipeline | Kinesis Data Streams + Lambda + Timestream | Moment Value |
| Agents | Strands + AgentCore Runtime + Memory | Scout / Router / Redactor / Narrator |
| Generation | Bedrock (Nova / Claude) | Catch-up cards |
| Optional voice-first | Alexa+ MCP add-on | *"Alexa, is anything good on right now?"* |

### Real data — no simulation anywhere

| Source | What's real | Access | Cost |
|---|---|---|---|
| **MLB Stats API** (`statsapi.mlb.com`, docs at `docs.statsapi.mlb.com`) | Official, free, real-time pitch-by-pitch live feed with game state | Public HTTP, no key | Free |
| **NHL API** (`api-web.nhle.com`) | Real play-by-play, live game state | Public HTTP | Free |
| **football-data.org** | Real fixtures, live scores for major European leagues | Free tier w/ key | Free |
| **TheSportsDB** | Real schedules, teams, logos across many leagues | Free tier | Free |
| **Sleeper API** | **Real fantasy rosters** — public, no key, no OAuth | Public HTTP | Free |
| Free ad-supported live channels | Real live linear streams for the tuning demo | Public FAST feeds | Free |

> **Check each provider's terms before submission** and say so in the README — "Third Party Integrations: Entrant must be authorized to use them" is an explicit rule. Prefer official league APIs (MLB, NHL) over scraped endpoints.

### Why it scores

- **Tech Implementation** — Uses the three Vega packages nobody else will touch (`kepler-channel`, `kepler-epg-provider`, `kepler-content-personalization`) for their actual purpose, plus a real streaming pipeline. The Redactor is a genuine, verifiable system invariant with tests.
- **Design** — Multi-modal parity (voice/D-pad/visual) is the judges' own stated example. Interruption taste is the design work, and it's visible.
- **Potential Impact** — Sports is where Amazon is spending. This is a feature Fire TV could ship, and the spoiler firewall is a "why didn't this always exist" capability.
- **Quality of the Idea** — Spoiler integrity as an enforced platform property is a genuinely novel framing.

### Novelty check

| What exists | Why Leverage is different |
|---|---|
| NFL RedZone | One league, human-operated, not personalised, no spoiler model |
| ESPN / theScore alerts | Push notifications — the *cause* of the spoiler problem |
| Multiview on Fire TV / YouTube TV | Shows you four games; doesn't tell you which one matters |
| "Spoiler-free mode" toggles | Hide a score in one app. Leverage enforces across the guide, the rows and the agent. |

### Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| You don't hold rights to the streams you'd tune to | **High** | Demo tuning across **real free ad-supported live channels** and your own test stream; for premium apps, deep-link rather than embed. Be explicit in the video that Leverage *routes*, never rehosts. |
| `kepler-media-content-launcher` is select-partners-only | High | Do not build the demo on it. Use `kepler-channel` + your own EPG. File it as a feature request. |
| Live games must exist during filming | Medium | Schedule filming against a real slate. Record a real fallback session. |
| Interrupting a viewer badly is worse than not interrupting | Medium | Router agent gets an explicit budget: max N interruptions/hour, learned from real accept/dismiss data. |

### Open Source mini-challenge play

Ship **`leverage-core`** (Apache-2.0): a league-agnostic library that normalises MLB/NHL/football feeds into a single `MomentValue` stream with pluggable win-probability models — plus **`spoiler-horizon`**, a tiny, well-tested redaction middleware that any sports app could adopt. The second one is the genuinely useful contribution.

### Friction-log goldmine (+10%)

(1) `kepler-channel` tuning semantics for non-partner apps; (2) EPG sync scheduler cadence limits vs. live sports volatility; (3) no documented way to suppress *platform-generated* rows/artwork for a specific title (this is the real blocker to true spoiler integrity — file as **critical**); (4) Content Launcher gating; (5) headless task wake latency under playback load.

### Path to real customers

Freemium: routing free, multi-league + fantasy stake + spoiler firewall at $4.99/mo. The real prize is licensing the spoiler-integrity layer to Fire TV itself, or to a rights-holder app. Fire TV Appstore distribution.

### 3-minute shot list

| Time | Shot |
|---|---|
| 0:00–0:12 | Real remote, real doom-flipping between four real live games. *"You will miss all three of the moments that mattered."* |
| 0:12–0:45 | Real routing: the strip appears, one press, TV moves, real high-leverage moment plays out |
| 0:45–1:20 | **The spoiler firewall clip** — ask Alexa the score on camera, watch it decline; show the redacted guide next to another viewer's unredacted guide |
| 1:20–1:45 | Catch-up card built from real play-by-play |
| 1:45–2:25 | Architecture + the Redactor test suite going green on screen |
| 2:25–3:00 | Market, repo, licence |

### Kill criteria

If real-time win probability proves noisy across leagues, ship with **MLB + NHL only** (both official and free) and say so. Depth beats breadth here.

---

## IDEA 4 — **COUNTER**
### *The $30 back-of-house manager: a Fire TV Stick and the Ring cameras a small business already owns.*

> **One-line pitch:** Counter turns a $30 Fire TV Stick and an existing wall-mounted TV into the operations screen a corner shop, clinic, workshop or gym has never been able to afford — with an agent that triages real Ring events into the three things staff actually need to act on right now, and answers the owner's questions from home through Alexa+.

| | |
|---|---|
| **Primary track** | Fire TV (Fire OS or Vega OS) |
| **Also qualifies** | Ring track ✅ (priority categories: **access control, business systems** ✅) |
| **Mini challenges** | AWS Builder ✅ · Open Source ✅ |
| **Primary audience** | Owner-operated businesses with a physical door and 1–20 staff: convenience shops, dental and vet clinics, barbershops, auto shops, gyms, self-storage, small warehouses |
| **Secondary audience** | Multi-site franchisees; commercial property managers |
| **Difficulty** | Medium (lowest-risk build in this document) |
| **Demo risk** | **Low** |
| **Strategic ceiling** | High on Potential Impact — the clearest, most boring-in-a-good-way commercial story here |

### The problem

There are **over 33 million US small businesses**, and several million of them have a physical door, a camera at it, and a television on a wall in the back. What they do not have is anything connecting the two.

The daily losses are unglamorous and enormous in aggregate: a customer stands at an unattended counter and leaves; a delivery arrives at the rear door and the driver leaves a "sorry we missed you" card; the back door gets propped open for twenty minutes in February; someone badges in at 03:40 and nobody knows until Monday. Commercial security platforms that solve this (Verkada, Rhombus, Openpath) start in the thousands of dollars per site per year and are sold to facilities managers — not to a person who also cuts hair.

Separately: **94–99% of alarm-system police dispatches are false**, an enormous, well-documented drain on both businesses and municipal budgets. The missing layer is not more detection. It is **triage**.

### The inversion

Every commercial video product treats the camera feed as **the product** and gives you a wall of tiles to stare at.

Counter treats the camera feed as **an input to an agent**, and treats the screen as a place where at most three things are ever shown — because a busy shop can act on three things and not thirty. It is a *decision* surface, not a *monitoring* surface.

And it runs on the two cheapest devices in the building.

### What it actually does — three scenes

**Scene A — The counter.**
Ring `motion_detected` with `sub_type: "human"` at the indoor camera pointed at the till, with no staff-side motion for 40 seconds. The back-room TV shows one card:

> **`Someone's been at the counter for 47 seconds.`** *(live WHEP frame)*
> `▶ Live` · `🔔 Play "be right with you"`

That second button calls `POST /v1/devices/{chime_id}/media/audio/playback` and a real Ring Chime by the till says *"Someone will be right with you."* **A real capability of the real API that essentially nobody is using**, doing something genuinely useful.

**Scene B — The door that shouldn't be open.**
Rear door camera: continuous motion, door-open state, 4 minutes, outside temperature 2°C (real NWS data for the shop's real coordinates via `GET /v1/devices/{id}/location`). Agent escalates from *note* → *card* → *chime* on a real policy ladder. The screen shows the reason, not just the alert:

> **`Rear door has been open 4 minutes. It's 2°C outside. Last person through: 14:07.`**

**Scene C — The owner, at home, on a Sunday.**
*"Alexa, did the Sysco delivery come yesterday?"* The Alexa+ add-on hits Counter's MCP server, which queries real Ring event history (`GET /v1/history/devices/{id}/events`) and answers:

> *"Yes — a delivery at the rear door at 6:42am Saturday, and someone brought it in four minutes later. Want to see the clip?"*

An MCP Apps card renders the timeline with the real snapshot.

### Architecture

**On-device (Fire TV)**
- Kiosk-mode TV app. On **Fire OS** you additionally get **ADM push** to wake the display and a foreground service for true always-on — this is the one idea where Fire OS is arguably the better primary target, with a Vega build shipped alongside to claim the newer platform.
- `@amazon-devices/kepler-ui-components`, strict focus order; designed to be read from **4 metres away by someone holding a box**: three cards maximum, 48pt headlines, colour-blind-safe status.
- `@amazon-devices/headless-task-manager` (Vega) / foreground service (Fire OS) holds the event socket.
- Zero credentials on device; the TV authenticates to your backend with a device-bound token issued by a one-time 6-digit pairing code.

**Cloud (AWS)**
- **API Gateway + Lambda** terminates Ring webhooks (HMAC verify, `request_id` idempotency, **200 in under 5s**), publishes to **EventBridge**.
- **Strands Agents SDK** on **Bedrock AgentCore Runtime**: a *Triage* agent (is this worth a human's attention *right now*?), a *Context* agent (business hours, staffing, weather, POS state), an *Escalation* agent (the notify/chime/SMS ladder), and a *Recall* agent (answers the owner's questions).
- **Bedrock (Nova vision)** over real Ring snapshots for "delivery van" vs "customer" vs "person loitering" — the single highest-value classification a small business needs.
- **AgentCore Memory** for per-site norms ("Tuesdays are dead between 2 and 4; a person at the counter then is unusual"). **DynamoDB**, **Timestream**, **AgentCore Identity** for Ring tokens.
- **Alexa+ MCP add-on**, Streamable HTTP, tools: `whats_happening_now`, `did_x_arrive`, `who_was_here_between`, `set_quiet_hours`, `play_counter_prompt`.

### Amazon & AWS surface

| Capability | Exact API / package | Role |
|---|---|---|
| Real events | Ring webhooks `motion_detected(sub_type)`, `button_press`, `device_online/offline` | Every trigger |
| Live look | Ring `POST /media/streaming/whep/sessions` | `▶ Live` |
| What is it | Ring `POST /media/image/download` + Bedrock Nova vision | Delivery vs customer vs loiterer |
| **Speak on site** | Ring `POST /media/audio/playback` (Chime) | "Be right with you" |
| History / recall | Ring `GET /v1/history/devices/{id}/events` | Scene C |
| Site location | Ring `GET /v1/devices/{id}/location` | Real weather correlation |
| Multi-camera sites | `?component_id=N` | Ring Elite support |
| TV surface | Vega `kepler-ui-components` + `headless-task-manager`; Fire OS ADM + foreground service | Always-on ops screen |
| Voice recall | Alexa+ MCP add-on + MCP Apps | Owner from home |
| Agents | Strands + AgentCore Runtime / Memory / Identity | Triage graph |

### Real data — no simulation anywhere

| Source | What's real | Access |
|---|---|---|
| Ring cameras at a real premises | Real motion/human/button events, snapshots, live streams, history | Ring Partner API (free account) |
| **NWS `api.weather.gov`** | Real weather at the shop's real coordinates | Free, no key, official US Government |
| **Square API** *(optional)* | Real transactions, real open/close, real staff clock-ins | Free developer account, real production data |
| **Google Places / OSM opening hours** *(optional)* | Real business hours | Public |
| The premises itself | Your own shop, a friend's shop, or your own front door as the stand-in | — |

> If you don't have a willing business, **use your own home's front door and garage as a stand-in site for the build**, then film the demo at a real small business — a single afternoon with a cooperative café owner makes the video enormously more credible.

### Why it scores

- **Tech Implementation** — Uses more of the *breadth* of the Ring Partner API than any other idea here, including the audio-playback endpoint almost nobody touches, plus correct webhook discipline (HMAC, idempotency, 5s budget) that judges from the Ring team will immediately recognise as competent.
- **Design** — "Three cards, 48pt, readable while holding a box" is a real design constraint honestly met. The escalation ladder is the design.
- **Potential Impact** — The strongest pure-commerce case in this document: a real, enormous, underserved market; a price point ten times below incumbents; and a distribution path through **both** the Fire TV Appstore and the Ring Appstore.
- **Quality of the Idea** — "Non-security uses of Ring" and "business systems" are both explicitly named in the judges' creativity guidance for the Ring track.

### Novelty check

| What exists | Why Counter is different |
|---|---|
| Ring Business / Ring for Business | Alerts and clips on a phone; no on-site decision surface, no agent |
| Verkada / Rhombus / Openpath | $$$$, facilities-manager product, not for a barbershop |
| Retail people-counting (RetailNext, Density) | Analytics for a head office; nothing actionable on the floor today |
| Generic NVR wall displays | A wall of tiles nobody looks at |

### Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Employee-monitoring perception | **High** | Explicit stance: Counter watches **the door and the counter**, never staff. No dwell-time-per-employee, no productivity metrics, ever. Say it on screen. |
| Always-on TV app lifecycle on Vega | Medium | Ship Fire OS as the primary kiosk build (foreground service + ADM) and Vega as the second target; document the gap as a feature request. |
| Ring 5s webhook budget | Low | Verify + enqueue only. |
| Jurisdictional recording law (audio, notice signage) | Medium | No audio recording anywhere in the product; Chime *playback* only. Ship a printable notice template. |

### Open Source mini-challenge play

Ship **`ring-webhook-kit`** (MIT): a correct, well-tested Ring Partner API webhook receiver — HMAC-SHA256 verification, `request_id` idempotency store, sub-5-second ack with async fan-out, typed event models, and adapters for Lambda/Express/FastAPI. **This is the piece every Ring developer has to write and get subtly wrong.** Then PR a webhook example into `AmazonAppDev/ring-api-helloworld`.

### Friction-log goldmine (+10%)

(1) No two-way audio endpoint despite hardware support — **critical** feature request; (2) no siren/light control endpoints; (3) no webhook replay/ dead-letter for missed deliveries; (4) no documented `sub_type` taxonomy beyond `"human"`; (5) no Ring sandbox that emits synthetic events on demand for CI; (6) Vega kiosk/always-on lifecycle gap.

### Path to real customers

$29/site/month, self-serve, no installer, no contract — sold against a $3,000/yr incumbent. Fire TV Appstore + Ring Appstore. Multi-site tier for franchisees. This is a business you could actually be operating by Q1 2027.

### 3-minute shot list

| Time | Shot |
|---|---|
| 0:00–0:15 | Real shop, real empty counter, real customer waiting, real staff member in the back — the loss, on camera |
| 0:15–0:45 | Real Ring event → real card on the real back-room TV → real Chime speaking |
| 0:45–1:15 | The propped door + real weather context; the escalation ladder |
| 1:15–1:45 | Real Alexa+ recall from a real Echo, MCP Apps timeline |
| 1:45–2:20 | Architecture + the webhook discipline (HMAC, idempotency, 5s) shown in code |
| 2:20–2:45 | Price comparison against incumbents; the "we never watch staff" stance |
| 2:45–3:00 | Repo, licence |

### Kill criteria

None material. This is the safest build in the document — if another idea stalls, this is the fallback that still finishes.

---

## IDEA 5 — **GROUNDTRUTH**
### *When the sirens start, the biggest screen in the house becomes the household's emergency operations centre.*

> **One-line pitch:** Groundtruth fuses authoritative real-time hazard data — NWS polygon alerts, NASA satellite fire detections, USGS seismic feeds, AirNow air quality — with live views from the household's own Ring cameras, and turns the television into an address-specific, agent-driven decision surface that answers the only two questions that matter: *what is happening at my house right now,* and *what do I do next, in what order.*

| | |
|---|---|
| **Primary track** | Fire TV (Vega OS) |
| **Also qualifies** | Ring track ✅ |
| **Mini challenges** | AWS Builder ✅ · Open Source ✅ |
| **Priority categories hit** | Multi-modal UX ✅ · Family ✅ · Computer vision ✅ |
| **Primary audience** | Households in wildfire, hurricane, flood, tornado and earthquake exposure — tens of millions of US homes in the wildland-urban interface and coastal hurricane zones |
| **Secondary audience** | Households with members who cannot evacuate unassisted; HOAs and neighbourhood groups; rural volunteer fire districts |
| **Difficulty** | Medium |
| **Demo risk** | Low-medium (real alerts are always firing *somewhere* — you can demo against a genuinely live NWS polygon) |
| **Strategic ceiling** | Very high on Potential Impact and Quality of Idea; slightly off the named Fire TV priority list |

### The problem

During an emergency, every information source a household has is **wrong-scaled**. Broadcast TV is county-level. Phone alerts are a truncated sentence. News is regional and hours behind. Social media is unverifiable. Meanwhile the household is trying to make *address-specific* decisions — do we go now, which road, do we have the dog, is the gas off — with county-level information and five people talking over each other.

And they are doing it by squinting at a phone, one person at a time, while the largest, most shared, most visible screen in the house sits dark.

### The inversion

Emergency information products optimise **broadcast reach** — get one message to a million people.

Groundtruth optimises **household specificity and shared attention** — get the *right* picture of *this address* onto the one screen everyone in the house can see at once, and turn it into an ordered checklist that a frightened family can actually execute.

And it adds something no public alerting system has: **ground truth from your own cameras.** The NWS polygon says your area is under a warning. Your Ring driveway camera shows whether there is smoke on your street *right now*. Putting those two things side by side on a television is both obvious in hindsight and, as far as I can find, entirely unbuilt.

### What it actually does — three scenes

**Scene A — The wake-up.**
A real NWS alert intersects the household's real coordinates. Groundtruth takes the TV (or surfaces the moment the TV comes on) with a single, calm, unmissable screen:

> **`RED FLAG WARNING — until 20:00`**
> Map: the real NWS polygon, your house pinned, the real NASA FIRMS satellite hotspots from the last 12 hours.
> Right panel: **your front camera, live.**
> `What should we do?` · `Show me the street` · `Not now`

**Scene B — The plan, not the panic.**
The agent produces an **ordered, household-specific action list** — generated from the real hazard type, the real distance and bearing of the threat, real wind direction from NWS, and the household profile (a 92-year-old upstairs, two cats, one car, insulin in the fridge):

> 1. *Move the car to face the street now* — `done`
> 2. *Grandma's go-bag: meds, glasses, hearing aids* — `done`
> 3. *Cats in carriers before you're in a hurry* — `done`
> 4. *Route: Ridge Rd is inside the warning polygon. Take Alder → Route 9 east.*

Every item is completable with one press or one word. The agent re-plans when the polygon moves. It tracks what's done so a family that splits up doesn't duplicate or drop steps.

**Scene C — The look outside without going outside.**
`Show me the street` opens a real live WHEP stream from the outdoor Ring camera onto the full TV, with a Bedrock-Nova-generated plain description running underneath — *"Visibility down the driveway looks reduced; there is haze but no visible flame in frame"* — for the family member who is upstairs, or blind, or on the phone with a neighbour.

Afterwards, Groundtruth assembles a real timeline — when the warning arrived, what the cameras saw, what the household did and when — which is genuinely useful for an insurance claim.

### Architecture

**On-device (Vega OS):** `headless-task-manager` service polls/subscribes for alerts and can bring the app forward when the TV is on; `react-native-svg` renders polygons and the map; `kepler-ui-components` for the checklist; `react-native-w3cmedia` / WHEP client for live camera; `keplerscript-netmgr-lib` to detect connectivity degradation and switch to a pre-cached low-bandwidth plan; full voice + D-pad parity.

**Cloud (AWS):** EventBridge Scheduler polls `api.weather.gov` alerts for the household's real point; Lambda does polygon-point intersection (Turf.js / Shapely); **Amazon Location Service** for geocoding, the map, and evacuation routing that *avoids the warning polygon*; **Strands Agents SDK** on **AgentCore Runtime** with a *Hazard* agent, a *Household* agent (profile + capabilities), a *Planner* agent (ordered actions), and a *Verifier* agent (reads the camera); **Bedrock Nova** vision over real Ring snapshots; **AgentCore Memory** for the household profile; **DynamoDB** for plan state; **Polly** for the spoken plan; **S3** for the offline plan bundle and the incident timeline.

### Real data — all authoritative, all free, all real

| Source | What's real | Access |
|---|---|---|
| **NWS `api.weather.gov`** | Real alerts with real geometry, real wind, real forecasts | Free, no key, official |
| **NASA FIRMS** | Real satellite active-fire detections (VIIRS/MODIS), near-real-time | Free API key |
| **USGS Earthquake feed** | Real quakes, magnitude, depth, location | Free, public GeoJSON |
| **AirNow / OpenAQ** | Real air quality and PM2.5 | Free API key |
| **USGS Water Services** | Real river gauge levels for flood risk | Free, public |
| **Ring cameras** | Real live views and snapshots at the real address | Ring Partner API |
| **Amazon Location Service / OpenStreetMap** | Real roads and real routing | AWS |

There is nothing to simulate. During any given week of October there will be live NWS warnings you can demo against honestly.

### Why it scores

- **Tech Implementation** — Real geospatial work (polygon intersection, polygon-avoiding routing), a real multi-source fusion pipeline, correct offline/degradation handling, and a genuinely hard multi-agent planning problem.
- **Design** — Calm, large, ordered, completable. Designed for a person whose hands are shaking. Voice and D-pad parity throughout. This is a serious design brief and it shows.
- **Potential Impact** — Unimpeachable. Real hazard, real scale, real lives, real free data, and a product Amazon could plausibly ship as a Fire TV feature tomorrow.
- **Quality of the Idea** — Pairing authoritative hazard geometry with the household's own camera is a genuinely original synthesis, and it is only possible in Amazon's ecosystem.

### Novelty check

| What exists | Why Groundtruth is different |
|---|---|
| Watch Duty, IPAWS/WEA, NWS app | Phone-first, area-level, information-only — no plan, no camera, no shared screen |
| Ring Neighbors | Community reports, not authoritative hazard data, no TV surface |
| Smart-home "emergency modes" | Turn on lights. Not a decision surface. |
| Broadcast TV emergency crawls | County-level, non-interactive, no personalisation |

### Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| **Giving safety advice** | **Critical** | Never invent guidance. The Planner agent may **only** compose from official sources — Ready.gov, CDC, NWS, local emergency management — retrieved via a Bedrock Knowledge Base, with the source shown on screen next to each step. State this in the video. |
| Power/internet loss is exactly when you need it | High | Pre-cache the plan and the checklist; detect degradation via `keplerscript-netmgr-lib`; degrade to a text-only cached mode. Demo this. |
| Waking a TV from a background event on Vega | High | Same mitigation and same feature request as Idea 1. Demo the "TV is already on" path. |
| Alarmism / false positives | Medium | Severity ladder tied to the NWS alert's own severity/certainty/urgency fields, not to your own judgement. |

### Open Source mini-challenge play

**`nws-polygon-watch`** (MIT): a correct, tested library for point-in-polygon alert subscription against `api.weather.gov` — handling the CAP geometry quirks, alert dedup/update/cancel semantics, and the `@id` lifecycle that everyone gets wrong. Plus **`firms-client`**. Both are genuinely missing and genuinely reusable.

### Friction-log goldmine (+10%)

(1) No way for a Vega app to surface a critical-priority notification or take the screen — **critical**; (2) no Fire TV "emergency" app category or elevated permission tier; (3) Ring WHEP session setup latency is too slow for an emergency path — quantify it; (4) no Ring API for "is the camera currently obstructed/dark"; (5) Alexa+ MCP US-only limits international disaster use.

### Path to real customers

Free tier (alerts + camera + plan), $4.99/mo family tier (multi-address, elder profiles, incident timeline export). Real institutional buyers: insurers (documented mitigation lowers loss ratios), utilities during Public Safety Power Shutoffs, and county emergency management offices. Fire TV Appstore.

---

## IDEA 6 — **THRESHOLD**
### *The television as the household's sensory bridge — eyes for the ears, ears for the eyes.*

> **One-line pitch:** Threshold does two things no TV has ever done: it makes the front door **visible** to a Deaf or hard-of-hearing household through unmissable, AI-described Ring cards on the screen they're already watching, and it generates **real-time audio description** for video that has none, mixed into the natural gaps in the dialogue — turning the single most-used device in the home into an accessibility device.

| | |
|---|---|
| **Primary track** | Fire TV (Vega OS) |
| **Also qualifies** | Ring track ✅ (priority category: **accessibility** ✅) |
| **Mini challenges** | AWS Builder ✅ · Open Source ✅ |
| **Priority categories hit** | **AI-enhanced viewing ✅ · Multi-modal UX ✅ · Computer vision ✅** |
| **Primary audience** | ~48M Americans with hearing loss; ~12M with blindness or low vision; and the very large number of households containing one of each |
| **Secondary audience** | Older adults with age-related sensory loss who don't identify as disabled; anyone watching with the sound off |
| **Difficulty** | Medium-high (the audio-description half is real ML work) |
| **Demo risk** | Low — both halves are visually and audibly obvious in seconds |
| **Strategic ceiling** | High. Accessibility wins are strongly favoured by corporate judging panels, and both halves are genuinely novel. |

### The problem

**Half one — the door is silent.** For a Deaf or hard-of-hearing household, a doorbell is a lightbulb flasher, at best, in one room. Ring's phone notification is useless if the phone is charging in the kitchen. Meanwhile the person is sitting in front of a 65-inch screen that could have told them, instantly, *who* is there and *why* — but doesn't.

**Half two — the picture is silent.** Audio description (a narrator describing the visual action in dialogue gaps) is the single most important accessibility feature for blind and low-vision viewers. It exists for a small, inconsistently-labelled fraction of streaming catalogues, and for **essentially zero** of the video people actually care most about: home videos, personal libraries, community and local content, archival film, and the long tail.

### The inversion

Accessibility on TV is treated as **metadata you either have or don't** — a track that a distributor did or didn't commission.

Threshold treats accessibility as **something generated at playback time, on demand, for anything.** And it treats the TV not as the thing being made accessible, but as **the accessibility device for the whole home.**

### What it actually does — three scenes

**Scene A — Eyes for the ears.**
Ring `button_press` fires. Within ~3 seconds, the TV shows an unmissable but non-destructive card — persistent (it does not auto-dismiss after 4 seconds like a phone toast), positioned in the safe area, with a live thumbnail and a genuinely useful sentence generated by Bedrock Nova vision over the real snapshot:

> **`FRONT DOOR`**
> *A delivery driver in a brown uniform is at the door holding a large box.*
> `▶ Live` · `🔔 "Leave it"` *(plays a pre-recorded message from the Ring Chime)* · `✕`

The description is the point. "Motion detected" is useless. *"Someone is at the door holding a clipboard, looking away"* is information.

**Scene B — Ears for the eyes.**
Playing a real video with no audio-description track, Threshold:
1. samples frames at scene boundaries (shot-change detection),
2. runs **Bedrock Nova vision** over them to produce short, description-style prose (following the real conventions of the art: present tense, no interpretation, no spoilers, essential-visual-information-only),
3. finds the **real dialogue gaps** by running VAD over the actual decoded audio,
4. fits the description to the gap length, synthesises it with **Amazon Polly** in a deliberately distinct voice, and
5. ducks the programme audio with `@amazon-devices/keplerscript-audio-lib` and mixes it in.

The result is a real, listenable audio-described version of a video that never had one — generated live.

**Scene C — The household that contains both.**
A Deaf parent and a blind grandparent watch together. Threshold runs **both** simultaneously: descriptions spoken for one, enhanced captions and door cards rendered for the other, with a single settings surface that is itself fully navigable by D-pad **and** fully spoken. Per-profile, not per-device.

### Architecture

**On-device (Vega OS):** `react-native-w3cmedia` playback (you own the pipeline, which is why you can sample frames and audio); `keplerscript-audio-lib` for ducking and mixing the description track; `headless-task-manager` for the Ring event socket and for pre-generating descriptions for the next title overnight; `kepler-ui-components` with a hard accessibility spec (safe-area-aware persistent cards, ≥7:1 contrast, no motion, no auto-dismiss); `kepler-media-controls` so the whole thing is voice-drivable.

**Cloud (AWS):** **Bedrock Nova / Claude** vision for description generation; **Amazon Transcribe** for dialogue-gap detection and speaker labelling; **Amazon Polly (generative)** for the description voice; **Amazon Rekognition** optionally for shot-boundary and face-consistency; **MediaConvert / Elastic Transcoder** or a Fargate FFmpeg task for offline pre-generation of a description sidecar (WebVTT-style, timed) so common titles are instant; **Strands Agents** on **AgentCore Runtime** for the *Describer* / *Timing* / *Door* agent graph; **AgentCore Memory** for per-profile preferences (verbosity, voice, character-name learning); **DynamoDB** + **S3** for sidecars.

**The pre-generation sidecar is the smart engineering move:** generate once, cache forever, ship a real, reusable, open **timed-description sidecar format**.

### Real data — no simulation anywhere

| Source | What's real | Access |
|---|---|---|
| **Ring Video Doorbell** | Real presses, real snapshots, real live streams | Ring Partner API |
| **Internet Archive** | An enormous real catalogue of genuinely public-domain film with no audio description | `archive.org` API, free |
| **NASA+ / NASA imagery** | Real, public-domain, visually rich video | Free |
| **Blender Foundation open movies** | Real CC-BY films (*Big Buck Bunny*, *Sintel*, *Tears of Steel*) | Free |
| **The household's own video** | Real home videos — the use case with the deepest emotional payload and zero existing description | Local / Plex / Jellyfin |
| **Described and Captioned Media Program** | Real professionally-described reference material to **evaluate your output against** | Free, public |

> That last row is your killer credibility move: **quantitatively compare your generated descriptions against professional human descriptions** on real matched content and publish the comparison in the README. Almost nobody in a hackathon evaluates their own output.

### Why it scores

- **Tech Implementation** — Real media-pipeline work (frame sampling, shot detection, VAD, gap-fitting, audio ducking and mixing through the platform's own audio library) plus a genuine multi-model AWS pipeline. Not a wrapper.
- **Design** — This is a *design-led* project. Persistent non-destructive cards, per-profile simultaneous modalities, a settings surface that is itself accessible. Judges assessing "complete, coherent product experience" will find one.
- **Potential Impact** — Tens of millions of people, an unimpeachable need, a legal tailwind (accessibility mandates in the US and EU), and a feature Fire TV would plausibly want to own platform-wide.
- **Quality of the Idea** — Generating accessibility rather than shipping it, and using the TV as the home's sensory bridge, are both genuinely creative reads.

### Novelty check

| What exists | Why Threshold is different |
|---|---|
| Audio description tracks on some streaming titles | Pre-authored, sparse, absent from everything personal or long-tail |
| Ring flashers / smart-bulb doorbell alerts | Binary signal, no identity, no context, no description |
| Live captioning (Live Caption, etc.) | Solves audio→text. Threshold solves **video→audio**, the much harder and much rarer direction |
| Be My Eyes / Seeing AI | Phone-based, situational, not a TV playback experience |

### Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Description quality / hallucination | **High** | Constrain the model hard: present tense, no inference about emotion or motive, no naming unknown characters, fixed word budget per gap. Refuse to describe when confidence is low — silence beats a wrong description. Evaluate against DCMP references and publish the numbers. |
| Latency for live generation | High | Pre-generate sidecars overnight via `headless-task-manager`; live generation is the fallback path, not the default. Demo the pre-generated path. |
| Content rights | Medium | Public-domain and CC content + the user's own library only. Never re-host. |
| Consulting real users | Medium — but it's an *opportunity* | Get **one real Deaf or blind person** to use it and appear in the demo for ten seconds. That single clip will outscore two minutes of architecture. |

### Open Source mini-challenge play

Ship the **Timed Audio Description sidecar spec + reference implementation** (`taad`, MIT): a small open format for machine-generated timed descriptions, with a generator, a validator, and a Vega/React Native player component that mixes it. Publish it, then PR the player component into `AmazonAppDev/vega-video-sample`. A new interoperable format is exactly the "new integration pattern" the rules praise.

### Friction-log goldmine (+10%)

(1) No documented Vega API for mixing a secondary audio track with programme audio at a controlled duck ratio; (2) no access to decoded frames from `react-native-w3cmedia` for analysis — **critical** feature request; (3) no platform-level accessibility-preference API on Vega (screen-reader state, contrast preference); (4) Ring notifications have no accessibility-priority tier; (5) no Vega text-to-speech API forcing a cloud round-trip for every utterance.

### Path to real customers

Free core (accessibility should not be paywalled — say so), $4.99/mo for pre-generated sidecars on large libraries and multi-profile households. Institutional: libraries, universities, and public broadcasters have real accessibility budgets and real legal obligations.

---

## IDEA 7 — **CADENCE**
### *Your television, tuned to exactly one notch above your current level of a language — forever.*

> **One-line pitch:** Cadence models the words you actually know, then turns real video into a continuously self-calibrating comprehensible-input session: pre-teaching the five words a scene needs, glossing only what you don't know, listening to you shadow the line back, and generating spaced-repetition review from the exact moments you stumbled — on the one screen where immersion is pleasurable instead of a chore.

| | |
|---|---|
| **Primary track** | Fire TV (Vega OS) |
| **Mini challenges** | AWS Builder ✅ · Open Source ✅ |
| **Priority categories hit** | **AI-enhanced viewing ✅ · Multi-modal UX ✅ · Family entertainment ✅** |
| **Primary audience** | Adult language learners past the beginner stage (the "intermediate plateau" — where every app abandons you), and heritage-language families trying to keep a second language alive in their children |
| **Secondary audience** | Immigrants acquiring the host-country language; expat families; schools |
| **Difficulty** | Medium |
| **Demo risk** | Low |
| **Strategic ceiling** | Medium-high. Beautiful product, huge market, but more replicable on other platforms than Ideas 1–6. |

### The problem

Roughly **1.5 billion people** are learning English, and hundreds of millions more are learning something else. The two available modes both fail in the middle:

- **Apps (Duolingo et al.)** are excellent at getting you to A2 and then plateau hard. They optimise streaks, not acquisition, and their content is synthetic.
- **Raw native media** is the thing that actually works — Krashen's comprehensible input hypothesis is one of the better-supported ideas in second-language acquisition — but unassisted native video at the intermediate stage is *incomprehensible* input. You understand 60%, you stop, you look something up, you lose the thread, you quit.

And **nothing** does this on a television, which is where people actually, voluntarily, spend hours watching content in a foreign language.

### The inversion

Language apps ask: *what lesson should this learner do next?*

Cadence asks: **what is the largest amount of real, enjoyable, native content this specific learner can understand right now — and how do I keep nudging that ceiling upward without them noticing?**

It never generates a lesson. It **modulates real content**. The learner thinks they're watching television.

### What it actually does — three scenes

**Scene A — Pre-teach, then play.**
Before a scene, Cadence shows five words — chosen because they appear in the next 90 seconds *and* fall just outside the learner's modelled known-word set. Five seconds, large type, with the actual line they'll appear in. Then it plays.

**Scene B — Smart subtitles, not dual subtitles.**
The subtitle track (real, from the content) renders with **only the unknown words glossed inline** — everything the learner already knows is left clean, because glossing known words is what makes dual subtitles into a crutch. Press `↓` on any line to pause, see the sentence broken down, hear it slowed, and — the good bit — **say it back**. Amazon Transcribe scores the attempt against the real line and the agent gives one specific correction, not a score.

**Scene C — Review that comes from your own life.**
The next session opens with spaced repetition generated entirely from **real clips you actually stumbled on** — the line, the scene, the character's face. Not a flashcard. The moment. This is dramatically stickier than any app deck because the retrieval cue is episodic.

Over weeks the agent raises the difficulty target: it watches your real pause rate, your real shadowing accuracy, and your real review performance, and moves you up the CEFR ladder by selecting harder content — which it can do because it knows the real lexical difficulty of every title in its catalogue.

### Architecture

**On-device (Vega OS):** `react-native-w3cmedia` (you own playback, so you own the subtitle timing and the audio); `kepler-ui-components` for the 10-foot subtitle and gloss rendering with a real focus model; `headless-task-manager` to pre-analyse tonight's episode overnight (this is what makes it feel instant); `kepler-content-personalization` so "continue your Spanish" appears in the platform's own rows; `kepler-media-controls` for voice.

**Cloud (AWS):** **Amazon Transcribe** for shadowing assessment and for generating transcripts where subtitles don't exist; **Amazon Polly (neural)** for slowed, correctly-stressed model pronunciation; **Amazon Comprehend** for lemmatisation and entity handling; **Amazon Translate** for gloss generation with a human-quality fallback to **Bedrock**; **Bedrock (Nova/Claude)** for the explanation agent ("why is it *subjunctive* here?"); **Strands Agents** on **AgentCore Runtime** for the *Difficulty* / *Gloss* / *Coach* / *Scheduler* agent graph; **AgentCore Memory** holds the learner's known-word model — the single most valuable asset in the product; **DynamoDB** + **S3 Vectors** for the lexical index.

### Real data — no simulation anywhere

| Source | What's real | Access |
|---|---|---|
| **Internet Archive** | Real foreign-language public-domain film with real subtitle tracks | Free API |
| **Blender open movies** | Real CC-BY films with real multi-language subtitles | Free |
| **The learner's own library** | Real Plex/Jellyfin content they actually want to watch | Local |
| **FAST channels** | Real live foreign-language linear channels | Public feeds |
| **`wordfreq` corpora** | Real frequency distributions across dozens of languages | Open source |
| **Wiktionary / Tatoeba** | Real definitions and real example sentences | CC-licensed |
| **CEFR-J / English Vocabulary Profile** | Real published CEFR word lists | Public research data |
| **The learner** | Real pauses, real shadowing recordings, real review performance | Your own use, from day one |

> Build your own real known-word model from your own real usage over the four weeks you're building. The demo should show **your** real curve.

### Why it scores

- **Tech Implementation** — Real NLP pipeline (lemmatisation, frequency modelling, CEFR mapping, gap-fitting), real speech assessment, and a genuine use of `headless-task-manager` for overnight pre-analysis that makes the UX possible.
- **Design** — The "gloss only what's unknown" decision is a real pedagogical design insight expressed as an interface. Every interaction is D-pad-native. Nothing requires text entry.
- **Potential Impact** — Enormous market, clear willingness to pay (the language-learning market is multi-billion), and a genuinely underserved segment (the intermediate plateau).
- **Quality of the Idea** — Grounded in real SLA research rather than gamification instinct; the episodic-cue review mechanism is a genuinely good idea.

### Novelty check

| What exists | Why Cadence is different |
|---|---|
| Language Reactor / Trancy (browser extensions) | Desktop browser + Netflix/YouTube only. No TV, no known-word model, no shadowing, no difficulty ladder. |
| Duolingo / Babbel | Synthetic content, streak-optimised, plateaus at A2/B1 |
| Lingopie | Dual subtitles on a fixed catalogue; no learner model, no adaptation |
| Any TV language app | Effectively doesn't exist |

### Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Catalogue rights | **High** | Public-domain + CC + the user's own library only. Never re-host. Say it clearly. |
| Microphone for shadowing on Vega | **High** | **Vega has no mic API.** Options: (a) shadowing via the Alexa+ add-on on an Echo in the room — an elegant, genuinely multi-device answer; (b) a Fire OS build using the Android mic; (c) ship without shadowing and keep the other four mechanics. Decide in week 1. File as a critical feature request. |
| Subtitle quality varies | Medium | Fall back to Transcribe-generated transcripts; flag confidence in the UI. |
| Learner-model cold start | Low | Seed from a 60-second CEFR placement built from real frequency bands. |

### Open Source mini-challenge play

**`cefr-lexicon`** (MIT): a merged, normalised, multi-language mapping from lemma → frequency band → CEFR level, assembled from open sources, with a clean API and a per-title "lexical difficulty" scorer. There is no good open version of this and every language-learning developer needs one.

### Friction-log goldmine (+10%)

(1) No microphone API on Vega — **critical**; (2) no access to the active subtitle cue from `react-native-w3cmedia` at render time; (3) no per-title language metadata in the Vega content model; (4) headless task scheduling granularity insufficient for overnight batch work; (5) no on-device TTS.

### Path to real customers

$9.99/mo. Family tier for heritage-language households. Institutional sales to language schools. Fire TV Appstore, and an obvious cross-sell for anyone who already owns an Echo.

---

## IDEA 8 — **LANTERN**
### *The screen stops being the fight. It becomes the thing that ends the fight gracefully.*

> **One-line pitch:** Lantern turns the television — the single biggest daily flashpoint in a house with an autistic or ADHD child — into the evidence-based visual-schedule and transition-support tool their therapist has been asking the family to use, grounded in real arrival events from Ring so the schedule reflects what is actually happening rather than what the clock says.

| | |
|---|---|
| **Primary track** | Fire TV (Vega OS) |
| **Also qualifies** | Ring track ✅ (priority: **caretaking, accessibility** ✅) · Bee track ✅ (optional) |
| **Mini challenges** | AWS Builder ✅ · Open Source ✅ |
| **Priority categories hit** | **Family entertainment ✅ · Multi-modal UX ✅** |
| **Primary audience** | Families of autistic and ADHD children aged roughly 3–12 — CDC's 2025 ADDM estimate is **1 in 31** US 8-year-olds identified with autism, plus a much larger ADHD population |
| **Secondary audience** | BCBAs, occupational therapists, special-education classrooms, respite carers |
| **Difficulty** | Medium |
| **Demo risk** | Medium (filming a real child requires care and consent — consider filming the *parent's* experience and the screen, not the child) |
| **Strategic ceiling** | High on Impact and Idea quality; genuinely under-served |

### The problem

Ask any parent of an autistic child what the hardest ten minutes of the day are and a large fraction will say **the transition off the screen**. It is the most-cited daily flashpoint in the clinical literature and in every parent forum.

The evidence-based interventions are well established and boring: **visual schedules**, **first/then boards**, **advance transition warnings**, **priming**, and **predictable, consistent routine**. They work. They also live on laminated PECS cards on the fridge and in phone apps the child never sees — which is to say, they live **everywhere except inside the thing the child is actually looking at**.

And they are all clock-based, while the real day is event-based: the therapist is running late, the bus is early, Dad's car just pulled in.

### The inversion

Every parental-controls product treats the screen as **the adversary** — something to time, limit, lock and cut off. Every cut-off is experienced by the child as an arbitrary act of aggression by a machine, and by the parent as a fight.

Lantern treats the screen as **the ally and the narrator of the transition**. It does not cut off. It *tells the truth, early, in the child's own visual language, using the child's own content as the unit of time.* And it tracks what actually worked so the family and the clinical team can stop guessing.

### What it actually does — three scenes

**Scene A — Time is measured in songs, not minutes.**
"Ten minutes" is meaningless to a five-year-old. Lantern's countdown is **content-native**, because it owns the player and knows the real structure of what's playing:

> **`Two more songs, then shoes.`** *(with the two upcoming thumbnails, and a filling progress ring)*

Then, at the real boundary between segments — never mid-song — the first/then board:

> **`FIRST` shoes → `THEN` park** *(with the child's own photos)*

Transition sounds and timings are per-child and consistent, because consistency is the whole intervention.

**Scene B — The schedule knows what's actually happening.**
Ring `motion_detected` at the driveway at 15:42: the OT's car. Lantern updates the on-screen visual schedule **before the doorbell rings**, giving a real advance warning that a clock could not:

> **`Miss Dana is here in a minute.`** *(her photo)* — **`FIRST` hello → `THEN` table**

Grounding a visual schedule in **real arrival events** rather than planned times is, as far as I can tell, entirely new — and it directly addresses the number-one cause of transition failure: surprise.

**Scene C — The data the clinical team has never had.**
Every transition is logged with its real antecedent, the real strategy used, and the real outcome. Over weeks, the agent finds real patterns:

> *"Transitions after 45+ minutes of screen time go badly about three times as often. The two-song warning works better than the five-minute warning. Tuesdays after OT are consistently harder."*

That is a real **ABC (antecedent–behaviour–consequence) dataset** generated passively, exportable to the child's BCBA or OT — who currently rely on parents remembering to fill in a paper form. If the parent wears a **Bee**, the agent additionally grounds this in what was actually said, which is a qualitatively better record than any checkbox.

### Architecture

**On-device (Vega OS):** `react-native-w3cmedia` (owning playback is what makes content-native countdowns possible); `kepler-content-personalization` for real watch-duration signal; `headless-task-manager` for the Ring socket and the nightly pattern pass; `kepler-ui-components` + `react-native-reanimated` for slow, predictable, non-startling motion; `keplerscript-audio-lib` for consistent, gentle transition sounds; `kepler-media-controls`.

**Cloud (AWS):** **Strands Agents** on **AgentCore Runtime** — a *Schedule* agent, a *Transition* agent (chooses the strategy for this child, this moment), a *Pattern* agent (nightly analysis), a *Clinician* agent (writes the report); **AgentCore Memory** for the per-child model; **Bedrock (Nova/Claude)** for the pattern narrative and for generating age-appropriate transition language in the child's own vocabulary; **Bedrock Knowledge Base** grounded in real published ASD transition-support literature so recommendations are cited, not invented; **Polly** for a consistent voice; **DynamoDB** + **Timestream**; **AgentCore Identity** for Ring tokens.

**Optional Bee:** the local proxy's `/v1/stream` SSE and `/v1/facts` add real spoken context to the log.

### Real data — no simulation anywhere

| Source | What's real | Access |
|---|---|---|
| **Ring cameras** | Real arrivals, real departures, real bus/therapist/parent events | Ring Partner API |
| **The TV** | Real watch durations, real content structure, real segment boundaries | Vega Content Personalization + your own player |
| **The family** | Real transitions, real outcomes, real photos of real people and places | The household |
| **Bee** *(optional)* | Real spoken context around each transition | Bee CLI / proxy / Skill |
| **Published ASD transition research** | Real, citable intervention evidence | Open-access literature → Bedrock Knowledge Base |

### Why it scores

- **Tech Implementation** — Content-native countdowns require genuinely owning the media pipeline; event-grounded scheduling requires correct Ring webhook work; the pattern engine is real longitudinal analysis, not a chart.
- **Design** — This is the most *disciplined* design brief in the document: predictable, low-arousal, no bright red, no sudden motion, no time pressure, per-child consistency. Getting it right is visible; getting it wrong is visible.
- **Potential Impact** — Millions of families, an intensely motivated buyer, and a real clinical wedge (BCBAs and OTs will actively recommend a tool that generates their data for them).
- **Quality of the Idea** — Reframing the screen from adversary to ally, and grounding a visual schedule in real arrival events, are both genuinely novel.

### Novelty check

| What exists | Why Lantern is different |
|---|---|
| Choiceworks, First Then Visual Schedule, Brili | Phone/tablet apps. Not inside the thing the child is watching. Clock-based. |
| Amazon Kids+ / parental controls | Timers and cut-offs — the thing that causes the meltdown |
| PECS cards | Paper. Static. Not event-aware. |
| Any TV product for neurodivergent families | Effectively doesn't exist |

### Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Clinical overreach | **High** | Lantern is a *support tool*, never a treatment or an assessment. All recommendations cite published sources via the Knowledge Base. No behaviour "scores." No diagnostic language. |
| Filming a real child | **High** | Film the parent's perspective, the screen, and the parent's testimony. Do not put a child's face in a public demo video. |
| Getting the design tone wrong | Medium | Consult a real OT or BCBA for 30 minutes. Put their name in the credits with permission. This is cheap and enormously credible. |
| Every child is different | Medium — and it's the product | Per-child configurability is the feature, not a caveat. |

### Open Source mini-challenge play

**`vega-calm-ui`** (MIT): a low-arousal 10-foot component set — predictable transitions, no-flash animation curves, configurable motion reduction, high-contrast-without-harshness palettes — with an ESLint rule set for `@amazon-devices/eslint-plugin-kepler` that flags startle-inducing patterns. Genuinely reusable, genuinely absent.

### Friction-log goldmine (+10%)

(1) No Vega API to reduce/disable system-level animations for sensory-sensitive users; (2) no content-structure metadata (chapter/segment boundaries) exposed by the platform; (3) no per-profile settings API on Vega for multi-child households; (4) Amazon Kids profiles are not accessible to third-party apps — **important** feature request; (5) Ring `sub_type` taxonomy too coarse to distinguish "a car arrived" from "a person walked past."

### Path to real customers

$14.99/mo consumer, with a clinician portal tier sold to ABA and OT practices. Real reimbursement adjacency in the US (many families have funded ABA hours). Fire TV Appstore, plus word-of-mouth in parent communities, which for this audience is the most powerful distribution channel that exists.

---

## IDEA 9 — **KEYFRAME**
### *The Fire TV Stick already in eight million short-term rentals becomes the property's front desk, concierge, and honest witness.*

> **One-line pitch:** Keyframe turns the streaming stick every short-term rental already has into an agentic front desk — greeting the guest by name at the exact moment Ring sees them arrive, answering the questions that generate 80% of host messages, and wiping every streaming credential at checkout, verified against a real departure event.

| | |
|---|---|
| **Primary track** | Fire TV (Fire OS primary — device-management realities favour it — with a Vega build) |
| **Also qualifies** | Ring track ✅ (priority: **access control, business systems** ✅) |
| **Mini challenges** | AWS Builder ✅ · Open Source ✅ |
| **Priority categories hit** | Family entertainment ✅ · Multi-modal UX ✅ |
| **Primary audience** | The ~8 million active Airbnb/Vrbo listings and the hosts and property managers who run them |
| **Secondary audience** | Boutique hotels, serviced apartments, corporate housing, student accommodation |
| **Difficulty** | Medium |
| **Demo risk** | Low (you can run a real property, or your own spare room, as a real test site) |
| **Strategic ceiling** | High commercially; Amazon already has a "Fire TV for Business"/hospitality motion this slots directly into |

### The problem

Three real, expensive, universal pains, all of which converge on a device that is already in the room:

1. **Arrival is the worst moment of the stay.** The guest arrives at 11pm in the rain, with a lockbox code in an email they can't find, in a house whose wifi password is on a card in a drawer. Hosts field the same six questions thousands of times.
2. **Credential leakage.** The previous guest logged into Netflix, Prime Video and Disney+ on the stick. Those sessions are still there. This is a real, known, unsolved, actively-exploited problem, and it is a genuine security incident for the guest.
3. **Disputes are decided by whoever has evidence.** Damage claims, party complaints, and unauthorised-occupancy disputes are resolved by whoever can show what actually happened at the door.

### The inversion

Hospitality tech has spent a decade trying to get guests to install **an app**. Guests do not install apps for a three-night stay. Adoption of host apps is famously abysmal.

Keyframe uses the **one screen every guest voluntarily turns on within ten minutes of arriving**, and requires the guest to install, download, scan and sign up for precisely nothing.

And it inverts the surveillance instinct: **no indoor cameras, ever.** Keyframe uses only the outdoor door event — arrival, departure, occupancy sanity — which is both legally cleaner (indoor cameras in STRs are banned by Airbnb policy and by law in many jurisdictions) and the only posture a guest would tolerate.

### What it actually does — three scenes

**Scene A — The arrival that just works.**
Ring `motion_detected` (`sub_type: human`) at the front door at 23:04, matched against the real reservation window from the property-management system. The TV — already on the Keyframe home screen — changes before the guest has put the bags down:

> **`Welcome, Amara.`**
> **`Wi-Fi: Cottage-Guest / harbour-lights-19`** *(large, and a QR code)*
> `The heating's on. Bins go out Tuesday. Tap for anything else.`

No app, no login, no scanning, no email archaeology.

**Scene B — The concierge that actually knows this house.**
A **Bedrock Knowledge Base built from the real house manual** — the actual document the host already wrote — answers the real questions, by voice or D-pad: *"How does the shower work?" "Where's the nearest pharmacy that's open?" "What's the checkout time?"* Local recommendations come from the **host's real curated list**, not a generic API, which is exactly what guests want and hosts are proud of. Escalation to the host is one press, with full context attached.

**Scene C — The clean checkout.**
At the real departure event (Ring door event + reservation end), Keyframe:
- runs a friendly on-screen checkout checklist,
- **wipes every streaming credential and viewing history on the device,** and shows the guest that it did — which is a genuine privacy service *to the guest*, not just hygiene for the host,
- and writes a factual arrival/departure timeline the host can rely on if a dispute ever arises.

### Architecture

**On-device (Fire TV):** Fire OS is the pragmatic primary here — device management, kiosk/lockdown behaviour, ADM push and account-wipe tooling are more mature. Ship a Vega build alongside to claim the new platform. Provisioning is a one-time 6-digit pairing code shown on screen — a host with forty properties must not be doing anything harder than that.

**Cloud (AWS):** **API Gateway + Lambda** for Ring webhooks (HMAC, idempotency, sub-5s ack); **EventBridge** for reservation lifecycle; **Bedrock Knowledge Bases** over the real house manual (the single highest-value AWS use here); **Strands Agents** on **AgentCore Runtime** for a *Concierge* agent, an *Arrival* agent, and a *Turnover* agent; **AgentCore Memory** per-property (so the agent gets better as the host corrects it); **Bedrock Nova** for the guest-facing conversation; **Polly**; **DynamoDB**; **AgentCore Identity** for Ring and PMS tokens; **Alexa+ MCP add-on** so the host can ask their own Echo *"has anyone arrived at the Harbour Cottage?"*

### Real data — no simulation anywhere

| Source | What's real | Access |
|---|---|---|
| **Ring Video Doorbell at a real property** | Real arrivals, real departures, real event history | Ring Partner API |
| **Hostaway / Guesty / Lodgify / Beds24 APIs** | Real reservations, real guest names, real check-in/out windows | Real developer accounts; several have genuine free/sandbox tiers |
| **The real house manual** | The actual document a real host wrote | → Bedrock Knowledge Base |
| **Host's real local recommendations** | A real curated list | The host |
| **NWS `api.weather.gov`** | Real local weather for the arrival card | Free |
| **OpenStreetMap / Overpass** | Real nearby amenities with real opening hours | Free |

> If you don't host, **run your own spare room as the test property for four weeks** — real doorbell, real reservations via a sandbox PMS account, real manual. Or partner with one real host for one real stay; a 20-second clip of a real guest arriving is worth more than any mock.

### Why it scores

- **Tech Implementation** — Real multi-tenant device fleet architecture, real PMS integration, correct Ring webhook discipline, and a knowledge-base-grounded agent that has to be *right* about a real house.
- **Design** — Zero-install, zero-login, works in the dark, works for a tired guest with luggage in both hands. That is a real constraint honestly met.
- **Potential Impact** — 8M listings; hosts pay for tools that reduce messages and disputes; Amazon has an existing hospitality motion this extends. Strong, credible, boring-in-a-good-way commerce.
- **Quality of the Idea** — The credential-wipe feature alone is a genuine "why doesn't this exist" moment, and the strict no-indoor-camera posture shows real understanding of the domain.

### Novelty check

| What exists | Why Keyframe is different |
|---|---|
| Hostaway / Guesty guest portals | Web links in emails nobody opens |
| Hotel in-room TV systems (Enseo, SONIFI) | $$$$, hotel-scale, not for a two-property host |
| Airbnb's own guidebooks | Static web pages; not on the TV; not event-triggered |
| Smart locks (August, Igloohome) | Solve the door, not the stay |
| Fire TV "hospitality mode" | Exists as device config; has no agent, no Ring, no PMS, no concierge |

### Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Credential wipe requires device-management privileges | **High** | Verify feasibility on Fire OS in week 1. Fallback: guide the guest through a one-tap sign-out flow at checkout and *verify* it, which still delivers the guest-privacy benefit. |
| Guest privacy perception | High | Hard stance, on screen: no indoor cameras, no listening, no tracking. Only the outdoor door event. |
| PMS API access | Medium | Several PMS providers have genuine self-serve developer tiers; pick one and go deep rather than shallow across four. |
| Multi-tenant secrets | Medium | AgentCore Identity + per-property scoping; the device holds a device-bound token only. |

### Open Source mini-challenge play

**`firetv-kiosk-provision`** (MIT): a clean, reusable pairing-and-provisioning flow for fleets of Fire TV devices — 6-digit code, device-bound token exchange, remote config, health heartbeat — with both a Fire OS and a Vega implementation. Every developer deploying Fire TV at scale rebuilds this badly.

### Friction-log goldmine (+10%)

(1) No first-class Vega/Fire OS API for third-party app provisioning at fleet scale; (2) no documented programmatic way to clear third-party app sessions on device — **critical**; (3) no hospitality/kiosk profile on Vega; (4) Ring has no "occupancy" or "expected arrival" concept in the API; (5) no Appstore distribution channel for privately-distributed fleet apps.

### Path to real customers

$9/property/month. Sells itself on two numbers a host can feel: messages received per stay, and disputes lost for lack of evidence. Distribution through PMS marketplaces (Hostaway and Guesty both have app stores) is a faster path than the Fire TV Appstore, and you can do both.

---

## IDEA 10 — **FIRSTWEEK**
### *The first seven days after hospital discharge, run from the television instead of from a folder of paper nobody can read.*

> **One-line pitch:** Firstweek pulls a patient's **real** discharge instructions and medication list through the legally-mandated FHIR patient-access APIs that every major US hospital and payer now exposes, and turns them into a day-by-day, voice-and-remote-driven recovery plan on the television — with real medication data, real red-flag symptom checks, and real verification that the home-health visit actually happened.

| | |
|---|---|
| **Primary track** | Fire TV (Vega OS) |
| **Also qualifies** | Ring track ✅ (caretaking) · Alexa+ ✅ |
| **Mini challenges** | AWS Builder ✅ · Open Source ✅ |
| **Priority categories hit** | Multi-modal UX ✅ · Family ✅ |
| **Primary audience** | The ~35 million annual US hospital discharges, concentrated heavily in the 65+ cohort — precisely the Fire TV demographic |
| **Secondary audience** | The family member who becomes an untrained nurse overnight; home-health agencies; ACOs and Medicare Advantage plans, who are financially penalised for readmissions |
| **Difficulty** | High (healthcare data + compliance) |
| **Demo risk** | Medium — but the sandboxes are genuinely excellent |
| **Strategic ceiling** | Very high on Impact; highest regulatory complexity of the ten |

### The problem

Roughly **one in five Medicare patients is readmitted within 30 days**, at a cost of tens of billions of dollars annually, and the dominant proximate cause is not clinical failure — it is **failure to execute the discharge plan**. Which is unsurprising, because the discharge plan is:

- eight pages of 8-point type,
- handed to a person who is sedated, in pain, and being wheeled toward a car,
- listing twelve medications, four of them new, two of them replacing something they already take,
- with red-flag symptoms buried on page six,
- and no mechanism whatsoever to confirm any of it was understood, let alone done.

The family member who becomes the de-facto nurse gets the same folder and no training.

### The inversion

Every discharge-management product is built for **the health system** — a care-manager dashboard, an outbound call queue, a portal the patient never logs into. Portal engagement in this population is dismal.

Firstweek is built for **the patient's living room**, on the device they were already going to be sitting in front of for the next seven days anyway, and it requires them to log into nothing and learn nothing.

The technical unlock is the genuinely interesting part: because of the **21st Century Cures Act** and CMS interoperability rules, **every major US EHR and payer is legally required to expose patient-accessible FHIR R4 APIs** with SMART-on-FHIR authorisation. A patient can authorise a third-party app to read their own real discharge summary, medication list, problems and encounters. This is real, available, and almost nobody has built a *television* client for it.

### What it actually does — three scenes

**Scene A — The plan, from the real record.**
The patient (or their family) authorises Firstweek once via SMART-on-FHIR. It pulls the real `DocumentReference` (discharge summary), `MedicationRequest`, `Condition`, `CarePlan` and `Encounter` resources, and renders **day one**:

> **`Tuesday — day 2 after surgery`**
> `☐ 8am  Apixaban 5mg — with food`
> `☐ 8am  Change the dressing` `▶ 40-second video`
> `☐ Walk to the end of the hall and back, twice`
> `☐ 2pm  Nurse Pauline visits`

Every item is one press or one word. Nothing requires a phone.

**Scene B — The medication reality check.**
Firstweek enriches the real medication list with **real** public drug data: **RxNorm** for normalisation (this is how you catch that the new prescription and an existing bottle are the same drug under different names — a leading cause of post-discharge harm), **openFDA** for real label warnings and adverse-event context, **DailyMed** for the real pill images so the patient can visually confirm what's in their hand, and **RxNav's interaction data** for real interaction flags. Anything flagged is routed to a human — never resolved by the agent:

> **`Worth a call.`** *Your new blood thinner and the ibuprofen you already take shouldn't usually be combined.*
> `📞 Call the pharmacy` · `📤 Send this to Dr. Okafor`

**Scene C — The red flag, and the witness.**
Each day the agent asks two or three plain-language questions drawn from the **real** discharge summary's own warning signs (*"Is the incision area more red than yesterday?"*), by voice or D-pad. An answer that crosses a documented threshold produces one clear instruction and one button: call the clinic, or call 911. It never diagnoses.

Separately, Ring's real door events verify whether the home-health nurse **actually arrived** — a real, chronic, expensive gap in post-acute care that agencies are legally required to document and currently do with self-reported timesheets.

### Architecture

**On-device (Vega OS):** `headless-task-manager` for medication timing and overnight sync; `kepler-ui-components` for the large-type checklist; `react-native-w3cmedia` for the real wound-care and exercise videos; `kepler-media-controls` + full voice parity; `security-manager-lib` for token custody; strict accessibility spec (32pt+, ≥7:1, no time limits).

**Cloud (AWS):** **SMART-on-FHIR** client with **AgentCore Identity** holding the OAuth tokens; **Amazon HealthLake** (purpose-built FHIR datastore) or DynamoDB for the record; **Amazon Comprehend Medical** to extract medications, dosages, frequencies, conditions and warning signs from the real unstructured discharge narrative — this is the single best-fit AWS service in this entire document; **Bedrock (Claude/Nova)** for plain-language rewriting at a genuine 6th-grade reading level; **Bedrock Knowledge Base** over real patient-education sources (MedlinePlus, CDC) so nothing is invented; **Strands Agents** on **AgentCore Runtime** — a *Plan* agent, a *Medication* agent, a *Triage* agent (escalate, never diagnose), a *Family* agent; **Polly**; **Alexa+ MCP add-on** so the patient can say *"Alexa, did I take my morning pills?"* from bed.

### Real data — no simulation anywhere

| Source | What's real | Access |
|---|---|---|
| **Epic on FHIR / Cerner (Oracle Health) sandboxes** | Real FHIR R4 APIs with realistic patient records; production access available to registered apps | Free developer programmes |
| **SMART Health IT sandbox** | Real, spec-compliant FHIR server | Free, open |
| **CMS Blue Button 2.0** | **Real Medicare claims data** for real consenting beneficiaries | Free developer programme |
| **RxNorm / RxNav (NLM)** | Real drug normalisation and real interaction data | Free, official |
| **openFDA** | Real labels, real adverse-event data | Free, official |
| **DailyMed (NLM)** | Real labels and real pill images | Free, official |
| **MedlinePlus Connect** | Real patient-education content | Free, official |
| **Ring** | Real home-health visit arrival events | Ring Partner API |

> **Your own real record is the strongest demo.** Under the Cures Act you have a right to your own data via these APIs. Using your own real (or a consenting family member's real) discharge record makes the "no simulated data" claim absolute — and you can redact on screen.

### Why it scores

- **Tech Implementation** — SMART-on-FHIR + HealthLake + Comprehend Medical + RxNorm reconciliation is serious, correct, domain-appropriate engineering that very few hackathon entrants will attempt, let alone get right.
- **Design** — A 10-foot, voice-and-remote, zero-typing interface for a person in pain, designed with real accessibility constraints.
- **Potential Impact** — Readmissions are one of the most-measured, most-penalised, most-funded problems in US healthcare. The buyer (ACOs, Medicare Advantage plans, hospitals under the HRRP penalty) is real, identified, and already spending.
- **Quality of the Idea** — "The TV is the post-discharge care surface" is a genuinely original and immediately convincing framing, and using the Cures Act APIs as the data unlock shows real ecosystem understanding.

### Novelty check

| What exists | Why Firstweek is different |
|---|---|
| Epic MyChart / patient portals | Web/phone; abysmal engagement in the 70+ post-discharge cohort |
| Medication reminder apps | Phone-based; no real record; no reconciliation; no red flags |
| Care-management call programmes | Expensive human labour, once or twice a week, by phone |
| Hospital discharge paperwork | Paper |
| Any TV-based health product | Effectively doesn't exist |

### Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| **Clinical safety** | **Critical** | Firstweek **never** diagnoses, never adjusts a dose, never overrides a clinician. It renders the existing plan, flags, and escalates to a human. Every flag cites its source. Put this on screen in the demo, in writing. |
| HIPAA / PHI handling | **Critical** | Patient-authorised access under the patient's own right of access; encrypt everywhere; AWS BAA-eligible services only (HealthLake, Comprehend Medical, Bedrock all qualify); no PHI in logs; document the model in the README. |
| FHIR production access takes time | High | **Build against the sandboxes** (Epic, Cerner, SMART) plus your own real record, and say so plainly. Judges will respect the honesty and the rigour. |
| Scope | High | Days 1–7 only. One condition family (post-surgical is cleanest). Resist expanding. |

### Open Source mini-challenge play

**`fhir-discharge-kit`** (Apache-2.0): a library that takes a FHIR R4 `Encounter` + `DocumentReference` + `MedicationRequest` bundle and emits a normalised, RxNorm-reconciled, plain-language day-by-day recovery plan — with a full test suite against the public SMART sandbox. This is a genuinely useful piece of open health infrastructure that does not currently exist in a clean form.

### Friction-log goldmine (+10%)

(1) No Vega secure-element or hardware-backed keystore documented for health-grade token custody — **critical**; (2) no Vega API for reliable timed local notifications (medication timing) without the app foregrounded; (3) no Vega accessibility-preference API; (4) Alexa+ MCP add-on has no documented PHI/BAA posture — **critical** question for the Alexa+ team; (5) no Fire TV "health" app category or review pathway.

### Path to real customers

B2B2C is the only sane route: hospitals under HRRP penalties, ACOs, and Medicare Advantage plans pay per-discharge for a measurable reduction in 30-day readmissions. Home-health agencies pay separately for the visit-verification signal. Consumer free tier for reach.

---

# PART II — CHOOSING

## 3. Scoring all ten against the actual rubric

The four Stage-Two criteria are **equally weighted**, and ties break in the order they are listed: Tech Implementation → Design → Potential Impact → Quality of the Idea. Scores below are my honest estimate of ceiling, 1–10, assuming excellent execution.

| # | Project | Tech Impl. | Design | Impact | Idea | **Total** | Build risk | Demo risk |
|---|---|---|---|---|---|---|---|---|
| **1** | **HEARTH** — TV as the care surface | 9 | **10** | **10** | **10** | **39** | **High** | Med-high |
| **2** | **STEADY** — Ring-as-camera rehab coach | **10** | 9 | 9 | **10** | **38** | Med-high | **Low** |
| **5** | **GROUNDTRUTH** — household emergency console | 9 | 9 | **10** | 9 | **37** | Medium | Low-med |
| **6** | **THRESHOLD** — sensory bridge | 9 | **10** | 9 | 9 | **37** | Med-high | **Low** |
| **3** | **LEVERAGE** — spoiler-safe sports router | 9 | 9 | 8 | 9 | **35** | Medium | Medium |
| **8** | **LANTERN** — neurodivergent transitions | 7 | **10** | 9 | 9 | **35** | Medium | Medium |
| **10** | **FIRSTWEEK** — post-discharge companion | 9 | 8 | **10** | 8 | **35** | **High** | Medium |
| **4** | **COUNTER** — $30 back-of-house manager | 8 | 8 | **10** | 8 | **34** | **Low** | **Low** |
| **7** | **CADENCE** — comprehensible input engine | 8 | 9 | 8 | 8 | **33** | Medium | **Low** |
| **9** | **KEYFRAME** — STR front desk | 7 | 8 | 9 | 7 | **31** | Medium | **Low** |

*Sorted by ceiling. Sorted by expected value, the order changes — see below.*

### How to read that table

Raw ceiling says **HEARTH (39)**, then **STEADY (38)**. But ceiling is not expected value. Multiply by probability of reaching it inside the window with a genuinely finished, filmable product, and the ordering changes:

| Project | Ceiling | P(reaching it) | **Expected** |
|---|---|---|---|
| **STEADY** | 38 | **0.85** | **32.3** |
| **HEARTH** | 39 | 0.65 | 25.4 |
| **GROUNDTRUTH** | 37 | 0.80 | 29.6 |
| **THRESHOLD** | 37 | 0.75 | 27.8 |
| **LEVERAGE** | 35 | 0.75 | 26.3 |
| **COUNTER** | 34 | **0.95** | **32.3** |

**STEADY and COUNTER are the highest expected-value entries.** STEADY has the far higher ceiling of the two, and its risk is concentrated in exactly one question that can be answered in a single afternoon.

---

## 4. My recommendation

### Primary: **IDEA 2 — STEADY**

Pick Steady. The reasoning, in order of how much it matters:

1. **It hits two of the six named Fire TV priority categories head-on** — *fitness* and *computer vision* — which is the cheapest possible way to clear Stage One with room to spare.
2. **It converts the platform's biggest limitation into the product's central idea.** "Fire TV has no camera, so we used the Ring already in the room" is a sentence that makes an Amazon device judge sit up. It demonstrates ecosystem understanding more convincingly than any amount of architecture narration — which is literally what the Quality-of-the-Idea criterion asks for.
3. **It is impossible on Roku, Google TV or Apple TV.** None of them own a camera in your living room with a partner API. That is the whole thesis of this document, executed in one architectural decision.
4. **It produces a number.** The 30-Second Chair Stand score, compared against real published CDC norms, is a hard, clinically legible output. Projects that produce numbers beat projects that produce vibes.
5. **The demo is the best of the ten.** A real person, a real living room, a real skeleton overlay tracking them on a real television, a real rep counter, a real audible correction. That is 40 seconds of video that needs no explanation, which matters enormously when judges are not required to watch past 3:00.
6. **The single biggest risk is answerable on day one.** Pull the Ring RTSP stream. Measure the latency. If it's good, build the live version. If it isn't, build the clip-based version, which loses almost nothing. No other idea here de-risks that cleanly.

### The upgrade, if week 1 goes well: **STEADY + one Hearth scene**

If by the end of week 1 you have live pose landmarks on the TV with acceptable latency, add **exactly one** thing from Hearth — the **Alexa+ MCP add-on** that lets a distant adult child ask *"Alexa, has Dad been doing his exercises?"* and get a real answer with the real chair-stand trend.

That single addition:
- adds a genuine cross-device story (Fire TV + Ring + Alexa+) for maybe three days of work,
- turns a fitness app into a **care** product, which roughly triples the Potential Impact story,
- demonstrates MCP 2025-11-25 over Streamable HTTP, which is a track requirement elsewhere and pure bonus here,
- and costs one extra 15-second scene in the video.

**Do not add more than that.** The fastest way to lose this hackathon is to build four half-finished tracks instead of one finished one.

### If you want maximum ceiling and accept the risk: **IDEA 1 — HEARTH**

Hearth is the better *product* and the better *story*, and it is the only idea here that legitimately spans all four device tracks. If your instinct pulls you there, take it — but impose three rules on yourself on day one:

1. **Three scenes. Written down. Frozen.** Door, Day, Family. Anything else is v2.
2. **Build Scene C (Alexa+ MCP) first**, because it is the one that proves the whole system works end to end, and it is the one that will slip.
3. **Resolve the overlay question in week 1.** If a Vega headless service cannot surface a card over playing content, redefine Scene A as "the card is waiting when the TV comes on" *immediately* and move on. Do not spend three weeks fighting the platform — spend twenty minutes writing an excellent friction-log entry about it instead, which is worth actual points.

### The safety net: **IDEA 4 — COUNTER**

If you get three weeks in and something structural has gone wrong, Counter is finishable in ten days by one experienced engineer and still scores ~34. Keep it in your pocket.

---

## 5. Track and mini-challenge strategy

### Enter Fire TV. Only Fire TV.

Several ideas above qualify for two, three or four tracks. **A project can win only one track prize.** Fire TV 1st is $25,000 + $15,000 in credits — the largest prize available. Entering additional tracks splits nothing in your favour and dilutes the Stage-One "reasonably fits the theme" read. Name Fire TV, build for Fire TV, and let the Ring/Alexa+/Bee integrations be *evidence of ambition* inside the Fire TV submission rather than separate entries.

> **Rules check:** for the Fire TV track the demo video **must** show the project running on an actual Fire TV device or the Fire TV/Vega simulator. Film that first. Everything else is negotiable; that shot is not.

### Take both mini-challenges. They are nearly free.

**AWS Builder ($5,000):** every idea above already specifies a multi-service AWS architecture. The criterion explicitly calls a single Bedrock call "obvious" and a "multi-service pipeline (Bedrock + AgentCore + Strands)" creative — so use **Strands Agents on AgentCore Runtime with AgentCore Memory and Identity**, and describe it properly in the Product Feedback answer, which is where this mini-challenge is actually judged. Note also that **building with Kiro Crew qualifies on its own**.

**Open Source ($5,000):** each idea above names a specific, genuinely reusable library to extract. The rules explicitly call a README fix "obvious" and "a new integration pattern (e.g., adding Vega support to a popular React Native library)" creative. Ship the library **and** open a PR against an `AmazonAppDev` repository. PRs don't need to be merged. Supply the contribution URL, repo URL, GitHub username, and the what/how/why description.

### Farm the +10% friction bonus. Almost nobody will.

This is the most mispriced scoring opportunity in the entire hackathon. The bonus is assessed by Amazon's internal review team during Stage One and handed to the Stage Two panel as a number applied to your final score. **Up to 10% on an equally-weighted four-criterion rubric is roughly the difference between second and first.**

Keep a `FRICTION.md` open from the first hour and append as you go. Each entry needs all six fields the rules ask for:

```
## FL-007 — Vega headless service cannot surface UI over foreground playback
Task attempted:  Display a Ring doorbell card over an active W3C media session
Steps taken:     1. Registered headless service in app manifest …
Expected:        A composited overlay, as Fire OS achieves with a foreground service
Actual:          No documented API; card only renders when the app is foreground
Severity:        Critical — blocks the core interaction of any ambient Vega app
Workaround:      Deferred card presentation until app foreground; documented in README
Suggestion:      Expose a permissioned `kepler-overlay` surface with a rate limit and
                 a user-visible permission prompt, mirroring Fire OS notification shades
```

Ten to fifteen entries of that quality, written while you actually hit the problems, is a couple of hours of work for a bonus worth more than any feature you could add in the same time. **The entries in each idea's "friction-log goldmine" section above are real gaps I verified while researching this document — they are your starting list.**

### Product feedback is a scored artefact, not a form

Every tool, API and SDK you touch needs: what you used it for, what worked, what needs work, how onboarding felt, and would-you-build-again with a reason. Write it like a staff engineer's platform review, because the people reading it build these platforms and this is explicitly the stated purpose of the hackathon. This is also where the AWS Builder mini-challenge is judged.

---

## 6. Cross-cutting requirements every idea must satisfy

Verified against the Official Rules — check each before you submit:

- [ ] **Public GitHub repo** with **an OSI licence file detectable in the About section at the top of the repo page.** Not just a LICENSE file in a subdirectory — it must show in the sidebar.
- [ ] **All source, assets and run instructions** in the repo. A judge must be able to run it.
- [ ] **Demo video under 3:00**, public, YouTube or Vimeo, in English, **showing the app running on real Fire TV hardware or the Fire TV/Vega simulator**.
- [ ] **No third-party trademarks, no copyrighted music or footage** without permission. Use original or genuinely licensed audio. This disqualifies people every year.
- [ ] **Product feedback** for every tool/API/SDK used, with the AWS description inside it.
- [ ] **Track + mini-challenges declared**, with the Open Source extra fields (contribution URL, repo URL, GitHub username, what/how/why).
- [ ] **Friction log entries** — the +10%.
- [ ] **Feature requests** with priority ratings (Critical / Important / Nice-to-have) — optional, cheap, and it's more signal to the same reviewers.
- [ ] **Third-party data terms**: every API you call, you must be authorised to use. Say so explicitly in the README.
- [ ] **Testing access**: the project must be free and unrestricted for judges until judging ends. Include credentials if anything is gated.
- [ ] **Real data, no simulation** — your own requirement. Every idea above names its real sources; start collecting your own real data the week you start building, because a four-week real trend line cannot be manufactured the night before.

---

## 7. What I would do in the first 72 hours

Regardless of which idea you pick:

| Hour | Action | Why |
|---|---|---|
| 0–2 | Register on Devpost; request the **$150 AWS credits** (form closes Oct 21, 12:00 PT, while supplies last) | Free, expires, trivially forgotten |
| 0–2 | Create the **Ring developer account** and get API access | Gating item; do it before anything else |
| 2–6 | Install the **Amazon Devices Builder Tools MCP** (`@amazon-devices/amazon-devices-buildertools-mcp`) into your coding agent, plus the Agent Skills | It's the hackathon's own recommended tool, it genuinely helps, and *using it generates friction-log entries* |
| 2–6 | `git clone AmazonAppDev/react-native-multi-tv-app-sample`; get it running on the **Vega Virtual Device** and on a real Fire TV Stick | This is your Stage-One insurance: proof it runs on the platform, on day one |
| 6–10 | **Answer the one question that kills your chosen idea.** For Steady: pull the Ring RTSP stream and measure glass-to-glass latency. For Hearth: try to render anything over active playback from a headless service. | Every idea here has exactly one such question. Answer it before you write a line of product code. |
| 10–24 | Open `FRICTION.md` and start writing. Open the repo with its licence. Take the first Fire TV screenshot. | The artefacts that win are the ones started early |
| 24–72 | Build the single scene that is the demo's money shot — the one at 0:30–1:20 of the video — and nothing else | If the money shot doesn't work, you want to know in three days, not three weeks |

---

## 8. One honest caveat

Every audience figure in this document — caregiver counts, fall incidence, autism prevalence, discharge volumes, listing counts, hearing and vision loss populations — is drawn from well-known public sources (CDC, AARP, Nielsen, SBA, CMS, Airbnb) and is directionally reliable, but **re-verify and cite each one before it goes into your Devpost description.** Judges assessing "a credible, specific case" respond well to a cited number and badly to a confident round one. The platform capabilities in Section 1, by contrast, were verified directly against live Amazon documentation and the real dependency manifests of the official sample apps on 2026-09-14, and are the load-bearing technical claims in this document.

---

*Generated 2026-09-14 · Fire TV Track, 1st Place · Build, Ship, Shape: Amazon Developer Hackathon*
