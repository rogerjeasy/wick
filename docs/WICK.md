# WICK
## Product Definition, Feature Plan and Win Strategy

**Build, Ship, Shape: Amazon Developer Hackathon — Fire TV Track, 1st Place**
*$25,000 cash · $15,000 AWS credits · A meeting with the Amazon Developer team · Featured on Amazon Developer channels*

| | |
|---|---|
| **Document version** | 1.0 |
| **Date** | 14 September 2026 |
| **Submission deadline** | Friday 23 October 2026, 12:00 PT (20:00 BST) |
| **Judging** | 9–20 November 2026 · **Winners announced** ~3 December 2026 |
| **Primary track** | Fire TV |
| **Mini challenges** | AWS Builder · Open Source |
| **Written for** | Product, business and non-technical readers. Every technical term is explained in plain English at first use and again in the glossary. No code appears anywhere in this document. |
| **Purpose** | To be the single source of truth that the technical build follows. If this document and the code disagree, this document is wrong and should be updated — not quietly ignored. |

---

# PART 0 — THE ONE PAGE

*If you read nothing else, read this.*

**Wick turns the television into the care surface for the person being cared for.**

Every product built for ageing at home is built for the *caregiver*. It is a phone app, full of alerts, that a daughter three hundred miles away checks between meetings. The person it is supposedly about — the 78-year-old in the armchair — experiences it as nothing at all, or worse, as surveillance.

Wick inverts this. It puts the intelligence **inside the home**, on the one screen an older adult already looks at for around seven hours a day, and asks them to install nothing, learn nothing, wear nothing and change nothing.

It uses four things Amazon already owns and nobody else has together:

| Amazon device | What it becomes in Wick |
|---|---|
| **Fire TV** | The surface. Where everything appears — calm, large, one button at a time. |
| **Ring** | The eyes at the door. Who is here, who came, who didn't. |
| **Bee** | The ears of the day. What was actually said, promised, worried about. |
| **Alexa+** | The far end of the line. How a distant family asks, from anywhere, "how are they doing?" |

An agent sits behind all four. It watches the door, listens to the day, learns the household's rhythm, and does two things: it tells the resident the handful of things that genuinely matter to them, **at a moment that doesn't interrupt** — and it tells the family a true, unsensational story about the week.

**Why this wins the Fire TV track:**

1. **It is impossible on Roku, Google TV or Apple TV.** None of them own the doorbell, the wearable and the assistant. This is the single strongest argument a Fire TV judge can be given.
2. **It uses the parts of Vega OS nobody else will touch** — background agents and the Fire TV home-screen personalisation surface — for exactly what they were built for.
3. **It is a genuinely new product category for the Fire TV Appstore**, with a real buyer, a real price and a real enterprise wedge.
4. **The interaction design is the idea.** Never interrupting mid-scene, one button, no red badges, no nagging. Judges assessing "a complete, coherent product experience" will find one that could not have been designed by accident.

**Why this is safe to build:** we have all four devices in hand, and a real older adult who has agreed to be the household. Every piece of data in the demo will be real.

**The one sentence for the video:** *"The average 78-year-old looks at this screen for seven hours a day. It has never once looked back."*

---

# THE NAME

> ### **Wick** *(adj., Northern English dialect)* — **alive.**

Three old words share this spelling, and the product is all three.

**1 · Alive.** In the north of England, *wick* means living. It comes from Old English *cwic* — the same root as "quick" in *the quick and the dead*. In *The Secret Garden*, Dickon kneels by a rose everyone has written off, scrapes the bark, and says: *"It's wick."* It's alive.

**2 · The thread that carries the flame.** From Old English *wēoce*. A wick is not the fire. It is the modest thing that quietly draws fuel to the light and keeps it burning.

**3 · A dwelling place.** Old English *wīc*, from Latin *vīcus*, a village — the reason Norwich, Warwick and Ipswich are called what they are.

**Why this name and not a gentler one.** Every product in this category is named for decline. They are called *Care*, *Guardian*, *Assist*, *Watch*, *Alert*. Each name quietly tells its user what they have become. Margaret is not a patient, a risk or a case. She is 78, she is in her own house, and she is **wick** — and the product is the thread that carries the light, not the one that shines it.

**Tagline:** *Still wick.*

**Say it:** *"Alexa, how's Mum been this week?"* — with Alexa+, the assistant routes to Wick from intent alone, so the name is rarely spoken aloud. That is an argument for choosing it on meaning rather than on how it performs as an invocation phrase.

---

# PART 1 — WHY WICK EXISTS

## 1.1 The problem, in human terms

Sarah lives in London. Her mother Margaret, 78, lives alone in the house Sarah grew up in, two hundred miles away.

Sarah's week contains a low, constant hum of not-knowing. Did Mum eat? Did the carer actually turn up on Tuesday? Was that phone call from the surgery important? She rings on Sunday and Margaret says "I'm fine, love," because Margaret says "I'm fine, love."

Sarah has tried to fix this three times.

She bought an indoor camera. For eleven days she watched clips of her mother's empty hallway. On day twelve she stopped opening the app, and the camera became a thing that makes Margaret feel watched without making Sarah feel informed.

She bought a pendant alarm. It is in the drawer in the kitchen, where Margaret put it, because Margaret is not going to wear a sign around her neck that says *I am old now*.

She set up a tablet. Margaret does not use the tablet.

Meanwhile, in the corner of Margaret's front room, there is a television. It is on from about four in the afternoon until about eleven at night. It is the single most reliable, most-attended, most-trusted object in her daily life, and it does exactly one thing: it plays *Midsomer Murders*.

**Wick is the product that noticed the television.**

## 1.2 The problem, in numbers

> *Every figure below should be re-verified and cited by source in the final Devpost description. Judges respond well to a cited number and badly to a confident round one.*

| Figure | Approximate scale | Source to cite |
|---|---|---|
| Unpaid family caregivers in the US | **~53 million** | AARP / NAC, *Caregiving in the U.S.* |
| Of those, caring from a distance | A very large minority — tens of millions | AARP |
| US adults 65+ living alone | **~15 million** | US Census Bureau |
| Daily television viewing, adults 65+ | **~7 hours** | Nielsen Total Audience |
| Adults 65+ who own a smartphone but rarely use apps | Majority report low app engagement | Pew Research |
| Americans living with Alzheimer's | **~7 million** | Alzheimer's Association |
| Annual cost of US long-term care | **Hundreds of billions** | CMS / Genworth |
| Average cost of a US care home place | **~$100,000+ / year** | Genworth Cost of Care |
| Adults 65+ who say they want to stay in their own home | **~75–90%** | AARP Home & Community Preferences |

The economic argument is brutal and simple: **the gap between a $100,000-a-year care home and a $15-a-month app is the entire market.** Anything that credibly delays a move into residential care by even a few months is worth vastly more than it costs.

## 1.3 Why every existing product fails

There are hundreds of products in this space. They fail in four recognisable ways.

**Failure 1 — They are built for the wrong person.**
The product is a dashboard for the caregiver. The care recipient is a data source, not a user. This is why adoption is a fight: the person whose house it is gets no benefit and all of the intrusion.

**Failure 2 — They produce alerts, not understanding.**
A camera that sends 40 motion notifications a day is not information; it is noise with a battery. Within two weeks every caregiver mutes it. The product then fails silently, which is the worst kind of failing, because everyone believes it is still working.

**Failure 3 — They require the older adult to adopt something.**
A pendant. A wristband. A tablet. An app. A voice routine. Each one is a small daily reminder of decline, and each one has an adoption rate that collapses with age. The products with the best data are the ones nobody wears.

**Failure 4 — They feel like surveillance, because they are.**
Indoor cameras streaming a person's living room to their children is, whatever its intent, surveillance. It corrodes the relationship it was bought to protect. Many older adults accept it and quietly resent it. Many refuse outright.

## 1.4 The insight that makes Wick different

Every product in this category asks:

> *How do we get data out of the home, to the caregiver?*

Wick asks:

> **How do we get intelligence into the home, onto a screen the resident already trusts, without them changing a single habit?**

That inversion produces a completely different product:

| Conventional care tech | Wick |
|---|---|
| Primary user is the distant caregiver | **Primary user is the resident** |
| Primary surface is a phone app | **Primary surface is the television** |
| Output is alerts and clips | **Output is a small number of things that matter, and a true story** |
| The resident must adopt something | **The resident adopts nothing** |
| Value to the resident: none | **Value to the resident: the door, their day, their family** |
| Indoor cameras watch the person | **No indoor camera ever leaves the house** |
| Success = the caregiver checks the app | **Success = the caregiver stops needing to** |

It also produces a different *emotional* product. Wick is not a monitoring system that the family imposes on Margaret. It is something that is useful **to Margaret** — it tells her who is at the door, it carries messages from Sarah, it remembers the thing the surgery said. The fact that it also produces a truthful weekly picture for Sarah is a consequence of it being useful to Margaret, not the other way round.

**That is the whole design.** Get that right and everything else follows.

## 1.5 Why only Amazon can build this

This is the argument that should be made explicitly, on screen, in the demo video, because it is the argument a Fire TV judge most wants to hear.

Wick needs four things simultaneously:

1. **A trusted, always-present screen in the room** — Fire TV.
2. **Eyes at the door with a real developer API** — Ring, which now exposes live video, snapshots, event webhooks and event history to third-party developers.
3. **A record of what was actually said and meant during the day** — Bee, a wearable that captures real conversation and distils it into facts and commitments.
4. **A voice endpoint the distant family already owns** — Alexa+, which now accepts self-hosted third-party integrations.

| Platform | Screen | Doorbell API | Wearable context | Assistant | Can build Wick? |
|---|---|---|---|---|---|
| **Amazon** | Fire TV | **Ring** | **Bee** | **Alexa+** | **Yes** |
| Google | Google TV | Nest (limited 3P API) | Fitbit (no conversation) | Gemini | No |
| Apple | Apple TV | None | Apple Watch (no conversation capture) | Siri | No |
| Roku | Roku | Roku Cameras (no 3P API) | None | None | No |
| Samsung | Tizen | SmartThings (partial) | Galaxy Watch | Bixby | No |

**Wick is not an app that happens to run on Fire TV. It is an argument for why Fire TV sits at the centre of the Amazon home.**

---

# PART 2 — WHO WICK IS FOR

Three named people. Use these names consistently in the README, the Devpost description, the demo video and the code. Named characters make a product legible; abstractions make it forgettable.

## 2.1 Margaret, 78 — the resident *(she/her)*

**The primary user. Not the buyer.**

Margaret lives alone in a three-bedroom house she has been in for forty-one years. She is widowed. She is cognitively intact with some short-term memory slippage — she forgets appointments, not people. She has a bad knee that she under-reports. She has a carer, Maria, who comes Tuesday and Friday mornings.

She has a smartphone. She uses it for calls and for photographs of her grandchildren. She has never voluntarily installed an app.

She watches television from around 4pm. She will answer the door to almost anyone, which worries Sarah considerably.

**What Margaret wants:** to stay in her house. To not be a burden. To not be treated as incapable. To know who is at the door before she gets up, because getting up is not free.

**What Margaret will not tolerate:** being watched. Being nagged. Being asked to learn something. Being made to feel monitored by her own children. A device that beeps at her.

**Margaret is the hardest user in consumer technology, and she is the one Wick is for.** Every design decision in this document resolves in her favour.

## 2.2 Sarah, 51 — the distant daughter *(she/her)*

