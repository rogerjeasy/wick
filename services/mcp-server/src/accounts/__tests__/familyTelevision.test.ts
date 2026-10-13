import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { DOOR_ANSWERS, PAIRING_PUBLIC_KEY_ROW, REACH_ANSWERS, familyTvCardId, reachCardId } from '@wick/contracts';
import { reachItem } from '@wick/agent';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { signJwt } from '../../../../edge-device/lambda/jwt.mjs';
import { createMemoryTable } from '../../__tests__/memoryTable.js';
import { LOOK_EVERY_MS } from '../../tools/lookIn.js';
import { createFamilyTelevision } from '../familyTelevision.js';
import { createMemoryStore } from './memoryStore.js';
import {
  HOUR,
  MIN,
  NOW,
  PAIRING,
  PICTURE,
  REACH_ID,
  SARAHS_TV,
  STRANGER,
  b64,
  bearer,
  david,
  homeOf,
  householdRequests,
  keepsRhythmPrivate,
  litToday,
  lookInRow,
  lookRow,
  member,
  putDoorCard,
  putFamilyTv,
  putLook,
  putPublicKey,
  reach,
  sarah,
  storedReach,
  token,
  world,
  type World,
} from './familyTvWorld.js';


describe('who a family television is — the token', () => {
  it('answers the television of a member the resident has allowed', async () => {
    const w = await world();

    const reply = await w.tv.home(bearer());

    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ residentName: 'Margaret', memberName: 'Sarah' });
  });

  it('takes a token exactly as the pairing service signs one (jwt.mjs signJwt)', async () => {
    const w = await world();
    // signJwt stamps the token by the real clock, so this television is asked by it too.
    w.clock = Date.now();
    const jwt = (signJwt as (claims: object, key: string, options: { expiresInSec: number }) => string)(SARAHS_TV, PAIRING.privateKey, { expiresInSec: 3600 });

    expect((await w.tv.home(bearer(jwt))).status).toBe(200);
  });

  it('takes the scheme in any case, as HTTP has it', async () => {
    const w = await world();

    expect((await w.tv.home(`bearer ${token()}`)).status).toBe(200);
  });

  it.each([
    ['no header at all', undefined],
    ['an empty header', ''],
    ['another scheme', `Basic ${token()}`],
    ['no token', 'Bearer '],
    ['two parts', `Bearer ${token().split('.').slice(0, 2).join('.')}`],
    ['four parts', `Bearer ${token()}.extra`],
    ['characters base64url does not have', `Bearer ${token().replace('.', '.+/=')}`],
    ['a header that is not JSON', `Bearer ${Buffer.from('not json').toString('base64url')}.${token().split('.').slice(1).join('.')}`],
    ['a header that is not an object', `Bearer ${b64('RS256')}.${token().split('.').slice(1).join('.')}`],
    ['a token far too long to be one', `Bearer ${token({ ...SARAHS_TV, padding: 'x'.repeat(8192) })}`],
  ])('refuses %s, and reads nothing at all', async (_name, authorization) => {
    const w = await world();

    const reply = await w.tv.home(authorization);

    expect(reply).toMatchObject({ status: 401, body: { error: 'invalid_token' }, reason: authorization ? 'malformed_token' : 'no_token' });
    expect(w.requests).toEqual([]);
    expect(w.storeCalls).toEqual([]);
  });

  it.each([
    ['alg none and no signature', token(SARAHS_TV, { header: { alg: 'none', typ: 'JWT' }, signature: 'none' })],
    ['alg none over a real signature', token(SARAHS_TV, { header: { alg: 'none', typ: 'JWT' } })],
    ['HS256 keyed with the published public key', token(SARAHS_TV, { header: { alg: 'HS256', typ: 'JWT' }, signature: 'hmac-of-public-key' })],
    ['HS256 over a real signature', token(SARAHS_TV, { header: { alg: 'HS256', typ: 'JWT' } })],
    ['RS512 over a real RS256 signature', token(SARAHS_TV, { header: { alg: 'RS512', typ: 'JWT' } })],
    ['PS256 over a real RS256 signature', token(SARAHS_TV, { header: { alg: 'PS256', typ: 'JWT' } })],
    ['rs256 in lower case', token(SARAHS_TV, { header: { alg: 'rs256', typ: 'JWT' } })],
    ['an alg that is a list', token(SARAHS_TV, { header: { alg: ['RS256'], typ: 'JWT' } })],
    ['no alg at all', token(SARAHS_TV, { header: { typ: 'JWT' } })],
  ])('refuses a token whose header says anything but RS256: %s', async (_name, jwt) => {
    const w = await world();

    const reply = await w.tv.home(bearer(jwt));

    expect(reply).toMatchObject({ status: 401, body: { error: 'invalid_token' }, reason: 'bad_alg' });
    // Decided on the header alone: not even the key is fetched for it.
    expect(w.requests).toEqual([]);
    expect(w.storeCalls).toEqual([]);
  });

  it('refuses a header that names extensions it must understand (crit)', async () => {
    const w = await world();

    const reply = await w.tv.home(bearer(token(SARAHS_TV, { header: { alg: 'RS256', typ: 'JWT', crit: ['exp'] } })));

    expect(reply).toMatchObject({ status: 401, reason: 'malformed_token' });
    expect(w.requests).toEqual([]);
  });

  it('refuses a token signed with any key but the pairing key', async () => {
    const w = await world();

    const reply = await w.tv.home(bearer(token(SARAHS_TV, { signedWith: STRANGER.privateKey })));

    expect(reply).toMatchObject({ status: 401, body: { error: 'invalid_token' }, reason: 'bad_signature' });
    expect(householdRequests(w)).toEqual([]);
    expect(w.storeCalls).toEqual([]);
  });

  it('refuses a token whose claims were changed after it was signed', async () => {
    const w = await world();
    putFamilyTv(w.table, { householdId: 'hh-2', deviceId: 'tv-sarah', userId: 'u_tom' });
    const [header, , signature] = token().split('.');
    const forged = `${header}.${b64({ ...SARAHS_TV, householdId: 'hh-2', userId: 'u_tom', iat: 0, exp: Math.floor(NOW / 1000) + 3600 })}.${signature}`;

    const reply = await w.tv.home(bearer(forged));

    expect(reply).toMatchObject({ status: 401, reason: 'bad_signature' });
    expect(householdRequests(w)).toEqual([]);
  });

  it('refuses a token with no signature under RS256', async () => {
    const w = await world();

    const reply = await w.tv.home(bearer(token(SARAHS_TV, { signature: 'none' })));

    expect(reply).toMatchObject({ status: 401, reason: 'bad_signature' });
    expect(householdRequests(w)).toEqual([]);
  });

  it('refuses a token past its time, and says that it is', async () => {
    const w = await world();
    const expired = token(SARAHS_TV, { exp: Math.floor(NOW / 1000) - 1 });

    const reply = await w.tv.home(bearer(expired));

    expect(reply).toMatchObject({ status: 401, body: { error: 'token_expired' }, reason: 'expired' });
    expect(householdRequests(w)).toEqual([]);
    expect(w.storeCalls).toEqual([]);
  });

  it('is refused from the very second it expires', async () => {
    const w = await world();
    const exp = Math.floor(NOW / 1000) + 30;
    const jwt = token(SARAHS_TV, { exp });

    w.clock = exp * 1000 - 1;
    expect((await w.tv.home(bearer(jwt))).status).toBe(200);
    w.clock = exp * 1000;
    expect(await w.tv.home(bearer(jwt))).toMatchObject({ status: 401, reason: 'expired' });
  });

  it.each([
    ['none', null],
    ['one in words', '9999999999'],
    ['one that is not a number', Number.NaN],
  ])('refuses a token that does not say when it expires: %s', async (_name, exp) => {
    const w = await world();

    const reply = await w.tv.home(bearer(token(SARAHS_TV, { exp })));

    expect(reply).toMatchObject({ status: 401, body: { error: 'invalid_token' }, reason: 'malformed_token' });
    expect(householdRequests(w)).toEqual([]);
  });
});

