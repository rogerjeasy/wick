/**
 * The Door Card's second server-side button: "Ask Sarah to look".
 *
 * A stranger is on the step, and the person the resident would ring for a
 * second opinion is one press away. The press files a request the family can
 * see (the MCP server's get_door_request), and the card says who was asked.
 * What they answer arrives later as another patch on this same card
 * (answer_door_request).
 *
 * Deterministic, like the chime (actions.ts): no model decides to show
 * someone's doorstep to anyone. The order is the argument. A card that is
 * not a live DOOR card that offered the button asks nobody. The circle is
 * read again at the press, not trusted from when the card was drawn, so
 * someone the resident has since removed is not asked (INV-9). And the
 * request is claimed before the resident is told anything, so a double
 * press or an EventBridge redelivery asks once.
 *
 * The press is the consent. Nothing about the door reaches the family
 * because Wick thought it should: the resident asked, for this one card.
 */
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { DOOR_ACTIONS, DOOR_CARD_TTL_MS, DOOR_LOOK_SK_PREFIX, type CardPatch, type QueuedCard } from '@wick/contracts';
import { parseCardAction, type GateRefusal } from './actions.js';
import { familyToAsk } from './index.js';

export interface FamilyMember {
  readonly userId: string;
  readonly name: string;
}

/** One question about one door card. */
export interface LookRequest {
  readonly householdId: string;
  readonly cardId: string;
  readonly askedAt: number;
  /** When the door card leaves the television — after that there is nothing to answer onto. */
  readonly expiresAt: number;
}

export type AskResult = 'asked' | 'nobody' | GateRefusal;

export interface AskFamilyDeps {
  readonly loadCard: (householdId: string, cardId: string) => Promise<QueuedCard | undefined>;
  /** The people the resident allows right now — read at the press, never cached. */
  readonly listFamily: (householdId: string) => Promise<readonly FamilyMember[]>;
  /** Conditional write of LOOK#<cardId>; false when it already existed. */
  readonly claimOnce: (request: LookRequest) => Promise<boolean>;
  readonly sendPatch: (patch: CardPatch) => Promise<void>;
  /**
   * Tells those people's own browsers there is something to open Wick for
   * (egress.ts nudgeFamily). It carries nothing about the door.
   */
  readonly nudge: (userIds: readonly string[]) => Promise<void>;
  readonly now: () => number;
}

export const NOBODY_TO_ASK_NOTICE = 'There is nobody Wick can ask just now.';

/** How long the request row is kept: long enough to say afterwards that it was asked and answered. */
const LOOK_KEPT_FOR_SEC = 24 * 60 * 60;

/** The people the resident has allowed, from the household's `MEM#<userId>` rows. */
export function allowedFamily(memberships: readonly Record<string, AttributeValue>[]): FamilyMember[] {
  const family: FamilyMember[] = [];
  for (const row of memberships) {
    const userId = row.sk?.S?.replace(/^MEM#/, '');
    const name = row.name?.S;
    if (userId && name && row.status?.S === 'allowed') family.push({ userId, name });
  }
  return family;
}

/** The LOOK# row. Pure, so its shape is tested without AWS. */
export function lookRequestItem(request: LookRequest): Record<string, AttributeValue> {
  return {
    pk: { S: `HH#${request.householdId}` },
    sk: { S: `${DOOR_LOOK_SK_PREFIX}${request.cardId}` },
    cardId: { S: request.cardId },
    askedAt: { N: String(request.askedAt) },
    expiresAt: { N: String(request.expiresAt) },
    ttl: { N: String(Math.floor(request.askedAt / 1000) + LOOK_KEPT_FOR_SEC) },
  };
}

const withoutAskButton = (queued: QueuedCard) => queued.card.actions.filter((a) => a.id !== DOOR_ACTIONS.askFamily);

export async function handleAskFamily(raw: Record<string, unknown>, deps: AskFamilyDeps): Promise<AskResult> {
  const detail = parseCardAction(raw);
  if (!detail || detail.action !== DOOR_ACTIONS.askFamily) return 'ignored';

  const queued = await deps.loadCard(detail.householdId, detail.cardId);
  if (!queued || queued.card.type !== 'DOOR') return 'unknown_card';
  // The device only draws buttons it was sent; a press for one it never had
  // is not a question the resident was ever offered.
  if (!queued.card.actions.some((a) => a.id === DOOR_ACTIONS.askFamily)) return 'not_offered';

  const askedAt = deps.now();
  const expiresAt = queued.expiresAt ?? queued.queuedAt + DOOR_CARD_TTL_MS;
  if (askedAt > expiresAt) return 'stale';

  const family = await deps.listFamily(detail.householdId);
  const who = familyToAsk(family.map((member) => member.name));
  if (!who) {
    // The resident still hears back, plainly, and the button that reaches
    // nobody goes.
    await deps.sendPatch({ cardId: queued.id, notice: NOBODY_TO_ASK_NOTICE, actions: withoutAskButton(queued) });
    return 'nobody';
  }

  if (!(await deps.claimOnce({ householdId: detail.householdId, cardId: queued.id, askedAt, expiresAt }))) return 'duplicate';

  await deps.sendPatch({
    cardId: queued.id,
    notice: `${who.charAt(0).toUpperCase()}${who.slice(1)} has been asked to look.`,
    actions: withoutAskButton(queued),
  });

  // After the resident has been told, and never in the way of it: the
  // question is already filed, and the family app finds it when it is open.
  try {
    await deps.nudge(family.map((member) => member.userId));
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'door_look_nudge_failed', err: err instanceof Error ? err.name : 'unknown' }));
  }
  return 'asked';
}
