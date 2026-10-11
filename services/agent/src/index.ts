/**
 * Strands agent graph, deployed to Bedrock AgentCore Runtime.
 *
 *   EventBridge ─┬─▶ Door ─────┐
 *                │             ├──▶ GUARDIAN ──▶ egress ─┬─▶ device (TV)
 *   cron ────────┴─▶ Narrator ─┘      (sync)             └─▶ MCP tool result
 *
 * Do not let these collapse into one agent. The separation is the architecture,
 * and it is also the demo.
 */
export { sendToDevice } from './egress.js';
export { privateNarrative, summariseWeek } from './agents/narrator/weekFacts.js';
export { visibleDeltas } from './agents/narrator/comparisons.js';
export { isoWeekRange } from './agents/narrator/isoWeek.js';
export { factsWeekNarrative } from './agents/narrator/index.js';