describe('who a family television is — the pairing key', () => {
  it('refuses everything while no key is published — it never falls back to an unchecked token', async () => {
    const w = await world({ publicKey: false });

    for (const jwt of [token(), token(SARAHS_TV, { signedWith: STRANGER.privateKey }), token(SARAHS_TV, { header: { alg: 'none' }, signature: 'none' })]) {
      expect(await w.tv.home(bearer(jwt))).toMatchObject({ status: 401, body: { error: 'invalid_token' } });
      expect(await w.tv.press(bearer(jwt), { cardId: familyTvCardId('door_look', 'door-abc'), action: 'known' })).toMatchObject({ status: 401 });
    }
    expect(await w.tv.home(bearer())).toMatchObject({ reason: 'no_key' });
    expect(householdRequests(w)).toEqual([]);
    expect(w.storeCalls).toEqual([]);
  });

  it('refuses everything when what is published is not a key', async () => {
    const w = await world({ publicKey: false });
    putPublicKey(w.table, 'not a key');

    expect(await w.tv.home(bearer())).toMatchObject({ status: 401, body: { error: 'invalid_token' }, reason: 'no_key' });
    expect(householdRequests(w)).toEqual([]);
  });

  it('refuses to work from a private key, should one ever be published in its place', async () => {
    const w = await world({ publicKey: false });
    putPublicKey(w.table, PAIRING.privateKey);

    expect(await w.tv.home(bearer())).toMatchObject({ status: 401, reason: 'no_key' });
  });

  it('refuses a key that is not an RSA key', async () => {
    const w = await world({ publicKey: false });
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256', publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    putPublicKey(w.table, ec.publicKey);

    expect(await w.tv.home(bearer())).toMatchObject({ status: 401, reason: 'no_key' });
  });

  it('answers once the first family television is connected and the key is published', async () => {
    const w = await world({ publicKey: false });
    expect((await w.tv.home(bearer())).status).toBe(401);

    putPublicKey(w.table);
    w.clock += MIN;

    expect((await w.tv.home(bearer(token(SARAHS_TV, { exp: Math.floor(w.clock / 1000) + 60 })))).status).toBe(200);
  });

  it('does not ask the table for a missing key on every request', async () => {
    const w = await world({ publicKey: false });

    for (let i = 0; i < 20; i += 1) await w.tv.home(bearer());

    expect(w.requests.filter((r) => r.pk === PAIRING_PUBLIC_KEY_ROW.pk)).toHaveLength(1);
  });

  it('keeps the key for a few minutes, then reads it again', async () => {
    const w = await world();
    const keyReads = () => w.requests.filter((r) => r.pk === PAIRING_PUBLIC_KEY_ROW.pk && r.sk === PAIRING_PUBLIC_KEY_ROW.sk).length;

    for (let i = 0; i < 20; i += 1) {
      w.clock += 8_000;
      await w.tv.home(bearer());
    }
    expect(keyReads()).toBe(1);

    w.clock += 5 * MIN;
    await w.tv.home(bearer());
    expect(keyReads()).toBe(2);
  });

  it('takes the key in either form it is written in (SPKI or PKCS#1)', async () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const w = await world({ publicKey: false });
    putPublicKey(w.table, pair.publicKey.export({ type: 'pkcs1', format: 'pem' }).toString());
    const jwt = token(SARAHS_TV, { signedWith: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });

    expect((await w.tv.home(bearer(jwt))).status).toBe(200);
  });
});

