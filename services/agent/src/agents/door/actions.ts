/**
 * The Door Card's server-side button: M1, the hallway chime.
 *
 * Deterministic on purpose — no model decides to make a sound in someone's
 * home (spec D4; Ring best practice #6). The order is the safety argument:
 * a card that is not a live DOOR card that offered the button never rings; a
 * card is claimed before anything is played, so a double press or an
 * EventBridge redelivery rings once; and the resident is always told what
 * happened, including "nothing".
 *
 * The three steps are exported separately because the door-action Strands
 * graph (graphs/doorAction.ts) runs them as its nodes; handleCardAction is
 * the same pipeline end to end, for callers that don't need a graph.
 */
import { DOOR_ACTIONS, type CardPatch, type QueuedCard } from '@wick/contracts';
import { summariseChimeOutcomes, type ChimeOutcome, type RingDevice } from '@wick/ring';

export type ChimeResult = ChimeOutcome | 'no_chime';

export const CHIME_NOTICE: Record<ChimeResult, string> = {
  rang: 'The hallway chime rang.',
  snoozed: 'The hallway chime is snoozed, so it stayed quiet.',
  offline: "The hallway chime didn't answer.",
  failed: "The hallway chime didn't answer.",
  no_audio: 'The hallway chime has no sound set up for Wick.',
  no_chime: "There's no hallway chime Wick can reach.",
};

/** Why a press went no further than the gate. */
export type GateRefusal = 'ignored' | 'unknown_card' | 'not_offered' | 'stale' | 'duplicate';

export type CardActionResult = ChimeResult | GateRefusal;

export interface CardActionDeps {
  readonly loadCard: (householdId: string, cardId: string) => Promise<QueuedCard | undefined>;
  /** Conditional write of CHIME#<cardId>; false when it already existed. */
  readonly claimOnce: (householdId: string, cardId: string) => Promise<boolean>;
  /** Fresh from Ring — not the Phase 1 cache; this is the moment of truth. */
  readonly listDevices: () => Promise<readonly RingDevice[]>;
  readonly ringChime: (chimeId: string) => Promise<ChimeOutcome>;
  readonly sendPatch: (patch: CardPatch) => Promise<void>;
  readonly now: () => number;
}

export interface CardActionDetail {
  readonly householdId: string;
  readonly cardId: string;
  readonly action: string;
}

export function parseCardAction(raw: Record<string, unknown>): CardActionDetail | null {
  const { householdId, cardId, action } = raw;
  if (typeof householdId !== 'string' || typeof cardId !== 'string' || typeof action !== 'string') return null;
  return { householdId, cardId, action };
}

export type GateOutcome =
  | { readonly pass: true; readonly detail: CardActionDetail; readonly queued: QueuedCard }
  | { readonly pass: false; readonly result: GateRefusal };

/** Step 1. Everything that must be true before a sound is made. */
export async function gateChimePress(
  raw: Record<string, unknown>,
  deps: Pick<CardActionDeps, 'loadCard' | 'claimOnce' | 'now'>,
): Promise<GateOutcome> {
  const detail = parseCardAction(raw);
  if (!detail || detail.action !== DOOR_ACTIONS.hallwayChime) return { pass: false, result: 'ignored' };

  const queued = await deps.loadCard(detail.householdId, detail.cardId);
  if (!queued || queued.card.type !== 'DOOR') return { pass: false, result: 'unknown_card' };
  // The device only draws buttons it was sent; a press for one it never had
  // is not a press the household's chime list ever vouched for.
  if (!queued.card.actions.some((a) => a.id === DOOR_ACTIONS.hallwayChime)) return { pass: false, result: 'not_offered' };
  if (queued.expiresAt !== undefined && deps.now() > queued.expiresAt) return { pass: false, result: 'stale' };

  // Last, so a refused press never burns the card's one ring.
  if (!(await deps.claimOnce(detail.householdId, detail.cardId))) return { pass: false, result: 'duplicate' };

  return { pass: true, detail, queued };
}

/** Step 2. Every chime in the house, at once; never retried. */
export async function ringHallwayChimes(deps: Pick<CardActionDeps, 'listDevices' | 'ringChime'>): Promise<ChimeResult> {
  let devices: readonly RingDevice[];
  try {
    devices = await deps.listDevices();
  } catch {
    // The press is claimed; the resident still hears back, plainly.
    return 'failed';
  }
  const chimes = devices.filter((d) => d.capabilities.chime);
  const outcomes = await Promise.all(chimes.map((c) => deps.ringChime(c.id)));
  return summariseChimeOutcomes(outcomes);
}

/** Step 3. The sentence, and the card without a button that has done its one job. */
export function chimePatch(queued: QueuedCard, result: ChimeResult): CardPatch {
  return {
    cardId: queued.id,
    notice: CHIME_NOTICE[result],
    actions: queued.card.actions.filter((a) => a.id !== DOOR_ACTIONS.hallwayChime),
  };
}

export async function handleCardAction(raw: Record<string, unknown>, deps: CardActionDeps): Promise<CardActionResult> {
  const gate = await gateChimePress(raw, deps);
  if (!gate.pass) return gate.result;

  const result = await ringHallwayChimes(deps);
  await deps.sendPatch(chimePatch(gate.queued, result));
  return result;
}
