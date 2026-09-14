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
