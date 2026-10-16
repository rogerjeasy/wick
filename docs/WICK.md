# Wick

**What it is, who it's for, and why it works the way it does.**

Roger Bavibidila · version 2.0 · 16 October 2026

How it's built is in [`WICK-TECHNICAL.md`](WICK-TECHNICAL.md). What's real and
what's simulated in this repository is in the README's
[*What is real, and what is simulated*](../README.md#what-is-real-and-what-is-simulated).
If this document and the code disagree about behaviour, this document is wrong
and I fix it.

---

# Part 0: The idea

Almost every product I found for older people living alone is built for
someone else. It's a phone app full of alerts, checked by a daughter two
hundred miles away between meetings. The person it's about, the 78-year-old in
the armchair, gets nothing from it, or feels watched.

I wanted to build the opposite. **Wick turns the television into a care product
for the person being cared for.** It's the screen she already watches for more
than four hours a day, and she doesn't have to install, learn, wear or change
anything.

It needs three things Amazon already has and nobody else has together:

| Device | What it does in Wick |
|---|---|
| **Fire TV** | Where everything appears: calm, large, one button at a time. |
| **Ring** | The door. Who's here, who came, who didn't. |
| **Alexa+** | How her family, far away, asks "how's Mum been?" |

Behind them is an agent. It watches the door and learns what a normal week
looks like in the house. Then it does two things. It tells her the few things
that matter to her, at a moment that doesn't interrupt. And it tells her family
a true, calm story about the week, which she has read first.

Past 75, Americans spend more than four hours a day in front of the television
(BLS American Time Use Survey 2025: 4.43 hours). It has never once looked back.

**What exists today.** Every device is a simulator or a stand-in: the Vega
Virtual Device, the Fire OS build on the Android TV emulator, Ring's Developer
Playground, and a family app standing in for Alexa+. The household is a demo
home with six weeks of simulated history, marked as such. There is no real
resident. Everything in between is deployed and real: the AWS stack, the MCP
server, the agents and models, the disclosure policy, accounts and pairing.

---

# The name

> **Wick** *(adj., Northern English)*: alive.

Three old words share the spelling, and I liked that the product is all three.

1. **Alive.** In the north of England, *wick* means living, from Old English
   *cwic*, the "quick" in *the quick and the dead*. In *The Secret Garden*,
   Dickon scrapes the bark of a rose everyone has given up on and says "It's
   wick."
2. **The thread that carries the flame.** A wick isn't the fire. It's the
   modest thing that keeps the light going.
3. **A dwelling.** Old English *wīc*, a village, as in Norwich and Warwick.

Products in this space are named for decline: *Care*, *Guardian*, *Assist*,
*Watch*, *Alert*. Each name tells its user what they've become. I didn't want
that. Margaret isn't a patient or a risk. She's 78, she's in her own house, and
she's wick.

With Alexa+, the assistant finds Wick from what you ask, so the name rarely has
to be said out loud. That let me choose it for what it means.

---

# Part 1: Why Wick exists

## 1.1 The problem

Sarah lives in London. Her mother Margaret, 78, lives alone two hundred miles
away, in the house Sarah grew up in.

Sarah's week has a constant hum of not knowing. Did Mum eat? Did the carer come
on Tuesday? She rings on Sunday and Margaret says "I'm fine, love," because
that's what Margaret says.

Sarah has tried three times. She bought an indoor camera, watched clips of an
empty hallway for eleven days, and stopped. She bought a pendant alarm, which
is in the kitchen drawer. She set up a tablet, which Margaret doesn't use.

Meanwhile the television in Margaret's front room is on from four in the
afternoon until eleven at night. It's the most reliable, most trusted thing in
her day, and it does one thing.

Wick is what happens when you notice the television.

## 1.2 The numbers

| Figure | Value | Source |
|---|---|---|
| Unpaid family caregivers in the US | **63 million**, up nearly 50% since 2015 | AARP and NAC, *Caregiving in the U.S. 2025* [1] |
| US adults 65+ living alone | **about 16.2 million** (2023); **26%** of adults 65+ | Computed from US Census CPS ASEC 2023, table AD-3 [2]; Pew's reading of the ACS [3] |
| Television per day | **4.20 hours** at 65–74, **4.43 hours** at 75+ (2.6 across all ages) | BLS *American Time Use Survey*, 2025, table 11A [4] |
| Americans 65+ with Alzheimer's | **7.4 million** (2026) | Alzheimer's Association, *2026 Facts and Figures* [5] |
| US median cost of care, 2025 | Nursing home private room **$129,575 a year**; assisted living **$74,400 a year**; home caregiver **$35 an hour** | CareScout, *Cost of Care Survey* 2025 [6] |
| Adults 50+ who want to stay at home as they age | **75%** | AARP, *2024 Home and Community Preferences Survey* [7] |
| Adults 65+ who own a smartphone | **78%** | Pew, *Mobile Fact Sheet*, 2025 [8] |
| Visit verification for home care | Required by federal law for Medicaid personal care and home health | 21st Century Cures Act §12006 [9] |

The gap between a $129,575-a-year nursing home and a monthly subscription is
the market. I don't claim Wick keeps anyone at home longer. There's no evidence
either way yet.

Most older adults do own a phone. My argument isn't that they can't use one.
It's that the screen they already sit in front of needs nothing new learned.

**Sources.**
[1] <https://www.aarp.org/pri/topics/ltss/family-caregiving/caregiving-in-the-us-2025/> ·
[2] <https://www.census.gov/data/tables/time-series/demo/families/adults.html> ·
[3] <https://www.pewresearch.org/short-reads/2025/12/04/a-smaller-share-of-older-us-adults-live-alone-today-than-in-1990/> ·
[4] <https://www.bls.gov/news.release/atus.t11a.htm> ·
[5] <https://www.alz.org/alzheimers-dementia/facts-figures> ·
[6] <https://www.carescout.com/cost-of-care> ·
[7] <https://www.aarp.org/press/releases/2024-12-10-new-aarp-report-majority-adults-50-plus-age-place-policies-communities-catch-up.html> ·
[8] <https://www.pewresearch.org/internet/fact-sheet/mobile/> ·
[9] <https://www.hhs.gov/guidance/document/cures-act-electronic-visit-verification>

I found no reliable recent figure for how many caregivers live far away, so I
haven't given one.

## 1.3 Why existing products fail

There are hundreds of products here, and a few already use the television
(Part 11). Most fail in one of four ways.

1. **They're built for the wrong person.** The caregiver gets a dashboard and
   the person whose house it is becomes a data source.
2. **They produce alerts, not understanding.** Forty motion alerts a day get
   muted within two weeks, and then the product fails silently.
3. **They ask the older person to adopt something.** A pendant, a wristband, a
   tablet. Each one is a daily reminder of decline, and nobody wears them.
4. **They feel like surveillance, because they are.** A camera streaming
   someone's living room to their children wears away the relationship it was
   bought to protect.

## 1.4 What I did differently

Every product in this space asks how to get data **out** of the home to the
caregiver. I asked how to get something useful **into** the home, onto a screen
she already trusts, without her changing a habit.

| Usual care tech | Wick |
|---|---|
| Made for the distant caregiver | **Made for the resident** |
| A phone app | **The television** |
| Alerts and clips | **A few things that matter, and a true story** |
| She must adopt something | **She adopts nothing** |
| Nothing in it for her | **The door, her family, her own week** |
| Indoor cameras watch her | **No indoor camera, ever** |
| Success is the caregiver checking | **Success is the caregiver needing to check less** |

Wick isn't something the family puts on Margaret. It's useful to her: it tells
her who's at the door and brings her Sarah's notes. The weekly picture for
Sarah comes out of that, not the other way round.

## 1.5 Why it has to be Amazon

Wick needs three things at once:

1. **A trusted screen that's always in the room.** Fire TV.
2. **A doorbell with a real developer API.** Ring, with live video, recorded
   frames, webhooks and event history.
3. **An assistant the family already owns.** Alexa+, which can call a
   self-hosted MCP server. For now that's open to select partners only (L9).

| Platform | Screen | Doorbell API | Assistant | Could build Wick? |
|---|---|---|---|---|
| **Amazon** | Fire TV | **Ring** | **Alexa+** | **Yes** |
| Google | Google TV | Nest (limited) | Gemini | No |
| Apple | Apple TV | None | Siri | No |
| Roku | Roku | Roku Cameras (no third-party API) | None | No |
| Samsung | Tizen | SmartThings (partial) | Bixby | No |

Wick isn't an app that happens to run on Fire TV. It only makes sense where the
screen, the door and the assistant come from the same place.

---

# Part 2: Who it's for

These three people are personas. I use the same names everywhere: in the app,
the README and the code.

## 2.1 Margaret, 78, the resident

**The user, not the buyer.** She has lived alone in the same house for
forty-one years and is widowed. She forgets appointments, not people. She has a
bad knee she plays down. Her carer, Maria, comes on Tuesday and Friday mornings.
She has a smartphone for calls and photos of her grandchildren and has never
installed an app. She watches television from about four. She'll answer the
door to almost anyone, which worries Sarah.

She wants to stay in her house, not be a burden, and know who's at the door
before she gets up, because getting up costs her something. She won't put up
with being watched, nagged, taught, or beeped at.

Margaret is the hardest user there is, and she's the one Wick is for. Every
decision in this document goes her way.

## 2.2 Sarah, 51, the daughter far away

**The buyer, not the main user.** She works full time, has two teenagers, and
worries about her mother all the time at a low level. She'll find Wick, pay for
it and set it up.

She wants to stop wondering, to know Maria came, and to be told the one thing
that matters instead of forty that don't. She doesn't want another app to
check, more guilt, or to pay for something her mother won't have in the house.

What matters most about Sarah is that she doesn't want more data. She wants
less worry. If Wick makes her check more often, it has failed.

## 2.3 Maria, 44, the carer

**The way into care agencies.** She works for an agency, has eleven clients, is
paid per visit, and fills in timesheets later from memory. She wants to be
trusted and to do less paperwork. Her agency wants proof that visits happened
when they were claimed. In the US that's a funded requirement (Electronic Visit
Verification). In the UK it's a Care Quality Commission question.