**The buyer. Not the primary user.**

Sarah works full time, has two teenagers, and carries a permanent low-grade anxiety about her mother. She is the one who will find Wick, pay for it, set it up, and champion it.

**What Sarah wants:** to stop wondering. To know that Maria came. To be told, once, the thing that actually matters — not forty times the things that don't. To be able to ask, out loud, from her kitchen, "how's Mum been this week?" and get a real answer.

**What Sarah will not tolerate:** another app to check. Another source of guilt. Paying for something her mother refuses to have in the house.

**The crucial insight about Sarah:** she does not want more data. She wants **less worry**. A product that gives her more information and the same amount of worry has failed. Wick's job is to make Sarah check less often, not more.

## 2.3 Maria, 44 — the paid carer *(she/her)*

**The enterprise wedge.**

Maria works for a domiciliary care agency. She has eleven clients. She is paid by the visit and records her visits on a paper timesheet or a phone app that she fills in later from memory.

**What Maria wants:** to not be treated as a suspect. To not do double data entry. To be able to flag something she noticed without a twenty-minute phone call.

**What Maria's agency wants:** verified, defensible evidence that visits actually happened, at the times claimed. In the US this is a funded regulatory requirement (Electronic Visit Verification). In the UK it is a Care Quality Commission evidence question. Both are real budgets.

**The wedge:** Ring's event history is a cleaner, more defensible record of "someone arrived at this door at 09:04" than any self-reported timesheet. Wick can sell that to agencies without ever pointing a camera at Margaret.

## 2.4 Who Wick is explicitly *not* for

Stating this clearly is a sign of product judgement, and it protects the scope.

- **People with advanced dementia.** Wick assumes the resident can understand a card on a screen and press one button. Beyond moderate impairment, the product's assumptions break. Say so.
- **People who need clinical monitoring.** Wick is not a medical device, does not detect falls, does not measure vital signs and makes no clinical claims. The moment it pretends otherwise it becomes a regulated product and a liability.
- **People who don't watch television.** The entire product depends on the screen being on. A household where the TV is rarely used is not a Wick household.
- **Households in conflict.** Wick requires the resident's genuine consent. It is not a tool for adult children to monitor a parent who has said no. This is an ethical line and a product line; the software enforces it.

---

# PART 3 — WHAT WICK IS

## 3.1 In one paragraph

Wick is a Fire TV application and an agent behind it. The agent watches the household's Ring doorbell and outdoor camera, reads the conversational context captured by the resident's Bee wearable, and learns the household's rhythm from the television itself. It surfaces, on the television, the small number of things the resident actually needs — who is at the door, what the surgery said, a message from their daughter — and it does so at moments that do not interrupt. Separately, it answers the distant family's questions through their own Echo, in prose rather than dashboards. It never streams the inside of the house to anyone, and the resident is never asked to learn, wear or install anything.

## 3.2 The four pillars

Everything in Wick belongs to exactly one of these. If a proposed feature does not belong to one of them, it does not go in.

### Pillar 1 — **The Door** *(Ring → Fire TV)*
Who is here, and what should I do about it. The most immediately, obviously useful thing Wick does for Margaret, and the fastest to demonstrate.

### Pillar 2 — **The Day** *(Bee → agent → Fire TV)*
What happened today that you'd want to remember. The things that were said, promised, arranged or worried about, surfaced gently at a natural break — never mid-programme.

### Pillar 3 — **The Family** *(agent → Alexa+ → anywhere)*
The far end of the line. Sarah asks her own Echo how her mother is, and gets a truthful, unsensational, narrative answer. Messages go the other way, arriving on the television as a card Margaret can answer with one button.

### Pillar 4 — **The Rhythm** *(Fire TV + Ring events → agent's memory)*
The quiet, invisible pillar. Wick learns what a normal week looks like in this house — when the television comes on, when the front door opens, when the carer arrives — so that when something is genuinely different, it knows, and when nothing is different, it stays silent. **This is the pillar that makes the other three trustworthy.**

## 3.3 A day in the life

*This narrative is the demo script, the README's opening, and the product's specification, all at once. Build what is described here.*

**09:02.** Maria's car pulls into the drive. Ring sees motion at the front camera. Wick notes it silently — the television is off, and this is exactly what Tuesday looks like. Nothing is surfaced to anyone. **A product that says nothing when nothing is wrong is the hardest and most valuable thing to build.**

**09:04.** The doorbell rings. The television is off, so nothing appears. Margaret answers the door. Wick records: *carer visit, on time, Tuesday as usual.*

**11:30.** Margaret mentions to Maria, in passing, that her knee has been bad again and that the surgery rang about Thursday. Bee captures both. Wick's agent extracts two things: a **fact** worth tracking (knee pain, second mention this week) and a **commitment** that is about to be forgotten (the surgery, Thursday).

**14:15.** A courier rings the bell. Margaret is in the garden. Wick notes the event and the snapshot. Later it will be able to answer, truthfully, "a parcel came at quarter past two."

**16:40.** The television goes on. Wick's card is waiting, but it does not appear yet, because Margaret has just sat down and is choosing what to watch. **Wick waits.**

**17:22.** The episode ends. *Now* Wick speaks — one full-screen card, very large type, three lines:

> **A few things from today, Margaret.**
> • *The surgery rang about Thursday. Shall I ask Sarah to call them?*
> • *You mentioned your knee again this morning.*
> • *Sarah's sent you a message.* ▶

Margaret presses the button on her remote. Sarah's voice plays. Margaret chooses one of three replies Wick has drafted — *"Tell her I'm fine and the roses are out"* — presses OK once, and goes back to her programme. Total interaction: eleven seconds, one button, no keyboard, no phone, nothing learned.

**17:24.** Sarah's phone buzzes in London. Her mother has replied.

**19:31.** The doorbell rings. The television is on. A card slides into the lower third — it does not cover the programme, it does not pause it, it does not make a noise:

> **Someone's at the front door.** *(live still from the doorbell)*
> *A man in a delivery uniform, holding a parcel.*
> ▶ **Watch live** · 🔔 **"Just a moment"** · ✕ **Not now**

Margaret presses the middle one. Down the hall, the Ring Chime by the front door says, in a recorded voice, *"Just a moment please."* The delivery driver waits. Margaret gets up in her own time.

**Sunday, 10:00.** Sarah, in her kitchen, says: *"Alexa, how's Mum been this week?"*

> *"Steady week. She's been up around seven most mornings and out to the shops Tuesday and Friday. Maria came both her usual days, on time. One thing worth mentioning — she's talked about her knee twice this week, and that's up from once last week. And Thursday night she was up at two in the morning with the kitchen light on for about forty minutes. Would you like to see the week, or shall I put a note on her television to ask how she's feeling?"*

Sarah did not open an app. Margaret did not do anything at all.

## 3.4 What the resident has to do

**Nothing.**

This is not a simplification. It is the product's central and most defensible claim, and it should be stated exactly this baldly in the demo video.

| Thing the resident must do | Wick |
|---|---|
| Install an app | **No** |
| Create an account | **No** |
| Learn a new interface | **No** |
| Wear a device | Only the Bee, if they choose — and that is a consenting decision they make for their own benefit |
| Charge something extra | **No** (Bee excepted) |
| Remember to do something daily | **No** |
| Change how they watch television | **No** |
| Answer questions from a machine | **No** |

Setup is performed once, by Sarah, on her own phone or on the television, in about eight minutes.

---

# PART 4 — THE FEATURE CATALOGUE, RANKED

## 4.1 How features were ranked

Every candidate feature was scored on six dimensions. The ranking is not "what's coolest" — it is **what most increases the probability of winning first place while remaining a coherent product**.

| Dimension | Question asked | Weight |
|---|---|---|
| **Resident value** | Does this make Margaret's life measurably better? | ×3 — highest weight, because the product's entire thesis is that the resident is the user |
| **Buyer value** | Does this make Sarah worry less? | ×2 |
| **Judging power** | How much does this move the four scoring criteria? | ×3 |
| **Demo power** | Can a judge understand it in ten seconds of video? | ×2 |
| **Effort** | Engineering cost | ÷ |
| **Risk** | Probability it doesn't work on real hardware | ÷ |

**Tiers mean something specific and are enforced:**

- **Tier 0 — The Spine.** Remove any one of these and Wick is not Wick. Build these first, in order. If only Tier 0 ships, you still have a complete, coherent, submittable product.
- **Tier 1 — The Multipliers.** These convert "good project" into "winning project". Build only after all of Tier 0 works on real hardware.
- **Tier 2 — The Depth.** Build only if Tier 0 and Tier 1 are complete and filmed. These are what you cut first, without regret.
- **Tier 3 — The Roadmap.** Describe these in the submission. Do not build them. They demonstrate that the product has a future, which is a Potential Impact scoring input.
- **Tier 4 — Rejected.** Things a lesser version of this product would include. Saying why they are excluded is itself evidence of product judgement, and judges notice.

**The cut rule, stated once:** at any point, cut from the bottom of the highest incomplete tier. Never start a Tier 2 feature while a Tier 1 feature is unfinished. Never ship a half-finished feature — a missing feature costs nothing, a broken one costs the Design score.

---

## 4.2 TIER 0 — THE SPINE
*Six features. Without all six, there is no product. Build in this order.*

---

### **S1 · The Door Card**
> *Someone is at the door, and the television tells you who — without stopping your programme.*

**What it does.** When the Ring doorbell is pressed or the front camera sees a person, a card appears in the lower third of the television. It does not pause playback, does not cover the picture, does not make a sound. It shows a still image from the doorbell and one sentence of plain English describing what is actually there — *"A man in a delivery uniform, holding a parcel"* — not "motion detected". Three large buttons: **Watch live**, **"Just a moment"**, **Not now**.

**Why it is number one.** It is the only feature that delivers value to Margaret in the first five seconds of her using the product, with zero learning. It is instantly comprehensible to a judge. It is the clearest possible demonstration of the Fire TV + Ring pairing that is the project's whole thesis. And for an older adult with a bad knee, knowing whether the trip to the door is worth making is a genuine, daily, unromantic improvement to life.

| Serves | Pillar 1 — The Door |
|---|---|
| **Resident value** | ★★★★★ |
| **Buyer value** | ★★★☆☆ |
| **Judging power** | ★★★★★ — Tech Implementation, Design, Idea |
| **Demo power** | ★★★★★ — the first 20 seconds of the video |
| **Effort** | Medium |
| **Risk** | **High** — see Limitation L1 (surfacing a card over active playback) |
| **Depends on** | Ring event webhooks, Ring snapshot retrieval, a vision model for the description, the Fire TV app being the active application |

**The hard part is not the card. It is the description.** "Motion detected" is worthless. "A man in a delivery uniform holding a parcel" is the product. Budget real time for getting these sentences right — short, factual, present tense, never speculative about intent.

---

### **S2 · The Natural-Break Engine**
> *Wick knows when it is acceptable to speak, and waits.*

**What it does.** An invisible feature. Wick owns the video player, so it knows precisely where it is in a programme: mid-scene, at a break, at the end of an episode, or at the moment the television is switched on. Every non-urgent message Wick wants to deliver is queued and released only at a moment that does not interrupt.

**Why it is number two.** This is the feature that makes Margaret tolerate Wick for more than a week. Every competing product interrupts, and every competing product gets muted. The entire emotional difference between "a helpful presence" and "another thing nagging me" lives here. It is also the feature that a judge assessing *"is the interaction model intuitive and well-considered for the target device"* will recognise as genuine design work rather than decoration.

