# sim-alexa — the simulated Alexa+ surface

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
2. takes a question from a suggestion chip or the text field and routes it to
   one of six tools (`get_week_narrative`, `get_today`, `did_visitor_come`,
   `send_note_to_tv`, `get_replies`, `get_resident_shared_view`) with a
   handful of rules — deliberately not a model, so it cannot invent an answer.
   When nothing matches, it says what it can do;
3. answers the way an assistant around an add-on does: **one sentence that
   stands alone spoken** (voice-only is the guide's baseline; "Speak answers"
   reads it aloud), then **at most one card** — a list with "See all" past
   four rows, a confirmation, or the note form with one final action;
4. shows a refusal as what it is. "Kept private" and "Not yet" are answers,
   in the server's own words, never an error.

`surface.js` holds the routing and the sentence-and-card logic with no DOM and
no network, and is tested (`__tests__/surface.test.ts`). `main.js` is the OAuth
and MCP client and puts the result on the page.

**The point.** The server is the real artefact. This is a client. If Alexa+ access
ever opens, this directory becomes redundant and **not one line of the server
changes** — which is the whole reason for building to the published spec rather
than to whatever is convenient.

Build after `services/mcp-server` answers correctly from MCP Inspector.
