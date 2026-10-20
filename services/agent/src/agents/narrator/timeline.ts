/**
 * Raw EVT#<ts>#<id> or VISIT# DynamoDB item -> the weekly narrative's TimelineEntry.
 *
 * card_shown/card_action (route.mjs) are deliberately not mapped: too
 * granular for a week-level narrative and not what "how's Mum been this
 * week" is asking about. TimelineEntry's 'card' and 'deviation' kinds stay
 * unused here — 'card' needs a product decision about which actions are
 * narrative-worthy, and a deviation is not an event with a moment: the
 * Rhythm baseline reports it on the week (WeekNarrative.deltas,
 * rhythm/baseline.ts), not as an entry in it.
 */
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { VISIT_SK_PREFIX, confirmedVisitSentence, doorWhenExpected, parseTimestampFromSortKey, type TimelineEntry } from '@wick/contracts';

const SK_PATTERN = /^EVT#\d{15}#/;

/**
 * An EVT# row, or a VISIT# row (packages/contracts visit.ts). A `presence`
 * row is somebody at the door when a regular visitor was expected — never
 * "<name> visited": a courier in the carer's hour writes the same row. Only
 * a visit the resident confirmed says who came.
 */
export function toTimelineEntry(item: Record<string, AttributeValue>): TimelineEntry | undefined {
  const sk = item.sk?.S;
  if (sk?.startsWith(VISIT_SK_PREFIX)) return confirmedVisitEntry(item);
  if (!sk || !SK_PATTERN.test(sk)) return undefined;
  const at = parseTimestampFromSortKey(sk);

  switch (item.type?.S) {
    case 'door':
      return { at, kind: 'door', summary: 'Someone was at the front door.' };

    case 'presence': {
      const personId = item.personId?.S;
      const name = item.personName?.S;
      return {
        at,
        kind: 'presence',
        summary: name ? doorWhenExpected(name) : 'Someone came to the door when a regular visitor was expected.',
        ...(personId ? { personId } : {}),
        ...(name ? { name } : {}),
      };
    }

    default:
      return undefined;
  }
}

/** A VISIT# row the resident answered "Yes, that's right" to. Any other answer, or none, is not a visit to tell. */
function confirmedVisitEntry(item: Record<string, AttributeValue>): TimelineEntry | undefined {
  if (item.answer?.S !== 'confirmed') return undefined;
  const at = Number(item.arrivedAt?.N);
  const name = item.name?.S;
  const personId = item.personId?.S;
  if (!Number.isFinite(at) || !name || !personId) return undefined;
  return { at, kind: 'visit', summary: confirmedVisitSentence(name), personId, name };
}
