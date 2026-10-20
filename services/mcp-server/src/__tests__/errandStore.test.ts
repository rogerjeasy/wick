/**
 * The ERRAND# rows and the roster entry each errand puts on the door
 * (services/agent store/errands.ts), against the table in memory — the
 * requests the Wick server's tools and the errand Lambdas really make.
 */
import { describe, expect, it } from 'vitest';
import { errandStore, type ErrandSend } from '@wick/agent';
import { errandPersonId, type Errand, type RosterEntry } from '@wick/contracts';
import { createMemoryTable } from './memoryTable.js';

const HH = 'hh-1';
const AT = Date.UTC(2026, 9, 15, 9); // Thursday 15 October 2026, 10:00 in London
const errand: Errand = {
  errandId: 'err_AAAAAAAAAAAAAAAAAAAA',
  householdId: HH,
  createdBy: 'u_sarah',
  createdByName: 'Sarah Hughes',
  who: 'the plumber',
  at: AT,
  windowMinutes: 60,
  remindAt: Date.UTC(2026, 9, 15, 7),
  tellMe: true,
  status: 'planned',
  createdAt: Date.UTC(2026, 9, 13, 12),
};

const setup = () => {
  const table = createMemoryTable();
  const store = errandStore((command) => table.ddb.send(command as never) as ReturnType<ErrandSend>, 'wick');
  return { table, store };
};

describe('errandStore.create — the errand and the door told, in one write', () => {
  it('files the errand and a roster entry the door matches by its time, under the member who arranged it', async () => {
    const { table, store } = setup();

    expect(await store.create(errand)).toBe(true);

    const rows = table.rows(`HH#${HH}`);
    expect(rows.map((r) => r.sk!.S)).toEqual([`ERRAND#${errand.errandId}`, `PER#errand:${errand.errandId}`]);
    const roster = JSON.parse(rows[1]!.data!.S!) as RosterEntry;
    expect(roster).toEqual({
      personId: errandPersonId(errand.errandId),
      name: 'the plumber',
      expectedOnce: { at: AT, windowMin: 60 },
      addedBy: 'u_sarah',
      arrangedByName: 'Sarah Hughes',
    });
    // The door forgets it two days after the window; the errand is kept a week past it, for "how did it go?".
    expect(rows[1]!.ttl!.N).toBe(String(Math.floor((AT + 60 * 60_000 + 2 * 86_400_000) / 1000)));
    expect(rows[0]!.ttl!.N).toBe(String(Math.floor((AT + 60 * 60_000 + 8 * 86_400_000) / 1000)));
    expect(await store.get(HH, errand.errandId)).toEqual(errand);
  });

  it('is false, and writes nothing more, for an id already taken', async () => {
    const { table, store } = setup();
    await store.create(errand);

    expect(await store.create({ ...errand, who: 'the electrician' })).toBe(false);
    expect((await store.get(HH, errand.errandId))?.who).toBe('the plumber');
    expect(table.rows(`HH#${HH}`)).toHaveLength(2);
  });
});

describe('errandStore.move — each step happens once, and only from where it may', () => {
  it('moves an errand on from a status it is in, with what the step learned', async () => {
    const { store } = setup();
    await store.create(errand);

    expect(await store.move(HH, errand.errandId, ['planned'], 'reminded', { remindedAt: 5 })).toBe(true);
    expect(await store.move(HH, errand.errandId, ['planned', 'reminded'], 'waiting', { taskToken: 'token-1' })).toBe(true);

    expect(await store.get(HH, errand.errandId)).toMatchObject({ status: 'waiting', remindedAt: 5, taskToken: 'token-1' });
  });

  it('refuses a step from a status it is not in: a cancelled errand is never reminded', async () => {
    const { store } = setup();
    await store.create(errand);
    await store.move(HH, errand.errandId, ['planned'], 'cancelled');

    expect(await store.move(HH, errand.errandId, ['planned'], 'reminded', { remindedAt: 5 })).toBe(false);
    expect((await store.get(HH, errand.errandId))?.status).toBe('cancelled');
  });

  it('is false for an errand that is not there', async () => {
    expect(await setup().store.move(HH, 'err_BBBBBBBBBBBBBBBBBBBB', ['planned'], 'cancelled')).toBe(false);
  });

  it('lets the door’s token go once the door has rung', async () => {
    const { store } = setup();
    await store.create(errand);
    await store.move(HH, errand.errandId, ['planned'], 'waiting', { taskToken: 'token-1' });

    expect(await store.move(HH, errand.errandId, ['waiting'], 'rang', { rangAt: AT + 4 * 60_000, cardId: 'door-abc' }, { forgetToken: true })).toBe(true);

    const held = await store.get(HH, errand.errandId);
    expect(held).toMatchObject({ status: 'rang', rangAt: AT + 4 * 60_000, cardId: 'door-abc' });
    expect(held?.taskToken).toBeUndefined();
  });
});

