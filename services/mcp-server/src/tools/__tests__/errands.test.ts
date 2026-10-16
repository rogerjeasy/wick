/**
 * Visit errands from the family's side: arrange_visit, get_errands and
 * cancel_errand, against the table in memory and a stand-in for the state
 * machine that records what it was asked.
 */
import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { errandStore, type ErrandExecutionInput, type ErrandSend } from '@wick/agent';
import { ERRAND_LIMITS, type Errand, type RosterEntry } from '@wick/contracts';
import { createMemoryTable, type MemoryTable } from '../../__tests__/memoryTable.js';
import { guardTools } from '../../guardian.js';
import type { ToolContext } from '../context.js';
import {
  ARRANGE_TOO_SOON_TEXT,
  ARRANGE_TOO_MANY_TEXT,
  ARRANGE_WHO_NOT_SHARED_TEXT,
  ARRANGE_BAD_WHO_TEXT,
  ERRANDS_UNAVAILABLE_TEXT,
  type ErrandMachine,
} from '../errands.js';
import { registerArrangeVisit } from '../arrange_visit.js';
import { NO_ERRANDS_TEXT, registerGetErrands } from '../get_errands.js';
import { ERRAND_ALREADY_OVER_TEXT, ERRAND_NOT_FOUND_TEXT, registerCancelErrand } from '../cancel_errand.js';
import { EXPECT_VISIT_BAD_TIME_TEXT, EXPECT_VISIT_PAST_TEXT, EXPECT_VISIT_TOO_FAR_TEXT } from '../expect_visit.js';
import { allowedContext } from './toolContext.js';

const HH = 'hh-1';
// Tuesday 13 October 2026, 13:00 in London (12:00 UTC).
const NOW = Date.UTC(2026, 9, 13, 12);
// Thursday 15 October 2026, 10:00 in London.
const THURSDAY_TEN = Date.UTC(2026, 9, 15, 9);
const sarah = allowedContext(HH, { userId: 'u_sarah', name: 'Sarah Hughes' });
const david = allowedContext(HH, { userId: 'u_david', name: 'David' });

function fakeMachine() {
  const started: { name: string; input: ErrandExecutionInput }[] = [];
  const stopped: string[] = [];
  let failNext = false;
  const machine: ErrandMachine = {
    async start(name, input) {
      if (failNext) {
        failNext = false;
        throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
      }
      started.push({ name, input });
      return `arn:aws:states:eu-west-2:111122223333:execution:wick-errand:${name}`;
    },
    async stop(executionArn) {
      stopped.push(executionArn);
    },
  };
  return { machine, started, stopped, failOnce: () => void (failNext = true) };
}

