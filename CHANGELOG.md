# Changelog

Wick's releases. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [1.2.1] — 2026-10-20

What an outside review and an end-to-end run on the Vega Virtual Device and
the Fire OS emulator found, fixed (#153–#159).

### Her television (Vega OS and Fire OS)

- **The Vega Virtual Device can be paired by anyone.** Every simulator has
  the same id, and the demo home that paired one last held them all: a fresh
  install opened in somebody else's home with no code. That hold now lapses
  twelve hours after the pairing, a demo home can bring the simulator in from
  the family app with no code on its screen, and the simulator and its
  background service follow it there without a relaunch.
- **The door says who is due, never who has come.** "Ask Sarah to look" stays
  when a visitor is expected; "Maria is expected around now", never "This
  looks like Maria"; "Sarah arranged a visit for about now". Somebody seen who
  did not ring is not taken for the visitor, nor counted as a caller.
- **What your family sees:** *Next* is the first button, where the focus
  starts, so paging on never changes what is shared.
- **Stop Wick** says so when it could not be done, instead of nothing.

### The family app and the agents

- A ring when Maria was expected is "Someone came to the door when Maria was
  expected"; only a visit she confirmed on her television says Maria came.
- One line for one moment at the door; today's list newest first.
- Absence is said only where the doorbell was heard: unheard days are named,
  and never called quiet.
- The assistant's true replies are no longer refused by the Guardrail;
  "not yet" ends with the visitor's usual time; a note keeps the member's own
  words for a time.
- The Guardian catches a street address ("at 12 Broadway"); the door's
  sentence is checked for injected text, and measured
  ([docs/evals/door-descriptions.md](docs/evals/door-descriptions.md)).
- A television that keeps no secret joins only a demo home.

### Installing

- **Fire OS:** signed with Wick's release key, as 1.2.0 was, so it installs
  over 1.2.0 in place. The release workflow now refuses an APK signed with
  any other key. From 1.1.0 or earlier (signed with a debug key), uninstall
  first: `adb uninstall com.wick.tv`.
- **Vega:** `vega run-app wick-vega-1.2.1-<arch>.vpkg com.wick.tv.main`.

## [1.2.0] — 2026-10-20

The redesign: one design system for her television, the browser television,
the family app and the project pages ([docs/design/DESIGN.md](docs/design/DESIGN.md)).

### Her television (Vega OS and Fire OS)

- **One meaning per key.** Play over a card reads it aloud, and the next Play
  stops the reading. It never moves the film: the film goes on when she
  answers the card or puts it aside with Back.
- **The film's bar.** Title, time gone of the whole, minutes left and a
  progress line. It comes on ↑ or ↓, a pause or a skip, and goes after four
  seconds of play. ↑ and ↓ were dead keys over a film before.
- **Holding OK shows itself.** From 0.4 s a line fills to the two seconds, with
  what holding will do. Let go early and nothing happens at all.
- **Home adapts to her.** A film she stopped part-way comes first, marked
  *Carry on* with the minutes left; then what she watches most at this time
  of day. Counted on the television, never guessed, never sent.
- **How Wick works.** A tour from the home screen, with only the remote: an
  example of the door, a note, holding OK and reading aloud, each marked
  *Example*. Nothing in it is sent.
- **Calm motion and icons.** Cards rise in over 200 ms and fade out over 150 ms
  over a scrim; the focused tile grows a little; Lucide icons, rendered to
  images at build time, beside the words. Reduced motion makes all of it
  instant. No native module was added, so Fire OS builds from the same source.

### Her television in a browser

- Says on screen that it is a stand-in for her Fire TV.
- A remote drawn beside the screen, so it works on a phone or a tablet; holding
  its OK is Hold for Sarah.
- The same bar, hold line, home order and tour as the Vega app.
- A parity test draws every card with the Vega app's own components and with
  the browser's, in English and Spanish. It found and fixed drift: labels Vega
  never shows, two wrong headlines, a missing door line and two orders.

### The family app

- From 1024 px, two columns: the conversation, and a panel about her home
  (her light, her televisions, who is expected, her circle).
- Suggestions are one row and a *More* sheet; nothing overflows from 320 px
  to 2560 px.
- Waiting says what it is doing, and every press answers at once.
- Atkinson Hyperlegible Next, Lucide icons, Motion and Open Props, all served
  from the app itself.

### Also

- The project pages restyled; their tool and feature counts are held to the
  code and the README by a test.
- The README shows eight screenshots of the core features, captured live.
- Since 1.1.0: a time counted from now is worked out, not refused (#125); a
  television's event is dated by the edge's clock (#126); her day opens the
  home screen (#133, #134); a lost connection is noticed, and the browser
  television reaches home through IoT Core (#135); the Fire OS release APK is
  signed with a release key (#136); the Guardian reads names in other scripts
  and role words with marks inside (#138, #140); the deploy role is narrowed,
  with spend budgets, per-route limits and a spend brake (#139); a demo test
  no longer fails for an hour every Tuesday (#142).
- Versions: Vega 1.2.0 (build 3); Fire OS 1.2.0 (version code 3), the first APK
  that can update an earlier one in place.

## [1.1.0] — 2026-10-18

- **Each home keeps its own time zone**, given when it is set up; a demo home
  runs on the guest's own clock.
- **Production's health report is no longer public.**
- **"Shall I tell Sarah?" starts on "Keep it to myself"**, which is also what
  Back does.
- **Notes say their time as a clock time**, and the third reply fits the note.
- **A visit errand's card turns to "Someone rang" by itself.**
- **The week's suggestion** says the thing to do, with its reason under it.
- Back on a note puts it aside, the family is told she has seen a note, her
  home can be closed from the television, and she can share from her home
  screen (PRs #97–#124).

## [1.0.0] — 2026-10-17

The first release: Wick, complete and deployed, as submitted to Build, Ship,
Shape (Fire TV track; AWS Builder and Open Source mini challenges). Built from
14 September 2026 in about a hundred pull requests.

### The product

- **Her television**, on Vega OS and on Fire OS from the same source, and in a
  browser tab for anyone without either:
  - a home screen and the player;
  - cards she answers with one button;
  - a background service that brings the door to her over other apps (a system
    toast on Vega, a notification on Fire OS).
- **Three pillars:**
  - the door: a card in about two seconds, then the picture and one sentence;
  - the family: notes that wait for a natural break, and honest answers;
  - the rhythm: what a normal week looks like in this house.
- **Fourteen features** on top: Ask Sarah to look, Shall I tell Sarah?, calm
  points, Watch together, the light in the window, Hold for Sarah, the visit
  witnessed, Sarah's television, her language, the mantelpiece, Read to me,
  Easier to see, visit errands, and the Sunday brief.
- **The family app**, standing in for Alexa+:
  - a real MCP server with 25 tools (spec 2025-11-25, OAuth 2.1);
  - accounts, a family circle she controls, Web Push;
  - a demo home with six weeks of simulated history.

### The agents

- The door's Strands graphs on **Bedrock AgentCore Runtime**, one microVM per
  household.
- The **family assistant**:
  - a Strands agent that calls Wick's own MCP tools with the member's token;
  - a yes from the member before every write;
  - its conversations kept in **AgentCore Memory**.
- **Visit errands**, run for days as one **Step Functions** execution each.
- **The Sunday brief**, a Strands Graph written from counted facts, fanned out
  over **SQS**.
- A **Bedrock Guardrail** reads what the agents say, grounded in what the tools
  returned. The Guardian, Wick's deterministic content gate, checks every
  sentence the family reads.

### Open source

- [`vega-calm-ui`](https://www.npmjs.com/package/vega-calm-ui) on npm: the
  accessible 10-foot components every card is drawn with, published with
  provenance through trusted publishing.
- [aws/bedrock-agentcore-sdk-typescript#287](https://github.com/aws/bedrock-agentcore-sdk-typescript/pull/287):
  AgentCore Memory session storage for Strands TypeScript. Its integration
  tests pass against a real memory.
- [AmazonAppDev/react-native-multi-tv-app-sample#135](https://github.com/AmazonAppDev/react-native-multi-tv-app-sample/pull/135):
  accessibility settings for Amazon's multi-TV sample.

### Known limits

- Not yet seen on real hardware: a Fire TV, a Ring doorbell, or a spoken "Alexa,
  pause". Ring's Developer Playground sends no webhooks, so demo homes use a
  labelled stand-in doorbell (FL-027).
- The Alexa+ add-on surface is partner-only, so a simulated Alexa+ app calls the
  real MCP server (FL-001).
- The Guardrail's grounding does not check which person came on which day
  (FL-048).
- 44 friction entries in [FRICTION.md](FRICTION.md), with feature requests in
  [docs/PRODUCT-FEEDBACK.md](docs/PRODUCT-FEEDBACK.md).
