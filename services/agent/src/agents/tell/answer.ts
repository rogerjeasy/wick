/**
 * "Shall I tell Sarah?" — the answer.
 *
 * The resident's press on a Tell card (ask.ts) is the only thing that makes
 * a difference readable by the family: "Tell Sarah" marks its row told and
 * nudges the family's own browsers; "Keep it to myself" marks it kept, and
 * nobody is told anything — not even that there was a question.
 *
 * Deterministic, and decided from the press alone: which difference comes
 * from the card's id, which answer from the button. The first answer is the
 * answer (the write is conditional), so a second press or a redelivered one
 * changes nothing and nudges nobody. And who is nudged is the circle as it
 * stands at the press (INV-9), not as it stood when the card was drawn.
 */
import { differenceIdFromTellCardId, tellAnswerOf, type TellAnswer } from '@wick/contracts';
import { parseCardAction } from '../door/actions.js';
import type { FamilyMember } from '../door/askFamily.js';

export type TellAnswerResult = 'told' | 'kept' | 'not_open' | 'ignored';

export interface AnswerDeps {
  /** Conditional write of the answer onto TELL#<differenceId>; false when there is no open question to answer. */
  readonly recordAnswer: (householdId: string, differenceId: string, answer: TellAnswer, at: number) => Promise<boolean>;
  readonly listFamily: (householdId: string) => Promise<readonly FamilyMember[]>;
  /** Tells those people's own browsers there is something to open Wick for. It carries nothing about the house. */
  readonly nudge: (userIds: readonly string[]) => Promise<void>;
  /**
   * Takes the card off every television in the home (egress.ts
   * withdrawFromDevices). The one that was pressed has already put it away;
   * a second one in another room would otherwise go on asking a question
   * that has been answered.
   */
  readonly withdraw: (householdId: string, cardId: string) => Promise<void>;
  readonly now: () => number;
}

export async function handleTellAnswer(raw: Record<string, unknown>, deps: AnswerDeps): Promise<TellAnswerResult> {
  const detail = parseCardAction(raw);
  const differenceId = detail ? differenceIdFromTellCardId(detail.cardId) : undefined;
  const answer = detail ? tellAnswerOf(detail.action) : undefined;
  if (!detail || !differenceId || !answer) return 'ignored';

  if (!(await deps.recordAnswer(detail.householdId, differenceId, answer, deps.now()))) return 'not_open';

  // The answer is on record whatever happens next. A card that could not be
  // withdrawn only means a late press somewhere, which changes nothing.
  try {
    await deps.withdraw(detail.householdId, detail.cardId);
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'tell_card_not_withdrawn', err: err instanceof Error ? err.name : 'unknown' }));
  }
  if (answer === 'keep') return 'kept';

  // After the answer is on record, and never in the way of it: what was
  // told is read through the family's own tools whenever they next look.
  try {
    const family = await deps.listFamily(detail.householdId);
    await deps.nudge(family.map((member) => member.userId));
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'told_nudge_failed', err: err instanceof Error ? err.name : 'unknown' }));
  }
  return 'told';
}
