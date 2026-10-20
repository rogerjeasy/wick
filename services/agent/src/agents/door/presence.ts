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

/** `simulated`: written by a demo home's stand-in doorbell (demoDoor.ts), and marked as every row of a demo home is. */
export interface TimelineItemOptions {
  readonly simulated?: boolean;
}

/**
 * `motion`: a person seen at the door who did not ring (motion, sub_type
 * human). Marked on the row, so that nothing counts it as a caller or says
 * somebody came (narrator/timeline.ts, get_today.ts). A row without it is a
 * ring, as every row written before it was.
 */
export interface DoorEventOptions extends TimelineItemOptions {
  readonly motion?: boolean;
}

const marked = (options: TimelineItemOptions): Record<string, AttributeValue> =>
  options.simulated ? { simulated: { BOOL: true } } : {};

/** M4 -> M5: a door event that matched the roster (roster.ts). */
export function buildPresenceItem(
  householdId: string,
  match: VisitorMatch,
  at: number,
  id: string,
  options: TimelineItemOptions = {},
): Record<string, AttributeValue> {
  return {
    pk: { S: `HH#${householdId}` },
    sk: { S: `EVT#${padTimestamp(at)}#${id}` },
    type: { S: 'presence' },
    personId: { S: match.personId },
    personName: { S: match.name },
    ...marked(options),
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
  options: DoorEventOptions = {},
): Record<string, AttributeValue> {
  return {
    pk: { S: `HH#${householdId}` },
    sk: { S: `EVT#${padTimestamp(at)}#${id}` },
    type: { S: 'door' },
    ...(options.motion ? { motion: { BOOL: true } } : {}),
    ...marked(options),
  };
}