| Serves | All four pillars — it is the delivery mechanism for everything |
|---|---|
| **Resident value** | ★★★★★ — invisible, and the reason the product survives contact with a real person |
| **Buyer value** | ★★☆☆☆ |
| **Judging power** | ★★★★★ — this is the Design score |
| **Demo power** | ★★★☆☆ — needs to be *narrated* to be noticed, which is worth doing |
| **Effort** | Medium |
| **Risk** | Low — entirely within our own player |
| **Depends on** | Owning playback; an urgency classification for every message |

**Two classes of message, and only two:** *Now* (the door — delivered immediately, non-destructively, lower third) and *When there's a gap* (everything else — queued until a break). There is no third class. Resist inventing one.

---

### **S3 · The Day Card**
> *The three things from today you'd want to remember, at the end of an episode.*

**What it does.** Wick reads the resident's real Bee data — the conversations they actually had, the facts the device distilled, the things they said they would do — and at the next natural break presents at most **three** items in very large type. Typically: a commitment about to be forgotten (*the surgery rang about Thursday*), something the resident said about themselves that is worth noticing (*you mentioned your knee again*), and anything waiting from the family.

**Why it is number three.** This is the feature nobody else on earth can build, because nobody else has a wearable that captures real conversation and a television to put it on. It is the strongest single answer to "quality of the idea". It is also genuinely useful in a way that requires no imagination: the thing Margaret most needs is not monitoring, it is **a memory that isn't hers**.

| Serves | Pillar 2 — The Day |
|---|---|
| **Resident value** | ★★★★★ |
| **Buyer value** | ★★★☆☆ |
| **Judging power** | ★★★★★ — Idea quality, Impact |
| **Demo power** | ★★★★☆ |
| **Effort** | Medium |
| **Risk** | Medium — depends on the quality of real Bee extraction |
| **Depends on** | Bee data access, S2 (the break engine), the disclosure policy (S5) |

**Three items. Never four.** The discipline of the number is the feature. A card with seven things on it is a to-do list, and Margaret will stop reading it.

---

### **S4 · The Family Line**
> *"Alexa, how's Mum been this week?" — answered in prose, from anywhere.*

**What it does.** A self-hosted MCP server — the open standard Alexa+ itself uses — so that Sarah can ask about her mother from wherever she is and get a truthful, narrative, unsensational answer. Not a dashboard. Not a score. A paragraph, the way a thoughtful neighbour would tell you.

**Why it is number four.** It is the entire reason Sarah pays, and it is the cross-device proof that makes this more than a TV app.

**What changed, and why it does not matter much.** Alexa+'s MCP Toolkit turns out to be restricted to select partners, with no published application path and no availability outside the United States (see L9). So S4 ships in two halves:

- **S4a — the server, which is real.** A genuinely spec-compliant MCP server: spec 2025-11-25, Streamable HTTP, OAuth 2.1 with PKCE, sub-500ms round trips. Nothing gates building this, and it is the part that carries the engineering. Exercised through MCP Inspector and a small simulated Alexa+ surface, which the hackathon rules explicitly permit as an alternative path.
- **S4b — the Alexa+ registration, which is gated.** Requested; the outcome is documented either way. If access opens, **no code changes** — the server already meets every published requirement.

The demo must be honest about which half is which. Showing a simulated surface as though it were a real Echo would be worse than not showing it at all.

| Serves | Pillar 3 — The Family |
|---|---|
| **Resident value** | ★★☆☆☆ — indirect: it reduces the number of anxious phone calls |
| **Buyer value** | ★★★★★ |
| **Judging power** | ★★★★★ — Tech Implementation, Impact |
| **Demo power** | ★★★★★ |
| **Effort** | Medium |
| **Risk** | **Realised** — the Alexa+ add-on surface is partner-gated (L9). Mitigated by shipping S4a; see above. |
| **Depends on** | The agent's weekly narrative (S6), the disclosure policy (S5) |

**Build this second, not last.** It was the piece most likely to hold an unpleasant surprise — and it did. Building it early is exactly why that surprise cost a research afternoon instead of a week in October.

---

### **S5 · The Disclosure Policy**
> *A written, enforced rule about what the family is allowed to see.*

**What it does.** A component that every single outbound sentence passes through before it reaches Sarah. It holds an explicit, human-readable policy: what class of information may be shared, what must be summarised, what must never leave the house, and what Margaret has specifically asked to keep private. Health, financial and relationship content is redacted by rule, not by judgement.

**Why it is number five, and why it is Tier 0.** Because Wick reads a person's actual conversations and puts the result in front of their children. Without an enforced, inspectable policy, Wick is not a care product — it is a surveillance product with good manners. This is also the component that makes the demo's central claim ("this is not surveillance") defensible rather than rhetorical, and it is the thing that distinguishes a serious engineer from an enthusiastic one in front of a judging panel.

| Serves | All pillars — it is a gate, not a feature |
|---|---|
| **Resident value** | ★★★★★ — it is the reason Margaret says yes |
| **Buyer value** | ★★★☆☆ — it constrains Sarah, correctly |
| **Judging power** | ★★★★☆ — Design, Impact, and enormous credibility |
| **Demo power** | ★★★☆☆ — show it refusing something, on camera |
| **Effort** | Small–Medium |
| **Risk** | Low |
| **Depends on** | Nothing. Build it early; retrofitting it is painful. |

**Show it working in the video.** Ask Alexa something Margaret has marked private, and let it decline. Ten seconds. It will be one of the most memorable moments in the submission.

---

### **S6 · The Rhythm**
> *Wick learns what a normal week looks like, so it can stay silent.*

**What it does.** Quietly, continuously, Wick builds a picture of this household's ordinary pattern from data it already has: when the television goes on and off, when the front door sees activity, when the carer arrives, when the resident leaves the house and comes back. It stores no video and needs no new sensors. The output is used for exactly two things: **staying quiet when everything is normal**, and **writing a truthful weekly narrative** with real comparisons ("that's up from once last week").

**Why it is number six, and why it is not optional.** Without it, the weekly narrative is a list of events, which is worthless. With it, the narrative contains the only sentence Sarah actually wants: *"nothing unusual this week."* A care product that can credibly say nothing is wrong is more valuable than one that lists forty things that happened.

| Serves | Pillar 4 — The Rhythm |
|---|---|
| **Resident value** | ★★★★☆ — it is why Wick doesn't nag |
| **Buyer value** | ★★★★★ |
| **Judging power** | ★★★★☆ — Tech Implementation, Idea |
| **Demo power** | ★★★☆☆ — shown through the narrative, not directly |
| **Effort** | Medium |
| **Risk** | Low–Medium — needs several weeks of real data to be convincing |
| **Depends on** | Real data collection starting **immediately**, weeks before the demo |

> **Act on this today.** The rhythm baseline cannot be manufactured the night before. Start recording real events in Margaret's household in week one, even before the app looks like anything. A five-week real baseline in the demo video is worth more than any feature you could build in the same time.

---

## 4.3 TIER 1 — THE MULTIPLIERS
*Six features. These are what turn a solid project into a winning one. None of them begins until all of Tier 0 runs on real hardware.*

---

### **M1 · "Just a moment"** — *the Ring Chime speaks*
> *One button on the remote, and a voice at the front door asks the visitor to wait.*

**What it does.** The middle button on the Door Card plays a short recorded message out of the Ring Chime in the hallway: *"Just a moment please."* The visitor waits. Margaret gets up in her own time, without the pressure of someone about to walk away.

**Why it is the top multiplier.** It converts Wick from *informative* to *useful*. It is a small, humane, unmistakably thoughtful feature that solves a real indignity — the scramble to the door. It uses a capability of the Ring API that, as far as can be determined, essentially nobody has used for anything. And on video it is a genuine delight moment: a judge watches a television button make a voice come out of a hallway.

**Resident value** ★★★★★ · **Buyer value** ★★★☆☆ · **Judging** ★★★★☆ · **Demo** ★★★★★ · **Effort** Small · **Risk** Low

**Cheap, delightful, differentiating.** If you build one Tier 1 feature, build this.

---

### **M2 · Watch Live**
> *The doorbell camera, full screen, on the television, in one press.*

**What it does.** The **Watch live** button replaces the programme with the live doorbell view, full screen. Press Back and the programme resumes exactly where it was.

**Why.** It closes the loop on the Door Card — description, then verification. For a resident with any doubt about who is outside, seeing them at 55 inches is a materially different experience from squinting at a phone. It is also technically substantive: real live video from a Ring device rendered on a Fire TV.

**Resident value** ★★★★☆ · **Buyer value** ★★☆☆☆ · **Judging** ★★★★☆ · **Demo** ★★★★★ · **Effort** Medium · **Risk** Medium — stream setup latency is the thing to measure early

---

### **M3 · One-Button Reply**
> *A message from Sarah plays; Margaret answers with a single press.*

**What it does.** Sarah records or types a note. It arrives on the television at the next natural break as a card with her photograph. Margaret presses ▶ to hear it, and is offered three replies that Wick has drafted from the content of the message. One press sends one. No keyboard, no microphone required, no phone.

**Why.** It makes the family line **two-way**, which transforms Wick from a monitoring product into a *connection* product — a completely different emotional category and a much better story. It is also the moment in the demo video most likely to make someone feel something, which matters more than most technical features.

**Resident value** ★★★★★ · **Buyer value** ★★★★★ · **Judging** ★★★★☆ · **Demo** ★★★★★ · **Effort** Medium · **Risk** Low

**The drafted replies are the craft.** Three options, in Margaret's own register, never twee, never infantilising. Get a real older adult to read them and tell you if they sound like something they'd say.

---

### **M4 · Known Visitors**
> *"This looks like Maria — she usually comes Tuesdays."*

**What it does.** The family curates a small roster of expected people — the carer, the gardener, the neighbour — each with a name, a photograph and a usual pattern. When the doorbell rings, the Door Card can say who it probably is, and whether that is expected today.

**Why.** It is the difference between information and understanding. "Someone is at the door" is a fact; "this looks like Maria, and it's Tuesday" is a decision already made. It also enables the carer-verification feature below.

**Resident value** ★★★★☆ · **Buyer value** ★★★★☆ · **Judging** ★★★★☆ · **Demo** ★★★★☆ · **Effort** Medium · **Risk** Medium — accuracy and, more importantly, the privacy framing

**Handle this carefully.** Facial recognition is a loaded capability. The correct framing, and the correct implementation, is: **an explicitly opt-in roster of named people the household has themselves added, deletable at any time, never applied to strangers, never used to build a profile of anyone.** Say all of that on screen. If in doubt about the framing, ship a non-biometric version that uses the visitor's expected schedule alone — "Maria usually comes at nine on Tuesdays" is nearly as useful and carries none of the weight.

---

### **M5 · Carer Verification**
> *Maria came at 9:04 on Tuesday. Here is the evidence.*

**What it does.** Wick records, from real door events, when a scheduled visitor actually arrived and roughly how long they stayed. It surfaces this in the weekly narrative and makes it available as a simple record.

**Why.** It is the enterprise wedge in a single feature, and it costs almost nothing on top of M4. Domiciliary care agencies have a funded, regulatory need for defensible visit evidence, and currently rely on self-reported timesheets. Including it demonstrates to a judge that this product has a business model beyond a consumer subscription — which is exactly what *"could it realistically serve an audience beyond the hackathon"* is asking.

