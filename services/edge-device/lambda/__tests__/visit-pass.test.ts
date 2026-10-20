/**
 * The visit pass, the edge's half (visit-pass.mjs): what three buttons on a
 * visitor's phone can do, and everything they cannot.
 *
 * The table is in memory and honours exactly the conditions the handler
 * writes under; the bus is a list. The constants and rules inlined from
 * packages/contracts visitPass.ts are held to it here.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GetItemCommand, QueryCommand, UpdateItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import {
  VISITOR_SAYS as CONTRACT_SAYS,
  VISIT_EVENTS as CONTRACT_EVENTS,
  VISIT_PASS_LIMITS as CONTRACT_LIMITS,
  VISIT_PASS_PK_PREFIX as CONTRACT_PK_PREFIX,
  VISIT_PASS_SK as CONTRACT_SK,
  errandPersonId,
  errandSk,
  isVisitPassToken as contractIsToken,
  nextLateMinutes as contractNextLate,
  passStateAt as contractPassState,
  readHomeState,
  readVisitSaidDetail,
  readVisitorWord as contractReadWord,
} from '@wick/contracts';
import {
  PASS_SPEAKS_FOR,
  VISIT_EVENTS,
  VISIT_PASS_PK_PREFIX,
  VISIT_PASS_SK,
  createHandler,
  isVisitPassToken,
  nextLateMinutes,
  passStateAt,
  tokenHash,
  // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
} from '../visit-pass.mjs';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { VISITOR_SAYS, VISIT_PASS_LIMITS, readVisitorWord } from '../visitor-word.mjs';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { readHome } from '../home.mjs';

type Item = Record<string, AttributeValue>;

const TOKEN = '0123456789abcdef0123456789abcdef';
const HASH = createHash('sha256').update(TOKEN).digest('hex');
const ERRAND = 'err_AAAAAAAAAAAAAAAAAAAA';
const HH = 'hh-1';
/** Thursday 22 October 2026, 10:00 in London: the doctor's visit. */
const VISIT_AT = Date.parse('2026-10-22T09:00:00Z');
const MINUTE = 60_000;

const keyOf = (key: Item | undefined) => `${key?.pk?.S}|${key?.sk?.S}`;
const refused = () => Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });

function seed(over: { errand?: Partial<Record<string, AttributeValue>> | null; member?: string | null; pass?: Item | null; roster?: boolean; presses?: number } = {}): Item[] {
  const rows: Item[] = [
    { pk: { S: 'HH#hh-1' }, sk: { S: 'META' }, residentName: { S: 'Margaret Hill' }, timeZone: { S: 'Europe/London' } },
  ];
  if (over.pass !== null) {
    rows.push(over.pass ?? {
      pk: { S: `VPASS#${HASH}` },
      sk: { S: 'VPASS' },
      householdId: { S: HH },
      errandId: { S: ERRAND },
      ...(over.presses === undefined ? {} : { presses: { N: String(over.presses) } }),
      ttl: { N: '1793000000' },
    });
  }
  if (over.errand !== null) {
    rows.push({
      pk: { S: 'HH#hh-1' },
      sk: { S: errandSk(ERRAND) },
      errandId: { S: ERRAND },
      createdBy: { S: 'u_sarah' },
      createdByName: { S: 'Sarah Hughes' },
      who: { S: 'Doctor Rossi' },
      at: { N: String(VISIT_AT) },
      windowMinutes: { N: '60' },
      tellMe: { BOOL: true },
      status: { S: 'waiting' },
      createdAt: { N: String(VISIT_AT - 86_400_000) },
      passHash: { S: HASH },
      ...(over.errand ?? {}),
    } as Item);
  }
  if (over.roster !== false) {
    rows.push({
      pk: { S: 'HH#hh-1' },
      sk: { S: `PER#${errandPersonId(ERRAND)}` },
      data: { S: JSON.stringify({ personId: errandPersonId(ERRAND), name: 'Doctor Rossi', expectedOnce: { at: VISIT_AT, windowMin: 60 }, addedBy: 'u_sarah', arrangedByName: 'Sarah Hughes' }) },
    });
  }
  if (over.member !== null) rows.push({ pk: { S: 'HH#hh-1' }, sk: { S: 'MEM#u_sarah' }, status: { S: over.member ?? 'allowed' }, name: { S: 'Sarah Hughes' } });
  return rows;
}

