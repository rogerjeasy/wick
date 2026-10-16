import { describe, expect, it } from 'vitest';
import type { MemoryStore, MessageData } from '@strands-agents/sdk';
import { memberMemoryStore, memberWordsOnly, memoryManagerFor, onlyTheirWords } from '../memory.js';

const asked = (text: string): MessageData => ({ role: 'user', content: [{ text }] });
const answered = (text: string): MessageData => ({ role: 'assistant', content: [{ text }] });
const called = (): MessageData => ({ role: 'assistant', content: [{ toolUse: { toolUseId: 't1', name: 'get_today', input: {} } }] });
const returned = (text: string): MessageData => ({
  role: 'user',
  content: [{ toolResult: { toolUseId: 't1', status: 'success', content: [{ text }] } }],
});

/** A store that keeps what it is handed: what would have gone to AgentCore. */
function keepingStore(): MemoryStore & { readonly added: { messages: MessageData[]; sequenceNumbers?: readonly number[] }[] } {
  const added: { messages: MessageData[]; sequenceNumbers?: readonly number[] }[] = [];
  return {
    name: 'member',
    writable: true,
    extraction: true,
    added,
    search: async () => [{ content: 'Our plumber is Dave.' }],
    add: async () => { throw new Error('nothing is ever added one fact at a time'); },
    addMessages: async (messages, context) => {
      added.push({ messages, ...(context?.sequenceNumbers ? { sequenceNumbers: context.sequenceNumbers } : {}) });
    },
  };
}

describe('onlyTheirWords — what the assistant may remember is what the member said', () => {
  it('keeps the member’s own sentences and nothing else: no answer, no tool call, no tool result about the resident', () => {
    const kept = onlyTheirWords(
      [asked('Our plumber is Dave.'), called(), returned('{"films":3,"door":6}'), answered('Margaret watched 3 films.')],
      { sequenceNumbers: [4, 5, 6, 7] },
    );

    expect(kept.messages).toEqual([asked('Our plumber is Dave.')]);
    expect(kept.context).toEqual({ sequenceNumbers: [4] });
  });

  it('keeps each kept sentence’s own number, so a retried batch is still recognised', () => {
    const kept = onlyTheirWords([answered('Hello.'), asked('Dave comes on Thursdays.'), answered('Noted.'), asked('Call me Sarah.')], { sequenceNumbers: [10, 11, 12, 13] });

    expect(kept.context.sequenceNumbers).toEqual([11, 13]);
  });

  it('takes only the words from a member’s message that also carries something else', () => {
    const mixed: MessageData = { role: 'user', content: [{ text: 'Our plumber is Dave.' }, { toolResult: { toolUseId: 't1', status: 'success', content: [{ text: 'secret' }] } }] };

    expect(onlyTheirWords([mixed]).messages).toEqual([asked('Our plumber is Dave.')]);
  });
});

describe('memberWordsOnly — the store the agent is given', () => {
  it('hands the real store only the member’s words', async () => {
    const inner = keepingStore();
    const store = memberWordsOnly(inner);

    await store.addMessages!([asked('Our plumber is Dave.'), returned('{"films":3}'), answered('She watched 3 films.')], { sequenceNumbers: [0, 1, 2] });

    expect(inner.added).toEqual([{ messages: [asked('Our plumber is Dave.')], sequenceNumbers: [0] }]);
  });

  it('writes nothing at all when the member said nothing', async () => {
    const inner = keepingStore();

    await memberWordsOnly(inner).addMessages!([returned('{"films":3}'), answered('She watched 3 films.')]);

    expect(inner.added).toEqual([]);
  });

  it('has no way to add one fact of the model’s choosing', () => {
    expect(memberWordsOnly(keepingStore()).add).toBeUndefined();
  });

  it('is searched as the real store is, under the same name, writing as it writes', async () => {
    const store = memberWordsOnly(keepingStore());

    expect(await store.search('plumber')).toEqual([{ content: 'Our plumber is Dave.' }]);
    expect(store).toMatchObject({ name: 'member', writable: true, extraction: true });
  });
});

describe('memoryManagerFor — memory reaches the model, and never as a tool', () => {
  it('gives the agent no memory tool to call: the approval rule never meets a tool that is not Wick’s', () => {
    const manager = memoryManagerFor(keepingStore());

    expect(manager.getTools()).toEqual([]);
  });
});

describe('memberMemoryStore — the official AgentCore Memory store, under the member’s namespace', () => {
  const recordingClient = () => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    return {
      sent,
      client: {
        send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
          sent.push({ name: command.constructor.name, input: command.input });
          return command.constructor.name === 'RetrieveMemoryRecordsCommand'
            ? { memoryRecordSummaries: [{ content: { text: 'Prefers to be told by text.' }, memoryRecordId: 'mem-1', namespaces: [], createdAt: new Date(0) }] }
            : { event: { eventId: '1#ab' } };
        },
      },
    };
  };

  it('reads from /households/{home}/members/{member}', async () => {
    const { client, sent } = recordingClient();
    const store = memberMemoryStore({ memoryId: 'wick_assistant-abcdefghij', householdId: 'hh_1', memberId: 'usr-2', client: client as never })!;

    const found = await store.search('how do I like to be told');

    expect(found.map((e) => e.content)).toEqual(['Prefers to be told by text.']);
    expect(sent[0]).toMatchObject({ name: 'RetrieveMemoryRecordsCommand', input: { memoryId: 'wick_assistant-abcdefghij', namespace: '/households/hh_1/members/usr-2' } });
  });

  it('writes the member’s words as events of the member, in the home', async () => {
    const { client, sent } = recordingClient();
    const store = memberMemoryStore({ memoryId: 'wick_assistant-abcdefghij', householdId: 'hh_1', memberId: 'usr-2', client: client as never })!;

    await store.addMessages!([asked('Our plumber is Dave.'), answered('She watched 3 films.')]);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ name: 'CreateEventCommand', input: { memoryId: 'wick_assistant-abcdefghij', actorId: 'usr-2', sessionId: 'hh_1' } });
    expect(JSON.stringify(sent[0]!.input)).toContain('Our plumber is Dave.');
    expect(JSON.stringify(sent[0]!.input)).not.toContain('films');
  });

  it('is not made for ids AgentCore would refuse', () => {
    expect(memberMemoryStore({ memoryId: 'wick_assistant-abcdefghij', householdId: 'hh 1', memberId: 'usr-2', client: {} as never })).toBeUndefined();
  });
});
