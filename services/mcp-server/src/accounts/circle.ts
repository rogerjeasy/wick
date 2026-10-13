/**
 * The family circle: who may reach a household, and how they come to.
 *
 * INV-9: a person can read a household only after the resident has allowed
 * them on the television. Every way in here — setting a household up,
 * accepting an invitation — ends in a membership that is `pending` and a
 * card on the resident's television. The only thing that turns `pending`
 * into `allowed` is the resident's own press (services/edge-device/lambda/
 * circle.mjs). Nothing in this file can do it.
 *
 * Never nag (docs/WICK.md Principle 8): once the resident has said no, the
 * same invitation cannot put the question to them again. The organiser has
 * to decide to ask, with a new one.
 */
import {
  CIRCLE_ACTIONS,
  MAX_CARD_DETAIL_CHARS,
  circleCardId,
  type MemberStatus,
  type QueuedCard,
} from '@wick/contracts';
import type { Identity } from './identity.js';
import type { AccountStore } from './store.js';
import type { Household, Membership, Television } from './types.js';

export interface CircleDeps {
  readonly store: AccountStore;
  /** services/agent/src/egress.ts's sendToDevice — the only path to the television (INV-2). */
  readonly sendCard: (card: QueuedCard) => Promise<void>;
  readonly now: () => number;
  /** A fresh, unguessable, URL-safe id. */
  readonly newId: () => string;
}

export type CircleErrorCode = 'name_required' | 'not_organiser' | 'not_a_member' | 'invitation_invalid' | 'cannot_remove_self' | 'not_a_television';

export class CircleError extends Error {
  readonly code: CircleErrorCode;
  constructor(code: CircleErrorCode) {
    super(code);
    this.name = 'CircleError';
    this.code = code;
  }
}

export interface Invitation {
  readonly code: string;
  readonly householdId: string;
  readonly invitedBy: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** Long enough to reach a brother who reads his messages at the weekend. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const MAX_NAME_CHARS = 40;

/**
 * A name as it will be shown on a television in large type: one line, no
 * control characters, short enough to leave the card's buttons on screen.
 */
export function cleanName(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_CHARS)
    .trim();
}

const firstName = (name: string): string => name.split(' ')[0] ?? name;

/**
 * The card the resident answers. The server writes every word; the
 * television renders it (apps/tv-vega/src/cards/CircleCard.tsx).
 */
export function buildCircleCard(household: Household, member: Membership, now: number): QueuedCard {
  const id = circleCardId(member.userId);
  const name = cleanName(member.name);
  const first = firstName(name);
  const detail =
    `If you allow it, ${first} can send you notes here and see what you choose to share. ` +
    'You can change what is shared at any time.';
  return {
    id,
    urgency: 'DEFERRED',
    queuedAt: now,
    shownCount: 0,
    card: {
      type: 'CIRCLE',
      id,
      householdId: household.householdId,
      correlationId: id,
      createdAt: now,
      personName: name,
      role: member.role,
      headline: `${name} would like to join your family circle.`,
      detail: detail.slice(0, MAX_CARD_DETAIL_CHARS),
      actions: [
        { id: CIRCLE_ACTIONS.allow, label: `Allow ${first}`, kind: 'primary' },
        { id: CIRCLE_ACTIONS.decline, label: 'No, thank you', kind: 'secondary' },
      ],
    },
  };
}

/**
 * Ask the resident. The card is written before the membership: a card for
 * a membership that failed to save is harmless (the press finds nothing to
 * change), and a retry sends it again; a membership with no card would
 * leave the person waiting for an answer nobody was asked for.
 */
async function askResident(deps: CircleDeps, household: Household, membership: Membership): Promise<void> {
  await deps.sendCard(buildCircleCard(household, membership, deps.now()));
  await deps.store.putMembership(membership);
}

export function createHousehold(
  deps: CircleDeps,
  person: Identity,
  input: { readonly residentName: string; readonly name?: string | undefined; readonly simulated?: boolean },
): Promise<Household> {
  return establishHousehold(deps, person, { ...input, householdId: `hh_${deps.newId()}` });
}

