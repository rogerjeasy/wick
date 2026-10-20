# Wick

**Product and business overview**

Roger Bavibidila · version 2.1 · 16 October 2026

This document explains what Wick is, who it's for, what it does today, and how
it becomes a business. How it's built is in
[`WICK-TECHNICAL.md`](WICK-TECHNICAL.md). What's real and what's simulated is in
the README's
[*What is real, and what is simulated*](../README.md#what-is-real-and-what-is-simulated).
If this document and the product disagree about behaviour, I fix the document.

---

## 1. Summary

**Wick is a Fire TV app for an older person who lives alone, and a service for
the family who worries about her.** On her television it shows who's at the
door, brings her family's notes at a moment that doesn't interrupt her
programme, and lets her answer with one button. Her family asks how she's
doing, and gets a short, honest answer that she has already seen herself.

Most care technology is built for the family member far away. I built Wick the
other way round. The person at home is the user, the television she already
watches is the screen, and she doesn't install, learn or wear anything.

| | |
|---|---|
| **User** | The resident: an older person living alone, who watches television every day. |
| **Buyer** | Her adult child or family, usually living far away. |
| **Second market** | Home-care agencies, who need proof that visits happened. |
| **Devices** | Fire TV (Vega OS and Fire OS), a Ring doorbell, and Alexa+ for the family. |
| **Price** | The door card is free. *Family* is £14.99 / $16.99 a month. Agencies pay per client. |
| **Cost to run** | About $1.55–3.75 per household a month at 300 homes, and $1.65–4.22 at 100, before live video and support (§9.2). |
| **Distribution** | The Fire TV and Ring app stores, into homes that already own the devices. |
| **Status** | Built and deployed on AWS. Tested on Amazon's simulators with a demo home. No older adult or family has used it yet, so every claim about its effect is a hypothesis (§15). |

**Why it can only be Amazon.** Wick needs a trusted screen in the room, a
doorbell with a developer API, and an assistant the family already owns. Only
Amazon has all three: Fire TV, Ring and Alexa+.

---

## 2. The problem

### 2.1 What it looks like

Sarah lives in London. Her mother Margaret, 78, lives alone two hundred miles
away. Sarah's week has a constant hum of not knowing. Did Mum eat? Did the carer
come on Tuesday? She rings on Sunday and Margaret says "I'm fine, love."

Sarah has tried three times. An indoor camera showed her an empty hallway for
eleven days before she stopped looking. A pendant alarm is in the kitchen
drawer. A tablet sits unused.

Meanwhile Margaret's television is on from four in the afternoon until eleven at
night. It's the most reliable, most trusted thing in her day. Wick starts there.

### 2.2 The numbers

| Figure | Value | Source |
|---|---|---|
| Unpaid family caregivers in the US | **63 million**, up nearly 50% since 2015 | AARP and NAC, *Caregiving in the U.S. 2025* [1] |
| US adults 65+ living alone | **about 16.2 million** (2023), **26%** of adults 65+ | Computed from US Census CPS ASEC 2023, table AD-3 [2]; Pew's reading of the ACS [3] |
| Television per day | **4.20 hours** at 65–74, **4.43 hours** at 75+ (2.6 across all ages) | BLS *American Time Use Survey*, 2025, table 11A [4] |
| Americans 65+ with Alzheimer's | **7.4 million** (2026) | Alzheimer's Association, *2026 Facts and Figures* [5] |
| US median cost of care, 2025 | Nursing home private room **$129,575 a year**, assisted living **$74,400 a year**, home caregiver **$35 an hour** | CareScout, *Cost of Care Survey* 2025 [6] |
| Adults 50+ who want to stay at home as they age | **75%** | AARP, *2024 Home and Community Preferences Survey* [7] |
| Adults 65+ who own a smartphone | **78%** | Pew, *Mobile Fact Sheet*, 2025 [8] |
| Visit verification for home care | Required by US federal law for Medicaid personal care and home health | 21st Century Cures Act §12006 [9] |

The gap between a $129,575-a-year nursing home and a monthly subscription is the
market. I don't claim yet that Wick keeps anyone at home longer, because there's
no evidence either way.

Most older adults do own a phone. My point isn't that they can't use one. It's
that the screen they already watch for four hours a day needs nothing new
learned.

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

### 2.3 Why existing products fail

1. **They're built for the wrong person.** The family gets a dashboard, and the
   person whose house it is becomes a data source.
2. **They send alerts, not understanding.** Forty motion alerts a day get muted
   within two weeks, and then the product fails silently.
3. **They ask the older person to adopt something.** A pendant, a wristband, a
   tablet. Each is a daily reminder of decline, and most go unused.
4. **They feel like surveillance.** A camera streaming someone's living room to
   their children wears away the relationship it was bought to protect.

| Usual care tech | Wick |
|---|---|
| Made for the distant caregiver | **Made for the resident** |
| A phone app | **The television** |
| Alerts and clips | **A few things that matter, and a true story** |
| She must adopt something | **She adopts nothing** |
| Indoor cameras watch her | **No indoor camera, ever** |
| Success is the caregiver checking | **Success is the caregiver needing to check less** |

---

## 3. Customers

### 3.1 The resident: Margaret, 78

**The user.** She has lived in the same house for forty-one years. She forgets
appointments, not people. She has a bad knee she plays down. Her carer comes
on Tuesday and Friday mornings. She watches television from about four and has
never installed an app.

She wants to stay in her house, not be a burden, and know who's at the door
before she gets up. She won't put up with being watched, nagged, taught or
beeped at. Every decision in Wick goes her way.

### 3.2 The buyer: Sarah, 51

**The person who pays.** She works full time, has two teenagers, and worries
about her mother at a low level all the time. She'll find Wick, pay for it and
set it up.

She doesn't want more data. She wants less worry. If Wick makes her check more
often, it has failed.

### 3.3 The second market: Maria, 44, and her agency

Maria is a carer with eleven clients, paid per visit, filling in timesheets
from memory. Her agency needs proof that visits happened when they were
claimed. In the US that's a funded legal requirement (Electronic Visit
Verification). In the UK it's a Care Quality Commission question. A door event
at 09:04 that the resident herself confirms is a better record than a
timesheet, and it needs no camera on her.