describe('who a family television is — the television', () => {
  it('refuses the resident’s own television: 403, and nothing is read', async () => {
    const w = await world();
    // Margaret's television: a DEV# row, and a token with no kind and no member.
    w.table.put({ pk: { S: 'HH#hh-1' }, sk: { S: 'DEV#wick-tv' }, deviceId: { S: 'wick-tv' }, denylisted: { BOOL: false } });
    const residents = token({ deviceId: 'wick-tv', householdId: 'hh-1' });

    const home = await w.tv.home(bearer(residents));
    const press = await w.tv.press(bearer(residents), { cardId: familyTvCardId('door_look', 'door-abc'), action: 'known' });

    expect(home).toMatchObject({ status: 403, body: { error: 'not_a_family_television' }, reason: 'not_family' });
    expect(press).toMatchObject({ status: 403, body: { error: 'not_a_family_television' } });
    expect(householdRequests(w)).toEqual([]);
    expect(w.storeCalls).toEqual([]);
  });

  it.each([
    ['another kind', { deviceId: 'tv-sarah', householdId: 'hh-1', kind: 'resident', userId: 'u_sarah' }],
    ['no member', { deviceId: 'tv-sarah', householdId: 'hh-1', kind: 'family' }],
    ['an empty member', { deviceId: 'tv-sarah', householdId: 'hh-1', kind: 'family', userId: '' }],
    ['no household', { deviceId: 'tv-sarah', kind: 'family', userId: 'u_sarah' }],
    ['a member that is not a string', { deviceId: 'tv-sarah', householdId: 'hh-1', kind: 'family', userId: { S: 'u_sarah' } }],
  ])('refuses a signed token that is not a family television’s: %s', async (_name, claims) => {
    const w = await world();

    const reply = await w.tv.home(bearer(token(claims)));

    expect(reply).toMatchObject({ status: 403, reason: 'not_family' });
    expect(householdRequests(w)).toEqual([]);
    expect(w.storeCalls).toEqual([]);
  });

  it('reads the television’s own row consistently, and no other, before it knows whose it is', async () => {
    const w = await world({ familyTv: false });

    const reply = await w.tv.home(bearer());

    expect(reply).toMatchObject({ status: 401, body: { error: 'television_not_connected' }, reason: 'no_row' });
    expect(householdRequests(w)).toEqual([{ command: 'GetItemCommand', pk: 'HH#hh-1', sk: 'FTV#tv-sarah', consistent: true }]);
    expect(w.storeCalls).toEqual([]);
  });

  it('refuses a television that has been removed, on its very next question', async () => {
    const w = await world();
    expect((await w.tv.home(bearer())).status).toBe(200);

    // The same television, the same token, the row gone.
    await w.table.ddb.send(new DeleteItemCommand({ TableName: 'wick', Key: { pk: { S: 'HH#hh-1' }, sk: { S: 'FTV#tv-sarah' } } }));

    expect(await w.tv.home(bearer())).toMatchObject({ status: 401, body: { error: 'television_not_connected' }, reason: 'no_row' });
    expect(await w.tv.press(bearer(), { cardId: familyTvCardId('door_look', 'door-abc'), action: 'known' })).toMatchObject({ status: 401 });
  });

  it.each([
    ['revoked (denylisted)', { BOOL: true }],
    ['marked in some way that is not a plain "not revoked"', { S: 'true' }],
  ])('refuses a television that has been %s', async (_name, denylisted) => {
    const w = await world({ familyTv: false });
    w.table.put({ pk: { S: 'HH#hh-1' }, sk: { S: 'FTV#tv-sarah' }, deviceId: { S: 'tv-sarah' }, householdId: { S: 'hh-1' }, userId: { S: 'u_sarah' }, denylisted });

    const reply = await w.tv.home(bearer());

    expect(reply).toMatchObject({ status: 401, body: { error: 'television_not_connected' }, reason: 'denylisted' });
    expect(householdRequests(w)).toHaveLength(1);
    expect(w.storeCalls).toEqual([]);
  });

  it('refuses a token whose member is not the one the television was connected by', async () => {
    const w = await world({ familyTv: false });
    // The television is David's; the token says Sarah.
    putFamilyTv(w.table, { userId: 'u_david' });

    const reply = await w.tv.home(bearer());

    expect(reply).toMatchObject({ status: 401, body: { error: 'television_not_connected' }, reason: 'not_this_members' });
    expect(householdRequests(w)).toHaveLength(1);
    expect(w.storeCalls).toEqual([]);
  });

  it('refuses a row that does not say whose television it is', async () => {
    const w = await world({ familyTv: false });
    w.table.put({ pk: { S: 'HH#hh-1' }, sk: { S: 'FTV#tv-sarah' }, deviceId: { S: 'tv-sarah' }, denylisted: { BOOL: false } });

    expect(await w.tv.home(bearer())).toMatchObject({ status: 401, reason: 'not_this_members' });
  });

  it('is not made a family television by the resident’s television having that id', async () => {
    const w = await world({ familyTv: false });
    w.table.put({ pk: { S: 'HH#hh-1' }, sk: { S: 'DEV#tv-sarah' }, deviceId: { S: 'tv-sarah' }, userId: { S: 'u_sarah' }, denylisted: { BOOL: false } });

    expect(await w.tv.home(bearer())).toMatchObject({ status: 401, reason: 'no_row' });
  });

  it('is a television of the home in its token, and of no other', async () => {
    const w = await world();
    // The same device id is connected in Edith's home too — by Tom.
    putFamilyTv(w.table, { householdId: 'hh-2', userId: 'u_tom' });

    await w.tv.home(bearer());

    expect(householdRequests(w).map((r) => r.pk).filter((pk) => pk !== 'HH#hh-1')).toEqual([]);
  });
});

describe('INV-9 — the circle is asked again on every call', () => {
  it.each([
    ['still waiting for the resident', { status: 'pending' as const }, 'Margaret hasn’t allowed this yet. A card is waiting on the television, and it only takes one press.'],
    ['turned down', { status: 'declined' as const }, 'Margaret chose not to share this with you.'],
    ['removed', { status: 'removed' as const }, 'You are no longer part of this family circle.'],
  ])('refuses somebody %s, in the words the tools use', async (_name, sarahIs, sentence) => {
    const w = await world({ sarah: sarahIs });
    putDoorCard(w.table, 'door-abc', { imageRef: PICTURE });
    putLook(w.table, 'door-abc', NOW - 30_000);

    const home = await w.tv.home(bearer());
    const press = await w.tv.press(bearer(), { cardId: familyTvCardId('door_look', 'door-abc'), action: 'known' });

    expect(home).toEqual({ status: 403, body: { error: 'not_allowed', say: sentence }, reason: 'not_allowed' });
    expect(press).toEqual({ status: 403, body: { error: 'not_allowed', say: sentence }, reason: 'not_allowed' });
    // Its own row, and nothing else of the household's.
    expect(householdRequests(w).map((r) => r.sk)).toEqual(['FTV#tv-sarah', 'FTV#tv-sarah']);
    expect(lookRow(w.table, 'door-abc')?.answeredAt).toBeUndefined();
    expect(w.patches).toEqual([]);
  });

  it('refuses somebody who is not in the circle at all', async () => {
    const w = await world({ familyTv: false });
    putFamilyTv(w.table, { deviceId: 'tv-nobody', userId: 'u_nobody' });

    const reply = await w.tv.home(bearer(token({ deviceId: 'tv-nobody', householdId: 'hh-1', kind: 'family', userId: 'u_nobody' })));

    expect(reply).toEqual({ status: 403, body: { error: 'not_allowed', say: 'You are not part of this family circle.' }, reason: 'not_allowed' });
  });

  it('counts a removal on the very next question', async () => {
    const w = await world();
    expect((await w.tv.home(bearer())).status).toBe(200);

    await w.store.setMemberStatus('hh-1', 'u_sarah', 'removed', NOW);

    expect((await w.tv.home(bearer())).status).toBe(403);
  });

  it('shows a neighbour nothing, and says what a neighbour is for', async () => {
    const w = await world({ sarah: { role: 'neighbour' } });
    litToday(w.table);
    putDoorCard(w.table, 'door-abc', { imageRef: PICTURE });
    putLook(w.table, 'door-abc', NOW - 30_000);
    const sentence = 'Margaret has asked you to help in two ways: to look at who is at the door, and to ring when asked. Nothing else about the house is shared with a neighbour.';

    const home = await w.tv.home(bearer());
    const press = await w.tv.press(bearer(), { cardId: familyTvCardId('door_look', 'door-abc'), action: 'known' });

    expect(home).toEqual({ status: 403, body: { error: 'not_allowed', say: sentence }, reason: 'neighbour' });
    expect(press).toEqual({ status: 403, body: { error: 'not_allowed', say: sentence }, reason: 'neighbour' });
    expect(householdRequests(w).map((r) => r.sk)).toEqual(['FTV#tv-sarah', 'FTV#tv-sarah']);
    expect(w.homes).toEqual([]);
    expect(w.patches).toEqual([]);
  });
});

