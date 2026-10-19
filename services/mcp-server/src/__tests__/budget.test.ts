/**
 * Allowances counted in the table (budget.ts): what a visitor with a
 * one-click account may spend holds for the whole deployment — across
 * instances, across restarts, and when many ask at once.
 */
import { describe, expect, it, vi } from 'vitest';
import { dynamoBudget, memoryBudget, type Allowance, type Budget } from '../budget.js';
import { createMemoryTable } from './memoryTable.js';
import { STEPS_PER_DAY, STEPS_PER_PERSON, STEPS_PER_WINDOW, createStepLimiter } from '../assistant/router.js';
import { createHearingLimiter, HEARINGS_PER_DAY, HEARINGS_PER_PERSON_PER_MINUTE, HEARINGS_PER_WINDOW } from '../hear/routes.js';
import { createDemoLimiter } from '../accounts/demo.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ONE = (limit: number, windowMs = HOUR, counter = 'thing'): readonly Allowance[] => [{ counter, limit, windowMs }];

/** Each implementation must keep the same promises. */
const implementations: readonly [string, (now: () => number) => Budget][] = [
  ['memoryBudget', (now) => memoryBudget(now)],
  ['dynamoBudget over a table', (now) => dynamoBudget(createMemoryTable().ddb, 'wick', now)],
];

describe.each(implementations)('%s', (_name, make) => {
  it('allows exactly the limit in a window, and no more', async () => {
    const budget = make(() => 5 * HOUR);
    const results: boolean[] = [];
    for (let i = 0; i < 5; i += 1) results.push(await budget.take(ONE(3)));
    expect(results).toEqual([true, true, true, false, false]);
  });

  it('starts a fresh allowance in the next window', async () => {
    let now = 5 * HOUR;
    const budget = make(() => now);
    for (let i = 0; i < 3; i += 1) await budget.take(ONE(3));
    expect(await budget.take(ONE(3))).toBe(false);
    now += HOUR;
    expect(await budget.take(ONE(3))).toBe(true);
  });

  it('counts a cost whole, or not at all', async () => {
    const budget = make(() => 0);
    expect(await budget.take(ONE(10), 4)).toBe(true);
    expect(await budget.take(ONE(10), 4)).toBe(true);
    expect(await budget.take(ONE(10), 4)).toBe(false); // 12 > 10: nothing taken
    expect(await budget.take(ONE(10), 2)).toBe(true); // exactly the 2 that were left
    expect(await budget.take(ONE(10), 1)).toBe(false);
  });

  it('never allows a cost bigger than the whole allowance', async () => {
    const budget = make(() => 0);
    expect(await budget.take(ONE(3), 4)).toBe(false);
    expect(await budget.take(ONE(3), 3)).toBe(true);
  });

  it('keeps one counter apart from another', async () => {
    const budget = make(() => 0);
    expect(await budget.take(ONE(1, HOUR, 'a'))).toBe(true);
    expect(await budget.take(ONE(1, HOUR, 'b'))).toBe(true);
    expect(await budget.take(ONE(1, HOUR, 'a'))).toBe(false);
  });

  it('takes several allowances together, and none when any is spent: the others are not charged', async () => {
    const budget = make(() => 0);
    const both: readonly Allowance[] = [
      { counter: 'person', limit: 100, windowMs: HOUR },
      { counter: 'everyone', limit: 2, windowMs: HOUR },
    ];
    expect(await budget.take(both)).toBe(true);
    expect(await budget.take(both)).toBe(true);
    // Everyone's is spent. The person's must not have been charged for the refusals.
    for (let i = 0; i < 20; i += 1) expect(await budget.take(both)).toBe(false);
    expect(await budget.take([{ counter: 'person', limit: 100, windowMs: HOUR }], 98)).toBe(true);
    expect(await budget.take([{ counter: 'person', limit: 100, windowMs: HOUR }], 1)).toBe(false);
  });

  it('gives a window of one length its own count: a day and an hour of the same counter do not meet', async () => {
    const budget = make(() => 0);
    expect(await budget.take([{ counter: 'x', limit: 1, windowMs: HOUR }])).toBe(true);
    expect(await budget.take([{ counter: 'x', limit: 1, windowMs: DAY }])).toBe(true);
  });

  it('is exact when many ask at the same moment', async () => {
    const budget = make(() => 0);
    const asked = await Promise.all(Array.from({ length: 200 }, () => budget.take(ONE(50))));
    expect(asked.filter(Boolean)).toHaveLength(50);
  });

  it('is exact for several allowances at once under a crowd', async () => {
    const budget = make(() => 0);
    const people = Array.from({ length: 10 }, (_, i) => `p${i}`);
    const asked = await Promise.all(
      Array.from({ length: 300 }, (_, i) => budget.take([
        { counter: `person#${people[i % 10]}`, limit: 8, windowMs: HOUR },
        { counter: 'everyone', limit: 60, windowMs: HOUR },
      ])),
    );
    expect(asked.filter(Boolean)).toHaveLength(60); // everyone's 60; no one over their 8
  });
});