A door event saying someone arrived at 09:04 is a better record than a
timesheet, and it needs no camera on Margaret.

## 2.4 Who it isn't for

- **People with advanced dementia.** Wick assumes she can read a card and press
  one button.
- **Anyone who needs clinical monitoring.** Wick isn't a medical device. It
  detects no falls, measures nothing, and makes no clinical claims.
- **People who don't watch television.** Everything depends on the screen
  being on.
- **Households in conflict.** Wick needs the resident's real consent. It isn't
  a way to watch a parent who said no, and the software enforces that.

---

# Part 3: What Wick is

## 3.1 In one paragraph

Wick is a Fire TV app with an agent behind it. The agent reads the household's
Ring doorbell and learns the household's rhythm from the television itself. On
the television it shows the few things she needs, like who's at the door, a
note from her daughter, or her own week, and only at moments that don't
interrupt. It answers the family's questions in plain sentences, not
dashboards. Today that's through the family app, and through Alexa+ once the
add-on surface opens. It never shows the inside of the house to anyone.

## 3.2 The three pillars

Every feature belongs to one of these. If it doesn't, it doesn't go in.

- **The Door** *(Ring to Fire TV).* Who's here, and what should I do about it.
  The most obviously useful thing Wick does for her.
- **The Family** *(agent to Alexa+ and the family app).* Sarah asks how her
  mother is and gets a true, calm answer. Notes go the other way and arrive at
  a natural break, and Margaret answers with one button.
- **The Rhythm** *(the television and the door, remembered).* Wick learns what
  a normal week looks like, so it can stay quiet when nothing is different.
  This is what makes the other two trustworthy.

## 3.3 A day in the life

*This is the day Wick is designed for. It isn't a recording. In this repository
the doorbell is Ring's simulator or a stand-in, the television is a simulator,
and Sarah asks in the family app.*

**09:02.** Maria's car pulls in. The television is off and this is what a
Tuesday looks like, so Wick notes it and says nothing to anyone. Saying nothing
when nothing is wrong is the hardest part to build.

**09:04.** The doorbell rings. Margaret answers. Wick records a carer visit, on
time.

**14:15.** A courier rings while Margaret is in the garden. Wick keeps the
event, so later it can say "a parcel came at quarter past two."

**16:20.** In London, Sarah asks for a note to go on her mother's television.

**16:40.** The television goes on. The note waits, because Margaret has just sat
down and is choosing what to watch.

