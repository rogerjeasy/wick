import { describe, expect, it } from 'vitest';
import { MAX_CARD_ACTIONS, MAX_CARD_DETAIL_CHARS, type QueuedCard } from '@wick/contracts';
import {
  acceptInvitation,
  adoptHousehold,
  buildCircleCard,
  checkAccess,
  CircleError,
  cleanName,
  createHousehold,
  createInvitation,
  describeCircle,
  INVITATION_TTL_MS,
  removeMember,
  type CircleDeps,
} from '../circle.js';
import type { Identity } from '../identity.js';
import { createMemoryStore } from './memoryStore.js';

const SARAH: Identity = { userId: 'u_sarah', email: 'sarah@example.com', name: 'Sarah Bennett' };
const TOM: Identity = { userId: 'u_tom', email: 'tom@example.com', name: 'Tom' };

function setup() {
  let clock = 1_790_000_000_000;
  let ids = 0;
  const store = createMemoryStore(() => clock);
  const cards: QueuedCard[] = [];
  const deps: CircleDeps = {
    store,
    sendCard: async (card) => void cards.push(card),
    now: () => clock,
    newId: () => `id${++ids}`,
  };
  return { deps, store, cards, tick: (ms: number) => void (clock += ms), now: () => clock };
}

/** What the resident's press does (services/edge-device/lambda/circle.mjs). */
async function residentAnswers(deps: CircleDeps, householdId: string, userId: string, status: 'allowed' | 'declined') {
  await deps.store.setMemberStatus(householdId, userId, status, deps.now());
}

describe('createHousehold', () => {
  it('makes the person its organiser, waiting for the resident', async () => {
    const { deps, store } = setup();

    const household = await createHousehold(deps, SARAH, { residentName: 'Margaret' });

    expect(household).toMatchObject({ residentName: 'Margaret', name: 'Margaret’s home', createdBy: 'u_sarah' });
    expect(await store.getMembership(household.householdId, 'u_sarah')).toMatchObject({
      role: 'organiser',
      status: 'pending',
      name: 'Sarah Bennett',
    });
  });

  it('puts a card on the television asking the resident to allow them', async () => {
    const { deps, cards } = setup();

    const household = await createHousehold(deps, SARAH, { residentName: 'Margaret' });

    expect(cards).toHaveLength(1);
    expect(cards[0]!.id).toBe('circle-u_sarah');
    expect(cards[0]!.card.householdId).toBe(household.householdId);
  });

  it('refuses a household with no resident named', async () => {
    const { deps } = setup();

    await expect(createHousehold(deps, SARAH, { residentName: '   ' })).rejects.toMatchObject({ code: 'name_required' });
  });
});

describe('buildCircleCard — what the resident reads', () => {
  const household = { householdId: 'hh_1', name: 'x', residentName: 'Margaret', createdBy: 'u_sarah', createdAt: 0 };
  const member = { householdId: 'hh_1', userId: 'u_sarah', name: 'Sarah Bennett', role: 'organiser' as const, status: 'pending' as const, requestedAt: 0 };

  it('names the person, says plainly what allowing means, and offers exactly two answers', () => {
    const queued = buildCircleCard(household, member, 5);

    expect(queued.card).toMatchObject({
      type: 'CIRCLE',
      personName: 'Sarah Bennett',
      headline: 'Sarah Bennett would like to join your family circle.',
      actions: [
        { id: 'allow', label: 'Allow Sarah', kind: 'primary' },
        { id: 'decline', label: 'No, thank you', kind: 'secondary' },
      ],
    });
    if (queued.card.type !== 'CIRCLE') throw new Error('not a circle card');
    expect(queued.card.detail).toContain('what you choose to share');
  });

  it('waits for a natural break like every card but the door (INV-5)', () => {
    expect(buildCircleCard(household, member, 5).urgency).toBe('DEFERRED');
  });

  it('fits the television: a long name cannot push the buttons off the screen', () => {
    const long = { ...member, name: cleanName('A'.repeat(200)) };
    const queued = buildCircleCard(household, long, 5);
    if (queued.card.type !== 'CIRCLE') throw new Error('not a circle card');

    expect(queued.card.detail.length).toBeLessThanOrEqual(MAX_CARD_DETAIL_CHARS);
    expect(queued.card.actions.length).toBeLessThanOrEqual(MAX_CARD_ACTIONS);
    expect(queued.card.personName.length).toBeLessThanOrEqual(40);
  });
});

describe('cleanName', () => {
  it('keeps a name to one short line', () => {
    expect(cleanName('  Sarah \n Bennett\t ')).toBe('Sarah Bennett');
  });
});

