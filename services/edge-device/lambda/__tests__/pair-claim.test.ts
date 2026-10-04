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