**17:22.** The episode ends, and now one card appears in large type:

> **A message from Sarah.**
> *The plumber is coming Thursday at ten. Love you.*
> **Thanks for letting me know!** · **I'll call you soon.** · **Not right now.**

She picks a reply, presses OK, and goes back to her programme. Eleven seconds,
one button.

**17:24.** Sarah's phone buzzes. Her mother has replied.

**19:31.** The doorbell rings during a programme. A card appears in the lower
third. It doesn't cover the picture, pause it or make a sound:

> **Someone's at the front door.** *(a still from the doorbell)*
> *A man in a delivery uniform, holding a parcel.*
> **Watch live** · **Ring the hallway chime** · **Not now**

She presses the middle one. The hallway chime rings, so whoever else is in the
house knows. The card says *"The hallway chime rang."* She gets up in her own
time.

**Sunday, 10:00.** Sarah asks: *"How's Mum been this week?"*

> *"Steady week. The television was on most evenings, about as usual. Maria came
> both her usual days. One thing worth mentioning: a parcel came on Tuesday
> afternoon. Would you like me to put a note on her television?"*

That's everything Wick can know: the door, the television, the visits. It
doesn't know when she got up or where she went, and it doesn't guess. Margaret
read the same week on her own television first.

Sarah didn't open an app. Margaret didn't do anything at all.

## 3.4 What she has to do

**Nothing.** She installs nothing, makes no account, learns nothing, wears
nothing, charges nothing, remembers nothing, and watches television the way she
always has.

Sarah sets it up once. She makes an account in the family app and enters the
code the television shows. Then Margaret allows her with one press on her own
television.

## 3.5 What exists today

The three pillars are built, plus twelve features on top of them, all running
on the deployed stack. The README describes each one next to what it never
does.

| Feature | What it is |
|---|---|
| **Ask Sarah to look** | One button on the door card asks the family to look at the same picture. They answer with one of three fixed sentences. |
| **Shall I tell Sarah?** | An unusual day is put to her first. Only *"Tell"* lets the family read it. |
| **Calm points** | A note waits for the credits, a pause, or a measured quiet cut in the film, which holds while she reads. |
| **Watch together** | After her press, a family member's player follows hers for one film. |
| **The light in the window** | The family sees one thing: whether her day has begun. She can put it out. |
| **Hold for Sarah** | Holding OK for two seconds asks one person to ring her, then the next. |
| **The visit, witnessed** | *"Maria was here… Is this right?"* Only her "Yes" confirms a visit. |
| **Sarah's television** | A family member connects the same app on their own Fire TV. |
| **Her language** | Spanish, once she says yes. Wick's own sentences come from a hand-written phrasebook. |
| **The mantelpiece** | Pictures from the family, checked by Amazon Rekognition, kept or let go by her. |
| **Read to me** | Play reads the card on screen aloud with Amazon Polly. |
| **Easier to see** | Larger text, 40-point minimum, and 21:1 contrast on every screen. |

Also built: the stand-in doorbell for demo homes, because Ring's simulator sends
no doorbell event, plus *What Sarah sees*, the one-button reply, Watch live, the
hallway chime, and asking by voice in the family app.

---

# Part 4: The features

## 4.1 How I sorted them

I sorted features by what they do for Margaret first, then for Sarah, then by
cost and risk.

- **Tier 0, the spine.** Take one away and it isn't Wick.
- **Tier 1, the multipliers.** What turns it from informative into useful.
- **Tier 2, the depth.** Worth having, and the first to cut.
- **Tier 3, the roadmap.** Where it goes next.
- **Tier 4, rejected.** What a worse version of this product would include, and
  why I won't.

A missing feature costs nothing. A broken one costs trust, so I don't ship half
of anything.

## 4.2 Tier 0: the spine

### S1 · The door card

*Someone's at the door, and the television tells you who without stopping your
programme.*

When the doorbell is pressed, a card appears in the lower third. It doesn't
pause, cover or make a sound. It shows a still from the doorbell and one plain
sentence about what's there, such as *"A man in a delivery uniform, holding a
parcel,"* never "motion detected." It has three buttons: **Watch live**, **Ring
the hallway chime** and **Not now**.

It comes first because it's useful to her in the first five seconds with
nothing to learn. With a bad knee, knowing whether the trip to the door is worth
it is a real, everyday help.

**The hard part is not the card. It is the description.** The sentence has to be
short, factual and in the present tense, and it must never guess at intent.

**As built.** The card appears first with a fixed sentence. The picture and the
model's sentence follow when they're ready, and a sentence later than 2.5 s is
dropped. From the demo's stand-in doorbell, the card arrived in 2.3 s and its
picture in 2.7 s (medians of five rings, 16 October 2026). A real Ring press
hasn't been measured end to end. If another app is in front, Vega shows a system
toast and Fire OS shows a notification, each with a button that brings Wick
forward.

### S2 · The natural-break engine

*Wick knows when it's all right to speak, and waits.*

Wick plays the films itself, so it knows where she is in a programme: mid-scene,
at a pause, at the credits, or just switched on. Everything that isn't urgent
waits for a moment that doesn't interrupt.

This is what makes her put up with Wick for more than a week. Every other
product interrupts and gets muted.

There are only two kinds of message. **Now** is the door, shown at once without
stopping anything. **When there's a gap** is everything else. There's no third
kind.

**As built,** a note can also show at a *calm point*: a cut that falls in
silence, measured in each film with Amazon Rekognition and ffmpeg. The film
holds on the cut while she reads.

### S3 · (removed)

This was a card from a wearable's record of her day. Wick has no such data, so I
removed it. The number stays so the others keep their names.

### S4 · The family line

*"Alexa, how's Mum been this week?" answered in plain sentences, from anywhere.*

An MCP server, the open standard Alexa+ uses, lets Sarah ask about her mother
and get a true, calm answer. It's a paragraph, not a dashboard or a score, the
way a thoughtful neighbour would tell you. It's the reason Sarah pays.

Alexa+'s MCP Toolkit turned out to be for select partners only, and US-only
(L9). So the server is real and the Alexa+ registration is waiting:

- **The server** follows MCP 2025-11-25 over Streamable HTTP, with OAuth 2.1
  and PKCE, 22 tools, and no model inside any tool. On an open connection, calls
  meet Alexa+'s 500 ms target. A new connection takes 0.7 to 1.1 s, because App
  Runner closes idle connections.