describe('GET /tv/home', () => {
  it('names the home and the member, by the first name the resident knows them by', async () => {
    const w = await world();

    expect(await homeOf(w)).toEqual({
      residentName: 'Margaret',
      memberName: 'Sarah',
      light: { lit: false, line: 'The light isn’t on at Margaret’s. It may not be lit yet today, or Margaret may have put it out.' },
      cards: [],
      wave: { label: 'Wave to Margaret', cardId: 'ftv-wave-new' },
    });
  });

  it('says a demo home is one', async () => {
    expect((await homeOf(await world({ simulated: true }))).simulated).toBe(true);
    expect(await homeOf(await world())).not.toHaveProperty('simulated');
  });

  describe('the light in the window', () => {
    it('is lit once her day has begun, in the one sentence get_light gives', async () => {
      const w = await world();
      litToday(w.table);

      expect((await homeOf(w)).light).toEqual({ lit: true, line: 'The light is on at Margaret’s: the day has begun there.' });
    });

    it('looks the same when she has put it out as when it was never lit', async () => {
      const never = await world();
      const out = await world();
      litToday(out.table);
      out.table.put({ pk: { S: 'HH#hh-1' }, sk: { S: 'LIGHT' }, outAt: { N: String(NOW - 30 * MIN) } });

      expect(JSON.stringify(await homeOf(out))).toBe(JSON.stringify(await homeOf(never)));
    });

    it('is a look, and she is told who looked in', async () => {
      const w = await world();

      await homeOf(w);

      expect(lookInRow(w.table)).toMatchObject({ name: { S: 'Sarah' }, lookedAt: { N: String(NOW) } });
      expect(w.homes).toHaveLength(1);
      expect(w.homes[0]).toMatchObject({ householdId: 'hh-1', home: { lookedIn: { name: 'Sarah', at: NOW } } });
    });

    it('notes one look, not one for every time the television asks: twenty polls, one row, one push', async () => {
      const w = await world();

      for (let i = 0; i < 20; i += 1) {
        await homeOf(w);
        w.clock += 8_000;
      }

      expect(w.homes).toHaveLength(1);
      expect(lookInRow(w.table)?.lookedAt).toEqual({ N: String(NOW) });
    });

    it('notes a look afresh once the little while has passed', async () => {
      const w = await world();
      await homeOf(w);

      w.clock = NOW + LOOK_EVERY_MS;
      await homeOf(w);

      expect(w.homes).toHaveLength(2);
    });

    it('is not shown, and no look is noted, when she keeps the shape of her day to herself', async () => {
      const w = await world();
      litToday(w.table);
      keepsRhythmPrivate(w.table);

      const home = await homeOf(w);

      expect(home).not.toHaveProperty('light');
      expect(JSON.stringify(home)).not.toMatch(/light/i);
      expect(lookInRow(w.table)).toBeUndefined();
      expect(w.homes).toEqual([]);
      // Nothing of her day was read either: not her televisions, not the light's own row.
      expect(householdRequests(w).map((r) => r.sk)).not.toEqual(expect.arrayContaining(['DEV#']));
      expect(householdRequests(w).map((r) => r.sk)).not.toEqual(expect.arrayContaining(['LIGHT']));
    });

    it('is still answered when the look could not be noted', async () => {
      const w = await world();
      litToday(w.table);
      w.before((request) => {
        if (request.command === 'UpdateItemCommand' && request.sk === 'LOOKIN#u_sarah') throw Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' });
      });

      expect((await homeOf(w)).light).toEqual({ lit: true, line: 'The light is on at Margaret’s: the day has begun there.' });
    });

    it('is still answered when her television could not be told', async () => {
      const table = createMemoryTable();
      putPublicKey(table);
      putFamilyTv(table);
      const store = createMemoryStore();
      await store.createHousehold({ householdId: 'hh-1', name: 'Mum’s house', residentName: 'Margaret', createdBy: 'u_sarah', createdAt: 1 });
      await store.putMembership(member());
      const tv = createFamilyTelevision({
        ddb: table.ddb,
        store,
        sendCard: async () => {},
        sendPatch: async () => {},
        withdrawCard: async () => {},
        sendHome: async () => {
          throw new Error('television is off');
        },
        now: () => NOW,
      });

      expect((await tv.home(bearer())).status).toBe(200);
    });

    it('is answered with no sender for her home screen at all: the look is kept for when her television next connects', async () => {
      const table = createMemoryTable();
      putPublicKey(table);
      putFamilyTv(table);
      const store = createMemoryStore();
      await store.createHousehold({ householdId: 'hh-1', name: 'Mum’s house', residentName: 'Margaret', createdBy: 'u_sarah', createdAt: 1 });
      await store.putMembership(member());
      const tv = createFamilyTelevision({ ddb: table.ddb, store, sendCard: async () => {}, sendPatch: async () => {}, withdrawCard: async () => {}, now: () => NOW });

      expect((await tv.home(bearer())).status).toBe(200);
      expect(lookInRow(table)).toMatchObject({ name: { S: 'Sarah' } });
    });
  });

  describe('a question from the front door', () => {
    it('is a card with the picture, the sentence and the three answers while her question is open', async () => {
      const w = await world();
      putDoorCard(w.table, 'door-abc', { description: 'A man in a yellow jacket holding a clipboard.', imageRef: PICTURE });
      putLook(w.table, 'door-abc', NOW - 30_000);

      expect((await homeOf(w)).cards).toEqual([
        {
          id: 'ftv-door_look-door-abc',
          kind: 'door_look',
          headline: 'Margaret has asked you to look at the door.',
          detail: 'A man in a yellow jacket holding a clipboard.',
          pictureUrl: PICTURE,
          actions: [
            { id: 'known', label: DOOR_ANSWERS.known, kind: 'primary' },
            { id: 'dont_open', label: DOOR_ANSWERS.dont_open, kind: 'secondary' },
            { id: 'not_sure', label: DOOR_ANSWERS.not_sure, kind: 'secondary' },
          ],
        },
      ]);
    });

    it('gives the door card’s own line, and no picture, before the picture and the sentence have arrived', async () => {
      const w = await world();
      putDoorCard(w.table, 'door-abc');
      putLook(w.table, 'door-abc', NOW - 1_000);

      const [card] = (await homeOf(w)).cards;

      expect(card).toMatchObject({ detail: "Someone's at the front door." });
      expect(card).not.toHaveProperty('pictureUrl');
      expect(card!.actions).toHaveLength(3);
    });

    it('shows nothing more to the member who answered: they were told at the press, and telling them again is a second thing to put away', async () => {
      const w = await world();
      putDoorCard(w.table, 'door-abc', { imageRef: PICTURE });
      putLook(w.table, 'door-abc', NOW - 5 * MIN, { answerKey: { S: 'dont_open' }, answeredAt: { N: String(NOW - 2 * MIN) }, answeredBy: { S: 'u_sarah' }, answeredByName: { S: 'Sarah' } });

      expect((await homeOf(w)).cards).toEqual([]);
    });

    it('says who answered when it was somebody else', async () => {
      const w = await world();
      putDoorCard(w.table, 'door-abc', { imageRef: PICTURE });
      putLook(w.table, 'door-abc', NOW - 5 * MIN, { answerKey: { S: 'known' }, answeredAt: { N: String(NOW - MIN) }, answeredBy: { S: 'u_david' }, answeredByName: { S: 'David' } });

      expect((await homeOf(w)).cards).toEqual([
        { id: 'ftv-door_look-door-abc', kind: 'door_look', headline: `David answered: “${DOOR_ANSWERS.known}”`, actions: [] },
      ]);
    });

    it('lets an answer go after ten minutes', async () => {
      const w = await world();
      putDoorCard(w.table, 'door-abc');
      putLook(w.table, 'door-abc', NOW - 20 * MIN, { answerKey: { S: 'known' }, answeredAt: { N: String(NOW - 10 * MIN) }, answeredBy: { S: 'u_sarah' }, answeredByName: { S: 'Sarah' } });

      expect((await homeOf(w)).cards).toEqual([]);
    });

    it('shows nothing once the door card has left her television unanswered', async () => {
      const expired = await world();
      putDoorCard(expired.table, 'door-abc', { imageRef: PICTURE }, NOW - 1);
      putLook(expired.table, 'door-abc', NOW - 10 * MIN);
      const cardless = await world();
      putLook(cardless.table, 'door-abc', NOW - MIN);

      expect((await homeOf(expired)).cards).toEqual([]);
      expect((await homeOf(cardless)).cards).toEqual([]);
      expect(JSON.stringify(await homeOf(expired))).not.toContain(PICTURE);
    });
  });

  describe('a request to ring', () => {
    it('is a card for the person she asked, with the answers that fit and a line that Wick rings nobody', async () => {
      const w = await world();
      w.table.put(reachItem(reach()));

      expect((await homeOf(w)).cards).toEqual([
        {
          id: `ftv-reach-${REACH_ID}`,
          kind: 'reach',
          headline: 'Margaret would like you to ring her.',
          detail: 'This does not make the call. Ring her yourself.',
          actions: [
            { id: 'now', label: REACH_ANSWERS.now, kind: 'primary' },
            { id: 'soon', label: REACH_ANSWERS.soon, kind: 'secondary' },
          ],
        },
      ]);
    });

    it('gives a hello as a hello, with the one thing that can be said back', async () => {
      const w = await world();
      w.table.put(reachItem(reach({ kind: 'hello', order: [sarah] })));

      const [card] = (await homeOf(w)).cards;

      expect(card).toEqual({
        id: `ftv-reach-${REACH_ID}`,
        kind: 'reach',
        headline: 'Margaret says hello.',
        actions: [{ id: 'hello', label: REACH_ANSWERS.hello, kind: 'primary' }],
      });
      expect(card).not.toHaveProperty('detail');
    });

    it('tells somebody not asked nothing at all: the very bytes given when there is no request', async () => {
      const none = await world();
      const notAsked = await world();
      // She asked David first; Sarah's turn has not come.
      notAsked.table.put(reachItem(reach({ order: [david, sarah], asked: 1 })));
      const answeredByDavid = await world();
      answeredByDavid.table.put(reachItem(reach({ order: [david, sarah], asked: 1, answer: { key: 'now', by: 'u_david', byName: 'David', at: NOW - MIN } })));

      const expected = JSON.stringify(await homeOf(none));

      expect(JSON.stringify((await homeOf(none)).cards)).toBe('[]');
      expect(JSON.stringify(await homeOf(notAsked))).toBe(expected);
      expect(JSON.stringify(await homeOf(answeredByDavid))).toBe(expected);
    });

    it('never says who else was asked, how many, or who is next', async () => {
      const w = await world();
      w.table.put(reachItem(reach({ order: [david, sarah, { userId: 'u_tom', name: 'Tom', role: 'neighbour' }], asked: 2 })));

      const body = JSON.stringify(await homeOf(w));

      expect(body).toContain('Margaret would like you to ring her.');
      for (const hidden of ['David', 'Tom', 'u_david', 'u_tom', 'order', 'asked']) expect(body).not.toContain(hidden);
    });

    it('shows nothing more to the member who answered', async () => {
      const w = await world();
      w.table.put(reachItem(reach({ answer: { key: 'soon', by: 'u_sarah', byName: 'Sarah', at: NOW - MIN } })));

      expect((await homeOf(w)).cards).toEqual([]);
    });

    it('says who answered when another person she asked got there first', async () => {
      const w = await world();
      w.table.put(reachItem(reach({ asked: 2, answer: { key: 'now', by: 'u_david', byName: 'David', at: NOW - MIN } })));

      expect((await homeOf(w)).cards).toEqual([
        { id: `ftv-reach-${REACH_ID}`, kind: 'reach', headline: `David answered: “${REACH_ANSWERS.now}”`, actions: [] },
      ]);
    });

    it('lets an answer go after ten minutes', async () => {
      const w = await world();
      w.table.put(reachItem(reach({ askedAt: NOW - 30 * MIN, answer: { key: 'now', by: 'u_sarah', byName: 'Sarah', at: NOW - 10 * MIN } })));

      expect((await homeOf(w)).cards).toEqual([]);
    });
  });

  it('puts what is waiting for an answer first: the door, then the request to ring, then what is settled', async () => {
    const both = await world();
    putDoorCard(both.table, 'door-abc');
    putLook(both.table, 'door-abc', NOW - 30_000);
    both.table.put(reachItem(reach()));
    const settledDoor = await world();
    putDoorCard(settledDoor.table, 'door-abc');
    // Settled by somebody else: a member's own answer is not shown to them again.
    putLook(settledDoor.table, 'door-abc', NOW - 5 * MIN, { answerKey: { S: 'known' }, answeredAt: { N: String(NOW - MIN) }, answeredBy: { S: 'u_david' }, answeredByName: { S: 'David' } });
    settledDoor.table.put(reachItem(reach()));

    expect((await homeOf(both)).cards.map((c) => c.kind)).toEqual(['door_look', 'reach']);
    expect((await homeOf(settledDoor)).cards.map((c) => [c.kind, c.actions.length])).toEqual([['reach', 2], ['door_look', 0]]);
  });

  it('is a handful of reads and one write, all of the home in the token', async () => {
    const w = await world();
    litToday(w.table);
    putDoorCard(w.table, 'door-abc', { imageRef: PICTURE });
    putLook(w.table, 'door-abc', NOW - 30_000);
    w.table.put(reachItem(reach()));

    await homeOf(w);

    const made = householdRequests(w);
    expect(made.every((r) => r.pk === 'HH#hh-1')).toBe(true);
    expect(made.filter((r) => r.command !== 'GetItemCommand' && r.command !== 'QueryCommand')).toEqual([
      { command: 'UpdateItemCommand', pk: 'HH#hh-1', sk: 'LOOKIN#u_sarah', consistent: false },
    ]);
    // The television's own row; what she shares; the look and her light; the door and its card; her weeks; her asking; the films; the wave.
    expect(made.map((r) => `${r.command.replace('Command', '')} ${r.sk}`).sort()).toEqual([
      'GetItem CARD#door-abc',
      'GetItem FTV#tv-sarah',
      'GetItem LIGHT',
      'GetItem META',
      'GetItem WAVE#u_sarah',
      'Query DEV#',
      'Query LOOK#',
      'Query NARR#',
      'Query REACH#',
      'Query WATCH#',
      'UpdateItem LOOKIN#u_sarah',
    ]);
  });
});

