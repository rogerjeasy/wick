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
 * Beside the tools' texts the source carries one fixed line of who is who
 * and how Wick works (`houseFacts`): the tools' JSON never says that a reply
 * to a note is the resident's, or that a note waits for a natural break, so
 * the Guardrail refused true replies that said so in plain words — three of
 * five turns on 2026-10-20 (scored 0.03 to 0.18; with the line, 0.90 to 0.99,
 * and a reply the facts do not support is still refused).
 *
 * A refused reply is not said: the turn returns without it, and the Wick
 * server answers `unsupported`, so the family app says the tools' own
 * sentences (services/mcp-server/src/assistant/turn.ts). A Guardrail that
 * cannot be asked refuses too: a reply nobody checked is not said.
 */
import { checkWithGuardrail, type GuardrailRef, type GuardrailSend } from '../brief/guardrail.js';
import { readableForGrounding } from './grounding.js';
import type { Who } from './prompt.js';
import type { AssistantTurnDeps } from './turn.js';

/**
 * Who is who, and what Wick always does, in words a reply may use: true of
 * every home and every turn, and nothing about this home's week. Written
 * without a pronoun for the resident: the family's name for them is all
 * Wick knows.
 */
export function houseFacts(who: Pick<Who, 'memberName' | 'residentName'>): string {
  const { memberName: member, residentName: resident } = who;
  return (
    `${resident} is the person at home, and the television is ${resident}'s television. ${member} is the person asking. ` +
    `A reply to a note is ${resident}'s reply, given on ${resident}'s television. ` +
    `A note waits on ${resident}'s television for the next natural break (a pause, the credits or a calm point in a film), never the middle of a programme, and then ${resident} sees it.`
  );
}

export function guardReplyWith(send: GuardrailSend, ref: GuardrailRef): NonNullable<AssistantTurnDeps['guardReply']> {
  return async (say, { question, toolTexts, timeZone, who }) => {
    try {
      // The facts as the Guardrail can read them: moments and weeks written out (grounding.ts).
      const facts = timeZone ? toolTexts.map((text) => readableForGrounding(text, timeZone)) : toolTexts;
      // With no tool text there is nothing to ground on, and the line alone must not make a reply grounded.
      const source = facts.length > 0 && who ? [houseFacts(who), ...facts] : facts;
      const check = await checkWithGuardrail(send, ref, { source, query: question ?? '', content: say, withoutFacts: 'topics_only' });
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
