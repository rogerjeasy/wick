import { describe, expect, it } from 'vitest';
import { DeleteItemCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { createHandler } from '../pair-status.mjs';

type Item = Record<string, { S?: string; BOOL?: boolean }>;

/** The nonces, honouring the one condition the poll deletes under. */
function nonces(items: Record<string, Item>) {
  const send = async (command: DeleteItemCommand | GetItemCommand) => {
    const code = command.input.Key!.pk!.S!;
    if (command instanceof GetItemCommand) return { Item: items[code] };
    const item = items[code];
    if (!item || item.claimed?.BOOL !== true) throw Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });
    delete items[code];
    return { Attributes: item };
  };
  const handler = createHandler({ send, table: 'wick' });
  return async (code: string) => {
    const res = (await handler({ queryStringParameters: { code } })) as { statusCode: number; body: string };
    return { status: res.statusCode, body: res.statusCode === 200 ? (JSON.parse(res.body) as Record<string, unknown>) : res.body };
  };
}

const TOKEN = JSON.stringify({ jwt: 'j', deviceId: 'tv-1', householdId: 'hh_1', expiresAt: 1 });
const SERVERS = 'v'.repeat(64);

describe('GET /pair/status', () => {
  // INV-1: a secret the server made for a television without a generator goes with the token, once, to whoever polls that code.
  it('hands over the token and the secret made for the television together, exactly once', async () => {
    const poll = nonces({ 'PAIR#123456': { claimed: { BOOL: true }, deliveryToken: { S: TOKEN }, deliveryProof: { S: SERVERS } } });

    expect(await poll('123456')).toEqual({ status: 200, body: { status: 'bound', token: JSON.parse(TOKEN), proof: SERVERS } });
    expect(await poll('123456')).toEqual({ status: 404, body: 'unknown_or_expired_code' });
  });

  it('hands over no secret before the code is entered, none to another code, and none where none was made', async () => {
    const poll = nonces({
      'PAIR#111111': { claimed: { BOOL: false } },
      'PAIR#222222': { claimed: { BOOL: true }, deliveryToken: { S: TOKEN } },
      'PAIR#333333': { claimed: { BOOL: true }, deliveryToken: { S: TOKEN }, deliveryProof: { S: SERVERS } },
    });

    expect(await poll('111111')).toEqual({ status: 200, body: { status: 'pending' } });
    expect(await poll('222222')).toEqual({ status: 200, body: { status: 'bound', token: JSON.parse(TOKEN) } });
    expect(await poll('444444')).toEqual({ status: 404, body: 'unknown_or_expired_code' });
  });
});
