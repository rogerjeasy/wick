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

**What it does.** A small web surface that:

1. speaks to the **real** MCP server in `services/mcp-server` over Streamable
   HTTP, spec 2025-11-25 — no shortcuts, no direct database reads;
2. offers five fixed buttons, one per tool it exercises (`get_week_narrative`,
   `get_today`, `did_visitor_come`, `send_note_to_tv`, `get_replies`) — no voice
   or free-text *question* input; four buttons take no input at all, and
   `send_note_to_tv` has a plain from/message form, not a spoken query;
3. displays each tool's raw JSON (or text) response verbatim in a `<pre>`
   block — **except two**, which render as panels:
   - `get_week_narrative` (M6): the Narrator's prose first, then the timeline
     it was built from (`renderWeekPanel()`). Until the resident has seen the
     week on their own television (INV-7), the server withholds it and says
     why, and that sentence shows as plain text.
   - `get_replies` (M3): each note sent to the television, with the
     resident's one-button reply under it, or "No reply yet."
     (`renderReplies()`).

   Both render client-side only, with no shortcut into the database.

**The point.** The server is the real artefact. This is a client. If Alexa+ access
ever opens, this directory becomes redundant and **not one line of the server
changes** — which is the whole reason for building to the published spec rather
than to whatever is convenient.

Build after `services/mcp-server` answers correctly from MCP Inspector.