**Resident value** ★★☆☆☆ · **Buyer value** ★★★★★ · **Judging** ★★★★☆ (Impact) · **Demo** ★★★☆☆ · **Effort** Small · **Risk** Low

**Frame it as protecting the carer, not policing them.** Maria benefits from a record that proves she came; that is the honest framing and the one that survives contact with a care agency.

---

### **M6 · The Week, Shown**
> *Sarah asks, and a timeline appears in the conversation, not just words.*

**What it does.** When Sarah asks Alexa+ about the week, alongside the spoken narrative an interactive panel renders in the Alexa+ conversation view: the week as a timeline, visits marked, anything unusual highlighted, with the option to see a door snapshot.

**Why.** It uses the newest and least-exploited part of the Alexa+ integration surface — the ability for a third party to render real interactive UI inside the assistant conversation. Very few submissions will do this. It is a direct, visible, hard-to-fake Tech Implementation point.

**Resident value** ★☆☆☆☆ · **Buyer value** ★★★★☆ · **Judging** ★★★★★ · **Demo** ★★★★☆ · **Effort** Medium · **Risk** Medium — newest surface, least documented

---

## 4.4 TIER 2 — THE DEPTH
*Build only if Tier 0 and Tier 1 are complete **and already filmed**. These are the first things to cut and you should feel nothing when you cut them.*

| # | Feature | What it does | Why it's here, not higher | Effort |
|---|---|---|---|---|
| **D1** | **Something's Different** | When the rhythm genuinely deviates — no television all evening, the front door not opened all day, an unusual night-time pattern — Wick offers the family a single, calm, non-alarming note. Never an alert. Never a red badge. | High value, but it needs weeks of real baseline to avoid false positives, and a bad false positive is worse than the feature's absence. | M |
| **D2** | **What Sarah Sees** | A screen on Margaret's own television showing exactly what her family can see about her, with a one-button control to take anything off the list permanently. | Ethically the most important feature in the product, and a superb 10-second demo moment. It sits in Tier 2 only because Tier 0's policy engine already delivers the substance; this makes it *visible*. **Promote it to Tier 1 if time allows.** | S |
| **D3** | **While You Were Out** | "A parcel came at quarter past two. Nobody else called." Available on demand from the home screen. | Genuinely useful, low risk, but adds no new capability — it's a view over data S1 already collects. | S |
| **D4** | **Ask About It** | Sarah can ask specific questions — "did Maria come on Tuesday?", "when did she last go out?" — rather than only the weekly summary. | Strong, but S4 already establishes the capability; this is breadth, not depth. | M |
| **D5** | **Quiet Hours** | Household-configurable windows where nothing is surfaced at all, plus a hard rule that nothing ever appears after a set hour. | Important for real use, nearly invisible in a demo. | S |
| **D6** | **When the Internet Goes** | Graceful degradation: the app states plainly what it cannot currently do rather than silently failing, and the door card falls back to the camera image alone. | Real products need it. Hackathon judges rarely see it — which is precisely why showing it for five seconds is disproportionately impressive. | M |

---

## 4.5 TIER 3 — THE ROADMAP
*Describe these in the submission. Do not build them. Their purpose is to show that Wick is a product with a future, which is a Potential Impact scoring input.*

| Feature | The one-line case |
|---|---|
| **Two-resident households** | Most 78-year-olds live with someone. Per-person rhythm, per-person disclosure, one television. |
| **The sibling circle** | Three adult children, three different levels of involvement, three different disclosure policies — and a resident who controls all of them. |
| **Medication rhythm** | Not reminders — *rhythm*. Wick learns when tablets are normally taken and notices when the pattern breaks, without ever becoming a medical device. |
| **The care agency portal** | Verified visit records across a whole client list. The enterprise product, sold to agencies, priced per client. |
| **The neighbour** | With the resident's explicit permission, a trusted neighbour can be the first call rather than a daughter two hundred miles away. |
| **Echo Show as a second surface** | For the kitchen. Same agent, same policy, smaller screen. |
| **Hearing support** | Route Wick's voice through the television's audio accessibility settings and the resident's hearing aids. |
| **Beyond English** | The product's audience is global; the market is not. Localisation is a market-expansion feature, not a v1 feature. |

---

## 4.6 TIER 4 — EXPLICITLY REJECTED
*A weaker version of this product would contain all of these. State the exclusions in the submission — product judgement is legible, and judges read it.*

| Rejected | Why |
|---|---|
| **Streaming an indoor camera to the family** | This is the single line Wick will not cross. It is the thing that makes every competing product feel like surveillance, and refusing it is the product's moral spine. Ring is used for **the door**, and for arrival and departure **events**, never for watching the resident. |
| **Fall detection** | Unreliable without dedicated sensors, clinically consequential when wrong, and a direct route to being a regulated medical device. Wick makes no clinical claims. Say so on screen. |
| **A chatbot on the television** | Margaret is not going to have a conversation with her television, and pretending otherwise is the most common failure of AI products aimed at older adults. Wick speaks in cards, and listens with one button. |
| **A "wellness score"** | Reducing a human being to a number out of ten is dehumanising, statistically indefensible, and exactly what every competitor does. Wick writes sentences. |
| **Streaks, badges, gamification** | No. |
| **Location tracking of the resident** | Wick knows the front door opened. It does not need to know, and will not ask, where Margaret went. |
| **An always-on microphone in the room** | Bee is a consenting, resident-owned device that the resident chooses to wear. An ambient room microphone is a different thing entirely, and Wick does not have one. |
| **Notifications to the resident's phone** | The entire product exists because that channel does not work for this user. |
| **Mood or sentiment detection** | Inferring a person's emotional state from their conversations and reporting it to their children is a profound overreach dressed as care. Wick reports what was *said*, filtered by policy, and nothing about what it thinks was *felt*. |
| **Any sound that could be described as a beep** | The fastest way to get a device unplugged. |

---

# PART 5 — THE DESIGN PRINCIPLES

*These are not guidelines. They are the product's constitution. When a design decision is contested, the principle wins and the feature changes.*

### 1. The resident is the user. The family is the customer. Never confuse them.
Every feature must answer "what does Margaret get from this?" A feature that serves only Sarah is a feature Margaret will eventually resent.

### 2. Never interrupt a scene.
Nothing non-urgent appears while a programme is playing. The door is the only exception, and even then it never pauses, covers or silences anything.

### 3. One button.
Every action a resident can take is reachable with the directional pad and a single OK press. No text entry anywhere in the product. No menus more than one level deep. If a flow needs two presses, it needs redesigning.

### 4. Nothing to learn.
If it requires explanation, it is wrong. The product should be comprehensible to someone who has never seen it and has not been told it exists.

### 5. Silence is the default state.
Wick's normal condition is saying nothing. It speaks only when it has something genuinely worth a person's attention. A quiet day should produce a quiet product.

### 6. Three things, never four.
The Day Card holds a maximum of three items. The Door Card has three buttons. Constraint is the feature; a longer list is a worse product.

### 7. Large, calm, still.
A minimum of 32-point type. Contrast well beyond the accessibility minimum. No animation that moves quickly, flashes, or startles. No red. No badges. No counters.

### 8. Never nag, never score, never judge.
Wick does not remind twice. It does not track compliance. It does not rate a person's day. It offers, once, at a good moment, and then lets it go.

### 9. No time limits.
Nothing in the product disappears on a timer or requires a response within a window. A card waits until it is dealt with, however long that takes.

### 10. The resident can always see what the family sees.
Transparency is not a settings screen buried three levels down. It is a first-class surface, and anything on it can be removed by the resident with one press. Permanently.

### 11. When Wick doesn't know, it says so.
No confident guesses. "I'm not sure who that is" is a correct and acceptable answer. Fabrication in a product like this is not a bug, it is a betrayal.

### 12. Dignity is a functional requirement.
Nothing in the interface, the voice, the copy or the demo video may position Margaret as diminished, childlike, or a problem being managed. If a sentence would embarrass her to read, it does not ship.

---

# PART 6 — THE TRUST MODEL

*Privacy in Wick is not a compliance section. It is the product. This part should be reflected almost verbatim in the README and summarised on screen in the demo video, because it is the single most credible thing the project can say.*

## 6.1 The four promises

These four sentences should appear, in this form, in the product, in the README, and in the video.

> **1. No camera ever shows the inside of this house to anyone.**
> Ring is used for the front door and for the fact that someone arrived or left. It is never used to watch the resident.
>
> **2. The resident can see everything the family can see.**
> One screen, on their own television, listing exactly what is shared. Anything on it can be removed permanently, by them, with one button.
>
> **3. Nothing about health, money or relationships leaves the house without explicit permission.**
> This is enforced by a written policy in the software, not by the good intentions of a model.
>
> **4. Wick reports what was said and what happened. It does not report what it thinks you felt.**
> No mood detection. No sentiment scores. No inferences about a person's inner state.

## 6.2 Who can see what

| Information | Resident | Family | Carer / agency |
|---|---|---|---|
| Who is at the door, right now | **Yes** | No | No |
| Doorbell and arrival events (that someone came) | Yes | **Yes** | Own visits only |
| Live or recorded video from the door camera | **Yes** | Only on explicit, per-event resident approval | No |
| Any camera inside the house | **Never captured** | **Never** | **Never** |
| Conversation content from the wearable | **Yes** | **No — never verbatim** | No |
| Facts derived from conversation (e.g. "mentioned knee pain") | Yes | Only if the class is permitted by policy **and** the resident has not excluded it | No |
| Commitments and appointments | Yes | Summarised only | No |
| Household rhythm (TV on/off, door activity patterns) | Yes | As narrative, never as raw logs | No |
| Weekly narrative | **Yes — the resident sees it first** | Yes | No |
| Carer visit times | Yes | Yes | Own visits only |

**The row that matters most:** *the resident sees the weekly narrative before the family does.* Nothing is said about Margaret behind her back. This is both ethically correct and a genuinely novel product decision, and it should be stated out loud in the video.

## 6.3 Consent — including for the demo video

We have a real older adult participating. That is an enormous advantage and a real responsibility.

**Before any filming or data collection:**

- [ ] Explain, in person and in plain language, what Wick captures, what it shares, and with whom.
- [ ] Get written, informed consent for (a) data collection, (b) appearing in a public video, (c) their home appearing, (d) the specific clips to be used — shown to them before publication.
- [ ] Establish an unconditional withdrawal right: at any point, for any reason, without explanation, everything is deleted. Say this explicitly and mean it.
- [ ] Agree what is off-limits before you start — rooms, topics, times of day.
- [ ] Offer a pseudonym and blur the house number. Being in a video watched by strangers is a bigger thing for a 78-year-old than it is for us.
- [ ] Show them the final cut before it goes public. Give them a veto. Honour it.

**In the video itself:** do not film the resident looking confused, struggling, or being helped. Film them doing something competently. The demo should make its subject look capable, because that is what the product is for.

> **This is not only ethics. It is scoring.** A judging panel of Amazon device-team professionals evaluating a product about vulnerable adults will actively look for evidence that the builder thought about this. A short, sincere on-screen statement about consent will be remembered.

## 6.4 Data handling, in plain English

