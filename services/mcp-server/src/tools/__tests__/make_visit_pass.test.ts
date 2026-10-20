/**
 * make_visit_pass — "Send Doctor Rossi a link", from the family's side:
 * through the real gate, against the table in memory.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { errandStore, type ErrandSend } from '@wick/agent';
import { VISIT_PASS_SK, isVisitPassToken, visitPassPk } from '@wick/contracts';
import { createMemoryTable, type MemoryTable } from '../../__tests__/memoryTable.js';
import { guardTools } from '../../guardian.js';
import type { ToolContext } from '../context.js';
import type { ErrandMachine } from '../errands.js';
import { registerArrangeVisit } from '../arrange_visit.js';
import { registerGetErrands } from '../get_errands.js';
import { registerCancelErrand, ERRAND_NOT_FOUND_TEXT } from '../cancel_errand.js';
import { VISIT_PASS_OVER_TEXT, VISIT_PASS_UNAVAILABLE_TEXT, registerMakeVisitPass } from '../make_visit_pass.js';
import { allowedContext } from './toolContext.js';

const HH = 'hh-1';
// Tuesday 13 October 2026, 13:00 in London.
const NOW = Date.UTC(2026, 9, 13, 12);
// Thursday 15 October 2026, 10:00 in London.
const THURSDAY_TEN = Date.UTC(2026, 9, 15, 9);
const HOUR = 3_600_000;
const FAMILY_APP = 'https://family.example';
const sarah = allowedContext(HH, { userId: 'u_sarah', name: 'Sarah Hughes' });
const david = allowedContext(HH, { userId: 'u_david', name: 'David', role: 'family' });
const machine: ErrandMachine = { start: async (name) => `arn:aws:states:eu-west-2:1:execution:wick-errand:${name}`, stop: async () => {} };

afterEach(() => vi.restoreAllMocks());

async function connect(table: MemoryTable, ctx: ToolContext, now = NOW, familyAppUrl = FAMILY_APP) {
  // Behind the Guardian, as every tool is (server.ts createMcpServer).
  const server = guardTools(new McpServer({ name: 'test', version: '0.1.0' }));
  registerArrangeVisit(server, table.ddb, ctx, machine, () => now);
  registerGetErrands(server, table.ddb, ctx, () => now);
  registerCancelErrand(server, table.ddb, ctx, machine);
  registerMakeVisitPass(server, table.ddb, ctx, familyAppUrl, () => now);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.1.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

interface Pass { link: string; who: string; opensAt: number; closesAt: number; said: string }
const structured = <T>(result: unknown) => (result as { structuredContent: T }).structuredContent;
const said = (result: unknown) => structured<{ say?: string }>(result).say;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const tokenOf = (link: string) => link.slice(link.indexOf('#') + 1);
const errandRow = (table: MemoryTable) => table.rows(`HH#${HH}`).find((r) => r.sk!.S!.startsWith('ERRAND#'))!;
const passRow = (table: MemoryTable, token: string) => table.rows(visitPassPk(sha256(token)))[0];

async function arranged(who = 'Doctor Rossi') {
  const table = createMemoryTable();
  const client = await connect(table, sarah);
  const { errand } = structured<{ errand: { errandId: string } }>(await client.callTool({ name: 'arrange_visit', arguments: { who, date: '2026-10-15', time: '10:00' } }));
  return { table, client, errandId: errand.errandId };
}

describe('make_visit_pass — a link for the visitor the member arranged', () => {
  it('hands the member a link to send, in their own words, and keeps only the token’s hash', async () => {
    const { table, client, errandId } = await arranged();

    const result = await client.callTool({ name: 'make_visit_pass', arguments: { errandId } });

    expect(result.isError).toBeFalsy();
    const pass = structured<Pass>(result);
    expect(pass.link).toMatch(/^https:\/\/family\.example\/visit\.html#[0-9a-f]{32}$/);
    expect(isVisitPassToken(tokenOf(pass.link))).toBe(true);
    expect(pass).toMatchObject({
      who: 'Doctor Rossi',
      opensAt: THURSDAY_TEN - 3 * HOUR,
      closesAt: THURSDAY_TEN + HOUR,
      said: 'Send this link to Doctor Rossi. It works from 7:00 am to 11:00 am on Thursday 15 October, and lets them say they are on the way, running late, or at the door — nothing else.',
    });

    const token = tokenOf(pass.link);
    expect(passRow(table, token)).toEqual({
      pk: { S: visitPassPk(sha256(token)) },
      sk: { S: VISIT_PASS_SK },
      householdId: { S: HH },
      errandId: { S: errandId },
      presses: { N: '0' },
      // A day after the visit's window has closed.
      ttl: { N: String(Math.floor((THURSDAY_TEN + HOUR + 24 * HOUR) / 1000)) },
    });
    expect(errandRow(table).passHash).toEqual({ S: sha256(token) });
    // The token itself is kept nowhere.
    expect(JSON.stringify([...table.rows(`HH#${HH}`), passRow(table, token)])).not.toContain(token);
  });

  it('replaces the link made before: one pass for one visit, and the old link stops working', async () => {
    const { table, client, errandId } = await arranged();
    const first = tokenOf(structured<Pass>(await client.callTool({ name: 'make_visit_pass', arguments: { errandId } })).link);

    const second = tokenOf(structured<Pass>(await client.callTool({ name: 'make_visit_pass', arguments: { errandId } })).link);

    expect(second).not.toBe(first);
    expect(passRow(table, first)).toBeUndefined();
    expect(passRow(table, second)).toBeDefined();
    expect(errandRow(table).passHash).toEqual({ S: sha256(second) });
  });

  it('is told on the visit afterwards: it has a link', async () => {
    const { client, errandId } = await arranged();
    await client.callTool({ name: 'make_visit_pass', arguments: { errandId } });

    const { errands } = structured<{ errands: { hasPass: boolean }[] }>(await client.callTool({ name: 'get_errands', arguments: {} }));

    expect(errands[0]!.hasPass).toBe(true);
  });

  it('is only the author’s: anyone else, and an id that is nobody’s, is told the same — and nothing is written', async () => {
    const { table, errandId } = await arranged();
    const asDavid = await connect(table, david);
    const before = JSON.stringify(table.rows(`HH#${HH}`));

    const theirs = await asDavid.callTool({ name: 'make_visit_pass', arguments: { errandId } });
    const nobodys = await asDavid.callTool({ name: 'make_visit_pass', arguments: { errandId: 'err_NOSUCHNOSUCHNOSUCHN' } });

    expect(said(theirs)).toBe(ERRAND_NOT_FOUND_TEXT);
    expect(said(nobodys)).toBe(ERRAND_NOT_FOUND_TEXT);
    expect(JSON.stringify(theirs)).toBe(JSON.stringify(nobodys));
    expect(JSON.stringify(table.rows(`HH#${HH}`))).toBe(before);
  });

  it('makes none for a visit called off, or one that is over', async () => {
    const cancelled = await arranged();
    await cancelled.client.callTool({ name: 'cancel_errand', arguments: { errandId: cancelled.errandId } });
    expect(said(await cancelled.client.callTool({ name: 'make_visit_pass', arguments: { errandId: cancelled.errandId } }))).toBe(VISIT_PASS_OVER_TEXT);

    const rang = await arranged();
    await errandStore((command) => rang.table.ddb.send(command as never) as ReturnType<ErrandSend>, 'wick').move(HH, rang.errandId, ['planned'], 'rang', { rangAt: THURSDAY_TEN });
    expect(said(await rang.client.callTool({ name: 'make_visit_pass', arguments: { errandId: rang.errandId } }))).toBe(VISIT_PASS_OVER_TEXT);

    // Still planned, but its window has closed: the steps have not caught up yet.
    const late = await arranged();
    const afterwards = await connect(late.table, sarah, THURSDAY_TEN + HOUR + 1);
    expect(said(await afterwards.callTool({ name: 'make_visit_pass', arguments: { errandId: late.errandId } }))).toBe(VISIT_PASS_OVER_TEXT);

    for (const { table } of [cancelled, rang, late]) expect(errandRow(table)).not.toHaveProperty('passHash');
  });

  it('says so on a Wick that does not know where the family app is', async () => {
    const { table, errandId } = await arranged();
    const client = await connect(table, sarah, NOW, '');

    expect(said(await client.callTool({ name: 'make_visit_pass', arguments: { errandId } }))).toBe(VISIT_PASS_UNAVAILABLE_TEXT);
    expect(errandRow(table)).not.toHaveProperty('passHash');
  });

  it('never writes the token to a log', async () => {
    const lines: unknown[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args));
    const { client, errandId } = await arranged();

    const token = tokenOf(structured<Pass>(await client.callTool({ name: 'make_visit_pass', arguments: { errandId } })).link);

    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(lines)).not.toContain(token);
    expect(JSON.stringify(lines)).not.toContain(sha256(token));
  });

  it('makes nothing for a neighbour, nor for someone the resident has not allowed', async () => {
    const { table, errandId } = await arranged();
    const tom = allowedContext(HH, { userId: 'u_tom', name: 'Tom', role: 'neighbour' });
    const waiting: ToolContext = { householdId: HH, userId: 'u_sarah', access: async () => ({ ok: false, reason: 'waiting', say: 'Margaret hasn’t allowed this yet.' }) };

    expect(said(await (await connect(table, tom)).callTool({ name: 'make_visit_pass', arguments: { errandId } }))).toMatch(/neighbour/);
    expect(said(await (await connect(table, waiting)).callTool({ name: 'make_visit_pass', arguments: { errandId } }))).toBe('Margaret hasn’t allowed this yet.');
    expect(errandRow(table)).not.toHaveProperty('passHash');
  });
});
