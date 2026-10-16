import { describe, expect, it } from 'vitest';
import type { ApplyGuardrailCommandInput } from '@aws-sdk/client-bedrock-runtime';
import { checkWithGuardrail, guardrailFromEnv, type GuardrailReply } from '../guardrail.js';

const REF = { id: 'gr-123', version: '1' };
const FACTS = ['This is the whole week: Monday to Sunday.', 'Someone came to the front door 3 times.'];

/** A Guardrail that records what it was asked and answers as told. */
function guardrail(reply: GuardrailReply | Error) {
  const asked: ApplyGuardrailCommandInput[] = [];
  return {
    asked,
    send: async (input: ApplyGuardrailCommandInput) => {
      asked.push(input);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
}

describe('checkWithGuardrail — the Bedrock Guardrail, with contextual grounding against the week’s facts', () => {
  it('asks with the fact lines as the grounding source, the question, and the sentence to guard', async () => {
    const g = guardrail({ action: 'NONE', assessments: [] });

    const result = await checkWithGuardrail(g.send, REF, { source: FACTS, query: 'How was the week?', content: 'Three callers at the door.' });

    expect(result).toEqual({ ok: true });
    expect(g.asked).toEqual([
      {
        guardrailIdentifier: 'gr-123',
        guardrailVersion: '1',
        source: 'OUTPUT',
        content: [
          { text: { text: FACTS.join('\n'), qualifiers: ['grounding_source'] } },
          { text: { text: 'How was the week?', qualifiers: ['query'] } },
          { text: { text: 'Three callers at the door.', qualifiers: ['guard_content'] } },
        ],
      },
    ]);
  });

  it('refuses a sentence the facts do not support, and says why in words a writer can act on', async () => {
    const g = guardrail({
      action: 'GUARDRAIL_INTERVENED',
      assessments: [{ contextualGroundingPolicy: { filters: [{ type: 'GROUNDING', threshold: 0.75, score: 0.31, action: 'BLOCKED', detected: true }] } }],
    });

    const result = await checkWithGuardrail(g.send, REF, { source: FACTS, query: 'q', content: 'Maria came every day.' });

    expect(result).toEqual({ ok: false, reason: 'it says something the facts do not support' });
  });

  it('names a denied topic, a content filter or personal details as the reason', async () => {
    const topic = await checkWithGuardrail(
      guardrail({ action: 'GUARDRAIL_INTERVENED', assessments: [{ topicPolicy: { topics: [{ name: 'guessing-her-mood', type: 'DENY', action: 'BLOCKED' }] } }] }).send,
      REF,
      { source: FACTS, query: 'q', content: 'She seemed lonely.' },
    );
    expect(topic).toEqual({ ok: false, reason: 'it strays into guessing-her-mood' });

    const pii = await checkWithGuardrail(
      guardrail({ action: 'GUARDRAIL_INTERVENED', assessments: [{ sensitiveInformationPolicy: { piiEntities: [{ type: 'PHONE', match: 'x', action: 'ANONYMIZED' }], regexes: [] } }] }).send,
      REF,
      { source: FACTS, query: 'q', content: 'Ring 07700 900000.' },
    );
    expect(pii).toEqual({ ok: false, reason: 'it contains personal details' });
  });

  it('refuses whatever it cannot name, when the Guardrail intervened all the same', async () => {
    const result = await checkWithGuardrail(guardrail({ action: 'GUARDRAIL_INTERVENED', assessments: [] }).send, REF, { source: FACTS, query: 'q', content: 'x' });
    expect(result).toEqual({ ok: false, reason: 'a safety check refused it' });
  });

  it('throws when the Guardrail cannot be asked: the caller decides, and fails closed', async () => {
    await expect(checkWithGuardrail(guardrail(new Error('ThrottlingException')).send, REF, { source: FACTS, query: 'q', content: 'x' })).rejects.toThrow('ThrottlingException');
    await expect(checkWithGuardrail(guardrail({ action: 'NONE', assessments: [] }).send, undefined, { source: FACTS, query: 'q', content: 'x' })).rejects.toThrow('guardrail_not_configured');
  });
});

describe('guardrailFromEnv — which Guardrail, and which published version', () => {
  it('is the id and version infra/agentcore.tf sets, or nothing when either is missing', () => {
    expect(guardrailFromEnv({ AGENTS_GUARDRAIL_ID: 'gr-1', AGENTS_GUARDRAIL_VERSION: '2' })).toEqual({ id: 'gr-1', version: '2' });
    expect(guardrailFromEnv({ AGENTS_GUARDRAIL_ID: 'gr-1' })).toBeUndefined();
    expect(guardrailFromEnv({})).toBeUndefined();
  });
});
