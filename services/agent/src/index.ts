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
export { sendHomeToDevices, sendPatchToDevice, sendToDevice, takeBackFromDevices } from './egress.js';
export { fallbackNarrative, privateNarrative, summariseWeek } from './agents/narrator/weekFacts.js';
export { visibleDeltas } from './agents/narrator/comparisons.js';
export { isoWeekRange } from './agents/narrator/isoWeek.js';
export { factsWeekNarrative } from './agents/narrator/index.js';
export { stillWelcome } from './agents/door/roster.js';
export { toTimelineEntry } from './agents/narrator/timeline.js';
export { VISIT_GRACE_MS, parsePattern, whatsDifferent, type Difference, type DifferenceKind, type DifferentAnswer } from './rhythm/different.js';
export { isSharedWithFamily, loadHouseholdPolicy, loadHouseholdTimeZone, loadRoster } from './store/household.js';
export { doorWaitSeconds, executionInput, instant, windowEndOf, type ErrandExecutionInput } from './agents/errand/machine.js';
export { errandFromItem, errandItem, errandRosterEntry, errandStore, type ErrandFacts, type ErrandSend, type ErrandStore, type HeldErrand } from './store/errands.js';
export { reachFromItem, reachItem, reachStore, type ReachSend, type ReachStore } from './store/reaches.js';
export { visitFromItem, visitItem, visitStore, type VisitSend, type VisitStore } from './store/visits.js';
// The assistant's rules: pure, so the Wick server bundles them too.
export { assistantPrompt, localWhen, systemPrompt, todayLine, type Who } from './agents/assistant/prompt.js';
// The names a member's conversation and words are kept under, shared with the Wick server.
export { ASSISTANT_AGENT_ID, assistantSessionId, memberMemory, memberNamespace, type MemberMemory } from './agents/assistant/identity.js';
export { briefMessage, type BriefMessage } from './agents/brief/fanout.js';
