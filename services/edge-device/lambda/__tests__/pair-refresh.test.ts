import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { createHandler } from '../pair-refresh.mjs';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { signJwt, verifyJwt } from '../jwt.mjs';
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

describe('POST /pair/refresh for a family television', () => {
  const family = { 'DEV#tv-2|META': { householdId: { S: 'hh_1' } }, 'HH#hh_1|FTV#tv-2': { deviceId: { S: 'tv-2' }, userId: { S: 'u_sarah' } } };
  const worldWithKey = (items: Record<string, Item>) => {
    const send = async (command: { input: { Key: Item } }) => {
      if (command instanceof GetItemCommand) return { Item: items[`${command.input.Key.pk!.S}|${command.input.Key.sk!.S}`] };
      return {};
    };
    return createHandler({ send, privateKey: async () => privateKey, publicKey: async () => publicKey, now: () => NOW, table: 'wick' });
  };
  const held = (claims: object, expiresInSec = -3600) => signJwt(claims, privateKey, { expiresInSec });
  const sarahs = { deviceId: 'tv-2', householdId: 'hh_1', kind: 'family', userId: 'u_sarah' };
  const withToken = (o: unknown, jwt?: string) => ({ body: JSON.stringify(o), headers: jwt ? { authorization: `Bearer ${jwt}` } : {} });

  it('mints its token again when it shows the one it held — even one that has run out', async () => {
    const res = await worldWithKey(family)(withToken({ deviceId: 'tv-2' }, held(sarahs)));

    expect(res.statusCode).toBe(200);
    const { token } = JSON.parse(res.body) as { token: { jwt: string; kind?: string; householdId: string } };
    expect(token).toMatchObject({ kind: 'family', householdId: 'hh_1' });
    expect(verifyJwt(token.jwt, publicKey)).toMatchObject(sarahs);
  });

  it('never from the device id alone: a family television sees one person’s view of a home, and an id can be guessed', async () => {
    const res = await worldWithKey(family)(withToken({ deviceId: 'tv-2' }));
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe('token_required');
  });

  it('refuses a token that is not this television’s, not this member’s, not a family one, or not Wick’s', async () => {
    const stranger = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const wrong = [
      held({ ...sarahs, deviceId: 'tv-3' }),
      held({ ...sarahs, householdId: 'hh_2' }),
      held({ ...sarahs, userId: 'u_dan' }),
      held({ deviceId: 'tv-2', householdId: 'hh_1' }),
      signJwt(sarahs, stranger.privateKey, { expiresInSec: 600 }),
      'not.a.token',
    ];
    for (const jwt of wrong) {
      expect((await worldWithKey(family)(withToken({ deviceId: 'tv-2' }, jwt))).statusCode).toBe(401);
    }
  });

  it('never makes the resident’s television a family one, and asks the resident’s for nothing new', async () => {
    const res = await worldWithKey({ 'DEV#tv-1|META': { householdId: { S: 'hh_1' } }, 'HH#hh_1|DEV#tv-1': { deviceId: { S: 'tv-1' } } })(withToken({ deviceId: 'tv-1', kind: 'family' }));
    expect(res.statusCode).toBe(200);
    const { token } = JSON.parse(res.body) as { token: { jwt: string; kind?: string } };
    expect(token.kind).toBeUndefined();
    expect(verifyJwt(token.jwt, publicKey).kind).toBeUndefined();
  });

  it('refuses one that has been revoked, or whose row does not say whose it is', async () => {
    const revoked = { ...family, 'HH#hh_1|FTV#tv-2': { deviceId: { S: 'tv-2' }, userId: { S: 'u_sarah' }, denylisted: { BOOL: true } } };
    expect((await worldWithKey(revoked)(withToken({ deviceId: 'tv-2' }, held(sarahs)))).statusCode).toBe(403);
    const nobody = { ...family, 'HH#hh_1|FTV#tv-2': { deviceId: { S: 'tv-2' } } };
    expect((await worldWithKey(nobody)(withToken({ deviceId: 'tv-2' }, held(sarahs)))).statusCode).toBe(404);
  });
});