const SPEAKS_FOR = /^attribute_exists\(pk\) AND #s IN \((:s\d(?:, )?)+\)$/;

/** The table in memory, honouring exactly the conditions the handler writes under — and refusing any other. */
function table(rows: Item[]) {
  const items = new Map(rows.map((row) => [keyOf(row), structuredClone(row)]));
  const writes: UpdateItemCommand['input'][] = [];
  const send = async (command: GetItemCommand | UpdateItemCommand | QueryCommand) => {
    if (command instanceof GetItemCommand) {
      expect(command.input.ConsistentRead).toBe(true);
      return { Item: items.get(keyOf(command.input.Key)) };
    }
    if (command instanceof QueryCommand) {
      const v = command.input.ExpressionAttributeValues!;
      const mine = [...items.values()].filter((row) => row.pk!.S === v[':pk']!.S).sort((a, b) => (a.sk!.S! < b.sk!.S! ? -1 : 1));
      return { Items: v[':prefix'] ? mine.filter((row) => row.sk!.S!.startsWith(v[':prefix']!.S!)) : mine.filter((row) => row.sk!.S! >= v[':from']!.S! && row.sk!.S! <= v[':to']!.S!) };
    }
    const input = command.input;
    const row = items.get(keyOf(input.Key));
    const v = input.ExpressionAttributeValues!;
    if (input.UpdateExpression === 'ADD presses :one') {
      expect(input.ConditionExpression).toBe('attribute_exists(pk) AND (attribute_not_exists(presses) OR presses < :max)');
      if (!row || Number(row.presses?.N ?? 0) >= Number(v[':max']!.N)) throw refused();
      row.presses = { N: String(Number(row.presses?.N ?? 0) + Number(v[':one']!.N)) };
    } else if (input.UpdateExpression === 'SET visitorWord = :word') {
      if (!row) throw refused();
      if (input.ConditionExpression !== 'attribute_exists(pk)') {
        expect(input.ConditionExpression).toMatch(SPEAKS_FOR);
        const allowed = Object.entries(v).filter(([name]) => /^:s\d$/.test(name)).map(([, value]) => value.S);
        if (!allowed.includes(row.status?.S)) throw refused();
      }
      row.visitorWord = v[':word']!;
    } else {
      throw new Error(`not an update this handler makes: ${input.UpdateExpression}`);
    }
    writes.push(input);
    return {};
  };
  return { items, writes, send };
}

interface Answer { readonly status: number; readonly body: Record<string, unknown>; readonly headers: Record<string, string> }

