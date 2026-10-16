/**
 * The Bedrock Guardrail, as the Sunday brief asks it (infra/guardrail.tf).
 *
 * ApplyGuardrail with contextual grounding: the week's fact lines are the
 * grounding source, so a sentence about her week that the facts do not
 * support is refused by the model-side check as well as by code's own
 * (checkNarrative). The same call carries the denied topics — medical and
 * financial advice, guessing her mood — the content filters and the PII
 * filter.
 *
 * The Guardian (@wick/policy) stays the gate of record (INV-2); this is a
 * second check, and either may refuse. When the Guardrail cannot be asked —
 * not configured, throttled, down — this throws, and the caller treats that
 * as a refusal: a paragraph nobody checked is not written, the facts are.
 *
 * Pure of AWS: the caller hands in the send (runtime/main.ts wires the real
 * BedrockRuntimeClient).
 */
import type { ApplyGuardrailCommandInput, ApplyGuardrailCommandOutput } from '@aws-sdk/client-bedrock-runtime';

export interface GuardrailRef {
  readonly id: string;
  /** A published version: an edit to the draft changes nothing until it is published. */
  readonly version: string;
}

export type GuardrailReply = Pick<ApplyGuardrailCommandOutput, 'action' | 'assessments'>;
export type GuardrailSend = (input: ApplyGuardrailCommandInput) => Promise<GuardrailReply>;

export type GuardrailCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface GuardrailAsk {
  /** The week's fact lines: all a sentence about her week may rest on. */
  readonly source: readonly string[];
  /** What the sentence answers. Contextual grounding scores its relevance to this. */
  readonly query: string;
  /** The sentence to check. */
  readonly content: string;
}

/** The Guardrail infra/agentcore.tf names, or undefined in a deployment that has none. */
export function guardrailFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): GuardrailRef | undefined {
  const id = env.AGENTS_GUARDRAIL_ID;
  const version = env.AGENTS_GUARDRAIL_VERSION;
  return id && version ? { id, version } : undefined;
}

/** Why it intervened, in words the writer is told on its second try. Never the content itself. */
function reasonOf(reply: GuardrailReply): string {
  for (const assessment of reply.assessments ?? []) {
    if (assessment.contextualGroundingPolicy?.filters?.some((f) => f.action === 'BLOCKED')) return 'it says something the facts do not support';
    const topic = assessment.topicPolicy?.topics?.find((t) => t.action === 'BLOCKED');
    if (topic) return `it strays into ${topic.name ?? 'a topic Wick does not talk about'}`;
    if (assessment.sensitiveInformationPolicy?.piiEntities?.some((p) => p.action !== 'NONE')) return 'it contains personal details';
    if (assessment.contentPolicy?.filters?.some((f) => f.action === 'BLOCKED')) return 'a content filter refused it';
  }
  return 'a safety check refused it';
}

export async function checkWithGuardrail(send: GuardrailSend, ref: GuardrailRef | undefined, ask: GuardrailAsk): Promise<GuardrailCheck> {
  if (!ref) throw new Error('guardrail_not_configured');
  const reply = await send({
    guardrailIdentifier: ref.id,
    guardrailVersion: ref.version,
    source: 'OUTPUT',
    content: [
      { text: { text: ask.source.join('\n'), qualifiers: ['grounding_source'] } },
      { text: { text: ask.query, qualifiers: ['query'] } },
      { text: { text: ask.content, qualifiers: ['guard_content'] } },
    ],
  });
  return reply.action === 'GUARDRAIL_INTERVENED' ? { ok: false, reason: reasonOf(reply) } : { ok: true };
}
