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
  it('mints a token for the household the television belongs to, from the device id alone — in a demo home', async () => {
    const handler = world({
      'HH#hh_1|META': { simulated: { BOOL: true } },
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
      'HH#hh_1|META': { simulated: { BOOL: true } },
      'DEV#tv-1|META': { householdId: { S: 'hh_1' } },
      'HH#hh_1|DEV#tv-1': { deviceId: { S: 'tv-1' } },
      'HH#hh_2|DEV#tv-1': { deviceId: { S: 'tv-1' } },
    });

    const res = await handler(body({ deviceId: 'tv-1', householdId: 'hh_2' }));

    const { token } = JSON.parse(res.body) as { token: { householdId: string } };
    expect(token.householdId).toBe('hh_1');
  });

  it('never mints from the id alone for a real home: a television that keeps no secret there is asked for proof', async () => {
    for (const meta of [undefined, { simulated: { BOOL: false } }, { name: { S: 'Margaret' } }]) {
      const handler = world({
        ...(meta ? { 'HH#hh_1|META': meta } : {}),
        'DEV#tv-1|META': { householdId: { S: 'hh_1' } },
        'HH#hh_1|DEV#tv-1': { deviceId: { S: 'tv-1' } },
      });
      for (const ask of [{ deviceId: 'tv-1' }, { deviceId: 'tv-1', proof: 'p'.repeat(64) }, { deviceId: 'tv-1', forService: true }]) {
        const res = await handler(body(ask));
        expect(res.statusCode).toBe(401);
        expect(res.body).toBe('proof_required');
      }
    }
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
      const send = async (command: { input: { Key: Item; UpdateExpression?: string; ExpressionAttributeValues?: Item } }) => {
        if (command instanceof GetItemCommand) {
          if (command.input.Key.sk!.S === 'META' && command.input.Key.pk!.S === 'HH#hh_1') return { Item: { simulated: { BOOL: true } } };
          return { Item: command.input.Key.pk!.S === 'DEV#tv-1' ? { householdId: { S: 'hh_1' } } : { ...row } };
        }
        if (command instanceof UpdateItemCommand) {
          const v = command.input.ExpressionAttributeValues!;
          // Whichever share it is counted in (pair-refresh.mjs): the names are the update's own.
          const [, at = '', count = ''] = /^SET (\w+) = :at, (\w+) = :count/.exec(command.input.UpdateExpression ?? '') ?? [];
          const unchanged = v[':wasAt'] ? row[at]?.N === v[':wasAt'].N && row[count]?.N === v[':wasCount']!.N : row[at] === undefined;
          if (!unchanged) throw Object.assign(new Error('changed'), { name: 'ConditionalCheckFailedException' });
          row[at] = v[':at']!;
          row[count] = v[':count']!;
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
    const res = await worldWithKey({ 'HH#hh_1|META': { simulated: { BOOL: true } }, 'DEV#tv-1|META': { householdId: { S: 'hh_1' } }, 'HH#hh_1|DEV#tv-1': { deviceId: { S: 'tv-1' } } })(withToken({ deviceId: 'tv-1', kind: 'family' }));
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
    const items: Record<string, Item> = { 'HH#hh_1|META': { simulated: { BOOL: true } }, 'DEV#tv-1|META': { householdId: { S: 'hh_1' } }, 'HH#hh_1|DEV#tv-1': { deviceId: { S: 'tv-1' } } };
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
    expect(updates).toEqual(['SET unprovenRefreshWindowAt = :at, unprovenRefreshCount = :count']);
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

// ---------------------------------------------------------------------------
// Adversarial: what someone who knows a television's id can and cannot do
// (AGENTS.md INV-1). Played against one in-memory table that honours every
// condition the pairing Lambdas write under, with pair-start, pair-claim and
// pair-refresh all running against it as they do in AWS.
// ---------------------------------------------------------------------------

// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { createHandler as createStart } from '../pair-start.mjs';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { createHandler as createClaim } from '../pair-claim.mjs';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { createHandler as createStatus } from '../pair-status.mjs';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { accessTokenKey } from '../wick-auth.mjs';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { proofHashOf } from '../proof.mjs';
import { DeleteItemCommand, PutItemCommand, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';

type Av = { S?: string; N?: string; BOOL?: boolean };
type Row = Record<string, Av>;

/** A table that keeps rows and honours the condition expressions the pairing Lambdas use. */
function memoryTable() {
  const rows = new Map<string, Row>();
  const keyOf = (k: Row) => `${k.pk!.S}|${k.sk!.S}`;
  /** Every write that was applied, by key. */
  const applied: string[] = [];
  /** Run once, just before the next write is decided: what another request did meanwhile. */
  let meanwhile: (() => void) | undefined;
  const holds = (row: Row | undefined, expression: string | undefined, values: Row = {}): boolean =>
    !expression ||
    expression.split(' OR ').some((alternative) =>
      alternative.split(' AND ').every((clause) => {
        let m: RegExpExecArray | null;
        if ((m = /^attribute_not_exists\((\w+)\)$/.exec(clause))) return row?.[m[1]!] === undefined;
        if ((m = /^attribute_exists\((\w+)\)$/.exec(clause))) return row?.[m[1]!] !== undefined;
        if ((m = /^(\w+) = (:\w+)$/.exec(clause))) return row?.[m[1]!] !== undefined && JSON.stringify(row[m[1]!]) === JSON.stringify(values[m[2]!]);
        if ((m = /^(\w+) > (:\w+)$/.exec(clause))) return row?.[m[1]!]?.N !== undefined && Number(row[m[1]!]!.N) > Number(values[m[2]!]!.N);
        throw new Error(`the test table does not know: ${clause}`);
      }),
    );
  const failed = () => Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });
  const decide = () => {
    const other = meanwhile;
    meanwhile = undefined;
    other?.();
  };
  const send = async (command: { input: Record<string, unknown> }) => {
    const input = command.input as { Key?: Row; Item?: Row; ConditionExpression?: string; ExpressionAttributeValues?: Row; UpdateExpression?: string; TransactItems?: { Delete: { Key: Row; ConditionExpression?: string; ExpressionAttributeValues?: Row } }[] };
    if (command instanceof GetItemCommand) {
      const row = rows.get(keyOf(input.Key!));
      return { Item: row ? structuredClone(row) : undefined };
    }
    decide();
    if (command instanceof PutItemCommand) {
      const key = keyOf(input.Item!);
      if (!holds(rows.get(key), input.ConditionExpression, input.ExpressionAttributeValues)) throw failed();
      rows.set(key, structuredClone(input.Item!));
      applied.push(`put ${key}`);
      return {};
    }
    if (command instanceof UpdateItemCommand) {
      const key = keyOf(input.Key!);
      const row = rows.get(key);
      const values = input.ExpressionAttributeValues ?? {};
      if (!holds(row, input.ConditionExpression, values)) throw failed();
      const next: Row = structuredClone(row ?? { ...input.Key! });
      const [, sets = '', removes = ''] = /^SET (.*?)(?: REMOVE (.*))?$/.exec(input.UpdateExpression ?? '') ?? [];
      for (const [, name, , ifMissing, plain] of sets.matchAll(/(\w+) = (if_not_exists\(\w+, (:\w+)\)|(:\w+))/g)) {
        if (ifMissing) next[name!] ??= values[ifMissing]!;
        else next[name!] = values[plain!]!;
      }
      for (const name of removes.split(', ').filter(Boolean)) delete next[name];
      rows.set(key, next);
      applied.push(`update ${key}`);
      return {};
    }
    if (command instanceof DeleteItemCommand) {
      const key = keyOf(input.Key!);
      const row = rows.get(key);
      if (!holds(row, input.ConditionExpression, input.ExpressionAttributeValues)) throw failed();
      rows.delete(key);
      applied.push(`delete ${key}`);
      return { Attributes: row };
    }
    if (command instanceof TransactWriteItemsCommand) {
      for (const { Delete } of input.TransactItems!) {
        if (!holds(rows.get(keyOf(Delete.Key)), Delete.ConditionExpression, Delete.ExpressionAttributeValues)) throw Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException' });
      }
      for (const { Delete } of input.TransactItems!) {
        rows.delete(keyOf(Delete.Key));
        applied.push(`delete ${keyOf(Delete.Key)}`);
      }
      return {};
    }
    throw new Error('the test table does not know this command');
  };
  return {
    rows,
    applied,
    send,
    row: (key: string) => rows.get(key),
    put: (key: string, row: Row) => {
      const [pk, sk] = key.split('|');
      rows.set(key, { pk: { S: pk }, sk: { S: sk }, ...row });
    },
    meanwhile: (what: () => void) => {
      meanwhile = what;
    },
  };
}

const NOW_A = 1_790_000_000_000;
const REAL = 'r'.repeat(20) + '0123456789abcdef0123456789abcdef0123456789ab';
const ATTACKERS = 'a'.repeat(20) + '0123456789abcdef0123456789abcdef0123456789ab';

/**
 * One home (hh_1, organiser Sarah) with the resident's television tv-1, and
 * one home of the attacker's own (hh_x, organiser Mallory). `secret`: whether
 * tv-1's row keeps its secret.
 */
function homes({ secret, family = false, demo = false }: { secret: boolean; family?: boolean; demo?: boolean }) {
  const table = memoryTable();
  let now = NOW_A;
  const deps = { send: table.send, privateKey: async () => privateKey, publicKey: async () => publicKey, now: () => now, table: 'wick' };
  const refresh = createHandler(deps);
  let code = 100000;
  const start = createStart({ send: table.send, now: () => now, table: 'wick', pairingUrlBase: 'https://wick.example', code: () => String((code += 1)) });
  const claim = createClaim(deps);
  const status = createStatus({ send: table.send, table: 'wick' });

  const organiser = (token: string, householdId: string, userId: string) => {
    table.put(`${accessTokenKey(token).pk.S}|META`, { data: { S: JSON.stringify({ userId, householdId }) }, expiresAt: { N: String(NOW_A + 86_400_000) } });
    table.put(`HH#${householdId}|MEM#${userId}`, { role: { S: 'organiser' }, status: { S: 'allowed' } });
  };
  organiser('sarahs-token', 'hh_1', 'u_sarah');
  organiser('mallorys-token', 'hh_x', 'u_mallory');
  table.put('DEV#tv-1|META', { householdId: { S: 'hh_1' } });
  // A demo home (proof.mjs isDemoHome): the only kind a television that keeps no secret is answered in from its id.
  if (demo) table.put('HH#hh_1|META', { simulated: { BOOL: true } });
  const victimKey = family ? 'HH#hh_1|FTV#tv-1' : 'HH#hh_1|DEV#tv-1';
  table.put(victimKey, {
    deviceId: { S: 'tv-1' },
    householdId: { S: 'hh_1' },
    denylisted: { BOOL: false },
    ...(family ? { userId: { S: 'u_sarah' } } : {}),
    ...(secret ? { proofHash: { S: proofHashOf(REAL) } } : {}),
  });

  const ask = async (body: object, jwt?: string, from = '198.51.100.23') => {
    const res = (await refresh({
      body: JSON.stringify({ deviceId: 'tv-1', ...body }),
      headers: jwt ? { authorization: `Bearer ${jwt}` } : {},
      requestContext: { http: { sourceIp: from } },
    })) as { statusCode: number; body: string };
    const minted = res.statusCode === 200 ? (verifyJwt((JSON.parse(res.body) as { token: { jwt: string } }).token.jwt, publicKey) as Record<string, unknown>) : undefined;
    return { status: res.statusCode, body: res.body, minted };
  };
  return {
    table,
    victimKey,
    victim: () => table.row(victimKey),
    ask,
    start: async (body: object) => (await start({ body: JSON.stringify(body) })) as { statusCode: number; body: string },
    claim: async (pairingCode: string, token: string, as?: string) =>
      (await claim({ headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ code: pairingCode, ...(as ? { as } : {}) }) })) as { statusCode: number; body: string },
    poll: async (pairingCode: string) => {
      const res = (await status({ queryStringParameters: { code: pairingCode } })) as { statusCode: number; body: string };
      return { status: res.statusCode, body: res.statusCode === 200 ? (JSON.parse(res.body) as { status: string; proof?: string; token?: { deviceId: string } }) : undefined };
    },
    later: (ms: number) => {
      now += ms;
    },
  };
}

const residentsClaims = { deviceId: 'tv-1', householdId: 'hh_1' };
const tokenFor = (claims: object, expiresInSec: number) => signJwt({ ...residentsClaims, ...claims }, privateKey, { expiresInSec });
/** What the real television holds from its pairing: thirty days, earned by the code. */
const pairingToken = () => tokenFor({ proof: 'pairing' }, 30 * 86400);

/** The row, without the refresh counters the exception is allowed to move. */
const settled = (row: Row | undefined) => {
  const { unprovenRefreshWindowAt: _a, unprovenRefreshCount: _b, ...rest } = row ?? {};
  return rest;
};

describe('TAKEOVER — someone who knows the resident’s television’s id', () => {
  const kinds: [string, boolean, boolean][] = [
    ['a television that keeps its secret', true, false],
    ['a real home’s television whose row keeps no secret yet', false, false],
    ['a demo home’s television whose row keeps no secret', false, true],
  ];
  for (const [kind, secret, demo] of kinds) {
    describe(kind, () => {
      const attacks: [string, object, (() => string) | undefined][] = [
        ['(a) with no token', {}, undefined],
        ['(a) with no token, and a secret of their own', { proof: ATTACKERS }, undefined],
        ['(b) with a proof:"none" token they minted', { proof: ATTACKERS }, () => tokenFor({ proof: 'none' }, 3600)],
        ['(c) with a token from before tokens said how, an hour long', { proof: ATTACKERS }, () => tokenFor({}, 3600)],
        ['(d) with a pairing token that has run out', { proof: ATTACKERS }, () => tokenFor({ proof: 'pairing' }, -60)],
        ['(d) with a pairing token of another television', { proof: ATTACKERS }, () => signJwt({ deviceId: 'tv-9', householdId: 'hh_1', proof: 'pairing' }, privateKey, { expiresInSec: 600 })],
        ['(d) with a family member’s token for this television', { proof: ATTACKERS }, () => tokenFor({ kind: 'family', userId: 'u_sarah', proof: 'pairing' }, 600)],
      ];
      for (const [name, body, jwt] of attacks) {
        it(`${name}: enrols nothing, replaces nothing, removes nothing, and is never handed a proof:"secret" token`, async () => {
          const h = homes({ secret, demo });
          const before = structuredClone(h.victim());

          const res = await h.ask(body, jwt?.());

          if (!demo) {
            expect(res.status).toBe(401);
            expect(res.body).toBe('proof_required');
            // Refused before anything was written.
            expect(h.table.applied).toEqual([]);
            expect(h.victim()).toEqual(before);
          } else {
            // The documented exception, in a demo home only: a token that says it proves nothing, and only its own share counted.
            expect(res.minted).toMatchObject({ proof: 'none' });
            expect(settled(h.victim())).toEqual(settled(before));
          }
          expect(res.minted?.proof).not.toBe('secret');
          expect(h.victim()?.proofHash).toEqual(before?.proofHash);
          expect(h.victim()?.denylisted).toEqual({ BOOL: false });
        });
      }

      it('(e) racing the real television’s enrolment: never the attacker’s secret, and no unproven token once the real one is enrolled', async () => {
        const h = homes({ secret: false, demo: true });
        // The attacker read the row before the real television enrolled, and writes after.
        h.table.meanwhile(() => {
          h.table.rows.get(h.victimKey)!.proofHash = { S: proofHashOf(REAL) };
        });
        const raced = await h.ask({ proof: ATTACKERS });
        expect(raced.status).toBe(401);
        expect(h.victim()?.proofHash).toEqual({ S: proofHashOf(REAL) });

        // And the real television's own enrolment, with its pairing token, wins over nothing but nothing.
        const fresh = homes({ secret: false, demo: true });
        await fresh.ask({ proof: ATTACKERS });
        expect((await fresh.ask({ proof: REAL }, pairingToken())).minted).toMatchObject({ proof: 'secret' });
        expect(fresh.victim()?.proofHash).toEqual({ S: proofHashOf(REAL) });
        expect((await fresh.ask({ proof: ATTACKERS }, tokenFor({ proof: 'none' }, 3600))).status).toBe(401);
      });

      it('(f) through pair-start with the victim’s id and a secret of their own: nothing changes while nobody enters the code, nor when their own organiser tries', async () => {
        const h = homes({ secret });
        const before = structuredClone(h.victim());

        const started = await h.start({ deviceId: 'tv-1', proof: ATTACKERS });
        expect(started.statusCode).toBe(200);
        expect(h.victim()).toEqual(before);
        // The code is no use to them: their own home cannot take a television that is another home's.
        const code = (JSON.parse(started.body) as { code: string }).code;
        const theirs = await h.claim(code, 'mallorys-token');
        expect(theirs.statusCode).toBe(409);
        expect(theirs.body).toBe('television_in_another_home');
        expect(h.victim()).toEqual(before);
        // And the secret they started with buys nothing at the refresh.
        const res = await h.ask({ proof: ATTACKERS });
        expect(res.minted?.proof).not.toBe('secret');
        expect(h.victim()?.proofHash).toEqual(before?.proofHash);
      });

      it('(g) through pair-start naming the victim as the television it replaces, with a wrong secret: the victim’s row survives — even if its own organiser is talked into entering the code', async () => {
        const h = homes({ secret });
        const before = structuredClone(h.victim());

        for (const organiserToken of ['mallorys-token', 'sarahs-token']) {
          const started = await h.start({ deviceId: `tv-mallory-${organiserToken.length}`, proof: ATTACKERS, replaces: { deviceId: 'tv-1', proof: ATTACKERS } });
          const code = (JSON.parse(started.body) as { code: string }).code;
          expect((await h.claim(code, organiserToken)).statusCode).toBe(200);
          expect(h.victim()).toEqual(before);
          expect(h.table.row('DEV#tv-1|META')).toMatchObject({ householdId: { S: 'hh_1' } });
        }
      });
    });
  }

  it('the real television, paired again, does remove the row it replaces — the same machinery, with the right secret', async () => {
    const h = homes({ secret: true });
    const started = await h.start({ deviceId: 'tv-1b', proof: ATTACKERS.replace(/a/g, 'b'), replaces: { deviceId: 'tv-1', proof: REAL } });
    expect((await h.claim((JSON.parse(started.body) as { code: string }).code, 'sarahs-token')).statusCode).toBe(200);
    expect(h.victim()).toBeUndefined();
    expect(h.table.row('DEV#tv-1|META')).toBeUndefined();
  });
});

describe('TAKEOVER — someone who knows a family member’s television’s id', () => {
  const sarahs = { deviceId: 'tv-1', householdId: 'hh_1', kind: 'family', userId: 'u_sarah' };
  const full = (expiresInSec: number) => signJwt(sarahs, privateKey, { expiresInSec });
  const stranger = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });

  for (const secret of [true, false]) {
    it(`refuses, writing nothing, every token that is not this television’s own (${secret ? 'with' : 'without'} a secret on the row)`, async () => {
      const h = homes({ secret, family: true });
      const before = structuredClone(h.victim());
      const forged = [
        undefined,
        tokenFor({ proof: 'pairing' }, 600),
        signJwt({ ...sarahs, userId: 'u_mallory' }, privateKey, { expiresInSec: 600 }),
        signJwt({ ...sarahs, householdId: 'hh_x' }, privateKey, { expiresInSec: 600 }),
        signJwt(sarahs, stranger.privateKey, { expiresInSec: 600 }),
        signJwt({ ...sarahs, scope: 'everything' }, privateKey, { expiresInSec: 600 }),
        // A narrow token for a session the row does not name.
        signJwt({ ...sarahs, scope: 'waiting', since: NOW_A }, privateKey, { expiresInSec: 600 }),
      ];
      for (const jwt of forged) {
        for (const body of [{}, { forService: true }, { proof: ATTACKERS }, { forService: true, proof: ATTACKERS }]) {
          expect((await h.ask(body, jwt)).status).toBe(401);
        }
      }
      expect(h.table.applied).toEqual([]);
      expect(h.victim()).toEqual(before);
    });
  }

  it('a stolen full token without the secret, run out or not, opens no way, ends no session and counts nothing', async () => {
    const h = homes({ secret: true, family: true });
    h.table.rows.get(h.victimKey)!.serviceSince = { N: String(NOW_A - 1000) };
    const before = structuredClone(h.victim());

    for (const jwt of [full(-3600), full(600)]) {
      for (const body of [{}, { forService: true }, { forService: true, proof: ATTACKERS }]) {
        const res = await h.ask(body, jwt, '203.0.113.7');
        expect(res.status).toBe(401);
        expect(res.body).toBe('proof_required');
      }
    }
    expect(h.table.applied).toEqual([]);
    expect(h.victim()).toEqual(before);
  });

  it('a narrow token, or the service’s knock inside the way, never enrols a secret on a row that keeps none', async () => {
    const h = homes({ secret: false, family: true });
    // The real app opens the way, from home.
    expect((await h.ask({ forService: true }, full(600), '203.0.113.7')).status).toBe(200);
    // Someone at the same address knocks first, with a secret of their own (the second exception's known residue).
    const knock = await h.ask({ forService: true, proof: ATTACKERS }, undefined, '203.0.113.7');
    expect(knock.minted).toMatchObject({ scope: 'waiting' });
    expect(knock.minted).not.toHaveProperty('proof');
    const narrow = signJwt({ ...sarahs, scope: 'waiting', since: knock.minted!.since }, privateKey, { expiresInSec: 600 });
    expect((await h.ask({ proof: ATTACKERS }, narrow)).minted).toMatchObject({ scope: 'waiting' });
    expect(h.victim()).not.toHaveProperty('proofHash');
  });
});

