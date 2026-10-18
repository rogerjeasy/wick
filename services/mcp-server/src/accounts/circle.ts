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
  isTimeZone,
  type CircleRole,
  type MemberStatus,
  type QueuedCard,
} from '@wick/contracts';
import type { Identity } from './identity.js';
import type { AccountStore } from './store.js';
import type { Household, Membership } from './types.js';

export interface CircleDeps {
  readonly store: AccountStore;
  /** services/agent/src/egress.ts's sendToDevice — the only path to the television (INV-2). */
  readonly sendCard: (card: QueuedCard) => Promise<void>;
  readonly now: () => number;
  /** A fresh, unguessable, URL-safe id. */
  readonly newId: () => string;
}

export type CircleErrorCode =
  | 'name_required'
  | 'not_organiser'
  | 'not_a_member'
  | 'invitation_invalid'
  | 'cannot_remove_self'
  | 'not_a_television'
  | 'not_your_television';

export class CircleError extends Error {
  readonly code: CircleErrorCode;
  constructor(code: CircleErrorCode) {
    super(code);
    this.name = 'CircleError';
    this.code = code;
  }
}

/** What an invitation can make of the person who accepts it. Never an organiser: that is whoever set the household up. */
export type InvitedRole = Exclude<CircleRole, 'organiser'>;

export const isInvitedRole = (role: unknown): role is InvitedRole => role === 'family' || role === 'neighbour';

