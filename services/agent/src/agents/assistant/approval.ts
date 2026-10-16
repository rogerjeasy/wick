/**
 * Nothing changes until the member says yes — on the agent as in the app.
 *
 * Before the agent, the browser drove the loop: it was shown each call the
 * model wanted, asked the member to confirm any that writes (a note on her
 * television, a visit at her door), and only then called the tool itself.
 * The agent now makes the calls, so the confirmation moves into the agent,
 * through Strands' own human-in-the-loop interrupts:
 *
 *   - Before every tool call (BeforeToolCallEvent), a tool that does not
 *     say it only reads — its MCP `annotations.readOnlyHint` is not `true`,
 *     including a tool that says nothing about itself — raises an
 *     interrupt. The agent stops; nothing has been called. The interrupt
 *     carries the call's name and arguments, which the family app shows on
 *     its confirm card (turn.ts `needsApproval`).
 *   - The member's answer resumes the agent with that interrupt's response.
 *     Strands keys an interrupt to one tool call (its toolUseId), so a yes
 *     is a yes to that call with those arguments, and to nothing else: a
 *     second write the model chooses afterwards raises its own.
 *   - Anything but `true` — no, or no answer — cancels the call, and the
 *     model is told in a sentence that the member chose not to.
 *
 * The annotations are Wick's own server's (tools are discovered from it, as
 * the app discovers them): the rule here is the app's own rule
 * (apps/sim-alexa/surface.js `needsConfirmation`), and fails closed the
 * same way.
 *
 * And the size of a turn: at most six rounds of tools, at most four calls
 * in one round. A round asking for more is refused as a whole, before any of
 * it runs, and the model is told why.
 */
import type { BeforeToolCallEvent, BeforeToolsEvent, JSONValue, Tool } from '@strands-agents/sdk';

/** What the model is told when the member says no. Not an error: it is their answer. */
export const DECLINED_TEXT = 'The member chose not to do this. Nothing was sent or changed.';
/** The interrupt's name: one per tool call, so its id is unique to that call. */
export const APPROVAL = 'approve';

export const MAX_TOOL_ROUNDS = 6;
export const MAX_CALLS_PER_ROUND = 4;

export const TOO_MANY_CALLS_TEXT = `Call at most ${MAX_CALLS_PER_ROUND} tools at once. None of these were called; ask again for fewer.`;
export const NO_SUCH_TOOL_TEXT = 'There is no such tool. Nothing was called.';

/** What the member is shown and answers: the call, exactly as it will be made. */
export interface ApprovalReason {
  readonly tool: string;
  readonly args: JSONValue;
}

/** Whether a tool must wait for the member's yes: every one that does not say it only reads. */
export const needsApproval = (tool: Tool | undefined): boolean => tool?.toolSpec.annotations?.readOnlyHint !== true;

/** The BeforeToolCallEvent hook. Throws Strands' interrupt the first time; on resume, reads the answer. */
export function askBeforeWriting(event: BeforeToolCallEvent): void {
  if (!event.tool) {
    // Strands answers an unknown tool itself; nothing to ask about, and nothing may run.
    event.cancel = NO_SUCH_TOOL_TEXT;
    return;
  }
  if (!needsApproval(event.tool)) return;
  const reason: ApprovalReason = { tool: event.toolUse.name, args: event.toolUse.input };
  const answer = event.interrupt<JSONValue>({ name: APPROVAL, reason: reason as unknown as JSONValue });
  if (answer !== true) event.cancel = DECLINED_TEXT;
}

const ROUNDS = 'wick.assistant.rounds';

/** The BeforeToolsEvent hook: a round of more than four calls, or a seventh round, runs nothing. */
export function keepTheTurnSmall(event: BeforeToolsEvent): void {
  const rounds = (typeof event.invocationState[ROUNDS] === 'number' ? (event.invocationState[ROUNDS] as number) : 0) + 1;
  event.invocationState[ROUNDS] = rounds;
  const calls = event.message.content.filter((block) => block.type === 'toolUseBlock').length;
  if (rounds > MAX_TOOL_ROUNDS) event.cancel = 'That is more steps than one question may take. Answer with what you have.';
  else if (calls > MAX_CALLS_PER_ROUND) event.cancel = TOO_MANY_CALLS_TEXT;
}
