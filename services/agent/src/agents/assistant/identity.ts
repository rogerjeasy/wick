/**
 * Who a conversation with the assistant belongs to, in the names AgentCore
 * and Strands keep it under.
 *
 * Shared by the two ends of the conversation: the Wick server, which picks
 * the runtime session to invoke and deletes a member's memory with their
 * account (services/mcp-server/src/assistant/), and the agent, which saves
 * and remembers under these names (turn.ts). One module, so the two can
 * never disagree about where a member's words are kept.
 *
 *   conversation  the Strands session and the AgentCore runtime session:
 *                 "assistant-" + sha256(householdId:memberId), 32 hex.
 *                 One per member per home: a member's conversation
 *                 survives a cold start and a new browser, and never
 *                 meets anyone else's.
 *   their words   AgentCore Memory, actor = the member, session = the home,
 *                 so the long-term records land under
 *                 /households/{home}/members/{member} — the namespace the
 *                 memory strategy is given (infra/assistant.tf).
 *
 * The saved state of the conversation is kept under the agent's own id as
 * the actor (ASSISTANT_AGENT_ID), never the member's: what the session
 * storage writes and what the memory strategy reads never mix.
 *
 * Pure, and free of any SDK: the Wick server bundles this too.
 */
import { createHash } from 'node:crypto';

/** The agent's id: Strands' scope id for its saved state, and that state's actor in AgentCore Memory. */
export const ASSISTANT_AGENT_ID = 'wick-assistant';

/**
 * The memory strategy's namespace (infra/assistant.tf). AgentCore fills in
 * only {actorId}, {sessionId} and {memoryStrategyId}; the home is the
 * session, so the namespace still reads as a home and a member.
 */
export const MEMBER_NAMESPACE_TEMPLATE = '/households/{sessionId}/members/{actorId}';

/** AgentCore Memory's own pattern for a session id (and, a little wider, an actor id): checked here, not discovered in a 400. */
const MEMORY_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;

/** One conversation per member per home. Throws on an id that could make two members share one. */
export function assistantSessionId(householdId: string, memberId: string): string {
  if (!householdId || !memberId || householdId.includes(':') || memberId.includes(':')) {
    throw new Error('assistant_session_id: bad ids');
  }
  return `assistant-${createHash('sha256').update(`${householdId}:${memberId}`).digest('hex').slice(0, 32)}`;
}

export interface MemberMemory {
  readonly actorId: string;
  readonly sessionId: string;
  readonly namespace: string;
}

/** Where a member's own words are remembered in one home; undefined for ids AgentCore would refuse, so nothing is. */
export function memberMemory(householdId: string, memberId: string): MemberMemory | undefined {
  if (!MEMORY_ID.test(householdId) || !MEMORY_ID.test(memberId)) return undefined;
  return { actorId: memberId, sessionId: householdId, namespace: memberNamespace(householdId, memberId) };
}

export function memberNamespace(householdId: string, memberId: string): string {
  return MEMBER_NAMESPACE_TEMPLATE.replace('{sessionId}', householdId).replace('{actorId}', memberId);
}