| Question | Answer |
|---|---|
| Where does conversation data live? | On the resident's own equipment by default. Only derived facts — never raw transcripts — reach the cloud, and only after passing the disclosure policy. |
| Is video stored? | Door snapshots are held briefly to generate a description, then discarded. Live video is never recorded by Wick. |
| Who holds the keys to the door camera? | The cloud service, never the television. The TV holds a token that identifies the device and nothing else, so a stolen streaming stick yields nothing. |
| What happens if the resident withdraws? | Everything is deleted, including the derived facts and the rhythm baseline. One action, no negotiation. |
| Can the family export the data? | They can export the narratives they were shown. They can never export anything they were not shown. |
| What is retained, and for how long? | Events and derived facts for 90 days by default, configurable down. Rhythm baselines are statistical and hold no content. |

---

# PART 7 — THE TECHNOLOGY

## 7.1 How to read this part

This section names real technologies, because the build has to follow it. Every item is explained in one plain sentence first. **No technical knowledge is assumed.** A glossary of every term appears in Appendix A.

The thing to understand about the shape of Wick is that it has **four layers**, and they exist for a reason:

> **The television** shows things and takes button presses. It holds no secrets and makes no decisions.
> **The agent** does the thinking — reads the door, reads the day, decides what's worth saying and when.
> **The connectors** talk to Ring, to Bee, and to Alexa+, each in the way that service requires.
> **The memory** remembers this household: its rhythm, its people, its policy.

Keeping the thinking out of the television is the single most important structural decision. It means the TV app stays small and fast, secrets never sit on a £30 device in someone's front room, and the agent can keep working while the television is off.

## 7.2 Layer 1 — The television

**In one sentence:** a Fire TV application that displays cards, plays video, and turns button presses into requests.

| Component | What it is, plainly | Why this choice |
|---|---|---|
| **Vega OS** | Amazon's new operating system for Fire TV, replacing the older Android-based one. | It is the platform Amazon is actively investing in and the one judges most want to see used well. We have the hardware. |
| **React Native for Vega** | The standard way to build Vega apps — write once in a common language, run on the television. | It is what Amazon's own sample apps use, which means the path is well-lit and the code is idiomatic. |
| **Vega's background task system** | Lets part of the app keep running when the app is not on screen. | This is what makes Wick an *agent* rather than a *screen*. It is also the least-used part of the platform, which is a scoring advantage. |
| **Vega's content personalisation** | Lets an app tell the Fire TV home screen what has been watched, feeding the "Continue Watching" row. | Two purposes: the television behaves correctly, **and** it is how Wick learns the household's rhythm without any new sensor. |
| **Vega's media player** | The standard video playback engine. | Owning playback is what makes the Natural-Break Engine possible. This is not incidental — it is why S2 can exist. |
| **Vega's audio controls** | Lets the app lower programme volume politely rather than cutting it. | Principle 2: never interrupt. |
| **Vega's UI components** | Amazon's building blocks for television interfaces, including the focus system that makes a directional pad work properly. | Using the platform's own focus model is the difference between an app that feels native and one that feels ported. |
| **A Fire OS companion build** | A second version for older Fire TV hardware. | It widens the addressable market enormously, and we have the hardware to prove it runs on both. Build it last. |

## 7.3 Layer 2 — The agent

**In one sentence:** the part that decides what matters, what to say, and when to stay quiet.

| Component | What it is, plainly | Why this choice |
|---|---|---|
| **Amazon Bedrock AgentCore Runtime** | AWS's managed home for running AI agents — it handles the servers, scaling and security so we don't. | It is purpose-built for exactly this, and using it well is directly what the AWS Builder mini-challenge rewards. |
| **AgentCore Memory** | A managed memory for an agent — what it has learned about this household over weeks. | The rhythm pillar lives here. "That's up from last week" is only possible with real long-term memory. |
| **AgentCore Identity** | A managed vault for the credentials that let us talk to Ring on the household's behalf. | Keeps every secret off the television and out of our own code. |
| **AgentCore Gateway** | Turns our agent's abilities into a standard set of tools other systems can call. | This is how Alexa+ reaches Wick. |
| **Strands Agents SDK** | AWS's toolkit for building agents that are made of several cooperating specialists rather than one large one. | Wick genuinely has four jobs — door, day, narrative, policy — and separating them makes each one testable and explainable. Judges explicitly reward multi-agent architecture over a single model call. |
| **Amazon Bedrock (Nova and Claude models)** | The AI models that read the door snapshot and write the sentences. | Nova for fast, cheap image understanding; Claude for the narrative writing where quality of language actually matters. |
| **Amazon Polly** | Turns written text into a natural speaking voice. | Wick's voice on the television. Choose one voice and never change it — consistency is part of the trust. |
| **Amazon Transcribe** | Turns recorded speech into text. | Sarah's voice notes. |

**The four specialists inside the agent:**

| Agent | Its one job |
|---|---|
| **Door** | Watch the doorbell and the front camera. Decide whether this is worth showing, and describe what is actually there. |
| **Day** | Read the day's real conversational context. Find the handful of things worth remembering. |
| **Narrator** | Write the weekly story for the family. Compare against the rhythm. Never sensationalise. |
| **Guardian** | Sit between everything and the outside world. Enforce the disclosure policy. Refuse when refusal is correct. |

The Guardian is deliberately the last thing every message touches. That is an architectural commitment, not a convention.

## 7.4 Layer 3 — The connectors

| Connector | What it does | Key practical constraints |
|---|---|---|
| **Ring** | Receives doorbell presses and motion events; fetches a still image; opens a live video session; plays a message through the hallway Chime; reads the history of who came and when. | Ring will not talk to a web page or a television directly — only to a server. Ring also expects an acknowledgement of every event within five seconds, so our receiver must acknowledge first and think afterwards. |
| **Bee** | Provides the real conversational context: what was said, the facts distilled from it, the commitments made, the day's summary — including a live stream of new material as it arrives. | Data stays on the resident's own equipment; only derived, policy-filtered facts move. |
| **Alexa+** | Registers Wick as something Alexa+ can call, so Sarah's Echo can reach it. Renders the weekly timeline inside the Alexa conversation. | Currently available in the United States only. Uses a specific, recent version of an open industry standard for connecting AI systems to tools. |
| **Amazon EventBridge** | AWS's message router — takes an incoming Ring event and hands it to whoever needs it. | Lets the five-second acknowledgement happen instantly while the real work continues behind it. |

## 7.5 Layer 4 — The memory

| Component | What it holds | Why |
|---|---|---|
| **Amazon DynamoDB** | The household's timeline: events, cards shown, replies sent, people on the visitor roster. | Fast, cheap, scales to nothing when idle. |
| **Amazon Timestream** | The rhythm: television on/off times, door activity, arrival times, as measurements over weeks. | Purpose-built for "what does a normal Tuesday look like in this house". |
| **AgentCore Memory** | What the agent has learned and concluded, in its own terms. | The difference between a system that logs and a system that remembers. |
| **Amazon S3** | Door snapshots held briefly, voice notes, generated audio. | With automatic deletion rules, so "we don't keep video" is enforced by the storage itself rather than by discipline. |
| **Amazon Bedrock Knowledge Bases** | The accumulated facts about the household, searchable in plain language. | How "when did she last mention her knee?" gets answered truthfully rather than guessed. |

## 7.6 What it costs to run

A rough, honest monthly estimate per household at small scale. This matters because "could it realistically serve an audience beyond the hackathon" is a scoring criterion, and a product that costs more to run than it charges is not a business.

| Item | Estimate | Note |
|---|---|---|
| Agent runtime and memory | $2–5 | Idle most of the day; bursts at door events |
| AI model usage | $2–6 | Image understanding is cheap; the weekly narrative is one substantial call per week |
| Speech synthesis | <$1 | Short utterances |
| Storage and messaging | <$1 | Tiny volumes |
| Live video relay | Variable | Only when someone presses **Watch live** — seconds at a time, a handful of times a day |
| **Rough total** | **$6–14 per household per month** | Against a $15–19 subscription. Viable, and improves substantially with scale. |

> During the hackathon, request the **$150 AWS promotional credits** available to entrants. The form closes on **21 October at 12:00 PT**, while supplies last. Budget alarms from day one regardless.

## 7.7 Why this stack scores well

Three specific things a Tech Implementation judge will be looking for, and how the stack delivers them:

1. **Depth of platform use, not breadth of name-dropping.** Wick uses the background task system and the content-personalisation surface — two genuinely under-used parts of Vega — for exactly what they were designed for. That reads as fluency.
2. **Multi-service AWS architecture, not a single model call.** The judging guidance explicitly calls one Bedrock call for text generation "obvious" and a multi-service agentic pipeline "creative". Four cooperating agents on a managed agent runtime with real long-term memory is unambiguously the latter.
3. **Correct security posture without being asked.** No credentials on the television. Every outbound message through a policy gate. Event acknowledgement inside the platform's stated five-second budget. These are the details that separate someone who has shipped from someone who has demoed.

---

# PART 8 — HOW IT WORKS, IN PLAIN ENGLISH

*Four journeys, no jargon. If a technical decision cannot be explained here, it is probably the wrong decision.*

## 8.1 Someone rings the doorbell

1. The Ring doorbell is pressed. Ring immediately notifies our service.
2. Our service checks the message is genuinely from Ring, says "received" within a second, and hands the event on. *(Ring requires acknowledgement within five seconds, so nothing slow happens before that "received".)*
3. Behind the scenes, the service asks Ring for a still image from the doorbell.
4. The **Door** agent looks at the image and writes one sentence about what is actually there. If the household has a visitor roster, it checks whether this is likely one of them, and whether they would be expected today.
5. The **Guardian** checks this is permitted to be shown, and to whom.
6. If the television is on, the card appears in the lower third within about three seconds. If the television is off, nothing happens — the event is simply recorded.
7. If the resident presses **"Just a moment"**, our service asks Ring to play a recorded message through the Chime in the hallway.
8. If the resident presses **Watch live**, our service opens a live video session with the doorbell and the television shows it full screen.

**What is *not* happening:** no video is recorded, no image is kept beyond the seconds needed to describe it, and the television never holds any credential that could reach the Ring account.

## 8.2 Something worth remembering happens during the day

1. The resident's wearable captures the day's real conversations on their own device.
2. The **Day** agent reads the derived material — facts, commitments, the day's summary — as it arrives.
3. It looks for three kinds of thing: a commitment about to be forgotten, something the resident said about themselves worth noticing, and anything waiting from the family.
4. It picks at most three, writes them in short, plain sentences, and puts the card in a queue.
5. **The card waits.** The Natural-Break Engine holds it until the television reaches a moment where showing it will not interrupt — the end of an episode, a break, or the moment the television is switched on and settled.
6. The card appears, full screen, very large. The resident deals with it in a few seconds, or ignores it. If ignored, it waits for the next natural break. It does not escalate and it does not repeat itself more than once.

## 8.3 The family asks how things are going

1. Sarah says "Alexa, how's Mum been this week?" to her own Echo.
2. Alexa+ recognises this as something Wick handles and passes the question to our service.
3. The **Narrator** agent assembles the week: what happened, and — crucially — how that compares to a normal week for this household.
4. The **Guardian** passes every sentence through the disclosure policy. Anything about health, money or relationships is removed or summarised unless policy and the resident's own choices permit it.
5. Alexa+ speaks the result. If Sarah's device has a screen, a timeline of the week renders alongside it.
6. **The resident has already seen this narrative on their own television.** Nothing is said about Margaret that Margaret has not seen first.

## 8.4 The family sends a message

1. Sarah records a voice note or types a message.
2. Our service transcribes it if needed, and drafts three short replies in the resident's own register.
3. The card joins the queue and appears at the next natural break, with Sarah's photograph.
4. The resident presses ▶ to hear it, chooses a reply with the directional pad, and presses OK once.
5. Sarah receives the reply on her phone.

