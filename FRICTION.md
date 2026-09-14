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
- [ ] **SP-2** Ring snapshot latency (`POST /media/image/download`)
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
