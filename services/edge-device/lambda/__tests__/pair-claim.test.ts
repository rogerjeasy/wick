import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GetItemCommand, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { createHandler } from '../pair-claim.mjs';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { verifyJwt } from '../jwt.mjs';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { accessTokenKey } from '../wick-auth.mjs';

const NOW = 1_790_000_000_000;
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

type Command = GetItemCommand | PutItemCommand | UpdateItemCommand;
type Item = Record<string, { S?: string; N?: string; BOOL?: boolean }>;

const keyOf = (key: Item) => `${key.pk!.S}|${key.sk!.S}`;

/** A table with just enough behaviour for the handler: reads from `items`, records writes, fails chosen conditions. */
function table(items: Record<string, Item>, failing: string[] = []) {
  const writes: Command[] = [];
  const send = async (command: Command) => {
    if (command instanceof GetItemCommand) return { Item: items[keyOf(command.input.Key as Item)] };
    const target = command instanceof PutItemCommand ? keyOf(command.input.Item as Item) : keyOf(command.input.Key as Item);
    if (failing.includes(target)) throw Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });
    writes.push(command);
    return {};
  };
  return { send, writes };
}

const TOKEN = 'sarahs-access-token';
const tokenItem = (householdId = 'hh_1'): Item => ({
  data: { S: JSON.stringify({ userId: 'u_sarah', householdId }) },
  expiresAt: { N: String(NOW + 60_000) },
});
const member = (role: string, status: string): Item => ({ role: { S: role }, status: { S: status } });
const pairingCode: Item = { deviceId: { S: 'tv-1' }, claimed: { BOOL: false }, expiresAt: { N: String(NOW + 60_000) } };

function world(over: Record<string, Item | undefined> = {}, failing: string[] = []) {
  const items: Record<string, Item> = {
    [keyOf(accessTokenKey(TOKEN))]: tokenItem(),
    'HH#hh_1|MEM#u_sarah': member('organiser', 'pending'),
    'PAIR#123456|META': pairingCode,
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete items[k];
    else items[k] = v;
  }
  const t = table(items, failing);
  return { ...t, handler: createHandler({ send: t.send, privateKey: async () => privateKey, now: () => NOW, table: 'wick' }) };
}

const event = (body: unknown, token: string | null = TOKEN) => ({
  headers: token ? { authorization: `Bearer ${token}` } : {},
  body: JSON.stringify(body),
});