describe('dynamoBudget — the deployment’s count, not one process’s', () => {
  it('is one allowance for two instances of the server over the same table', async () => {
    const table = createMemoryTable();
    const first = dynamoBudget(table.ddb, 'wick', () => 0);
    const second = dynamoBudget(table.ddb, 'wick', () => 0);

    const asked = await Promise.all(Array.from({ length: 100 }, (_, i) => (i % 2 ? first : second).take(ONE(30))));

    expect(asked.filter(Boolean)).toHaveLength(30);
  });

  it('is not given back by a restart: a new process over the same table finds it spent', async () => {
    const table = createMemoryTable();
    const before = dynamoBudget(table.ddb, 'wick', () => 0);
    for (let i = 0; i < 5; i += 1) await before.take(ONE(5));

    const after = dynamoBudget(table.ddb, 'wick', () => 0);
    expect(await after.take(ONE(5))).toBe(false);
  });

  it('writes one row a window, that ends with the window', async () => {
    const table = createMemoryTable();
    const budget = dynamoBudget(table.ddb, 'wick', () => 7 * HOUR + 123);
    await budget.take([{ counter: 'demo#accounts', limit: 60, windowMs: HOUR }], 3);

    const [row] = table.rows('LIMIT#demo#accounts');
    expect(row).toMatchObject({ pk: { S: 'LIMIT#demo#accounts' }, sk: { S: `W${HOUR}#7` }, n: { N: '3' } });
    // Gone after the window it counted, with a window to spare.
    expect(Number(row!.ttl!.N)).toBe(((7 + 2) * HOUR) / 1000);
  });

  it('allows nothing when the table cannot be asked, and says so to its caller', async () => {
    const down = { send: vi.fn(async () => { throw Object.assign(new Error('boom'), { name: 'ProvisionedThroughputExceededException' }); }) };
    const budget = dynamoBudget(down as never, 'wick', () => 0);
    await expect(budget.take(ONE(5))).rejects.toThrow('boom');
  });

  it('gives back what an earlier allowance took when a later one is refused, even if a give-back fails, and never lets more through', async () => {
    const table = createMemoryTable();
    let failGiveBacks = false;
    const flaky = {
      send: async (command: { input: { ExpressionAttributeValues?: Record<string, { N?: string }> } }) => {
        const by = command.input.ExpressionAttributeValues?.[':by']?.N;
        if (failGiveBacks && by !== undefined && Number(by) < 0) throw new Error('cannot give back');
        return (table.ddb as unknown as { send: (c: unknown) => Promise<unknown> }).send(command);
      },
    };
    const budget = dynamoBudget(flaky as never, 'wick', () => 0);
    const both: readonly Allowance[] = [
      { counter: 'person', limit: 4, windowMs: HOUR },
      { counter: 'everyone', limit: 1, windowMs: HOUR },
    ];
    expect(await budget.take(both)).toBe(true);
    failGiveBacks = true;
    // Refused by 'everyone'; the give-back to 'person' then fails: person stays over by one.
    expect(await budget.take(both)).toBe(false);
    failGiveBacks = false;
    // A tighter limit than the true count, never a looser one: person has 2 of 4 counted, so 2 more fit, not 3.
    expect(await budget.take([{ counter: 'person', limit: 4, windowMs: HOUR }], 2)).toBe(true);
    expect(await budget.take([{ counter: 'person', limit: 4, windowMs: HOUR }], 1)).toBe(false);
  });
});

