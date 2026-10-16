/**
 * errand-door: a ring on the bus wakes the errands waiting at that door —
 * only that household's, only inside their window, and only once.
 */
import { describe, expect, it } from 'vitest';
import type { ErrandStatus } from '@wick/contracts';
import type { ErrandStore, HeldErrand } from '../../../store/errands.js';
import { handleDoorRang, type ErrandDoorDeps } from '../door.js';

const AT = Date.UTC(2026, 9, 15, 9); // Thursday 10:00 in London
const MIN = 60_000;

const errand = (householdId: string, errandId: string, more: Partial<HeldErrand> = {}): HeldErrand => ({
  errandId,
  householdId,
  createdBy: 'u_sarah',
  createdByName: 'Sarah',
  who: 'the plumber',
  at: AT,
  windowMinutes: 60,
  tellMe: true,
  status: 'waiting' as ErrandStatus,
  createdAt: AT - 86_400_000,
  taskToken: `token-${errandId}`,
  ...more,
});

function setup(rows: HeldErrand[], handBack: ErrandDoorDeps['handBack'] = async () => {}) {
  const held = new Map(rows.map((row) => [`${row.householdId}/${row.errandId}`, row]));
  const listed: string[] = [];
  const handed: { token: string; output: object }[] = [];
  const errands: ErrandStore = {
    create: async () => true,
    get: async (householdId, errandId) => held.get(`${householdId}/${errandId}`),
    async list(householdId) {
      listed.push(householdId);
      return [...held.values()].filter((row) => row.householdId === householdId).map(({ taskToken: _hidden, ...row }) => row);
    },
    setExecution: async () => {},
    move: async () => true,
    async spendToken(householdId, errandId, token) {
      const row = held.get(`${householdId}/${errandId}`);
      if (row?.taskToken !== token) return false;
      const { taskToken: _spent, ...rest } = row;
      held.set(`${householdId}/${errandId}`, rest);
      return true;
    },
    forgetRoster: async () => {},
  };
  const deps: ErrandDoorDeps = {
    errands,
    handBack: async (token, output) => {
      await handBack(token, output);
      handed.push({ token, output });
    },
  };
  return { deps, handed, listed };
}

const ring = (householdId: string, at: number) => ({ householdId, at, cardId: 'door-abc', matchPersonId: 'errand:err_AAAAAAAAAAAAAAAAAAAA' });

describe('errand-door — the door rang', () => {
  it('hands the ring to every errand of that home waiting with a window around it', async () => {
    const { deps, handed } = setup([
      errand('hh-1', 'err_AAAAAAAAAAAAAAAAAAAA'),
      errand('hh-1', 'err_BBBBBBBBBBBBBBBBBBBB', { at: AT + 50 * MIN }),
    ]);

    expect(await handleDoorRang(ring('hh-1', AT + 4 * MIN), deps)).toEqual({ told: 2, spent: 0 });
    expect(handed).toEqual([
      { token: 'token-err_AAAAAAAAAAAAAAAAAAAA', output: { rangAt: AT + 4 * MIN, cardId: 'door-abc' } },
      { token: 'token-err_BBBBBBBBBBBBBBBBBBBB', output: { rangAt: AT + 4 * MIN, cardId: 'door-abc' } },
    ]);
  });

  it('counts a ring an hour either side, and not a minute more', async () => {
    const fresh = () => setup([errand('hh-1', 'err_AAAAAAAAAAAAAAAAAAAA')]);
    for (const [when, told] of [[AT - 60 * MIN, 1], [AT + 60 * MIN, 1], [AT - 61 * MIN, 0], [AT + 61 * MIN, 0]] as const) {
      const { deps } = fresh();
      expect((await handleDoorRang(ring('hh-1', when), deps)) as { told: number }).toMatchObject({ told });
    }
  });

  it('leaves alone an errand that is not waiting — not yet armed, called off, or over', async () => {
    const { deps, handed } = setup([
      (({ taskToken: _none, ...notArmed }) => notArmed)(errand('hh-1', 'err_AAAAAAAAAAAAAAAAAAAA', { status: 'reminded' })),
      errand('hh-1', 'err_BBBBBBBBBBBBBBBBBBBB', { status: 'cancelled' }),
      errand('hh-1', 'err_CCCCCCCCCCCCCCCCCCCC', { status: 'rang' }),
    ]);

    expect(await handleDoorRang(ring('hh-1', AT), deps)).toEqual({ told: 0, spent: 0 });
    expect(handed).toHaveLength(0);
  });

  it('reads only the household the ring was at: another home’s errands are never touched', async () => {
    const { deps, handed, listed } = setup([errand('hh-2', 'err_AAAAAAAAAAAAAAAAAAAA')]);

    expect(await handleDoorRang(ring('hh-1', AT), deps)).toEqual({ told: 0, spent: 0 });
    expect(listed).toEqual(['hh-1']);
    expect(handed).toHaveLength(0);
  });

  it('is told once: a second ring finds the token spent and does nothing', async () => {
    const { deps, handed } = setup([errand('hh-1', 'err_AAAAAAAAAAAAAAAAAAAA')]);

    await handleDoorRang(ring('hh-1', AT), deps);
    expect(await handleDoorRang(ring('hh-1', AT + MIN), deps)).toEqual({ told: 0, spent: 0 });
    expect(handed).toHaveLength(1);
  });

  it('lets go of a token Step Functions says is over, without failing', async () => {
    const { deps } = setup([errand('hh-1', 'err_AAAAAAAAAAAAAAAAAAAA')], async () => {
      throw Object.assign(new Error('gone'), { name: 'TaskTimedOut' });
    });

    expect(await handleDoorRang(ring('hh-1', AT), deps)).toEqual({ told: 0, spent: 1 });
    expect(await handleDoorRang(ring('hh-1', AT), deps)).toEqual({ told: 0, spent: 0 });
  });

  it('fails, after telling the rest, when Step Functions could not be reached — so the ring is tried again', async () => {
    let calls = 0;
    const { deps, handed } = setup(
      [errand('hh-1', 'err_AAAAAAAAAAAAAAAAAAAA'), errand('hh-1', 'err_BBBBBBBBBBBBBBBBBBBB')],
      async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
      },
    );

    await expect(handleDoorRang(ring('hh-1', AT), deps)).rejects.toMatchObject({ name: 'ThrottlingException' });
    expect(handed).toHaveLength(1);
    // Tried again: the one already told is not told twice.
    expect(await handleDoorRang(ring('hh-1', AT), deps)).toEqual({ told: 1, spent: 0 });
  });

  it('ignores an event that is not a ring', async () => {
    const { deps, listed } = setup([]);
    expect(await handleDoorRang({ householdId: 'hh-1' }, deps)).toBe('ignored');
    expect(await handleDoorRang(null, deps)).toBe('ignored');
    expect(listed).toHaveLength(0);
  });
});