describe('LOCKOUT — nothing without the secret can keep the real television out', () => {
  it('a stranger asking without the secret, over and over, changes nothing the real television is later refused by', async () => {
    const h = homes({ secret: true });
    for (let i = 0; i < 20; i += 1) await h.ask(i % 2 ? { proof: ATTACKERS } : {}, i % 3 ? tokenFor({ proof: 'none' }, 3600) : undefined);
    expect(h.table.applied).toEqual([]);

    const real = await h.ask({ proof: REAL });
    expect(real.status).toBe(200);
    expect(real.minted).toMatchObject({ proof: 'secret' });
  });

  it('in a real home, a row with no secret yet answers a stranger nothing, and the real television still enrols with its pairing token', async () => {
    const h = homes({ secret: false });
    for (let i = 0; i < 10; i += 1) expect((await h.ask({})).status).toBe(401);
    expect(h.table.applied).toEqual([]);

    expect((await h.ask({ proof: REAL }, pairingToken())).minted).toMatchObject({ proof: 'secret' });
    expect((await h.ask({ proof: REAL })).status).toBe(200);
  });

  it('in a demo home, a row with no secret yet: a stranger using up the share anyone may use does not stop the real television enrolling, or refreshing after', async () => {
    const h = homes({ secret: false, demo: true });
    let refused = 0;
    for (let i = 0; i < 10; i += 1) if ((await h.ask({})).status === 429) refused += 1;
    expect(refused).toBeGreaterThan(0);

    expect((await h.ask({ proof: REAL }, pairingToken())).minted).toMatchObject({ proof: 'secret' });
    expect((await h.ask({ proof: REAL })).status).toBe(200);
  });

  it('a family television’s secret, once kept, is asked for before anything is counted: a stranger cannot use up its app’s share', async () => {
    const h = homes({ secret: true, family: true });
    const old = signJwt({ deviceId: 'tv-1', householdId: 'hh_1', kind: 'family', userId: 'u_sarah' }, privateKey, { expiresInSec: -3600 });
    for (let i = 0; i < 10; i += 1) await h.ask({}, old);
    expect(h.table.applied).toEqual([]);
    expect((await h.ask({ proof: REAL }, old)).status).toBe(200);
  });
});

