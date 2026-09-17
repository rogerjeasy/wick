/**
 * Door event orchestrator — the piece that actually gets invoked.
 *
 * `buildPhaseOneCard` (index.ts) is a pure function; nothing called it. This
 * is the glue: turn a Ring event into a Phase 1 card and get it to the
 * device, immediately, without waiting on the image or the description.
 *
 * `sendToDevice` is injected rather than imported so this stays a pure,
 * fast unit test — the Lambda entrypoint wires the real egress.sendToDevice.
 *
 * Phase 2 (image patch, description patch) is deliberately out of scope
 * here: it needs a patch-delivery path (egress has none yet) and is safe to
 * add after Phase 1 is proven on real hardware — a card that never gets its
 * picture is still useful; a card that never arrives at all is not.
 *
 * See docs/WICK-TECHNICAL.md §5.2, §15 (S1).
 */
import type { QueuedCard } from '@wick/contracts';
import { buildPhaseOneCard, type DoorCardInput } from './index.js';

export interface DoorEventDeps {
  readonly sendToDevice: (card: QueuedCard) => Promise<void>;
}

export async function handleDoorEvent(
  input: DoorCardInput,
  deps: DoorEventDeps,
): Promise<QueuedCard> {
  const card = buildPhaseOneCard(input);
  const queued: QueuedCard = {
    id: card.id,
    urgency: 'DOOR',
    card,
    queuedAt: input.now,
    shownCount: 0,
  };

  await deps.sendToDevice(queued);

  return queued;
}