/**
 * Give a household that existed before accounts did its first organiser,
 * keeping its id — and with it the timeline, the weeks and the doorbell
 * link filed under that id. For scripts/adopt-household.ts only: no request
 * may ever choose a household id (INV-8). It cannot take a household that
 * already has an organiser (store.ts's createHousehold refuses), and the
 * resident is asked on the television like for anyone else.
 */
export function adoptHousehold(
  deps: CircleDeps,
  person: Identity,
  input: { readonly householdId: string; readonly residentName: string; readonly name?: string | undefined },
): Promise<Household> {
  return establishHousehold(deps, person, input);
}

async function establishHousehold(
  deps: CircleDeps,
  person: Identity,
  input: { readonly householdId: string; readonly residentName: string; readonly name?: string | undefined; readonly simulated?: boolean },
): Promise<Household> {
  const residentName = cleanName(input.residentName);
  if (!residentName) throw new CircleError('name_required');

  const now = deps.now();
  const household: Household = {
    householdId: input.householdId,
    name: cleanName(input.name ?? '') || `${residentName}’s home`,
    residentName,
    createdBy: person.userId,
    createdAt: now,
    ...(input.simulated ? { simulated: true } : {}),
  };
  await deps.store.createHousehold(household);
  await askResident(deps, household, {
    householdId: household.householdId,
    userId: person.userId,
    name: cleanName(person.name) || person.email,
    role: 'organiser',
    status: 'pending',
    requestedAt: now,
  });
  return household;
}

export async function requireOrganiser(deps: CircleDeps, actor: { householdId: string; userId: string }): Promise<Membership> {
  const membership = await deps.store.getMembership(actor.householdId, actor.userId);
  // An organiser still waiting for the resident may invite and connect the
  // television: nobody they invite can read anything until the resident
  // allows that person too.
  if (membership?.role !== 'organiser' || (membership.status !== 'allowed' && membership.status !== 'pending')) {
    throw new CircleError('not_organiser');
  }
  return membership;
}

export async function createInvitation(deps: CircleDeps, actor: { householdId: string; userId: string }): Promise<Invitation> {
  await requireOrganiser(deps, actor);
  const now = deps.now();
  const invitation: Invitation = {
    code: deps.newId(),
    householdId: actor.householdId,
    invitedBy: actor.userId,
    createdAt: now,
    expiresAt: now + INVITATION_TTL_MS,
  };
  await deps.store.putRecord('INV', invitation.code, invitation, invitation.expiresAt);
  return invitation;
}

export interface InvitationView {
  readonly invitation: Invitation;
  readonly household: Household;
  readonly invitedByName: string;
}

/** What the invited person is shown before they join. Undefined when the invitation is gone. */
export async function describeInvitation(deps: CircleDeps, code: string): Promise<InvitationView | undefined> {
  const invitation = code ? await deps.store.getRecord<Invitation>('INV', code) : undefined;
  if (!invitation) return undefined;
  const [household, inviter] = await Promise.all([
    deps.store.getHousehold(invitation.householdId),
    deps.store.getMembership(invitation.householdId, invitation.invitedBy),
  ]);
  if (!household) return undefined;
  return { invitation, household, invitedByName: inviter?.name ?? 'Your family' };
}

/**
 * Whether accepting this invitation would put a question to the resident.
 * Not for someone they already allowed, nor for someone still waiting. And
 * not for someone they turned down or the organiser removed, unless the
 * invitation was made after that: only a newer one may ask again.
 */
export function invitationNeedsAnswer(existing: Membership | undefined, invitation: Invitation): boolean {
  if (!existing) return true;
  if (existing.status === 'allowed' || existing.status === 'pending') return false;
  return (existing.decidedAt ?? 0) < invitation.createdAt;
}

