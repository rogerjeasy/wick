/**
 * The MCP server (S4a). This is the real artefact.
 *
 * The Alexa+ MCP Toolkit is partner-gated (FRICTION.md FL-001), so this server is
 * exercised through MCP Inspector and the simulated surface in apps/sim-alexa
 * rather than a real Echo. Build to the published spec anyway: it is good
 * engineering independently, and if access opens, nothing here changes.
 *
 * HARD REQUIREMENTS (verified, Alexa+ MCP Toolkit quickstart, 2026-09-14):
 *   - MCP spec 2025-11-25, Streamable HTTP. Not legacy SSE.
 *   - Public HTTPS. cloudflared is the documented local-dev tunnel.
 *   - ROUND TRIP UNDER 500ms. Architectural constraint, not a target.
 *   - Tools are discovered by introspection AT DEPLOY TIME.
 *     Redeploy after ANY tool change. This will bite you at least once — write
 *     it into FRICTION.md when it does.
 *
 * Therefore: every tool handler is a single DynamoDB GetItem over precomputed
 * state. NO MODEL CALL EVER RUNS INSIDE A TOOL HANDLER. If you want one, you
 * have mis-sited the work — precompute it upstream (§5.4).
 */
export {};
