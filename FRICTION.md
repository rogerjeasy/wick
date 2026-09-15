# Friction Log

Developer-experience friction encountered while building Wick on Amazon Devices,
Ring, Bee, Alexa+ and AWS.

**Write entries the moment you hit the problem.** A friction log assembled at the
end reads like one, and this is assessed during Stage One for a bonus of up to
10% applied to the final score.

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

## Open slots — the spikes (see docs/WICK-TECHNICAL.md §14)

Fill each in as the spike completes, **whatever the answer**. A spike that
succeeds still often surfaces a documentation or ergonomics gap.

- [ ] **SP-1** Rendering over active playback on Vega
- [x] **SP-2** Ring snapshot latency (`POST /media/image/download`) — **3.15s** end to end
      (0.8s to the 303, ~2.3s to pull 106KB). And it is not a snapshot: see FL-005.
- [ ] **SP-3** Ring WHEP session negotiation and limits on Vega
- [ ] **SP-4** Alexa+ add-on onboarding (`alexa-ai configure → deploy`)
- [ ] **SP-5** WebSocket / MQTT transport inside Vega's RN 0.83 fork
- [ ] **SP-6** Bee proxy SSE longevity against the 120s idle timeout
- [ ] **SP-7** Content Personalization round trip to Continue Watching
- [ ] **SP-8** Vega sample on real Fire TV Stick hardware

## Known gaps to write up when encountered

Pre-identified during research (docs/WICK-TECHNICAL.md Appendix E). These are
leads, not entries — an entry requires that you actually hit it.

| Severity | Gap |
|---|---|
| Critical | No third-party overlay / ambient surface on Vega |
| Critical | No camera, microphone, BLE or presence API on Vega |
| Critical | No documented hardware-backed keystore on Vega |
| Important | No public Ambient Experience / presence API |
| Important | Content Launcher & Account Login partner-gated, no sandbox |
| Important | Ring: no two-way audio / siren / light endpoints |
| Important | Ring: no webhook replay, DLQ or synthetic-event sandbox |
| Important | Ring: WHEP session duration/concurrency limits undocumented |
| Important | Alexa+ MCP add-on is US-only |
| Important | No accessibility-preference API on Vega beyond screen-reader state |
| Nice-to-have | Ring `sub_type` taxonomy too coarse |
| Nice-to-have | Ring blocks browser/TV origins, forcing an extra hop |
| Nice-to-have | Bee proxy 120s idle timeout fights long-lived SSE |
| Nice-to-have | Amazon Kids / household profiles unavailable to third-party apps |
| Nice-to-have | Vega samples ship mock data wired into the real service path |

---

## Entries

<!-- Newest first. -->

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
