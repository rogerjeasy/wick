/**
 * Strands agent graph, deployed to Bedrock AgentCore Runtime.
 *
 *   EventBridge ─┬─▶ Door ─────┐
 *                │             │
 *   Bee SSE ─────┼─▶ Day ──────┼──▶ GUARDIAN ──▶ egress ─┬─▶ device (TV)
 *                │             │      (sync)             └─▶ MCP tool result
 *   cron ────────┴─▶ Narrator ─┘
 *
 * Do not let these collapse into one agent. The separation is the architecture,
 * and it is also the demo.
 */
export {};
