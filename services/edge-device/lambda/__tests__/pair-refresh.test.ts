import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { createHandler } from '../pair-refresh.mjs';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { verifyJwt } from '../jwt.mjs';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { REFRESH_MAX_PER_WINDOW, REFRESH_WINDOW_MS, nextRefreshWindow } from '../pairing-code.mjs';

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

  // One launch is two refreshes where the disk keeps nothing (FL-013): the
  // app, then the card service it starts a second later. The limit used to
  // be one in 30 seconds, so the second was refused on every launch but the
  // first — and a refused refresh reads as "not paired" (seen on the Vega
  // simulator, 2026-10-11).
  describe('how often', () => {
    /** A table of one television, kept across calls, with a clock the test moves. */
    function television() {
      const row: Item = { deviceId: { S: 'tv-1' } };
      let now = NOW;
      const send = async (command: { input: { Key: Item; ExpressionAttributeValues?: Item } }) => {
        if (command instanceof GetItemCommand) {
          return { Item: command.input.Key.pk!.S === 'DEV#tv-1' ? { householdId: { S: 'hh_1' } } : { ...row } };
        }
        if (command instanceof UpdateItemCommand) {
          const v = command.input.ExpressionAttributeValues!;
          const unchanged = v[':wasAt'] ? row.refreshWindowAt?.N === v[':wasAt'].N && row.refreshCount?.N === v[':wasCount']!.N : row.refreshWindowAt === undefined;
          if (!unchanged) throw Object.assign(new Error('changed'), { name: 'ConditionalCheckFailedException' });
          row.refreshWindowAt = v[':at']!;
          row.refreshCount = v[':count']!;
        }
        return {};
      };
      const handler = createHandler({ send, privateKey: async () => privateKey, now: () => now, table: 'wick' });
      return {
        refresh: async () => (await handler(body({ deviceId: 'tv-1' }))).statusCode as number,
        later: (ms: number) => {
          now += ms;
        },
      };
    }

    it('lets the app and its card service both refresh when Wick is opened, and again when it is opened straight after', async () => {
      const tv = television();

      expect(await tv.refresh()).toBe(200);
      tv.later(1_000);
      expect(await tv.refresh()).toBe(200);
      tv.later(5_000);
      expect(await tv.refresh()).toBe(200);
      tv.later(1_000);
      expect(await tv.refresh()).toBe(200);
    });

    it('still refuses a television that keeps asking, until the window has passed', async () => {
      const tv = television();
      for (let i = 0; i < REFRESH_MAX_PER_WINDOW; i += 1) expect(await tv.refresh()).toBe(200);

      expect(await tv.refresh()).toBe(429);
      tv.later(REFRESH_WINDOW_MS - 1);
      expect(await tv.refresh()).toBe(429);
      tv.later(1);
      expect(await tv.refresh()).toBe(200);
    });

    it('counts from the first refresh of a window, not the latest', () => {
      const at = { N: String(NOW) };

      expect(nextRefreshWindow({}, NOW)).toEqual({ at: NOW, count: 1 });
      expect(nextRefreshWindow({ refreshWindowAt: at, refreshCount: { N: '1' } }, NOW + 29_000)).toEqual({ at: NOW, count: 2 });
      expect(nextRefreshWindow({ refreshWindowAt: at, refreshCount: { N: String(REFRESH_MAX_PER_WINDOW) } }, NOW + 29_000)).toBeNull();
      expect(nextRefreshWindow({ refreshWindowAt: at, refreshCount: { N: String(REFRESH_MAX_PER_WINDOW) } }, NOW + REFRESH_WINDOW_MS)).toEqual({ at: NOW + REFRESH_WINDOW_MS, count: 1 });
    });
  });
});
