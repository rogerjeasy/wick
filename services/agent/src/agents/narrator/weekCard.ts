/**
 * The narrative, as a card on the resident's own television — the surface
 * INV-7 requires and, until now, didn't exist. See index.ts's header
 * comment for why residentSeenAt is never set by the Narrator itself: it
 * is set only when the resident presses this card's one button, over on
 * route.mjs (services/edge-device/lambda/route.mjs), which recovers the
 * isoWeek from the card id rather than needing a lookup.
 */
import { WEEK_ACTIONS, type QueuedCard, type WeekNarrative } from '@wick/contracts';

/**
 * `familyName` is the household's family member as the resident knows them
 * (WICK_FAMILY_NAME). The second button opens "What Sarah sees" over this
 * card (trust promise 2); OK stays first and focused, because only OK
 * releases the week to the family.
 */
export function buildWeekCard(narrative: WeekNarrative, correlationId: string, now: number, familyName?: string): QueuedCard {
  const id = `week-${narrative.isoWeek}`;

  return {
    id,
    urgency: 'DEFERRED',
    card: {
      type: 'WEEK',
      id,
      householdId: narrative.householdId,
      correlationId,
      createdAt: now,
      actions: [
        { id: WEEK_ACTIONS.seen, label: 'OK', kind: 'primary' },
        { id: WEEK_ACTIONS.sharing, label: `What ${familyName ?? 'your family'} sees`, kind: 'secondary' },
      ],
      isoWeek: narrative.isoWeek,
      text: narrative.text,
    },
    queuedAt: now,
    shownCount: 0,
  };
}