### 3.4 Who it isn't for

- **People with advanced dementia.** Wick assumes she can read a card and press
  one button.
- **Anyone who needs clinical monitoring.** Wick isn't a medical device and
  makes no clinical claims.
- **People who rarely watch television.** Everything happens on the screen.
- **Households where she hasn't agreed.** Wick needs her consent, and the
  software enforces it.

---

## 4. The product

### 4.1 What it is

Wick has three parts, and every feature belongs to one of them.

- **The door.** When someone rings, her television tells her who's there,
  without stopping her programme.
- **The family.** Her family asks how she is and gets a calm, honest answer.
  Their notes reach her television at a natural break, and she replies with one
  button.
- **The rhythm.** Wick learns what a normal week looks like in her house, so it
  stays quiet when nothing is different and can say so when something is.

Behind it, an agent reads the doorbell and the television, and a written policy
decides what the family is allowed to see. Nothing from inside the house is ever
shown to anyone.

### 4.2 A day with Wick

*This is the day Wick is designed for. In this repository the doorbell is Ring's
simulator or a stand-in, the television is a simulator, and Sarah asks in the
family app.*

**09:02.** Maria's car pulls in. The television is off and this is a normal
Tuesday, so Wick notes it and says nothing to anyone.

**09:04.** The doorbell rings and Margaret lets Maria in. Wick records a carer
visit, on time.

**14:15.** A courier rings while Margaret is in the garden. Wick keeps the event,
so later it can say "a parcel came at quarter past two."

**16:20.** In London, Sarah asks for a note to go on her mother's television.

**16:40.** The television goes on. The note waits, because Margaret is still
choosing what to watch.

**17:22.** The episode ends, and one card appears in large type:

