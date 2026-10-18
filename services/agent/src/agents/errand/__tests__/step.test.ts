/**
 * errand-step: each action of the state machine, in every state an errand
 * can be in — and an author the resident no longer allows.
 */
import { describe, expect, it } from 'vitest';
import { PUSH_KINDS, errandReminderCardId, isErrandOpen, type Errand, type ErrandStatus, type MessageCard, type PushKind, type QueuedCard } from '@wick/contracts';
import type { ErrandFacts, ErrandStore, HeldErrand } from '../../../store/errands.js';
import { ERRAND_STEP_ACTIONS, handleErrandStep, type ErrandStepDeps } from '../step.js';

const HH = 'hh-1';
const ID = 'err_AAAAAAAAAAAAAAAAAAAA';
const TZ = 'Europe/London';
// Thursday 15 October 2026: eight in the morning in London, the visit at ten.
const EIGHT = Date.UTC(2026, 9, 15, 7);
const AT = Date.UTC(2026, 9, 15, 9);

const base: Errand = {
  errandId: ID,
  householdId: HH,
  createdBy: 'u_sarah',
  createdByName: 'Sarah Hughes',
  who: 'the plumber',
  at: AT,
  windowMinutes: 60,
  remindAt: EIGHT,
  tellMe: true,
  status: 'planned',
  createdAt: Date.UTC(2026, 9, 13, 12),
};

/** The store's promises, kept in a map: a step moves only from the statuses it names. */
function memoryErrands(start: HeldErrand | undefined) {
  let held = start;
  const forgotten: string[] = [];
  const store: ErrandStore = {
    create: async () => true,
    get: async () => held,
    list: async () => (held ? [held] : []),
    setExecution: async () => {},
    async move(_hh, _id, from, to, facts: ErrandFacts = {}, options = {}) {
      if (!held || !from.includes(held.status)) return false;
      const { taskToken: _spent, ...rest } = held;
      held = { ...(options.forgetToken ? rest : held), ...facts, status: to };
      return true;
    },
    async spendToken(_hh, _id, token) {
      if (held?.taskToken !== token) return false;
      const { taskToken: _spent, ...rest } = held;
      held = rest;
      return true;
    },
    async forgetRoster(_hh, errandId) {
      forgotten.push(errandId);
    },
  };
  return { store, held: () => held, forgotten };
}

function setup(start: HeldErrand | 'none' = base, options: { allowed?: boolean; now?: number } = {}) {
  const errands = memoryErrands(start === 'none' ? undefined : start);
  const cards: QueuedCard[] = [];
  const nudges: { userIds: readonly string[]; kind: PushKind }[] = [];
  const handedBack: { token: string; output: object }[] = [];
  const deps: ErrandStepDeps = {
    errands: errands.store,
    isAllowed: async () => options.allowed ?? true,
    sendCard: async (card) => void cards.push(card),
    nudge: async (userIds, kind) => void nudges.push({ userIds, kind }),
    handBack: async (token, output) => void handedBack.push({ token, output }),
    timeZoneOf: async () => TZ,
    now: () => options.now ?? EIGHT,
  };
  return { deps, cards, nudges, handedBack, ...errands };
}

const step = (action: string, extra: Record<string, unknown> = {}) => ({ action, householdId: HH, errandId: ID, ...extra });
const as = (status: ErrandStatus, more: Partial<HeldErrand> = {}): HeldErrand => ({ ...base, status, ...more });

describe('errand-step — what it takes', () => {
  it('knows five actions, and refuses anything else before reading a row', async () => {
    expect(ERRAND_STEP_ACTIONS).toEqual(['remind', 'arm', 'rang', 'no_show', 'failed']);
    const { deps } = setup();
    await expect(handleErrandStep(step('ring_the_police'), deps)).rejects.toThrow(/not an errand step/);
    await expect(handleErrandStep({ action: 'remind', householdId: HH, errandId: 'nope' }, deps)).rejects.toThrow(/not an errand step/);
    await expect(handleErrandStep(step('arm'), deps)).rejects.toThrow(/not an errand step/);
  });
});