describe('invitations', () => {
  it('lets the organiser invite, and the invited person waits for the resident too', async () => {
    const { deps, store, cards } = setup();
    const household = await createHousehold(deps, SARAH, { residentName: 'Margaret' });

    const invitation = await createInvitation(deps, { householdId: household.householdId, userId: 'u_sarah' });
    const membership = await acceptInvitation(deps, TOM, invitation.code);

    expect(invitation.expiresAt).toBe(deps.now() + INVITATION_TTL_MS);
    expect(membership).toMatchObject({ householdId: household.householdId, role: 'family', status: 'pending', invitedBy: 'u_sarah' });
    expect(await store.getMembership(household.householdId, 'u_tom')).toMatchObject({ status: 'pending' });
    expect(cards.map((c) => c.id)).toEqual(['circle-u_sarah', 'circle-u_tom']);
  });

  it('only the organiser can invite', async () => {
    const { deps } = setup();
    const household = await createHousehold(deps, SARAH, { residentName: 'Margaret' });
    const invitation = await createInvitation(deps, { householdId: household.householdId, userId: 'u_sarah' });
    await acceptInvitation(deps, TOM, invitation.code);

    await expect(createInvitation(deps, { householdId: household.householdId, userId: 'u_tom' })).rejects.toMatchObject({
      code: 'not_organiser',
    });
  });

  it('refuses an invitation that has expired or never existed', async () => {
    const { deps, tick } = setup();
    const household = await createHousehold(deps, SARAH, { residentName: 'Margaret' });
    const invitation = await createInvitation(deps, { householdId: household.householdId, userId: 'u_sarah' });
    tick(INVITATION_TTL_MS + 1);

    await expect(acceptInvitation(deps, TOM, invitation.code)).rejects.toMatchObject({ code: 'invitation_invalid' });
    await expect(acceptInvitation(deps, TOM, 'nope')).rejects.toBeInstanceOf(CircleError);
  });

  it('does not ask the resident twice: someone already allowed keeps their place and no new card is sent', async () => {
    const { deps, cards } = setup();
    const household = await createHousehold(deps, SARAH, { residentName: 'Margaret' });
    const invitation = await createInvitation(deps, { householdId: household.householdId, userId: 'u_sarah' });
    await acceptInvitation(deps, TOM, invitation.code);
    await residentAnswers(deps, household.householdId, 'u_tom', 'allowed');
    const before = cards.length;

    const again = await acceptInvitation(deps, TOM, invitation.code);

    expect(again.status).toBe('allowed');
    expect(cards).toHaveLength(before);
  });

  it('never nags: after the resident says no, the same invitation cannot ask again', async () => {
    const { deps, cards, tick } = setup();
    const household = await createHousehold(deps, SARAH, { residentName: 'Margaret' });
    const invitation = await createInvitation(deps, { householdId: household.householdId, userId: 'u_sarah' });
    await acceptInvitation(deps, TOM, invitation.code);
    tick(1000);
    await residentAnswers(deps, household.householdId, 'u_tom', 'declined');
    const before = cards.length;

    const again = await acceptInvitation(deps, TOM, invitation.code);

    expect(again.status).toBe('declined');
    expect(cards).toHaveLength(before);
  });

  it('lets the organiser ask again with a new invitation, made after the resident said no', async () => {
    const { deps, cards, tick } = setup();
    const household = await createHousehold(deps, SARAH, { residentName: 'Margaret' });
    const first = await createInvitation(deps, { householdId: household.householdId, userId: 'u_sarah' });
    await acceptInvitation(deps, TOM, first.code);
    tick(1000);
    await residentAnswers(deps, household.householdId, 'u_tom', 'declined');
    tick(1000);
    const second = await createInvitation(deps, { householdId: household.householdId, userId: 'u_sarah' });
    const before = cards.length;

    const again = await acceptInvitation(deps, TOM, second.code);

    expect(again.status).toBe('pending');
    expect(cards).toHaveLength(before + 1);
  });
});

describe('checkAccess — INV-9: nobody reads a household before the resident allows them', () => {
  it('refuses someone who is waiting, and says where the answer is waiting', async () => {
    const { deps, store } = setup();
    const household = await createHousehold(deps, SARAH, { residentName: 'Margaret' });

    const access = await checkAccess(store, household.householdId, 'u_sarah');

    expect(access).toEqual({
      ok: false,
      reason: 'waiting',
      say: 'Margaret hasn’t allowed this yet. A card is waiting on the television, and it only takes one press.',
    });
  });

  it('lets someone the resident has allowed through', async () => {
    const { deps, store } = setup();
    const household = await createHousehold(deps, SARAH, { residentName: 'Margaret' });
    await residentAnswers(deps, household.householdId, 'u_sarah', 'allowed');

    const access = await checkAccess(store, household.householdId, 'u_sarah');

    expect(access.ok).toBe(true);
    if (access.ok) expect(access.membership.name).toBe('Sarah Bennett');
  });

  it('refuses someone the resident declined, without making it sound like an error', async () => {
    const { deps, store } = setup();
    const household = await createHousehold(deps, SARAH, { residentName: 'Margaret' });
    await residentAnswers(deps, household.householdId, 'u_sarah', 'declined');

    expect(await checkAccess(store, household.householdId, 'u_sarah')).toMatchObject({
      ok: false,
      reason: 'declined',
      say: 'Margaret chose not to share this with you.',
    });
  });

  it('refuses a stranger and someone who was removed', async () => {
    const { deps, store } = setup();
    const household = await createHousehold(deps, SARAH, { residentName: 'Margaret' });
    await residentAnswers(deps, household.householdId, 'u_sarah', 'allowed');
    const invitation = await createInvitation(deps, { householdId: household.householdId, userId: 'u_sarah' });
    await acceptInvitation(deps, TOM, invitation.code);
    await residentAnswers(deps, household.householdId, 'u_tom', 'allowed');
    await removeMember(deps, { householdId: household.householdId, userId: 'u_sarah' }, 'u_tom');

    expect(await checkAccess(store, household.householdId, 'u_tom')).toMatchObject({ ok: false, reason: 'removed' });
    expect(await checkAccess(store, household.householdId, 'u_nobody')).toMatchObject({ ok: false, reason: 'not_a_member' });
  });
});