> **A message from Sarah.**
> *The plumber is coming Thursday at ten. Love you.*
> **Thanks for letting me know!** · **I'll call you soon.** · **Not right now.**

She picks a reply and presses OK. Eleven seconds, one button. Two minutes later,
Sarah's phone shows the reply.

**19:31.** The doorbell rings during a programme. A card rises over the lower
half of the screen, and the programme waits under it:

> **Someone's at the front door.** *(a still from the doorbell)*
> *A man in a delivery uniform, holding a parcel.*
> **Watch live** · **Ring the hallway chime** · **Not now**

She rings the hallway chime so the rest of the house knows, and gets up in her
own time. When she is back, the programme is where she left it.

**Sunday, 10:00.** Sarah asks: *"How's Mum been this week?"*

> *"Steady week. The television was on most evenings, about as usual. Maria came
> both her usual days. One thing worth mentioning: a parcel came on Tuesday
> afternoon. Would you like me to put a note on her television?"*

Wick only knows the door, the television and the visits, and it doesn't guess
beyond them. Margaret read the same week on her own television first.

### 4.3 Getting started

The resident does nothing. Her family sets Wick up once:

1. Wick on her Fire TV shows a six-digit code.
2. Make an account in the family app and enter the code.
3. Margaret presses **Allow** on her own television. Nothing is shared until she
   does.

### 4.4 Try it

No account and no hardware are needed.

