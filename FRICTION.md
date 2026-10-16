# Friction Log

Developer-experience friction encountered while building Wick on Amazon Devices,
Ring, Alexa+ and AWS.

40 entries, FL-001 to FL-044, newest first, each written when the problem was hit.
There is no FL-020, FL-034, FL-037 or FL-039: those numbers were set aside for
work running in parallel and not needed. The same
problems, gathered by tool with what worked well beside them, are in
[docs/PRODUCT-FEEDBACK.md](docs/PRODUCT-FEEDBACK.md).

Every entry needs all six fields. Severity: `Critical` / `Important` / `Nice-to-have`.

---

## Template

```
## FL-000 — <one-line title>

**Tool / API:**      <e.g. Vega OS 1.2 / @amazon-devices/headless-task-manager 1.2.8>
**Task attempted:**  <what you were trying to do>
**Steps taken:**     1. …
                     2. …
**Expected:**        <what the docs led you to expect>
**Actual:**          <what happened>
**Severity:**        Critical | Important | Nice-to-have
**Workaround:**      <what you did instead, or "none — blocked">
**Suggestion:**      <specific, actionable change you would make to the platform>
```

---

## The spikes these entries refer to

Before building, eight questions were set as spikes (SP-1 to SP-8, docs/WICK-TECHNICAL.md §14).
Four were answered, and the entries below cite them:

- **SP-1** Rendering over active playback on Vega — **yes.** A DOOR card composited by
  the app over its own `w3cmedia` HLS playback on the VVD (2026-10-01): legible, playback
  uninterrupted. Over *another app's* playback there is still no overlay for a card —
  but a system toast can be put there, from a service the app starts: FL-022.
- **SP-2** Ring snapshot latency (`POST /media/image/download`) — **3.15s** end to end
  (0.8s to the 303, ~2.3s to pull 106KB). And it is not a snapshot: see FL-005.
- **SP-3** Ring WHEP session negotiation and limits on Vega — **WHEP works; Vega can't be
  the client.** Relay-held token, Ring answers 201 in ~1.5s, 1280x720 H.264 live in desktop
  Chromium in 5.6s. Vega has no WebRTC package and its WebView segfaults on the VVD
  (FL-015), so Watch Live bridges WHEP to HLS in the cloud; the bridge produced its first
  playlist 6.8s after the request. Cleartext HLS is refused silently (FL-016).
- **SP-5** WebSocket / MQTT transport inside Vega's RN 0.83 fork — **both work, on the
  simulator.** `mqtt.js` 5.16 over WSS connects to IoT Core from the Vega Virtual Device
  with no change to the library; cards come down and replies go up; with MQTT refused
  the app is on the WebSocket instead (2026-10-11). The four-hour run on hardware was
  never possible: FL-009, and its update.

Three were never run: SP-4 (Alexa+ add-on onboarding — the toolkit is partner-gated, FL-001),
SP-7 (a Content Personalization round trip to Continue Watching) and SP-8 (a real Fire TV
Stick — there was no hardware, FL-009). SP-6 (a Bee wearable stream) went when Bee was
removed from the design (2026-10-02).

## Entries

<!-- Newest first. -->

## FL-047 — A Strands TypeScript Graph cannot loop back to a node that has an edge from outside the loop

*2026-10-16.*

**Tool / API:**      Strands Agents SDK for TypeScript 1.18.0 (`@strands-agents/sdk`, `Graph` in
                     `multiagent/graph.js`); structured output (`structuredOutputSchema`, zod 4)

**Task attempted:**  The Sunday brief as a Graph: analyst → writer → check, with the check sending a
                     refused draft back to the writer once, with the reason, before the suggester
                     (services/agent/src/graphs/weeklyBrief.ts).

**Steps taken:**     1. Built the obvious edges: analyst → writer, writer → check, check → writer
                        (conditional, "retry"), check → suggester (conditional, "done").
                     2. The run stopped after the analyst. Read `_findReady` and
                        `_allDependenciesSatisfied`: a node runs only when every incoming edge's
                        source has COMPLETED and every edge handler is true. The writer's incoming
                        edges are the analyst's and the check's; the check cannot have completed
                        before the writer's first run, so the writer never runs.
                     3. The class comment says so ("AND semantics … Python uses OR"), and that the
                        TS Graph supports cycles (`maxSteps`), but no example shows a cycle with an
                        entry edge, and the graph does not warn that one can never start.
                     4. Made the loop's entry a declared source: `sources: ['analyst']`, edges
                        analyst → writer → check → analyst. The analyst keeps what it counted and,
                        on its second visit, hands the writer the same facts with the reason.

**Expected:**        A conditional back-edge into the writer, as in the Python SDK's
                     `GraphBuilder` with OR semantics, or a construction-time error for a node that
                     can never become ready.

**Actual:**          The graph runs its source and finishes quietly with every other node pending:
                     no error, no warning, a result whose status is COMPLETED.

**Severity:**        Important

