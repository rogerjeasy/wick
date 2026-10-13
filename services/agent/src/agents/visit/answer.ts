/**
 * The visit, witnessed — her answer (packages/contracts visit.ts).
 *
 * "Yes, that's right" makes it a visit the resident herself confirmed, and
 * that is all it does: the family's get_visits reads the row.
 *
 * "No, that's not right" confirms nothing. Whether the family hears that
 * she disputed it is hers to decide, so it becomes a question of the kind
 * she already knows — "Shall I tell Sarah?", showing the very sentence
 * that would be told (agents/tell, INV-10). Until she says so, and after
 * "Keep it to myself", the family sees a visit that is simply not
 * confirmed, exactly like one she has not been asked about.
 *
 * Decided from the press alone: which visit from the card's id, which
 * answer from the button. The first answer is the answer (the write is
 * conditional), so a second press or a redelivered one changes nothing.
 */
import { disputedSentence, visitAnswerOf, visitIdFromCardId, type Visit, type VisitAnswer } from '@wick/contracts';
import { parseCardAction } from '../door/actions.js';

/** One "Shall I tell …?" about one disputed visit. */
export interface TellOffer {
  readonly householdId: string;
  readonly differenceId: string;
  readonly sentence: string;
  /** A first name, or "the family". */
  readonly who: string;
  /** The moment the visit began. */
  readonly at: number;
  readonly now: number;
}

export interface VisitAnswerDeps {
  /** Conditional write of the answer; the visit as it then stands, or undefined when there was no open question. */
  readonly answer: (householdId: string, id: string, answer: VisitAnswer, at: number) => Promise<Visit | undefined>;
  /** Takes the card off the home's other televisions. */
  readonly withdraw: (householdId: string, cardId: string) => Promise<void>;
  /**
   * Who she would be telling, in a button's words — or undefined when there
   * is nobody: she allows no family, or keeps who visits to herself. Read at
   * the press (INV-9).
   */
  readonly whoToTell: (householdId: string) => Promise<string | undefined>;
  /** Files the question and puts the Tell card on her television. False when it was already asked. */
  readonly offerToTell: (offer: TellOffer) => Promise<boolean>;
  readonly now: () => number;
  readonly timeZone: string;
}

export type VisitAnswerResult = VisitAnswer | 'not_open' | 'ignored';

async function attempt(what: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: what, err: err instanceof Error ? err.name : 'unknown' }));
  }
}

export async function handleVisitAnswer(raw: Record<string, unknown>, deps: VisitAnswerDeps): Promise<VisitAnswerResult> {
  const detail = parseCardAction(raw);
  const id = detail ? visitIdFromCardId(detail.cardId) : undefined;
  const answer = detail ? visitAnswerOf(detail.action) : undefined;
  if (!detail || !detail.householdId || !id || !answer) return 'ignored';
  const { householdId } = detail;

  const now = deps.now();
  const visit = await deps.answer(householdId, id, answer, now);
  if (!visit) return 'not_open';

  // Her answer is on record whatever happens next.
  await attempt('visit_card_not_withdrawn', () => deps.withdraw(householdId, detail.cardId));
  if (answer === 'confirmed') return 'confirmed';

  await attempt('visit_dispute_not_offered', async () => {
    const who = await deps.whoToTell(householdId);
    if (!who) return;
    await deps.offerToTell({ householdId, differenceId: `visit_disputed-${id}`, sentence: disputedSentence(visit, deps.timeZone), who, at: visit.arrivedAt, now });
  });
  return 'disputed';
}