Total interaction for the resident: **one button, twice.**

---

# PART 9 — LIMITATIONS

*This part is deliberately long and deliberately honest. Two reasons: a product plan that hides its limits produces a build that discovers them at the worst possible moment — and the judging criteria explicitly reward "a genuine understanding of the developer ecosystem", which means knowing what the platform cannot yet do and saying so precisely.*

*Every limitation marked **→ FR** becomes a formal Feature Request in the submission. Every one marked **→ FL** becomes a Friction Log entry, which is worth up to a 10% scoring bonus.*

## 9.1 Platform limitations — things Amazon does not currently allow

### **L1 — A Vega app cannot reliably put anything on screen when it is not the active app.** *(Severity: Critical)* **→ FR, → FL**
This is the single biggest constraint on Wick. Vega has a background task system, so the agent can keep thinking while the app is not on screen — but there is no published way for a third-party app to draw a card over a *different* application's video, the way a notification works on a phone.

**What this means in practice:** the Door Card works as designed while Wick is the active application. If the resident is watching a different streaming app, Wick cannot currently interrupt it.

**How we handle it:** Wick is designed to be the household's default television surface — it plays content itself — which means in normal use it *is* the active app. Where it isn't, the card waits and appears the moment Wick returns to the foreground. This is the honest answer and it should be stated plainly rather than glossed over. The feature request writes itself: *a permissioned, rate-limited overlay surface for approved ambient applications, with a visible user permission prompt.*

### **L2 — Vega has no camera, no microphone, no Bluetooth and no presence sensors for third-party apps.** *(Severity: Important)* **→ FR**
Verified against the real dependency lists of every official Vega sample app. There is no way for Wick to see or hear the room from the television itself.

**What this means:** Wick cannot detect who is in the room, cannot take a voice reply directly from the television, and cannot do anything camera-based on the TV. This is precisely why the product uses Ring for the door and a wearable for the day — the constraint shaped the design, and arguably improved it.

### **L3 — There is no public API for the Fire TV Ambient Experience or its presence sensors.** *(Severity: Important)* **→ FR**
Newer Fire TV hardware has genuine presence detection and an ambient screen mode. Neither is available to third-party developers; this is an open, unanswered question on Amazon's own developer forum.

**What this means:** Wick cannot appear on a dormant television, and cannot know whether anyone is actually in the room. A future version with this access would be substantially better, and that is exactly what a feature request should say.

### **L4 — Some Fire TV integration features are restricted to selected partners.** *(Severity: Important)* **→ FR, → FL**
Deep-linking into other applications and platform account-linking are gated. There is no sandbox for an independent developer to evaluate them against.

**What this means:** do not design any demonstrated behaviour that depends on launching another app. Wick doesn't, and this is the reason.

### **L5 — Ring will not accept requests from a browser or a television.** *(Severity: Nice-to-have)* **→ FL**
All Ring API access must come from a server. This is a sound security decision that nevertheless forces an extra network hop for every television interaction.

**What this means:** slightly more latency on **Watch live**, and a hard requirement that our service is always available. It is also, conveniently, exactly the architecture we wanted anyway.

### **L6 — Ring's API has no two-way audio, no siren and no light control.** *(Severity: Important)* **→ FR**
The hardware supports two-way talk; the developer API does not expose it. Wick's "Just a moment" plays a pre-recorded message through a Chime instead — which works, but a resident cannot speak to a visitor from their armchair.

**What this means:** a genuinely desirable feature is simply unavailable. This is one of the strongest feature requests the project can file.

### **L7 — Ring's event descriptions are coarse.** *(Severity: Nice-to-have)* **→ FR**
Motion events indicate that a human was detected, but not much more. Distinguishing "a car pulled in" from "someone walked past" requires our own image analysis.

### **L8 — Ring gives no way to replay a missed event.** *(Severity: Important)* **→ FR, → FL**
If our service is briefly unavailable, the event is gone. There is no queue to catch up from and no test facility that emits events on demand, which makes automated testing awkward.

### **L9 — The Alexa+ MCP Toolkit is restricted to select partners, and is US-only.** *(Severity: Critical)* **→ FR, → FL**
Verified on the Alexa+ add-ons documentation home page: *"At this time, Category SDK and MCP Toolkit are available to select partners only."* There is no published eligibility criterion, application form or waitlist. The restriction appears only on the docs home page — the Overview, QuickStart and Certification pages all describe a self-serve flow without mentioning it.

**What this means:** the family pillar cannot be delivered through a real Echo. Wick ships a genuinely spec-compliant self-hosted MCP server instead (S4a), exercised through an MCP client and a simulated Alexa+ surface — a path the hackathon rules explicitly allow. Nothing about the server changes if access later opens.

Written up in full as **FL-001**, with a concrete suggestion: mirror Ring's model — register, develop immediately against your own devices, and gate only publication.

### **L10 — No secure hardware key storage is documented on Vega.** *(Severity: Important)* **→ FR**
For a product handling sensitive household information, the absence of documented hardware-backed credential storage on the device is a real gap. Wick works around it by keeping no meaningful secrets on the television at all — but not every product can.

### **L11 — No accessibility-preference API on Vega.** *(Severity: Important)* **→ FR**
An app cannot ask the system whether the user prefers larger text, higher contrast or reduced motion. For a product built entirely around accessibility, having to ask the user directly for something the platform already knows is a notable friction.

### **L12 — Amazon Kids profiles and household profiles are not accessible to third-party apps.** *(Severity: Nice-to-have)* **→ FR**
Wick must maintain its own idea of who is using the television rather than using the platform's.

## 9.2 Product limitations — things Wick genuinely cannot do

| Limitation | Why it matters | How we address it |
|---|---|---|
| **Wick cannot tell whether the resident is all right.** | It knows the television went on and the door opened. It does not know whether Margaret is well. | Say so explicitly. Wick reduces uncertainty; it does not eliminate it, and it is not a substitute for anyone. |
| **Wick cannot detect a fall or a medical emergency.** | This is the first thing every family will ask. | Answer it directly and repeatedly: Wick is not a medical device and makes no clinical claims. Recommend a proper alarm alongside it. |
| **Wick is blind when the television is off.** | Most of the day, in most households. | The Rhythm pillar partly compensates — a television that *doesn't* go on at its usual time is itself information. But the limitation is real. |
| **Wick depends on the resident wearing the Bee.** | If they don't wear it, the Day pillar is empty. | The Door, Family and Rhythm pillars still work fully. Wick degrades to three pillars rather than failing. Design for this from the start. |
| **Wick cannot know context it was never given.** | It doesn't know the hospital appointment was cancelled if nobody said so. | Never present a derived conclusion as certainty. Principle 11. |
| **Descriptions of visitors can be wrong.** | "A delivery driver" may be a neighbour in a coat. | Always show the actual image alongside the description. The picture is the ground truth; the sentence is a convenience. |
| **Wick needs weeks to become good.** | The rhythm baseline is worthless on day one. | Start collecting real data immediately. Say plainly in the submission how many real weeks the demo represents. |
| **One television, one household.** | Multi-television and multi-resident households are not handled in this version. | Tier 3 roadmap. Name it as a known gap rather than pretending it's out of scope. |

## 9.3 Data limitations

- **The wearable's transcription is imperfect.** Accents, crosstalk, television noise in the background. Derived facts inherit those errors. Never present a derived fact as a quotation.
- **Door events are not people.** A motion event is not proof anyone entered, and a doorbell press is not proof anyone was admitted. The narrative must use language that reflects this — "someone came to the door", not "Maria visited".
- **Absence of evidence is not evidence of absence.** If the door camera saw nothing, that may mean nobody came — or that the camera was offline. Wick must know the difference between "no events" and "no data", and say which.
- **A real demo cannot be re-shot.** Real life does not repeat. Capture generously and continuously from week one; the perfect doorbell moment will happen exactly once.

## 9.4 Commercial and regulatory limitations

| Limitation | Implication |
|---|---|
| **Regional availability** | The family pillar is US-only today. A UK or EU launch needs a different approach for that pillar. |
| **This is consumer software, not a medical device** | Staying on the correct side of that line is a permanent constraint on the product's language and features, not a one-off decision. Any claim about detecting or preventing a health event changes the regulatory category. |
| **Personal data, including inferences about health** | Handling this at scale in the UK/EU means real UK GDPR and GDPR obligations: lawful basis, data minimisation, the right to erasure, and a genuine Data Protection Impact Assessment. Wick's design already leans this way, but compliance is work, not an attitude. |
| **Recording law varies** | Doorbell cameras are subject to different rules in different jurisdictions, and audio is treated more strictly than video almost everywhere. Wick records no audio at the door, which avoids most of it. |
| **The name "Wick" is screened, not cleared** | Indicative web searches surfaced no conflicts in home technology, care services or consumer electronics — unlike two earlier candidates, which were eliminated for exactly that reason. But an indicative search is not trademark clearance. Before any commercial use, run a proper search in the relevant classes (software; likely also telecoms and care services) and check domain and app-store availability. Screened alternatives held in reserve: *Bide*, *Stead*, *Ingle*, *Limen*. |
| **The enterprise wedge needs its own product** | Care-agency visit verification has procurement cycles, compliance requirements and integration demands that a consumer app does not. It is a real business, but it is a second business. |

## 9.5 Self-imposed limits

These are constraints Wick chooses. They cost features. They are the point.

- **No indoor camera. Ever.** Even if a customer asks. Even if it would close a deal.
- **No clinical claims.** Even if the data would support an interesting one.
- **No emotional inference reported to anyone.** Even though the models could.
- **No monitoring without the resident's genuine, informed, revocable consent.** Even if the family is paying and the resident is unenthusiastic.
- **No dark patterns to increase engagement.** The best possible outcome is that Sarah opens Wick less often as her confidence grows.

---

# PART 10 — RISKS AND HOW WE HANDLE THEM

| # | Risk | Likelihood | Impact | Response |
|---|---|---|---|---|
| **R1** | The Door Card cannot be shown over active playback *(see L1)* | **High** | **High** | **Decide in week 1.** If it cannot be done, redefine the behaviour immediately: the card is waiting the moment the television returns to Wick. Rewrite the demo script accordingly and move on the same day. Do not spend three weeks fighting the platform — spend twenty minutes writing an excellent friction-log entry, which is worth actual points. |
| **R2** | Scope grows and nothing is finished | **High** | **Critical** | Tier 0 is frozen on day one. Nothing from Tier 1 starts until all six Tier 0 features run on real hardware. Nothing from Tier 2 starts until Tier 1 is **filmed**, not merely working. |
| **R3** | The Alexa+ integration proves harder or slower to obtain than expected | Medium | **High** | Validate access in week 1, before writing product code. If it is unavailable, the fallback is a genuinely functional standalone conversational surface for the family, and the submission says so honestly. |
| **R4** | Real Bee data yields thin or uninteresting facts | Medium | Medium | Start collecting immediately. If the automatic extraction is weak, the Day agent does more of the work over raw material. Assess by end of week 2. |
| **R5** | The product reads as surveillance despite our intentions | Medium | **Critical** | The trust model (Part 6) is not a section of the README, it is on screen in the product and spoken in the video. The "What Sarah Sees" feature exists precisely for this and should be promoted to Tier 1 if there is any doubt. |
| **R6** | The resident withdraws consent, or circumstances change | Low–Medium | **High** | This is their absolute right and must be honoured instantly. Mitigate by capturing footage early and continuously, and by having a second consenting household identified as a backup. Never pressure. |
| **R7** | Live video on the television is too slow to be pleasant | Medium | Medium | Measure it in week 1. If it is poor, **Watch live** becomes "show me the last few seconds" using a still or a short clip, which is nearly as useful and entirely reliable. |
| **R8** | The demo video runs over three minutes | Medium | **High** | Judges are not required to watch past 3:00. Script to 2:45. Cut architecture before cutting the human moments. |
| **R9** | The repository is not judge-ready | Medium | **Critical** | The licence must be visible in the repository's About panel — not merely present in a file. Setup instructions must actually work on a clean machine. Verify both a week before the deadline, not on the day. |
| **R10** | AWS costs run away during development | Low | Medium | Billing alarms on day one. Request the $150 entrant credits before 21 October. |
| **R11** | Copyrighted music or footage in the video | Medium | **Critical — disqualifying** | Original or properly licensed audio only. No television content visible that isn't ours to show. This disqualifies entrants every year. |
| **R12** | Building four pillars produces four half-products | Medium | **Critical** | The pillars are not equal. Door and Family are the demo. Day is the differentiator. Rhythm is invisible infrastructure. If something must give, it is breadth within a pillar, never a whole pillar. |