- **The family app** calls it today, standing in for Alexa+. I say so wherever
  it appears. If access opens, the server needs no changes.

### S5 · The disclosure policy

*A written, enforced rule about what the family may see.*

Every sentence going to the family passes through one policy. It says what may
be shared, what must be summarised, what never leaves the house, and what she
has asked to keep private. Health, money and relationships are kept back by
rule, not by a model's judgement.

Without it, Wick is a surveillance product with good manners. With it, "this
isn't surveillance" is something you can check.

**As built:** `services/policy`, pure and property-tested, behind one egress
module that every family-bound string must pass. Ask the family app something
she's marked private and it declines.

### S6 · The rhythm

*Wick learns what a normal week looks like, so it can stay quiet.*

From data it already has, Wick builds a picture of this household's usual week:
when the television goes on and off, when the door is busy, when the carer
comes. It stores no video and needs no new sensors. It's used for two things:
staying quiet when things are normal, and writing a weekly story with real
comparisons, like "that's up from once last week."

Without it, the week is a list of events. With it, the week can say the one
sentence Sarah wants: *"nothing unusual this week."*

**As built:** counts by weekday and hour over the household's last six weeks,
and nothing is called different with fewer than three weeks of history. There's
no real household, so the demo home's six weeks are simulated, counted by the
same code, and marked everywhere they appear.

## 4.3 Tier 1: the multipliers

### M1 · Ring the hallway chime

*One button on the remote, and the chime down the hall rings.*

The middle button on the door card rings the Ring Chime in the hallway. The card
then says what happened: it rang, it's snoozed, or it didn't answer. Whoever
else is home knows someone's at the door, and Margaret gets up in her own time.

Ring's API can play sound only on a Chime, indoors. It can't speak through the
doorbell, so this tells the house, not the visitor. The button only appears
when the household has a Chime that's online and not snoozed. One press rings
it once, and no model ever decides to make a sound in someone's home.

**As built:** end to end, and tested against Ring's documented contract for
every outcome. It isn't demonstrated, because Ring's Playground has no chime and
I don't have a real one (FRICTION.md FL-019). Without a chime the button isn't
drawn, so it never offers something that can't work.

### M2 · Watch live

*The doorbell camera, full screen on the television, in one press.*

**Watch live** opens the doorbell's live view for as long as Ring allows: 30
seconds on a battery doorbell, 60 on a wired one. Back returns to the card.

Ring streams live video only over WebRTC, and Vega has no WebRTC (FL-015). So a
bridge receives Ring's stream, repackages it as HLS without re-encoding, and the
television plays it from CloudFront about six seconds after the press. Live view
is only allowed while a door card is under five minutes old.

**As built:** seen on both simulators with Ring's Playground camera.

### M3 · One-button reply

*A note from Sarah arrives, and Margaret answers with one press.*

Sarah types a note. It arrives at the next natural break with three replies, and
one press sends one. There's no keyboard, microphone or phone.

This makes the family line two-way, and that turns Wick from a monitoring
product into a connection product.

**As built:** no model writes the replies. Two are chosen for the note from a
fixed list of sentences I wrote, and the third is always *"Not right now."*, so
no model ever puts words in her mouth. The replies haven't been read by a real
older person yet. They should be.

### M4 · Known visitors

*"This looks like Maria. She usually comes on Tuesdays."*

The family adds the people they expect, such as the carer, the gardener or a
neighbour, with their usual days. When the doorbell rings, the card can say who
it probably is and whether that's expected today.

**As built:** schedule only. No face is ever matched. It's an explicitly opt-in
roster of people the household added themselves, deletable any time, never
applied to strangers, never used to build a profile of anyone.

### M5 · The visit, witnessed

*Maria came at 9:04 on Tuesday, and Margaret agrees.*

Wick records when a regular visitor actually arrived and roughly how long they
stayed, from the door's own events. This is what a care agency would pay for, and
it costs almost nothing on top of M4.

**As built:** the door's sightings make a visit, and the television asks her
*"Is this right?"* Only her "Yes" confirms it. It's the door's reading plus her
agreement, not a clinical or billing record. I think of it as protecting the
carer, not policing her: Maria gets a record that proves she came.

### M6 · The week, shown

A timeline of the week drawn inside the Alexa+ conversation, next to the spoken
answer. **Not built.** The Alexa+ surface is gated, and the family app shows the
week as text.

## 4.4 Tier 2: the depth

| # | Feature | What it does | State |
|---|---|---|---|
| **D1** | **Something's different** | When the week really is different, like a regular visitor who didn't come or someone at the door at night, Wick asks **her** first, on her television, showing the exact sentence it would send. Only *"Tell"* lets the family read it. *"Keep it to myself"* looks to the family exactly like nothing happened (INV-10). Nothing is called different with fewer than three weeks of history. | Built, as *Shall I tell Sarah?* |
| **D2** | **What Sarah sees** | A screen on her own television showing exactly what the family can see, with one press to take anything off. | Built |
| **D3** | **While you were out** | "A parcel came at quarter past two," on request from the home screen. | Not built |
| **D4** | **Ask about it** | Sarah asks specific questions, like "did Maria come on Tuesday?", through the 22 tools. | Built |
| **D5** | **Quiet hours** | Times of day when nothing appears at all. | Not built |
| **D6** | **When the internet goes** | The app says plainly when it can't reach Wick instead of failing silently. The door card falls back to its first sentence if the picture or description doesn't come. | Partly built |

## 4.5 Tier 3: the roadmap

| Idea | Why |
|---|---|
| **Two residents** | Many 78-year-olds live with someone. One television, a rhythm and a policy for each person. |
| **The sibling circle** | Several children, each involved differently. *Partly built:* a home has several members and she allows or removes each one. A separate policy per person isn't built. |
| **Medication rhythm** | Not reminders. Noticing when the usual pattern breaks, without becoming a medical device. |
| **A care agency portal** | Confirmed visits across a client list, priced per client. |
| **The neighbour** | *Built.* With her permission, a trusted neighbour can be asked to look at the door or ring her, and sees nothing else. |
| **Echo Show** | A second, smaller screen for the kitchen. Same agent, same policy. |
| **Hearing support** | Wick's voice through her hearing settings and hearing aids. *Read to me* is the first step. |
| **More languages** | Spanish is built. Each new language needs its own hand-written phrasebook. |

