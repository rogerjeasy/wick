import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GetItemCommand } from '@aws-sdk/client-dynamodb';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { createHandler } from '../pair-refresh.mjs';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { verifyJwt } from '../jwt.mjs';

const NOW = 1_790_000_000_000;
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

type Item = Record<string, { S?: string; N?: string; BOOL?: boolean }>;

function world(items: Record<string, Item>) {
  const send = async (command: { input: { Key: Item } }) => {
    if (command instanceof GetItemCommand) return { Item: items[`${command.input.Key.pk!.S}|${command.input.Key.sk!.S}`] };
    return {};
  };
  return createHandler({ send, privateKey: async () => privateKey, now: () => NOW, table: 'wick' });
}

const body = (o: unknown) => ({ body: JSON.stringify(o) });

describe('POST /pair/refresh', () => {
  it('mints a token for the household the television belongs to, from the device id alone', async () => {
    const handler = world({
      'DEV#tv-1|META': { householdId: { S: 'hh_1' } },
      'HH#hh_1|DEV#tv-1': { deviceId: { S: 'tv-1' } },
    });

    const res = await handler(body({ deviceId: 'tv-1' }));

    expect(res.statusCode).toBe(200);
    const { token } = JSON.parse(res.body) as { token: { jwt: string; householdId: string } };
    expect(token.householdId).toBe('hh_1');
    expect(verifyJwt(token.jwt, publicKey)).toMatchObject({ deviceId: 'tv-1', householdId: 'hh_1' });
  });

  it('INV-8: ignores a household named in the request — a television cannot ask its way into another home', async () => {
    const handler = world({
      'DEV#tv-1|META': { householdId: { S: 'hh_1' } },
      'HH#hh_1|DEV#tv-1': { deviceId: { S: 'tv-1' } },
      'HH#hh_2|DEV#tv-1': { deviceId: { S: 'tv-1' } },
    });

    const res = await handler(body({ deviceId: 'tv-1', householdId: 'hh_2' }));

    const { token } = JSON.parse(res.body) as { token: { householdId: string } };
    expect(token.householdId).toBe('hh_1');
  });

  it('says a television nobody has connected is not paired', async () => {
    expect((await world({})(body({ deviceId: 'tv-9' }))).statusCode).toBe(404);
  });

  it('refuses a television that was disconnected', async () => {
    const handler = world({
      'DEV#tv-1|META': { householdId: { S: 'hh_1' } },
      'HH#hh_1|DEV#tv-1': { deviceId: { S: 'tv-1' }, denylisted: { BOOL: true } },
    });

    expect((await handler(body({ deviceId: 'tv-1' }))).statusCode).toBe(403);
  });
});
