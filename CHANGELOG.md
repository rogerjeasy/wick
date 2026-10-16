# Changelog

Wick's releases. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-10-17

The first release: Wick, complete and deployed, as submitted to Build, Ship,
Shape (Fire TV track; AWS Builder and Open Source mini challenges). Built from
14 September 2026 in 106 pull requests.

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