## 4.6 Tier 4: what I won't build

| Rejected | Why |
|---|---|
| **An indoor camera streamed to the family** | The one line Wick won't cross. Ring is for the door and for arrivals, never for watching her. |
| **Fall detection** | Unreliable without dedicated sensors, serious when wrong, and it would make Wick a medical device. |
| **A chatbot on the television** | Margaret isn't going to chat with her television. Wick speaks in cards and listens with one button. |
| **A wellness score** | Turning a person into a number out of ten is dehumanising and can't be defended. Wick writes sentences. |
| **Streaks, badges, gamification** | No. |
| **Tracking where she goes** | Wick knows the front door opened. It doesn't need to know where she went. |
| **An always-on microphone** | Her television has no microphone at all. The family app can take a family member's own spoken question when they press, and keeps nothing. |
| **Notifications to her phone** | Wick exists because that channel doesn't work for her. |
| **Mood or sentiment detection** | Guessing her feelings and reporting them to her children is overreach dressed as care. |
| **Anything that sounds like a beep** | The quickest way to get unplugged. |

---

# Part 5: The design principles

When a decision is contested, the principle wins and the feature changes.

### 1. The resident is the user. The family is the customer.
Every feature has to answer "what does Margaret get from this?" A feature that
only serves Sarah is one Margaret will come to resent.

### 2. Never interrupt a scene.
Nothing that isn't urgent appears during a programme. The door is the only
exception, and it never pauses, covers or silences anything.

### 3. One button.
Everything she can do is reachable with the arrows and one OK press. No typing
anywhere, and no menu deeper than one level.

### 4. Nothing to learn.
If it needs explaining, it's wrong.

### 5. Silence is the default.
Wick normally says nothing. A quiet day should give a quiet product.

### 6. Three things, never four.
Three films on the home screen. Three buttons on a card. A longer list is a
worse product.

### 7. Large, calm, still.
32-point type at least, contrast well past the minimum, no fast or flashing
movement, no red, no badges, no counters.

### 8. Never nag, never score, never judge.
Wick doesn't remind twice, track compliance, or rate her day. It offers once, at
a good moment, and lets it go.

### 9. No time limits.
Nothing disappears on a timer or needs an answer within a window. A card waits
as long as it takes.

### 10. She can always see what the family sees.
That's a screen of its own, not a setting three levels down, and she can remove
anything on it with one press, for good.

### 11. When Wick doesn't know, it says so.
No confident guesses. "I'm not sure who that is" is a good answer. Making
things up in a product like this isn't a bug. It's a betrayal.

### 12. Dignity is a requirement.
Nothing in the screens, the voice or the words may treat her as diminished,
childlike or a problem to manage. If a sentence would embarrass her to read, it
doesn't ship.

---

# Part 6: Trust

Privacy isn't a section of Wick. It's the product.

## 6.1 Four promises

> **1. No camera ever shows the inside of this house to anyone.**
> Ring is for the front door and for the fact that someone arrived or left.
>
> **2. She can see everything the family can see.**
> One screen on her own television lists it, and she can remove anything with
> one button.
>
> **3. Nothing about health, money or relationships leaves the house without her
> permission.**
> A written policy in the software enforces this, not a model's good intentions.
>
> **4. Wick reports what was said and what happened, never what it thinks she
> felt.**

## 6.2 Who can see what

| Information | Resident | Family | Carer or agency |
|---|---|---|---|
| Who is at the door right now | **Yes** | Only when she presses *"Ask Sarah to look"*, and then just that picture | No |
| That someone came to the door | Yes | **Yes** | Not built |
| Live video from the door | **Yes** | **Never** | No |
| Any camera inside the house | **Never captured** | **Never** | **Never** |
| Appointments | Yes | Summarised only | No |
| The household's rhythm | Yes | As narrative, never as raw logs | No |
| The weekly story | **Yes, and she sees it first** | Yes | No |
| Carer visits | Yes | Whether she confirmed them, never whether she disputed one | Not built |
| Whether her day has begun | Yes, and she can put it out | Lit or not, nothing more | No |

The row I care most about: **she sees the week before the family does.**
Nothing is said about Margaret behind her back.

## 6.3 Consent

There's no real older person in this project. The household is a demo home, its
history is simulated and marked, and the doorbell's visitors are pictures of
nobody real. I chose that on purpose: nobody's home was recorded to make this.

Before any real household uses Wick, or any real person appears in a recording:

- Explain in person, in plain words, what Wick captures, what it shares and with
  whom.
- Get written consent for the data, for any recording, and for each clip used.
- Agree what's off limits before starting: rooms, topics, times.
- Make withdrawal unconditional: everything is deleted, for any reason. A
  one-step deletion isn't built yet, so for now it's done by hand.
- Show them anything before it goes public, and honour a veto.

The software already enforces the part it can. Nobody reads a household until
the resident has allowed them, with one press on her own television (INV-9).

## 6.4 Data, in plain English

| Question | Answer |
|---|---|
| Is anything heard in the house? | No. A family member's spoken question in the family app is turned into words and not kept. |
| Is video stored? | Door pictures and live-view pieces are deleted within a day by the storage itself. Live video is never recorded. |
| Who holds the keys to the Ring account? | The cloud service, one secret per household. The television holds only a token for itself, so a stolen stick gets you nothing. |
| What if a family member is removed or a television disconnected? | It takes effect on their next request. |
| What if she withdraws? | Everything should be deleted. Today that's done by hand. |
| Can the family export the data? | Not built. |
| How long is it kept? | Door pictures and readings: a day, by storage rule. Family pictures: as long as she keeps them. A general retention period for the timeline isn't set yet. |

---

# Part 7: The technology

## 7.1 Four layers

> **The television** shows things and takes button presses. It holds no secrets
> and makes no decisions.
> **The agent** reads the door, learns the week, and decides what's worth saying
> and when.
> **The connectors** talk to Ring and to Alexa+ in the way each one requires.
> **The memory** remembers this household: its rhythm, its people, its policy.

Keeping the thinking off the television was the most important structural
decision. The app stays small and fast, no secrets sit on a cheap device in
someone's front room, and the agent keeps working while the television is off.

## 7.2 The television