describe('remind — a note on her television from the member, at a natural break', () => {
  it('sends the member’s reminder in Wick’s own words, deferred, and says how long the door waits from now', async () => {
    const { deps, cards, held } = setup();

    const answer = await handleErrandStep(step('remind'), deps);

    expect(answer).toEqual({ ended: false, doorWaitSeconds: (AT + 3_600_000 - EIGHT) / 1000 });
    expect(cards).toHaveLength(1);
    const queued = cards[0]!;
    expect(queued).toMatchObject({ id: errandReminderCardId(ID), urgency: 'DEFERRED' });
    const card = queued.card as MessageCard;
    expect(card).toMatchObject({ type: 'MESSAGE', householdId: HH, fromName: 'Sarah Hughes' });
    expect(card.transcript).toBe('A reminder from Sarah: the plumber is coming this morning at 10:00 am.');
    expect(card.suggestedReplies).toEqual(['Thanks for letting me know!', 'OK']);
    expect(held()).toMatchObject({ status: 'reminded', remindedAt: EIGHT });
  });

  it('names the day when the reminder comes the day before', async () => {
    const lateVisit = { ...base, at: Date.UTC(2026, 9, 14, 23, 30) }; // Thursday 00:30 in London
    const { deps, cards } = setup(lateVisit, { now: Date.UTC(2026, 9, 14, 22, 30) }); // Wednesday 23:30

    await handleErrandStep(step('remind'), deps);

    expect((cards[0]!.card as MessageCard).transcript).toBe('A reminder from Sarah: the plumber is coming on Thursday at 12:30 am.');
  });

  it('does not send it twice: a retried step finds her already reminded', async () => {
    const { deps, cards } = setup(as('reminded', { remindedAt: EIGHT }));

    expect(await handleErrandStep(step('remind'), deps)).toMatchObject({ ended: false });
    expect(cards).toHaveLength(0);
  });

  it('ends the errand, saying nothing, when it was called off', async () => {
    for (const status of ['cancelled', 'failed', 'rang', 'no_show'] as const) {
      const { deps, cards } = setup(as(status));
      expect(await handleErrandStep(step('remind'), deps)).toEqual({ ended: true, doorWaitSeconds: 60 });
      expect(cards).toHaveLength(0);
    }
  });

  it('ends it when the errand is not there', async () => {
    const { deps } = setup('none');
    expect(await handleErrandStep(step('remind'), deps)).toMatchObject({ ended: true });
  });

  it('does nothing visible for an author the resident no longer allows: the door is no longer told, and it ends (INV-9)', async () => {
    const { deps, cards, nudges, held, forgotten } = setup(base, { allowed: false });

    expect(await handleErrandStep(step('remind'), deps)).toMatchObject({ ended: true });
    expect(cards).toHaveLength(0);
    expect(nudges).toHaveLength(0);
    expect(forgotten).toEqual([ID]);
    expect(isErrandOpen(held()!.status)).toBe(false);
  });
});

describe('arm — the door is told to wait', () => {
  it('keeps the task token on the errand, which now waits', async () => {
    const { deps, held, handedBack } = setup(as('reminded'));

    expect(await handleErrandStep(step('arm', { taskToken: 'token-1' }), deps)).toEqual({ armed: true });
    expect(held()).toMatchObject({ status: 'waiting', taskToken: 'token-1' });
    expect(handedBack).toHaveLength(0);
  });

  it('arms an errand with no reminder straight from planned, and takes a retry’s new token', async () => {
    const { deps, held } = setup();
    await handleErrandStep(step('arm', { taskToken: 'token-1' }), deps);
    await handleErrandStep(step('arm', { taskToken: 'token-2' }), deps);
    expect(held()?.taskToken).toBe('token-2');
  });

  it('hands its own token back at once when the errand was called off, so the execution ends', async () => {
    const { deps, held, handedBack } = setup(as('cancelled'));

    expect(await handleErrandStep(step('arm', { taskToken: 'token-1' }), deps)).toEqual({ armed: false });
    expect(handedBack).toEqual([{ token: 'token-1', output: { ended: true } }]);
    expect(held()?.taskToken).toBeUndefined();
  });

  it('hands it back, and takes the visitor off the door, for an author no longer allowed', async () => {
    const { deps, handedBack, forgotten, held } = setup(base, { allowed: false });

    expect(await handleErrandStep(step('arm', { taskToken: 'token-1' }), deps)).toEqual({ armed: false });
    expect(handedBack).toEqual([{ token: 'token-1', output: { ended: true } }]);
    expect(forgotten).toEqual([ID]);
    expect(held()?.status).toBe('cancelled');
  });
});

