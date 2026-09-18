/**
 * Timeline items the Door orchestrator writes, in the exact EVT#<ts>#<id>
 * shape route.mjs already writes card_shown/card_action to, and get_today.ts
 * / did_visitor_come.ts already read: no separate `at` attribute — the
 * timestamp lives only in the sort key (see timeline.ts's own comment on
 * why) — so both readers parse it back out rather than off an item
 * attribute.
 *
 * Until now nothing wrote either shape for real; only
 * scripts/seed-mcp-stub-data.ts faked them. "Did Maria come on Tuesday?"
 * (M5) and "what happened at the door today?" (get_today.ts's 'door' case,
 * D3's data source) could only ever be answered from seeded data — this is
 * what makes them real answers.
 */
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { padTimestamp, type VisitorMatch } from '@wick/contracts';

/** M4 -> M5: a door event that matched the roster (roster.ts). */
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

/**
 * Every door-worthy event, matched or not — the generic "someone was at
 * the door" marker. Written alongside buildPresenceItem's more specific
 * record when there's also a roster match; on its own the rest of the time.
 */
export function buildDoorEventItem(
  householdId: string,
  at: number,
  id: string,
): Record<string, AttributeValue> {
  return {
    pk: { S: `HH#${householdId}` },
    sk: { S: `EVT#${padTimestamp(at)}#${id}` },
    type: { S: 'door' },
  };
}
