/**
 * M4 -> M5. When a door event matches the roster (roster.ts), that is a
 * real presence worth recording — the same EVT#<ts>#<id> timeline
 * route.mjs writes card_shown/card_action to, in the exact shape
 * get_today.ts and did_visitor_come.ts already read: `type: 'presence'`,
 * `personId`, `personName`, no separate `at` attribute (the timestamp lives
 * only in the sort key — see timeline.ts's own comment on why).
 *
 * Until now nothing wrote this shape for real; only
 * scripts/seed-mcp-stub-data.ts faked it. "Did Maria come on Tuesday?"
 * (M5) could only ever be answered from seeded data — this is what makes
 * it a real answer.
 */
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { padTimestamp, type VisitorMatch } from '@wick/contracts';

export function buildPresenceItem(
  householdId: string,
  match: VisitorMatch,
  at: number,
  id: string,
): Record<string, AttributeValue> {
  return {
    pk: { S: `HH#${householdId}` },
    sk: { S: `EVT#${padTimestamp(at)}#${id}` },
    type: { S: 'presence' },
    personId: { S: match.personId },
    personName: { S: match.name },
  };
}
