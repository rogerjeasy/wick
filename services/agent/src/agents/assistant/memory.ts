/**
 * What the assistant remembers between conversations: the member's own
 * words, and nothing else.
 *
 * "Our plumber is Dave", "tell me by text, not by ringing" — a family
 * member says things worth not having to say twice, and AgentCore Memory's
 * user-preference strategy turns them into records under
 * /households/{home}/members/{member} (identity.ts, infra/assistant.tf).
 *
 * What it must never keep is anything about the resident. Her week, her
 * door, the light — those are the tools' answers, read through the Guardian
 * on every call (INV-2, INV-4), and what she has stopped sharing must stop
 * being said. A memory of a tool's answer would be a second copy that no
 * gate reads again, and no "stop sharing" reaches. So the store the agent is
 * given is wrapped (memberWordsOnly): it is handed only messages the member
 * wrote, and only their words — never a tool call, never a tool result,
 * never the assistant's own sentences (which repeat the results). And it
 * has no `add`, so nothing of the model's choosing is ever stored.
 *
 * The memory reaches the model by injection before a fresh question, never
 * as a tool: every tool the agent may call is Wick's, behind the approval
 * rule (approval.ts), and a memory tool would be one more that is not.
 */
import type { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { AgentCoreMemoryStore } from 'bedrock-agentcore/experimental/memory/strands';
import { InvocationTrigger, MemoryManager, type AddMessagesContext, type MemoryStore, type MessageData } from '@strands-agents/sdk';
import { memberMemory } from './identity.js';

/** How many remembered things are put before a question. A few: the member said them, and they are short. */
const REMEMBERED_PER_QUESTION = 3;

export interface TheirWords {
  readonly messages: MessageData[];
  readonly context: AddMessagesContext;
}

/** The member's own sentences in a batch, each with its own sequence number. */
export function onlyTheirWords(messages: readonly MessageData[], context: AddMessagesContext = {}): TheirWords {
  const kept: MessageData[] = [];
  const numbers: number[] = [];
  messages.forEach((message, i) => {
    if (message.role !== 'user') return;
    const words = message.content.filter((block): block is { text: string } => 'text' in block && typeof block.text === 'string' && block.text.trim() !== '');
    if (words.length === 0) return;
    kept.push({ role: 'user', content: words.map((block) => ({ text: block.text })) });
    const number = context.sequenceNumbers?.[i];
    if (number !== undefined) numbers.push(number);
  });
  return { messages: kept, context: context.sequenceNumbers ? { sequenceNumbers: numbers } : {} };
}

/** The store as the agent sees it: searched as it is, written to with the member's words only, and never added to. */
export function memberWordsOnly(store: MemoryStore): MemoryStore {
  const wrapped: MemoryStore = {
    name: store.name,
    writable: store.writable,
    ...(store.description !== undefined ? { description: store.description } : {}),
    ...(store.maxSearchResults !== undefined ? { maxSearchResults: store.maxSearchResults } : {}),
    ...(store.extraction !== undefined ? { extraction: store.extraction } : {}),
    search: (query, options) => store.search(query, options),
  };
  const addMessages = store.addMessages?.bind(store);
  if (!addMessages) return wrapped;
  return {
    ...wrapped,
    addMessages: async (messages, context) => {
      const theirs = onlyTheirWords(messages, context);
      if (theirs.messages.length > 0) await addMessages(theirs.messages, theirs.context);
    },
  };
}

/** The agent's memory: injected before a fresh question, with no tool to search or add. */
export function memoryManagerFor(store: MemoryStore): MemoryManager {
  return new MemoryManager({
    stores: [memberWordsOnly(store)],
    searchToolConfig: false,
    addToolConfig: false,
    injection: { trigger: 'userTurn', maxEntries: REMEMBERED_PER_QUESTION },
  });
}

export interface MemberStoreConfig {
  readonly memoryId: string;
  readonly householdId: string;
  readonly memberId: string;
  readonly client: BedrockAgentCoreClient;
}

/**
 * The official AgentCore Memory store for one member in one home: read
 * from their namespace, written as their events. Written after every
 * question (InvocationTrigger) — the agent lives for one question, so a
 * cadence counted in questions would never be reached — and flushed before
 * the answer leaves (turn.ts). Already wrapped in memberWordsOnly, so no
 * path to it writes anything else. Undefined where the ids would be refused.
 */
export function memberMemoryStore(config: MemberStoreConfig): MemoryStore | undefined {
  const where = memberMemory(config.householdId, config.memberId);
  if (!where) return undefined;
  return memberWordsOnly(new AgentCoreMemoryStore({
    name: 'what-they-told-you',
    description: 'What this family member said before, in their own words.',
    memoryId: config.memoryId,
    actorId: where.actorId,
    sessionId: where.sessionId,
    namespace: where.namespace,
    client: config.client,
    writable: true,
    extraction: { trigger: new InvocationTrigger() },
  }));
}