describe('errandStore.spendToken — a token is handed back once', () => {
  it('takes the token off only while it is still the one given', async () => {
    const { store } = setup();
    await store.create(errand);
    await store.move(HH, errand.errandId, ['planned'], 'waiting', { taskToken: 'token-1' });

    expect(await store.spendToken(HH, errand.errandId, 'token-2')).toBe(false);
    expect(await store.spendToken(HH, errand.errandId, 'token-1')).toBe(true);
    expect(await store.spendToken(HH, errand.errandId, 'token-1')).toBe(false);
    expect((await store.get(HH, errand.errandId))?.taskToken).toBeUndefined();
  });
});

describe('errandStore.list, setExecution, forgetRoster', () => {
  it('lists the household’s errands newest first, with no token in them', async () => {
    const { store } = setup();
    const later = { ...errand, errandId: 'err_CCCCCCCCCCCCCCCCCCCC', createdAt: errand.createdAt + 1000 };
    await store.create(errand);
    await store.create(later);
    await store.move(HH, errand.errandId, ['planned'], 'waiting', { taskToken: 'token-1' });
    await store.setExecution(HH, errand.errandId, 'arn:aws:states:eu-west-2:1:execution:wick-errand:err_AAAAAAAAAAAAAAAAAAAA');

    const listed = await store.list(HH);

    expect(listed.map((e) => e.errandId)).toEqual([later.errandId, errand.errandId]);
    expect(listed[1]).toMatchObject({ status: 'waiting', executionArn: expect.stringContaining('execution') });
    expect(JSON.stringify(listed)).not.toContain('token-1');
  });

  it('takes the visitor off the door, and leaves the errand', async () => {
    const { table, store } = setup();
    await store.create(errand);

    await store.forgetRoster(HH, errand.errandId);

    expect(table.rows(`HH#${HH}`).map((r) => r.sk!.S)).toEqual([`ERRAND#${errand.errandId}`]);
  });
});

describe('errandStore — the visit pass on an errand (packages/contracts visitPass.ts)', () => {
  const keep = async (table: ReturnType<typeof setup>['table'], attributes: Record<string, { S: string }>) => {
    const [row] = table.rows(`HH#${HH}`).filter((r) => r.sk!.S!.startsWith('ERRAND#'));
    table.put({ ...row!, ...attributes });
  };

  it('reads the pass’s hash and the visitor’s last word, from get and from list', async () => {
    const { table, store } = setup();
    await store.create(errand);
    await keep(table, { passHash: { S: 'a'.repeat(64) }, visitorWord: { S: JSON.stringify({ says: 'late', at: AT - 600_000, lateMinutes: 15 }) } });

    expect(await store.get(HH, errand.errandId)).toMatchObject({ passHash: 'a'.repeat(64), visitorWord: { says: 'late', at: AT - 600_000, lateMinutes: 15 } });
    expect((await store.list(HH))[0]).toMatchObject({ passHash: 'a'.repeat(64), visitorWord: { says: 'late', at: AT - 600_000, lateMinutes: 15 } });
  });

  it('reads no word from one it cannot read: the errand is still the errand', async () => {
    const { table, store } = setup();
    await store.create(errand);

    for (const raw of ['not json', JSON.stringify({ says: 'come_in', at: AT }), JSON.stringify({ says: 'late', at: AT })]) {
      await keep(table, { visitorWord: { S: raw } });
      const held = await store.get(HH, errand.errandId);
      expect(held, raw).toEqual(errand);
    }
  });
});