// What waits, said while Wick is off the screen (Vega only). The app cannot
// hand its token to its background service on the television — nothing is
// shared between the two (FRICTION.md FL-013, and the spike of 2026-10-13) —
// so it opens a short way for the service here, with its own proof.
describe('POST /pair/refresh for a family television’s background service', () => {
  const sarahs = { deviceId: 'tv-2', householdId: 'hh_1', kind: 'family', userId: 'u_sarah' };
  const fullToken = (expiresInSec = 3600) => signJwt(sarahs, privateKey, { expiresInSec });
  /** Where the television is: its app and its service are one device, and ask from one address. */
  const HOME_ADDRESS = '203.0.113.7';
  const ELSEWHERE = '198.51.100.23';

  /** A table of one family television, kept across calls, that honours the conditions it is written under. */
  function familyTelevision(row: Item = { deviceId: { S: 'tv-2' }, userId: { S: 'u_sarah' } }, signingKey: string = privateKey) {
    let now = NOW;
    /** Run once, between a request's read of the row and its write: what another request did meanwhile. */
    let meanwhile: (() => void) | undefined;
    const send = async (command: { input: { Key: Item; UpdateExpression?: string; ConditionExpression?: string; ExpressionAttributeValues?: Item } }) => {
      const key = `${command.input.Key.pk!.S}|${command.input.Key.sk!.S}`;
      if (command instanceof GetItemCommand) {
        if (key === 'DEV#tv-2|META') return { Item: { householdId: { S: 'hh_1' } } };
        return { Item: key === 'HH#hh_1|FTV#tv-2' ? { ...row } : undefined };
      }
      if (command instanceof UpdateItemCommand) {
        expect(key).toBe('HH#hh_1|FTV#tv-2');
        const other = meanwhile;
        meanwhile = undefined;
        other?.();
        const values = command.input.ExpressionAttributeValues ?? {};
        const same = (a: Item[string] | undefined, b: Item[string] | undefined) => JSON.stringify(a) === JSON.stringify(b);
        for (const clause of (command.input.ConditionExpression ?? '').split(' AND ').filter(Boolean)) {
          const missing = /^attribute_not_exists\((\w+)\)$/.exec(clause);
          const present = /^attribute_exists\((\w+)\)$/.exec(clause);
          const equal = /^(\w+) = (:\w+)$/.exec(clause);
          const greater = /^(\w+) > (:\w+)$/.exec(clause);
          // As DynamoDB: a comparison with an attribute that is not there does not hold.
          const holds = missing
            ? row[missing[1]!] === undefined
            : present
              ? present[1] === 'pk' || row[present[1]!] !== undefined
              : equal
                ? same(row[equal[1]!], values[equal[2]!])
                : greater
                  ? row[greater[1]!]?.N !== undefined && Number(row[greater[1]!]!.N) > Number(values[greater[2]!]!.N)
                  : false;
          if (!holds) throw Object.assign(new Error(`condition failed: ${clause}`), { name: 'ConditionalCheckFailedException' });
        }
        const [, sets = '', removes = ''] = /^SET (.*?)(?: REMOVE (.*))?$/.exec(command.input.UpdateExpression ?? '') ?? [];
        for (const set of sets.split(', ').filter(Boolean)) {
          const [name, value] = set.split(' = ');
          row[name!] = values[value!]!;
        }
        for (const name of removes.split(', ').filter(Boolean)) delete row[name];
      }
      return {};
    };
    const handler = createHandler({ send, privateKey: async () => signingKey, publicKey: async () => publicKey, now: () => now, table: 'wick' });
    const ask = async (o: object, jwt?: string, from: string | null = HOME_ADDRESS) => {
      const res = (await handler({
        body: JSON.stringify({ deviceId: 'tv-2', ...o }),
        headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
        // What the HTTP API gives the Lambda (payload format 2.0, infra/pairing.tf).
        ...(from ? { requestContext: { http: { sourceIp: from } } } : {}),
      })) as { statusCode: number; body: string };
      const token = res.statusCode === 200 ? (JSON.parse(res.body) as { token: { jwt: string; kind?: string; scope?: string; expiresAt: number } }).token : undefined;
      return { status: res.statusCode, body: res.body, token, claims: token ? (verifyJwt(token.jwt, publicKey) as Record<string, unknown>) : undefined };
    };
    return {
      row,
      /** The app, showing the token it holds. */
      app: (o: object = {}, jwt = fullToken(), from: string | null = HOME_ADDRESS) => ask(o, jwt, from),
      /** Anybody who knows the device id: the service — from the television's own address — or a stranger from theirs. */
      proofless: (o: object = { forService: true }, from: string | null = HOME_ADDRESS) => ask(o, undefined, from),
      ask,
      later: (ms: number) => {
        now += ms;
      },
      meanwhile: (what: () => void) => {
        meanwhile = what;
      },
    };
  }

  it('answers one of two asks that arrive together: the way is used up in the write, not in the read', async () => {
    const tv = familyTelevision();
    await tv.app({ forService: true });

    // Another ask took the way after this one read the row and before it wrote.
    tv.meanwhile(() => {
      delete tv.row.serviceUntil;
      delete tv.row.serviceFrom;
    });
    const loser = await tv.proofless();

    expect(loser.status).toBe(401);
    expect(loser.body).toBe('token_required');
  });

  // Hardening, after a security review of the mint without proof: the way
  // is bound to the address it was opened from.
  describe('only from where it was opened', () => {
    it('answers the television’s own address and no other — and a stranger’s ask does not spend the way', async () => {
      const tv = familyTelevision();
      await tv.app({ forService: true });

      const stranger = await tv.proofless({ forService: true }, ELSEWHERE);
      expect(stranger.status).toBe(401);
      expect(stranger.body).toBe('token_required');

      expect((await tv.proofless()).token).toMatchObject({ scope: 'waiting' });
    });

    it('keeps a fingerprint of the address beside the stamp, never the address', async () => {
      const tv = familyTelevision();
      await tv.app({ forService: true });

      expect(tv.row.serviceFrom?.S).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(tv.row)).not.toContain(HOME_ADDRESS);
    });

    // A plain hash of an address is the address to anyone who can read the
    // row and try four billion of them. The fingerprint is keyed with a
    // secret only this Lambda has.
    it('keys the fingerprint: it is no plain hash of the address, with the television’s id or without', async () => {
      const tv = familyTelevision();
      await tv.app({ forService: true });
      const sha = (text: string) => createHash('sha256').update(text).digest('hex');

      const stored = tv.row.serviceFrom!.S!;
      for (const guess of [HOME_ADDRESS, `tv-2\n${HOME_ADDRESS}`, `${HOME_ADDRESS}\ntv-2`, `tv-2${HOME_ADDRESS}`, `tv-2|${HOME_ADDRESS}`]) {
        expect(stored).not.toBe(sha(guess));
      }
    });

    it('is the same fingerprint for the same address each time, so the television’s own service still matches', async () => {
      const tv = familyTelevision();
      await tv.app({ forService: true });
      const first = tv.row.serviceFrom!.S!;
      expect((await tv.proofless()).status).toBe(200);

      tv.later(40_000);
      await tv.app({ forService: true });
      expect(tv.row.serviceFrom!.S).toBe(first);
      expect((await tv.proofless()).status).toBe(200);
    });

    it('cannot be worked out without the Lambda’s secret: under another key the same address is another fingerprint, and matches nothing', async () => {
      const other = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
      const tv = familyTelevision();
      await tv.app({ forService: true });
      const stored = tv.row.serviceFrom!.S!;

      // The same table row, read by a Lambda with a different secret, from the very same address.
      const elsewhere = familyTelevision(tv.row, other.privateKey);
      expect((await elsewhere.proofless()).status).toBe(401);
      expect(tv.row.serviceFrom!.S).toBe(stored);
    });

    it('writes nothing of the secret to the row', async () => {
      const tv = familyTelevision();
      await tv.app({ forService: true });

      const written = JSON.stringify(tv.row);
      const keyBody = privateKey.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
      expect(written).not.toContain(keyBody.slice(0, 40));
      expect(Object.keys(tv.row).sort()).toEqual(['deviceId', 'refreshCount', 'refreshWindowAt', 'serviceFrom', 'serviceUntil', 'userId']);
    });

    it('is checked in the write that uses the way up, so it cannot be raced round', async () => {
      const tv = familyTelevision();
      await tv.app({ forService: true });

      // Between this ask's read and its write, the app opened the way again — from somewhere else.
      tv.meanwhile(() => {
        tv.row.serviceFrom = { S: 'f'.repeat(64) };
      });
      expect((await tv.proofless()).status).toBe(401);
    });

    it('checks in that same write that the way has not closed', async () => {
      const tv = familyTelevision();
      await tv.app({ forService: true });

      // What the row says by the time of the write is what counts, not what was read.
      tv.meanwhile(() => {
        tv.row.serviceUntil = { N: String(NOW - 1) };
      });
      expect((await tv.proofless()).status).toBe(401);
    });

    it('never opens a way for a request that comes from nowhere — though the app still gets its own token', async () => {
      const tv = familyTelevision();

      const opened = await tv.app({ forService: true }, fullToken(), null);
      expect(opened.status).toBe(200);
      expect(opened.token).not.toHaveProperty('scope');
      expect(tv.row).not.toHaveProperty('serviceUntil');
      expect(tv.row).not.toHaveProperty('serviceFrom');
    });

    it('never answers a request that comes from nowhere, inside a way or not', async () => {
      const tv = familyTelevision();
      await tv.app({ forService: true });

      expect((await tv.proofless({ forService: true }, null)).status).toBe(401);
      // A way stamped without an address (a row from before this rule) answers nobody either.
      delete tv.row.serviceFrom;
      expect((await tv.proofless()).status).toBe(401);
    });

    it('takes the address away with the stamp when the way is used', async () => {
      const tv = familyTelevision();
      await tv.app({ forService: true });
      await tv.proofless();

      expect(tv.row).not.toHaveProperty('serviceUntil');
      expect(tv.row).not.toHaveProperty('serviceFrom');
    });
  });

  // And the narrow token is the one token here that cannot be brought back once it has run out.
  describe('a narrow token that has run out', () => {
    const scoped = (expiresInSec: number) => signJwt({ ...sarahs, scope: 'waiting', since: NOW }, privateKey, { expiresInSec });

    it('is refused: it is renewed while it is still good, or not at all', async () => {
      // A television whose service was let in at NOW.
      const tv = familyTelevision({ deviceId: { S: 'tv-2' }, userId: { S: 'u_sarah' }, serviceSince: { N: String(NOW) } });

      const lapsed = await tv.ask({}, scoped(-60));
      expect(lapsed.status).toBe(401);
      expect(lapsed.body).toBe('token_expired');

      expect((await tv.ask({}, scoped(600))).token).toMatchObject({ scope: 'waiting' });
    });

    it('leaves the television’s own token as it was: one that has run out is still its proof', async () => {
      const tv = familyTelevision();

      const res = await tv.app({}, fullToken(-3600));
      expect(res.status).toBe(200);
      expect(res.token).not.toHaveProperty('scope');
    });
  });

  it('mints the service a token of one scope, once, after the app has opened the way with its own token', async () => {
    const tv = familyTelevision();

    const opened = await tv.app({ forService: true });
    expect(opened.status).toBe(200);
    // The app's own refresh is what it always was: its full token, with no scope.
    expect(opened.token).toMatchObject({ kind: 'family' });
    expect(opened.token).not.toHaveProperty('scope');
    expect(opened.claims).not.toHaveProperty('scope');

    tv.later(1_000);
    const service = await tv.proofless();
    expect(service.status).toBe(200);
    expect(service.token).toMatchObject({ kind: 'family', scope: 'waiting' });
    // The household and the member are the row's (INV-8), and the token says how little it is for.
    expect(service.claims).toMatchObject({ ...sarahs, scope: 'waiting' });
    expect(service.token!.expiresAt).toBe(NOW + 1_000 + 3600 * 1000);
  });

  it('is single use: a second ask without a token is refused as it always was', async () => {
    const tv = familyTelevision();
    await tv.app({ forService: true });

    expect((await tv.proofless()).status).toBe(200);
    const second = await tv.proofless();
    expect(second.status).toBe(401);
    expect(second.body).toBe('token_required');
    expect(tv.row).not.toHaveProperty('serviceUntil');
  });

  it('gives nothing without a token when the app has not opened the way — whatever the request says', async () => {
    const tv = familyTelevision();

    expect((await tv.proofless()).body).toBe('token_required');
    expect((await tv.proofless({})).body).toBe('token_required');
  });

  it('is not opened by an ordinary refresh: the app has to ask for it', async () => {
    const tv = familyTelevision();
    expect((await tv.app()).status).toBe(200);

    expect(tv.row).not.toHaveProperty('serviceUntil');
    expect((await tv.proofless()).status).toBe(401);
  });

  it('stays shut to a plain refresh without a token even while the way is open: only the service’s own ask takes it', async () => {
    const tv = familyTelevision();
    await tv.app({ forService: true });

    // The app itself, relaunched on a television that keeps nothing, asks like this — and must not be handed the narrow token.
    const plain = await tv.proofless({});
    expect(plain.status).toBe(401);
    expect(plain.body).toBe('token_required');
    // And the way is still there for the service.
    expect((await tv.proofless()).status).toBe(200);
  });

  it('closes by itself after ninety seconds', async () => {
    const tv = familyTelevision();
    await tv.app({ forService: true });

    tv.later(90_000);
    expect((await tv.proofless()).status).toBe(401);
  });

  // The narrow token is the least trusted token there is, and it must not
  // be able to keep the television's own app from refreshing. So the two
  // are counted apart: the service's mint and every renewal of a narrow
  // token in one place on the row, the app's refreshes in another.
  describe('counted apart from the app', () => {
    const narrow = async (tv: ReturnType<typeof familyTelevision>) => {
      await tv.app({ forService: true });
      return (await tv.proofless()).token!.jwt;
    };

    it('a narrow token asked for over and over, until it is refused, leaves the app’s very next refresh answered', async () => {
      const tv = familyTelevision();
      let scoped = await narrow(tv);

      // The mint was the first of its share; these are the rest, and then one too many.
      for (let i = 1; i < REFRESH_MAX_PER_WINDOW; i += 1) {
        const again = await tv.ask({}, scoped);
        expect(again.status).toBe(200);
        scoped = again.token!.jwt;
      }
      expect((await tv.ask({}, scoped)).status).toBe(429);
      expect((await tv.ask({}, scoped)).status).toBe(429);

      const app = await tv.app();
      expect(app.status).toBe(200);
      expect(app.token).not.toHaveProperty('scope');
    });

    it('the app at its own limit does not stop its service’s first ask', async () => {
      const tv = familyTelevision();
      // A busy half minute: the app as often as it may, the last of them opening the way.
      for (let i = 1; i < REFRESH_MAX_PER_WINDOW; i += 1) expect((await tv.app()).status).toBe(200);
      expect((await tv.app({ forService: true })).status).toBe(200);
      expect((await tv.app()).status).toBe(429);

      // No wait is needed: the service is counted on its own.
      expect((await tv.proofless()).token).toMatchObject({ scope: 'waiting' });
    });

    it('counts the service’s mint and a narrow token’s renewals in their own place on the row, and the app’s in its own', async () => {
      const tv = familyTelevision();
      const scoped = await narrow(tv);
      expect(tv.row.refreshCount).toEqual({ N: '1' });
      expect(tv.row.serviceRefreshCount).toEqual({ N: '1' });

      await tv.ask({}, scoped);
      expect(tv.row.refreshCount).toEqual({ N: '1' });
      expect(tv.row.serviceRefreshCount).toEqual({ N: '2' });

      await tv.app();
      await tv.app({ forService: true });
      expect(tv.row.refreshCount).toEqual({ N: '3' });
      expect(tv.row.serviceRefreshCount).toEqual({ N: '2' });
    });

    it('still holds a narrow token to the same share, and gives it a new one when its own half minute has passed', async () => {
      const tv = familyTelevision();
      const scoped = await narrow(tv);
      for (let i = 1; i < REFRESH_MAX_PER_WINDOW; i += 1) await tv.ask({}, scoped);

      expect((await tv.ask({}, scoped)).status).toBe(429);
      tv.later(REFRESH_WINDOW_MS);
      expect((await tv.ask({}, scoped)).status).toBe(200);
    });

    it('a way stays open past a service turned away for asking too often, and is not spent by the refusal', async () => {
      const tv = familyTelevision();
      const scoped = await narrow(tv);
      for (let i = 1; i < REFRESH_MAX_PER_WINDOW; i += 1) await tv.ask({}, scoped);
      await tv.app({ forService: true });

      // The service's share is used up, by whoever held that narrow token.
      expect((await tv.proofless()).status).toBe(429);
      expect(tv.row).toHaveProperty('serviceUntil');
      // A little over the half minute — the wait the television already makes (PairingFlow) — and the way is still open.
      tv.later(32_000);
      expect((await tv.proofless()).token).toMatchObject({ scope: 'waiting' });
    });

    it('uses the way up and counts the mint in one write: an ask that lost its place in the count does not get in twice', async () => {
      const tv = familyTelevision();
      await tv.app({ forService: true });

      // Another narrow refresh was counted between this ask's read and its write.
      tv.meanwhile(() => {
        tv.row.serviceRefreshWindowAt = { N: String(NOW) };
        tv.row.serviceRefreshCount = { N: '1' };
      });
      const first = await tv.proofless();
      expect(first.status).toBe(200);
      expect(tv.row.serviceRefreshCount).toEqual({ N: '2' });
      expect((await tv.proofless()).status).toBe(401);
    });
  });

  it('never widens: a scoped token shown as proof brings another scoped token, and never opens the way', async () => {
    const tv = familyTelevision();
    await tv.app({ forService: true });
    const scoped = (await tv.proofless()).token!.jwt;

    tv.later(40_000);
    const again = await tv.ask({}, scoped);
    expect(again.status).toBe(200);
    expect(again.token).toMatchObject({ kind: 'family', scope: 'waiting' });
    expect(again.claims).toMatchObject({ ...sarahs, scope: 'waiting' });

    tv.later(40_000);
    const asking = await tv.ask({ forService: true }, scoped);
    expect(asking.token).toMatchObject({ scope: 'waiting' });
    expect(tv.row).not.toHaveProperty('serviceUntil');
    expect((await tv.proofless()).status).toBe(401);
  });

  it('refuses a token of a scope it does not know', async () => {
    const tv = familyTelevision();
    const odd = signJwt({ ...sarahs, scope: 'everything' }, privateKey, { expiresInSec: 600 });

    const res = await tv.ask({}, odd);
    expect(res.status).toBe(401);
    expect(res.body).toBe('invalid_token');
  });

  it('opens nothing for a television that has been revoked, and mints nothing for it inside a way opened before', async () => {
    const revoked = familyTelevision({ deviceId: { S: 'tv-2' }, userId: { S: 'u_sarah' }, denylisted: { BOOL: true } });
    expect((await revoked.app({ forService: true })).status).toBe(403);

    const tv = familyTelevision();
    await tv.app({ forService: true });
    tv.row.denylisted = { BOOL: true };
    expect((await tv.proofless()).status).toBe(403);
  });

  it('means nothing on the resident’s television: its service is answered as before, with no scope and no way stamped', async () => {
    const items: Record<string, Item> = { 'DEV#tv-1|META': { householdId: { S: 'hh_1' } }, 'HH#hh_1|DEV#tv-1': { deviceId: { S: 'tv-1' } } };
    const updates: string[] = [];
    const send = async (command: { input: { Key: Item; UpdateExpression?: string } }) => {
      if (command instanceof GetItemCommand) return { Item: items[`${command.input.Key.pk!.S}|${command.input.Key.sk!.S}`] };
      updates.push(command.input.UpdateExpression ?? '');
      return {};
    };
    const handler = createHandler({ send, privateKey: async () => privateKey, publicKey: async () => publicKey, now: () => NOW, table: 'wick' });

    const res = await handler({ body: JSON.stringify({ deviceId: 'tv-1', forService: true }) });
    expect(res.statusCode).toBe(200);
    const { token } = JSON.parse(res.body) as { token: { jwt: string; kind?: string; scope?: string } };
    expect(token).not.toHaveProperty('kind');
    expect(token).not.toHaveProperty('scope');
    expect(verifyJwt(token.jwt, publicKey)).not.toHaveProperty('scope');
    expect(updates).toEqual(['SET refreshWindowAt = :at, refreshCount = :count']);
  });
});