| Part | What it does |
|---|---|
| **Vega OS and React Native for Vega** | The main app. It runs on the Vega Virtual Device. There's no Fire TV hardware in this project. |
| **Vega background service** | Lets the door reach her when another app is in front, as a system toast with one button that brings Wick forward. |
| **Vega content personalisation and media controls** | Tells the Fire TV home screen what's been watched, and lets "Alexa, pause" count as a natural break. |
| **The Fire OS build** | The same source on Android-based Fire TV, through four small adapters. It runs on the Android TV emulator, because there's no Fire OS emulator. A foreground service carries the door notification. |
| **A television in a browser tab** | Pairs and receives cards just like a television, so anyone can try Wick with no hardware. |

## 7.3 The agent

| Part | What it does |
|---|---|
| **Bedrock AgentCore Runtime** | Runs the door's work, each household in its own isolated session. |
| **Strands Agents SDK** | The door's steps as graphs. Ringing the chime and opening live view have no model in them. |
| **Nova Lite** | One sentence about who's at the door. |
| **Claude Sonnet 4.5** | The weekly story, written from numbers the code already counted, and choosing which tool answers a family question. |
| **Lambda, EventBridge, Scheduler** | The edge handlers, the event bus, and the three-minute wait in *Hold for Sarah*. |
| **Polly, Translate, Rekognition, Transcribe** | Reading aloud, her language, checking pictures and measuring calm points, and a family member's spoken question. |

Inside the agent are six specialists:

| Agent | Its one job |
|---|---|
| **Door** | Describe who's at the door, say who it probably is from the schedule, and act on her buttons. |
| **Narrator** | Write the weekly story. Count first, compare with the usual, and let the model write only from those numbers. |
| **Tell** | Ask her *"Shall I tell Sarah?"* when a day is unusual. |
| **Visit** | Ask her *"Is this right?"* about a visit the door saw. |
| **Reach** | Ask one person at a time to ring her. |
| **Guardian** | Stand between everything and the outside world, enforce the policy, and refuse when refusing is right. |

Only Door and Narrator call a model. The Guardian is the last thing every
family-bound message touches, and it's rules only.

## 7.4 The connectors

| Connector | What it does | Constraints |
|---|---|---|
| **Ring** | Receives events, fetches a frame, opens live view, rings the Chime. | Server to server only. Every event must be acknowledged within five seconds. Each household links its own account. |
| **Alexa+ and the family app** | The MCP server Alexa+ would call. The family app calls it today. | Alexa+ add-ons are US-only and partner-gated. |
| **IoT Core and API Gateway** | The two channels to the television: MQTT first, WebSocket as fallback. | The television's token is checked on every connect. |
| **Web Push** | A notice to a family member's browser. | It says only what kind of thing is waiting, never a name or a sentence. |

## 7.5 The memory

| Part | What it holds |
|---|---|
| **DynamoDB** | Everything about a household in one table: timeline, rhythm counts, weeks, cards, members, televisions. |
| **S3** | Door pictures and live video (deleted within a day), readings (a day), family pictures (as long as she keeps them), the films. Deletion is a rule on the storage, so "we don't keep video" is a guarantee. |
| **Secrets Manager** | Each household's Ring link, and the signing and push keys. No credential is in the code, on the television or in the repository. |
| **Cognito** | Family members' sign-in. Wick never stores a password. |

## 7.6 What it costs to run

An estimate, not a bill: AWS list prices in us-east-1, the deployed setup, and
assumed use.

**Fixed, whatever the number of households:**

| Item | Per month |
|---|---|
| App Runner (the Wick server, 1 vCPU / 2 GB, always on) | **$10–57**, depending on how busy it is |
| CloudFront, S3, API Gateway, IoT Core, logs, shared secrets | ~$5–15 |

**Per household:**

| Item | Per month |
|---|---|
| Ring link secret | $0.40 |
| Weekly story (Claude Sonnet 4.5) | ~$0.10 |
| Family questions (Claude Sonnet 4.5 choosing a tool) | ~$0.50–2 |
| Door events (Lambda, AgentCore, Nova Lite) | ~$0.10–0.50 |
| DynamoDB, Polly, Translate, Rekognition, Transcribe | <$0.50 |
| Live video relay | Only while someone presses **Watch live** |
| **Rough total** | **~$1.50–3.50** |

At 100 households that's about $150–200 a month, or $1.50–2 each. At 10
households the fixed part dominates and it's closer to $7–9 each. Against a
$15–19 subscription it works at a few hundred households, and not below that.

---

# Part 8: How it works

## 8.1 Someone rings the doorbell

1. Ring tells our service. The service checks it's really Ring, says "received"
   at once, and passes it on, since Ring wants an answer within five seconds.
2. A card goes to the television straight away: *"Someone's at the front door."*
3. The service fetches a frame from the doorbell and adds it to the card. The
   Door agent writes one sentence, which is dropped if it takes longer than
   2.5 s. If a regular visitor is due today, the card says who it probably is.
4. If another app is in front, a system toast or notification tells her, with a
   button that brings Wick forward.
5. Her buttons: **Ring the hallway chime** rings it once and says whether it
   rang. **Watch live** fills the screen with the doorbell camera. **Ask Sarah
   to look** shows Sarah the same picture, and Sarah's answer appears on the
   card.

No video is recorded, no frame is kept beyond a day, and the television never
holds anything that could reach the Ring account.

## 8.2 The family sends a note

1. Sarah asks the family app to put a note on her mother's television.
2. The note is checked against the policy and becomes a card with three replies.
3. The card waits for a moment that doesn't interrupt: the credits, a pause, a
   calm point, or the television settling after it's switched on.
4. She answers with one button, or doesn't. If not, it comes back once at a later
   break, then waits quietly on the home screen. It never escalates.
5. Sarah sees the reply.

## 8.3 The family asks how things are going

1. Sarah asks "How's Mum been this week?"
2. A model picks which of Wick's tools answers it. The tool first checks that
   Margaret still allows Sarah.
3. The Narrator wrote the week on Sunday: what happened, counted, and compared
   with a usual week here.
4. Every sentence has already passed the Guardian.
5. Margaret has already seen this week on her own television.

## 8.4 Margaret asks for a call

1. She holds OK for two seconds. A card asks: *"Ask Sarah to ring you?"*
2. She presses yes. Sarah is told her mother would like a call, and not why.
3. If Sarah hasn't answered in three minutes, the next person is asked, and a
   neighbour last.
