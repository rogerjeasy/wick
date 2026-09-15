/**
 * Door agent — two-phase emission. This is the key latency decision.
 *
 *   Phase 1  (<= 900ms from webhook)  line + actions, on screen immediately
 *   Phase 2a (when the image lands)   imageRef patches in
 *   Phase 2b (<= 2200ms, cancel 2500) description patches in
 *
 * A single-shot card that waits for vision blows the 3s budget whenever Bedrock
 * is slow. A late description is worse than none — the resident has already
 * decided. If Phase 2 times out the card simply stays as Phase 1, which is still
 * better than any competitor.
 *
 * The image moved out of Phase 1 for a measured reason: Ring's image retrieval
 * takes ~3.15s end to end (FL-005, SP-2). The design assumed a live snapshot;
 * there is no such call. So Phase 1 is text and buttons, and the picture is a
 * patch like everything else.
 *
 * See docs/WICK-TECHNICAL.md §5.1, §5.2, §9.1.
 */
import { createHash } from 'node:crypto';
import {
  MAX_CARD_ACTIONS,
  type CardAction,
  type CardPatch,
  type DoorCard,
} from '@wick/contracts';
import type { RingDevice, RingHistoryEvent, RingImage } from '@wick/ring';

/** Plain English, always the same, never "motion detected". docs/WICK.md §3.3. */
export const DOOR_LINE = "Someone's at the front door.";

export const DESCRIPTION_MAX_WORDS = 14;

/** Below this, say nothing at all rather than guess. Principle 11. */
export const MIN_DESCRIPTION_CONFIDENCE = 0.6;

/**
 * Words that mark a claim about intent, mood or likelihood rather than an
 * observation. A vision model reaches for these constantly, and every one of
 * them turns a description into a judgement about a stranger at someone's door.
 */
const SPECULATION = [
  'seems', 'seem', 'appears', 'appear', 'probably', 'possibly', 'maybe',
  'might', 'may', 'could', 'likely', 'apparently', 'presumably', 'looks like',
  'trying', 'wants', 'waiting for', 'intends', 'suspicious', 'angry', 'happy',
  'nervous', 'friendly', 'aggressive',
];

export interface DoorCardInput {
  readonly event: RingHistoryEvent;
  readonly device: RingDevice;
  readonly householdId: string;
  readonly correlationId: string;
  readonly now: number;
}

/**
 * The three buttons — minus any the hardware cannot actually do.
 *
 * "Just a moment" needs Chime Controls. Offering it on a device without one
 * produces a button that fails when pressed, which is worse than a button that
 * was never there. D6: state plainly what cannot be done; never fail silently.
 */
function actionsFor(device: RingDevice): readonly CardAction[] {
  const actions: CardAction[] = [
    { id: 'watch_live', label: 'Watch live', kind: 'primary' },
  ];

  if (device.capabilities.chime) {
    actions.push({ id: 'just_a_moment', label: '"Just a moment"', kind: 'secondary' });
  }

  // There is always a way out, and it is always last.
  actions.push({ id: 'dismiss', label: 'Not now', kind: 'dismiss' });

  return actions.slice(0, MAX_CARD_ACTIONS);
}

/**
 * A short, stable card id.
 *
 * Ring event ids are ~100 characters of opaque base32. Carrying one verbatim
 * would put it in the card id, the patch, every log line and the device
 * payload, four times over. Hashing keeps it derived-from-the-event — so a
 * redelivered webhook still rebuilds the same card (INV-6) — without the bulk.
 */
function cardIdFor(eventId: string): string {
  return `door-${createHash('sha256').update(eventId).digest('base64url').slice(0, 12)}`;
}

/**
 * Phase 1. Everything here is local — no Ring call, no model call — so it is
 * bounded by nothing but the webhook itself.
 *
 * The id is derived from the Ring event id so that a redelivered webhook
 * rebuilds the same card rather than stacking a second one on the television
 * (INV-6: idempotent and correlated).
 */
export function buildPhaseOneCard(input: DoorCardInput): DoorCard {
  const { event, device, householdId, correlationId, now } = input;

  return {
    type: 'DOOR',
    id: cardIdFor(event.id),
    householdId,
    correlationId,
    createdAt: now,
    line: DOOR_LINE,
    actions: actionsFor(device),
  };
}

/**
 * Is this a description we are willing to put on someone's television?
 *
 * Deliberately a validator and not only a prompt instruction. A prompt is a
 * request; this is the thing that actually holds when the model ignores it —
 * and a visitor's clothing or signage is untrusted text entering a vision
 * prompt, so it will be ignored eventually.
 */
export function validateDescription(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const words = trimmed.split(/\s+/);
  if (words.length > DESCRIPTION_MAX_WORDS) return false;

  // One sentence. Trailing full stop is fine; a second sentence is not.
  if (/[.!?]\s+\S/.test(trimmed)) return false;

  const lower = trimmed.toLowerCase();
  if (SPECULATION.some((w) => new RegExp(`\\b${w}\\b`).test(lower))) return false;

  return true;
}

export interface DescriptionCandidate {
  readonly description: string;
  readonly confidence: number;
}

/**
 * Phase 2b. Returns null — not an empty patch — when there is nothing worth
 * saying, so a caller cannot accidentally send silence as content.
 */
export function buildDescriptionPatch(
  cardId: string,
  candidate: DescriptionCandidate,
): CardPatch | null {
  if (candidate.confidence < MIN_DESCRIPTION_CONFIDENCE) return null;
  if (!validateDescription(candidate.description)) return null;

  return { cardId, description: candidate.description.trim() };
}

/** Phase 2a. The picture, once Ring has finally handed it over. */
export function buildImagePatch(cardId: string, image: RingImage): CardPatch {
  return { cardId, imageRef: image.url };
}