describe('rang and no_show — the member is told how it went', () => {
  const RANG = AT + 4 * 60_000;

  it('records the ring and notifies the author’s browsers, with a kind and nothing else', async () => {
    const { deps, held, nudges } = setup(as('waiting', { taskToken: 'token-1' }));

    expect(await handleErrandStep(step('rang', { rangAt: RANG, cardId: 'door-abc' }), deps)).toEqual({ status: 'rang' });
    expect(held()).toMatchObject({ status: 'rang', rangAt: RANG, cardId: 'door-abc' });
    expect(held()?.taskToken).toBeUndefined();
    expect(nudges).toEqual([{ userIds: ['u_sarah'], kind: PUSH_KINDS.errandRang }]);
    expect(JSON.stringify(nudges)).not.toMatch(/plumber|Sarah|10:0|hh-1/);
  });

  it('records that nobody came, and says so to the author', async () => {
    const { deps, held, nudges } = setup(as('waiting', { taskToken: 'token-1' }));

    expect(await handleErrandStep(step('no_show'), deps)).toEqual({ status: 'no_show' });
    expect(held()?.status).toBe('no_show');
    expect(nudges).toEqual([{ userIds: ['u_sarah'], kind: PUSH_KINDS.errandNoShow }]);
  });

  it('notifies nobody when the member did not ask to be told', async () => {
    const { deps, nudges, held } = setup(as('waiting', { tellMe: false }));
    await handleErrandStep(step('rang', { rangAt: RANG, cardId: 'door-abc' }), deps);
    expect(held()?.status).toBe('rang');
    expect(nudges).toHaveLength(0);
  });

  it('does nothing to an errand that is not waiting: called off, or already told', async () => {
    for (const status of ['cancelled', 'rang', 'no_show', 'failed'] as const) {
      const { deps, held, nudges } = setup(as(status));
      expect(await handleErrandStep(step('no_show'), deps)).toEqual({ status });
      expect(held()?.status).toBe(status);
      expect(nudges).toHaveLength(0);
    }
  });

  it('tells nobody, and takes the visitor off the door, when the author is no longer allowed', async () => {
    const { deps, nudges, forgotten, held } = setup(as('waiting', { taskToken: 'token-1' }), { allowed: false });

    expect(await handleErrandStep(step('rang', { rangAt: RANG, cardId: 'door-abc' }), deps)).toEqual({ status: 'cancelled' });
    expect(nudges).toHaveLength(0);
    expect(forgotten).toEqual([ID]);
    expect(held()?.rangAt).toBeUndefined();
  });

  it('records the ring even when the notification cannot be sent: it is a courtesy on top', async () => {
    const { deps, held } = setup(as('waiting'));
    const failing = { ...deps, nudge: async () => { throw new Error('push keys are not set'); } };

    expect(await handleErrandStep(step('rang', { rangAt: RANG, cardId: 'door-abc' }), failing)).toEqual({ status: 'rang' });
    expect(held()?.status).toBe('rang');
  });
});

describe('failed — a step failed every try', () => {
  it('marks an open errand failed and takes the visitor off the door', async () => {
    const { deps, held, forgotten } = setup(as('waiting', { taskToken: 'token-1' }));

    expect(await handleErrandStep(step('failed'), deps)).toEqual({ status: 'failed' });
    expect(held()?.status).toBe('failed');
    expect(held()?.taskToken).toBeUndefined();
    expect(forgotten).toEqual([ID]);
  });

  it('leaves an errand that is already over as it ended', async () => {
    const { deps, held } = setup(as('rang', { rangAt: AT }));
    expect(await handleErrandStep(step('failed'), deps)).toEqual({ status: 'rang' });
    expect(held()?.status).toBe('rang');
  });
});
