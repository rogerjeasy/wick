# sim-alexa — the family app, with a simulated Alexa+ conversation

**It is also the family's app now.** A person signs in (or creates an account
with an email and a password) on the Wick server's own pages, and this page
then holds a link to that account: who is in the family circle, an invitation
link to send, and "Connect a television" for the six-digit code. Opened with
`?invite=<code>` it joins a circle; with `?pair=<code>` (the link on the
television's pairing screen) it connects that television. Someone the person
at home has not allowed yet is told so, and shown nothing (AGENTS.md INV-9).

**Try the demo.** Where the server allows it (`demo_accounts` in
`infra/variables.tf`, on for the hackathon), the link card has a second
button. One click makes an anonymous guest account and a demo home — no
email, no password, no code — and comes straight back. A guest is held to
the same rules as anyone: they see nothing until the demo home's television
has said Allow, and the "Connect a television" card links to a virtual
television in a browser tab for anyone with no Fire TV to hand
(`services/mcp-server/src/accounts/demo.ts`).

**The first screen.** Signed out it says what Wick is in one sentence, with
*Try the demo* first and *Sign in* second. Signed in with something left to
set up, a short checklist says what to do next and ticks itself off from the
server's own answers: her television connected, her Allow on the Circle card,
a first question asked (`presentChecklist`). The address of the Wick server is
a developer's business: the field is shown only when the page is opened with
`?dev` (on a laptop it still defaults to `http://127.0.0.1:3300`).

To try the whole journey with no AWS:
`npx vite-node -c vitest.config.ts services/mcp-server/src/__tests__/devServer.ts`

**Wick's listing.** Before sign-in the page shows Wick as an add-on would be
listed: its icon, name, what it is for, three things to say, and that enabling
it links an account. All of it is read from `addon.json`, the package Amazon's
toolkit would be given (`addon-package/`), published beside this page — and the
server the page links against is the one that file names. The listing is
labelled as simulated, and every phrase it shows is held by a test to one that
the page answers.

**Why this exists.** The Alexa+ MCP Toolkit is restricted to select partners with
no published application path (see `FRICTION.md` FL-001), so Wick cannot register
a real add-on. The hackathon rules explicitly permit an alternative:

> *"Alternatively, entrants may submit a simulated Alexa+ experience instead —
> built using any AI or agentic tool of their choice, no specific framework, SDK,
> or MCP-shaped surface required."*

**What this is not.** A fake Echo. The demo must never present this as a real
Alexa+ integration — doing so would be worse than not showing it at all. One line
on screen stating that the add-on surface is partner-gated and this is the
permitted alternative costs three seconds and buys credibility.

**What it does.** A small web surface, styled to Amazon's Alexa+ add-on design
guide (its card and button tokens, spacing scale, radii, and the 1.6x far-field
type scale), that:

1. speaks to the **real** MCP server in `services/mcp-server` over Streamable
   HTTP, spec 2025-11-25, after a real OAuth 2.1 link — no shortcuts, no direct
   database reads;
2. takes a question from a suggestion chip or the text field and lets a
   **model choose** among Wick's twenty-two tools (`get_week_narrative`,
   `get_today`, `get_whats_different`, `did_visitor_come`, `get_visits`,
   `list_regular_visitors`, `add_regular_visitor`, `expect_visit`,
   `send_note_to_tv`, `get_replies`, `get_resident_shared_view`,
   `get_door_request`, `answer_door_request`, `invite_to_watch`,
   `get_watch_together`, `join_watch_together`, `answer_watch_together`,
   `withdraw_watch_invitation`, `get_light`, `get_reach_request`,
   `answer_reach_request`, `get_pictures`). The model
   runs on the Wick server (`services/mcp-server/src/assistant`, Bedrock
   Converse) and only decides: **this page makes every call itself, over
   MCP, with the signed-in person's own token**, so the model can reach
   nothing they could not. One question can take several tools — "I'm coming
   on Saturday at three, let Mum know" tells the door and puts a note on the
   television;
3. keeps the model to the facts. A reply whose numbers are not in the tools'
   answers is sent back once with the reason, and after that the page says
   the tools' own sentences. Anything that writes — a note, an announced
   visit — is **shown and confirmed first**. Where the server has no model,
   or it is busy, the page answers by a handful of rules instead
   (`routeUtterance`): it never goes silent and never makes an answer up;
4. answers the way an assistant around an add-on does: **one sentence that
   stands alone spoken** (voice-only is the guide's baseline; "Speak answers"
   reads it aloud), then **the cards the answer earned**, in the guide's
   vocabulary — a header, the primary text, the picture where the tool
   returned one, at most three actions: a list with "See all" past four
   rows; the week as its paragraph, its measures against a usual week, and a
   **carousel of its days** (only the days its timeline has something on,
   five inline, "See all" for the rest); the door with its picture, the
   vision model's sentence and the three answers; a confirmation — and a
   line saying, in plain words, what was done to answer;
5. shows a refusal as what it is. "Kept private" and "Not yet" are answers,
   in the server's own words, never an error.

**Ask by voice.** The microphone beside the field takes one spoken question,
ten seconds at most: press to start and again to stop (or hold it, and let
go). The page brings the sound to 16 kHz, 16-bit PCM itself and sends it to
the Wick server's `POST /api/hear`, which has Amazon Transcribe turn it into
words; the words go into the field and are asked as if typed. The microphone
is asked for on the first press, and let go of when the question ends;
nothing is recorded or kept. Where the browser has no microphone to offer,
the button is not shown. Not the browser's own speech recognition, which
sends the sound elsewhere.

`surface.js` holds the routing and the sentence-and-card logic with no DOM and
no network, and is tested (`__tests__/surface.test.ts`); `voice.js` does the
same for the sound of a question (`__tests__/voice.test.ts`). `main.js` is the
OAuth and MCP client and puts the result on the page.

**The point.** The server is the real artefact. This is a client. If Alexa+ access
ever opens, this directory becomes redundant and **not one line of the server
changes** — which is the whole reason for building to the published spec rather
than to whatever is convenient.

Build after `services/mcp-server` answers correctly from MCP Inspector.

**Watching a film together.** "Ask Mum to watch a film with me" sends an
invitation to the television (`invite_to_watch`); the answer is kept on the
server, so "Did Mum say yes to the film?" works on any later day. At the
arranged time this page offers a seat: a player with no pause and no skip,
kept where the television's player is (`get_watch_together`, asked every two
seconds while the seat is taken). The film plays through hls.js, loaded from
jsDelivr only when a seat is taken, pinned to one version and checked against
a hash; where that cannot run, the browser's own HLS is used. The following
itself is `follow` in `surface.js`, and is tested there.

To try it with no television: `GET http://127.0.0.1:3300/dev/watch?press=accept`
says yes as the resident, `?press=start` starts the film once you have sat
down, and `?player=pause`, `play`, `seek&to=<ms>` and `stop` work the
stand-in television's player. `?press=loved_it` answers the question at the
credits.