async function connect(table: MemoryTable, ctx: ToolContext, machine: ErrandMachine | undefined, now = NOW) {
  // Behind the Guardian, as every tool is (server.ts createMcpServer).
  const server = guardTools(new McpServer({ name: 'test', version: '0.1.0' }));
  registerArrangeVisit(server, table.ddb, ctx, machine, () => now);
  registerGetErrands(server, table.ddb, ctx, () => now);
  registerCancelErrand(server, table.ddb, ctx, machine);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.1.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

const said = (result: unknown) => (result as { structuredContent: { say?: string } }).structuredContent.say;
const content = <T>(result: unknown) => (result as { structuredContent: T }).structuredContent;
const errandRows = (table: MemoryTable) => table.rows(`HH#${HH}`).filter((r) => r.sk!.S!.startsWith('ERRAND#'));
const rosterRows = (table: MemoryTable) => table.rows(`HH#${HH}`).filter((r) => r.sk!.S!.startsWith('PER#errand:'));
const store = (table: MemoryTable) => errandStore((command) => table.ddb.send(command as never) as ReturnType<ErrandSend>, 'wick');

const PLUMBER = { who: 'the plumber', date: '2026-10-15', time: '10:00', reminder: 'morning_of', tellMe: true } as const;

interface ErrandView {
  errandId: string;
  who: string;
  at: number;
  when: string;
  status: string;
  reminded: boolean;
  remindAt?: number;
  rangAt?: number;
  said: string;
}

describe('arrange_visit — "the plumber is coming Thursday at ten, let Mum know"', () => {
  it('files the errand, tells the door whom to expect, and starts the state machine named by the errand', async () => {
    const table = createMemoryTable();
    const { machine, started } = fakeMachine();
    const client = await connect(table, sarah, machine);

    const result = await client.callTool({ name: 'arrange_visit', arguments: PLUMBER });

    const { errand } = content<{ arranged: true; errand: ErrandView }>(result);
    expect(errand).toMatchObject({
      who: 'the plumber',
      at: THURSDAY_TEN,
      when: 'Thursday 15 October at 10:00 am',
      status: 'planned',
      reminded: false,
      // Eight in the morning on the day, her time.
      remindAt: Date.UTC(2026, 9, 15, 7),
      tellMe: true,
      said: 'The door knows to expect the plumber on Thursday 15 October at 10:00 am.',
    });
    expect(errand.errandId).toMatch(/^err_[A-Za-z0-9_-]{20}$/);

    const [row] = errandRows(table);
    expect(row).toMatchObject({ createdBy: { S: 'u_sarah' }, createdByName: { S: 'Sarah Hughes' }, who: { S: 'the plumber' }, status: { S: 'planned' } });
    const roster = JSON.parse(rosterRows(table)[0]!.data!.S!) as RosterEntry;
    expect(roster).toMatchObject({ personId: `errand:${errand.errandId}`, name: 'the plumber', expectedOnce: { at: THURSDAY_TEN, windowMin: 60 }, addedBy: 'u_sarah' });

    expect(started).toEqual([{
      name: errand.errandId,
      input: { householdId: HH, errandId: errand.errandId, remindAt: '2026-10-15T07:00:00Z', windowEnd: '2026-10-15T10:00:00Z', door: { waitSeconds: (THURSDAY_TEN + 3_600_000 - NOW) / 1000 } },
    }]);
    // The execution is kept for the operator, and never handed to the family.
    expect(row!.executionArn!.S).toBe(`arn:aws:states:eu-west-2:111122223333:execution:wick-errand:${errand.errandId}`);
    expect(JSON.stringify(result)).not.toContain('arn:aws');
  });

  it('reminds her an hour before, or not at all, as the member chose', async () => {
    const table = createMemoryTable();
    const { machine, started } = fakeMachine();
    const client = await connect(table, sarah, machine);

    await client.callTool({ name: 'arrange_visit', arguments: { ...PLUMBER, reminder: 'hour_before' } });
    await client.callTool({ name: 'arrange_visit', arguments: { ...PLUMBER, time: '15:00', reminder: 'none' } });

    expect(started[0]!.input.remindAt).toBe('2026-10-15T08:00:00Z');
    expect(started[1]!.input).not.toHaveProperty('remindAt');
  });

  it('accepts a visit two minutes from now, so one can be watched end to end', async () => {
    const table = createMemoryTable();
    const { machine } = fakeMachine();
    // 13:00:00 in London; the visit at 13:02.
    const client = await connect(table, sarah, machine);

    const result = await client.callTool({ name: 'arrange_visit', arguments: { ...PLUMBER, date: '2026-10-13', time: '13:02' } });

    expect(content<{ errand: ErrandView }>(result).errand.status).toBe('planned');
  });

  it('refuses a time that has passed, one too soon to tell the door, one too far ahead, and one it cannot read — and writes nothing', async () => {
    const table = createMemoryTable();
    const { machine, started } = fakeMachine();
    const client = await connect(table, sarah, machine);
    const ask = (date: string, time: string) => client.callTool({ name: 'arrange_visit', arguments: { ...PLUMBER, date, time } });

    expect(said(await ask('2026-10-13', '12:00'))).toBe(EXPECT_VISIT_PAST_TEXT);
    expect(said(await ask('2026-10-13', '13:01'))).toBe(ARRANGE_TOO_SOON_TEXT);
    expect(said(await ask('2026-12-31', '10:00'))).toBe(EXPECT_VISIT_TOO_FAR_TEXT);
    expect(said(await ask('2026-02-30', '10:00'))).toBe(EXPECT_VISIT_BAD_TIME_TEXT);
    expect(said(await ask('2026-10-15', '25:00'))).toBe(EXPECT_VISIT_BAD_TIME_TEXT);

    expect(errandRows(table)).toHaveLength(0);
    expect(started).toHaveLength(0);
    expect(ERRAND_LIMITS.minLeadMs).toBe(2 * 60_000);
  });

  it('asks for who is coming in a few words, and for another word when the Guardian cannot clear it', async () => {
    const table = createMemoryTable();
    const { machine, started } = fakeMachine();
    const client = await connect(table, sarah, machine);
    const ask = (who: string) => client.callTool({ name: 'arrange_visit', arguments: { ...PLUMBER, who } });

    expect(said(await ask('   '))).toBe(ARRANGE_BAD_WHO_TEXT);
    expect(said(await ask('x'.repeat(41)))).toBe(ARRANGE_BAD_WHO_TEXT);
    // A role is a fact about her health, and the errand's words reach the family again (INV-4).
    expect(said(await ask('the nurse'))).toBe(ARRANGE_WHO_NOT_SHARED_TEXT);
    expect(ARRANGE_WHO_NOT_SHARED_TEXT).toMatch(/another word/);

    expect(errandRows(table)).toHaveLength(0);
    expect(rosterRows(table)).toHaveLength(0);
    expect(started).toHaveLength(0);
  });

  it('trims who is coming, and takes forty characters', async () => {
    const table = createMemoryTable();
    const { machine } = fakeMachine();
    const client = await connect(table, sarah, machine);

    const result = await client.callTool({ name: 'arrange_visit', arguments: { ...PLUMBER, who: `  ${'Dave from the council, about the drains'}  ` } });

    expect(content<{ errand: ErrandView }>(result).errand.who).toBe('Dave from the council, about the drains');
  });

  it('carries at most ten open errands for a household at once', async () => {
    const table = createMemoryTable();
    const { machine, started } = fakeMachine();
    const client = await connect(table, sarah, machine);
    for (let i = 0; i < ERRAND_LIMITS.maxOpenPerHousehold; i += 1) {
      await client.callTool({ name: 'arrange_visit', arguments: { ...PLUMBER, time: `1${i}:00` } });
    }

    const eleventh = await client.callTool({ name: 'arrange_visit', arguments: { ...PLUMBER, time: '20:30' } });

    expect(said(eleventh)).toBe(ARRANGE_TOO_MANY_TEXT);
    expect(started).toHaveLength(10);
  });

  it('counts only errands still open: one that is over makes room', async () => {
    const table = createMemoryTable();
    const { machine } = fakeMachine();
    const client = await connect(table, sarah, machine);
    for (let i = 0; i < ERRAND_LIMITS.maxOpenPerHousehold; i += 1) {
      await client.callTool({ name: 'arrange_visit', arguments: { ...PLUMBER, time: `1${i}:00` } });
    }
    const [first] = await store(table).list(HH);
    await store(table).move(HH, first!.errandId, ['planned'], 'no_show');

    const another = await client.callTool({ name: 'arrange_visit', arguments: { ...PLUMBER, time: '20:30' } });

    expect(content<{ errand: ErrandView }>(another).errand.status).toBe('planned');
  });

  it('arranges once when the same call comes twice: one errand, one execution, the answer repeated', async () => {
    const table = createMemoryTable();
    const { machine, started } = fakeMachine();
    const client = await connect(table, sarah, machine);

    const first = content<{ errand: ErrandView }>(await client.callTool({ name: 'arrange_visit', arguments: PLUMBER }));
    const again = content<{ errand: ErrandView; repeated?: true }>(await client.callTool({ name: 'arrange_visit', arguments: PLUMBER }));

    expect(again.repeated).toBe(true);
    expect(again.errand.errandId).toBe(first.errand.errandId);
    expect(errandRows(table)).toHaveLength(1);
    expect(started).toHaveLength(1);
  });

  it('leaves nothing standing when the machine could not be started, so it can be tried again', async () => {
    const table = createMemoryTable();
    const { machine, started, failOnce } = fakeMachine();
    const client = await connect(table, sarah, machine);
    failOnce();

    const failed = await client.callTool({ name: 'arrange_visit', arguments: PLUMBER });

    expect(failed.isError).toBe(true);
    expect(errandRows(table).map((r) => r.status!.S)).toEqual(['failed']);
    expect(rosterRows(table)).toHaveLength(0);

    const retried = await client.callTool({ name: 'arrange_visit', arguments: PLUMBER });
    expect(content<{ errand: ErrandView }>(retried).errand.status).toBe('planned');
    expect(started).toHaveLength(1);
  });

  it('says so, and writes nothing, on a Wick with no errand machine', async () => {
    const table = createMemoryTable();
    const client = await connect(table, sarah, undefined);

    expect(said(await client.callTool({ name: 'arrange_visit', arguments: PLUMBER }))).toBe(ERRANDS_UNAVAILABLE_TEXT);
    expect(table.rows(`HH#${HH}`)).toHaveLength(0);
  });

  it('arranges nothing for someone the resident has not allowed (INV-9), nor for a neighbour', async () => {
    const table = createMemoryTable();
    const { machine, started } = fakeMachine();
    const waiting: ToolContext = { householdId: HH, userId: 'u_sarah', access: async () => ({ ok: false, reason: 'waiting', say: 'Margaret hasn’t allowed this yet.' }) };
    const tom = allowedContext(HH, { userId: 'u_tom', name: 'Tom', role: 'neighbour' });

    expect(said(await (await connect(table, waiting, machine)).callTool({ name: 'arrange_visit', arguments: PLUMBER }))).toBe('Margaret hasn’t allowed this yet.');
    expect(said(await (await connect(table, tom, machine)).callTool({ name: 'arrange_visit', arguments: PLUMBER }))).toMatch(/neighbour/);
    expect(table.rows(`HH#${HH}`)).toHaveLength(0);
    expect(started).toHaveLength(0);
  });
});

describe('get_errands — "did the plumber come?"', () => {
  const plant = (table: MemoryTable, errand: Partial<Errand> & Pick<Errand, 'errandId'>) =>
    store(table).create({
      householdId: HH, createdBy: 'u_sarah', createdByName: 'Sarah Hughes', who: 'the plumber', at: THURSDAY_TEN, windowMinutes: 60,
      tellMe: true, status: 'planned', createdAt: NOW, ...errand,
    });

  it('tells what the door saw, honestly: somebody rang around then — never that the plumber came', async () => {
    const table = createMemoryTable();
    await plant(table, { errandId: 'err_RANGRANGRANGRANGRANG' });
    await store(table).move(HH, 'err_RANGRANGRANGRANGRANG', ['planned'], 'rang', { rangAt: THURSDAY_TEN + 4 * 60_000, cardId: 'door-abc' });
    const client = await connect(table, sarah, fakeMachine().machine, THURSDAY_TEN + 3 * 3_600_000);

    const { errands } = content<{ errands: ErrandView[] }>(await client.callTool({ name: 'get_errands', arguments: {} }));

    expect(errands).toHaveLength(1);
    expect(errands[0]).toMatchObject({ status: 'rang', rangAt: THURSDAY_TEN + 4 * 60_000 });
    expect(errands[0]!.said).toBe('Someone rang at 10:04 am, around when the plumber was expected.');
    expect(errands[0]!.said).not.toMatch(/came/);
  });

  it('says when nobody rang in the window', async () => {
    const table = createMemoryTable();
    await plant(table, { errandId: 'err_NOSHOWNOSHOWNOSHOW_' });
    await store(table).move(HH, 'err_NOSHOWNOSHOWNOSHOW_', ['planned'], 'no_show');
    const client = await connect(table, sarah, fakeMachine().machine, THURSDAY_TEN + 3 * 3_600_000);

    const { errands } = content<{ errands: ErrandView[] }>(await client.callTool({ name: 'get_errands', arguments: {} }));

    expect(errands[0]!.said).toBe('Nobody rang between 9:00 am and 11:00 am, when the plumber was expected.');
  });

  it('says she has been reminded, once she has', async () => {
    const table = createMemoryTable();
    await plant(table, { errandId: 'err_REMINDEDREMINDEDREM' });
    await store(table).move(HH, 'err_REMINDEDREMINDEDREM', ['planned'], 'waiting', { remindedAt: THURSDAY_TEN - 2 * 3_600_000, taskToken: 't' });
    const client = await connect(table, sarah, fakeMachine().machine, THURSDAY_TEN - 3_600_000);

    const { errands } = content<{ errands: ErrandView[] }>(await client.callTool({ name: 'get_errands', arguments: {} }));

    expect(errands[0]).toMatchObject({ status: 'waiting', reminded: true, said: 'Margaret has been reminded that the plumber is coming on Thursday 15 October at 10:00 am.' });
  });

  it('lists only the member’s own, open or from the last seven days, newest first — and never the execution or the token', async () => {
    const table = createMemoryTable();
    await plant(table, { errandId: 'err_OLDOLDOLDOLDOLDOLDOL', at: NOW - 9 * 86_400_000, status: 'no_show', createdAt: NOW - 10 * 86_400_000 });
    await plant(table, { errandId: 'err_DAVIDSDAVIDSDAVIDS_', createdBy: 'u_david', createdByName: 'David' });
    await plant(table, { errandId: 'err_FIRSTFIRSTFIRSTFIRS', createdAt: NOW - 1000 });
    await plant(table, { errandId: 'err_LATERLATERLATERLATE', who: 'the window cleaner', createdAt: NOW });
    await store(table).setExecution(HH, 'err_LATERLATERLATERLATE', 'arn:aws:states:eu-west-2:1:execution:wick-errand:err_LATERLATERLATERLATE');
    await store(table).move(HH, 'err_LATERLATERLATERLATE', ['planned'], 'waiting', { taskToken: 'secret-token' });
    const client = await connect(table, sarah, fakeMachine().machine);

    const result = await client.callTool({ name: 'get_errands', arguments: {} });

    expect(content<{ errands: ErrandView[] }>(result).errands.map((e) => e.errandId)).toEqual(['err_LATERLATERLATERLATE', 'err_FIRSTFIRSTFIRSTFIRS']);
    expect(JSON.stringify(result)).not.toMatch(/arn:aws|secret-token|executionArn|taskToken/);
  });

  it('says there are none', async () => {
    const client = await connect(createMemoryTable(), sarah, fakeMachine().machine);
    expect(said(await client.callTool({ name: 'get_errands', arguments: {} }))).toBe(NO_ERRANDS_TEXT);
  });
});

describe('cancel_errand — "the plumber can’t come after all"', () => {
  async function arranged() {
    const table = createMemoryTable();
    const fake = fakeMachine();
    const client = await connect(table, sarah, fake.machine);
    const { errand } = content<{ errand: ErrandView }>(await client.callTool({ name: 'arrange_visit', arguments: PLUMBER }));
    return { table, client, errand, ...fake };
  }

  it('calls it off: the machine stopped, the door no longer told, the errand cancelled', async () => {
    const { table, client, errand, stopped } = await arranged();

    const result = await client.callTool({ name: 'cancel_errand', arguments: { errandId: errand.errandId } });

    expect(content<{ cancelled: true; errand: ErrandView }>(result)).toMatchObject({
      cancelled: true,
      errand: { status: 'cancelled', said: 'The visit from the plumber on Thursday 15 October at 10:00 am was called off.' },
    });
    expect(stopped).toEqual([`arn:aws:states:eu-west-2:111122223333:execution:wick-errand:${errand.errandId}`]);
    expect(rosterRows(table)).toHaveLength(0);
    expect(errandRows(table)[0]!.status!.S).toBe('cancelled');
  });

  it('is the same answer asked again, and stops nothing twice', async () => {
    const { client, errand, stopped } = await arranged();
    await client.callTool({ name: 'cancel_errand', arguments: { errandId: errand.errandId } });

    const again = await client.callTool({ name: 'cancel_errand', arguments: { errandId: errand.errandId } });

    expect(content<{ errand: ErrandView }>(again).errand.status).toBe('cancelled');
    expect(stopped).toHaveLength(1);
  });

  it('is only the author’s to call off: anyone else is told there is no such visit, and nothing changes', async () => {
    const { table, errand, machine, stopped } = await arranged();
    const asDavid = await connect(table, david, machine);

    expect(said(await asDavid.callTool({ name: 'cancel_errand', arguments: { errandId: errand.errandId } }))).toBe(ERRAND_NOT_FOUND_TEXT);
    expect(said(await asDavid.callTool({ name: 'cancel_errand', arguments: { errandId: 'err_NOSUCHNOSUCHNOSUCHN' } }))).toBe(ERRAND_NOT_FOUND_TEXT);
    expect(errandRows(table)[0]!.status!.S).toBe('planned');
    expect(rosterRows(table)).toHaveLength(1);
    expect(stopped).toHaveLength(0);
  });

  it('cannot call off a visit that is over', async () => {
    const { table, client, errand, stopped } = await arranged();
    await store(table).move(HH, errand.errandId, ['planned'], 'rang', { rangAt: THURSDAY_TEN });

    expect(said(await client.callTool({ name: 'cancel_errand', arguments: { errandId: errand.errandId } }))).toBe(ERRAND_ALREADY_OVER_TEXT);
    expect(stopped).toHaveLength(0);
  });
});