function edge(rows: Item[] = seed(), over: { now?: number; putEvents?: (entries: unknown[]) => Promise<unknown> } = {}) {
  const t = table(rows);
  const published: { EventBusName: string; Source: string; DetailType: string; Detail: string }[][] = [];
  let now = over.now ?? VISIT_AT - 20 * MINUTE;
  const handler = createHandler({
    send: t.send,
    putEvents: over.putEvents ?? (async (entries: never[]) => (published.push(entries), { FailedEntryCount: 0 })),
    table: 'wick',
    busName: 'wick-bus',
    now: () => now,
  });
  const call = async (route: 'status' | 'say', body: unknown, raw = false): Promise<Answer> => {
    const res = await handler({ routeKey: `POST /visit/${route}`, body: raw ? body : JSON.stringify(body) });
    return { status: res.statusCode, body: JSON.parse(res.body), headers: res.headers };
  };
  return {
    ...t,
    published,
    status: (token: unknown = TOKEN) => call('status', { token }),
    say: (says: unknown, token: unknown = TOKEN) => call('say', { token, says }),
    call,
    setNow: (at: number) => void (now = at),
    word: (sk: string) => {
      const raw = t.items.get(`HH#hh-1|${sk}`)?.visitorWord?.S;
      return raw ? JSON.parse(raw) : undefined;
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('what the inlined rules are', () => {
  it('are the contract’s own', () => {
    expect(VISITOR_SAYS).toEqual([...CONTRACT_SAYS]);
    expect(VISIT_PASS_LIMITS).toEqual({ opensBeforeMs: CONTRACT_LIMITS.opensBeforeMs, lateStepMinutes: CONTRACT_LIMITS.lateStepMinutes, maxPresses: CONTRACT_LIMITS.maxPresses });
    expect([VISIT_PASS_PK_PREFIX, VISIT_PASS_SK]).toEqual([CONTRACT_PK_PREFIX, CONTRACT_SK]);
    expect(VISIT_EVENTS).toEqual(CONTRACT_EVENTS);
    expect(tokenHash(TOKEN)).toBe(HASH);
    for (const value of [TOKEN, TOKEN.toUpperCase(), TOKEN.slice(1), `${TOKEN}0`, 'g'.repeat(32), '', undefined, 42]) {
      expect(isVisitPassToken(value), String(value)).toBe(contractIsToken(value));
    }
    const visit = { at: VISIT_AT, windowMinutes: 60 };
    for (const now of [VISIT_AT - 3 * 3_600_000 - 1, VISIT_AT - 3 * 3_600_000, VISIT_AT, VISIT_AT + 60 * MINUTE, VISIT_AT + 60 * MINUTE + 1]) {
      expect(passStateAt(visit, now)).toBe(contractPassState(visit, now));
    }
    for (const [current, window] of [[undefined, 60], [15, 60], [45, 60], [60, 60], [undefined, 10]] as const) {
      expect(nextLateMinutes(current, window)).toBe(contractNextLate(current, window));
    }
    for (const raw of [{ says: 'late', at: 1, lateMinutes: 15 }, { says: 'late', at: 1 }, { says: 'on_way', at: 1, lateMinutes: 15 }, { says: 'come_in', at: 1 }, { says: 'at_door', at: Number.NaN }, null, 'at_door']) {
      expect(readVisitorWord(raw)).toEqual(contractReadWord(raw));
    }
  });

  it('let a pass speak for a visit still waiting, or one whose door has rung, and no other', () => {
    expect(PASS_SPEAKS_FOR).toEqual(['planned', 'reminded', 'waiting', 'rang']);
  });
});

describe('POST /visit/status', () => {
  it('says the pass is open, and nothing more, before anything has been said', async () => {
    const e = edge();
    const res = await e.status();
    expect(res).toMatchObject({ status: 200, body: { state: 'open' } });
    expect(res.headers['content-type']).toBe('application/json');
    expect(e.writes).toEqual([]);
    expect(e.published).toEqual([]);
  });

  it('says what was last said, and when — and never who, the house or the member', async () => {
    const e = edge();
    await e.say('late');
    const res = await e.status();
    expect(res.body).toEqual({ state: 'open', says: 'late', at: VISIT_AT - 20 * MINUTE, lateMinutes: 15 });
    expect(JSON.stringify(res)).not.toMatch(/Rossi|Sarah|Margaret|hh-1|u_sarah|err_/);
  });

  it('says "not yet" to a real pass before its visit’s three hours, and writes nothing', async () => {
    const e = edge(seed(), { now: VISIT_AT - 3 * 3_600_000 - 1 });
    expect((await e.status()).body).toEqual({ state: 'not_yet' });
    expect((await e.say('on_way')).body).toEqual({ state: 'not_yet' });
    expect(e.writes).toEqual([]);
    expect(e.published).toEqual([]);
  });
});

describe('POST /visit/say', () => {
  it('keeps "on my way" on the visit and beside the door’s roster entry, counts the press, and answers with it', async () => {
    const e = edge();

    const res = await e.say('on_way');

    expect(res).toMatchObject({ status: 200, body: { state: 'open', says: 'on_way', at: VISIT_AT - 20 * MINUTE } });
    const word = { says: 'on_way', at: VISIT_AT - 20 * MINUTE };
    expect(e.word(errandSk(ERRAND))).toEqual(word);
    expect(e.word(`PER#${errandPersonId(ERRAND)}`)).toEqual(word);
    // The entry the door matches on is never rewritten: the word is an attribute of its own.
    expect(e.items.get(`HH#hh-1|PER#${errandPersonId(ERRAND)}`)!.data!.S).toContain('"name":"Doctor Rossi"');
    expect(e.items.get(`VPASS#${HASH}|VPASS`)!.presses).toEqual({ N: '1' });
  });

  it('tells the bus once, with her home whole and what was said, and nothing of who', async () => {
    const e = edge();

    await e.say('at_door');

    expect(e.published).toHaveLength(1);
    const [homeChanged, said] = e.published[0]!;
    expect(homeChanged).toMatchObject({ EventBusName: 'wick-bus', Source: 'wick.device', DetailType: 'home.changed' });
    const detail = JSON.parse(homeChanged!.Detail);
    // No television pressed anything: every television of the home is told.
    expect(detail).not.toHaveProperty('deviceId');
    expect(detail).toMatchObject({ householdId: HH, at: VISIT_AT - 20 * MINUTE });
    // The home as device-event.mjs tells it: read the same way, from the same rows, just after the word was kept.
    expect(detail.home).toEqual(JSON.parse(JSON.stringify(await readHome({ send: e.send, table: 'wick', householdId: HH, now: VISIT_AT - 20 * MINUTE }))));
    expect(readHomeState(detail.home)).toBeDefined();
    // Her day already says it: the word was kept before the home was read.
    expect(detail.home.today.coming.map((c: { line: string }) => c.line)).toEqual(['Doctor Rossi says they are at your door. Sarah arranged it.']);

    expect(said).toEqual({ EventBusName: 'wick-bus', Source: 'wick.visit', DetailType: 'visit.said', Detail: JSON.stringify({ householdId: HH, errandId: ERRAND, says: 'at_door', at: VISIT_AT - 20 * MINUTE }) });
    expect(readVisitSaidDetail(JSON.parse(said!.Detail))).toEqual({ householdId: HH, errandId: ERRAND, says: 'at_door', at: VISIT_AT - 20 * MINUTE });
  });

  it('"running late" adds a quarter of an hour each time, from what was kept, never past the visit’s own window', async () => {
    const e = edge();
    const lates: unknown[] = [];
    for (let i = 0; i < 5; i += 1) lates.push((await e.say('late')).body.lateMinutes);
    expect(lates).toEqual([15, 30, 45, 60, 60]);
    // Said again after "on my way", it starts again at a quarter of an hour.
    await e.say('on_way');
    expect((await e.say('late')).body.lateMinutes).toBe(15);
  });

  it('keeps the word on the visit when the door no longer expects them, and never makes a roster row', async () => {
    const e = edge(seed({ roster: false }));
    expect((await e.say('on_way')).status).toBe(200);
    expect(e.word(errandSk(ERRAND))).toMatchObject({ says: 'on_way' });
    expect(e.items.has(`HH#hh-1|PER#${errandPersonId(ERRAND)}`)).toBe(false);
  });

  it('speaks for a visit whose door has rung: the doctor may press "I’m at the door" a moment after the bell', async () => {
    const e = edge(seed({ errand: { status: { S: 'rang' }, rangAt: { N: String(VISIT_AT - 21 * MINUTE) }, cardId: { S: 'door-abc' } } }));
    expect((await e.say('at_door')).body).toMatchObject({ state: 'open', says: 'at_door' });
  });

  it('is refused past thirty presses, and writes nothing more', async () => {
    const e = edge(seed({ presses: 30 }));
    expect(await e.say('on_way')).toMatchObject({ status: 429, body: { state: 'open', busy: true } });
    expect(e.writes).toEqual([]);
    expect(e.published).toEqual([]);
    const twentyNine = edge(seed({ presses: 29 }));
    expect((await twentyNine.say('on_way')).status).toBe(200);
    expect((await twentyNine.say('on_way')).status).toBe(429);
  });

  it('refuses a word that is not one of the three before it looks at the token', async () => {
    for (const says of ['come_in', '', undefined, 3]) {
      const e = edge();
      expect(await e.say(says)).toMatchObject({ status: 400, body: { error: 'says' } });
      expect(await e.say(says, 'nonsense')).toMatchObject({ status: 400, body: { error: 'says' } });
      expect(e.writes).toEqual([]);
    }
  });

  it('a bus that cannot be told costs the telling, never the press', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = edge(seed(), { putEvents: async () => { throw Object.assign(new Error('down'), { name: 'InternalException' }); } });

    expect(await e.say('at_door')).toMatchObject({ status: 200, body: { state: 'open', says: 'at_door' } });

    expect(e.word(errandSk(ERRAND))).toMatchObject({ says: 'at_door' });
    expect(error.mock.calls.flat().join(' ')).toContain('visit_said_publish_failed');
  });
});

describe('every refusal is the same answer', () => {
  const OVER = { status: 200, body: { state: 'over' } };
  const cases: [string, () => ReturnType<typeof edge>, unknown?][] = [
    ['a token that is not one', () => edge(), 'not-a-token'],
    ['a token in capitals', () => edge(), TOKEN.toUpperCase()],
    ['no token at all', () => edge(), null],
    ['a token nobody holds', () => edge(), 'f'.repeat(32)],
    ['a pass whose visit is gone', () => edge(seed({ errand: null }))],
    ['a visit called off', () => edge(seed({ errand: { status: { S: 'cancelled' } } }))],
    ['a visit that failed', () => edge(seed({ errand: { status: { S: 'failed' } } }))],
    ['a visit nobody came to', () => edge(seed({ errand: { status: { S: 'no_show' } } }))],
    ['a pass made again since', () => edge(seed({ errand: { passHash: { S: 'e'.repeat(64) } } }))],
    ['a visit with no pass of its own', () => edge(seed({ errand: { passHash: { NULL: true } } }))],
    ['a member she no longer allows', () => edge(seed({ member: 'removed' }))],
    ['a member who has left the circle', () => edge(seed({ member: null }))],
    ['a visit whose hours are over', () => edge(seed(), { now: VISIT_AT + 60 * MINUTE + 1 })],
  ];

  for (const [why, make, token = TOKEN] of cases) {
    it(`${why}: { state: 'over' }, and nothing written or told`, async () => {
      const e = make();
      expect(await e.status(token)).toMatchObject(OVER);
      expect(await e.say('at_door', token)).toMatchObject(OVER);
      expect(e.writes).toEqual([]);
      expect(e.published).toEqual([]);
    });
  }

  it('a body that is not JSON, or not an object', async () => {
    const e = edge();
    expect(await e.call('status', '{not json', true)).toMatchObject(OVER);
    expect(await e.call('status', '"a string"', true)).toMatchObject(OVER);
    expect(await e.call('status', undefined, true)).toMatchObject(OVER);
  });

  it('a visit called off between the read and the write is not written to', async () => {
    const e = edge();
    const cancel = e.send;
    // Called off just as the visitor pressed: the pass's read saw it open, the write finds it cancelled.
    const racing = createHandler({
      send: async (command: GetItemCommand | UpdateItemCommand | QueryCommand) => {
        if (command instanceof UpdateItemCommand && command.input.UpdateExpression === 'ADD presses :one') e.items.get(`HH#hh-1|${errandSk(ERRAND)}`)!.status = { S: 'cancelled' };
        return cancel(command);
      },
      putEvents: async () => ({}),
      table: 'wick',
      busName: 'wick-bus',
      now: () => VISIT_AT,
    });
    const res = await racing({ routeKey: 'POST /visit/say', body: JSON.stringify({ token: TOKEN, says: 'on_way' }) });
    expect(JSON.parse(res.body)).toEqual({ state: 'over' });
    expect(e.word(errandSk(ERRAND))).toBeUndefined();
    expect(e.word(`PER#${errandPersonId(ERRAND)}`)).toBeUndefined();
  });
});

describe('what is logged', () => {
  it('names the errand and what was said, and never the token or its hash', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => void lines.push(args.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...args) => void lines.push(args.map(String).join(' ')));
    const e = edge();
    await e.say('on_way');
    await e.status('f'.repeat(32));
    await edge(seed({ member: 'removed' })).say('at_door');
    await edge(seed({ presses: 30 })).say('late');

    const all = lines.join('\n');
    expect(all).toContain('visit_pass_said');
    expect(all).toContain(ERRAND);
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(HASH);
    expect(all).not.toContain('f'.repeat(32));
    expect(all).not.toMatch(/Rossi|Sarah/);
  });
});