export async function acceptInvitation(deps: CircleDeps, person: Identity, code: string): Promise<Membership> {
  const view = await describeInvitation(deps, code);
  if (!view) throw new CircleError('invitation_invalid');
  const { invitation, household } = view;

  const existing = await deps.store.getMembership(household.householdId, person.userId);
  // Allowed already, or the resident has answered this very invitation.
  if (existing && existing.status !== 'pending' && !invitationNeedsAnswer(existing, invitation)) return existing;

  const membership: Membership = {
    householdId: household.householdId,
    userId: person.userId,
    name: cleanName(person.name) || person.email,
    role: existing?.role ?? 'family',
    status: 'pending',
    requestedAt: deps.now(),
    invitedBy: invitation.invitedBy,
  };
  await askResident(deps, household, membership);
  return membership;
}

export async function removeMember(deps: CircleDeps, actor: { householdId: string; userId: string }, userId: string): Promise<void> {
  await requireOrganiser(deps, actor);
  if (userId === actor.userId) throw new CircleError('cannot_remove_self');
  const target = await deps.store.getMembership(actor.householdId, userId);
  if (!target) throw new CircleError('not_a_member');
  await deps.store.setMemberStatus(actor.householdId, userId, 'removed', deps.now());
  // After the status, so a failure here cannot leave them a member. A visit
  // they announced must not have the door go on saying a caller looks like
  // them (tools/expect_visit.ts).
  await deps.store.forgetAnnouncedVisits(actor.householdId, userId);
}

/**
 * Disconnects a television from the organiser's own home — one that was
 * replaced, given away, or only ever a test. The household is the actor's
 * (INV-8): a television of another home is simply not found. The resident
 * loses nothing by it: a television still in the house shows its pairing
 * code again, and connecting it asks nobody's leave twice.
 */
export async function removeTelevision(deps: CircleDeps, actor: { householdId: string; userId: string }, deviceId: string): Promise<void> {
  await requireOrganiser(deps, actor);
  if (!(await deps.store.removeTelevision(actor.householdId, deviceId))) throw new CircleError('not_a_television');
}

export interface CircleView {
  readonly household: Household;
  readonly members: readonly {
    readonly userId: string;
    readonly name: string;
    readonly role: Membership['role'];
    readonly status: MemberStatus;
    readonly you: boolean;
  }[];
  readonly televisions: readonly Television[];
}

export async function describeCircle(deps: Pick<CircleDeps, 'store'>, householdId: string, viewerId: string): Promise<CircleView> {
  const [household, members, televisions] = await Promise.all([
    deps.store.getHousehold(householdId),
    deps.store.listMembers(householdId),
    deps.store.listTelevisions(householdId),
  ]);
  if (!household) throw new CircleError('not_a_member');
  return {
    household,
    members: members
      .filter((m) => m.status !== 'removed')
      .sort((a, b) => a.requestedAt - b.requestedAt || a.userId.localeCompare(b.userId))
      .map((m) => ({ userId: m.userId, name: m.name, role: m.role, status: m.status, you: m.userId === viewerId })),
    televisions,
  };
}

export type Access =
  | { readonly ok: true; readonly membership: Membership; readonly household: Household }
  | { readonly ok: false; readonly reason: 'not_a_member' | 'waiting' | 'declined' | 'removed'; readonly say: string };

/**
 * INV-9's gate, asked on every read. A refusal is a sentence a person can
 * be told as it stands (§6.4: warm and specific, never a raw error).
 */
export async function checkAccess(store: AccountStore, householdId: string, userId: string): Promise<Access> {
  const [membership, household] = await Promise.all([store.getMembership(householdId, userId), store.getHousehold(householdId)]);
  if (!membership || !household) {
    return { ok: false, reason: 'not_a_member', say: 'You are not part of this family circle.' };
  }
  const resident = household.residentName;
  switch (membership.status) {
    case 'allowed':
      return { ok: true, membership, household };
    case 'pending':
      return {
        ok: false,
        reason: 'waiting',
        say: `${resident} hasn’t allowed this yet. A card is waiting on the television, and it only takes one press.`,
      };
    case 'declined':
      return { ok: false, reason: 'declined', say: `${resident} chose not to share this with you.` };
    case 'removed':
      return { ok: false, reason: 'removed', say: 'You are no longer part of this family circle.' };
  }
}