// A narrow token can be renewed while it is good, so by itself a stolen one
// would live until the television is disconnected. Two more bounds on the
// chain of renewals: there is one of them at a time, and it has an end.
describe('POST /pair/refresh — the service’s session', () => {
  const sarahs = { deviceId: 'tv-2', householdId: 'hh_1', kind: 'family', userId: 'u_sarah' };
  const HOME_ADDRESS = '203.0.113.7';
  const DAY = 24 * 60 * 60 * 1000;

  /** As above: one family television's row, honouring the conditions it is written under. */
  function television() {
    const row: Item = { deviceId: { S: 'tv-2' }, userId: { S: 'u_sarah' } };
    let now = NOW;
    let meanwhile: (() => void) | undefined;
    const send = async (command: { input: { Key: Item; UpdateExpression?: string; ConditionExpression?: string; ExpressionAttributeValues?: Item } }) => {
      const key = `${command.input.Key.pk!.S}|${command.input.Key.sk!.S}`;
      if (command instanceof GetItemCommand) {
        if (key === 'DEV#tv-2|META') return { Item: { householdId: { S: 'hh_1' } } };
        return { Item: key === 'HH#hh_1|FTV#tv-2' ? { ...row } : undefined };
      }
      if (command instanceof UpdateItemCommand) {
        const other = meanwhile;
        meanwhile = undefined;
        other?.();
        const values = command.input.ExpressionAttributeValues ?? {};
        for (const clause of (command.input.ConditionExpression ?? '').split(' AND ').filter(Boolean)) {
          const missing = /^attribute_not_exists\((\w+)\)$/.exec(clause);
          const present = /^attribute_exists\((\w+)\)$/.exec(clause);
          const equal = /^(\w+) = (:\w+)$/.exec(clause);
          const greater = /^(\w+) > (:\w+)$/.exec(clause);
          const holds = missing
            ? row[missing[1]!] === undefined
            : present
              ? present[1] === 'pk' || row[present[1]!] !== undefined
              : equal
                ? JSON.stringify(row[equal[1]!]) === JSON.stringify(values[equal[2]!])
                : greater
                  ? row[greater[1]!]?.N !== undefined && Number(row[greater[1]!]!.N) > Number(values[greater[2]!]!.N)
                  : false;
          if (!holds) throw Object.assign(new Error(`condition failed: ${clause}`), { name: 'ConditionalCheckFailedException' });
        }
        const [, sets = '', removes = ''] = /^SET (.*?)(?: REMOVE (.*))?$/.exec(command.input.UpdateExpression ?? '') ?? [];
        for (const set of sets.split(', ').filter(Boolean)) {
          const [name, value] = set.split(' = ');
          row[name!] = values[value!]!;
        }
        for (const name of removes.split(', ').filter(Boolean)) delete row[name];
      }
      return {};
    };
    const handler = createHandler({ send, privateKey: async () => privateKey, publicKey: async () => publicKey, now: () => now, table: 'wick' });
    const ask = async (o: object, jwt?: string, from: string | null = HOME_ADDRESS) => {
      const res = (await handler({
        body: JSON.stringify({ deviceId: 'tv-2', ...o }),
        headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
        ...(from ? { requestContext: { http: { sourceIp: from } } } : {}),
      })) as { statusCode: number; body: string };
      const token = res.statusCode === 200 ? (JSON.parse(res.body) as { token: { jwt: string; scope?: string } }).token : undefined;
      return { status: res.statusCode, body: res.body, token, claims: token ? (verifyJwt(token.jwt, publicKey) as Record<string, unknown>) : undefined };
    };
    const full = () => signJwt(sarahs, privateKey, { expiresInSec: 3600 });
    return {
      row,
      now: () => now,
      later: (ms: number) => {
        now += ms;
      },
      meanwhile: (what: () => void) => {
        meanwhile = what;
      },
      ask,
      full,
      app: (o: object = {}) => ask(o, full()),
      renew: (jwt: string) => ask({}, jwt),
      /** The service asking to be let in: no token, from the television's own address. */
      claim: () => ask({ forService: true }),
      /** The app opens the way and its service takes it: one hand-off. */
      handOff: async () => {
        expect((await ask({ forService: true }, full())).status).toBe(200);
        const claimed = await ask({ forService: true });
        expect(claimed.status).toBe(200);
        return claimed;
      },
    };
  }

  it('begins when the service is let in: the row and the token both say when', async () => {
    const tv = television();
    tv.later(5_000);
    const claimed = await tv.handOff();

    expect(tv.row.serviceSince).toEqual({ N: String(NOW + 5_000) });
    expect(claimed.claims).toMatchObject({ ...sarahs, scope: 'waiting', since: NOW + 5_000 });
  });

  it('is carried through every renewal unchanged: the session is as old as its first token', async () => {
    const tv = television();
    const claimed = await tv.handOff();

    tv.later(40 * 60 * 1000);
    const once = await tv.renew(claimed.token!.jwt);
    tv.later(40 * 60 * 1000);
    const twice = await tv.renew(once.token!.jwt);

    expect(once.claims).toMatchObject({ scope: 'waiting', since: NOW });
    expect(twice.claims).toMatchObject({ scope: 'waiting', since: NOW });
    expect(tv.row.serviceSince).toEqual({ N: String(NOW) });
  });

  it('is the only one: a new hand-off ends every earlier chain at once', async () => {
    const tv = television();
    const first = await tv.handOff();
    tv.later(60_000);
    const second = await tv.handOff();

    const old = await tv.renew(first.token!.jwt);
    expect(old.status).toBe(401);
    expect(old.body).toBe('session_replaced');
    expect((await tv.renew(second.token!.jwt)).status).toBe(200);
  });

  it('ends the earlier chain even when the two hand-offs fall in the same millisecond', async () => {
    const tv = television();
    const first = await tv.handOff();
    tv.later(0);
    // A second window needs the app's share of refreshes and the service's: both have room for two.
    const second = await tv.handOff();

    expect(second.claims!.since).not.toBe(first.claims!.since);
    expect((await tv.renew(first.token!.jwt)).status).toBe(401);
    expect((await tv.renew(second.token!.jwt)).status).toBe(200);
  });

  it('is checked in the write, not only when the row is read: a renewal overtaken by a new hand-off is not answered', async () => {
    const tv = television();
    const claimed = await tv.handOff();

    // Between this renewal's read and its write, the service was let in again.
    tv.meanwhile(() => {
      tv.row.serviceSince = { N: String(NOW + 1) };
    });
    expect((await tv.renew(claimed.token!.jwt)).status).toBe(401);
  });

  it('has an end: after seven days a narrow token is not renewed, however good its expiry', async () => {
    const tv = television();
    const claimed = await tv.handOff();

    tv.later(7 * DAY);
    expect((await tv.renew(claimed.token!.jwt)).status).toBe(200);
    tv.later(1);
    const over = await tv.renew(claimed.token!.jwt);
    expect(over.status).toBe(401);
    expect(over.body).toBe('session_over');
  });

  it('begins again, with a new seven days, when the app next opens the way', async () => {
    const tv = television();
    const first = await tv.handOff();
    tv.later(7 * DAY + 1);
    expect((await tv.renew(first.token!.jwt)).body).toBe('session_over');

    const second = await tv.handOff();
    expect(second.claims).toMatchObject({ since: NOW + 7 * DAY + 1 });
    expect((await tv.renew(second.token!.jwt)).status).toBe(200);
  });

  it('refuses a narrow token that does not say when its session began', async () => {
    const tv = television();
    await tv.handOff();
    const sinceless = signJwt({ ...sarahs, scope: 'waiting' }, privateKey, { expiresInSec: 600 });

    const res = await tv.renew(sinceless);
    expect(res.status).toBe(401);
    expect(res.body).toBe('invalid_token');
    for (const since of ['yesterday', null, Number.NaN]) {
      expect((await tv.renew(signJwt({ ...sarahs, scope: 'waiting', since }, privateKey, { expiresInSec: 600 }))).status).toBe(401);
    }
  });

  it('refuses a narrow token on a television whose service has never been let in', async () => {
    const tv = television();

    expect((await tv.renew(signJwt({ ...sarahs, scope: 'waiting', since: NOW }, privateKey, { expiresInSec: 600 }))).status).toBe(401);
  });

  it('is nothing to an ordinary refresh of the television’s own token: it has no session, and neither begins nor ends one', async () => {
    const tv = television();
    const claimed = await tv.handOff();

    const app = await tv.app();
    expect(app.claims).not.toHaveProperty('since');
    expect(app.claims).not.toHaveProperty('scope');
    expect(tv.row.serviceSince).toEqual({ N: String(NOW) });
    expect((await tv.renew(claimed.token!.jwt)).status).toBe(200);
  });

  // A service that still holds a good token does not ask to be let in
  // again, so "a new hand-off" alone would leave a token copied out of a
  // running service good for the session's seven days. The opening itself
  // ends the session: every time the app comes on screen, it rotates.
  describe('ended by the app opening the way', () => {
    it('ends the session in the very write that opens the way: the narrow token is not renewed after it', async () => {
      const tv = television();
      const claimed = await tv.handOff();
      tv.later(60_000);

      expect((await tv.app({ forService: true })).status).toBe(200);
      expect(tv.row).not.toHaveProperty('serviceSince');
      expect(tv.row).toHaveProperty('serviceUntil');

      const old = await tv.renew(claimed.token!.jwt);
      expect(old.status).toBe(401);
      expect(old.body).toBe('session_replaced');
    });

    it('lets the television’s own service in again inside that same way, with a new session', async () => {
      const tv = television();
      const first = await tv.handOff();
      tv.later(60_000);
      await tv.app({ forService: true });
      tv.later(25_000);

      const again = await tv.claim();
      expect(again.status).toBe(200);
      expect(again.claims).toMatchObject({ scope: 'waiting', since: NOW + 85_000 });
      expect(again.claims!.since).not.toBe(first.claims!.since);
      expect(tv.row.serviceSince).toEqual({ N: String(NOW + 85_000) });
      // The new session's token is renewed; the old session's still is not.
      expect((await tv.renew(again.token!.jwt)).status).toBe(200);
      expect((await tv.renew(first.token!.jwt)).status).toBe(401);
    });

    it('stops a renewal that was already under way when the way was opened', async () => {
      const tv = television();
      const claimed = await tv.handOff();

      // Between this renewal's read of the row and its write, the app came on screen.
      tv.meanwhile(() => {
        delete tv.row.serviceSince;
      });
      expect((await tv.renew(claimed.token!.jwt)).status).toBe(401);
    });

    it('ends nothing when the opening is refused for its token', async () => {
      const tv = television();
      const claimed = await tv.handOff();
      const stranger = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });

      for (const bad of [signJwt(sarahs, stranger.privateKey, { expiresInSec: 600 }), signJwt({ ...sarahs, userId: 'u_dan' }, privateKey, { expiresInSec: 600 }), 'not.a.token']) {
        expect((await tv.ask({ forService: true }, bad)).status).toBe(401);
      }
      // Nor by a request with no token at all, or one that is not asking as the service's app.
      expect((await tv.ask({ forService: true })).status).toBe(401);

      expect(tv.row.serviceSince).toEqual({ N: String(NOW) });
      expect((await tv.renew(claimed.token!.jwt)).status).toBe(200);
    });

    it('ends nothing when the opening is refused for asking too often', async () => {
      const tv = television();
      const claimed = await tv.handOff();
      // The app's share of the half minute: the opening was one, these are the rest.
      for (let i = 1; i < REFRESH_MAX_PER_WINDOW; i += 1) expect((await tv.app()).status).toBe(200);

      expect((await tv.app({ forService: true })).status).toBe(429);
      expect(tv.row.serviceSince).toEqual({ N: String(NOW) });
      expect((await tv.renew(claimed.token!.jwt)).status).toBe(200);
    });

    it('ends nothing when a narrow token asks for the way to be opened: only the app’s own token can', async () => {
      const tv = television();
      const claimed = await tv.handOff();

      const asked = await tv.ask({ forService: true }, claimed.token!.jwt);
      expect(asked.status).toBe(200);
      expect(asked.claims).toMatchObject({ scope: 'waiting', since: NOW });
      expect(tv.row.serviceSince).toEqual({ N: String(NOW) });
      expect(tv.row).not.toHaveProperty('serviceUntil');
    });

    it('ends nothing when the opening comes from nowhere and so opens nothing', async () => {
      const tv = television();
      const claimed = await tv.handOff();

      expect((await tv.ask({ forService: true }, tv.full(), null)).status).toBe(200);
      expect(tv.row).not.toHaveProperty('serviceUntil');
      expect(tv.row.serviceSince).toEqual({ N: String(NOW) });
      expect((await tv.renew(claimed.token!.jwt)).status).toBe(200);
    });
  });
});
