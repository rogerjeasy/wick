/**
 * The visit pass, heard by the agent plane (packages/contracts visitPass.ts).
 *
 *   visitor's phone -> edge visit-pass.mjs -> EventBridge (wick.visit / visit.said)
 *     -> agent-card-action -> (this)
 *          the member who arranged it: a nudge of the kind for what was said (egress.ts nudgeFamily)
 *          "I'm at the door" around a ring already carded: that card is told who is there (egress.ts sendPatchToDevice)
 *
 * The edge has already kept the word on the visit and told her televisions'
 * home screens (her day). What is left is what only the agent plane may do:
 * reach a family member's browser, and change a card on her televisions
 * (INV-2: egress.ts is the one way out).
 *
 * The other half of the door's side is the ring itself: a ring that comes
 * after "I'm at the door" reads the word fresh and says who is there from
 * the first (agents/door/route.ts). This is for the other order — the
 * visitor rang, then pressed — so the card already up says the same.
 *
 * The visit stands on the word of the member who arranged it, so they are
 * asked about again here (INV-9), as every errand step asks
 * (agents/errand/step.ts). A nudge carries a kind and nothing else, and the
 * words the member reads are get_errands', past the Guardian.
 *
 * Redelivered, it does no more: the nudge is claimed once per press, and
 * the patch puts the card where it already is.
 *
 * Pure: actionLambda.ts owns the clients.
 */
import {
  VISIT_PASS_LIMITS,
  pushKindForVisitor,
  readVisitSaidDetail,
  visitorArrivedLine,
  visitorConfirmedNotice,
  type CardPatch,
  type ErrandStatus,
  type PushKind,
  type VisitSaidDetail,
} from '@wick/contracts';
import type { HeldErrand } from '../../store/errands.js';

export interface VisitSaidDeps {
  /** The errand as it stands, read consistently (store/errands.ts get). */
  readonly loadErrand: (householdId: string, errandId: string) => Promise<HeldErrand | undefined>;
  /** Whether the resident allows this member right now: their MEM# row, read again (errand/allowed.ts). */
  readonly isAllowed: (householdId: string, userId: string) => Promise<boolean>;
  /** The press is this one's to tell: false when it was already told (visitSaidClaim). */
  readonly claimOnce: (said: VisitSaidDetail) => Promise<boolean>;
  /** egress.ts nudgeFamily: a kind, and nothing about the house. */
  readonly nudge: (userIds: readonly string[], kind: PushKind) => Promise<void>;
  /** egress.ts sendPatchToDevice: the stored card patched, and every television in the home told. */
  readonly sendPatch: (patch: CardPatch, householdId: string) => Promise<void>;
}

export type VisitSaidResult = 'ignored' | 'not_allowed' | { readonly nudged: boolean; readonly patched: boolean };

/** What a visit pass still works for (edge visit-pass.mjs): an errand still waiting for its visitor, or one whose door has rung. */
const SPEAKS_FOR: readonly ErrandStatus[] = ['planned', 'reminded', 'waiting', 'rang'];

/** A day: long past any redelivery, and the row is gone. */
const CLAIM_KEPT_SEC = 86_400;

/** PutItem input claiming one press for its nudge. Pure, so its shape is tested without AWS. */
export function visitSaidClaim(input: { readonly table: string } & VisitSaidDetail) {
  return {
    TableName: input.table,
    Item: {
      pk: { S: `HH#${input.householdId}` },
      sk: { S: `VSAID#${input.errandId}#${input.says}#${input.at}` },
      ttl: { N: String(Math.floor(input.at / 1000) + CLAIM_KEPT_SEC) },
    },
    ConditionExpression: 'attribute_not_exists(pk)',
  };
}

/** The door card the ring made, told who is there — when "I'm at the door" and the ring were close enough to be about each other. */
function doorPatchFor(errand: HeldErrand, said: VisitSaidDetail): CardPatch | undefined {
  if (said.says !== 'at_door' || errand.rangAt === undefined || !errand.cardId) return undefined;
  if (Math.abs(said.at - errand.rangAt) > VISIT_PASS_LIMITS.atDoorFreshMs) return undefined;
  return { cardId: errand.cardId, line: visitorArrivedLine(errand.who), notice: visitorConfirmedNotice(errand.createdByName) };
}

export async function handleVisitSaid(raw: unknown, deps: VisitSaidDeps): Promise<VisitSaidResult> {
  const said = readVisitSaidDetail(raw);
  if (!said) return 'ignored';
  const errand = await deps.loadErrand(said.householdId, said.errandId);
  if (!errand || !SPEAKS_FOR.includes(errand.status)) return 'ignored';
  if (!(await deps.isAllowed(errand.householdId, errand.createdBy))) return 'not_allowed';

  let nudged = false;
  if (errand.tellMe && (await deps.claimOnce(said))) {
    // A courtesy on top of what the edge kept: a failure is logged, never the card's.
    try {
      await deps.nudge([errand.createdBy], pushKindForVisitor(said.says));
      nudged = true;
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: 'visit_said_nudge_failed', errandId: errand.errandId, err: err instanceof Error ? err.name : 'unknown' }));
    }
  }

  const patch = doorPatchFor(errand, said);
  if (patch) await deps.sendPatch(patch, errand.householdId);

  // Ids and what was said only: never who, never the member.
  console.log(JSON.stringify({ level: 'info', msg: 'visit_said', errandId: errand.errandId, says: said.says, nudged, patched: patch !== undefined }));
  return { nudged, patched: patch !== undefined };
}
