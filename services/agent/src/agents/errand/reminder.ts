/**
 * Her reminder of a visit the family arranged: "A reminder from Sarah: the
 * plumber is coming this morning at 10:00 am."
 *
 * A note from the member, on her television at the next natural break
 * (DEFERRED — INV-5), answered like any note with one button. The sentence
 * is written here, by code, from the errand — never by a model, and never
 * by the member: what they wrote is who is coming, already through the
 * Guardian when the errand was made. The phrasebook holds the sentence
 * whole (packages/contracts phrasebook/es.ts), so she reads it in her
 * language; its card id marks it as Wick's own, so it is never handed to a
 * machine translator (contracts errand.ts ERRAND_REMINDER_CARD_PREFIX).
 */
import { clockTime, errandReminderCardId, type Errand, type QueuedCard } from '@wick/contracts';

/** What she can answer: thanks, or an acknowledgement. Both in the phrasebook already. */
export const REMINDER_REPLIES = ['Thanks for letting me know!', 'OK'] as const;

const firstName = (name: string): string => name.trim().split(/\s+/)[0] || name;
const localDay = (at: number, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
const localHour = (at: number, timeZone: string): number =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(at));
const weekday = (at: number, timeZone: string): string => new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long' }).format(at);

/** "this morning at 10:00 am" on the day; "on Thursday at 12:30 am" from the day before. */
function whenFrom(now: number, at: number, timeZone: string): string {
  const time = clockTime(at, timeZone);
  if (localDay(now, timeZone) !== localDay(at, timeZone)) return `on ${weekday(at, timeZone)} at ${time}`;
  const hour = localHour(at, timeZone);
  const part = hour < 12 ? 'this morning' : hour < 17 ? 'this afternoon' : 'this evening';
  return `${part} at ${time}`;
}

export function reminderSentence(errand: Pick<Errand, 'createdByName' | 'who' | 'at'>, timeZone: string, now: number): string {
  return `A reminder from ${firstName(errand.createdByName)}: ${errand.who} is coming ${whenFrom(now, errand.at, timeZone)}.`;
}

export function buildErrandReminder(errand: Errand, timeZone: string, now: number): QueuedCard {
  const id = errandReminderCardId(errand.errandId);
  return {
    id,
    urgency: 'DEFERRED',
    queuedAt: now,
    shownCount: 0,
    card: {
      type: 'MESSAGE',
      id,
      householdId: errand.householdId,
      correlationId: errand.errandId,
      createdAt: now,
      actions: [],
      // The name the resident allowed, as on any note from them.
      fromName: errand.createdByName,
      transcript: reminderSentence(errand, timeZone, now),
      suggestedReplies: [...REMINDER_REPLIES],
    },
  };
}