---

# PART 11 — THE COMPETITIVE LANDSCAPE

| Category | Examples | What they do | Why Wick is different |
|---|---|---|---|
| **Camera-based monitoring** | Ring, Nest, Wyze, plus "elder monitoring" resellers | Motion alerts and clips to a caregiver's phone | Caregiver-facing, alert-fatiguing, surveillance-shaped. Wick serves the resident and never streams the interior. |
| **Personal alarms** | Lifeline, Life Alert, pendant and watch alarms | Emergency button, fall detection | Reactive, worn, stigmatised, and in the drawer. Wick is ambient and worn by nobody. |
| **Passive activity sensors** | Canary Care, Just Checking, Birdie, Lively | Door and motion sensors feeding a caregiver dashboard | New hardware to install; nothing at all for the resident; output is a chart. Wick uses devices already present and outputs prose. |
| **Care coordination platforms** | CareZone, Carely, Papa | Shared calendars, task lists, notes between family members | Useful to families, invisible to the resident. Wick's primary surface is the resident's own television. |
| **Voice-first attempts** | Alexa Together *(discontinued)*, Alexa Care Hub | Voice check-ins and activity feeds via Echo | Amazon has tried voice alone here. Wick adds the screen, the door and the day — and learns from what didn't work. |
| **Companion robots and tablets** | ElliQ, GrandPad, Joy | A dedicated device the older adult must adopt | Adoption is the entire problem, and a new device is the entire problem restated. Wick requires adoption of nothing. |
| **TV-based health products** | Effectively none at meaningful scale | — | **The category is empty.** That is the opportunity. |

**The honest competitive summary:** none of these is bad. They are all built on the same assumption — that the caregiver is the user — and that assumption is what creates the adoption problem the whole category complains about. Wick's bet is that the assumption is wrong.

---

# PART 12 — THE BUSINESS

## 12.1 Market

| Layer | Size | Note |
|---|---|---|
| US adults 65+ living alone | **~15 million** | The narrow target |
| Of those, in households with a television and broadband | The large majority | Fire TV's own demographic skews older than the streaming average |
| US unpaid family caregivers | **~53 million** | The buyer population |
| Existing Fire TV households | Hundreds of millions of devices sold | **Distribution is already in the room** |
| US home-care agencies | Tens of thousands | The enterprise wedge |

**The distribution insight that matters most:** Wick does not need to persuade anyone to buy hardware. In a very large number of these households the television, the doorbell and the Echo are already there. The product is a download and a subscription.

## 12.2 Pricing

| Tier | Price | What's included | Who buys |
|---|---|---|---|
| **Free** | £0 | The Door Card, on the resident's own television. No family features. | The resident, or a family trying it |
| **Family** | **£14.99 / $16.99 per month** | Everything: the Day, the weekly narrative through Alexa+, two-way messages, carer verification | Sarah |
| **Starter bundle** | ~£150 one-off + subscription | Fire TV Stick + Ring Doorbell + setup, for households that don't have them | Sarah, at the point of a crisis — which is when this is actually bought |
| **Agency** | Per client, per month | Verified visit records across a client list, with export | Care agencies |

**Why free includes the Door Card:** because the resident must get value before the family gets information. That sequencing is the product's thesis expressed as a pricing decision, and it is also the best possible acquisition funnel — the resident asks to keep it.

## 12.3 Unit economics

At £14.99 against an estimated £6–14 in running costs, early gross margin is thin and improves markedly with scale as fixed agent-runtime costs amortise. The genuine lever is the **agency tier**, which has far better margins because the marginal cost of verifying a visit is close to zero once the door events are already being collected.

## 12.4 Route to market

1. **Fire TV Appstore** — the primary consumer channel, and a channel where a genuinely new category faces almost no competition for attention.
2. **Ring Appstore** — the second channel, reaching exactly the households that already have the doorbell.
3. **The crisis moment** — this product is bought in the week after a fall, a hospital admission, or a frightening phone call. Marketing should live where people look in that week: discharge information, carer forums, Age UK and AARP resources, and search.
4. **Care agencies** — a slower, higher-value channel where verified visit evidence sells itself.
5. **Amazon itself** — the honest ambition. A product that makes Fire TV, Ring, Alexa+ and Bee more valuable together is a product Amazon has a structural reason to want, and the prize for this track includes a meeting with the team that would decide.

## 12.5 What "success beyond the hackathon" looks like

- **Month 1–3:** ten real households, none of them ours. Measure whether Sarah checks less.
- **Month 4–6:** Fire TV Appstore listing; the first agency pilot.
- **Month 7–12:** multi-resident support, a second region, and the beginning of the evidence base for the only claim that ultimately matters — that Wick households stay at home longer.

---

# PART 13 — WHAT SUCCESS LOOKS LIKE

*Metrics chosen so that the product cannot win by being annoying. Most engagement metrics reward exactly the behaviour Wick is trying to eliminate.*

| Metric | Direction | Why this one |
|---|---|---|
| **Cards dismissed without action** | **Down** | If the resident is swiping Wick away, Wick is interrupting badly. This is the single most important number. |
| **Family app opens per week** | **Down** | Success is Sarah worrying less, not checking more. A product that increases anxious checking has failed. |
| **Resident retention at 90 days** | **Up** | The real test. Most products in this category are unplugged inside a month. |
| **Door Cards acted on** | **Up** | Proof the resident finds it genuinely useful rather than merely tolerable. |
| **Messages replied to** | **Up** | Proof the connection half is working. |
| **Days with no surfaced items** | **Healthy, not zero** | A product that speaks every day is nagging. Quiet days are correct behaviour. |
| **Items removed by the resident from "What Sarah Sees"** | **Watched, not optimised** | Some removal is healthy — it means the control is real and understood. A sudden spike means something has gone wrong in what we're sharing. |
| **Time from doorbell press to card on screen** | **Under 3 seconds** | Beyond this it is not useful; the visitor has gone. |
| **Weekly narratives the resident disputes** | **Near zero** | If Margaret reads her own week and says "that's not right", the whole product is untrustworthy. |

---

# PART 14 — THE WIN STRATEGY

## 14.1 Clearing Stage One

Judging happens in two stages. The first is a simple pass/fail: does the project reasonably fit the theme, and does it reasonably use the required technology for its track?

For the Fire TV track the requirement is unambiguous: **the demo video must show the project running on an actual Fire TV device or the Fire TV/Vega simulator.**

**Therefore: film that shot in week one, before the app does anything interesting.** A recording of Wick's home screen on a real Fire TV, taken early, is the insurance policy for the entire project. Everything else can be improved. That shot cannot be faked.

## 14.2 Mapping features to the four criteria

The four Stage Two criteria are **equally weighted**. Ties break in listed order: Tech Implementation first, then Design, then Potential Impact, then Quality of the Idea. That ordering means Tech Implementation is quietly worth slightly more than the others, and Design more than the two below it.

| Criterion | What the judges ask | Wick's strongest evidence |
|---|---|---|
| **Tech Implementation** | *How well is it built, and does it effectively leverage the required APIs, SDKs and device capabilities?* | Uses the two least-exploited parts of Vega — background tasks and content personalisation — for their actual purpose. Correct Ring security posture and five-second event discipline. A real Alexa+ integration on the current standard, including interactive UI in the conversation. Four cooperating agents on a managed runtime with genuine long-term memory, not a single model call. |
| **Design** | *Does it deliver a complete, coherent product experience? Is the interaction model intuitive and well-considered for the device?* | The Natural-Break Engine. One button. 32-point type. No badges, no beeps, no timers. Twelve written principles that a judge can check the product against. Designed for the hardest user in consumer technology and honest about it. |
| **Potential Impact** | *A credible, specific case for solving customer needs? Could it serve an audience beyond the hackathon?* | 53 million caregivers. 15 million older adults living alone. A £100,000-a-year alternative. A real buyer, a real price, a real enterprise wedge, and distribution through two Amazon app stores into households that already own every device required. |
| **Quality of the Idea** | *Creative and imaginative use of the tools? Genuine understanding of the ecosystem and the end user?* | The inversion, stated in one sentence. A product that is structurally impossible on any competing platform. A twelve-item limitations section that proves we read the documentation rather than skimmed it. And a set of explicitly rejected features that shows we know what a lesser version of this would have been. |

## 14.3 The +10% friction bonus — the most mispriced opportunity in this hackathon

Amazon's internal review team assesses friction-log entries during Stage One and passes a recommended bonus — **up to 10%** — to the Stage Two panel, which applies it to the final score.

On an equally-weighted four-criterion rubric, **10% is roughly the difference between first and second place.** It costs a few hours spread across the build.

**Open a `FRICTION.md` on day one and append to it as things go wrong.** Each entry needs all six fields the rules ask for: the task attempted, the steps taken, expected versus actual result, a severity rating, the workaround used, and an actionable suggestion.

**Part 9 of this document is your starting list.** Every limitation marked **→ FL** is a verified, real gap. Write each one up properly the moment you hit it, while the details are fresh — retrospective friction logs read as retrospective.

Target: **twelve to fifteen high-quality entries.** Most entrants will file none.

## 14.4 The two mini challenges — both are nearly free

**AWS Builder ($5,000).** The judging guidance explicitly calls a single Bedrock call for text generation "obvious" and a multi-service agentic pipeline "creative". Wick's architecture is already unambiguously the latter. The critical detail: **this challenge is judged largely on the Product Feedback answer**, so describe the AWS architecture properly there, not just in the README.

**Open Source ($5,000).** The guidance calls a README fix "obvious" and "a new integration pattern" creative. Wick's natural extraction is an **accessible television component library** — large-type, high-contrast, single-action, no-motion cards for Vega, with a linting rule that flags focus-order mistakes. It is genuinely reusable, genuinely absent, and directly downstream of work we have to do anyway. Ship it under a permissive licence, then open a pull request against one of Amazon's own sample repositories adding an accessibility theme. Pull requests do not need to be merged.

Remember the extra required fields: contribution URL, repository URL, GitHub username, and a description of what was done, how it works and why it matters.

## 14.5 Product feedback is a scored artefact, not a form

Every tool, API and SDK touched needs: what it was used for, what worked, what needs work, how onboarding felt, and whether you would build with it again and why.