4. Whoever answers picks one sentence, *"I'm ringing you now,"* and it appears on
   her television under their name.

Wick rings nobody, calls no service and sounds no alarm, and the card says so.

---

# Part 9: Limitations

The details, with what I tried and what I'd change, are in
[`FRICTION.md`](../FRICTION.md) and [`PRODUCT-FEEDBACK.md`](PRODUCT-FEEDBACK.md).

## 9.1 What the platforms don't allow yet

- **L1. A Vega app can't draw over another app's video.** Wick plays films
  itself, so it's usually the app in front. When it isn't, Vega's background
  service posts a system toast for the door, with a button that brings Wick
  forward (FL-022, FL-026). On Fire OS a foreground service posts one notification.
  Amazon's guidance says not to do that over another app, and Wick makes that
  exception for the front door only (FL-035). The Android TV emulator draws no
  third-party notifications, so I've only checked it in the system log (FL-036).
- **L2. Vega gives third-party apps no camera, microphone, Bluetooth or presence
  sensor.** Wick can't see or hear the room from the television, which is why
  the door comes from Ring. The limit shaped the design, and I think it improved
  it.
- **L3. No public API for Fire TV's ambient mode or presence sensors.** Wick
  can't appear on a sleeping television or know whether anyone is in the room.
- **L4. Some Fire TV integrations are partner-only,** like deep links into other
  apps, so nothing in Wick depends on launching another app.
- **L5. Ring accepts requests only from a server,** never from a browser or a
  television. That's sound, and it's the architecture I wanted anyway.
- **L6. Ring's API has no two-way talk, siren or lights.** She can't speak to a
  visitor from her armchair. The Chime (M1) tells the house instead.
- **L7. Ring's motion events are coarse.** Telling a car from a passer-by needs
  our own image check.
- **L8. Ring can't replay a missed event,** and the Playground can't send one on
  demand, so there's nothing to catch up from after an outage.
- **L9. The Alexa+ MCP Toolkit is for select partners only, and US-only.** Only
  the docs home page says so: *"available to select partners only."* There's no
  application form or waitlist. So the family reaches Wick through the family
  app, and the server is ready for the day access opens (FL-001).
- **L10. Vega documents no hardware key storage.** Wick keeps no meaningful
  secret on the television at all.
- **L11. Vega has no accessibility-preference API.** An app can't ask whether she
  prefers larger text or less motion, so Wick asks her.
- **L12. Fire TV profiles aren't available to apps,** so Wick keeps its own idea
  of who's using the television.

## 9.2 What Wick can't do

| Limitation | What I do about it |
|---|---|
| **It can't tell whether she's all right.** It knows the television went on and the door opened. | Say so plainly. Wick reduces uncertainty. It doesn't remove it, and it replaces nobody. |
| **It can't detect a fall or an emergency.** It's the first thing families ask. | Answer directly: Wick isn't a medical device. Recommend a proper alarm alongside it. |
| **It's blind when the television is off.** | A television that doesn't come on at its usual time is information too. But the limit is real. |
| **It can't know what it was never told.** | Never present a guess as fact (Principle 11). |
| **A visitor's description can be wrong.** | The picture is always shown with the sentence. The picture is the truth and the sentence is a convenience. |
| **It needs weeks to learn a house.** | Nothing is called different with fewer than three weeks of history. |
| **One resident per household.** | Two residents is on the roadmap. |

## 9.3 What the data can't say

- **A door event isn't a person.** Motion isn't proof anyone came in, so the
  words are "someone came to the door," not "Maria visited," until she confirms.
- **No events isn't the same as no data.** A camera that saw nothing may have
  been offline. Wick has to know the difference and say which.
- **Simulated data says so.** Every simulated row, week and home is marked, and
  the family app says so wherever it names the home.

## 9.4 Commercial and legal limits

| Limit | What it means |
|---|---|
| **Region** | The family pillar is US-only today, because Alexa+ is. |
| **Not a medical device** | That line shapes the product's words and features permanently. Any claim about detecting a health event changes what it legally is. |
| **Personal data** | In the UK and EU this means GDPR: lawful basis, minimisation, erasure, and a real Data Protection Impact Assessment. The design leans that way, but compliance is work. |
| **Recording law** | It varies by place, and audio is treated more strictly than video. Wick records no audio at the door. |
| **The name** | I screened "Wick" with web searches and found no conflict in home technology, care or consumer electronics. That isn't trademark clearance, which comes before any commercial use. |
| **Agencies are a second business** | Procurement, compliance and integrations are a different product from a consumer app. |

## 9.5 Limits I chose

They cost features. That's the point.

- **No indoor camera, ever,** even if a customer asks for one.
- **No clinical claims,** even if the data seems to support one.
- **No feelings reported to anyone,** even though the models could guess.
- **No monitoring without her real, informed consent that she can take back,**
  even if the family is paying.
- **No tricks to raise engagement.** The best outcome is that Sarah opens Wick
  less as she worries less.

---

# Part 10: Risks

| # | Risk | What happened, or what I'd do |
|---|---|---|
| **R1** | The door card can't appear over another app (L1). | **Partly true.** Inside Wick the card shows over the film. Over another app, Vega shows a system toast and Fire OS a notification. |
| **R2** | Alexa+ access doesn't come. | **True.** The MCP server is built to the published requirements and the family app stands in for Alexa+, saying so. |
| **R3** | Wick feels like surveillance despite everything. | The trust model is on her screen, not hidden in a document. *What Sarah sees* exists for exactly this. |
| **R4** | A resident withdraws consent. | Her absolute right, honoured at once. A one-step deletion is still to build. |
| **R5** | Live video is too slow to be pleasant. | It takes about six seconds through the bridge. If that's too slow for real use, Watch live could show the last few seconds instead. |

---

# Part 11: What else is out there