**Workaround:**      The cycle enters through a declared source node; the retry passes back
                     through it. Tested end to end with a scripted model (the retry path appears in
                     the run's node order). Structured output needed no workaround: the agent
                     node's `structuredOutput` is on its NodeResult, read in the next node.

**Suggestion:**      Either an edge option for OR (`{ source, target, any: true }`), or a check at
                     construction that every node is reachable under AND semantics, naming the
                     node that can never start. And one example of a refine-and-retry loop in the
                     multi-agent docs, which is the commonest loop there is.
## FL-046 — A Strands agent built per request: interrupts, sessions and memory each assume one long-lived agent

*2026-10-16.*

**Tool / API:**      Strands Agents TypeScript SDK 1.18 (`@strands-agents/sdk`: `BeforeToolCallEvent.interrupt`,
                     `SessionManager`, `MemoryManager`); `bedrock-agentcore` 0.4.5
                     (`experimental/memory/strands` `AgentCoreMemoryStore`); AgentCore Memory namespaces

**Task attempted:**  Run the family assistant as one Strands `Agent` per AgentCore invocation (it must
                     be built with the member's own token on its `McpClient`), pausing before every
                     write for the member's yes and resuming in the next invocation, with the
                     conversation in a `SessionManager` and the member's words in AgentCore Memory.

**Steps taken:**     1. Raised an interrupt from `BeforeToolCallEvent` for every tool whose MCP
                        `readOnlyHint` is not `true`, and resumed with `InterruptResponseContent` in a
                        new agent restored by the `SessionManager`. This works across processes: the
                        pending tool call is in the snapshot (services/agent/src/agents/assistant/turn.ts).
                     2. Asked a new question while a write was waiting: the agent throws ("Agent is in
                        an interrupted state"). There is no public way to drop a pending interrupt.
                        Answering "no" with `limits: { turns: 1 }` closes it without a model call, but
                        leaves the conversation ending on a tool result, so the next question makes two
                        user messages in a row, which Bedrock's Converse refuses.
                     3. Restored a session: `loadSnapshot` also restores the saved system prompt,
                        replacing the one the agent was built with, so a prompt that says what day it
                        is says the day of the first question.
                     4. Gave a `MemoryManager` the official `AgentCoreMemoryStore`: its default
                        extraction cadence counts turns of one agent, so an agent that lives for one
                        question never writes; and the namespace can only use `{actorId}`,
                        `{sessionId}` and `{memoryStrategyId}`, so "a member in a home" has to be the
                        actor in the session.

**Expected:**        Interrupts, sessions and memory documented for an agent rebuilt on every request,
                     which is how a server that acts with each caller's credentials must build it.

**Actual:**          Each works, each needs a step the docs do not mention: decline and close the turn
                     by hand (an assistant message pushed to keep the roles alternating), set
                     `agent.systemPrompt` again after `initialize()`, use `InvocationTrigger` and
                     `flush()` before answering, and make the home the AgentCore session.

**Severity:**        Important

**Workaround:**      All four, in turn.ts and memory.ts, each tested with a scripted model against an
                     in-process MCP server over real Streamable HTTP.

**Suggestion:**      Add `agent.cancelInterrupts()` (or let a plain prompt resume an interrupted agent
                     by declining what is pending), let `SessionManager` leave out the system prompt
                     (`exclude: ['systemPrompt']`), document the per-request pattern with
                     `InvocationTrigger`, and let a namespace template take caller-supplied values.
## FL-045 — A Step Functions Wait takes a moment, but a task's timeout only takes seconds from now

*2026-10-16.*

**Tool / API:**      AWS Step Functions, Amazon States Language (JSONPath): `Wait.TimestampPath`,
                     `Task.TimeoutSecondsPath`, `arn:aws:states:::lambda:invoke.waitForTaskToken`

**Task attempted:**  A visit errand (infra/errand.asl.json): wait until her reminder, then wait at the
                     door for a ring until the end of the visit's window — an absolute moment, an hour
                     after the time the family member gave — and say nobody came if it passes.

**Steps taken:**     1. The reminder is a Wait with `TimestampPath`: an ISO 8601 moment from the
                        execution's input. That works as written.
                     2. The door is a task with a task token, so its end has to be its timeout. Read
                        the Task state reference (docs.aws.amazon.com/step-functions/latest/dg/
                        state-task.html, 2026-10-16): `TimeoutSeconds` is "a positive, non-zero
                        integer", counted from when the task starts; `TimeoutSecondsPath` selects one
                        from the input, "JSONPath only". There is no `TimeoutTimestampPath`.
                     3. Looked for a way to turn the window's end into seconds in the definition. The
                        JSONPath intrinsic functions have arithmetic (`States.MathAdd`) but nothing
                        that reads a timestamp or the clock.

**Expected:**        A task's deadline could be given the way a Wait's is: as a moment.

**Actual:**          Only as seconds from the task's own start, which depends on when the steps
                     before it ran — here, whenever the reminder was sent. JSONata could compute it,
                     but a state is in one query language or the other, and the rest of the machine
                     reads and places results with JSONPath.

**Severity:**        Nice-to-have

**Workaround:**      The seconds are counted in code: by the Wick server when the execution starts
                     (for an errand with no reminder) and by the reminder step for one with
                     (services/agent agents/errand/machine.ts `doorWaitSeconds`, at least 60), and
                     the door task reads them with `TimeoutSecondsPath`. A test walks every path of
                     the machine to hold the two to each other (errand/__tests__/asl.test.ts).

**Suggestion:**      Add `TimeoutTimestamp` / `TimeoutTimestampPath` to Task states, mirroring Wait's
                     `Timestamp` / `TimestampPath`, so a callback can be given a deadline that is a
                     time of day; or document the JSONata expression that does it in the callback
                     pattern's guide.

---

## FL-044 — Vega's only documented toast API is a React hook, and the one place a toast is needed has no React tree

*2026-10-16.*

**Tool / API:**      React Native for Vega 0.83, `useToastKepler` (`@amazon-devices/react-native-kepler`
                     4.0.1, Libraries/Components/ToastKepler); `@amazon-devices/headless-task-manager`
                     1.2.8; Vega Virtual Device, SDK 0.24.12044

**Task attempted:**  Post the door's system toast from the card service (a headless service, the only
                     part of Wick that runs while another app is in front, FL-022) through a
                     documented API, instead of looking the `NotificationManager` TurboModule up by
                     name and posting a hand-copied object.

**Steps taken:**     1. Searched the Vega docs and npm for a toast or notification API. The API
                        reference documents `useToastKepler` and nothing else; the "interactive
                        toast" guide uses `react-native-toast-message` inside a screen. No
                        `@amazon-devices/*` notification package is published.
                     2. Read `ToastKepler.kepler.js`: the hook calls `useContext` and `useCallback`,
                        builds a `NotificationContent` with `ToastKind` and `AppLaunchTarget`, and
                        posts it to `NativeNotificationManager`. A hook cannot be called outside a
                        React render, and a headless service renders nothing.
                     3. Built the toast from the hook's own classes and type, and posted it to the
                        hook's own module, all imported from react-native-kepler's ToastKepler
                        directory (apps/tv-vega/src/notify/doorToast.ts). Checked on the VVD: the
                        toast is drawn over the launcher with the door's picture, the sentence and
                        "Open Wick" (`notification_manager_tm: Posting notification`).

**Expected:**        A documented, non-hook way to post a toast, since the docs say background
                     services exist to do work while another app is in front.

**Actual:**          Only the hook is documented. Its parts are reachable through the package's
                     `exports` map but are not part of the documented API, so a background service
                     has to reach past the documented surface either way.

**Severity:**        Important

**Workaround:**      The hook's own parts, typed by its own `NotificationContent`, so a change to
                     the contract in a later SDK fails Wick's type check instead of posting a toast
                     that draws nothing.

**Suggestion:**      Export and document a plain function beside the hook — for example
                     `showToast({ title, description, iconUri, options, duration })` — usable from a
                     headless service, and say in the headless services guide that a service may
                     post one.

---

## FL-043 — Content Personalization takes Watch Activity with a clear log, but where it goes cannot be seen without a catalogue

*2026-10-16.*

**Tool / API:**      `@amazon-devices/kepler-content-personalization` 1.3.3; Vega Virtual Device,
                     SDK 0.24.12044, CLI 1.3.4; Vega docs "Get Started with Vega Content
                     Personalization" and "Watch Activity" (0.24), read 2026-10-16

**Task attempted:**  Report what she watches to the platform as it happens, by the "When to Send"
                     rules, and see the result.

**Steps taken:**     1. Reported `reportNewPlaybackEvent` on each change of state, each seek and every
                        60 seconds in the player, with the content id in `cdf_id`, an
                        `app_internal` profile id, duration, position, state and the credits
                        position (apps/tv-vega/src/personalization).
                     2. Ran the guide's check, `vega exec loggingctl log -f | grep -Ei
                        'kepler.tv.personalization'`: it fails with "No such file or directory:
                        'loggingctl'". `vega device run-cmd --command 'loggingctl log -f'` printed
                        nothing. `vega device start-log-stream` showed the platform's lines:
                        `reportNewPlaybackEvent called`, `async call received`, `sendPlaybackEvents
                        async call completed successfully` — at the start, at 60 s, at a pause and
                        on leaving the film.
                     3. Looked for Continue Watching. The guide says the content id comes from "your
                        catalog file", and Wick's three films are Blender's open films, in no Amazon
                        catalogue. Nothing on the VVD showed a row, and nothing said why.
                     4. Read the playback pull handler's documentation: it is for playback that
                        happened off the device (`reportRefreshedPlaybackEvents`). Wick used to send
                        this television's own stored events through it as active events, which would
                        have counted each evening twice; it now answers with nothing.

**Expected:**        The documented log check to run, and either a Continue Watching row or a log
                     line saying an id could not be resolved.

**Actual:**          The documented command fails as written. Reports are accepted silently whether
                     or not the platform can use them.

**Severity:**        Nice-to-have

**Workaround:**      `vega device start-log-stream` to see reports taken; Continue Watching left
                     unverified and said so (WICK-TECHNICAL §3.3, SP-7).

**Suggestion:**      Correct the guide's command for the CLI it ships with; log a warning when a
                     reported content id is not in the app's catalogue; say on the "Watch Activity"
                     page whether the pull handler should return on-device events.

---

## FL-042 — Fire TV's Alexa and Vega's speak different media-session languages for the same words, and nothing that runs off a Fire TV can send either

*2026-10-16.*

**Tool / API:**      Fire OS media sessions as described in developer.amazon.com/docs/fire-tv/
                     mediasession-api-integration.html ("Voice-enabling Transport Controls with
                     Media Session API on Fire TV"), read 2026-10-16; Android
                     `android.media.session.MediaSession` (API 21); Android TV emulator, system
                     image `android-34/android-tv/arm64-v8a`; compared with Vega Media Controls
                     (`@amazon-devices/kepler-media-controls` 1.0.25, FL-031)

**Task attempted:**  Give the Fire OS build the media session the Vega build already has, so
                     "Alexa, pause" reaches her film there too — through the same shared handler
                     and the same rules as her remote's keys (apps/tv-vega/src/watch/mediaSession.ts).

**Steps taken:**     1. Read the Fire TV page. "Alexa, play"/"resume" → `onPlay`; "pause" and
                        "stop" → `onPause`; "rewind" and "fast-forward", with or without a length
                        of time, → `onSeekTo(position)`, Alexa working out the position ("absolute
                        time is not supported"); "restart" → `onSeekTo(0)`; "previous"/"next" →
                        `onSkipToPrevious`/`onSkipToNext`. Missing actions make Alexa say the
                        command is not supported. A permission
                        (`com.amazon.permission.media.session.voicecommandcontrol`, not needed from
                        Fire OS 14) and an opt-in meta-data
                        (`com.amazon.voice.supports_background_media_session`) are asked for.
                     2. Compared with Vega, where the same words arrive as `handleStartOver`,
                        `handleSkipForward(delta)`, `handleSkipBackward(delta)` and `handleStop`,
                        and a seek to a time is a separate command Wick does not offer.
                     3. Mapped Android to Vega's names in one small Kotlin file: a seek to zero is
                        start over; any other seek is a skip by its distance from where the
                        published state says the film is now; fast-forward and rewind keys are
                        the skips; previous and next are refused.
                     4. Looked for a way to send a voice command to the Android TV emulator. It has
                        no Alexa. `adb shell cmd media_session dispatch <pause|play|fast-forward|
                        rewind|stop|play-pause|next|previous>` sends a media key to the media
                        button session, which proves the session and its key handling; nothing
                        sends `onSeekTo`, which is how Alexa sends three of the five commands.
                     5. Sent the remote's Play/Pause with `input keyevent`: as on Vega (FL-031) it
                        reaches the app twice, as the key (React Native does not consume it) and
                        as the session's command, a millisecond apart. Fast-forward reaches the
                        session only as the key coming up.

**Expected:**        One model for "Alexa, rewind thirty seconds" across Amazon's two TV platforms,
                     or a table on each page saying how the other's commands map; and a way to send
                     an Alexa transport command to an app without a Fire TV.

**Actual:**          Two models. A shared app has to keep both: Vega's relative skips and explicit
                     start over, and Fire TV's absolute seeks with restart as a seek to zero —
                     which means the Fire OS side has to reckon where the film is from its own
                     last published state to turn a seek back into a skip. "Stop" is a pause on
                     Fire TV's Alexa and its own command on Vega. The voice half cannot be run
                     anywhere but a Fire TV.

**Severity:**        Important — the Fire OS session is proved on the emulator only for media keys;
                     the seeks Alexa sends for rewind, fast-forward and restart are proved on the
                     JVM, not on a device.

**Workaround:**      Map both onto the shared rules' seven commands (FilmTransport.kt, tested on the
                     JVM); prove the session on the emulator with `cmd media_session dispatch`
                     (state, actions, metadata, every key, release on leaving the film); let the
                     shared echo filter (`keyEchoes`) drop the doubled Play/Pause, as on Vega.

**Suggestion:**      1. One cross-platform table of Alexa transport utterances against Vega Media
                        Controls handlers and Android `MediaSession` callbacks, on both pages.
                     2. A command-line way to send an Alexa transport command to an app — an
                        `adb shell` intent on Fire OS, a `vega` subcommand on Vega — so it can be
                        tested without speaking to a device.
                     3. Say on both pages that the remote's Play/Pause reaches the app both as a
                        key and as a session command.

---

## FL-041 — Ring signs a webhook's body and nothing else, documents no replay window, and does not say whether a retry is stamped afresh

*2026-10-16.*

**Tool / API:**      Ring Partner API webhooks, v1.1 payload, as documented in
                     developer.amazon.com/docs/ring/api-documentation.html ("Notifications",
                     "Webhook Authentication & Verification", "Webhook v1.1 Payload Structure",
                     "Retry Logic"), read 2026-10-16

**Task attempted:**  Prove Wick's webhook receiver against what Ring documents, and refuse a
                     correctly signed event that is being replayed: a body captured once and
                     posted again later, after its `request_id` row (24 hours) has gone.

**Steps taken:**     1. Read the Notifications section end to end. It says: "All webhook requests
                        from Ring include an HMAC-SHA256 signature in the X-Signature header",
                        shown as `X-Signature: sha256=<hmac_signature>`, hex, keyed with the
                        partner's HMAC signing key, over "the raw body bytes, not re-serialized
                        JSON". The envelope is `meta.{version, time, request_id, account_id}` and
                        `data.{id, type, attributes}`; a device event's attributes carry
                        `source` (the device), `timestamp` (epoch ms, when it happened) and, for
                        motion, `sub_type`. `meta.time` is "ISO 8601 timestamp when Ring sent the
                        webhook".
                     2. Looked for replay protection: a timestamp header, a signed timestamp
                        beside the body (as `t=…,v1=…` schemes do), a tolerance window, a nonce.
                        There is none for webhooks. The page's only replay protection is for
                        account-linking nonces (a 600-second window), which it tells you not to
                        mix up with webhooks.
                     3. Read the retry schedule: 1 s, 5 s, 30 s, 2 min, 10 min, 1 h after the
                        first attempt, then a dead-letter queue kept 72 hours, replayed on request
                        through the integration representative. 4xx is never retried, and "10+
                        consecutive failures over 24 hours" of 4xx may disable the endpoint.
                     4. Looked for whether `meta.time` is stamped again on each retry and on a
                        dead-letter replay, or kept from the first attempt. Not said.
                     5. Found, in doing this, that Wick's own receiver had been written against a
                        flat shape (`request_id`, `event_type`, `device_id`, `occurred_at` at the
                        top) and guessed the header (`x-ring-signature ?? x-amz-signature ??
                        x-signature`). A real Ring delivery would have been answered 400 — never
                        retried. That was our mistake, from building before this section was
                        read closely, and the Playground could not catch it because it sends no
                        webhook (FL-027).

**Expected:**        Either a signed timestamp outside the body with a documented tolerance
                     (the common pattern), or a sentence saying `meta.time` is set on every
                     delivery attempt, so a partner can safely refuse anything older than a few
                     minutes.

**Actual:**          The signature covers the body only, so the only time a partner can trust is
                     `meta.time`. A window on it is safe for Ring's first four attempts (the
                     fourth is 36 s after the first) whatever Ring does. If `meta.time` is kept
                     from the first attempt, the fifth (about 2.5 minutes in) still passes a
                     five-minute window, but the sixth and seventh (about 12.5 minutes and 1 h
                     12 min in) and any dead-letter replay would fall outside it. If it is
                     stamped afresh, they pass. Which it is cannot be learned without a real delivery, and the
                     Playground sends none.

**Severity:**        Important — every partner has to choose between no replay protection and a
                     window that may drop Ring's own late retries.

**Workaround:**      `services/edge-ring/lambda/webhook-receiver.mjs` reads `X-Signature` only,
                     verifies the raw bytes, reads the v1.1 envelope, and drops a signed body
                     whose `meta.time` is more than five minutes old or more than one minute
                     ahead (`MAX_EVENT_AGE_MS`, `MAX_EVENT_LEAD_MS`). It answers those 200, not
                     4xx: Ring counts repeated 4xx toward disabling an endpoint, and a late
                     retry is Ring's own. For the door that costs
                     nothing: a door card lives five minutes (`DOOR_CARD_TTL_MS`), and the Door
                     agent runs no event older than that (`infra/agent.tf`). A device-lifecycle event
                     replayed from the dead-letter queue after an outage would be dropped; Wick
                     reads none of those today. `request_id` is still deduplicated for 24 hours.
                     Not seen against a real Ring delivery.

**Suggestion:**      1. Send a signed timestamp: `X-Signature: t=<unix>,sha256=<hmac of
                        "t.body">`, and document a tolerance (five minutes is usual).
                     2. Until then, say in "Webhook v1.1 Payload Structure" whether `meta.time`
                        is set on each delivery attempt and on a dead-letter replay.
                     3. Give the Playground a "send a test webhook" button (FL-027) so a partner
                        finds a wrong envelope or header on day one, not at certification.

## FL-040 — The Alexa+ MCP add-on design guide names Card, List and Carousel but gives none of them an anatomy, and its components page is not in its own navigation

**Date:**            2026-10-16

**Tool / API:**      Alexa+ MCP add-on design guide (developer.amazon.com/docs/alexaplus/add-ons/,
                     the overview, Display Modes, Layout and Rendering, Visual Foundations and
                     Components and Patterns pages, as published on 2026-10-16)

**Task attempted:**  Draw the family app's answers — the door, the week, the visits, today, the
                     light, a film invitation — as the cards an Alexa+ surface would show for an
                     add-on's tool results: a header, primary text, an image where the tool
                     returned one, and a few actions; and the week's days as a carousel.

**Steps taken:**     1. Read the overview. Its navigation lists the conversation surface, tools and
                        data, Display Modes and the glossary; the "Build a High-Quality Design"
                        and "Get Ready for Customers" sections are collapsed with no links in them.
                        The overview's only rule for a card is "one title, one or two supporting
                        fields, one clear action".
                     2. Read Display Modes (inline, fullscreen, hydrated, voice-only) and Layout
                        and Rendering (Block and Card viewports, `hostContext`, CSP). Both point
                        to "Components and Patterns" for components; neither links it from the
                        navigation, and I reached it by its address
                        (…/mcp-addon-components-and-patterns.html).
                     3. Components and Patterns names four patterns — List, Carousel, Card, Map —
                        and says not to invent others. The Card is "a single entity shown with an
                        image and optional action buttons"; the Carousel returns "3 to 5 items in
                        inline mode" and "See more" lazy-loads the rest.
                     4. Read Visual Foundations for the card's parts: it has colours, spacing,
                        radii and a type scale, and no anatomy.

**Expected:**        For each pattern, its parts and their limits: which text is the header and
                     which is primary or secondary, which type token each takes, the image's
                     aspect ratio and place, how many calls to action a card may carry, how wide
                     a carousel item is and what "See more" does on a web transcript surface.

**Actual:**          None of those is written down. A Card has "an image and optional action
                     buttons", with no count; a Carousel has an item count but no item size; the
                     type tokens are not tied to any part of a card. Two builders following the
                     guide would draw different cards, and neither could say which matches what
                     Alexa+ renders natively in hydrated mode.

**Severity:**        Nice-to-have — the cards were built, but on our reading, not the guide's.

**Workaround:**      Took the guide's words literally and filled the gaps with Wick's own product
                     rules: a header (Headline2) with a line under it, primary text at Body1, the
                     picture first where the tool returned one, at most three actions (Wick's own
                     "three, never four"); the week's carousel shows only days its timeline has
                     something on, five inline (the top of the guide's three to five), and "See
                     all" lays every day out in place rather than opening another surface
                     (`apps/sim-alexa/surface.js` `weekDays`, `CAROUSEL_INLINE`; `main.js`
                     `renderWeekCard`).

**Suggestion:**      1. Put Components and Patterns, Layout and Rendering and Visual Foundations
                        in the guide's navigation.
                     2. Give each pattern an anatomy diagram with its parts named, the type token
                        and spacing each takes, the image ratio, the maximum number of calls to
                        action, and a carousel item's width per device class.
                     3. Say what the hydrated (data-only) mode draws for a List, a Carousel and a
                        Card, so an add-on that returns data knows what its customer will see.
## FL-033 — App Runner's front end closes a kept-alive client connection after a few seconds to a minute, says why nowhere, and each reconnection is the whole of the "slow" tool call

**Date:**            2026-10-16

**Tool / API:**      AWS App Runner (an ECR image service, us-east-1; responses carry `server: envoy`),
                     reached over HTTP/1.1 + TLS from Node 22's `https.Agent({ keepAlive: true, maxSockets: 1 })`

**Task attempted:**  Find out why the Wick server answers MCP tool calls at two speeds — about
                     0.2 s or about 0.8–1.1 s (issue #47) — when Alexa+ asks for a round trip
                     under 500 ms.

**Steps taken:**     1. Wrote `npm run latency:mcp` (scripts/mcp-latency.ts): a fresh demo guest,
                        then N `tools/call` requests over ONE kept-alive connection, noting for
                        each call whether it reused the connection or had to open one, and
                        whether the answer said `Connection: close`.
                     2. Ran it from a laptop in Europe against the deployed server (the image
                        from before this work: Node's default 5 s keep-alive, vite-node), four
                        times: 100 calls back to back, 100 at one a second, 40 at one a second,
                        40 at one every three seconds.
                     3. Looked in the App Runner developer guide and in re:Post for any idle
                        timeout, connection lifetime or `Connection: close` behaviour on the
                        service's front end. Found none documented.

**Expected:**        A connection a client keeps alive stays open while it is used, or the
                     service documents how long it does stay open, so a client can plan for the
                     reconnection.

**Actual:**          The front end ends the connection with `Connection: close` on an ordinary
                     200 answer, after a lifetime that varies from 2 s to 40 s (2.3, 4.4, 5.5,
                     23.5 and 5.5 s in one run; 39.5, 4.0, 23.9, 9.4, 17.6, 5.6, 7.6, 4.8 s in
                     another), more often the more slowly requests come. Every slow call is the
                     first on a new connection: at one a second, 54 calls on a reused connection
                     had p50 201 ms and p95 296 ms, none over 500 ms; the 6 on a new connection
                     had p50 780 ms, all over 500 ms. Back to back (100 calls in about 20 s) only
                     one connection was replaced and one call went over 500 ms. Whether the
                     container's own 5 s keep-alive played a part could not be told from
                     outside; nothing App Runner exposes says which side closed.

**Severity:**        Important — from Europe it is the difference between meeting Alexa+'s
                     500 ms and missing it on 1 % to 22 % of calls (the slower the requests come, the more), and nothing in the service's
                     documentation lets a developer find the cause without writing a probe.

**Workaround:**      The server now keeps its own idle connections open for 65 s
                     (`keepAliveTimeout`, services/mcp-server/src/lifecycle.ts), longer than any
                     usual proxy idle time, so the container is not the side that closes; and
                     every answer carries `Server-Timing` (auth, build, gate, handler, guard,
                     total), so the server's share of a slow call can be read from the client.
                     Whether that changes App Runner's behaviour is to be measured after the
                     deploy, with the same script. From inside us-east-1 a reconnection costs a
                     fraction of what it costs from Europe.

**Suggestion:**      1. Document the front end's connection behaviour: the idle timeout, any
                        maximum connection lifetime or request count, and when it answers
                        `Connection: close`.
                     2. Say in the response (or in a metric) whether a close came from the
                        front end or from the container's own connection.
                     3. Offer HTTP/2 to clients, which would make one connection's set-up cost
                        rarer still.

---

## FL-036 — The Android TV emulator draws no notification of a third-party app: not as a heads-up, not in its notifications panel

*2026-10-16.*

**Tool / API:**      Android TV emulator, system image `android-34/android-tv/arm64-v8a`
                     (the one the hackathon FAQ names in place of a Fire TV), its launcher's
                     notifications panel (`com.google.android.tvrecommendations` 6.3.1) /
                     `NotificationManager`, `NotificationCompat` (AndroidX Core)

**Task attempted:**  See Wick's door notification on the screen while another app is in
                     front (FL-035), and press it, on the only stand-in for a Fire TV there is.

**Steps taken:**     1. Built and installed the Fire OS APK with the door service, paired it to a
                        demo home, put Android TV Settings in front of Wick, rang the demo home's
                        stand-in doorbell (`POST /api/demo/doorbell`).
                     2. `dumpsys notification --noredact`: the notification is there, on channel
                        `wick_door`, importance 4 (HIGH), priority 1, `BigPictureStyle`, the
                        title "Someone's at the front door (stand-in doorbell).", then — a few
                        seconds later — the vision model's sentence and an 832x474 picture.
                     3. Screen captures once a second for eight seconds after the ring: not a
                        pixel changed. No heads-up.
                     4. Opened the system's notifications panel (`cmd statusbar
                        expand-notifications`): it lists Google's own notices and nothing of
                        Wick's.
                     5. Added Android's own television mark to the notification
                        (`Notification.TvExtender`'s extras, `android.tv.EXTENSIONS` with
                        `FLAG_AVAILABLE_ON_TV`; the class itself is a system API) and rang again:
                        the extras were on the notification and the panel still did not list it.
                        Taken out again.

**Expected:**        The emulator the FAQ names behaves like a television for the one thing a
                     television app most needs to test outside itself — a notification — or a
                     written note says it does not.

**Actual:**          Nothing a third-party app posts is drawn anywhere on this image. Android
                     takes the notification, keeps it, updates it and times it out exactly as
                     asked, and shows none of it. Fire TV's documentation says the opposite of
                     Fire OS — a high-priority notification is a heads-up at the bottom of the
                     screen and stays in the Notification Center — so on the emulator there is
                     no way to see what the resident would see, nor to press it.

**Severity:**        Important — the door outside Wick on Fire OS is checked on the emulator only
                     through `dumpsys`; what it looks like on a Fire TV, and that pressing it
                     brings Wick forward, is not seen.

**Workaround:**      Checked what can be checked without a drawing: the foreground service and its
                     type, the notification's every field through `dumpsys`, that it is updated
                     with the picture and the sentence, that it goes when Wick comes forward, at
                     its card's end and when the card is answered on another television, and
                     that the intent it carries brings Wick forward to the card (sent by hand
                     with `am start`). Then ran the same APK on an Android *phone* emulator
                     (API 34, Google APIs) paired into the same home: there the heads-up and the
                     picture are drawn and pressing *Open Wick* brings Wick to the card. A
                     phone's system UI is not a Fire TV's, so this shows the notification is
                     right, not what a Fire TV draws.

**Suggestion:**      1. A Fire OS emulator image (FL-025), or at least a Fire TV system UI for the
                        Android TV emulator that draws heads-up notifications and the Notification
                        Center as a Fire TV does.
                     2. Until then, one sentence on the Fire TV notifications page saying the
                        Android TV emulator does not draw third-party notifications, so nobody
                        spends an afternoon proving it.

---

## FL-035 — Fire TV's notification guidance says "no heads-up while another app is in front" in a blog post, says nothing of foreground services, and a doorbell is exactly the case it rules out

*2026-10-16.*

**Tool / API:**      Fire OS 7 / 8 (Android 9 / 11) Android notifications, as described in
                     developer.amazon.com/docs/fire-tv/notifications.html and the Appstore blog
                     post "Amazon Device Messaging (ADM) and local notifications on Fire TV"
                     (Kevin Tsang, 2021-07-21); Android foreground services (`specialUse`,
                     Android 14), `POST_NOTIFICATIONS` (Android 13)

**Task attempted:**  Say "Someone's at the front door." on a Fire TV while another app is in
                     front, as Wick does on Vega with a system toast (FL-022): the only thing in
                     Wick that may interrupt anything.

**Steps taken:**     1. Read the Fire TV notifications page. It says heads-up notifications
                        "appear at the bottom of the screen and fade away after a few seconds",
                        that "you must set the notification as a high priority", that "heads-up
                        notifications are limited in height to normal layouts only (there are no
                        expanded layouts)", that a large image is "the tile image in the
                        notification card" at 16:9, and that "Users can also select Do Not
                        Interrupt to suppress heads-up notifications". It says nothing about
                        whether an app may post one over another app.
                     2. Found that rule only in the blog post: "your app should not send a
                        Heads-Up notification when another app is in the foreground", and
                        "Build your notification mechanism in order to verify if another app is
                        in the foreground".
                     3. Looked for what Fire OS does with the ongoing notification Android
                        requires of a foreground service — whether it lands in the Notification
                        Center, and whether it lights the bell on Settings — and for any word on
                        foreground services on Fire TV at all. Found neither.
                     4. Built it anyway (`apps/tv-fireos/android/.../door`): a `specialUse`
                        foreground service holding the door's background connection, one
                        high-priority notification per door card, no sound, no vibration, no
                        light, no badge, taken down when Wick comes forward, when the card is
                        taken back and at the card's own five minutes.

**Expected:**        The rule on the documentation page, with the exception every television
                     platform makes: a doorbell, a call, an alarm — something happening now that
                     the person would want to be told over a film. And a sentence on what a
                     foreground service's notification does on a Fire TV.

**Actual:**          The rule is in a blog post and has no exception. A doorbell is exactly the
                     case it rules out: the whole point is that another app is in front. Fire
                     TV's own Ring integration puts the doorbell's picture over any app, so the
                     platform plainly thinks a doorbell may interrupt; a third-party app has
                     nothing written to stand on. Whether Fire OS shows the service's ongoing
                     notification in the Notification Center, with the bell, is not said, and
                     with no Fire TV and no Fire OS emulator (FL-025, FL-036) it could not be
                     looked at.

**Severity:**        Important — the feature is built against the blog's advice, on purpose, for
                     one kind of card, and how it looks on a Fire TV is unseen.

**Workaround:**      Wick departs from the advice for the door only, and says so
                     (`apps/tv-fireos/src/door/doorAlert.ts`): a note from the family, a week, a
                     question, anything DEFERRED never posts anything outside Wick. The door's
                     notification is high priority (a heads-up), carries no sound, and Fire OS's
                     Do Not Interrupt still silences it — that is her choice. The service's own
                     notification is the lowest importance there is, with no badge. On Android 13
                     and later she is asked once, by the system, whether Wick may notify; Fire OS
                     7 and 8 grant it at install.
                     One thing found on the way, which is React Native's and not Amazon's: in
                     React Native 0.83's new architecture no package registers
                     `HeadlessJsTaskSupport`, so `AppRegistry` never tells Android a Headless JS
                     task has ended, and a service waiting for that (as `HeadlessJsTaskService`
                     does) never stops. Seen on the emulator; Wick's task says so through its
                     own module instead.

**Suggestion:**      1. Move the foreground rule onto the notifications page and give it the
                        exception: "unless the notification is time-critical for the user — a
                        doorbell, an incoming call, an alarm — in which case use
                        `CATEGORY_CALL`/`CATEGORY_ALARM`/a named category" (and name one for a
                        doorbell).
                     2. Say what a foreground service's notification does on Fire TV: whether it
                        is listed in the Notification Center, whether it lights the bell on
                        Settings, and whether a `specialUse` service is accepted in Appstore
                        review.
                     3. Say whether `BigPictureStyle` is drawn anywhere on Fire TV (the page says
                        there are no expanded layouts) and which field is the "tile image".

---

## FL-038 — Vega answers whether high-contrast text is on, but says nothing an app can use about text size, and the simulator cannot turn either setting, or VoiceView, on

*2026-10-16*

**Tool / API:**      Vega OS 1.2, Vega SDK 0.24.12044, Vega Virtual Device /
                     `@amazon-devices/react-native-kepler` 4.0.1+rn0.83.0 (`AccessibilityInfo`,
                     `Dimensions`, `PixelRatio`)

**Task attempted:**  "Easier to see": larger text and higher contrast on her television, with
                     the platform's own settings as the default, and VoiceView respected (each
                     card announced once, no slideshow while it is on).

**Steps taken:**     1. Looked for Vega accessibility documentation in the SDK under ~/vega/sdk:
                        there is none (binaries, the VVD image and logs only), so read
                        `Libraries/Components/AccessibilityInfo/AccessibilityInfo.js` in
                        react-native-kepler, the parts marked `amznmod_react - kepler platform
                        support`.
                     2. Its event table for `Platform.OS === 'kepler'` has three entries:
                        `change` and `screenReaderChanged` (both VoiceView) and
                        `highTextContrastChanged`. `isHighTextContrastEnabled()` goes to the
                        native module on kepler as on Android. `isBoldTextEnabled()` and
                        `isGrayscaleEnabled()` are hard-wired to `Promise.resolve(false)` on
                        kepler; there is no `reduceMotionChanged`.
                     3. Looked for text size: `AccessibilityInfo` has no query for it. The
                        only trace is `Dimensions.get('window').fontScale`, which kepler fills
                        from a native `windowPhysicalPixels.fontScale`;
                        `PixelRatio.getFontScale()` falls back to `PixelRatio.get()` (2 on a
                        1080p Vega screen) when that is missing, so it cannot be trusted to mean
                        "text size". React Native's `Text` already multiplies by `fontScale`
                        itself (`allowFontScaling` defaults to true).
                     4. Logged `fontScale` once at launch; the release build's `console.info`
                        did not appear in `vega device start-log-stream`, so its value on the
                        simulator was not seen.
                     5. Looked for a way to turn VoiceView or high-contrast text on in the
                        Vega Virtual Device from the CLI (`vega device run-cmd`): found none.
                        The simulator's own Settings screens were not explored.

**Expected:**        A documented accessibility page for Vega listing which `AccessibilityInfo`
                     calls and events are real, a text-size setting an app can read (or a
                     statement that there is none), and a way to switch VoiceView and
                     high-contrast text on in the simulator to test against.

**Actual:**          High-contrast text and VoiceView can be read and followed; text size
                     cannot, except through a `fontScale` whose meaning on Vega is not
                     documented and which React Native already applies to every word. Neither
                     setting could be turned on in the simulator, so Wick's reaction to them
                     (higher contrast by default, the announcement of each card, no slideshow,
                     no Play mark) is checked by unit tests only.

**Severity:**        Important

**Workaround:**      Higher contrast follows `isHighTextContrastEnabled()` /
                     `highTextContrastChanged` until she presses the button herself
                     (`packages/vega-calm-ui/src/accessibility.ts`,
                     `apps/tv-vega/src/seeing/seeing.ts`). Larger text is Wick's own setting,
                     off by default, and the platform's `fontScale` is not followed — following
                     it as well would scale every word twice. Her choice is kept in the app's
                     file store, which the Vega Virtual Device does not keep across launches
                     (FL-013): there it is forgotten at every launch.

**Suggestion:**      Publish a Vega accessibility reference that says which React Native
                     accessibility APIs work on kepler; expose the system text size (or say
                     there is none) and document `fontScale`; add `vega device` commands, or
                     VVD menu items, to toggle VoiceView, high-contrast text and text size.

---

## FL-032 — Speech to text from a browser through App Runner has to be one buffered POST: App Runner has no WebSockets, says so only in a closed GitHub issue, and documents no request-body limit

**Tool / API:**      AWS App Runner (an ECR image service, us-east-1) /
                     Amazon Transcribe streaming, `@aws-sdk/client-transcribe-streaming` 3.1150.0
                     (`StartStreamTranscriptionCommand`)

**Task attempted:**  Let a family member ask Wick a question out loud from the family app, heard
                     by Amazon Transcribe. The family app is a static page with no AWS
                     credential (and must have none), so the sound has to go through the Wick
                     server on App Runner, which holds the instance role.

**Steps taken:**     2026-10-14, reading before building:
                     1. Looked for how App Runner carries a long-lived or streamed request. The
                        developer guide says only that it supports "HTTP 1.0 and HTTP 1.1 to the
                        container instances" and that there is "a total of 120 seconds request
                        timeout limit", body read included
                        (docs.aws.amazon.com/apprunner/latest/dg/develop.html). Nothing about
                        WebSockets either way.
                     2. Found the answer in `aws/apprunner-roadmap` issue #13, "Support web
                        sockets": closed as not planned, AWS's reply "We don't have native
                        support for web sockets at this point"
                        (github.com/aws/apprunner-roadmap/issues/13). The same thread notes App
                        Runner closed to new customers on 2026-04-30 and gets no new features.
                     3. Looked for a request-body size limit, since the utterance has to go in
                        one body: neither the developer guide's quotas
                        (docs.aws.amazon.com/apprunner/latest/dg/architecture.html) nor the
                        General Reference (docs.aws.amazon.com/general/latest/gr/apprunner.html)
                        names one. The only number found is WAF's inspection size, which is not
                        a limit on the body.
                     4. Fell back on what Wick has already sent through this same service:
                        `POST /api/photos` takes bodies of up to 1.5 MB and has been seen
                        working live. Ten seconds of 16 kHz 16-bit audio is 320 KB.

**Expected:**        One sentence in App Runner's own documentation saying WebSockets (and
                     request streaming) are not supported, and the largest request body it
                     passes — the two facts any audio or upload design needs first.

**Actual:**          The WebSocket answer is only in a closed roadmap issue, and the body limit
                     is not documented anywhere I could find. So the natural design — the
                     browser streams audio over a socket and partial transcripts come back as
                     she speaks — is out, and the design that works was chosen partly on
                     Wick's own evidence (1.5 MB pictures already go through) rather than on a
                     documented number.

**Severity:**        Nice-to-have — there is a working design, but a family member now sees her
                     words only after she stops speaking, not while she speaks.

**Workaround:**      The page records one utterance (ten seconds at most), turns it into 16 kHz
                     16-bit PCM itself, and sends it in one POST to `/api/hear`; the server
                     streams it to Transcribe in 8 KB `AudioEvent`s and answers with the final
                     words (`services/mcp-server/src/hear`). The route reads at most
                     328 000 bytes, a long way under what App Runner has been seen to pass, and
                     Transcribe is given fifteen seconds, a long way under App Runner's 120.

**Suggestion:**      1. Say in the App Runner developer guide, beside "HTTP 1.0 and HTTP 1.1",
                        that WebSocket upgrades and HTTP/2 to the container are not supported.
                     2. Publish the maximum request body size App Runner's front end passes
                        (or state that there is none below the 120-second timeout).
                     3. Transcribe already accepts a presigned WebSocket URL, which a server could
                        mint for a browser and so skip App Runner altogether — but the browser
                        then has to frame audio in AWS's binary event-stream encoding itself,
                        which the docs leave to the SDK. A small, dependency-free browser
                        reference for that framing would make the direct path usable from a
                        page with no build step, as Wick's family app is.

---

## FL-031 — Vega Media Controls: once a session is registered the remote's Play/Pause reaches the app twice, the simulator has no way to send a media command, and two ordinary state shapes fail with errors that name neither field

**Tool / API:**      Vega OS 1.2 / `@amazon-devices/kepler-media-controls` 1.0.25
                     (`MediaControlServerComponentAsync`, `setHandlerForComponent`,
                     `updateMediaSessionStates`), `@amazon-devices/react-native-w3cmedia` 2.3.2,
                     `@amazon-devices/react-native-kepler` 4.0.1, Vega Virtual Device, SDK 0.24.12044

**Task attempted:**  Make Wick's own film a media session, so "Alexa, pause" and the system's
                     transport controls pause and resume it — and so a pause made that way is a
                     natural break, exactly like a pause by the key. The manifest had declared
                     `IMediaPlaybackServer` since the start, with nothing behind it.

**Steps taken:**     1. Read the Media Controls guides (get started; "media player media
                        control"). They show two ways: hand the player to the platform with
                        `VideoPlayer.setMediaControlFocus(componentInstance, handler?)`, or
                        register a handler with the server yourself. Read w3cmedia's own
                        source to choose: handed over, the player answers play, pause and seek
                        by itself and publishes a stock state — media id `com.foo.bar`, eight
                        speeds from -3 to 3, ratings, and an "X-ray" control. Registered the
                        handler directly instead (`watch/mediaControls.ts`), so every command
                        passes through the same rules as the remote's keys.
                     2. Got the component with `useComponentInstance()`, as the guide shows.
                        The device log: "useComponentInstance is deprecated. Update to use
                        getComponentInstance from KeplerAppStateManager instead." Switched to
                        `useKeplerAppStateManager().getComponentInstance()`.
                     3. Published a state with `mediaInfo.startTime: {seconds: 0, nanoseconds: 0}`
                        (the film starts at zero). Every update failed:
                        `[com.amazon.apmf.ForeignRuntimeError]: time instant cannot be
                        represented in epoch-us`, and every `handleGetSessionState` answer
                        became `transactionError`. Nothing says which field: `startTime` is a
                        wall-clock instant, not a position (w3cmedia's own default is
                        946684870 s). Leaving it out fixed it.
                     4. On leaving the film, said "no session" with
                        `updateMediaSessionStates([])`: `InvalidArgumentError: Array of
                        MediaSessionState is empty`. "No film" has to be a state:
                        `NOT_PLAYING`, no actions.
                     5. Pressed Play/Pause on the simulator (`inputd-cli button_press
                        KEY_PLAYPAUSE`) with the session registered. The app got the key
                        (`useTVEventHandler`, "play") at .104 s and then, from inputd's
                        `MediaController`, the session's `handleTogglePlayPause` at .163 s.
                        Acting on both paused the film and played it again at once: the
                        button did nothing. The guides never say a key is delivered both ways.
                     6. Looked for a way to send a media command, or a voice utterance, to the
                        simulator. `vega` has no media-controls command; the device has
                        `inputd-cli`, `vlcm`, `vmsgr`, and `alexa` (a script that fakes the
                        far-field button to "open ASR", with nothing to listen to). No
                        media-controls test tool is in the SDK or on the device. Built a
                        throwaway client package that finds Wick's endpoint with
                        `MediaControlComponentAsync.makeMediaControlEndpointLocator()` and calls
                        `pause()`: its service started (lifecycle log), but its JavaScript wrote
                        nothing at all to the device log, so whether the call was made could
                        not be told. Removed it.
                     7. What does reach the session on the simulator: `KEY_STOP`. The app does
                        not act on that key; the platform turns it into the session's
                        `handleStop`, which Wick obeys as a pause. Seen: "media_command stop",
                        the player paused, and five seconds later the break engine said
                        `AT_BREAK`. With no film on screen the same key is refused and nothing
                        moves.

**Expected:**        The guide to say which commands a remote key also produces as a key event,
                     so an app that listens to both does not act twice; a way in the SDK (a
                     `vega device` command, or a test client) to send Play, Pause and the rest
                     to an app's session the way Alexa does; and errors that name the field.

**Actual:**          A press arrives twice, about 60 ms apart; there is no way to send a voice
                     or media-session command to the simulator, so "Alexa, pause" itself cannot
                     be tried without a Fire TV; and two ordinary shapes (a zero start time, an
                     empty list) fail with messages that name neither.

**Severity:**        Important

**Workaround:**      A command that matches a media key pressed within 600 ms of it is dropped,
                     after waiting 300 ms in case it is the one that arrives first
                     (`watch/mediaSession.ts` `keyEchoes`). `startTime` is left out, and "no
                     film" is a `NOT_PLAYING` state. The session was exercised on the simulator
                     through `KEY_STOP`; the voice path itself is the same handler, unexercised.

**Suggestion:**      1. Document, per key, whether the remote's media keys reach the app as key
                        events, as session commands, or both — and add a flag to say "this app
                        handles its own media keys".
                     2. Ship a media-controls test client: `vega device media-control
                        <appId> play|pause|toggle|seek …`, or a sample app that does it.
                     3. Name the field in conversion errors ("mediaInfo.startTime: time
                        instant …"), and accept an empty list as "no session", or say in the
                        API reference that it is refused.
                     4. Update the guide's `useComponentInstance()` to the non-deprecated call.

---

## FL-030 — Amazon's own image models on Bedrock are past end of life, and the model list says nothing until you call one

**Tool / API:**      Amazon Bedrock `InvokeModel`, `amazon.nova-canvas-v1:0` and
                     `amazon.titan-image-generator-v2:0`, `ListFoundationModels --by-output-modality IMAGE`,
                     2026-10-14

**Task attempted:**  Make four pictures for a demo home's stand-in doorbell (`docs/demo-door`): a
                     doorbell camera's frame of a carer, a parcel, a stranger and an empty step, made
                     with an image model so that no real person or house is shown, and on AWS so the
                     whole entry stays on one platform.

**Steps taken:**     1. Called `amazon.nova-canvas-v1:0` in us-east-1, eu-west-1 and ap-northeast-1:
                        `ResourceNotFoundException: This model version has reached the end of its life.`
                        In us-west-2: `The provided model identifier is invalid.`
                     2. Did the same for `amazon.titan-image-generator-v2:0`: end of life in us-east-1
                        and us-west-2, an invalid identifier elsewhere.
                     3. Listed the image models in us-east-1: neither is listed, and no Amazon model
                        makes an image any more. In us-west-2 three Stability models do
                        (`stable-image-ultra-v1:1`, `stable-image-core-v1:1`, `sd3-5-large-v1:0`).

**Expected:**        A model that the Nova documentation still presents as Amazon's image generator
                     to be callable, or to be marked as retired, with a successor named, wherever it
                     is documented.

**Actual:**          It is simply absent from the model list, and the only place that says why is the
                     error of a call to it. The successor is not named. Code and samples written
                     against Nova Canvas stop working with an error that reads like a typo in the
                     region.

**Severity:**        Nice-to-have — a third-party model on Bedrock did the job — but it costs the time
                     of finding out, and an entry that wanted to say "made with Amazon Nova" cannot.

**Workaround:**      Stable Image Ultra on Bedrock in us-west-2. The model, date, prompts and seeds are
                     in `docs/demo-door/NOTICE.md`.

**Suggestion:**      1. Keep retired models in `ListFoundationModels` with `modelLifecycle.status`
                        `LEGACY`/`EOL` and the date, rather than dropping them.
                     2. Name the successor in the end-of-life error, and in the model's documentation.

---

## FL-029 — A Vega app can start its own service, but cannot hand it anything: no launch data, no shared storage, no second message

**Tool / API:**      Vega OS SDK 0.24.12044 / `@amazon-devices/headless-task-manager` 1.2.8
                     (`registerHeadlessEntryPoint2`, `…::onStartService`), `Linking.openURL` on a
                     `pkg://` service URI, Vega Virtual Device

**Task attempted:**  Give Wick's background service the token its app already holds. On a family
                     member's own television the service asks what is waiting for that member
                     while another app is in front, and the pairing service mints that
                     television's token only for one that shows the token it held. The app has
                     it; the service, a separate process, does not.

**Steps taken:**     On the Vega Virtual Device, 2026-10-13:
                     1. Read what `onStart` is given: `{id, name, type}` and nothing else.
                     2. Put a 915-character query on the `pkg://` service URI. The service
                        started; the query was readable nowhere in it.
                     3. Tried `require('react-native').Linking` in the service to read the
                        launching URL: the process aborted with signal 6, inside a try/catch.
                     4. Wrote with `AsyncLocalStorage` in the app and read in the service: it is
                        present in both processes and shared by neither. (The file system keeps
                        nothing at all here — FL-013.)
                     5. Sent a second `openURL` to the running singleton service: `onStart` was
                        not called again.
                     6. Put both components in one process group: one pid, two JavaScript
                        runtimes, nothing shared.

**Expected:**        One documented way for an app to pass a small value to the service it
                     starts — launch data on the start, a message to a running service, or
                     storage the two share.

**Actual:**          None of the six works, and nothing says so. The start succeeds each time,
                     so the failure is only that the value never arrives. One of the attempts
                     kills the service outright.

**Severity:**        Important — any service that acts for the signed-in app needs its
                     credential, and here it must either persist one (impossible on the
                     simulator, FL-013) or be given one some other way.

**Workaround:**      The hand-off goes through Wick's own pairing service. The app, showing its
                     token, opens a window on its television's row; for ninety seconds one
                     request without a token, from the same network address, is answered once
                     with a token good for a single question (`scope: 'waiting'`), which cannot
                     be renewed once expired. Written up as a contained exception in
                     `services/edge-device/lambda/pair-refresh.mjs` and in AGENTS.md (INV-1);
                     the television's half is `apps/tv-vega/src/family/offScreen.ts` and
                     `headless/waitingService.ts`.

**Suggestion:**      1. Pass launch data to `onStartService` — the query of the `pkg://` URI
                        would do — and document its size limit.
                     2. Deliver a second launch to a running singleton service as a message.
                     3. Document which storage, if any, an app and its service share, and make
                        `Linking` in a headless runtime fail as a catchable error.

---

## FL-028 — On Fire OS a short key press reaches JavaScript as a key-up only, and a held key under another name, and neither is said anywhere

**Tool / API:**      Fire OS build of a React Native TV app (`react-native-tvos` 0.83.0-0, `useTVEventHandler`),
                     Android TV emulator image, a virtual remote made with Android's `uinput`

**Task attempted:**  Tell OK held for two seconds from OK pressed, while a programme plays and nothing
                     on screen has the focus ("Hold for Sarah", `apps/tv-vega/src/watch/hold.ts`). On
                     Vega this is two events, key down then key up (FL-021), and timing them works.

**Steps taken:**     1. Timed the hold from `eventKeyAction` 0 to `eventKeyAction` 1, passed through the
                        Fire OS remote adapter (`apps/tv-fireos/src/adapters/remoteEvents.ts`).
                     2. On the emulator, during a film: a SHORT press paused the film, un-paused it by
                        itself two seconds later and brought the card for a hold. A real 2.5-second
                        hold did nothing at all — not even a pause.
                     3. Read the native side. `ReactAndroidHWInputDeviceHelper` sends a key-down to
                        JavaScript only when `ReactFeatureFlags.enableKeyDownEvents` is set, and it
                        defaults to false: a short press is one `select` event with action 1. And once
                        Android's key repeat starts (about 0.3 s), the same key is reported as
                        `longSelect`, down and then up, and never as `select`.

**Expected:**        A press to arrive the same way whatever its length — the same event name, a
                     key-down when it starts and a key-up when it ends — or the Fire TV guidance for
                     React Native to say that it does not, next to `useTVEventHandler`.

**Actual:**          Three different shapes for one button: up only (short), `longSelect` down/up
                     (held), or down then up (with a flag nobody mentions). Code that waits for a
                     key-up to end a press never sees the press begin; code that treats the first
                     event as the press, as ours did, takes a short press for a key still held. The
                     failure is silent and only on a device: unit tests of the handler pass.
                     `adb shell input keyevent` cannot show it either — this `input` has no way to
                     hold a key, so finding it needed a kernel-level virtual remote.

**Severity:**        Important — "long-press OK" is a natural gesture on a remote with five buttons,
                     and the first attempt at it ships a short press that misfires.

**Workaround:**      In the Fire OS adapter only; the shared screens are unchanged. A key-up with no
                     key-down before it is said as a whole press (down, then up), and `longSelect` is
                     said as `select`. Tests in `apps/tv-fireos/src/__tests__/adapters.test.ts` feed
                     the adapter's output through the hold detector itself.

**Suggestion:**      1. In the Fire TV React Native guidance, a table per remote button: which
                        `eventType` and `eventKeyAction` arrive for a short press, a long press and a
                        repeat, on Fire OS and on Vega, side by side.
                     2. Document `enableKeyDownEvents`, and say what changes when it is on.
                     3. Give `adb shell input` (or the Fire TV tooling) a real key hold, as Vega's
                        `inputd-cli button_press --holdDuration` has — that one made the Vega half of
                        this a five-minute test.

---

## FL-027 — The Ring Developer Playground delivers no doorbell or motion webhook, so nothing event-driven can be shown on it

**Tool / API:**      Ring Partner API webhooks (`button_press`, `motion_detected` with `sub_type`), Ring
                     Developer Playground, October 2026

**Task attempted:**  Record a carer's visit from the two things a doorbell sees: the press when they
                     arrive, and a person at the door again when they leave ("The visit, witnessed",
                     `packages/contracts/src/visit.ts`). Then show it without owning a Ring device,
                     which the hackathon allows.

**Steps taken:**     1. Built the path Ring's webhook documentation describes: HMAC-SHA256
                        verification, idempotency on `request_id`, a 200 inside five seconds, and
                        the Door agent behind it (`services/edge-ring`, `services/agent`).
                     2. Linked the Playground's simulated doorbell by Ring's real OAuth and
                        registered the webhook URL.
                     3. Looked for a way to make the Playground press its doorbell or see a person.
                        It offers a simulated camera and live-view sessions. No press, no motion,
                        and no webhook of either kind reaches the registered URL.
                     4. Asked in the hackathon forum (topic 45309). Amazon's answer: the Playground
                        simulates live view sessions only — no chime target, no `motion_detected`
                        webhooks (so no `sub_type`), no sensors.

**Expected:**        The simulator listed in Ring's developer documentation to be able to produce the
                     events the same documentation tells a partner to build on, at least on demand:
                     a button to "press the doorbell" and one to "walk past", each sending the
                     documented webhook to the registered URL.

**Actual:**          The whole event half of the Partner API — the half the rubric calls creative
                     ("event-based triggers", "care-taking monitoring") — cannot be exercised
                     against anything Ring provides without buying a doorbell. A developer learns
                     this only after building the webhook receiver, or by asking.

**Severity:**        Important — it does not block building, but it means every Playground-only
                     entrant either skips events or writes their own event source and has to
                     explain it. The forum shows several did (topics 45309, 45511).

**Workaround:**      `scripts/visit-sighting.sh` (and the older `scripts/test-ring-webhook.sh`) post
                     the JSON Ring documents, signed with the real HMAC key, to the real webhook.
                     Everything after the webhook is the deployed path. Amazon confirmed in the
                     forum (topic 45511) that an entrant's own simulator is acceptable. The README
                     and the video say which events came from this stand-in. And so that someone
                     trying Wick sees the door too, a demo home has a stand-in doorbell, rung from
                     the family app (`POST /api/demo/doorbell`, `packages/contracts/src/demoDoor.ts`):
                     it never reaches Ring, says it is a stand-in on the card, and everything after
                     the ring is the Door agent's own path.

**Suggestion:**      1. Give each Playground device "Press doorbell" and "Person detected" buttons
                        that send the real, signed webhook to the registered URL, with a chosen
                        `sub_type`.
                     2. Failing that, publish a signed-event CLI (`ring webhook send --type
                        button_press --device <id>`) so every partner tests against the same
                        payloads rather than each guessing them from the documentation.
                     3. Say on the Playground's own page, in one line, which of the Partner API's
                        capabilities it does not simulate.

---

## FL-026 — A Vega service whose start takes longer than eight seconds is killed as "not responding", and nothing in the package says a start has a time limit

**Tool / API:**      Vega OS SDK 0.24.12044 / `@amazon-devices/headless-task-manager` 1.2.8
                     (`registerHeadlessEntryPoint2`, `…::onStartService`), Vega Virtual Device

**Task attempted:**  Have Wick's background card service wait for its device token before it
                     opens its connection. (It has to ask the server: the simulator keeps no
                     files, FL-013, so the app and its service — two processes — cannot share
                     one. The server allowed one such request in 30 seconds, the app had just
                     made it, so the service's was refused and it waited to ask again.)

**Steps taken:**     1. Made the service's `onStartService` function `await` the token, with a
                        32-second wait and a second request when the first was refused.
                     2. Opened Wick. The app ran; `vega device running-apps` no longer listed
                        the service, and no door alert came up outside Wick.
                     3. Read `vega device start-log-stream`. Eight seconds after the launch:
                        `lcm-transition-monitor: Transition timed out - appInst[1663]
                        (com.wick.tv.card.service): START transition`, then `Forcefully
                        terminating process 1367917 with reason AppNotResponding` and a crash
                        report (`crashed with signal 3`).

**Expected:**        Either that a start function may take as long as its work takes — it is
                     `async`, and the README's example returns a promise — or a stated limit.

**Actual:**          The system gives a service's start about eight seconds and then kills the
                     process. The package's README (68 lines, the copy installed from npm)
                     does not mention a limit, a timeout or "not responding"; the online
                     reference was not re-read for this entry. From the app's side the failure
                     is silent: the `pkg://` launch succeeds, nothing is thrown, and nothing
                     restarts the service. Before this, the same missing token had failed the
                     other way — the service returned at once, stayed alive holding nothing —
                     which is how a door alert outside Wick had been working only until the
                     app was next reopened.

**Severity:**        Important — any service that does network work before it is ready (a
                     token, a handshake) is correct on a fast network and dead on a slow one,
                     with the reason visible only in the system log.

**Workaround:**      The start returns within three seconds whatever happens, and the
                     connection is taken up when the token arrives
                     (`apps/tv-vega/src/headless/CardService.ts`). The server now allows a
                     launch's worth of refreshes — the app's and its service's, twice in 30
                     seconds (`services/edge-device/lambda/pairing-code.mjs`).

**Suggestion:**      1. State the time limit of `onStartService` (and `onStopService`) in the
                        README and the reference, and say what happens when it is passed.
                     2. Say whether a service killed this way is ever started again, and give
                        the app a way to learn that the service it launched has gone.
                     3. A documented way for an app to hand a value to the service it starts
                        would remove the reason for the wait in the first place (FL-013).

---

## FL-025 — Fire OS has no emulator, and on the one the FAQ names a television app's remote is silent until something holds focus

**Tool / API:**      Fire TV (Fire OS) with React Native — `react-native-tvos` 0.83.0-0 on the Android
                     TV emulator (API 34, arm64), the emulator the hackathon FAQ names for Fire OS

**Task attempted:**  Run Wick's Vega app on Fire OS from the same source, and pause a film with the
                     remote's play/pause key.

**Steps taken:**     1. Built `apps/tv-fireos`: the Vega app's source, with Android stand-ins for the
                        three Amazon packages it imports. Pairing, the home screen and playback
                        worked on the emulator first time.
                     2. Pressed play/pause (`adb shell input keyevent KEYCODE_MEDIA_PLAY_PAUSE`) and
                        OK while a film played. Nothing happened; the film kept playing.
                     3. Logged every event `useTVEventHandler` delivered. With only the picture on
                        screen: none at all, for any key.
                     4. Gave the picture's frame focus (`focusable`, `hasTVPreferredFocus`). Events
                        arrived — and play/pause arrived only as the key coming up
                        (`eventKeyAction: 1`), never going down.

**Expected:**        What Vega does with the same code: `useTVEventHandler` hears every key press
                     whatever is focused, as key down (`eventKeyAction: 0`; FL-021 covers the names).

**Actual:**          Two differences, neither in Fire TV's React Native guidance or the multi-TV
                     sample's notes: (a) Android delivers a key press to the focused view and to
                     nothing if nothing is focused, so a screen that is all picture has a dead
                     remote; (b) which half of a press arrives depends on the key. Code written to
                     act on key down — the right thing on Vega — ignores play/pause entirely.
                     There is also no Fire OS emulator to find this on: it was found on a stock
                     Android TV image, and whether a Fire TV Stick behaves the same is unknown.

**Severity:**        Important — a player with no working pause is the first thing a reviewer of a
                     Fire TV app would hit, and it fails silently.

**Workaround:**      In the Fire OS adapters only; the shared screens are unchanged. The video
                     view's frame holds focus while it is all there is
                     (`apps/tv-fireos/src/adapters/w3cmedia.tsx`), and a press is acted on once,
                     whichever half arrives first (`remoteEvents.ts`).

**Suggestion:**      1. Publish a Fire OS emulator image, or state plainly how the Android TV
                        emulator differs from a Fire TV device for input, focus and notifications.
                     2. In the Vega/Fire OS porting guide, a short table: `useTVEventHandler` on
                        Vega versus Fire OS — which events, which action, and the focus requirement.
                     3. Have `react-native-multi-tv-app-sample` include a full-screen player with
                        no focusable control on it, since that is the case that breaks.

---

## FL-024 — An MQTT client in a WebSocket cannot authenticate to IoT Core the way MQTT clients are shown to, and the reason is one sentence on one page

**Tool / API:**      AWS IoT Core custom authentication, MQTT over WebSockets; `mqtt.js` 5.x inside
                     React Native (Vega's RN 0.83 fork and react-native-tvos)

**Task attempted:**  Let a television authenticate to IoT Core with the one credential it holds —
                     its device-bound JWT — through a custom authorizer, from `mqtt.js` over WSS.

**Steps taken:**     1. Wrote the client the way every MQTT example shows: `username` = device id,
                        `password` = the token, sent in the MQTT CONNECT (the first version of
                        `apps/tv-vega/src/transport/MqttChannel.ts`, 2026-09-16).
                     2. Built the server side on 2026-10-11 and read "Connecting to AWS IoT Core
                        by using custom authentication" to write the authorizer.
                     3. Found, under "MQTT over WebSockets": credentials may go in the HTTP upgrade
                        request or in the MQTT CONNECT, and *"If you pass credentials through the
                        MQTT connect message, the ALPN and SNI TLS extensions are required."*

**Expected:**        That `username`/`password` in CONNECT, which the same page documents for MQTT,
                     would work over a WebSocket too — the page lists it as one of the two ways.

**Actual:**          A WebSocket opened from JavaScript — a browser's, React Native's, Vega's —
                     has no way to set ALPN; the runtime negotiates it. So for every JavaScript
                     client the second way does not exist, and the token must travel in the
                     upgrade request's query string. Nothing on the page says which clients can
                     use which way. The client as first written could never have connected, and
                     no test without a real broker could show it.

**Severity:**        Important — it silently invalidates the obvious client design, and is found
                     only by reading for it or by a refused connection with no reason given.

**Workaround:**      The token goes in the address (`…/mqtt?x-amz-customauthorizer-name=…&token=…`),
                     as it already does on the API Gateway WebSocket. The authorizer reads the
                     query string first and the MQTT password second, so a client that can set
                     ALPN still works (`services/edge-device/lambda/iot-policy.mjs` `tokenFrom`).

**Suggestion:**      1. Say it in the terms a developer searches in: "From a browser, React Native
                        or any WebSocket API that does not expose ALPN, pass credentials in the
                        query string or headers; username and password are not available."
                     2. Have the authorizer's refusal reach the client's error with a reason, at
                        least in a development mode. A bare close is the hardest thing to debug.

---

## FL-023 — The add-on docs name two MCP protocol versions, and only one of them is the one the client is shown sending

**Tool / API:**      Alexa+ MCP Toolkit docs — "Create an MCP Add-on" (quickstart) and "Alexa+ MCP
                     Client and App Lifecycle" (developer.amazon.com/docs/alexaplus/add-ons), read
                     2026-10-11

**Task attempted:**  Confirm which MCP protocol version an add-on's server must answer, so a
                     preflight could check Wick's server the way a deploy would meet it.

**Steps taken:**     1. Read the quickstart's hard requirements: MCP spec 2025-11-25, Streamable
                        HTTP. The hackathon rules name the same version.
                     2. Read the client lifecycle page for the exact `initialize` the Alexa+ client
                        sends. Its example request carries `"protocolVersion": "2025-03-26"`,
                        `capabilities: {"roots": {"listChanged": true}}` and
                        `clientInfo.name: "Alexa+ MCP Client"`; its example response echoes
                        `2025-03-26` and lists `tools` and `resources` capabilities.
                     3. Ran both against Wick's deployed server (`npm run addon:check -- --live
                        --demo`): it answers `2025-11-25` to a `2025-11-25` hello and `2025-03-26`
                        to a `2025-03-26` one, so either reading works here.

**Expected:**        One stated version, or a sentence saying the client negotiates down and which
                     versions a server must accept.

**Actual:**          Two pages, two versions, no sentence connecting them. A server built to the
                     letter of the quickstart on a framework that accepts only the newest version
                     would be told nothing was wrong until its first real `initialize`. The same
                     example response lists a `resources` capability with no statement of whether
                     a server that has no resources must advertise it.

**Severity:**        Important — it is the first message of every session, and the page that
                     shows it disagrees with the page that specifies it.

**Workaround:**      Answer both. Wick's server negotiates the version through the MCP SDK, and the
                     preflight says hello both ways and reports what came back
                     (`scripts/addon/preflight.ts`).

**Suggestion:**      1. State on both pages which protocol versions the Alexa+ client sends today
                        and which it accepts in reply.
                     2. Say whether `resources` (and any other capability in the example response)
                        is required or merely shown.
                     3. Publish the client's real `initialize` as a fixture developers can replay
                        against their own server — the web simulator does this for partners; a
                        JSON file would do it for everyone else.

---

## FL-022 — A Vega app can announce something while another app is in front, but every step of how is undocumented, and two of the documents say it cannot

**Tool / API:**      Vega SDK 0.24.12044 / Vega CLI 1.3.4 / Vega Virtual Device;
                     `@amazon-devices/react-native-kepler` 4.0.1 (`useToastKepler`,
                     `Linking`, `AppState`), the `NotificationManager` TurboModule,
                     `@amazon-devices/expo-notifications` 2.0.9000000000-rn-83

**Task attempted:**  Tell the resident somebody is at the door while they are in another
                     app or on the home screen. Until now a door card appeared only while
                     Wick itself was on screen (FL-014).

**Steps taken:**     1. Logged a heartbeat from the interactive component and pressed
                        Home. `AppState` reports `background`, one more tick runs, and
                        then nothing: timers and a chain of `fetch` calls both stop
                        within about five seconds. The process stays in
                        `vega device running-apps`.
                     2. Read the device log for how a system service gets started. The
                        notification renderer was launched by `servicergrd` when a
                        client connected ("service inactive; client connection
                        deferred … issuing launch request") and stopped fifteen seconds
                        later ("No clients connected to the service, terminating").
                        Nothing connects to `com.wick.tv.card.service`, which is why it
                        has never run.
                     3. Tried `vmsgr send pkg://com.wick.tv.card.service` from the dev
                        shell: `[com.amazon.apmf.SecurityError]: Missing privileges to
                        send message`.
                     4. Called `Linking.openURL('pkg://com.wick.tv.card.service')` from
                        the app, with `[[wants.service]]` for its own service in the
                        manifest. The service process started, and kept ticking after
                        Home and with another app in front — for the five minutes
                        watched.
                     5. Posted to the `NotificationManager` TurboModule with
                        `com.amazon.notification.privilege.post`. Information,
                        action-required and ongoing kinds, and `HIGH` importance, are
                        all refused: `No Permission Error`. The toast kind is accepted
                        and returns an id.
                     6. The accepted toast drew nothing, three times, in 24 screenshots.
                        The renderer launched and came to the foreground as an overlay
                        each time. Reading `useToastKepler`'s source gave the reason:
                        the channel's `name` has to be the render template
                        (`SimpleToastRenderTemplate` / `MenuToastRenderTemplate`). With
                        any other name the post succeeds and nothing is drawn.
                     7. With the template as the channel name, posted from the service
                        while another app was in front: the toast appears over it, and
                        the Menu button on it brings Wick forward.

**Expected:**        One page that says what a third-party app may show outside itself
                     and how to keep code running to do it. What exists says no:
                     - the expo-notifications page: "The library currently doesn't work
                       on the Vega Virtual Device", and not supported on React Native
                       0.83; the package's own `README.kepler.md`: "The library is not
                       currently supported on Kepler";
                     - the type definitions describe `isImportant` as "displayed on top
                       of the foreground app", with no word that an app may not use it;
                     - the headless overview's "Manually launch with this command:" is
                       followed by nothing, in every version from 0.21 to 0.24;
                     - `useToastKepler` is documented, but not whether a toast shows
                       when the app that posts it is not in front, or on the VVD.

**Actual:**          It works, on the simulator, with three undocumented facts:
                     an app starts its own service by sending its `pkg://` URI through
                     `Linking`; a started service outlives the app's time on screen,
                     where the app's own JavaScript does not; and a toast posted from
                     that service is drawn by the system over whatever is in front,
                     provided the channel is named after a render template. The
                     documented notification library is not needed, and the statement
                     that notifications do not work on the VVD is out of date for
                     toasts.

**Severity:**        Critical — this is the difference between an app that can tell
                     someone the doorbell rang and one that cannot, and the only way to
                     find it is to read the device log and the SDK's source.

**Workaround:**      Wick starts `com.wick.tv.card.service` each time it comes on
                     screen (`src/headless/launchCardService.ts`). The service holds a
                     second, background connection, and for a door card posts a toast
                     with an "Open Wick" button (`src/notify/doorToast.ts`) — and a
                     second one, with the picture from the door and what was seen
                     there, when the door agent's description arrives. The app
                     closes its own connection on `background`, so the server knows to
                     send to the service instead.

                     **What it costs:** a toast, not a card — one line, a small
                     picture, eight seconds, one button. Nothing starts the service
                     after a reboot until Wick has been opened once. How long the
                     platform leaves the service running is not known beyond the five
                     minutes watched, and none of this has been seen on hardware.

**Suggestion:**      1. **Document the route.** "To show something while your app is not
                        in front: start a service with `Linking.openURL('pkg://<service
                        component id>')`, post a toast from it." Three lines would have
                        saved three weeks of believing it impossible.
                     2. **Say what is stopped in the background and when.** The
                        AppState page says the process survives; it does not say the
                        JavaScript stops within seconds, which is the fact an app has to
                        design around.
                     3. **Fail a toast whose channel name is not a template.** Accepting
                        it, returning an id and drawing nothing is the same shape as
                        FL-016: a silent no.
                     4. **Name the privilege in the error.** `No Permission Error` for
                        an information notification does not say which privilege would
                        allow it, or that no third-party app can have it.
                     5. **Correct the VVD statement** on the notifications page, and
                        fill in the empty "Manually launch with this command:" line.
                     6. **Give a service a documented lifetime**: whether it is
                        restarted after a reboot or after the platform reclaims it, and
                        a way to ask for that.

---

## FL-021 — `useTVEventHandler` delivers different key names from the ones `HWEvent` documents

**Tool / API:**      Vega OS 1.2 / @amazon-devices/react-native-kepler 4.0.1 (`useTVEventHandler`,
                     `HWEvent` in `Libraries/TV/TVTypes.d.ts`), Vega Virtual Device, SDK 0.24.12044

**Task attempted:**  Pause, resume and skip Wick's own programme from the remote: Play/Pause or
                     OK toggles, Fast-forward and Rewind move 30 seconds.

**Steps taken:**     1. Wrote the handler against the names in `HWEvent`'s own doc comment and
                        type: `playpause`, `select`, `skip_forward`, `skip_backward`.
                     2. On the VVD nothing happened: the programme kept playing through
                        `inputd-cli button_press KEY_PLAYPAUSE` and `KEY_ENTER`.
                     3. Logged every event the hook delivered. `KEY_PLAYPAUSE` arrives as
                        `"play"`, `KEY_ENTER` as `"enter"`, `KEY_FASTFORWARD` as `"forward"`.
                        `KEY_RIGHT` arrives as `"right"`, as documented. Each press is two
                        events, `eventKeyAction` 0 then 1.

**Expected:**        The event names in the SDK's type and doc comment to be the ones the
                     platform sends, or the type to be a closed union so a wrong name fails to
                     compile.

**Actual:**          `eventType` is typed `... | string`, so any spelling compiles, and three of
                     the four media keys Wick needed are sent under names the doc comment
                     attributes to nothing (`play`, `enter`) or lists without saying which
                     button sends them (`forward`). `play` is not in the type's list at all.
                     The failure is silent: a remote that does nothing.

**Severity:**        Important — media keys are the first thing a video app wires, and the only
                     way to find the real names is to log them on a device.

**Workaround:**      `apps/tv-vega/src/watch/remoteKeys.ts` accepts both spellings of each key,
                     with a test naming the ones seen on the VVD.

**Suggestion:**      1. Document, per remote button, the exact `eventType` each Vega device and
                        the VVD sends, next to the `inputd-cli` key name that produces it.
                     2. Make `eventType` a closed union of the names really sent, and drop
                        `| string`, so a wrong name is a compile error.

---

## FL-019 — Ring's only simulator has no chime, so a chime integration can't be demonstrated without buying one

**Tool / API:**      Ring Developer Playground (released 2026-05-28); Ring Partner API Chimes,
                     `POST /v1/devices/{id}/media/audio/playback` (Chime Controls capability)

**Task attempted:**  Demonstrate M1 "Ring the hallway chime": a TV-remote button that plays the
                     app's slot audio on the household's Ring Chime.

**Steps taken:**     1. Built and tested the whole path against Ring's documented chime contract
                        (discovery by `audio.supported_actions` ∋ `chime.play`, slots from
                        `configurations`, playback, snooze/offline handling).
                     2. Looked for a chime to run it against without hardware. The Playground
                        account lists one simulated camera and nothing else, and its simulation
                        covers "Package, Vehicle, and Motion event types" and live view only
                        (release notes). Ring publishes no local emulator or SDK.
                     3. The only chime emulator found is a third-party project that Ring's
                        documentation does not list. The Ring track accepts only simulators
                        listed there, so it can't stand in for Ring in a submission.
                     4. Separately, the real linked account shows no devices to the app (FL-010),
                        so even a purchased chime is not certain to become visible.

**Expected:**        The Playground to simulate every device class the Partner API documents, or
                     at least those with write actions (chime playback), the way it simulates
                     camera events and live view.

**Actual:**          Chime playback, the API's only way to make a sound in the home, can be
                     exercised only with a physical Chime on a fully linked account.

**Severity:**        Important — a whole capability (Chime Controls) is untestable and
                     undemonstrable for anyone without the hardware, and it is the capability
                     that lets an app act in the home rather than only watch it.

**Workaround:**      Wick ships M1 built and contract-tested, and the TV draws the button only
                     when a chime exists, so a household without one never sees a dead button.
                     The demo shows Watch live instead.

**Suggestion:**      1. Add a simulated Chime to the Playground account, with the app's audio
                        slots populated and a visible or audible "played" indication.
                     2. Document how audio gets into an app's chime slot. The API exposes the
                        slots read-only and does not say who fills them.

---

## FL-018 — A Vega app without `com.amazon.mediatransform.service` in its manifest can't decode any video, and nothing says so until playback

**Tool / API:**      Vega OS 1.2 / @amazon-devices/react-native-w3cmedia 2.3.2 (`VideoPlayer`),
                     Vega Virtual Device, SDK 0.24.12044; `manifest.toml`

**Task attempted:**  M2 "Watch live": play the bridge's HLS (H.264 Constrained Baseline 3.1,
                     720p30, AAC, MPEG-TS over HTTPS through CloudFront) in the app's own player.

**Steps taken:**     1. The view reached its live phase (the playlist named segments), and the
                        screen stayed black: pure #000, so the video surface was drawn but
                        showed no frames.
                     2. `loggingctl` through `vega device run-cmd` returns only a few dozen
                        lines, and `journalctl` is refused in the developer shell; the full
                        log came only through `vega device start-log-stream` on the host.
                     3. The player emitted `loadstart`, `waiting`, then `error` (MediaError 3).
                        GStreamer: `kepler_viddec_hw_h264` "Could not create Transform",
                        `mediaxform_create failed`, `not-negotiated`.
                     4. Ruled out the stream: the same segment re-encoded to High profile
                        failed identically, as did a copy with SPS/PPS repeated on every
                        keyframe, and so did the public mux.dev test stream that had played
                        on this VVD in SP-1. A VVD reboot changed nothing.
                     5. Higher up the same log: `Binder: Unable connect to
                        'com.amazon.mediatransform.service'. Missing the permissions needed
                        to connect to the service.`
                     6. Added `[[wants.service]] id = "com.amazon.mediatransform.service"`:
                        the mux stream played at once.

**Expected:**        The build-time manifest validation (which runs, and reports "0 errors")
                     to warn that a package declaring `w3cmedia` and `media.server` but not the
                     transform service cannot decode video, or the player to report the
                     permission failure as such.

**Actual:**          Validation passes; at runtime the cause is one `err` line far above the
                     decode failure, and the app sees only "MediaError 3: Error Occurred." —
                     indistinguishable from a bad stream.

**Severity:**        Important — it looks exactly like a codec problem, so the natural next
                     steps (transcode, change profile, repeat headers) all waste time.

**Workaround:**      Declare the service; a test (`apps/tv-vega/src/__tests__/manifest.test.ts`)
                     now keeps it there. The live view also turns a player `error` into one
                     plain sentence instead of a black screen.

**Suggestion:**      1. Have manifest validation flag a `w3cmedia` app without
                        `com.amazon.mediatransform.service`.
                     2. Carry the permission failure into the MediaError message.
                     3. List the full service set video playback needs on the `VideoPlayer`
                        page (the vega-video-sample manifest is the only reference).

---

## FL-017 — A Bedrock AgentCore Runtime in PUBLIC network mode gets no outbound UDP, so it cannot receive Ring live video

**Tool / API:**      Amazon Bedrock AgentCore Runtime (container, `network_mode = "PUBLIC"`,
                     arm64), us-east-1; Ring Partner API WHEP; werift 0.24.4

**Task attempted:**  M2 "Watch live": run the WHEP-to-HLS bridge (SP-3) inside the household's
                     AgentCore Runtime session, next to the Strands graph that gates it.

**Steps taken:**     1. Deployed the runtime (`wick_agents`, image `cbd39fb`). `POST
                        /live/sessions` from the TV path: the graph passed, Ring answered the
                        WHEP offer `201` in ~1.5s.
                     2. No RTP ever arrived; ffmpeg hit its 10s UDP read timeout, 0 segments.
                     3. Logged the peer from inside the microVM: the offer held only `host`
                        candidates, never `srflx`, and the connection sat at `connecting` for
                        20s, then closed.
                     4. The identical code from a laptop on the same camera, minutes apart:
                        `host,srflx,host,srflx`, connected, 1,173 video RTP packets in 9s.
                     5. A one-shot STUN probe (UDP to stun.l.google.com:19302) from a plain
                        nodejs22 arm64 Lambda in the same account: answered in 202ms.

**Expected:**        "PUBLIC" network mode to mean general internet egress, or the
                     restriction to be documented (it is the deciding fact for any agent that
                     touches WebRTC, SIP, RTP, QUIC or DNS-over-UDP to a custom resolver).

**Actual:**          HTTPS out works (Ring's API, Bedrock, S3, DynamoDB all fine); UDP out gets
                     no answer. Nothing fails loudly: the STUN request simply isn't answered, so
                     WebRTC degrades into a connection that never leaves `connecting`. Ring's
                     RTSP bridge is no way round it — its media is SRTP over UDP too.

**Severity:**        Important — it rules out real-time media in the agent runtime, and it
                     surfaced only as a 10-second silence two layers away from the cause.

**Workaround:**      The Strands graph stays in AgentCore and keeps the decision (who may watch,
                     one stream per household); the media bridge itself moves to a Lambda,
                     which does get UDP (step 5) — the design's original home for it.

**Suggestion:**      1. Document AgentCore Runtime's egress: which protocols and ports PUBLIC
                        mode permits.
                     2. If UDP is deliberately blocked, fail the socket send (EPERM/EACCES)
                        rather than drop silently, so libraries report it.
                     3. Offer UDP egress as an opt-in (or document VPC mode + NAT as the way
                        to get it) for agents that handle real-time media.

---

## FL-016 — Vega's media player silently refuses a cleartext HLS URL: no request, no error, a black rectangle

**Tool / API:**      Vega OS 1.2 / @amazon-devices/react-native-w3cmedia 2.3.2 (`VideoPlayer`),
                     Vega Virtual Device, SDK 0.24.12044

**Task attempted:**  Play a live HLS stream produced by Wick's WHEP-to-HLS bridge (SP-3) in
                     the app's own `VideoPlayer`, served from the development machine.

**Steps taken:**     1. Confirmed `VideoPlayer` plays public HLS over **https** on the VVD
                        (`test-streams.mux.dev`, H.264 + AAC in MPEG-TS): `timeupdate` events
                        advance, picture on screen.
                     2. Served the bridge's own output over **http** at `http://10.0.2.2:8790/`,
                        then — to rule out the live edge — a fixed copy of the same segments
                        as a VOD playlist at `http://10.0.2.2:8791/vod.m3u8`.
                     3. `vega device run-cmd "curl http://10.0.2.2:8791/"` from the VVD itself
                        returns 200, so the host is reachable from the device.
                     4. Relaunched the app against each URL with request logging on the
                        server.

**Expected:**        Either playback, or an `error` event / log line naming the reason —
                     "cleartext not permitted", as Android's network-security config says.

**Actual:**          The player never makes a request. The server log shows only the
                     developer's own curl. The device log shows `render KeplerVideoSurfaceView`
                     and periodic `hasEnded: 0`, and nothing else from `W3CMEDIA` — no
                     fetch, no error, no warning. The screen shows a black rectangle.

**Severity:**        Important — a local development loop (a Mac serving HLS to the VVD) is the
                     obvious first thing anyone building live video tries, and it fails with
                     no signal at all. Blocking HTTP is a reasonable default; failing silently
                     is not.

**Workaround:**      Serve HLS over HTTPS only (the bridge ships behind TLS in AWS). Local
                     testing needs a trusted certificate, which the VVD's trust store does not
                     make easy either.

**Suggestion:**      1. Emit a `MediaError` (and a log line) naming the policy when a URL is
                        refused for its scheme.
                     2. Document the cleartext policy on the `VideoPlayer` page, with a
                        development-only manifest opt-in for `http://10.0.2.2`.

---

## FL-015 — `@amazon-devices/webview` 4.0.2 segfaults on mount on the Vega Virtual Device — including Amazon's own `vegaWebview` template

**Tool / API:**      @amazon-devices/webview 4.0.2 (`libkeplerscript-webview-lib-2.so`),
                     Vega Virtual Device (Apple Silicon, `sim_tv_aarch64`), SDK 0.24.12044,
                     Vega CLI 1.3.4

**Task attempted:**  SP-3 — run a WHEP (WebRTC) client inside a Vega `WebView`, since Vega has
                     no WebRTC module for React Native, so "Watch live" could show the Ring
                     doorbell in under a second.

**Steps taken:**     1. Proved the WHEP path itself first: a page in desktop Chromium, SDP
                        relayed through a local server holding the Ring token, played the Ring
                        Playground camera live at 1280x720 in 5.6s.
                     2. Added `@amazon-devices/webview@4.0.2` and
                        `/com.amazon.kepler.webview_4@IWebview_4` to Wick, rendered a
                        full-screen `WebView` at that page. The app crashed on launch:
                        `SIGSEGV`, `libkeplerscript-webview-lib-2.so.2.0 + 0x2471ba`, on the
                        JS thread, right after `applyWebEngineFlagsWebView switches applied
                        successfully`.
                     3. Added everything "Set Up your Vega Web App" lists (media, DRM,
                        `com.amazon.gipc.uuid.*` wants/offers, file-sharing privilege). Same
                        crash, same offset.
                     4. Reduced to `<WebView source={{uri:'https://example.com/'}} />`. Same.
                     5. Generated Amazon's own template (`vega project generate --template
                        vegaWebview`), noticed it also declares
                        `com.amazon.webview.renderer_service` — which the setup page never
                        mentions — added that to Wick. Same crash.
                     6. Built and ran the **unmodified template**. Same crash, same offset.

**Expected:**        The platform's own WebView template to run on the platform's own
                     simulator, as the release notes for 0.24 describe WebView 4.0.x (Chromium
                     144) as shipping for RN 0.83.

**Actual:**          Every WebView — Wick's or Amazon's, any URL, any props — kills the process
                     on mount on the VVD. No JS error surfaces; the only evidence is an ACR
                     crash dump in the device log.

**Severity:**        Critical for anyone building a web app or a WebRTC feature on the
                     simulator; Important for Wick, which moved Watch Live to a cloud bridge.

**Workaround:**      Watch Live bridges Ring's WHEP stream to HLS in the cloud and plays it in
                     the native `w3cmedia` `VideoPlayer`, which does work on the VVD (SP-1).
                     Costs ~5s of latency against sub-second WebRTC.

**Suggestion:**      1. Fix or document the VVD WebView crash; the template is the first thing
                        a web developer runs.
                     2. Put `com.amazon.webview.renderer_service` on the setup page — the
                        template needs it and the docs don't say so.
                     3. Ship a WebRTC module for Vega React Native (or confirm WebView's
                        `RTCPeerConnection` on hardware). Ring's own live API is WebRTC; today
                        a Fire TV app cannot show a Ring camera without a server in between.

---

## FL-014 — Fixing FL-013's symptom exposed the real one: `card.service` never launches as a process at all, and there is no locally-discoverable manifest field that makes it

**Tool / API:**      Vega manifest schema (`[[components.service]]`, `[offers]`) /
                     `@amazon-devices/headless-task-manager` 1.x / Vega CLI 1.3.4,
                     SDK 0.24.12044

**Task attempted:**  Prove the full demo path end to end on the paired VVD from
                     FL-013: a real Ring doorbell event → webhook → Door
                     agent → device channel → a card actually rendering on
                     screen. `scripts/test-ring-webhook.sh` against a real
                     Ring Playground device confirmed the card gets queued
                     server-side (`CARD# exists: true`); it never appeared
                     on the TV.

**Steps taken:**     1. Traced why: `CardService.ts`'s `onStartCardService()`
                        (a separate `card_service` process, by design, so a
                        UI crash can't drop the channel) calls
                        `pairing.loadToken()`, which only ever reads the
                        same broken `/data/wick-token.json` FL-013
                        documents — and `card_service` never calls
                        `start()`/`pollUntilBound()` itself, so it has no
                        in-memory fallback the way `App.tsx`'s own process
                        does. Two genuinely separate processes with no
                        shared JS memory means the main process reaching
                        `'ready'` says nothing about whether `card_service`
                        ever got a token.
                     2. Fixed that half for real: `PairingFlow.loadToken()`
                        now takes an optional `deviceId` and falls back to a
                        new `POST /pair/refresh {deviceId, householdId}`
                        endpoint when disk has nothing — using the same
                        durable `HH#{householdId}/DEV#{deviceId}` binding
                        `pair-claim.mjs` already writes, so the server (not
                        this device's broken local disk) is the actual
                        source of truth for "is this device paired." Also
                        wrapped the disk read itself in try/catch — it was
                        the one call in this file FL-013 never guarded,
                        and an uncaught rejection from a headless entry
                        point's async function is a plausible match for a
                        native `abort()`.
                     3. Deployed (`terraform apply`) and verified live with
                        curl against the real endpoint: 404
                        `device_not_paired` for an unknown device, 200 with
                        a fresh JWT for the already-bound `wick-tv`. Rebuilt
                        the app, reinstalled, relaunched — **confirmed**:
                        the pairing screen no longer appears at all on
                        relaunch; the app goes straight to `'ready'`. This
                        part is real, tested (5 new unit tests across
                        `PairingFlow.test.ts`/`CardService.test.ts`), and
                        shipped. **This same fix has a security cost, fully
                        documented and mitigated in AGENTS.md under INV-1**:
                        `/pair/refresh` mints from `{deviceId, householdId}`
                        alone, with no proof of possession, precisely because
                        the broken `/data` this entry is about leaves no
                        other way for `card_service` to prove it's the real
                        device. A real proof-of-possession scheme is blocked
                        by the same storage bug (nothing to persist a keypair
                        into) — a platform bug forcing a security trade-off
                        in application code, not just a workflow one.
                     4. The card still didn't render. `vega device
                        running-apps` after launch listed only
                        `com.wick.tv.main` — `com.wick.tv.card.service`
                        never appears, and grepping the full device log
                        since launch shows zero `LaunchComponent` requests
                        for it, ever, across every relaunch this session.
                        `onStartCardService()` never runs at all; the
                        token-loading fix above is necessary but provably
                        not sufficient.
                     5. Found `[offers]` only declared
                        `com.wick.tv.content.dataRefresh.provider`, never
                        `com.wick.tv.card.service` — added the matching
                        `[[offers.service]]` entry (manifest validates
                        clean, 0 errors). Rebuilt, reinstalled, relaunched:
                        still zero `LaunchComponent` requests for
                        `card.service`, still absent from `running-apps`.
                        Not the (or not the only) missing piece.
                     6. A separate, already-half-applied lead from earlier
                        this session turned out to be a real, documented fix
                        for something adjacent: `package.json`'s
                        `kepler.useSystemJsBundlesForHeadlessJs: false` —
                        Amazon's own SDK 0.24 release notes name a known
                        issue, "headless tasks crash on React Native 0.83,"
                        for any app with a `[[components.task]]`/
                        `[[components.service]]` in its own process group
                        (this manifest has four), symptoms including
                        `ReferenceError: Property '__DEV_RUNTIME__' doesn't
                        exist` and **"data isn't synced"** — a strong match
                        for this session's `IoError`. It had been added to
                        `package.json` but never verified with a clean
                        rebuild. Cleared `build/` and ran `--reset-cache
                        --reset-global-cache`; confirmed via the build log
                        ("Building split bundle for index.js") that the flag
                        now actually takes effect, where it hadn't in this
                        session's earlier builds (2-4), which silently reused
                        stale cached headless bundle artifacts from before
                        the flag was set. Reinstalled, relaunched: the
                        specific native log line this entry and FL-013 both
                        quote, "Application data root path is not set,"
                        no longer appears at all — but `writeStringToFile`
                        still rejects with the same bare `IoError`
                        (`pairing_token_persist_failed` still logs, this
                        time from a real `/pair/refresh` fallback token),
                        and `card.service` still never launches. A real
                        fix for a real, named, adjacent bug — not this one.
                     7. Looked for a working reference before guessing
                        further: `vega project list-templates` offers
                        `helloWorld`, `helloWorld-rn72`, `basic-turbo-module`,
                        `idl-turbo-module`, `vegaWebview` — none include a
                        `[[components.service]]` example. No generated
                        reference project with a working service survived
                        from FL-011/FL-012's session. `@amazon-devices/
                        headless-task-manager`'s own README documents
                        *registering* an entry point
                        (`registerHeadlessEntryPoint2`) in full, but says
                        nothing about what actually triggers the platform to
                        spawn the process that entry point lives in.
                     8. Separately, tried the *other* advisory the build
                        surfaced for this same component
                        (`vpt`'s own info-level suggestion to use
                        `/com.amazon.kepler.headless.runtime.loader_2@
                        IKeplerScript_2_0` instead of
                        `react_native_kepler_4@IReactNativeKepler_0` for
                        `card.service`/`dataRefresh.provider`, "for better
                        memory optimization"). This **hard-fails**
                        validation instead: "Inconsistent runtime module
                        versions found... All runtime modules declared must
                        use the same version" — `com.wick.tv.main` is a real
                        interactive UI component and cannot run under that
                        loader, so a manifest mixing interactive and
                        headless-service components (which this one
                        necessarily does) can never satisfy vpt's own
                        advisory without violating vpt's own hard
                        constraint. Reverted; documented inline in
                        manifest.toml.

**Expected:**        That declaring a `[[components.service]]` in its own
                     `[[processes.group]]`, registering its headless entry
                     points, and (per step 5) offering it under `[offers]`
                     would be sufficient for the platform to launch it
                     alongside — or lazily on behalf of — the package's
                     interactive component, the same way `com.wick.tv.main`
                     launches from its own `[[offers.module]]` +
                     `[[message]]` pair.

**Actual:**          None of that launches it. Something else — a second
                     `[[offers.module]]`/`[[message]]` pair specifically for
                     `card.service` (mirroring `com.wick.tv.main`'s), an
                     explicit native "start this sibling component" call
                     from `App.tsx`, a `[[wants.service]]` on the consuming
                     side, or a manifest field not covered by anything
                     locally available — is required, and none of the
                     locally-available SDK docs, templates, or package
                     READMEs name it.

**Severity:**        Critical while open (worked around 2026-09-30, see below) — the entire live card-delivery
                     path (the product's actual core loop: a real doorbell
                     event reaching the TV) is unreachable on this VVD
                     regardless of pairing state, independent of and
                     downstream from FL-013. The pairing-persistence fix in
                     this same entry is real and shipped; it just isn't the
                     last blocker it looked like from `App.tsx`'s side alone.

**Workaround:**      **Found and verified 2026-09-30: stop depending on the
                     service.** The channel logic moved out of
                     `CardService.ts` into a process-agnostic
                     `startCardChannel()`/`holdCardChannel()`
                     (`apps/tv-vega/src/transport/startCardChannel.ts`), and
                     `App.tsx` now holds the channel itself once pairing
                     reaches `'ready'`, writing into the same `QueueStore`
                     instance its render loop reads. `QueueStore` became
                     memory-first so FL-013's broken `/data` can no longer
                     eat a card between arrival and render.
                     `card_service` still runs the same code wherever the
                     platform does launch it.

                     **Verified live on the VVD, same session:** WebSocket
                     `$connect` recorded for `wick-tv` 2s after launch (the
                     first successful connect from this VVD); a real
                     Message card replayed by reconcile rendered; a button
                     press made the full round trip (`card_action` on the
                     timeline, `actedAt` stamped on the CARD# item); and a
                     signed webhook for the Ring Playground doorbell put
                     **"Someone's at the front door."** on screen, device
                     `card_shown` ~4.9s after the event (first invocation
                     after a deploy, so including a Lambda cold start).

                     **What it costs:** cards only arrive while Wick is on
                     screen — the background half of §3.1 (a card reaching
                     the device while another app is in front) stays
                     unreachable until the platform launches the service.
                     For a card that must interrupt another app that was
                     never possible anyway (SP-1, `WICK.md` R1).

**Suggestion:**      1. **Document what actually starts a
                        `[[components.service]]` process.** The manifest
                        schema accepts the declaration, `vpt validate`
                        passes it clean, and the SDK gives no error or log
                        line explaining why it never runs — structurally the
                        same "accepted but inert, with nothing pointing at
                        why" shape as FL-005/FL-006/FL-011.
                     2. **Make an offered-but-never-launched service
                        diagnosable.** `vega device running-apps` and the
                        device log give zero signal that `card.service` was
                        even considered — not a rejection, not a crash, just
                        silence indistinguishable from "correctly idle."
                     3. **Reconcile `vpt`'s own advisory and hard
                        constraint** for the headless-runtime-loader
                        suggestion (step 8) — it is actively wrong for any
                        manifest that mixes interactive and headless-service
                        components, which is the normal shape for an app
                        like this one (a UI plus a background channel
                        holder), not an edge case.
                     4. Ship the sample this session couldn't find: a
                        minimal template or reference project with one
                        interactive component and one real
                        `[[components.service]]` that actually starts, the
                        way `helloWorld` already does for the interactive-
                        only case.
                     5. **Say what `useSystemJsBundlesForHeadlessJs: false`
                        does and does not fix.** It is real and it changed
                        real, observable behavior (step 6) — but "headless
                        tasks crash" and "a `[[components.service]]` never
                        launches at all" read, from the release notes alone,
                        like the same problem. They are not. A one-line note
                        distinguishing them would have saved this session an
                        experiment that was reasonable to try but always
                        going to fail.

---

## FL-013 — `IKeplerFileSystem` never provisions a data root for this package on the VVD, so every write silently fails and stalls the pairing screen forever

**Tool / API:**      `@amazon-devices/kepler-file-system` 0.0.7 / Vega Virtual Device
                     (`vega device` CLI 1.3.4, SDK 0.24.12044)

**Task attempted:**  Pair a real Vega app instance end to end: `POST /pair/start`
                     on the TV, claim the code from `docs/pair/` in a browser
                     (confirmed working — see the claim page's own 200 response),
                     then watch the TV's `PairingFlow.pollUntilBound` pick up the
                     bound token and transition `App.tsx` from the pairing screen
                     to `'ready'`.

**Steps taken:**     1. Reproduced the report ("the claim page says Connected,
                        but the TV never finishes setting up") by relaunching
                        `com.wick.tv.main` under `vega device start-log-stream`.
                     2. Every launch logs, repeatedly, from both the `main` and
                        `card_service` processes:
                        `ERROR com.amazon.keplerscript: [KeplerScript-Native]
                        Application data root path is not set.`
                     3. Confirmed this is not cosmetic: `vega device run-cmd
                        --command 'ls -la /data'` shows the app's data
                        directory completely empty — not `wick-token.json`
                        (`PairingFlow.ts`), not `wick-deviceId.json`
                        (`OnInstallTask.ts`, which runs on every install and
                        should have written one), nothing.
                     4. Ruled out a stale/corrupt install before assuming it
                        was environmental, same discipline as FL-012: full
                        `vega device reboot` (device came back, `/data` still
                        empty) and a clean `uninstall-app` + `install-app`
                        of a same-session `npm run build` package (still
                        empty, same repeating error from a fresh pid).
                     5. Traced the actual failure this causes:
                        `PairingFlow.pollUntilBound` awaits
                        `fs.writeStringToFile(TOKEN_PATH, ...)` unguarded, on
                        the success path, *after* the server has already
                        confirmed the claim. When that write rejects, the
                        whole `pollUntilBound()` promise rejects; `App.tsx`'s
                        outer `catch` only records `debugError` — it never
                        calls `setScreen({ kind: 'ready' })`. A real,
                        server-confirmed pairing therefore leaves the device
                        stuck on the pairing screen indefinitely, with no
                        indication to the person on the TV that anything
                        went wrong on their end (because nothing did).

**Expected:**        That declaring `/com.amazon.kepler.kepler_file_system_0
                     @IKeplerFileSystem_0` under `[needs.module]` (manifest.toml,
                     confirmed valid by `vpt`'s own manifest validator: "0
                     errors") is sufficient for `/data` to be a writable,
                     package-scoped directory, per the package's own README.

**Actual:**          The module loads and the calls don't throw a
                     module-not-found error — they throw a **data-root**
                     error, meaning the OS/package-manager side of the
                     provisioning (whatever assigns this package a concrete
                     backing directory under `/data`) never ran, independent
                     of the manifest declaration being valid. Reboot and
                     reinstall both rule out "stale state" as the cause.

**Severity:**        Critical while open — no on-device state (the pairing
                     token, the device id, the Rhythm sync cursor, the queue)
                     can survive an app restart, and until now it silently
                     converted a successful pairing into an infinite hang
                     with zero operator-visible signal.

**Workaround:**      Made token persistence best-effort instead of load-bearing
                     for the pairing handshake: `PairingFlow.pollUntilBound`
                     now wraps the `writeStringToFile` call in `try/catch`,
                     logs (`pairing_token_persist_failed`) and still resolves
                     with the token the server already confirmed. The device
                     reaches `'ready'` immediately; it will just re-pair on
                     the next relaunch until the underlying data-root issue
                     is fixed, which is a recoverable, visible failure mode
                     instead of a silent, permanent one. Added a regression
                     test (`PairingFlow.test.ts`, "resolves with the token
                     even when persisting it fails") reproducing the exact
                     rejection observed on-device.

                     **Verified live, end to end, same session:** relaunched
                     `com.wick.tv.main` under `start-log-stream`, read the
                     fresh pairing code (`434912`) off the VVD window, and
                     claimed it with the exact same `POST /pair/claim` call
                     `docs/pair/index.html` makes (`{"ok":true}`). The device
                     log shows the claim land three seconds later —
                     `[KeplerScript-JavaScript] 'pairing_token_persist_failed',
                     { message: '[com.amazon.kepler.io.IoError]: ' }` logged,
                     not thrown — immediately followed by the pairing
                     screen's mount tearing down (`SurfaceTelemetryLogger`
                     mutations 11→21, transactions 2→3) and the app settling
                     on a stable `'ready'` frame with zero further
                     `keplerscript` errors of any kind. A real,
                     server-confirmed pairing now reaches `'ready'` on this
                     VVD, which it did not before this fix.

                     One correction to this entry's own diagnosis surfaced by
                     that same session's diagnostic overlay (App.tsx, mount-
                     time probe): **the failure is not `/data`-specific.**
                     `/tmp/wick-test.json` fails with the identical bare
                     `com.amazon.kepler.io.IoError` as `/data/wick-test.json`
                     — whatever is unprovisioned affects every writable root
                     this package can reach, not only the one this entry's
                     title names. The root cause is therefore broader than
                     "no data root" and still open; the Suggestion section
                     below is updated to match.

                     Per this entry's own Suggestion #3, applied the identical
                     try/catch-and-log treatment to the two other on-device
                     writes flagged as sharing this gap: `OnInstallTask.
                     loadOrCreateDeviceId` (`device_id_persist_failed`) and
                     `RhythmSyncTask.doRhythmSync`'s cursor write
                     (`rhythm_sync_cursor_persist_failed`). Both keep their
                     already-produced result on a write failure — the
                     generated device id, the already-enqueued outbound
                     events — rather than losing it to an unrelated /data
                     fault. Regression tests added to both suites
                     (`OnInstallTask.test.ts`, `RhythmSyncTask.test.ts`)
                     reproducing the same rejection. All three call sites
                     this entry named are now closed.

**Suggestion:**      1. **Make "Application data root path is not set" a
                        package-manager-level install/launch error, not a
                        buried native runtime log line** — a manifest that
                        validates with "0 errors" but still can't actually
                        back a single writable path gives a developer nothing
                        to act on except grep-ing device logs.
                     2. **Document what actually provisions a package's
                        writable storage** — it is evidently not just
                        declaring `IKeplerFileSystem` in `[needs.module]`,
                        and it is not scoped to `/data`: `/tmp` fails with
                        the identical bare `com.amazon.kepler.io.IoError` on
                        this same VVD instance. Something else (a CLI
                        provisioning step? a VVD image limitation? a second
                        manifest field?) is missing, and nothing in the
                        locally-available SDK docs names it.
                     3. ~~Treat any `KeplerFileSystem` write on a success
                        path as untrusted in this codebase until this is
                        resolved~~ — done. `PairingFlow`, `OnInstallTask` and
                        `RhythmSyncTask` all now catch, log, and keep the
                        result they already had rather than rejecting. Live-
                        verified end to end for `PairingFlow` this session
                        (see Workaround); the other two follow the identical,
                        already-proven pattern.

---

## FL-012 — A custom Metro `resolveRequest` silently discarded the Vega SDK's own package-redirection resolver, crashing the app on every single launch

**Tool / API:**      Metro 0.83.8 / `@react-native/metro-config` 0.83.0 /
                     `@amazon-devices/react-native-kepler` 4.0.1+rn0.83.0

**Task attempted:**  Get the real Wick app to actually *run* on the Vega
                     Virtual Device, not just install (FL-011 fixed the
                     install; this is what was still crashing it on launch
                     immediately after).

**Steps taken:**     1. FL-011's icon fix made `vpm install` succeed, but
                        `vega device is-app-running` showed `com.wick.tv.main`
                        was never actually running after launch — no visible
                        error on device, just silently dead.
                     2. `vega device get-log-info` listed 23
                        `SYSTEM_TOMBSTONE` crash reports, all
                        `com_wick_tv.acr`, confirming it crashed on every
                        single launch attempt, not intermittently.
                     3. Ruled out a systemic/SDK-wide cause before assuming
                        it was ours: launched the same known-good
                        `helloWorld` reference project on the identical VVD
                        instance — `is-app-running` confirmed it stayed up.
                        Whatever was wrong was specific to this app.
                     4. Read the raw crash report:
                        `CrashLang:JavaScript`, `CrashReason:SIGABRT`,
                        `TypeError: Cannot read property 'select' of
                        undefined`, thrown deep inside a chain of
                        `metroRequire`/`loadModuleImplementation` frames —
                        useless on its own, since it's a hashed, minified
                        bundle filename with matching line/column numbers
                        that mean nothing without a source map.
                     5. Found the matching `.bundle.map` still present next
                        to the (already-superseded) hashed bundle in
                        `build/lib/rn-bundles/Release/`, and ran the crash's
                        stack trace through `metro-symbolicate` (already a
                        transitive devDependency — no new tooling needed)
                        against it. That produced real file paths: the crash
                        was inside `node_modules/react-native/Libraries/
                        ReactNative/BridgelessUIManager.js`, reached via
                        `AppContainer`/`renderApplication` — code every
                        registered RN app goes through unconditionally, not
                        anything specific to this app's own source.
                     6. Read the actual crashing line in the installed
                        package: `Platform.select({...})`, where `Platform`
                        was `undefined` — traced to
                        `import Platform from '../Utilities/Platform'` at
                        the top of that file. Confirmed plain
                        `node_modules/react-native/Libraries/Utilities/`
                        only ships `Platform.ios.js` / `Platform.android.js`
                        / a generic `Platform.js` that is a **self-importing
                        back-compat stub** (`import Platform from
                        './Platform'` — recursing into itself, never meant
                        to be the real resolution) — while the actual Vega
                        implementation, `Platform.kepler.js`, exists only
                        inside `@amazon-devices/react-native-kepler`'s own,
                        entirely separate copy of the `Libraries/` tree.
                     7. Root cause: `apps/tv-vega/metro.config.js` (added
                        this session, see FL-011's predecessor commit)
                        called `getDefaultConfig(projectRoot)` and then
                        supplied its own `resolver.resolveRequest` to handle
                        this codebase's TypeScript-NodeNext `.js`-extension
                        imports — without first checking whether
                        `getDefaultConfig()`'s own return value already had
                        one. It did: dumping the resolved config directly
                        (`typeof cfg.resolver.resolveRequest`) showed a real
                        function, not `undefined` — almost certainly the
                        Vega SDK's own logic for redirecting `react-native`
                        package-internal requires to
                        `react-native-kepler`'s tree. `mergeConfig` cannot
                        merge two functions, so the custom one silently
                        replaced it outright. The custom resolver's own
                        fallback path called `context.resolveRequest`
                        (Metro's generic built-in resolver, always present
                        on the context object regardless of config) instead
                        of the SDK's actual default — which looks identical
                        in every case *except* this one, since Metro's
                        generic resolver has no idea `react-native`'s own
                        internals need redirecting to a sibling package.
                     8. Fix: capture `getDefaultConfig(projectRoot).resolver.
                        resolveRequest` into a variable *before* overriding
                        it, and delegate to that captured function (falling
                        back to `context.resolveRequest` only if it's
                        genuinely absent) instead of always using
                        `context.resolveRequest`. Rebuilt — bundle size
                        dropped from ~5.8MB to ~2.6MB (real react-native's
                        own duplicated internals were no longer being
                        bundled wholesale) — reinstalled, and
                        `is-app-running` confirmed the app now launches and
                        stays running, with zero new crash reports.

**Expected:**        That extending `getDefaultConfig()`'s resolver with one
                     additional rule (via the documented `resolveRequest`
                     override pattern) would compose with whatever the SDK
                     already configured, the same way `mergeConfig` composes
                     every other resolver field.

**Actual:**          `resolveRequest` is a single function slot, not a list —
                     supplying one silently discards whatever
                     `getDefaultConfig()` already provided, with no warning
                     at config-load time, build time, or install time. The
                     failure surfaces only as a runtime crash deep inside
                     React Native's own internals, symbolication required to
                     even locate it, several build/install cycles removed
                     from the actual mistake (a five-line metro.config.js
                     addition from an earlier session).

**Severity:**        Critical while open — it crashed the app on literally
                     every launch, with no on-device error message a
                     developer could act on, and the true cause (a resolver
                     override pattern that looks correct and is
                     copy-pasted from real-world Metro monorepo guides
                     constantly) is nowhere near where the symptom appears.
                     Resolved this session.

**Workaround:**      N/A — root-caused and fixed.

**Suggestion:**      1. **Document, in `getDefaultConfig()`'s own reference
                        page, that its returned `resolver.resolveRequest` is
                        load-bearing and must be captured and delegated to,
                        not just overridden** — this is a generic Metro
                        footgun made specifically dangerous on Vega because
                        the default resolver is doing real platform-package
                        redirection work, not just convenience.
                     2. **Make the missing redirection fail loudly.** A
                        `Platform.select is not a function` (or better, a
                        Vega-specific "no kepler variant found for
                        Libraries/Utilities/Platform") at bundle time, or at
                        minimum a non-generic crash reason on device, would
                        have turned a multi-hour investigation into a
                        five-minute one.
                     3. **Ship `metro-symbolicate` (or an equivalent
                        one-command wrapper) as a documented, discoverable
                        step in the crash-triage docs.** It already exists
                        as a transitive dependency and did the actual work
                        here; nothing in the Vega docs pointed at it.

---

## FL-011 — First real `vega build` gets the app packaging correctly; the VVD's own installer then rejects the package with no diagnosable reason

**Tool / API:**      Vega CLI 1.3.4 / SDK 0.24.12044 (`react-native build-vega`,
                     `vpt validate`, `vpm install` on the Vega Virtual Device)

**Task attempted:**  Get `apps/tv-vega` actually building and running for the
                     first time — SP-1 (render-over-playback) and SP-8
                     (real hardware / VVD insurance) both need a working
                     build before either can be answered. This session was the
                     first time anyone had run this repo's app code through
                     the real Vega CLI rather than against sample-repo docs.

**Steps taken:**     1. `vega project doctor` found the manifest genuinely
                        broken: a `[[message]]` block with no owning
                        `[[offers.module]]` (`MessageRouterSyntaxError`) —
                        fixed per the SDK's own
                        `messaging-UserGuide.md`. Also found `kepler` was
                        missing entirely from `package.json` (`projectType`
                        required), and the build/start scripts
                        (`kepler bundle` / `kepler run`) were the CLI's
                        pre-rebrand alias names — `bundle` and bare `run`
                        don't exist in the CLI surface at all.
                     2. Generated a real reference project
                        (`vega project generate --template helloWorld`) to
                        get ground truth instead of guessing, and found this
                        repo's own comment — "react-native-kepler IS the
                        React Native fork... do NOT also install
                        `react-native`" — is wrong. The reference project
                        depends on both, pinned `react-native@0.83.0`
                        alongside `@amazon-devices/react-native-kepler`, and
                        imports `AppRegistry`/`View`/etc. from `react-native`
                        directly.
                     3. Fixed in order to get `react-native build-vega` to
                        run at all: added the missing `@amazon-devices/
                        kepler-cli-platform` devDependency (it's what
                        registers the `build-vega` command on the
                        `react-native` CLI — without it, `build-vega` is
                        "unknown command"); added `@babel/runtime`; added
                        Metro `watchFolders`/`nodeModulesPaths` (Metro's
                        default config only looks in this package's own
                        `node_modules`, not the npm-workspaces root, so every
                        hoisted dependency failed to resolve); added a
                        `resolveRequest` override so Metro would resolve this
                        codebase's TypeScript-NodeNext-style `.js`-extension
                        relative imports (`from './config.js'` for a real
                        `config.ts`) to their real `.ts`/`.tsx` files — Metro
                        treats an explicit extension as final and doesn't
                        retry `sourceExts` the way `tsc`/Node's ESM resolver
                        do, so every relative import in the app was affected;
                        forced `react-native` to `0.83.0` everywhere via a
                        root `package.json` `overrides` — several
                        `@amazon-devices/*` packages (headless-task-manager,
                        kepler-content-personalization, kepler-media-controls,
                        kepler-cli-platform, react-native-w3cmedia) declare a
                        loose peer dep that resolves to `0.87.1` on the
                        public registry, which ships Flow syntax the pinned
                        Hermes/Metro 0.83 toolchain can't parse, while
                        `react-native-kepler` itself is explicitly built
                        against `0.83.0` (`4.0.1+rn0.83.0`).
                     4. `react-native build-vega --build-type Release` then
                        succeeded end to end — valid `.vpkg` for all three
                        architectures, `manifest.toml` valid, 0 errors.
                     5. `vega run-app ... --deviceId VirtualDevice` failed:
                        `Package is invalid`. `vpt validate <the .vpkg>`
                        first caught a real, separate issue — `build_number
                        must be greater than 0` (manifest.toml's own
                        `[package].build_number` field is accepted by the
                        parser but silently ignored by packaging; only
                        `--build-number` on `react-native build-vega` itself
                        actually sets it) — fixed, and `vpt validate` then
                        passes clean ("done.", no errors).
                     6. `vpm install <path> --force` on the VVD still failed
                        with the identical `Package is invalid`, and
                        `vpm print <path> --manifest` showed the correct,
                        well-formed manifest content being read from the
                        package. No further detail available from `vpm`'s
                        own CLI surface (no verbose flag on `install`).
                     7. **Isolated it empirically rather than guessing.**
                        Installed the known-good `helloWorld` reference
                        project on the same VVD instance — it installed and
                        launched cleanly, proving `vpm install` itself
                        wasn't broken; the cause was specific to this
                        package. Then manifest-bisected: rebuilt with
                        progressively larger slices of the real manifest
                        (interactive-only → +services → +tasks → +second
                        category → +needs.privilege → +wants), reinstalling
                        after each, until the one addition that reproduced
                        the failure was isolated — restoring the
                        `icon = "@image/Wick.png"` line, referencing an
                        icon file that has never existed in this repo.

**Expected:**        That a package passing `vpt validate` cleanly (which
                     explicitly downgrades a missing icon to a non-enforced
                     warning: "icon validation is not enforced, continuing
                     packaging...") would install on the Vega Virtual
                     Device — `vpt validate` is the SDK's own documented
                     pre-flight check for exactly this.

**Actual — root cause found and fixed:** `vpt validate` and `vpm install`
                     disagree about the same missing-icon condition, and
                     only one of them says why. `vpt validate` treats it as
                     a warning; `vpm install` treats the identical condition
                     as a hard rejection, surfaced as a generic
                     `Package is invalid` with no error code, no field name,
                     nothing pointing at "icon" — structurally the same
                     failure shape as FL-005/FL-006's Ring errors (a real
                     rejection, no way to act on it) but on Amazon's own
                     first-party tooling this time. Fix: added a real icon
                     asset at `apps/tv-vega/assets/image/Wick.png` (reused
                     from the existing Alexa+ add-on brand assets in
                     `docs/icons/`). The full, real manifest — every
                     service, task, want, need and the extras block, none
                     of which turned out to matter — now installs and
                     launches cleanly on the VVD.

**Severity:**        Important while open; now resolved. The build pipeline
                     is proven real and working end to end for the first
                     time this session (`vega project doctor`,
                     `vpt validate`, `react-native build-vega`, `vpm install`,
                     `vega run-app` all succeeding against the real app) —
                     SP-1 and SP-8 are unblocked at the tooling layer; what
                     remains for both is eyes-on confirmation (GUI VVD or
                     real hardware), which needs a human, not more CLI work.

**Workaround:**      N/A — root-caused and fixed, not worked around.

**Suggestion:**      1. **Make `vpm install`'s rejection as specific as
                        `vpt validate`'s, especially where they currently
                        contradict each other.** A missing icon is a
                        one-line fix once named; as a generic
                        `Package is invalid` it cost a full manifest
                        bisection to find.
                     2. **Make `vpt validate`'s icon warning match `vpm
                        install`'s actual enforcement.** If the installer
                        treats a missing icon as fatal, the validator
                        calling it non-enforced is actively misleading —
                        worse than not checking at all, because it gives
                        false confidence right before packaging.
                     3. **Document that `manifest.toml`'s `[package].
                        build_number` field is not read by packaging** — the
                        build's own warning ("Provide via --build-number CLI
                        option or in manifest.toml [package] section")
                        states both work; only one does.
                     4. Same ask as FL-007: **typecheck/test the SDK's own
                        packages under the versions they claim to require.**
                        `@amazon-devices/react-native-kepler` at
                        `4.0.1+rn0.83.0` alongside five sibling packages that
                        resolve to `react-native@0.87.1` on a clean install
                        is exactly the kind of drift CI would catch before a
                        third-party developer does.

---

## FL-010 — FL-003's own documented workaround PATCH is itself rejected, and the console's parallel "Sign in" flow doesn't reach it either

**Tool / API:**      Ring Partner API — `PATCH /v1/accounts/me/app-integrations` · Ring
                     Control Center's per-app "My apps" page ("Sign in" / "Connect Ring
                     account")

**Task attempted:**  Get `finishLink()`'s completion PATCH (the fix FL-003 already
                     documents) to actually succeed, so real Ring webhooks start
                     reaching `services/edge-ring/lambda/webhook.mjs` for once.

**Steps taken:**     1. Re-ran the partner-initiated OAuth flow (`ring_authorize_url`)
                        clean: PKCE exchange succeeds, `account_linked` logs
                        `hasRefresh: true, hasAccountId: true` — the token half is fine,
                        confirmed by `wick-ring-refresh`'s hourly logs actually rotating
                        it (`ring_token_refreshed`, `rotatedRefreshToken: true`).
                     2. `completeAppIntegration()`'s PATCH fires immediately after, body
                        `{"status":"completed","account_identifier":"<id>"}`. Every single
                        attempt (multiple, across sessions) returns the same:
                        ```
                        400 {"errors":[{"status":"400","title":"Invalid Status Transition",
                                        "detail":"Status change not allowed"}]}
                        ```
                     3. Ring's own Control Center ("My apps" → Wick) independently showed
                        `Pending. App sign-in required` with a `Sign in` button and `No
                        locations are connected` — a second, human-facing signal that
                        something about activation is incomplete, from a completely
                        different surface than the API.
                     4. Clicked it, expecting it to be the missing activation step.
                        Landed on a real Ring OAuth-style consent screen ("Wick is asking
                        to read events from your Ring doorbell and chime..."), completed
                        it, and was redirected to `?nonce=...&time=...`.
                     5. Checked what actually reached our backend: `GET /ring/link` *did*
                        receive the nonce/time redirect (`account_link_received`,
                        `paramKeys: ["nonce","time"]`) — but `link.mjs`'s own header
                        comment already says why nothing happens with it: *"The nonce claim
                        is not implemented: for a private app the console completes its own
                        authorisation and this path has never fired."* Confirmed in the
                        code (`link.mjs` lines 124–133): any request that isn't `?code&state`
                        or `?error` just gets 302'd straight to the static consent page
                        (`link.html`) with the query string forwarded, untouched.
                     6. Re-ran step 1–2 again *after* completing the console "Sign in" —
                        same PKCE success, same `Invalid Status Transition` on the PATCH,
                        byte-for-byte. The console flow changed nothing observable on the
                        API side.

**Expected:**        Either the documented completion PATCH (FL-003) to succeed once a
                     real OAuth link exists, or the console's own "Sign in" flow to be the
                     thing that unblocks it — some path to `status: "completed"` actually
                     applying.

**Actual:**          Two independent activation surfaces (an API PATCH, a console consent
                     flow) both report the integration as unfinished, and neither one's
                     completion path affects the other's outcome. The nonce redirect the
                     console flow produces has no server-side handler *by design*
                     (per `link.mjs`'s own comment, written before this session even
                     started) — it was already known to be a dead end, which this session
                     re-confirmed empirically rather than assumed. What's genuinely new
                     here: even knowing that, there is no remaining lever in either surface
                     — the account is authorized (real access + refresh tokens, auto-
                     refreshing hourly) but Ring's own account_identifier-scoped
                     app-integration resource refuses to leave whatever internal status it
                     starts in.

**Severity:**        Important — unlike FL-003 at the time it was written, this is no
                     longer "a workaround exists, just non-obvious." The documented
                     workaround is now known to be blocked, with no further lever
                     discovered from either the API or the console. Real webhook delivery
                     from Ring stays unavailable; it does not block anything else — every
                     Ring REST call (devices, images, history, chime) already works fine on
                     the same token, and `RING_TEST_DEVICE_ID` on
                     `scripts/test-ring-webhook.sh` (added this session) fully exercises
                     the Door agent's Lambda path by simulating the webhook Ring would
                     otherwise send.

**Workaround:**      `scripts/test-ring-webhook.sh RING_TEST_DEVICE_ID=<real device id>` —
                     posts a correctly-HMAC-signed synthetic payload straight to our own
                     webhook endpoint, using a device id from the real linked account, so
                     the Door agent's device lookup succeeds and a real card gets queued
                     with real Rhythm buckets written. This proves the entire deployed
                     pipeline end to end without depending on Ring ever actually sending a
                     webhook. See `docs/SIMULATOR-TESTING-GUIDE.md` §2c.

**Suggestion:**      1. Everything FL-003 already suggested still applies and is now more
                        clearly warranted: **make the dormant state observable and its
                        cause diagnosable** — a real error code (`integration_not_completed`,
                        or the actual disallowed-transition detail: *from* what status,
                        *to* what status) would turn two dead ends into one visible one.
                     2. **If the console "Sign in" flow is meant to be the real activation
                        path for private apps** (as its UI strongly implies —
                        "pending, sign-in required"), publish that it's the required step,
                        and wire the resulting nonce redirect to something a partner's
                        backend can actually call — right now it carries a real,
                        single-use credential (the nonce) to a static page with no
                        handler on either end.
                     3. Do not present two account-activation surfaces (API PATCH, console
                        consent) if only one of them can ever function for a private app —
                        the other one costs a developer a full round trip to learn it does
                        nothing.

---

## FL-009 — SP-5's hardware spike is un-runnable this session, so IoT Core stays unbuilt behind a complete MQTT client

**Tool / API:**      AWS IoT Core (device gateway, custom authorizer, topic rules) / Vega OS
                     react-native-kepler 1.2 (Fire TV hardware)

**Task attempted:**  Stand up the transport backend for S1 device wiring — both halves of
                     `createDeviceChannel()`'s MQTT-first-then-WebSocket fallback
                     (docs/WICK-TECHNICAL.md §14, SP-5).

**Steps taken:**     1. Built `MqttChannel.ts` (Task 1) as a complete, real client against
                        the documented per-device topic contract, using `mqtt.js` over WSS —
                        no simulated transport, no mock broker.
                     2. Went to size the IoT Core side: a custom authorizer, a per-device IAM
                        policy scoped to that device's topics, and topic rules to route
                        inbound messages.
                     3. Checked docs/WICK-TECHNICAL.md §14's own decision gate for this
                        exact question: "run `mqtt.js` over WSS on real Vega hardware for 4
                        hours and see" — i.e. SP-1..SP-8 in FRICTION.md's Open Slots, SP-5
                        specifically.
                     4. No Fire TV / Vega hardware is available this session (SP-8 is also
                        open, same root cause).

**Expected:**        That MQTT-vs-WebSocket would be settled by a real 4-hour spike on
                     device, with IoT Core built to match whichever transport the spike
                     confirmed.

**Actual:**          The spike cannot run without hardware, so there is nothing to confirm.
                     Standing up IoT Core speculatively — a custom authorizer, per-device
                     policies, topic rules — before anyone has confirmed `mqtt.js` even
                     connects inside Vega's RN 0.83 fork would be exactly the kind of
                     unverified infra this repo's own testing philosophy argues against
                     (AGENTS.md, docs/WICK-TECHNICAL.md §12.1). This is not a platform
                     restriction like FL-001..FL-004 — it is a resourcing gap this session
                     cannot close — but it directly shapes what got built: Tasks 6-7 give
                     `WebSocketChannel` a real pairing API and real WebSocket routes
                     (`connect`/`disconnect`/`route` Lambdas, `sendToDevice()` in
                     `services/agent/src/egress.ts`), while `infra/transport.tf`'s IoT Core
                     stack is deliberately absent. `MqttChannel` remains real, tested client
                     code with nothing live to point it at.

**Severity:**        Important — it does not block the demo (`createDeviceChannel()` falls
                     back to WebSocket automatically, §14, Scope decision 1), but it leaves
                     one of the two documented transports unverified end-to-end, and the
                     spike itself stays open (SP-5, SP-8) for the duration of this build.

**Workaround:**      `createDeviceChannel()` (Task 3) implements MQTT-first-then-WebSocket as
                     *runtime* fallback behavior rather than a static choice: `config.mqttWssUrl`
                     is simply absent until IoT Core exists, so the factory goes straight to
                     WebSocket. That is the honest way to satisfy "try MQTT first" without
                     fabricating a spike result the hardware was never available to produce.

**Suggestion:**      1. **Treat "no hardware available" as a first-class blocked state in the
                        spike log**, not a silent scope cut — this entry and the two open
                        checkboxes (SP-5, SP-8) in FRICTION.md's Open Slots are that record.
                     2. **Sequence the follow-up explicitly**: once `infra/transport.tf`'s
                        WebSocket half is deployed and proven (this pass), point `MqttChannel`
                        at a real IoT Core endpoint and run the actual 4-hour spike — the
                        natural next step, not a redesign.
                     3. For any team in this position, a short-loan hardware program (a Fire
                        TV Stick mailed for the hackathon's duration, per SP-8) would have
                        turned two open spikes into closed ones.


**Update 2026-10-11 — run, on simulators.** IoT Core was built (`infra/iot.tf`; what it
took to authenticate is FL-024) and the television's build was given the address. On the
Vega Virtual Device (SDK 0.24.12044, React Native 0.83, release build, `mqtt.js` 5.16):

- `mqtt.js` connected over WSS from Vega's runtime at the first attempt, with no change to
  the library, the bundler or the manifest. The server's row for the television read
  `mqtt`. Question Q3 of the technical document is answered: yes.
- A family note arrived over MQTT and was shown; the reply pressed on the remote went back
  up the events topic and was read back through `get_replies`.
- Pressing Home closed the connection and IoT Core's presence event cleared the row within
  eight seconds; a door card sent then went to the background service and came up as the
  system toast (FL-022). Opening Wick again reconnected over MQTT and the door card was on
  screen.
- With the address naming an authorizer that does not exist, the app was on the WebSocket
  instead (the row read `websocket`).

On the Android TV emulator, with the Fire OS build: connected over MQTT, a card down and a
reply up, and the same fallback.

Not run: four hours, a network drop and recovery (only leaving and reopening the app, and
killing and restarting it), and any hardware.

One thing the run found that the documentation does not say. A client that reconnects
into its persistent session keeps its `sessionIdentifier` — the television's was the same
before and after every reconnect. The lifecycle-events page says connect and disconnect
events "might be sent out of order", and the natural guard — clear the row only if it
still names the session that ended — does nothing when both connections carry one id.
The field that does tell them apart is `versionNumber`: a connection's connect and its
disconnect carry the same one. It is described as a way "to infer the order" of events,
not as the connection's identity, it starts again at 0 after an hour offline, and
`timestamp` is "an approximation" — so a correct presence table needs the session, the
version and the time together (`iot-policy.mjs`, `presenceConnected` /
`presenceDisconnected`). **Suggestion:** on the lifecycle-events page, say which field
identifies a connection as opposed to a session, and show the rule a presence table needs.

---

## FL-008 — Image retrieval fails most first attempts after an event, with an internal error name and no documented settling time

**Tool / API:**      Ring Partner API — the media host behind
                     `POST /v1/devices/{id}/media/image/download`

**Task attempted:**  Capture the still for a door event as soon as the event is visible —
                     which is the only moment that matters for a Door Card.

**Steps taken:**     1. Triggered live-view event simulations in the Developer Playground and
                        polled `/v1/history/devices/{id}/events` for the new entry.
                     2. On each new event, followed the 303 and fetched the presigned URL.
                     3. Did this five times.

**Expected:**        An image, or an error that says to wait.

**Actual:**          **Three of five attempts returned a JSON body instead of an image:**

                     ```
                     422  GRECO_NO_VALID_KEY
                          "No valid Greco key available for decryption"
                     ```

                     Two problems compound here.

                     First, the name. "Greco" is an internal component; nothing in the
                     published documentation mentions it, so the error is unsearchable and
                     gives a partner no idea whether the fault is theirs, whether it is
                     retryable, or how long to wait. The behaviour suggests the decryption
                     key has not propagated by the time the history entry is readable — but
                     that is inference from five samples, not something anyone documented.

                     Second, the delivery. This arrives as a 201-byte JSON body from a
                     presigned URL that a client is fetching precisely because it expects
                     bytes. Written straight to disk it produces a file named `.jpg` that
                     is not an image, and the failure then surfaces layers away — for us, as
                     a vision model with nothing to describe.

**Severity:**        Important — a 60% first-attempt failure rate on the single most
                     demo-critical call, presenting as corrupt output rather than an error.

**Workaround:**      `imageForEvent()` in `services/connectors/ring/src/media.ts` retries up
                     to four times, 2s apart, on this error code alone — a 400 on the body
                     shape or a 401 on the token will never fix itself and is not retried.
                     Each attempt re-requests the presigned URL, which is short-lived.
                     `fetchImageBytes()` checks the magic bytes, so a non-image is one clear
                     error at the source instead of a corrupt file downstream.

**Suggestion:**      1. **Publish the settling behaviour.** If a frame is not retrievable for
                        N seconds after an event, say so and say N. Every partner building a
                        doorbell feature hits this on their first event.
                     2. **Use an error a partner can act on** — `MEDIA_NOT_READY`, ideally
                        with `Retry-After`. `GRECO_NO_VALID_KEY` names an internal system and
                        reads like a permanent fault.
                     3. **Do not return a JSON error body from a media URL without making it
                        unmistakable** — the status code is right, but any client streaming
                        straight to a file will still write it.
                     4. Consider holding the history entry back until its media is
                        retrievable. The event being visible is what tells a partner to go
                        and fetch.

---

## FL-007 — The Vega SDK ships raw .ts that shadows its own .d.ts, and its strict-types escape hatch is not published

**Tool / API:**      `@amazon-devices/react-native-kepler` 4.0.1 (Vega OS / Kepler)

**Task attempted:**  Install the Vega SDK and typecheck the Fire TV app under the repository's
                     existing strict settings (`strict`, `noUncheckedIndexedAccess`,
                     `exactOptionalPropertyTypes`, `skipLibCheck`).

**Steps taken:**     1. `npm install @amazon-devices/react-native-kepler` — which, contrary to
                        our own README's assumption, works: the SDK is on the public npm
                        registry and does not require the Vega CLI scaffold.
                     2. `tsc -b apps/tv-vega`.
                     3. Found the package ships `KeplerBackHandler.ts` **and**
                        `KeplerBackHandler.d.ts` in the same directory — 49 such pairs.
                        TypeScript resolves `.ts` ahead of `.d.ts`, so the sources win,
                        `skipLibCheck` stops applying, and the SDK is typechecked as if it
                        were ours.
                     4. Took the SDK's own documented way out: `package.json` declares an
                        export condition
                        `"react-native-strict-api": "./types_generated/index.d.ts"`.
                        Set `customConditions: ["react-native-strict-api"]`.

**Expected:**        The strict-api condition to resolve to pre-generated declarations, which
                     `skipLibCheck` would then skip — exactly what the condition exists for.

**Actual:**          ```
                     error TS2722: Cannot invoke an object which is possibly 'undefined'.
                       node_modules/@amazon-devices/react-native-kepler/
                         Libraries/Utilities/KeplerBackHandler.ts:116
                              if (subscriptions[i]()) {
                     ```

                     The condition changes nothing, because **`types_generated/` is not in the
                     published tarball**. The package advertises an escape hatch it does not
                     ship. The only remaining lever is to turn the check off.

**Severity:**        Important — not a blocker, but it silently lowers the type safety of the
                     application code, which is the opposite of what the setting is for.

**Workaround:**      `noUncheckedIndexedAccess: false` in `apps/tv-vega/tsconfig.json` and
                     `packages/vega-calm-ui/tsconfig.json` — the only two packages that import
                     the SDK. `tsconfig.base.json` is untouched, so every service and the
                     contracts package keep the check. The cost is real and contained: the
                     Vega app's own indexed access is no longer checked.

**Suggestion:**      1. **Publish `types_generated/`, or drop the export condition.** A
                        condition pointing at an unpublished path is worse than no condition:
                        it costs a developer the time to find and try it.
                     2. **Do not ship `.ts` beside `.d.ts`.** Ship one. Given `.ts` always
                        wins resolution, shipping both means the declarations can never be
                        used by anyone who has the sources — which is everyone.
                     3. **Typecheck the SDK under its own recommended settings in CI.** The
                        failing line is an ordinary unchecked index, and there are 49 files
                        exposed the same way.
                     4. **Correct the documentation that says these packages come only from
                        the CLI scaffold.** They install fine from npm; we had deliberately
                        excluded the app from our build on the strength of that claim, and
                        lost the type coverage for it.

---

## FL-006 — A missing capability fails as a bare validation error, with nothing naming the capability

**Tool / API:**      Ring Partner API — `POST /v1/devices/{id}/media/audio/playback`

**Task attempted:**  M1 "Just a moment" — play a short recorded line out of the Ring Chime by
                     the front door, so a visitor waits while the resident gets up.

**Steps taken:**     1. Read the reference: the endpoint "requires the **Chime Controls**
                        capability". Reasonable, and checkable — so we checked.
                     2. `GET /v1/devices?include=capabilities` returns, for the device:
                        `audio: { customizable_slots: null, supported_actions: null }`.
                        The `audio` block is **present**, and null throughout.
                     3. Called the endpoint anyway, with four body shapes.

**Expected:**        Either a documented capability flag we could branch on before drawing
                     the button, or a refusal that names the missing capability.

**Actual:**          Every attempt returned the same thing:

                     ```
                     400  {"errors":[{"detail":"The request contains invalid input.",
                                      "title":"Validation Error"}]}
                     ```

                     No code, no field, no mention of a capability. Indistinguishable from
                     a payload we had got wrong — which, after FL-005, was exactly what we
                     assumed for a while.

                     Worth recording precisely because of what it is **not**: a 400 rather
                     than a 403 rules out the `ava.v1:read` scope, which had been our
                     standing worry about every write-shaped call. The scope is not the
                     problem. The device is.

**Severity:**        Important — it costs a feature, and the diagnosis is actively misleading.

**Workaround:**      Treat a present-but-null `audio` block as *no chime*
                     (`services/connectors/ring/src/jsonapi.ts`) and **do not draw the
                     button**. A door card offering an action that 400s is worse than one
                     with two buttons, and the product rule already says so: state plainly
                     what cannot be done rather than fail silently (`docs/WICK.md` D6).

**Suggestion:**      1. **Name the capability in the error.**
                        `{"code":"CAPABILITY_UNAVAILABLE","detail":"device does not support
                        chime_controls"}` costs one string and removes the whole ambiguity.
                     2. **Document the capability's shape**, not just its name. "Requires
                        Chime Controls" is unactionable when the payload shows `audio` with
                        null members and nothing called `chime_controls` anywhere.
                     3. **Say which Playground devices lack which capabilities.** A partner
                        building against the Playground will design for what it exposes, and
                        discover the gap when they reach real hardware — or, as here, design
                        around a gap that may not exist on real hardware at all.

**Update 2026-10-01:** Ring's Chimes page (Early Access) now documents the body
(`{"data":{"type":"audio","attributes":{"audio_ref":…}}}`, where `audio_ref`
comes from the chime's own `configurations.audio.customizable_slots`) and the
capability to branch on: `audio.supported_actions` ∋ `chime.play`. Our four
attempts were against the Playground *camera*, which is not a chime at all; a
chime is its own device. Wick now discovers chimes that way
(`services/connectors/ring/src/chime.ts`), and the button was renamed to what the
API can actually do: "Ring the hallway chime", an indoor speaker that tells the
house rather than the visitor. Two documentation gaps remain: nothing on the camera
side says "this endpoint is for chimes only", and the Playground has no chime to
test against, so the playback path is contract-tested against Ring's documented
shapes but not yet run against hardware.

---

## FL-005 — The "snapshot" endpoint is historical retrieval, and its payload is discoverable only by guessing

**Tool / API:**      Ring Partner API — `POST /v1/devices/{id}/media/image/download`

**Task attempted:**  Fetch a doorbell image to render on a Door Card — the single most
                     important frame in the product.

**Steps taken:**     Called the endpoint and followed the errors, which is the only
                     available method:

                     | Request body | Response |
                     |---|---|
                     | *(none)* | `403 REQUEST_FORBIDDEN` — "Cannot authorize: empty request body" |
                     | `{}` | `403` — "Cannot authorize: **missing required timestamp fields**" |
                     | `{"start":…,"end":…}` | `403` — same |
                     | `{"start_time":…,"end_time":…}` | `403` — same |
                     | `{"timestamp":…}` | `400 INVALID_PAYLOAD` — "**type is required**" |
                     | `{"type":"image","timestamp":…}` | `400` — "type not supported, valid values: **at_timestamp, latest_in_range**" |
                     | `{"type":"at_timestamp","timestamp":…}` | **`303`** → presigned URL → `200`, 1280x720 JPEG |

**Expected:**        From the API reference's one-line table entry, a call that returns the
                     camera's current view — what "snapshot" means on every other camera
                     platform, and what our Door Card was designed around.

**Actual:**          Two surprises, one of them architectural.

                     1. **It is not live.** `at_timestamp` retrieves a frame from recorded
                        history. There is no "capture now" call. A door event must therefore
                        be answered with a frame from *just after* the event, which changes
                        the Door Card from "here is who is there" to "here is who was there",
                        and puts recording retention on the critical path of a live feature.
                     2. **The payload is undocumented.** Six requests to discover two field
                        names, and the enum only by provoking a validation error. The API
                        reference lists the path and nothing else — no schema, no example.

                     Worth crediting: the errors are specific and they do converge. Naming
                     the valid enum values in the rejection is better than most APIs manage.
                     But it is still reverse-engineering, and each probe costs a round trip
                     against a 30-minute token.

**Severity:**        Important — recoverable in an afternoon, and it invalidates a design
                     assumption that a one-line docs entry actively encourages.

**Workaround:**      `{"type":"at_timestamp","timestamp":<ms>}`, then follow the 303. Budget
                     **~3.2s** end to end (measured, n=3): 0.8s to the redirect, ~2.3s to
                     pull 106KB from `download-eu-south-2.prod.phoenix.devices.amazon.dev`.
                     Too slow to block a card render — fetch it after the card is on screen,
                     never before.

**Suggestion:**      1. **Publish the request schema.** One JSON example beside the path
                        entry removes the entire exercise.
                     2. **Rename it, or say plainly that it is historical.** "Snapshot" in
                        the endpoint table sets the wrong expectation before a developer
                        writes a line; `image/download` with `at_timestamp` is retrieval.
                     3. **Return 400, not 403, for a malformed body.** "Cannot authorize"
                        sends you to check scopes and tokens — the two things that were
                        never wrong. This cost the most time of anything here.
                     4. Document the 303 and the media host, so it can be allowlisted in
                        egress rules ahead of time rather than discovered in an outage.

---

## FL-004 — Partner-Initiated OAuth 2.0 is documented in full, gated silently, and fails with no error code

**Tool / API:**      Ring Partner API — `https://account.ring.com/account/integrations/partner-link/authorize`

**Task attempted:**  Obtain an access token for a **private** app by driving partner-initiated
                     OAuth ourselves, after establishing that the console's connect button
                     issues no credential (FL-002).

**Steps taken:**     1. Built the flow to the published specification: PKCE S256, all seven
                        documented query parameters, `redirect_uri` exactly matching the
                        registered Account Link URL.
                     2. Opened the authorize URL while signed in to Ring.
                     3. Isolated each parameter against the endpoint to find what it validates.

**Expected:**        Either a consent screen, or an OAuth error redirect back to `redirect_uri`
                     carrying `error=` — which RFC 6749 requires for every failure except an
                     untrusted `client_id`/`redirect_uri`.

**Actual:**          *"Something went wrong. Please return to the partner application and try
                     again."* No error code, no correlation id, and **no redirect back at all**
                     — our Account Link URL was never called, in any form. Probing the endpoint
                     showed why it is so hard to diagnose: before sign-in it validates only
                     parameter *shape*, and is indifferent to identity.

                     | Probe | Result |
                     |---|---|
                     | Registered `client_id` + registered `redirect_uri` | 302 + params stashed in cookie |
                     | **Invented `client_id`**, same params | **302, byte-identical** |
                     | Registered `client_id` + `redirect_uri=evil.example.com` | 302 |
                     | `code_challenge` too short | 400 |

                     So the endpoint accepts a fabricated client as readily as a real one and
                     defers every meaningful check to a post-sign-in page that reports nothing.
                     The gate is stated once, in the prerequisites: *"Your app must be
                     allowlisted for Partner-Initiated OAuth 2.0."* The console exposes no
                     allowlist status and no way to request one.

**Severity:**        Critical — a fully documented flow, buildable end to end, that cannot
                     succeed and cannot say so.

**Workaround:**      The Developer Playground issues a ~30-minute access token valid against
                     every Ring API with no OAuth at all. `scripts/set-ring-token.sh` verifies
                     one against `/v1/users/me` and stores it. Enough to build and demo; not a
                     product.

**Suggestion:**      1. **Return a real OAuth error.** `error=unauthorized_client` redirected to
                        the registered `redirect_uri` costs nothing and turns a half-day of
                        investigation into one log line.
                     2. **Validate `client_id` before the sign-in wall.** Accepting an invented
                        client with a 302 actively misleads: it is the strongest available
                        signal that the request was well-formed, and it is meaningless.
                     3. **Show allowlist status in the console**, next to the credentials, with
                        a request path — or state on the flow's documentation page that it is
                        unavailable to private apps. Right now the only way to learn this is to
                        implement it.
                     4. Put a correlation id on the error page. There was nothing to quote in a
                        support request.

---

## FL-003 — Partner-initiated linking leaves the integration dormant until an undocumented-by-placement PATCH

**Tool / API:**      Ring Partner API — `PATCH /v1/accounts/me/app-integrations` (api.amazonvision.com)

**Task attempted:**  Finish a partner-initiated OAuth link: exchange the authorization code
                     for tokens and start receiving doorbell webhooks.

**Steps taken:**     1. Ran the partner-initiated flow to completion: PKCE S256, authorization
                        code, `POST https://oauth.ring.com/oauth/token`, access + refresh
                        tokens returned and stored.
                     2. Treated that as the end of the flow, because it is the end of every
                        OAuth flow.
                     3. Found, in the API reference rather than the linking walkthrough, that
                        the integration "is not fully active" until `status: "completed"` is
                        PATCHed to `/v1/accounts/me/app-integrations`.

**Expected:**        That a successful authorization-code exchange links the account. That is
                     what an access token means everywhere else.

**Actual:**          Tokens are valid and device authorizations stay dormant. Every symptom
                     points somewhere else: webhooks silent, device list thin, token fine.
                     The natural diagnosis is a webhook signature or subscription problem,
                     and that is a long way to chase in the wrong direction.

**Severity:**        Important — not a blocker once known, but the failure mode is silent and
                     misattributing.

**Workaround:**      `finishLink()` in `services/edge-ring/lambda/ring-token.mjs` does the
                     exchange, the `/v1/users/me` lookup for `account_identifier`, and the
                     completion PATCH as one unit, and reports which half succeeded so the
                     browser page can say "almost there" instead of "connected".

**Suggestion:**      1. **Put the PATCH in the account-linking walkthrough**, as a numbered
                        step between "exchange the code" and "receive webhooks" — not only
                        in the endpoint reference, where a developer following the guide has
                        no reason to look.
                     2. **Make the dormant state observable.** A `status` field on
                        `GET /v1/accounts/me/app-integrations`, or a 409 on the first device
                        call with `integration_not_completed`, turns a silent misattribution
                        into a one-line fix.
                     3. Better still, **complete it server-side** on a successful exchange.
                        A step that must always be called, in only one valid order, is a
                        step the platform can take itself.

---

## FL-002 — "Connect Ring account" in the console reports a link that produces no token

**Tool / API:**      Ring Developer Console — App Configuration / Account linking

**Task attempted:**  Obtain a Ring access token for a private app, so the backend could read
                     devices and receive doorbell events.

**Steps taken:**     1. Registered the app, set the Account Link URL, Token Exchange URL and
                        Webhook URL to live endpoints on our API.
                     2. Pressed **Connect Ring account** in the console and approved. The
                        console showed **1/10 accounts connected**.
                     3. Waited for the authorization code. Checked the API Gateway access log
                        — the authoritative record of everything that reached the API.
                     4. Tried `client_credentials` against `https://oauth.ring.com/oauth/token`
                        as a fallback.

**Expected:**        That connecting an account in the console drives the documented one-way
                     flow: an authorization code POSTed to the Token Exchange URL, or a nonce
                     redirect to the Account Link URL. Either would give us a token.

**Actual:**          Neither URL was ever called. Not once, in any form — the access log shows
                     no request at all correlated with the console action, so this is not a
                     handler bug on our side. The console completes its own authorisation and
                     reports success; "connected" means the account is *available* to the app,
                     not that the app holds a credential. `client_credentials` is refused:

                     ```
                     HTTP 401  unsupported_grant_type: invalid grant type for client
                     ```

**Severity:**        Critical — it is the first step of every integration, it reports success,
                     and the success is not the thing you need.

**Confirmed:**       The Private Use Apps documentation states it outright: connecting an account
                     adds it to an **allowlist**, and *"this allowlist controls who can discover
                     and access the app"*. It is an access-control list, not a credential
                     issuer. Verified independently from our side: across every log group that
                     has ever existed for this project — Terraform-era and the CDK-era groups
                     that preceded them — Ring has invoked our Account Link URL, Token Exchange
                     URL and Webhook URL exactly **zero** times, while the console read
                     "1/10 accounts connected" throughout.

**Workaround:**      Drive partner-initiated OAuth ourselves: `GET /ring/authorize` mints PKCE
                     S256, parks the verifier under the state with a 10-minute TTL, and
                     redirects to
                     `https://account.ring.com/account/integrations/partner-link/authorize`.
                     The callback lands on the Account Link URL, which branches on the
                     parameters present — Ring matches `redirect_uri` exactly against the
                     pre-registered URI, so one endpoint has to serve both models.

**Suggestion:**      1. **Say what the counter counts.** "1/10 accounts connected" should read
                        "1/10 accounts available — no token issued". One word of copy removes
                        the entire failure.
                     2. **Show the linking state per account**: available / code sent / token
                        exchanged, with the timestamp of the last call to each configured URL.
                        The console knows this; the developer is reduced to reading access logs.
                     3. **Make the console button optionally drive the real flow**, so the
                        documented handshake can be exercised once from a place a developer
                        already is.
                     4. Reject `client_credentials` with the guidance, not just the refusal:
                        name the two supported models in the error body.

---

## FL-001 — Alexa+ MCP Toolkit is restricted to select partners, with no application path

**Tool / API:**      Alexa+ MCP Toolkit / `alexa-ai` CLI (developer.amazon.com/docs/alexaplus/add-ons)

**Task attempted:**  Register a self-hosted MCP server as an Alexa+ add-on, so a family
                     member could ask their own Echo about a relative living alone — the
                     cross-device half of a Fire TV project.

**Steps taken:**     1. Read the MCP Toolkit Overview and QuickStart. Both describe a
                        complete, self-serve flow: `alexa-ai configure` → `new mcp` →
                        `deploy`, with an `addon.json` manifest schema documented in full.
                     2. Built against those requirements: MCP spec 2025-11-25, Streamable
                        HTTP, OAuth 2.1 + PKCE (S256), Protected Resource Metadata at
                        `/.well-known/oauth-authorization-server`, sub-500ms round trips.
                     3. Prepared every gating asset the manifest demands — six icon sizes,
                        a 600x900 carousel image, live privacy and terms URLs.
                     4. Went to obtain CLI access and found, on the add-ons documentation
                        home page: *"At this time, Category SDK and MCP Toolkit are
                        available to select partners only."*

**Expected:**        That the QuickStart's documented flow was available to a registered
                     Amazon developer, as its wording implies throughout. Nothing in the
                     Overview, QuickStart, Certification or Account Linking pages mentions
                     a restriction.

**Actual:**          Both the Category SDK and the MCP Toolkit are gated to select
                     partners. There is no published eligibility criterion, application
                     form, waitlist, or contact address for requesting access. The
                     restriction appears only on the docs home page, not on the pages that
                     describe the workflow in detail.

**Severity:**        Critical — it gates an entire documented developer surface, and it is
                     discoverable only after building against the spec.

**Workaround:**      Built the MCP server anyway: genuinely spec-compliant (2025-11-25,
                     Streamable HTTP, OAuth 2.1 + PKCE), exercised through MCP Inspector
                     and a simulated Alexa+ surface, which the hackathon rules explicitly
                     permit as an alternative. The server is real; only the Alexa+
                     registration is missing. If access opens, no code changes.

**Suggestion:**      Three things, in order of value:
                     1. **Put the restriction at the top of the Overview and QuickStart**,
                        not only on the docs home page. A developer who lands on the
                        QuickStart from search — the common path — will build for hours
                        before discovering it.
                     2. **Publish an eligibility criterion and a request form**, even if
                        the answer is usually no. "Select partners only" with no door is
                        worse than a documented queue.
                     3. **Offer a development-stage sandbox** that accepts any registered
                        developer and exercises the full loop against a simulator, with
                        only production deployment gated. This is how the Ring Partner API
                        handles the same problem, and it works well: register, develop
                        immediately against your own devices, certify only to publish.

**Also noted:**      The toolkit is documented as United States only. Combined with partner
                     gating, a developer outside the US has no path to the surface at all.

**Follow-up, 2026-10-11:** Amazon staff confirmed in the hackathon forum (topic 45262, and again
                     in the week of 2026-10-05 in topic 45482) that access "will not be granted to hackathon
                     participants". The add-on package is therefore finished as far as it can be
                     without Amazon: the manifest is held to the quickstart's field table in CI,
                     `npm run addon:check -- --live` runs the checks a deploy is documented to
                     need against the deployed stack, and the simulated surface draws Wick's
                     listing from the same `addon.json`. It also removed one thing a real deploy
                     would have tripped on: the manifest carried `_comment` keys, which are not
                     manifest fields.