**Write it as a staff engineer's platform review**, because the people reading it build these platforms and gathering this feedback is the hackathon's explicitly stated purpose. This is also where the AWS Builder mini challenge is judged. It is not paperwork; it is one of the highest-signal surfaces in the submission.

## 14.6 The demo video — the highest-leverage artefact in the project

Judges are not required to watch past three minutes. **Script to 2:45.**

| Time | Shot | Purpose |
|---|---|---|
| **0:00–0:12** | A real living room, a real television playing. One line on screen: *"The average 78-year-old looks at this screen for seven hours a day. It has never once looked back."* | The hook. No logo, no title card, no music sting. |
| **0:12–0:22** | The inversion, stated: every care product is built for the person who isn't there. | The idea, in ten seconds. |
| **0:22–0:50** | **The Door, live.** A real doorbell press. The real card on the real Fire TV. The real description. The button pressed. The real Chime speaking in the hallway. | The money shot. Everything else supports this. |
| **0:50–1:20** | **The Day, live.** The episode ends, the card appears, real Bee-derived items, the real message from the real daughter, the one-button reply, the phone buzzing at the other end. | The emotional centre. |
| **1:20–1:45** | **The Family, live.** The real MCP server answering a real question, through an MCP client and the simulated Alexa+ surface. Say on screen, in one line, that the Alexa+ add-on surface is partner-gated and this is the permitted alternative. | The cross-device proof — and the honesty is itself credibility. |
| **1:45–1:55** | **The refusal.** Ask Alexa something the resident has marked private. Watch it decline. | Ten seconds that will be remembered. |
| **1:55–2:25** | Architecture, fast and named: the Vega capabilities, the Ring endpoints, the agent graph. On screen, not narrated vaguely. | The Tech Implementation evidence. |
| **2:25–2:40** | The stance, stated plainly: no indoor camera ever leaves this house. The resident sees her own week first. A word about consent. | Credibility. |
| **2:40–2:55** | Market, bundle, repository, licence. | The close. |

**Rules that disqualify people every year:** no third-party trademarks, no copyrighted music, no copyrighted footage. Use original or properly licensed audio, and be careful about what is playing on the television in shot.

**Film the human moments first.** Architecture can be recorded at a desk the night before. A real doorbell moment with a real person in a real house happens once.

---

# PART 15 — THE SHAPE OF THE WORK

*Roughly five and a half weeks remain. This is a sequencing plan, not a schedule — sequence matters far more than dates, because each phase de-risks the next.*

## Phase 0 — Prove the ground *(first 72 hours)*

The purpose of this phase is not to build. It is to **find out what is impossible before committing to it.**

- [ ] Register on Devpost. **Request the $150 AWS credits** — the form closes 21 October, 12:00 PT, while supplies last.
- [ ] Create the Ring developer account and confirm API access.
- [ ] Confirm access to the Alexa+ integration surface. **This is the highest-uncertainty dependency; find out now, not in week four.**
- [ ] Install Amazon's own Builder Tools into the coding environment — it is the hackathon's recommended tool, it genuinely helps, and **using it will generate friction-log entries**.
- [ ] Get an official Vega sample application running on the real Fire TV Stick. **Record that footage.** This is Stage One insurance.
- [ ] **Answer R1:** can anything be drawn over active playback? Decide the Door Card's behaviour this week, and rewrite the demo script to match whatever the answer is.
- [ ] **Begin real data collection in the resident's home.** Ring events and Bee capture, running continuously from now. Every day of delay is a day missing from the rhythm baseline.
- [ ] Create the repository with its licence visible in the About panel. Open `FRICTION.md`. Take the first screenshot.

## Phase 1 — The spine, in order

Build S1 through S6, finishing each before starting the next. Build **S4 (the Family Line) second**, immediately after S1, because it is the piece most likely to contain an unpleasant surprise and the piece that proves the system works end to end.

Exit condition: **all six Tier 0 features run on real hardware with real data.** Not on a simulator. Not with test fixtures.

## Phase 2 — The multipliers

M1 through M6, in that order. M1 is small, delightful and differentiating — build it first. Stop the moment Phase 3 needs to begin; unfinished multipliers cost nothing, an unfinished video costs everything.

## Phase 3 — Film it

**Start filming before you think you are ready.** Allocate a full week. Real life does not do second takes, and the resident's availability is not infinitely elastic.

Shoot the human moments across several days so you have choices. Get the consent conversations done and documented properly before the camera comes out.

## Phase 4 — The submission surfaces

These are scored artefacts and deserve real time, not the last evening:

- [ ] README as a landing page: live demo first, the idea in two sentences, the architecture, the trust model, setup instructions that actually work on a clean machine.
- [ ] The licence visible in the repository's About panel — **verify this, it is a common and fatal omission.**
- [ ] Product feedback, written as a platform review.
- [ ] `FRICTION.md` finalised — twelve to fifteen entries.
- [ ] Feature requests with priority ratings.
- [ ] Open-source library published and the pull request opened.
- [ ] Devpost form completed with both mini challenges declared and all their extra fields filled.

## Phase 5 — Buffer

Keep the final few days genuinely free. Something will go wrong. Submitting a day early is worth more than any feature you could add in that day.

---

# PART 16 — DECISIONS STILL OPEN

*These need an answer, and the answer changes the build. None of them blocks starting.*

| # | Decision | Options | Recommendation |
|---|---|---|---|
| **D1** | **Vega or Fire OS as the primary build?** | Vega is newer, thinner, more impressive to judges, more constrained. Fire OS is more capable and reaches far more existing devices. | **Vega primary, Fire OS companion.** We have both devices. Vega demonstrates ecosystem fluency; the Fire OS build widens the impact story. Build Vega first. |
| **D2** | **Does the resident see the weekly narrative before the family?** | Yes (stronger ethics, a genuinely novel claim, and a better story) or no (simpler). | **Yes.** It is a differentiator, it is right, and it costs almost nothing. |
| **D3** | **Known Visitors — face-based or schedule-based?** | Face recognition on an opt-in roster, or purely "Maria usually comes at nine on Tuesdays". | **Start schedule-based.** It delivers most of the value with none of the weight, and it can be upgraded. Revisit only if the demo genuinely needs it. |
| **D4** | ~~**What is the product called?**~~ **RESOLVED** | Screened against conflicts in home tech, care and consumer electronics. Two candidates were eliminated on direct sector collisions. | **Wick.** Locked on 14 September 2026. Use it everywhere, consistently, from today. Formal trademark clearance remains outstanding before commercial use — see Part 9.4. |
| **D5** | **How much of the Day pillar depends on automatic extraction?** | Rely on the wearable's own derived facts, or do more interpretation ourselves. | **Assess with real data by end of week two**, then decide. Do not guess now. |
| **D6** | **Is "What Sarah Sees" Tier 1 or Tier 2?** | Ethically it is central; by effort it is small. | **Promote to Tier 1 if week three is calm.** It is the cheapest credibility in the product. |
| **D7** | **One household or two in the demo?** | A single real household is deeper. Two is more robust against withdrawal. | **One real household, one identified backup.** Never pressure the primary. |

---

# APPENDIX A — GLOSSARY

*Every technical term used in this document, in one plain sentence.*

| Term | Plain English |
|---|---|
| **Agent** | A piece of software that decides what to do rather than following a fixed script. Wick has four, each with one job. |
| **AgentCore** | Amazon's managed service for running AI agents — it handles the servers, the memory and the security credentials. |
| **Alexa+** | The new, more capable version of Alexa, which for the first time can call out to third-party services like Wick. |
| **API** | A defined way for one piece of software to ask another for something. "The Ring API" means the set of requests Ring will accept from us. |
| **Bedrock** | Amazon's service for using large AI models without running them yourself. |
| **Bee** | A small wearable that captures the conversations around its wearer and distils them into facts, commitments and summaries. |
| **Chime** | A Ring accessory that plays sounds inside the house. Wick can make it speak. |
| **Fire OS** | The older, Android-based operating system on most existing Fire TV devices. |
| **Headless / background task** | Part of an app that keeps running when the app is not on screen. |
| **MCP** | An open industry standard for connecting AI assistants to outside services. It is how Alexa+ reaches Wick. |
| **Nova / Claude** | AI models available through Bedrock. Nova is used here for quickly understanding images; Claude for writing the narratives. |
| **Polly** | Amazon's service that turns written text into a natural speaking voice. |
| **Ring Partner API** | The set of requests Ring accepts from approved developers — doorbell events, still images, live video, event history. |
| **RTSP / WHEP** | Two standard ways of receiving live video from a camera over the internet. |
| **Snapshot** | A single still photograph from a camera, as opposed to a video. |
| **Streamable HTTP** | The specific connection method Alexa+ requires for talking to a third-party service. |
| **Transcribe** | Amazon's service that turns recorded speech into text. |
| **Vega OS** | Amazon's new operating system for Fire TV, replacing Fire OS on the latest devices. |
| **Watch Activity** | The information an app tells Fire TV about what has been watched, which populates the "Continue Watching" row. |
| **Webhook** | A message one service sends to another the instant something happens, rather than waiting to be asked. |

---

# APPENDIX B — CHECKLIST BEFORE SUBMITTING

Drawn directly from the Official Rules. Every one of these has disqualified someone, somewhere.

- [ ] Public GitHub repository, with an open-source **licence visible in the About panel at the top of the repository page** — not merely a file in a folder.
- [ ] All source code, assets and working setup instructions in the repository.
- [ ] Demo video **under 3:00**, public, on YouTube or Vimeo, in English.
- [ ] The video **shows Wick running on a real Fire TV device or the Fire TV/Vega simulator**.
- [ ] No third-party trademarks, no copyrighted music, no copyrighted footage.
- [ ] Product feedback completed for every tool, API and SDK used — with the AWS description inside it.
- [ ] Primary track declared: **Fire TV**. *(Wick also qualifies for Ring, Bee and Alexa+ — but a project can win only one track prize, and Fire TV first place is the largest. Enter Fire TV only; let the other integrations be evidence of ambition inside that submission.)*
- [ ] Both mini challenges declared, with their extra fields completed.
- [ ] `FRICTION.md` entries submitted — the up-to-10% bonus.
- [ ] Feature requests submitted with priority ratings.
- [ ] Every third-party service used is one we are authorised to use, and the README says so.
- [ ] The project is free and unrestricted for judges until judging ends, with any credentials they need included.
- [ ] Written consent from the resident on file, and the final cut shown to them before publication.
- [ ] All data in the demo is **real**. Nothing simulated, anywhere.

---

# APPENDIX C — THE CAST

*Use these names and details consistently across the README, the Devpost description, the video and the interface. Consistency is what makes a product feel real.*

| | |
|---|---|
| **Margaret**, 78 *(she/her)* | The resident. Lives alone, forty-one years in the same house. Widowed. Bad knee she under-reports. Watches television from four o'clock. Has never voluntarily installed an app. **The user.** |
| **Sarah**, 51 *(she/her)* | Margaret's daughter. London, two hundred miles away. Full-time job, two teenagers, permanent low-grade worry. **The buyer.** |
| **Maria**, 44 *(she/her)* | The carer. Eleven clients. Tuesdays and Fridays, nine o'clock. Paper timesheets. **The enterprise wedge.** |

---

*Wick — Product Definition, Feature Plan and Win Strategy · Version 1.0 · 14 September 2026*
*Build, Ship, Shape: Amazon Developer Hackathon · Fire TV Track, 1st Place*