| Category | Examples | What they do | How Wick differs |
|---|---|---|---|
| **Cameras** | Ring, Nest, Wyze, elder-monitoring resellers | Motion alerts and clips to a caregiver's phone | Built for the caregiver. Wick serves her and never shows the inside of the house. |
| **Personal alarms** | Lifeline, Life Alert, pendants, watches | An emergency button, fall detection | Worn, and often in the drawer. Wick is worn by nobody. |
| **Activity sensors** | Canary Care, Just Checking, Birdie, Lively | Door and motion sensors feeding a dashboard | New hardware, a chart for the family, nothing for her. Wick uses what's already there and writes sentences. |
| **Care coordination** | CareZone, Carely, Papa | Shared calendars and notes for families | Useful to the family, invisible to her. |
| **Voice** | Alexa Together *(discontinued)*, Alexa Care Hub | Voice check-ins and activity feeds on Echo | Amazon tried voice alone. Wick adds the screen and the door. |
| **Companion devices** | ElliQ, GrandPad, Joy | A new device she has to adopt | Adoption is the whole problem. |
| **Care on the TV** | **JubileeTV** [1], **Independa** on LG TVs [2] | Family messages, calls and reminders on her TV, and an activity view for the family | **The space isn't empty.** Wick's difference is who's in control: nothing reaches her mid-scene, the family sees nothing she hasn't seen first or chosen to tell, there's no camera or microphone in the room, and no new hardware where Fire TV and Ring are already in the house. |
| **Doorbell on the TV** | **Fire TV's own Ring integration** [3] [4] | A live picture-in-picture over anything that's playing, on supported models | Amazon already does this, and over any app. Wick doesn't compete with it. It adds the plain sentence, who it probably is, *Ask Sarah to look*, and the visit she confirms. |

Sources: [1] <https://getjubileetv.com/blogs/media/jubileetv-launches> ·
[2] <https://www.independa.com/> ·
[3] <https://ring.com/support/articles/k9l04/Viewing-Your-Cameras-on-Fire-TV-with-Alexa> ·
[4] <https://www.aftvnews.com/?p=35532>. Checked October 2026, from the vendors' own pages.

None of these is bad. They all assume the caregiver is the user, and that
assumption causes the adoption problem the whole category complains about. I
think it's wrong.

---

# Part 12: The business

## 12.1 Market

- **About 16.2 million** US adults 65+ live alone (Part 1.2). They're the
  people Wick is for.
- **63 million** unpaid family caregivers in the US are the buyers.
- **Tens of thousands** of US home-care agencies are the second market.

In many of these homes the television, the doorbell and the Echo are already
there. Wick is a download and a subscription, with no hardware to sell.

## 12.2 Pricing

| Tier | Price | What's in it | Who buys |
|---|---|---|---|
| **Free** | £0 | The door card on her own television | Her, or a family trying it |
| **Family** | **£14.99 / $16.99 a month** | Everything: the week, notes both ways, confirmed visits | Sarah |
| **Starter bundle** | ~£150 once, plus the subscription | Fire TV Stick, Ring doorbell and setup | Sarah, usually in a crisis, which is when this gets bought |
| **Agency** | Per client, per month | Confirmed visits across a client list | Care agencies |

The door card is free because she has to get something before the family gets
anything. It's also the best way in: she's the one who asks to keep it.

## 12.3 Unit economics

Part 7.6 puts the cost at about $1.50–3.50 per household per month once a few
hundred households share the fixed part. At £14.99 the margin is thin at a
handful and healthy at a few hundred. The agency tier has better margins,
because confirming a visit costs almost nothing once the door events exist.

## 12.4 Route to market

1. **The Fire TV Appstore,** where a new category has little competition.
2. **The Ring Appstore,** which reaches homes that already have the doorbell.
3. **The week after a crisis,** like a fall, a hospital stay or a frightening
   phone call. That's when families look, in discharge leaflets, carer forums,
   Age UK and AARP pages, and search.
4. **Care agencies,** slower, where confirmed visits sell themselves.
5. **Amazon.** A product that makes Fire TV, Ring and Alexa+ worth more together
   is one Amazon has a reason to want.

## 12.5 What comes next

- **Months 1–3:** ten real households, none of them mine. See whether Sarah
  checks less.
- **Months 4–6:** a Fire TV Appstore listing and a first agency pilot.
- **Months 7–12:** two-resident homes, a second region, and the start of the
  evidence for the only claim that really matters: that Wick households stay at
  home longer.

---

# Part 13: How I'll know it works

I chose measures that Wick can't improve by being annoying.

| Measure | Should go | Why |
|---|---|---|
| **Cards dismissed without action** | Down | If she's waving Wick away, it's interrupting badly. This matters most. |
| **Family app opens a week** | Down | Success is Sarah worrying less, not checking more. |
| **Residents still using it at 90 days** | Up | Most products here are unplugged within a month. |
| **Door cards acted on** | Up | She finds it useful, not just tolerable. |
| **Notes replied to** | Up | The connection half works. |
| **Days with nothing shown** | Healthy, not zero | A product that speaks every day is nagging. |
| **Things she removes from *What Sarah sees*** | Watched, not optimised | Some is healthy. A spike means we're sharing the wrong thing. |
| **Doorbell press to card on screen** | Under 3 seconds | Any slower and the visitor has gone. |
| **Weeks she says are wrong** | Near zero | If she reads her own week and says "that's not right", nothing else can be trusted. |

---

# Glossary

| Term | Meaning |
|---|---|
| **Agent** | A piece of software with one job in Wick's back end. There are six, and only two call an AI model. |
| **AgentCore** | Amazon's managed service for running AI agents. Each household gets its own session. |
| **Alexa+** | The newer Alexa, which can call outside services like Wick. |
| **API** | A defined way for one program to ask another for something. |
| **Bedrock** | Amazon's service for using large AI models without running them yourself. |
| **Chime** | A Ring speaker inside the house. Wick can ring it once from the door card. |
| **Fire OS** | The older, Android-based system on most Fire TVs in homes today. |
| **Background service** | Part of an app that keeps running when the app isn't on screen. |
| **MCP** | An open standard for connecting AI assistants to outside services. It's how Alexa+ would reach Wick. |
| **Nova Lite, Claude Sonnet 4.5** | AI models on Bedrock. Nova Lite describes the door's picture. Claude writes the week and picks which tool answers a question. |
| **Polly, Translate, Transcribe, Rekognition** | Amazon's services for reading aloud, translation, speech to text, and image and video analysis. |
| **Ring Partner API** | What Ring lets approved developers do: doorbell events, pictures, live video, event history. |
| **Streamable HTTP** | The connection method Alexa+ requires from an outside service. |
| **Vega OS** | Amazon's new operating system for Fire TV. |
| **WHEP** | A standard way to receive live video from a camera. |
| **Webhook** | A message one service sends another the moment something happens. |