describe('POST /tv/press', () => {
  const doorCard = familyTvCardId('door_look', 'door-abc');
  const reachCard = familyTvCardId('reach', REACH_ID);

  const asked = async (): Promise<World> => {
    const w = await world();
    putDoorCard(w.table, 'door-abc', { imageRef: PICTURE });
    putLook(w.table, 'door-abc', NOW - 30_000);
    return w;
  };

  describe('the door', () => {
    it('puts the chosen sentence on her door card, under the member’s first name', async () => {
      const w = await asked();

      const reply = await w.tv.press(bearer(), { cardId: doorCard, action: 'dont_open' });

      expect(reply).toEqual({ status: 200, body: { done: true, say: `It is on the television now: “Sarah says: ${DOOR_ANSWERS.dont_open}”` } });
      expect(w.patches).toEqual([{ householdId: 'hh-1', patch: { cardId: 'door-abc', notice: `Sarah says: ${DOOR_ANSWERS.dont_open}` } }]);
      expect(lookRow(w.table, 'door-abc')).toMatchObject({ answerKey: { S: 'dont_open' }, answeredAt: { N: String(NOW) }, answeredBy: { S: 'u_sarah' }, answeredByName: { S: 'Sarah' } });
    });

    it('then leaves the television’s own home clear: the press was answered in a sentence, and that was the telling', async () => {
      const w = await asked();
      await w.tv.press(bearer(), { cardId: doorCard, action: 'known' });

      expect((await homeOf(w)).cards).toEqual([]);
    });

    it('answers once: a second press is told what was said, and her television is left alone', async () => {
      const w = await asked();
      await w.tv.press(bearer(), { cardId: doorCard, action: 'known' });

      const second = await w.tv.press(bearer(), { cardId: doorCard, action: 'dont_open' });

      expect(second).toEqual({ status: 200, body: { done: false, say: `Sarah has already answered: "${DOOR_ANSWERS.known}"` } });
      expect(w.patches).toHaveLength(1);
      expect(lookRow(w.table, 'door-abc')).toMatchObject({ answerKey: { S: 'known' } });
    });

    it('loses the race gracefully: somebody answered between the read and the write', async () => {
      const w = await asked();
      let raced = false;
      w.before((request) => {
        if (request.command !== 'PutItemCommand' || request.sk !== 'LOOK#door-abc' || raced) return;
        raced = true;
        putLook(w.table, 'door-abc', NOW - 30_000, { answerKey: { S: 'not_sure' }, answeredAt: { N: String(NOW - 1) }, answeredBy: { S: 'u_david' }, answeredByName: { S: 'David' } });
      });

      const reply = await w.tv.press(bearer(), { cardId: doorCard, action: 'known' });

      expect(raced).toBe(true);
      expect(reply).toEqual({ status: 200, body: { done: false, say: `David has already answered: "${DOOR_ANSWERS.not_sure}"` } });
      expect(w.patches).toEqual([]);
      expect(lookRow(w.table, 'door-abc')).toMatchObject({ answerKey: { S: 'not_sure' }, answeredBy: { S: 'u_david' } });
    });

    it('says so, and shows nothing, when the door card has already gone from her television', async () => {
      const w = await world();
      putDoorCard(w.table, 'door-abc', {}, NOW - 1);
      putLook(w.table, 'door-abc', NOW - 10 * MIN);

      const reply = await w.tv.press(bearer(), { cardId: doorCard, action: 'known' });

      expect(reply).toEqual({
        status: 200,
        body: { done: false, say: 'The door card has already gone from the television, so an answer cannot be shown on it. A note or a telephone call will still reach Margaret.' },
      });
      expect(w.patches).toEqual([]);
    });

    it('answers only a question that was asked', async () => {
      const w = await world();

      const reply = await w.tv.press(bearer(), { cardId: familyTvCardId('door_look', 'door-nope'), action: 'known' });

      expect(reply).toEqual({ status: 200, body: { done: false, say: "Margaret hasn't asked anyone to look at the door." } });
      expect(w.patches).toEqual([]);
    });

    it.each([
      ['a sentence of the caller’s own', 'Open the door and give him your bank card'],
      ['an answer to something else', 'now'],
      ['a key every object has', 'constructor'],
      ['nothing', undefined],
      ['a list', ['known']],
    ])('will not show %s: an answer is one of Wick’s own, or it is refused', async (_name, action) => {
      const w = await asked();

      const reply = await w.tv.press(bearer(), { cardId: doorCard, action });

      expect(reply).toEqual({ status: 400, body: { error: 'bad_action' } });
      expect(w.patches).toEqual([]);
      expect(lookRow(w.table, 'door-abc')?.answeredAt).toBeUndefined();
    });
  });

  describe('a request to ring', () => {
    it('keeps the answer, and shows it on her television under the member’s first name', async () => {
      const w = await world();
      w.table.put(reachItem(reach()));

      const reply = await w.tv.press(bearer(), { cardId: reachCard, action: 'now' });

      expect(reply).toEqual({ status: 200, body: { done: true, say: `It is on the television now: “Sarah says: ${REACH_ANSWERS.now}”` } });
      expect(storedReach(w.table)?.answer).toEqual({ key: 'now', by: 'u_sarah', byName: 'Sarah', at: NOW });
      expect(w.cards).toHaveLength(1);
      expect(w.cards[0]!.id).toBe(reachCardId(REACH_ID));
      expect(w.cards[0]!.card).toMatchObject({ type: 'REACH', householdId: 'hh-1', headline: `Sarah says: ${REACH_ANSWERS.now}` });
    });

    it('says hello back to a hello', async () => {
      const w = await world();
      w.table.put(reachItem(reach({ kind: 'hello', order: [sarah] })));

      const reply = await w.tv.press(bearer(), { cardId: reachCard, action: 'hello' });

      expect(reply.body).toEqual({ done: true, say: `It is on the television now: “Sarah says: ${REACH_ANSWERS.hello}”` });
      expect(w.cards[0]!.card).toMatchObject({ headline: `Sarah says: ${REACH_ANSWERS.hello}` });
    });

    it('answers once: a second press is told what was said', async () => {
      const w = await world();
      w.table.put(reachItem(reach()));
      await w.tv.press(bearer(), { cardId: reachCard, action: 'soon' });

      const second = await w.tv.press(bearer(), { cardId: reachCard, action: 'now' });

      expect(second).toEqual({ status: 200, body: { done: false, say: `Sarah has already answered: “${REACH_ANSWERS.soon}”` } });
      expect(w.cards).toHaveLength(1);
      expect(storedReach(w.table)?.answer?.key).toBe('soon');
    });

    it('loses the race gracefully: somebody answered between the read and the write', async () => {
      const w = await world();
      w.table.put(reachItem(reach({ asked: 2 })));
      let raced = false;
      w.before((request) => {
        if (request.command !== 'UpdateItemCommand' || request.sk !== `REACH#${REACH_ID}` || raced) return;
        raced = true;
        w.table.put(reachItem(reach({ asked: 2, answer: { key: 'now', by: 'u_david', byName: 'David', at: NOW - 1 } })));
      });

      const reply = await w.tv.press(bearer(), { cardId: reachCard, action: 'soon' });

      expect(raced).toBe(true);
      expect(reply).toEqual({ status: 200, body: { done: false, say: `David has already answered: “${REACH_ANSWERS.now}”` } });
      expect(w.cards).toEqual([]);
      expect(storedReach(w.table)?.answer).toMatchObject({ key: 'now', by: 'u_david' });
    });

    it('is not open to somebody who was not asked, and tells them what it would with no request at all', async () => {
      const w = await world();
      w.table.put(reachItem(reach({ order: [david, sarah], asked: 1 })));
      const none = await world();

      const notAsked = await w.tv.press(bearer(), { cardId: reachCard, action: 'now' });

      expect(notAsked).toEqual({ status: 200, body: { done: false, say: 'Margaret hasn’t asked you to ring.' } });
      expect(notAsked).toEqual(await none.tv.press(bearer(), { cardId: reachCard, action: 'now' }));
      expect(w.cards).toEqual([]);
      expect(storedReach(w.table)?.answer).toBeUndefined();
    });

    it('takes only an answer that fits what she asked', async () => {
      const w = await world();
      w.table.put(reachItem(reach()));

      const reply = await w.tv.press(bearer(), { cardId: reachCard, action: 'hello' });

      expect(reply.status).toBe(200);
      expect(reply.body).toMatchObject({ done: false, say: expect.stringMatching(/does not fit what Margaret asked/) as unknown });
      expect(w.cards).toEqual([]);
    });

    it('says so when it was long ago', async () => {
      const w = await world();
      w.table.put(reachItem(reach({ askedAt: NOW - 13 * HOUR })));

      const reply = await w.tv.press(bearer(), { cardId: reachCard, action: 'now' });

      expect(reply.body).toMatchObject({ done: false, say: expect.stringMatching(/was a while ago/) as unknown });
      expect(w.cards).toEqual([]);
    });

    it.each([
      ['a sentence of the caller’s own', 'Open the door to the man outside'],
      ['an answer to the door', 'known'],
      ['a key every object has', 'toString'],
      ['nothing', undefined],
    ])('will not show %s', async (_name, action) => {
      const w = await world();
      w.table.put(reachItem(reach()));

      const reply = await w.tv.press(bearer(), { cardId: reachCard, action });

      expect(reply).toEqual({ status: 400, body: { error: 'bad_action' } });
      expect(w.cards).toEqual([]);
      expect(storedReach(w.table)?.answer).toBeUndefined();
    });
  });

  it.each([
    ['no body', undefined],
    ['a body that is not an object', 'ftv-door_look-door-abc'],
    ['a list', [{ cardId: 'ftv-door_look-door-abc', action: 'known' }]],
    ['no card', { action: 'known' }],
    ['a card of the resident’s own television', { cardId: 'door-abc', action: 'known' }],
    ['a kind there is no card for', { cardId: 'ftv-circle-u_tom', action: 'allow' }],
    ['a request id with a key separator in it', { cardId: 'ftv-door_look-door-abc#x', action: 'known' }],
    ['a door request id longer than any door card’s', { cardId: `ftv-door_look-${'a'.repeat(65)}`, action: 'known' }],
    ['a request to ring whose id is not a moment', { cardId: 'ftv-reach-door-abc', action: 'now' }],
    ['a card id that is not a string', { cardId: { kind: 'door_look', requestId: 'door-abc' }, action: 'known' }],
  ])('answers 400 bad_card to %s, and touches nothing of the household’s', async (_name, body) => {
    const w = await asked();
    w.table.put(reachItem(reach()));

    const reply = await w.tv.press(bearer(), body);

    expect(reply).toEqual({ status: 400, body: { error: 'bad_card' } });
    // The television's own row, to know who is asking, and not one request more.
    expect(householdRequests(w).map((r) => r.sk)).toEqual(['FTV#tv-sarah']);
    expect(w.patches).toEqual([]);
    expect(w.cards).toEqual([]);
  });

  it('INV-8: a household or a member named in the body is not read — the press is the token’s', async () => {
    const w = await asked();
    // Edith's home has the same door card id open, and Tom is allowed there.
    putDoorCard(w.table, 'door-abc', {}, NOW + 4 * MIN, 'hh-2');
    putLook(w.table, 'door-abc', NOW - 30_000, {}, 'hh-2');

    const reply = await w.tv.press(bearer(), { cardId: doorCard, action: 'known', householdId: 'hh-2', userId: 'u_tom', memberName: 'Tom', deviceId: 'tv-tom', kind: 'resident' });

    expect(reply.body).toEqual({ done: true, say: `It is on the television now: “Sarah says: ${DOOR_ANSWERS.known}”` });
    expect(w.patches).toEqual([{ householdId: 'hh-1', patch: { cardId: 'door-abc', notice: `Sarah says: ${DOOR_ANSWERS.known}` } }]);
    expect(lookRow(w.table, 'door-abc', 'hh-1')).toMatchObject({ answeredBy: { S: 'u_sarah' } });
    expect(lookRow(w.table, 'door-abc', 'hh-2')?.answeredAt).toBeUndefined();
    expect(householdRequests(w).every((r) => r.pk === 'HH#hh-1')).toBe(true);
    expect(w.storeCalls).toEqual(['getMembership', 'getHousehold']);
  });

  it('a press does nothing for anyone who is not let in', async () => {
    const w = await asked();
    w.table.put(reachItem(reach()));
    const refused: [string, number][] = [
      ['', 401],
      [bearer(token(SARAHS_TV, { signedWith: STRANGER.privateKey })), 401],
      [bearer(token(SARAHS_TV, { header: { alg: 'none' }, signature: 'none' })), 401],
      [bearer(token(SARAHS_TV, { exp: Math.floor(NOW / 1000) - 1 })), 401],
      [bearer(token({ deviceId: 'tv-sarah', householdId: 'hh-1' })), 403],
      [bearer(token({ ...SARAHS_TV, deviceId: 'tv-unknown' })), 401],
      [bearer(token({ ...SARAHS_TV, userId: 'u_david' })), 401],
    ];

    for (const [authorization, status] of refused) {
      expect((await w.tv.press(authorization, { cardId: doorCard, action: 'known' })).status).toBe(status);
      expect((await w.tv.press(authorization, { cardId: reachCard, action: 'now' })).status).toBe(status);
    }

    expect(w.patches).toEqual([]);
    expect(w.cards).toEqual([]);
    expect(lookRow(w.table, 'door-abc')?.answeredAt).toBeUndefined();
    expect(storedReach(w.table)?.answer).toBeUndefined();
    expect(w.storeCalls).toEqual([]);
    // Only a television's own row was ever asked for.
    expect(householdRequests(w).every((r) => r.sk.startsWith('FTV#'))).toBe(true);
  });
});

