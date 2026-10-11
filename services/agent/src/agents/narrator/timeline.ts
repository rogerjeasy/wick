/**
 * Raw EVT#<ts>#<id> DynamoDB item -> the weekly narrative's TimelineEntry.
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
import { parseTimestampFromSortKey, type TimelineEntry } from '@wick/contracts';

const SK_PATTERN = /^EVT#\d{15}#/;

export function toTimelineEntry(item: Record<string, AttributeValue>): TimelineEntry | undefined {
  const sk = item.sk?.S;
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
        kind: 'visit',
        summary: name ? `${name} visited.` : 'Someone visited.',
        ...(personId ? { personId } : {}),
      };
    }

    default:
      return undefined;
  }
}