describe('removeMember — what they announced goes with them', () => {
  it('takes a removed person’s announced visits off the roster: the door must not go on expecting them', async () => {
    const { deps, store } = setup();
    const household = await createHousehold(deps, SARAH, { residentName: 'Margaret' });
    await acceptInvitation(deps, TOM, (await createInvitation(deps, { householdId: household.householdId, userId: 'u_sarah' })).code);

    await removeMember(deps, { householdId: household.householdId, userId: 'u_sarah' }, 'u_tom');

    expect(store.forgottenVisits).toEqual([{ householdId: household.householdId, userId: 'u_tom' }]);
  });
});

describe('removeMember', () => {
  it('is the organiser’s to do, and never to themselves', async () => {
    const { deps } = setup();
    const household = await createHousehold(deps, SARAH, { residentName: 'Margaret' });
    const invitation = await createInvitation(deps, { householdId: household.householdId, userId: 'u_sarah' });
    await acceptInvitation(deps, TOM, invitation.code);

    await expect(removeMember(deps, { householdId: household.householdId, userId: 'u_tom' }, 'u_sarah')).rejects.toMatchObject({ code: 'not_organiser' });
    await expect(removeMember(deps, { householdId: household.householdId, userId: 'u_sarah' }, 'u_sarah')).rejects.toMatchObject({ code: 'cannot_remove_self' });
  });
});

describe('describeCircle', () => {
  it('shows who is in the circle, what the resident has said about each, and the televisions', async () => {
    const { deps, store } = setup();
    const household = await createHousehold(deps, SARAH, { residentName: 'Margaret' });
    await residentAnswers(deps, household.householdId, 'u_sarah', 'allowed');
    const invitation = await createInvitation(deps, { householdId: household.householdId, userId: 'u_sarah' });
    await acceptInvitation(deps, TOM, invitation.code);
    store.addTelevision(household.householdId, { deviceId: 'tv-1', pairedAt: 5, connected: true });

    const circle = await describeCircle(deps, household.householdId, 'u_sarah');

    expect(circle.household.residentName).toBe('Margaret');
    expect(circle.members).toEqual([
      { userId: 'u_sarah', name: 'Sarah Bennett', role: 'organiser', status: 'allowed', you: true },
      { userId: 'u_tom', name: 'Tom', role: 'family', status: 'pending', you: false },
    ]);
    expect(circle.televisions).toEqual([{ deviceId: 'tv-1', pairedAt: 5, connected: true }]);
  });

  it('leaves out people who were removed', async () => {
    const { deps } = setup();
    const household = await createHousehold(deps, SARAH, { residentName: 'Margaret' });
    const invitation = await createInvitation(deps, { householdId: household.householdId, userId: 'u_sarah' });
    await acceptInvitation(deps, TOM, invitation.code);
    await removeMember(deps, { householdId: household.householdId, userId: 'u_sarah' }, 'u_tom');

    const circle = await describeCircle(deps, household.householdId, 'u_sarah');

    expect(circle.members.map((m) => m.userId)).toEqual(['u_sarah']);
  });
});

describe('adoptHousehold — a household that existed before accounts did', () => {
  it('keeps the household’s id, so its timeline, weeks and doorbell stay with it, and asks the resident like anyone else', async () => {
    const { deps, store, cards } = setup();

    const household = await adoptHousehold(deps, SARAH, { householdId: 'margaret', residentName: 'Margaret' });

    expect(household.householdId).toBe('margaret');
    expect(await store.getMembership('margaret', 'u_sarah')).toMatchObject({ role: 'organiser', status: 'pending' });
    expect(cards.map((c) => c.card.householdId)).toEqual(['margaret']);
  });

  it('cannot be used to take a household somebody already has', async () => {
    const { deps } = setup();
    await adoptHousehold(deps, SARAH, { householdId: 'margaret', residentName: 'Margaret' });

    await expect(adoptHousehold(deps, TOM, { householdId: 'margaret', residentName: 'Margaret' })).rejects.toThrow(/already exists/);
  });
});