export interface Invitation {
  readonly code: string;
  readonly householdId: string;
  readonly invitedBy: string;
  /** Absent on an invitation made before there were neighbours: family. */
  readonly role?: InvitedRole;
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
  // A neighbour is asked for two things and shown nothing (packages/contracts circle.ts): the card says exactly that.
  const neighbour = member.role === 'neighbour';
  const detail = neighbour
    ? `If you allow it, you can ask ${first} to look at who is at your door, or to ring you. ${first} will not see your week, your day or your notes.`
    : `If you allow it, ${first} can send you notes here and see what you choose to share. ` +
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
      headline: neighbour ? `${name} would like to be a neighbour you can ask.` : `${name} would like to join your family circle.`,
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
  input: { readonly residentName: string; readonly name?: string | undefined; readonly simulated?: boolean; readonly timeZone?: string | undefined },
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
  input: {
    readonly householdId: string;
    readonly residentName: string;
    readonly name?: string | undefined;
    readonly simulated?: boolean;
    readonly timeZone?: string | undefined;
  },
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
    // A zone nobody can read is not kept: the home is read in the default, as one set up before homes had a zone.
    ...(isTimeZone(input.timeZone) ? { timeZone: input.timeZone } : {}),
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

export async function requireOrganiser(deps: Pick<CircleDeps, 'store'>, actor: { householdId: string; userId: string }): Promise<Membership> {
  const membership = await deps.store.getMembership(actor.householdId, actor.userId);
  // An organiser still waiting for the resident may invite and connect the
  // television: nobody they invite can read anything until the resident
  // allows that person too.
  if (membership?.role !== 'organiser' || (membership.status !== 'allowed' && membership.status !== 'pending')) {
    throw new CircleError('not_organiser');
  }
  return membership;
}

export async function createInvitation(deps: CircleDeps, actor: { householdId: string; userId: string }, role?: InvitedRole): Promise<Invitation> {
  await requireOrganiser(deps, actor);
  const now = deps.now();
  const invitation: Invitation = {
    code: deps.newId(),
    householdId: actor.householdId,
    invitedBy: actor.userId,
    ...(role ? { role } : {}),
    createdAt: now,
    expiresAt: now + INVITATION_TTL_MS,
  };
  // Filed under the organiser who made it: it is in their export, and goes with their account.
  await deps.store.putRecord('INV', invitation.code, invitation, invitation.expiresAt, actor.userId);
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
    // The part this invitation names — the resident is asked about exactly
    // that, on the card. Whoever set the household up stays its organiser.
    role: existing?.role === 'organiser' ? 'organiser' : invitation.role ?? 'family',
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
  // And a television of their own stops being one of this home's. It was
  // already shown nothing — every call checks the circle (INV-9) — but it
  // should not go on being listed, nor keep the device from being connected
  // anywhere else.
  for (const tv of await deps.store.listFamilyTelevisions(actor.householdId)) {
    if (tv.userId === userId) await deps.store.removeFamilyTelevision(actor.householdId, tv.deviceId);
  }
}

/**
 * Disconnects a television from the organiser's own home — one that was
 * replaced, given away, or only ever a test. The household is the actor's
 * (INV-8): a television of another home is simply not found. The resident
 * loses nothing by it: a television still in the house shows its pairing
 * code again, and connecting it asks nobody's leave twice.
 */
export async function removeTelevision(deps: CircleDeps, actor: { householdId: string; userId: string }, ref: string): Promise<void> {
  await requireOrganiser(deps, actor);
  // Named by its `ref`, never its id (describeCircle): found among this home's own.
  const tv = (await deps.store.listTelevisions(actor.householdId)).find((held) => held.ref === ref);
  if (!tv || !(await deps.store.removeTelevision(actor.householdId, tv.deviceId))) throw new CircleError('not_a_television');
}

/**
 * Disconnects a television a member connected as their own (packages/contracts
 * familyTelevision.ts). It is the member's whose television it is, and the
 * organiser's for anyone's — one somebody left connected, or the television
 * of someone since removed. The household is the actor's (INV-8). Nothing
 * here can touch the resident's own television: that is a row of another
 * kind, and `removeTelevision`'s to remove.
 */
export async function removeFamilyTelevision(deps: CircleDeps, actor: { householdId: string; userId: string }, ref: string): Promise<void> {
  const membership = await deps.store.getMembership(actor.householdId, actor.userId);
  // The organiser as everywhere else here: allowed, or still waiting for the resident.
  const organiser = membership?.role === 'organiser' && (membership.status === 'allowed' || membership.status === 'pending');
  if (!organiser && membership?.status !== 'allowed') throw new CircleError('not_your_television');

  // Named by its `ref`, never its id (describeCircle): found among this home's own.
  const tv = (await deps.store.listFamilyTelevisions(actor.householdId)).find((held) => held.ref === ref);
  if (!tv) throw new CircleError('not_a_television');
  // For a member, removed only if it is theirs: the condition is the store's, so there is no moment between looking and removing.
  if (await deps.store.removeFamilyTelevision(actor.householdId, tv.deviceId, organiser ? undefined : actor.userId)) return;
  throw new CircleError(organiser || tv.userId === actor.userId ? 'not_a_television' : 'not_your_television');
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
  /**
   * The resident's televisions, and only those: they are what "two
   * televisions connected" counts. Each is named by its `ref`, never by its
   * device id: an id is what a refresh is asked for by, and whoever learns
   * it learns how to ask (AGENTS.md INV-1).
   */
  readonly televisions: readonly TelevisionView[];
  /**
   * The televisions members connected as their own, oldest first — a list
   * of its own, never among the resident's. Empty for a viewer the resident
   * has not allowed yet (INV-9). Named by `ref` as well.
   */
  readonly familyTelevisions: readonly {
    readonly ref: string;
    readonly userId: string;
    /** The member's name as the circle shows it. */
    readonly memberName: string;
    readonly pairedAt?: number;
    /** Whether it is the viewer's own. */
    readonly yours: boolean;
  }[];
}

/** A television as the family is shown it: when it was connected, whether it is on, and the name to disconnect it by. */
export interface TelevisionView {
  readonly ref: string;
  readonly pairedAt?: number;
  readonly connected: boolean;
}

export async function describeCircle(deps: Pick<CircleDeps, 'store'>, householdId: string, viewerId: string): Promise<CircleView> {
  const [household, members, televisions, familyTelevisions] = await Promise.all([
    deps.store.getHousehold(householdId),
    deps.store.listMembers(householdId),
    deps.store.listTelevisions(householdId),
    deps.store.listFamilyTelevisions(householdId),
  ]);
  if (!household) throw new CircleError('not_a_member');
  // Shown to somebody the resident allows — and not to a neighbour, who is asked things and shown nothing.
  const allowed = members.some((m) => m.userId === viewerId && m.status === 'allowed' && m.role !== 'neighbour');
  return {
    household,
    members: members
      .filter((m) => m.status !== 'removed')
      .sort((a, b) => a.requestedAt - b.requestedAt || a.userId.localeCompare(b.userId))
      .map((m) => ({ userId: m.userId, name: m.name, role: m.role, status: m.status, you: m.userId === viewerId })),
    // Built field by field, so nothing the store reads — the device id above all — rides along.
    televisions: televisions.map((tv) => ({ ref: tv.ref, ...(tv.pairedAt === undefined ? {} : { pairedAt: tv.pairedAt }), connected: tv.connected })),
    familyTelevisions: !allowed
      ? []
      : [...familyTelevisions]
          .sort((a, b) => (a.pairedAt ?? 0) - (b.pairedAt ?? 0) || a.ref.localeCompare(b.ref))
          .map((tv) => ({
            ref: tv.ref,
            userId: tv.userId,
            // Someone since removed is still named: the organiser has to know whose television they are disconnecting.
            memberName: members.find((m) => m.userId === tv.userId)?.name ?? 'Someone',
            ...(tv.pairedAt === undefined ? {} : { pairedAt: tv.pairedAt }),
            yours: tv.userId === viewerId,
          })),
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
  return accessOf(membership, household);
}

/** The same gate, for a caller that has already read the membership and the household. */
export function accessOf(membership: Membership | undefined, household: Household | undefined): Access {
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
