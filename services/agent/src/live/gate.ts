/**
 * Who may watch the front door, and when (spec §4.3, "Security bound").
 *
 * The device token that asks is extractable, and for a television that keeps
 * no secret — the Vega Virtual Device — /pair/refresh mints one from its id
 * alone (INV-1's accepted exception; a television that keeps one is refused
 * such a token, deviceToken.ts `refusesUnproven`). So a live view is
 * only granted while someone is plausibly at the door: for a DOOR card of
 * this household that offered Watch live and is under five minutes old. That
 * bounds what a stolen token can see; it does not eliminate it, and the
 * threat model says so.
 */
import { DOOR_ACTIONS, LIVE_CARD_MAX_AGE_MS, type LiveRefusal, type QueuedCard } from '@wick/contracts';

export interface LiveTarget {
  readonly queued: QueuedCard;
  /** CARD#.ringDeviceId — stored beside the card, never sent to the TV. */
  readonly ringDeviceId?: string;
}

export interface LiveGateDeps {
  readonly loadLiveTarget: (householdId: string, cardId: string) => Promise<LiveTarget | undefined>;
  readonly now: () => number;
}

export type LiveGateOutcome =
  | { readonly pass: true; readonly cardId: string; readonly ringDeviceId: string; readonly correlationId: string }
  | { readonly pass: false; readonly refusal: LiveRefusal };

export async function gateLiveRequest(
  req: { readonly householdId: string; readonly cardId: string },
  deps: LiveGateDeps,
): Promise<LiveGateOutcome> {
  const target = await deps.loadLiveTarget(req.householdId, req.cardId);
  const card = target?.queued.card;
  if (!target || card?.type !== 'DOOR' || !card.actions.some((a) => a.id === DOOR_ACTIONS.watchLive)) {
    return { pass: false, refusal: 'no_such_card' };
  }

  const now = deps.now();
  const expired = target.queued.expiresAt !== undefined && now > target.queued.expiresAt;
  if (expired || now - card.createdAt > LIVE_CARD_MAX_AGE_MS) return { pass: false, refusal: 'card_too_old' };

  if (!target.ringDeviceId) return { pass: false, refusal: 'camera_unavailable' };

  return { pass: true, cardId: card.id, ringDeviceId: target.ringDeviceId, correlationId: card.correlationId };
}
