/**
 * What the assistant kept of a member, taken with their account
 * (accounts/myData.ts deleteAccount).
 *
 * Two things are kept in AgentCore Memory (services/agent/src/agents/
 * assistant/identity.ts names both):
 *
 *   - their conversation's saved state: the events of the session
 *     `assistant-<hash of home and member>`, under the agent's own actor;
 *   - their own words: the events under them as the actor, in the home as
 *     the session, and the long-term records the memory strategy made of
 *     them, under /households/{home}/members/{member}.
 *
 * Every one is deleted, a page at a time, and a record that will not go
 * fails the deletion, so it can be asked for again and finish. Nothing of
 * anyone else's is named in any request: another member, or the same
 * member in another home, is another actor, session and namespace.
 */
import {
  BatchDeleteMemoryRecordsCommand,
  DeleteEventCommand,
  ListEventsCommand,
  ListMemoryRecordsCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { ASSISTANT_AGENT_ID, assistantSessionId, memberMemory } from '@wick/agent';

export interface AssistantMemory {
  /** Deletes everything the assistant kept of this member in this home. */
  forget(householdId: string, memberId: string): Promise<void>;
}

type MemoryCommand = ListEventsCommand | DeleteEventCommand | ListMemoryRecordsCommand | BatchDeleteMemoryRecordsCommand;
export type MemorySend = (command: MemoryCommand) => Promise<unknown>;

/** BatchDeleteMemoryRecords' own ceiling on one call. */
const RECORDS_PER_BATCH = 100;

const notFound = (err: unknown): boolean => (err as { name?: string }).name === 'ResourceNotFoundException';

export function agentCoreForgetting(send: MemorySend, memoryId: string): AssistantMemory {
  // Listed to the end first, then deleted: deleting while paging moves what the next page is.
  async function deleteEvents(actorId: string, sessionId: string): Promise<void> {
    const ids: string[] = [];
    let nextToken: string | undefined;
    do {
      let page: { events?: { eventId?: string }[]; nextToken?: string };
      try {
        page = (await send(new ListEventsCommand({ memoryId, actorId, sessionId, includePayloads: false, maxResults: 100, ...(nextToken ? { nextToken } : {}) }))) as typeof page;
      } catch (err) {
        if (notFound(err)) return;
        throw err;
      }
      for (const { eventId } of page.events ?? []) if (eventId) ids.push(eventId);
      nextToken = page.nextToken;
    } while (nextToken);
    for (const eventId of ids) await send(new DeleteEventCommand({ memoryId, actorId, sessionId, eventId }));
  }

  async function deleteRecords(namespace: string): Promise<void> {
    let nextToken: string | undefined;
    const ids: string[] = [];
    do {
      const page = (await send(new ListMemoryRecordsCommand({ memoryId, namespace, maxResults: 100, ...(nextToken ? { nextToken } : {}) }))) as {
        memoryRecordSummaries?: { memoryRecordId?: string }[];
        nextToken?: string;
      };
      for (const { memoryRecordId } of page.memoryRecordSummaries ?? []) if (memoryRecordId) ids.push(memoryRecordId);
      nextToken = page.nextToken;
    } while (nextToken);

    for (let i = 0; i < ids.length; i += RECORDS_PER_BATCH) {
      const batch = ids.slice(i, i + RECORDS_PER_BATCH);
      const out = (await send(new BatchDeleteMemoryRecordsCommand({ memoryId, records: batch.map((memoryRecordId) => ({ memoryRecordId, namespace })) }))) as {
        failedRecords?: unknown[];
      };
      if ((out.failedRecords ?? []).length > 0) throw new Error('memory_records_not_deleted');
    }
  }

  return {
    async forget(householdId, memberId) {
      await deleteEvents(ASSISTANT_AGENT_ID, assistantSessionId(householdId, memberId));
      const theirs = memberMemory(householdId, memberId);
      if (!theirs) return;
      await deleteEvents(theirs.actorId, theirs.sessionId);
      await deleteRecords(theirs.namespace);
    },
  };
}