describe('when authentication fails, nothing of the household’s is read', () => {
  it('reads the published key at most, for every token that does not verify as a family television’s', async () => {
    const w = await world();
    litToday(w.table);
    putDoorCard(w.table, 'door-abc', { imageRef: PICTURE });
    putLook(w.table, 'door-abc', NOW - 30_000);
    w.table.put(reachItem(reach()));
    const unverified = [
      undefined,
      'Bearer nonsense',
      bearer(token(SARAHS_TV, { header: { alg: 'none' }, signature: 'none' })),
      bearer(token(SARAHS_TV, { header: { alg: 'HS256' }, signature: 'hmac-of-public-key' })),
      bearer(token(SARAHS_TV, { signedWith: STRANGER.privateKey })),
      bearer(token(SARAHS_TV, { exp: Math.floor(NOW / 1000) - 1 })),
      bearer(token(SARAHS_TV, { exp: null })),
      bearer(token({ deviceId: 'wick-tv', householdId: 'hh-1' })),
    ];

    for (const authorization of unverified) {
      const reply = await w.tv.home(authorization);
      expect([401, 403]).toContain(reply.status);
      expect(JSON.stringify(reply.body)).not.toMatch(/Margaret|Sarah|light|cards/);
    }

    expect(householdRequests(w)).toEqual([]);
    expect(w.requests.length).toBeLessThanOrEqual(1);
    expect(w.storeCalls).toEqual([]);
    expect(w.homes).toEqual([]);
    expect(lookInRow(w.table)).toBeUndefined();
  });

  it('never puts a token, a claim or an id in a refusal', async () => {
    const w = await world({ familyTv: false });
    const jwt = token();

    const body = JSON.stringify((await w.tv.home(bearer(jwt))).body);

    for (const secret of [jwt, 'hh-1', 'u_sarah', 'tv-sarah']) expect(body).not.toContain(secret);
  });
});
