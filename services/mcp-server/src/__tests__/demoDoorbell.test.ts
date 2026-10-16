/**
 * POST /api/demo/doorbell over a real socket: somebody made to arrive at a
 * demo home's door (accounts/demoDoorbell.ts). Who may ring it, which home
 * it rings in (the token's, INV-8), how often, and what is handed to the
 * Door agent.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_DOOR_RINGS_PER_HOUR, DEMO_DOOR_COOLDOWN_MS, type DemoDoorEvent } from '../accounts/demoDoorbell.js';
import type { AppDeps } from '../server.js';
import {
  Browser,
  beginAuthorize,
  exchangeCode,
  linkInvited,
  linkNewOrganiser,
  registerClient,
  residentAllows,
  startServer,
  type Harness,
  type Tokens,
} from './harness.js';
import { createMemoryTable, type MemoryTable } from './memoryTable.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

interface World {
  readonly h: Harness;
  readonly table: MemoryTable;
  readonly rung: DemoDoorEvent[];
  clock: number;
}

async function server(overrides: Partial<AppDeps> = {}): Promise<World> {
  const table = createMemoryTable();
  const rung: DemoDoorEvent[] = [];
  // Starts at the real time and only moves forward from it: the OAuth bearer check and the
  // store's expiry read the wall clock, so a fixed date made every sign-in here expire
  // once that date was half an hour in the past.
  const world = { clock: Date.now() };
  const h = await startServer({
    demoAccounts: true,
    ddb: table.ddb,
    ringDemoDoor: async (event) => void rung.push(event),
    now: () => world.clock,
    ...overrides,
  });
  closers.push(h.close);
  return Object.assign(world, { h, table, rung });
}

/** One click on "Try the demo": a guest, organiser of a demo home of their own. */
async function guest(h: Harness): Promise<{ tokens: Tokens; householdId: string; userId: string }> {
  const browser = new Browser(h.base);
  const client = await registerClient(h.base);
  const tx = await beginAuthorize(browser, client, { demo: '1' });
  const res = await browser.get(`/account?tx=${tx}`);
  const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
  const tokens = (await (await exchangeCode(h.base, client, code)).json()) as Tokens;
  const me = (await (await fetch(`${h.base}/api/me`, { headers: { authorization: `Bearer ${tokens.access_token}` } })).json()) as {
    user: { userId: string };
    household: { householdId: string };
  };
  return { tokens, householdId: me.household.householdId, userId: me.user.userId };
}

/** A demo home whose virtual television is connected and whose resident has allowed the guest. */
async function demoHome(w: World) {
  const g = await guest(w.h);
  await residentAllows(w.h, g.householdId, g.userId);
  w.h.store.addTelevision(g.householdId, { deviceId: 'tv-virtual', pairedAt: 5, connected: true });
  return g;
}

