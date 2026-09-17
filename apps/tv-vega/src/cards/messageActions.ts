/**
 * Turns a MessageCard's suggested replies into CalmCard actions. Pure and
 * RN-import-free on purpose — see MessageCard.tsx's own comment on why the
 * view component itself carries no test.
 */
import type { CardAction } from '@wick/contracts';
import { MAX_CARD_ACTIONS } from '@wick/contracts';

/** The first reply gets initial focus (CalmCard's default); the rest are peers. */
export function replyActions(suggestedReplies: readonly string[]): readonly CardAction[] {
  return suggestedReplies.slice(0, MAX_CARD_ACTIONS).map((label, i) => ({
    id: `reply_${i}`,
    label,
    kind: i === 0 ? 'primary' : 'secondary',
  }));
}
