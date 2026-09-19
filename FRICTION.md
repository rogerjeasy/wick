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
