/**
 * The narrative, as a card on the resident's own television — the surface
 * INV-7 requires and, until now, didn't exist. See index.ts's header
 * comment for why residentSeenAt is never set by the Narrator itself: it
 * is set only when the resident presses this card's one button, over on
 * route.mjs (services/edge-device/lambda/route.mjs), which recovers the
 * isoWeek from the card id rather than needing a lookup.
 */
import type { QueuedCard, WeekNarrative } from '@wick/contracts';

export function buildWeekCard(narrative: WeekNarrative, correlationId: string, now: number): QueuedCard {
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
      actions: [{ id: 'seen', label: 'OK', kind: 'primary' }],
      isoWeek: narrative.isoWeek,
      text: narrative.text,
    },
    queuedAt: now,
    shownCount: 0,
  };
}