const ring = (h: Harness, who: { tokens: Tokens }, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${h.base}/api/demo/doorbell`, {
    method: 'POST',
    headers: { authorization: `Bearer ${who.tokens.access_token}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const answer = async (res: Response) => ({ status: res.status, body: (await res.json()) as { error?: string; message?: string; rung?: boolean; say?: string; visitor?: string } });

describe('POST /api/demo/doorbell — the stand-in doorbell of a demo home', () => {
  it('rings it: the Door agent is handed the visitor, the token’s household, and when', async () => {
    const w = await server();
    const g = await demoHome(w);

    const res = await answer(await ring(w.h, g, { visitor: 'parcel' }));

    expect(res).toEqual({
      status: 200,
      body: { rung: true, visitor: 'parcel', say: 'Margaret’s television will show who is at the door. Answer it there.' },
    });
    expect(w.rung).toHaveLength(1);
    expect(w.rung[0]).toEqual({ householdId: g.householdId, visitor: 'parcel', ringId: expect.any(String) as string, occurredAt: w.clock, correlationId: expect.any(String) as string });
  });

  it('rings in the caller’s own demo home, whatever household the body names (INV-8)', async () => {
    const w = await server();
    const other = await demoHome(w);
    const g = await demoHome(w);

    expect((await ring(w.h, g, { visitor: 'carer', householdId: other.householdId })).status).toBe(200);

    expect(w.rung.map((e) => e.householdId)).toEqual([g.householdId]);
  });

  it('is refused in a home a person set up: its door is its own', async () => {
    const w = await server();
    const sarah = await linkNewOrganiser(w.h);
    await residentAllows(w.h, sarah.householdId, sarah.userId);
    w.h.store.addTelevision(sarah.householdId, { deviceId: 'tv-1', pairedAt: 5, connected: true });

    const res = await answer(await ring(w.h, sarah, { visitor: 'stranger' }));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_a_demo_home');
    expect(w.rung).toEqual([]);
  });

  it('is refused before the resident has allowed the guest (INV-9)', async () => {
    const w = await server();
    const g = await guest(w.h);
    w.h.store.addTelevision(g.householdId, { deviceId: 'tv-virtual', pairedAt: 5, connected: true });

    const res = await answer(await ring(w.h, g, { visitor: 'stranger' }));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_allowed_yet');
    expect(w.rung).toEqual([]);
  });

  it('is refused to a neighbour, even an allowed one', async () => {
    const w = await server();
    const g = await demoHome(w);
    const invite = (await (await fetch(`${w.h.base}/api/circle/invitations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${g.tokens.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'neighbour' }),
    })).json()) as { code: string };
    const june = await linkInvited(w.h, { name: 'June', email: 'june@example.com', password: 'a neighbourly passphrase' }, invite.code);
    await residentAllows(w.h, june.householdId, june.userId);

    const res = await answer(await ring(w.h, june, { visitor: 'stranger' }));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_for_a_neighbour');
    expect(w.rung).toEqual([]);
  });

  it('is refused for a visitor not on the list', async () => {
    const w = await server();
    const g = await demoHome(w);
    for (const visitor of ['burglar', '', 7, null, undefined, 'toString']) {
      const res = await answer(await ring(w.h, g, { visitor }));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('bad_visitor');
    }
    expect(w.rung).toEqual([]);
  });

  it('is refused when her television is not connected: there is nowhere for the door card to go', async () => {
    const w = await server();
    const g = await guest(w.h);
    await residentAllows(w.h, g.householdId, g.userId);

    const res = await answer(await ring(w.h, g, { visitor: 'parcel' }));

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('no_television');
  });

  it('rings once for a double click', async () => {
    const w = await server();
    const g = await demoHome(w);

    expect((await ring(w.h, g, { visitor: 'parcel' })).status).toBe(200);
    const second = await answer(await ring(w.h, g, { visitor: 'stranger' }));

    expect(second.status).toBe(429);
    expect(second.body.error).toBe('too_soon');
    expect(w.rung).toHaveLength(1);

    w.clock += DEMO_DOOR_COOLDOWN_MS;
    expect((await ring(w.h, g, { visitor: 'stranger' })).status).toBe(200);
    expect(w.rung).toHaveLength(2);
  });

  it('rings a few times an hour, and no more', async () => {
    const w = await server();
    const g = await demoHome(w);
    const start = w.clock;

    for (let i = 0; i < DEMO_DOOR_RINGS_PER_HOUR; i += 1) {
      w.clock = start + i * DEMO_DOOR_COOLDOWN_MS;
      expect((await ring(w.h, g, { visitor: 'parcel' })).status).toBe(200);
    }
    w.clock = start + DEMO_DOOR_RINGS_PER_HOUR * DEMO_DOOR_COOLDOWN_MS;
    const refused = await answer(await ring(w.h, g, { visitor: 'parcel' }));

    expect(refused.status).toBe(429);
    expect(refused.body.error).toBe('too_many');
    expect(w.rung).toHaveLength(DEMO_DOOR_RINGS_PER_HOUR);
  });

  it('rings once for one Idempotency-Key, however often it is sent (INV-6)', async () => {
    const w = await server();
    const g = await demoHome(w);
    const key = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

    const first = await answer(await ring(w.h, g, { visitor: 'carer' }, { 'idempotency-key': key }));
    w.clock += 2_000;
    const again = await answer(await ring(w.h, g, { visitor: 'carer' }, { 'idempotency-key': key }));

    expect(first.status).toBe(200);
    expect(again).toEqual(first);
    expect(w.rung).toHaveLength(1);
    expect(w.rung[0]!.ringId).toBe(key);
  });

  it('refuses a key that is not shaped like one, rather than ringing without it', async () => {
    const w = await server();
    const g = await demoHome(w);
    expect((await answer(await ring(w.h, g, { visitor: 'carer' }, { 'idempotency-key': 'no good' }))).body.error).toBe('bad_key');
    expect(w.rung).toEqual([]);
  });

  it('says so when this Wick has no stand-in doorbell to ring', async () => {
    const w = await server({ ringDemoDoor: undefined });
    const g = await demoHome(w);

    const res = await answer(await ring(w.h, g, { visitor: 'parcel' }));

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('doorbell_unavailable');
  });

  it('says it was not rung when the Door agent could not be reached, and lets the same key try again', async () => {
    let fail = true;
    const rung: DemoDoorEvent[] = [];
    const w = await server({ ringDemoDoor: async (event) => { if (fail) throw new Error('lambda down'); rung.push(event); } });
    const g = await demoHome(w);
    const key = 'f0e1d2c3b4a5968778695a4b3c2d1e0f';

    const failed = await answer(await ring(w.h, g, { visitor: 'parcel' }, { 'idempotency-key': key }));
    expect(failed.status).toBe(502);
    expect(failed.body.error).toBe('not_rung');

    fail = false;
    w.clock += DEMO_DOOR_COOLDOWN_MS;
    expect((await ring(w.h, g, { visitor: 'parcel' }, { 'idempotency-key': key })).status).toBe(200);
    expect(rung).toHaveLength(1);
  });

  it('asks for the sign-in like every other /api route', async () => {
    const w = await server();
    const res = await fetch(`${w.h.base}/api/demo/doorbell`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"visitor":"parcel"}' });
    expect(res.status).toBe(401);
  });
});