describe('POST /pair/claim', () => {
  it('refuses anyone who is not signed in, and writes nothing', async () => {
    const { handler, writes } = world();

    const res = await handler(event({ code: '123456' }, null));

    expect(res.statusCode).toBe(401);
    expect(writes).toEqual([]);
  });

  it('refuses a token it does not know, or one that has expired', async () => {
    const unknown = world();
    expect((await unknown.handler(event({ code: '123456' }, 'made-up'))).statusCode).toBe(401);

    const expired = world({ [keyOf(accessTokenKey(TOKEN))]: { ...tokenItem(), expiresAt: { N: String(NOW - 1) } } });
    expect((await expired.handler(event({ code: '123456' }))).statusCode).toBe(401);
    expect(expired.writes).toEqual([]);
  });

  it('refuses a family member: connecting the television is the organiser’s to do', async () => {
    const { handler, writes } = world({ 'HH#hh_1|MEM#u_sarah': member('family', 'allowed') });

    const res = await handler(event({ code: '123456' }));

    expect(res.statusCode).toBe(403);
    expect(writes).toEqual([]);
  });

  it('connects the television to the household the token is for', async () => {
    const { handler, writes } = world();

    const res = await handler(event({ code: '123456' }));

    expect(res.statusCode).toBe(200);
    const binding = writes.find((w) => w instanceof UpdateItemCommand && keyOf(w.input.Key as Item) === 'HH#hh_1|DEV#tv-1');
    expect(binding).toBeDefined();
    const claim = writes.find((w) => w instanceof UpdateItemCommand && keyOf(w.input.Key as Item) === 'PAIR#123456|META') as UpdateItemCommand;
    const delivered = JSON.parse(claim.input.ExpressionAttributeValues![':tok']!.S!) as { jwt: string; householdId: string; deviceId: string };
    expect(delivered).toMatchObject({ householdId: 'hh_1', deviceId: 'tv-1' });
    expect(verifyJwt(delivered.jwt, publicKey)).toMatchObject({ householdId: 'hh_1', deviceId: 'tv-1' });
  });

  it('INV-8: ignores a household named in the request — it used to be taken from the body', async () => {
    const { handler, writes } = world();

    await handler(event({ code: '123456', householdId: 'somebody-elses-home' }));

    expect(JSON.stringify(writes.map((w) => w.input))).not.toContain('somebody-elses-home');
  });

  it('will not take over a television that belongs to another home', async () => {
    const { handler, writes } = world({}, ['DEV#tv-1|META']);

    const res = await handler(event({ code: '123456' }));

    expect(res.statusCode).toBe(409);
    expect(res.body).toBe('television_in_another_home');
    expect(writes).toEqual([]);
  });

  it('says so when the code is unknown, expired or already used', async () => {
    expect((await world({ 'PAIR#123456|META': undefined }).handler(event({ code: '123456' }))).statusCode).toBe(404);
    expect((await world({ 'PAIR#123456|META': { ...pairingCode, expiresAt: { N: String(NOW - 1) } } }).handler(event({ code: '123456' }))).statusCode).toBe(410);
    expect((await world({ 'PAIR#123456|META': { ...pairingCode, claimed: { BOOL: true } } }).handler(event({ code: '123456' }))).statusCode).toBe(409);
  });
});