describe('what an anonymous visitor may spend, counted in the table', () => {
  const table = () => createMemoryTable().ddb;

  it('the assistant: one person’s steps, the guests’ together and the day’s hold across instances', async () => {
    const ddb = table();
    const a = createStepLimiter(dynamoBudget(ddb, 'wick', () => 0));
    const b = createStepLimiter(dynamoBudget(ddb, 'wick', () => 0)); // another instance

    let allowed = 0;
    for (let i = 0; i < STEPS_PER_PERSON * 2; i += 1) if (await (i % 2 ? a : b)('guest_one')) allowed += 1;
    expect(allowed).toBe(STEPS_PER_PERSON);
  });

  it('the assistant: a flood of guests on many instances cannot pass the guests’ total, or the account holders’ own', async () => {
    const ddb = table();
    const instances = [0, 1, 2, 3].map(() => createStepLimiter(dynamoBudget(ddb, 'wick', () => 0)));
    let allowed = 0;
    for (let guest = 0; guest < 30; guest += 1) {
      for (let i = 0; i < STEPS_PER_PERSON; i += 1) if (await instances[(guest + i) % 4]!(`guest_${guest}`)) allowed += 1;
    }
    expect(allowed).toBe(STEPS_PER_WINDOW);
    // Someone who signed up is still answered.
    expect(await instances[2]!('u_sarah')).toBe(true);
  });

  it('the assistant: the day, across windows, is a known number', async () => {
    let at = 0;
    const take = createStepLimiter(dynamoBudget(table(), 'wick', () => at));
    let taken = 0;
    for (let person = 0; taken < STEPS_PER_DAY; person += 1) {
      if (await take(`p${person}`)) taken += 1;
      else at += 10 * MIN;
    }
    at += 10 * MIN;
    expect(await take('one-more')).toBe(false);
    at += DAY;
    expect(await take('one-more')).toBe(true);
  });

  it('the assistant: a table that is down allows no step, and costs no model', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const down = { send: async () => { throw new Error('down'); } };
    expect(await createStepLimiter(dynamoBudget(down as never, 'wick', () => 0))('u_sarah')).toBe(false);
    vi.restoreAllMocks();
  });

  it('a spoken question: a person’s minute, everyone’s ten, and the day, across instances', async () => {
    const ddb = table();
    let at = 0;
    const a = createHearingLimiter(dynamoBudget(ddb, 'wick', () => at));
    const b = createHearingLimiter(dynamoBudget(ddb, 'wick', () => at));

    let one = 0;
    for (let i = 0; i < HEARINGS_PER_PERSON_PER_MINUTE * 3; i += 1) if (await (i % 2 ? a : b)('u_sarah')) one += 1;
    expect(one).toBe(HEARINGS_PER_PERSON_PER_MINUTE);
    at += MIN;
    expect(await a('u_sarah')).toBe(true);

    let accounts = 0;
    for (let person = 0; person < 100; person += 1) for (let i = 0; i < HEARINGS_PER_PERSON_PER_MINUTE; i += 1) if (await a(`u_${person}`)) accounts += 1;
    // The ten minutes' total (HEARINGS_PER_WINDOW) was already part spent by u_sarah's.
    expect(accounts + 1 + one).toBeLessThanOrEqual(HEARINGS_PER_WINDOW);
    expect(HEARINGS_PER_DAY).toBeGreaterThan(HEARINGS_PER_WINDOW);
  });

  it('demo guests: sixty an hour for the deployment, however many instances make them', async () => {
    const ddb = table();
    const start = Math.floor(1_790_000_000_000 / HOUR) * HOUR;
    const limiters = [0, 1, 2].map(() => createDemoLimiter(dynamoBudget(ddb, 'wick', () => start)));
    let made = 0;
    for (let i = 0; i < 100; i += 1) if (await limiters[i % 3]!.take()) made += 1;
    expect(made).toBe(60);
  });
});
