/**
 * The Bedrock Guardrail on the assistant's reply — and only on its reply.
 *
 * A family member asking "How has my mum been this week?" is what Wick is
 * for, so the member's own question is never put through the Guardrail: its
 * denied topics (medical and financial advice, guessing her mood) refused
 * that very question when they were attached to the model's input. What
 * the agent *says* is checked instead, with `ApplyGuardrail`: the tools' own
 * texts are the grounding source and the question the query, so a sentence
 * the tools did not support is refused, and so is any guess about how she
 * feels. A reply that called no tool (a clarifying question) has nothing
 * to ground on; it is let through grounding by name (`withoutFacts`), and the
 * topics and filters still read it. The Wick server's number check still
 * refuses any number in it the question did not give
 * (services/mcp-server/src/assistant/turn.ts).
 *
 * A refused reply is not said: the turn returns without it, and the Wick
 * server answers `unsupported`, so the family app says the tools' own
 * sentences (services/mcp-server/src/assistant/turn.ts). A Guardrail that
 * cannot be asked refuses too: a reply nobody checked is not said.
 */
import { checkWithGuardrail, type GuardrailRef, type GuardrailSend } from '../brief/guardrail.js';
import type { AssistantTurnDeps } from './turn.js';

export function guardReplyWith(send: GuardrailSend, ref: GuardrailRef): NonNullable<AssistantTurnDeps['guardReply']> {
  return async (say, { question, toolTexts }) => {
    try {
      const check = await checkWithGuardrail(send, ref, { source: toolTexts, query: question ?? '', content: say, withoutFacts: 'topics_only' });
      // Why, never what: the reason names a policy, not the words it refused.
      if (!check.ok) console.log(JSON.stringify({ level: 'warn', msg: 'assistant_guardrail_refused', why: check.reason }));
      return check.ok;
    } catch (err) {
      const e = err as Error;
      console.log(JSON.stringify({ level: 'warn', msg: 'assistant_guardrail_unavailable', error: `${e.name}: ${e.message}`.slice(0, 200) }));
      return false;
    }
  };
}