describe('POST /pair/claim as a family television — "this one is mine"', () => {
  const asFamily = (over: Record<string, Item | undefined> = {}, failing: string[] = []) =>
    world({ 'HH#hh_1|MEM#u_sarah': member('family', 'allowed'), ...over }, failing);
  const writeTo = (writes: Command[], key: string) =>
    writes.find((w) => keyOf(((w.input as { Item?: Item }).Item ?? (w.input as { Key?: Item }).Key) as Item) === key);

  it('connects it as the television of the member who is signed in — not as the resident’s', async () => {
    const { handler, writes } = asFamily();

    const res = await handler(event({ code: '123456', as: 'family' }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, deviceId: 'tv-1', kind: 'family' });
    // Never a DEV# row: that is what every card for the resident, and every press that counts as hers, is keyed on.
    expect(writeTo(writes, 'HH#hh_1|DEV#tv-1')).toBeUndefined();
    const row = writeTo(writes, 'HH#hh_1|FTV#tv-1') as UpdateItemCommand;
    expect(row.input.ExpressionAttributeValues).toMatchObject({ ':did': { S: 'tv-1' }, ':hhid': { S: 'hh_1' }, ':by': { S: 'u_sarah' } });
  });

  it('gives it a token that says whose it is, and that it is a family television', async () => {
    const { handler, writes } = asFamily();
    await handler(event({ code: '123456', as: 'family' }));

    const claim = writeTo(writes, 'PAIR#123456|META') as UpdateItemCommand;
    const delivered = JSON.parse(claim.input.ExpressionAttributeValues![':tok']!.S!) as { jwt: string; kind: string; householdId: string };
    expect(delivered).toMatchObject({ kind: 'family', householdId: 'hh_1', deviceId: 'tv-1' });
    expect(verifyJwt(delivered.jwt, publicKey)).toMatchObject({ deviceId: 'tv-1', householdId: 'hh_1', kind: 'family', userId: 'u_sarah' });
  });

  it('is for someone the resident has allowed: not for a person still waiting, turned down or removed', async () => {
    for (const status of ['pending', 'declined', 'removed']) {
      const { handler, writes } = asFamily({ 'HH#hh_1|MEM#u_sarah': member('family', status) });
      const res = await handler(event({ code: '123456', as: 'family' }));
      expect(res.statusCode).toBe(403);
      expect(res.body).toBe('not_allowed_yet');
      expect(writes).toEqual([]);
    }
  });

  it('is not for a neighbour: a neighbour is asked things, and has no television of the house', async () => {
    const { handler, writes } = asFamily({ 'HH#hh_1|MEM#u_sarah': member('neighbour', 'allowed') });
    expect((await handler(event({ code: '123456', as: 'family' }))).statusCode).toBe(403);
    expect(writes).toEqual([]);
  });

  it('lets the organiser connect a television of their own too, once allowed', async () => {
    const { handler } = asFamily({ 'HH#hh_1|MEM#u_sarah': member('organiser', 'allowed') });
    expect((await handler(event({ code: '123456', as: 'family' }))).statusCode).toBe(200);
  });

  it('still belongs to one home only', async () => {
    const { handler, writes } = asFamily({}, ['DEV#tv-1|META']);
    const res = await handler(event({ code: '123456', as: 'family' }));
    expect(res.statusCode).toBe(409);
    expect(writeTo(writes, 'HH#hh_1|FTV#tv-1')).toBeUndefined();
  });

  it('publishes the key a family television’s token is checked with, so the Wick server can check it', async () => {
    const world_ = asFamily();
    const handler = createHandler({ send: world_.send, privateKey: async () => privateKey, publicKey: async () => publicKey, now: () => NOW, table: 'wick' });
    await handler(event({ code: '123456', as: 'family' }));
    const published = writeTo(world_.writes, 'CONFIG#pairing|PUBLIC_KEY') as PutItemCommand;
    expect(published.input.Item).toMatchObject({ publicKeyPem: { S: publicKey } });
  });

  it('refuses a kind it has not heard of, and leaves the resident’s way exactly as it was', async () => {
    const odd = asFamily();
    expect((await odd.handler(event({ code: '123456', as: 'admin' }))).statusCode).toBe(400);
    expect(odd.writes).toEqual([]);

    // No `as`: the resident's television, the organiser's to connect, a DEV# row, and no kind in the token.
    const { handler, writes } = world();
    expect(JSON.parse((await handler(event({ code: '123456' }))).body)).toEqual({ ok: true, deviceId: 'tv-1' });
    expect(writeTo(writes, 'HH#hh_1|DEV#tv-1')).toBeDefined();
    const delivered = JSON.parse((writeTo(writes, 'PAIR#123456|META') as UpdateItemCommand).input.ExpressionAttributeValues![':tok']!.S!) as { jwt: string; kind?: string };
    expect(delivered.kind).toBeUndefined();
    expect(verifyJwt(delivered.jwt, publicKey).kind).toBeUndefined();
  });
});

describe('POST /pair/claim — one television, one kind', () => {
  it('will not make the resident’s television somebody’s own as well', async () => {
    const { handler, writes } = world({ 'HH#hh_1|MEM#u_sarah': member('organiser', 'allowed'), 'HH#hh_1|DEV#tv-1': { deviceId: { S: 'tv-1' } } });
    const res = await handler(event({ code: '123456', as: 'family' }));
    expect(res.statusCode).toBe(409);
    expect(res.body).toBe('already_the_residents_television');
    expect(writes).toEqual([]);
  });

  it('will not make somebody’s own television the resident’s as well', async () => {
    const { handler, writes } = world({ 'HH#hh_1|FTV#tv-1': { deviceId: { S: 'tv-1' }, userId: { S: 'u_dan' } } });
    const res = await handler(event({ code: '123456' }));
    expect(res.statusCode).toBe(409);
    expect(res.body).toBe('already_a_family_television');
    expect(writes).toEqual([]);
  });
});