// A Vega television keeps a file but has no cryptographic generator, so the
// server makes its secret when the code is entered and hands it over once,
// with the token, to the television polling that code.
describe('a secret made by the server, for a television that cannot make one', () => {
  const pairAs = async (h: ReturnType<typeof homes>, body: object) => {
    const started = await h.start(body);
    const code = (JSON.parse(started.body) as { code: string }).code;
    expect((await h.claim(code, 'sarahs-token')).statusCode).toBe(200);
    return code;
  };
  const askAs = async (h: ReturnType<typeof homes>, deviceId: string, body: object) => {
    const refresh = createHandler({ send: h.table.send, privateKey: async () => privateKey, publicKey: async () => publicKey, now: () => NOW_A, table: 'wick' });
    const res = (await refresh({ body: JSON.stringify({ deviceId, ...body }) })) as { statusCode: number; body: string };
    return { status: res.statusCode, minted: res.statusCode === 200 ? (verifyJwt((JSON.parse(res.body) as { token: { jwt: string } }).token.jwt, publicKey) as Record<string, unknown>) : undefined };
  };

  it('is handed over exactly once, with the token, to the code’s own poll; the row keeps its hash; a refresh needs it', async () => {
    const h = homes({ secret: false });
    const code = await pairAs(h, { deviceId: 'wick-vega', keeps: true });

    const first = await h.poll(code);
    expect(first.body).toMatchObject({ status: 'bound', token: { deviceId: 'wick-vega' } });
    const secret = first.body!.proof!;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    // Once: the nonce went with it, and nothing else holds the secret.
    expect((await h.poll(code)).status).toBe(404);
    expect(h.table.row('HH#hh_1|DEV#wick-vega')?.proofHash).toEqual({ S: proofHashOf(secret) });
    expect(JSON.stringify([...h.table.rows.values()])).not.toContain(secret);

    expect((await askAs(h, 'wick-vega', {})).status).toBe(401);
    expect((await askAs(h, 'wick-vega', { proof: ATTACKERS })).status).toBe(401);
    expect((await askAs(h, 'wick-vega', { proof: secret })).minted).toMatchObject({ proof: 'secret' });
  });

  it('is never made for a television that does not say it keeps a file, nor for the simulator’s id whatever it says — which joins only a demo home', async () => {
    const h = homes({ secret: false, demo: true });
    for (const body of [{ deviceId: 'wick-vega' }, { deviceId: 'wick-tv', keeps: true }]) {
      const code = await pairAs(h, body);
      const polled = await h.poll(code);
      expect(polled.body).toMatchObject({ status: 'bound' });
      expect(polled.body).not.toHaveProperty('proof');
      expect(h.table.row(`HH#hh_1|DEV#${body.deviceId}`)).not.toHaveProperty('proofHash');
      // Answered from its id alone, as before: the documented exception, not locked out.
      expect((await askAs(h, body.deviceId, {})).minted).toMatchObject({ proof: 'none' });
    }
  });

  it('a television that will keep no secret is never connected to a real home, and nothing is written', async () => {
    const h = homes({ secret: false });
    for (const ask of [{ deviceId: 'wick-vega' }, { deviceId: 'wick-tv', keeps: true }, { deviceId: 'wick-tv' }]) {
      const started = await h.start(ask);
      const code = (JSON.parse(started.body) as { code: string }).code;
      const before = structuredClone([...h.table.rows.entries()]);
      const res = await h.claim(code, 'sarahs-token');
      expect(res.statusCode).toBe(403);
      expect(res.body).toBe('television_cannot_prove_itself');
      expect([...h.table.rows.entries()]).toEqual(before);
      expect((await h.poll(code)).body).toEqual({ status: 'pending' });
    }
    // One that keeps a secret is connected as ever.
    expect((await h.claim((JSON.parse((await h.start({ deviceId: 'wick-vega', keeps: true })).body) as { code: string }).code, 'sarahs-token')).statusCode).toBe(200);
  });

  it('cannot be had by somebody who does not hold the code: polling any other code hands over nothing', async () => {
    const h = homes({ secret: false });
    const code = await pairAs(h, { deviceId: 'wick-vega', keeps: true });
    for (const other of ['000000', '999999', `${code}0`]) expect((await h.poll(other)).body).toBeUndefined();
    expect((await h.poll(code)).body?.proof).toMatch(/^[0-9a-f]{64}$/);
  });

  it('asked for with the victim’s id by an attacker: their own home cannot claim it, so no secret is made', async () => {
    const h = homes({ secret: false });
    const started = await h.start({ deviceId: 'tv-1', keeps: true });
    const code = (JSON.parse(started.body) as { code: string }).code;
    expect((await h.claim(code, 'mallorys-token')).statusCode).toBe(409);
    expect((await h.poll(code)).body).toEqual({ status: 'pending' });
    expect(h.victim()).not.toHaveProperty('proofHash');
  });
});