1. Open [her television in a browser tab](https://d2sbabcft8sm3m.cloudfront.net/tv.html).
   The keyboard is the remote: arrows move, Enter is OK, Esc is Back, Space is
   Play/Pause.
2. Open the [family app](https://dmaz25jvryojp.cloudfront.net/), choose **Try the
   demo** and enter the code on the television. You're Sarah, in a demo home with
   six weeks of simulated history.
3. Press **Allow Sarah** on the television. Then ask the family app *"How has my
   mum been this week?"*, send a note while a film plays, or press **Ring the
   stand-in doorbell**.

---

## 5. What it does today

Everything below is built and running on the deployed stack unless it says
otherwise. The IDs are used in the code and the technical document.

### 5.1 The door

| ID | Feature | What it does |
|---|---|---|
| **S1** | **The door card** | A ring puts a card on her screen with a still from the doorbell and one plain sentence about who's there. It doesn't cover the screen or make a sound; her film waits under it until she puts it away, because she may get up to answer the door. If another app is in front, Vega shows a system toast and Fire OS a notification, with a button that brings Wick forward. |
| **M1** | **Ring the hallway chime** | One button rings the Ring Chime once, so the house knows. Built and tested against Ring's contract, but not demonstrated: Ring's simulator has no chime, and the button only appears when a chime exists. |
| **M2** | **Watch live** | The doorbell camera full screen on her television, about six seconds after the press, for as long as Ring allows. |
| **M4** | **Known visitors** | The family adds regular visitors and their usual days, and the card can say *"This looks like Maria. She usually comes on Tuesdays."* |
| | **Ask Sarah to look** | One button asks the family to look at the same picture. They answer with one of three fixed sentences. |

**The hard part is not the card. It is the description.** "Motion detected" is
useless. The sentence has to be short, factual and in the present tense, and it
must never guess at intent.

Known visitors works on schedule alone, and no face is ever matched. It's an
explicitly opt-in roster of people the household added themselves, deletable
any time, never applied to strangers, never used to build a profile of anyone.

### 5.2 The family

| ID | Feature | What it does |
|---|---|---|
| **S4** | **The family line** | The family asks in plain words and gets a paragraph, not a dashboard. It runs on an MCP server, the open standard Alexa+ uses, with 25 tools, and an agent on Amazon Bedrock AgentCore that uses them with the member's own token and asks before every write. Alexa+ add-ons are partner-only for now, so the family app calls the same server and agent today. |
| **M3** | **One-button reply** | A note arrives at a natural break with three replies. Two are chosen from a fixed list of sentences I wrote, and the third is always *"Not right now."* No model ever puts words in her mouth. Back puts a note aside without answering: it waits on her home screen, and the family sees only that she has seen it. |
| **D4** | **Ask about it** | Specific questions, like "did Maria come on Tuesday?" |
| | **Hold for Sarah** | She holds OK for two seconds to ask one person to ring her. If they don't answer in three minutes, the next person is asked. |
| | **Watch together** | After her press, a family member's player follows hers for one film. |
| | **The light in the window** | The family sees one thing: whether her day has begun. She can put it out. |
| | **The mantelpiece** | The family sends pictures, checked by Amazon Rekognition. She keeps them or lets them go. |
| | **Sarah's television** | A family member connects Wick on their own Fire TV. |
| | **Visit errands** | *"The plumber is coming Thursday at ten — let Mum know."* After the member's yes, a note waits for her natural break, the door is told whom to expect, she is reminded that morning, and the member is told when the door rang or that nobody came. It never says the plumber came: only that someone rang around then. |

### 5.3 Her week, under her control

| ID | Feature | What it does |
|---|---|---|
| **S6** | **The rhythm** | Counts by weekday and hour over the last six weeks, so the week can say *"nothing unusual"* and mean it. Nothing is called different with fewer than three weeks of history. |
| **S5** | **The disclosure policy** | Every sentence to the family passes one written policy. Health, money and relationships are kept back by rule, not by a model's judgement. |
| **D1** | **Shall I tell Sarah?** | When the week really is different, Wick asks **her** first and shows the exact sentence. Only *"Tell"* lets the family read it. *"Keep it to myself"* looks to the family as if nothing happened. |
| **M5** | **The visit, witnessed** | *"Maria was here from 9:02 to 9:47. Is this right?"* Only her "Yes" confirms a visit. |
| **D2** | **What Sarah sees** | A screen on her television listing everything the family can see, with one press to take anything off. |
| | **The Sunday brief** | Her week, written by agents from counted facts and checked twice, ends with one thing the family member could do: write a note, arrange a visit, or watch a film together. She sees it first. |

### 5.4 Comfort and access

| ID | Feature | What it does |
|---|---|---|
| **S2** | **Natural breaks and calm points** | Notes wait for the credits, a pause, or a quiet cut measured in the film itself, and the film holds while she reads. Only the door may interrupt. |
| | **Read to me** | Play reads the card on screen aloud with Amazon Polly. |
| | **Easier to see** | Larger text, 40-point minimum, and 21:1 contrast on every screen. |
| | **Her language** | Spanish, once she says yes. Wick's own sentences come from a hand-written phrasebook. |
| **D6** | **When the internet goes** | The app says plainly when it can't reach Wick instead of failing silently. *Partly built.* |

### 5.5 Not built yet

| ID | Feature | Why not |
|---|---|---|
| **M6** | The week drawn as a timeline inside Alexa+ | The Alexa+ surface is partner-only. |
| **D3** | "While you were out", on request | Lower priority. |
| **D5** | Quiet hours | Lower priority. |

---

## 6. What Wick will never do

These would make a weaker product, and each is a promise to the resident.

| Never | Why |
|---|---|
| **Stream an indoor camera to the family** | The one line Wick won't cross. Ring is for the door, never for watching her. |
| **Detect falls** | Unreliable without dedicated sensors, serious when wrong, and it would make Wick a medical device. |
| **Put a chatbot on the television** | She speaks to Wick with one button, not a conversation. |
| **Give her a wellness score** | A person isn't a number out of ten. Wick writes sentences. |
| **Use streaks, badges or gamification** | No. |
| **Track where she goes** | Wick knows the front door opened, not where she went. |
| **Listen to the room** | Her television has no microphone. A family member can speak a question in their own app, and nothing is kept. |
| **Notify her phone** | Wick exists because that channel doesn't work for her. |
| **Guess her mood** | Reporting her feelings to her children is overreach dressed as care. |
| **Beep** | The quickest way to get unplugged. |

---

## 7. Design principles

These decide every contested choice in the product.

### 1. The resident is the user. The family is the customer.
Every feature has to answer "what does Margaret get from this?"

### 2. Never interrupt a scene.
Nothing that isn't urgent appears during a programme. The door is the only
exception, and it never pauses, covers or silences anything.

### 3. One button.
Everything she can do is reachable with the arrows and one OK press. No typing,
and no menu deeper than one level.

### 4. Nothing to learn.
If it needs explaining, it's wrong.

### 5. Silence is the default.
A quiet day should give a quiet product.

### 6. Three things, never four.
Three films on the home screen. Three buttons on a card.

### 7. Large, calm, still.
32-point type at least, high contrast, no fast or flashing movement, no red, no
badges, no counters.

### 8. Never nag, never score, never judge.
Wick offers once, at a good moment, and lets it go.

### 9. No time limits.
A card waits as long as it takes.

### 10. She can always see what the family sees.
It's a screen of its own, and she can remove anything on it with one press.

### 11. When Wick doesn't know, it says so.
"I'm not sure who that is" is a good answer. Making things up here would be a
betrayal.

### 12. Dignity is a requirement.
If a sentence would embarrass her to read, it doesn't ship.

---

## 8. Trust and privacy

Privacy isn't a feature of Wick. It's the reason anyone would let it in the
house.

### 8.1 Four promises

1. **No camera ever shows the inside of this house to anyone.**
2. **She can see everything the family can see,** and remove anything with one
   button.
3. **Nothing about health, money or relationships leaves the house without her
   permission.** A written policy in the software enforces this, not a model.
4. **Wick reports what was said and what happened, never what it thinks she
   felt.**

### 8.2 Who sees what

| Information | Resident | Family | Carer or agency |
|---|---|---|---|
| Who is at the door right now | **Yes** | Only when she presses *"Ask Sarah to look"* | No |
| That someone came to the door | Yes | **Yes** | Not built |
| Live video from the door | **Yes** | **Never** | No |
| Any camera inside the house | **Never captured** | **Never** | **Never** |
| Appointments | Yes | Summarised only | No |
| The household's rhythm | Yes | As narrative, never as raw logs | No |
| The weekly story | **Yes, and she sees it first** | Yes | No |
| Carer visits | Yes | Whether she confirmed them, never whether she disputed one | Not built |
| Whether her day has begun | Yes, and she can put it out | Lit or not, nothing more | No |

### 8.3 Consent

There's no real older person in this project. The household is a demo home with
simulated, marked history, and the doorbell's visitors are pictures of nobody
real. Nobody's home was recorded to make this.

In the product, nobody can read a household until the resident allows them with
one press on her own television. Before any real household uses Wick, I'll
explain in person what it captures and shares, get written consent, agree what's
off limits, and make withdrawal unconditional.

### 8.4 Data

| Question | Answer |
|---|---|
| Is anything heard in the house? | No. |
| Is video stored? | Wick keeps no copy of a door picture: the card shows Ring's own, through a short-lived link. Live video passes through short pieces that are removed when the viewing ends and deleted by the storage within about two days. Nothing is kept as a recording. |
| Who holds the Ring keys? | The cloud service, one secret per household. A stolen Fire TV Stick gets you nothing. |
| What if a family member is removed? | It takes effect on their next request. |
| What if she withdraws? | She stops Wick on her own television: *What your family sees*, reached at any time from her light on the home screen, ends with *Stop Wick*, then *Yes, delete everything*. Her home is closed at once: the doorbell disconnected, everyone in her circle taken out, every picture and record deleted. Her family's app then says plainly that she has stopped Wick. The family can download or delete their own data in the family app. |
| How long is it kept? | Door pictures and readings: a day. Family pictures: as long as she keeps them. A retention period for the timeline isn't set yet. |

---

## 9. Business model

### 9.1 Pricing

| Plan | Price | What's in it | Who buys |
|---|---|---|---|
| **Free** | £0 | The door card on her own television | Her, or a family trying it |
| **Family** | **£14.99 / $16.99 a month** | Everything: the week, notes both ways, confirmed visits, the family's own television | Sarah |
| **Starter bundle** | ~£150 once, plus Family | Fire TV Stick, Ring doorbell and setup | Sarah, usually after a crisis, which is when this gets bought |
| **Agency** | Per client, per month | Confirmed visits across a client list | Care agencies |

The door card is free because she has to get something before her family gets
anything. It's also the way in: she's the one who asks to keep it.

### 9.2 What it costs to run

An estimate from AWS list prices in us-east-1 and the deployed setup.

**Fixed, whatever the number of households:**

| Item | Per month |
|---|---|
| App Runner (the Wick server, 1 vCPU / 2 GB, always on) | **$10–57**, depending on load |
| CloudFront, S3, API Gateway, IoT Core, logs, shared secrets | ~$5–15 |

**Per household:**

| Item | Per month |
|---|---|
| Ring link secret | $0.40 |
| Weekly story (Claude Sonnet 4.5) | ~$0.10 |
| Family questions (Claude Sonnet 4.5) | ~$0.50–2 |
| Door events (Lambda, AgentCore, Nova Lite) | ~$0.10–0.50 |
| DynamoDB, Polly, Translate, Rekognition, Transcribe | <$0.50 |
| Live video relay | Only while someone watches; not counted here |
| **Rough total** | **~$1.50–3.50** |

The fixed part is $15–72 a month in all. So:

| Households | Per month, in all | Per household |
|---|---|---|
| 10 | $30–107 | $3.00–10.70 |
| 100 | $165–422 | $1.65–4.22 |
| 300 | $465–1,122 | $1.55–3.74 |

None of this counts the live video relay, support or installation help, which
are not measured yet. They are the first costs a pilot has to measure.

### 9.3 Unit economics

At £14.99 a month, the margin is thin at a handful of households and healthy at
a few hundred. The agency plan has the best margin, because confirming a visit
costs almost nothing once the door events already exist.

---

## 10. Market and go-to-market

### 10.1 Market

- **About 16.2 million** US adults 65+ live alone. They're the users.
- **63 million** unpaid family caregivers in the US are the buyers.
- **Tens of thousands** of US home-care agencies are the second market.

In many of these homes the television, the doorbell and the Echo are already
there. Wick is a download and a subscription, with no hardware to sell.

### 10.2 Why Amazon

| Platform | Screen | Doorbell API | Assistant | Could run Wick? |
|---|---|---|---|---|
| **Amazon** | Fire TV | **Ring** | **Alexa+** | **Yes** |
| Google | Google TV | Nest (limited) | Gemini | No |
| Apple | Apple TV | None | Siri | No |
| Roku | Roku | Roku Cameras (no third-party API) | None | No |
| Samsung | Tizen | SmartThings (partial) | Bixby | No |

A product that makes Fire TV, Ring and Alexa+ worth more together gives Amazon a
reason to want it in the home.

### 10.3 How it reaches people

1. **The Fire TV Appstore,** where a care app has little competition.
2. **The Ring Appstore,** which reaches homes that already have the doorbell.
3. **The week after a crisis,** such as a fall, a hospital stay or a worrying
   phone call. That's when families look: discharge leaflets, carer forums, Age
   UK and AARP pages, and search.
4. **Care agencies,** a slower channel where confirmed visits sell themselves.

---

## 11. Competition

| Category | Examples | What they do | How Wick differs |
|---|---|---|---|
| **Cameras** | Ring, Nest, Wyze, elder-monitoring resellers | Motion alerts and clips to a caregiver's phone | Built for the caregiver. Wick serves her and never shows the inside. |
| **Personal alarms** | Lifeline, Life Alert, pendants, watches | An emergency button, fall detection | Worn, and often in the drawer. Wick is worn by nobody. |
| **Activity sensors** | Canary Care, Just Checking, Birdie, Lively | Sensors feeding a family dashboard | New hardware, nothing for her. Wick uses what's there and writes sentences. |
| **Care coordination** | CareZone, Carely, Papa | Shared calendars and notes for families | Useful to the family, invisible to her. |
| **Voice** | Alexa Together *(discontinued)*, Alexa Care Hub | Voice check-ins on Echo | Voice alone. Wick adds the screen and the door. |
| **Companion devices** | ElliQ, GrandPad, Joy | A new device she has to adopt | Adoption is the whole problem. |
| **Care on the TV** | **JubileeTV** [1], **Independa** on LG TVs [2] | Family messages, calls and reminders on her TV, plus an activity view | **The closest rivals.** Wick's difference is who's in control: nothing reaches her mid-scene, the family sees nothing she hasn't seen or chosen to tell, there's no camera or microphone in the room, and no new hardware. |
| **Doorbell on the TV** | **Fire TV's own Ring integration** [3] [4] | A live picture-in-picture over anything playing | Wick doesn't compete with it. It adds the plain sentence, who it probably is, *Ask Sarah to look*, and the visit she confirms. |

Sources: [1] <https://getjubileetv.com/blogs/media/jubileetv-launches> ·
[2] <https://www.independa.com/> ·
[3] <https://ring.com/support/articles/k9l04/Viewing-Your-Cameras-on-Fire-TV-with-Alexa> ·
[4] <https://www.aftvnews.com/?p=35532>. Checked October 2026.

They all assume the caregiver is the user. That assumption causes the adoption
problem the whole category complains about, and it's the bet Wick makes against
them.

---

## 12. How it's built

The full design is in [`WICK-TECHNICAL.md`](WICK-TECHNICAL.md). In short:

- **The television shows and never decides.** It holds no secrets, so a cheap
  device in someone's front room is never a risk.
- **Agents do the thinking,** in the cloud, and keep working while the
  television is off. Small agents each have one job: Door, Narrator, Tell,
  Visit, Reach, and the Guardian, which enforces the policy on everything that
  leaves the house. Three of them use AI models, on Amazon Bedrock AgentCore:
  the Door, the family's assistant (which calls Wick's own tools with the
  member's token and asks before every write), and the Sunday brief's graph.
- **Every answer comes from data already counted.** The assistant's model
  chooses which tools to ask and the words; the facts are the tools', and a
  number the tools did not give is refused.

| Layer | Technology |
|---|---|
| **Television** | Vega OS with React Native, a background service for the door, media controls, and the same app on Fire OS through four small adapters |
| **Door** | Ring Partner API: webhooks, recorded frames, live view, the Chime |
| **Family** | An MCP server for Alexa+, and a family app that uses it today |
| **Agents** | Amazon Bedrock (Nova Lite, Claude Sonnet 4.5) behind a Bedrock Guardrail; AgentCore Runtime with Strands agents and graphs; AgentCore Memory for the assistant's conversations; Step Functions for visit errands |
| **AWS** | Lambda, API Gateway, IoT Core, EventBridge and Scheduler, App Runner, DynamoDB, S3, CloudFront, Secrets Manager, Cognito, Rekognition, Polly, Translate and Transcribe, all in Terraform |

---

## 13. Where it stands today

### 13.1 Real and simulated

There's no Fire TV hardware, Ring doorbell or real resident in this project.

| | Today |
|---|---|
| **Television** | The Vega Virtual Device, the Fire OS build on the Android TV emulator, and a browser version anyone can open |
| **Doorbell** | Ring's Developer Playground behind Ring's real API, plus a labelled stand-in doorbell, because the Playground sends no doorbell events |
| **Alexa+** | The family app, calling the real MCP server |
| **Household** | A demo home with six weeks of simulated history, marked everywhere |
| **Everything in between** | Real and deployed: the AWS stack, the agents and models, the policy, accounts and pairing |

### 13.2 Measured

| Measurement | Result |
|---|---|
| Doorbell to door card | 2.3 s median, on the stand-in doorbell |
| Door card to its picture | 2.7 s median |
| The family line on an open connection | 230–241 ms p95, against Alexa+'s 500 ms target |
| The family line on a new connection | 0.7–1.1 s, because App Runner closes idle connections |
| Automated tests | About 6,500, all passing, with the television's screens rendered |
| Launch to fully drawn, Vega | 722 ms mean over 10 cold starts, on the Vega Virtual Device |
| Memory on her home screen, Vega | 64 MiB PSS, on the Vega Virtual Device |

### 13.3 Limitations

- **Over other apps.** No app can draw over another app on Vega or Fire OS, so
  Wick's cards appear only while Wick is on screen. When she is watching
  something else, only the door interrupts: a system toast on Vega, a heads-up
  on Fire OS. A note waits. On Fire OS it waits quietly in the Notification
  Center, never over her programme; on Vega it waits in Wick. Either way it is
  on her screen the moment she opens Wick.
- **Alexa+ is partner-only and US-only.** The server is ready the day access
  opens, with no changes.
- **Ring's API has no two-way talk.** She can't speak to a visitor from her
  armchair. The Chime tells the house instead.
- **Wick can't tell whether she's all right.** It knows the television went on
  and the door opened. It reduces worry. It doesn't replace anyone, and it isn't
  an alarm.
- **It's blind when the television is off,** although a television that doesn't
  come on at its usual time is information too.
- **It needs about three weeks to learn a house** before it calls anything
  different.
- **One resident per household** for now.

Each platform limit, with what I tried and what I'd ask Amazon to change, is in
[`FRICTION.md`](../FRICTION.md) and [`PRODUCT-FEEDBACK.md`](PRODUCT-FEEDBACK.md).

---

## 14. Risks

| # | Risk | Where it stands |
|---|---|---|
| **R1** | The door card can't appear over another app. | **Partly true.** Inside Wick it shows over the film. Over another app, Vega shows a system toast and Fire OS a notification. Everything else, including the timing of notes at a calm point, works only while she watches in Wick, which plays three open films today. Bringing that to the programmes she already watches needs a content or player partnership. |
| **R2** | Alexa+ access doesn't come. | **True for now.** The family app calls the same server and says what it is. |
| **R3** | Wick feels like surveillance anyway. | The trust model is on her screen, and *What Sarah sees* exists for exactly this. |
| **R4** | Not a medical device, and must stay that way. | Wick makes no clinical claims, and its words and features are kept to that line. |
| **R5** | Personal data rules in the UK and EU. | The design already minimises data. A full GDPR review and impact assessment come before any launch there. |

---

## 15. What's next

Nothing below has happened yet. Wick has not been used by an older adult or a
family, so whether the family checks less, whether a resident understands what
she is consenting to, and whether she keeps using it are open questions. The
first thing to do is small and observed: a few resident and family pairs set it
up, answer the door, consent and take it back, while someone notes what they
finish alone, where they get stuck, and whether they would keep it.

### 15.1 The next twelve months

- **Months 1–3:** ten real households, none of them mine. Measure whether the
  family checks less.
- **Months 4–6:** a Fire TV Appstore listing and a first agency pilot.
- **Months 7–12:** two-resident homes, a second region, and the first evidence
  for the claim that matters most: that Wick households stay at home longer.

### 15.2 On the roadmap

- **Two residents in one home,** each with their own rhythm and policy.
- **Per-person policies** for siblings who are involved differently.
- **An agency portal** for confirmed visits across a client list.
- **Echo Show** as a second, smaller screen in the kitchen.
- **More languages,** each with its own hand-written phrasebook.

### 15.3 How I'll know it works

These measures can't be improved by being annoying.

| Measure | Should go |
|---|---|
| Cards dismissed without action | Down |
| Family app opens a week | Down, because the family worries less |
| Residents still using it at 90 days | Up |
| Door cards acted on, notes replied to | Up |
| Days with nothing shown | Healthy, not zero |
| Doorbell press to card on screen | Under 3 seconds |
| Weeks she says are wrong | Near zero |

---

## About the name

*Wick* is a Northern English word for **alive**, from the same root as "quick"
in *the quick and the dead*. It's also the thread that carries a candle's flame,
and an old word for a home, as in Norwich and Warwick. Products in this space are
named for decline, like *Care*, *Guardian* or *Alert*. Margaret isn't a patient.
She's 78, she's in her own house, and she's wick.
