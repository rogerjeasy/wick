import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { LinkError, createLinkService } from '../household-link-service.mjs';
import {
  PLAYGROUND_TOKEN_MS,
  linkSummary,
  linkedHouseholdsPage,
  householdOfLinkRow,
  pastedTokenExpiry,
  touchLinkExpiry,
  // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
} from '../household-links.mjs';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { tokenSecretId } from '../ring-token.mjs';

const NOW = 1_760_000_000_000;
const PLAYGROUND_TOKEN = 'playground-token-0123456789abcdef';
const CAMERA = { id: 'ava1.ring.device.PLAYGROUND', name: 'Front Door' };
const OAUTH_TOKEN = 'oauth-access-token-0123456789abcdef';

type Item = Record<string, { S?: string; N?: string; BOOL?: boolean }>;

/** A table that honours the two conditions the service relies on, and nothing more. */
function fakeTable() {
  const items = new Map<string, Item>();
  const keyOf = (k: Item) => `${k.pk!.S}|${k.sk!.S}`;
  const fail = () => Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });
  const ddb = async (command: string, input: { Key?: Item; Item?: Item; ConditionExpression?: string; ExpressionAttributeValues?: Record<string, { S?: string }> }) => {
    if (command === 'get') return { Item: items.get(keyOf(input.Key!)) };
    if (command === 'put') {
      const existing = items.get(keyOf(input.Item!));
      if (input.ConditionExpression && existing && existing.householdId?.S !== input.ExpressionAttributeValues![':hh']!.S) throw fail();
      items.set(keyOf(input.Item!), input.Item!);
      return {};
    }
    const existing = items.get(keyOf(input.Key!));
    if (input.ConditionExpression && existing?.householdId?.S !== input.ExpressionAttributeValues![':hh']!.S) throw fail();
    items.delete(keyOf(input.Key!));
    return {};
  };
  return { items, ddb, holderOf: (deviceId: string) => items.get(`RINGDEV#${deviceId}|META`)?.householdId?.S };
}

/** Everything the service is given, with Ring answering each token with the devices listed for it. */
function harness(options: { devicesByToken?: Record<string, { id: string; name: string | null }[]>; playgroundAllowed?: boolean } = {}) {
  const table = fakeTable();
  const secrets = new Map<string, Record<string, unknown>>();
  const devicesByToken = options.devicesByToken ?? { [PLAYGROUND_TOKEN]: [CAMERA] };
  const listDevices = vi.fn(async ({ accessToken }: { accessToken: string }) => {
    const devices = devicesByToken[accessToken];
    if (!devices) throw Object.assign(new Error('devices_failed'), { status: 401 });
    return devices;
  });
  const exchange = vi.fn(async ({ code }: { code: string; codeVerifier: string }) => {
    if (code !== 'ring-code-1') throw Object.assign(new Error('token_exchange_failed'), { status: 400 });
    return { access_token: OAUTH_TOKEN, refresh_token: 'refresh-0123456789' };
  });
  const service = createLinkService({
    table: 'wick',
    ddb: table.ddb,
    writeTokens: async (householdId: string, record: Record<string, unknown>) => {
      secrets.set(tokenSecretId(householdId), record);
      return record;
    },
    deleteTokens: async (householdId: string) => {
      secrets.delete(tokenSecretId(householdId));
    },
    listDevices,
    beginAuthorization: async ({ householdId, userId }: { householdId: string; userId?: string }) => `https://ring.test/authorize?for=${householdId}&by=${userId}`,
    exchange,
    finishLink: async (householdId: string, tokens: Record<string, unknown>) => {
      const record = { ...tokens, source: 'oauth' };
      secrets.set(tokenSecretId(householdId), record);
      return { record };
    },
    playgroundAllowed: options.playgroundAllowed ?? true,
    now: () => NOW,
  });
  return { service, table, secrets, listDevices, exchange };
}

describe('a household that has not connected Ring', () => {
  it('is simply not linked, and is told whether a Playground token may be used', async () => {
    const { service } = harness();

    expect(await service.status('hh_a')).toEqual({ linked: false, playgroundAllowed: true });
  });
});

describe('connecting with a Playground token', () => {
  it('keeps the token in that household\'s own secret and takes the camera for it', async () => {
    const { service, secrets, table } = harness();

    const status = await service.playground('hh_a', 'user_sarah', PLAYGROUND_TOKEN);

    expect([...secrets.keys()]).toEqual(['wick/ring/tokens/hh_a']);
    expect(secrets.get('wick/ring/tokens/hh_a')).toMatchObject({ access_token: PLAYGROUND_TOKEN, source: 'playground', obtainedAt: NOW });
    expect(table.holderOf(CAMERA.id)).toBe('hh_a');
    expect(status).toMatchObject({ linked: true, source: 'playground', simulated: true, refreshable: false, devices: [CAMERA], heldElsewhere: 0 });
  });

  it('says how long the pasted token lasts, and that it cannot be refreshed', async () => {
    const { service } = harness();

    const status = await service.playground('hh_a', 'user_sarah', PLAYGROUND_TOKEN);

    expect(status.expiresAt).toBe(NOW + PLAYGROUND_TOKEN_MS);
    expect(status.expired).toBe(false);
  });

  it('never puts the token, or any part of it, in the row the family app reads', async () => {
    const { service, table } = harness();

    const status = await service.playground('hh_a', 'user_sarah', PLAYGROUND_TOKEN);

    expect(JSON.stringify([...table.items.values()])).not.toContain(PLAYGROUND_TOKEN);
    expect(JSON.stringify(status)).not.toContain(PLAYGROUND_TOKEN);
  });

  it('asks Ring first, and keeps nothing of a token Ring refuses', async () => {
    const { service, secrets, table } = harness();

    await expect(service.playground('hh_a', 'user_sarah', 'a-token-ring-has-never-seen')).rejects.toMatchObject({ code: 'token_refused' });

    expect(secrets.size).toBe(0);
    expect(table.items.size).toBe(0);
  });

  it('refuses something that is not a token before asking anyone', async () => {
    const { service, listDevices } = harness();

    for (const bad of ['', 'short', 'two words are not a token at all', undefined, 42]) {
      await expect(service.playground('hh_a', 'user_sarah', bad), String(bad)).rejects.toMatchObject({ code: 'bad_token' });
    }
    expect(listDevices).not.toHaveBeenCalled();
  });

  it('is refused outright where the deployment does not allow it', async () => {
    const { service, listDevices, secrets } = harness({ playgroundAllowed: false });

    await expect(service.playground('hh_a', 'user_sarah', PLAYGROUND_TOKEN)).rejects.toBeInstanceOf(LinkError);
    await expect(service.playground('hh_a', 'user_sarah', PLAYGROUND_TOKEN)).rejects.toMatchObject({ code: 'playground_not_allowed' });

    expect(listDevices).not.toHaveBeenCalled();
    expect(secrets.size).toBe(0);
  });
});

describe('two households', () => {
  const OTHER_TOKEN = 'another-accounts-token-0123456789';

  it('each hold their own credential and their own doorbell', async () => {
    const kitchen = { id: 'ava1.ring.device.KITCHEN', name: 'Back Door' };
    const { service, secrets, table } = harness({ devicesByToken: { [PLAYGROUND_TOKEN]: [CAMERA], [OTHER_TOKEN]: [kitchen] } });

    await service.playground('hh_a', 'user_sarah', PLAYGROUND_TOKEN);
    await service.playground('hh_b', 'user_tom', OTHER_TOKEN);

    expect(secrets.get('wick/ring/tokens/hh_a')?.access_token).toBe(PLAYGROUND_TOKEN);
    expect(secrets.get('wick/ring/tokens/hh_b')?.access_token).toBe(OTHER_TOKEN);
    expect(table.holderOf(CAMERA.id)).toBe('hh_a');
    expect(table.holderOf(kitchen.id)).toBe('hh_b');
    expect((await service.status('hh_a')).devices).toEqual([CAMERA]);
    expect((await service.status('hh_b')).devices).toEqual([kitchen]);
  });

  it('cannot both take one doorbell: the second is linked, told one is held elsewhere, and gets no camera', async () => {
    const { service, table } = harness({ devicesByToken: { [PLAYGROUND_TOKEN]: [CAMERA], [OTHER_TOKEN]: [CAMERA] } });

    await service.playground('hh_a', 'user_sarah', PLAYGROUND_TOKEN);
    const second = await service.playground('hh_b', 'user_tom', OTHER_TOKEN);

    expect(table.holderOf(CAMERA.id)).toBe('hh_a');
    expect(second).toMatchObject({ linked: true, devices: [], heldElsewhere: 1 });
  });

  it('see only their own link', async () => {
    const { service } = harness();

    await service.playground('hh_a', 'user_sarah', PLAYGROUND_TOKEN);

    expect(await service.status('hh_b')).toEqual({ linked: false, playgroundAllowed: true });
  });
});

describe('disconnecting', () => {
  it('lets the doorbell go, deletes the secret and removes the row', async () => {
    const { service, secrets, table } = harness();
    await service.playground('hh_a', 'user_sarah', PLAYGROUND_TOKEN);

    const status = await service.disconnect('hh_a');

    expect(status).toEqual({ linked: false, playgroundAllowed: true });
    expect(secrets.size).toBe(0);
    expect(table.items.size).toBe(0);
  });

  it('frees the doorbell for another household to connect', async () => {
    const { service, table } = harness({ devicesByToken: { [PLAYGROUND_TOKEN]: [CAMERA] } });
    await service.playground('hh_a', 'user_sarah', PLAYGROUND_TOKEN);
    await service.disconnect('hh_a');

    await service.playground('hh_b', 'user_tom', PLAYGROUND_TOKEN);

    expect(table.holderOf(CAMERA.id)).toBe('hh_b');
  });

  it('never releases a doorbell another household has come to hold', async () => {
    const { service, table } = harness();
    await service.playground('hh_a', 'user_sarah', PLAYGROUND_TOKEN);
    // The operator moved the camera to another home after hh_a linked.
    table.items.set(`RINGDEV#${CAMERA.id}|META`, { pk: { S: `RINGDEV#${CAMERA.id}` }, sk: { S: 'META' }, householdId: { S: 'hh_b' } });

    await service.disconnect('hh_a');

    expect(table.holderOf(CAMERA.id)).toBe('hh_b');
  });

  it('can be asked twice, and for a household that was never linked', async () => {
    const { service } = harness();

    await expect(service.disconnect('hh_a')).resolves.toEqual({ linked: false, playgroundAllowed: true });
    await expect(service.disconnect('hh_a')).resolves.toEqual({ linked: false, playgroundAllowed: true });
  });
});

describe('connecting through Ring\'s sign-in', () => {
  it('starts an authorisation bound to the household and the person who asked', async () => {
    const { service } = harness();

    expect(await service.start('hh_a', 'user_sarah')).toEqual({ url: 'https://ring.test/authorize?for=hh_a&by=user_sarah' });
  });

  it('records a finished link the same way: the devices are claimed and the row says it refreshes', async () => {
    const OAUTH = 'oauth-access-token-0123456789abcdef';
    const { service, table } = harness({ devicesByToken: { [OAUTH]: [CAMERA] } });
    const record = { access_token: OAUTH, refresh_token: 'refresh-0123456789', source: 'oauth', accountId: 'ava1.ring.account.A', expiresAt: NOW + 4 * 3_600_000 };

    const status = await service.recordLink('hh_a', record, 'user_sarah');

    expect(status).toMatchObject({ linked: true, source: 'oauth', simulated: false, refreshable: true, expired: false, devices: [CAMERA] });
    expect(table.holderOf(CAMERA.id)).toBe('hh_a');
    expect(JSON.stringify([...table.items.values()])).not.toContain('refresh-0123456789');
  });

  it('keeps the link when Ring will not list devices just then', async () => {
    const { service } = harness({ devicesByToken: {} });

    const status = await service.recordLink('hh_a', { access_token: 'oauth-access-token-0123456789abcdef', refresh_token: 'r', source: 'oauth' }, 'user_sarah');

    expect(status).toMatchObject({ linked: true, devices: [] });
  });
});

describe('a household id that is not one', () => {
  it('is refused by every action, before anything is read or written', async () => {
    const { service, secrets, table, listDevices } = harness();

    for (const id of ['', '../hh_b', 'hh_a/hh_b', '*', undefined]) {
      await expect(service.status(id), String(id)).rejects.toMatchObject({ code: 'bad_household' });
      await expect(service.start(id, 'u'), String(id)).rejects.toMatchObject({ code: 'bad_household' });
      await expect(service.playground(id, 'u', PLAYGROUND_TOKEN), String(id)).rejects.toMatchObject({ code: 'bad_household' });
      await expect(service.disconnect(id), String(id)).rejects.toMatchObject({ code: 'bad_household' });
    }
    expect(listDevices).not.toHaveBeenCalled();
    expect(secrets.size + table.items.size).toBe(0);
  });
});

describe('what the row says', () => {
  it('calls a pasted token expired once its half hour is up — and a refreshing link never', () => {
    const pasted = { source: { S: 'playground' }, linkedAt: { N: String(NOW) }, expiresAt: { N: String(NOW + 1) }, refreshable: { BOOL: false }, devices: { S: '[]' } };
    const linked = { ...pasted, source: { S: 'oauth' }, refreshable: { BOOL: true } };

    expect(linkSummary(pasted, NOW).expired).toBe(false);
    expect(linkSummary(pasted, NOW + 2).expired).toBe(true);
    expect(linkSummary(linked, NOW + 2).expired).toBe(false);
  });

  it('reads a JWT\'s own expiry, and assumes half an hour for anything else', () => {
    const exp = Math.floor(NOW / 1000) + 600;
    const jwt = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.sig`;

    expect(pastedTokenExpiry(jwt, NOW)).toBe(exp * 1000);
    expect(pastedTokenExpiry('not.a.jwt', NOW)).toBe(NOW + PLAYGROUND_TOKEN_MS);
    expect(pastedTokenExpiry(PLAYGROUND_TOKEN, NOW)).toBe(NOW + PLAYGROUND_TOKEN_MS);
  });

  it('is found by the hourly refresh among every household\'s rows', () => {
    const page = linkedHouseholdsPage({ table: 'wick' });

    expect(page.FilterExpression).toBe('sk = :ring AND begins_with(pk, :hh)');
    expect(householdOfLinkRow({ pk: { S: 'HH#hh_a' } })).toBe('hh_a');
    expect(householdOfLinkRow(undefined)).toBeUndefined();
  });

  it('has its expiry moved on after a refresh, only if the row exists', () => {
    const update = touchLinkExpiry({ table: 'wick', householdId: 'hh_a', expiresAt: NOW + 1000 });

    expect(update.Key).toEqual({ pk: { S: 'HH#hh_a' }, sk: { S: 'RING' } });
    expect(update.ConditionExpression).toBe('attribute_exists(pk)');
  });
});

describe('tokenSecretId', () => {
  it('names one secret per household under the prefix', () => {
    expect(tokenSecretId('hh_a')).toBe('wick/ring/tokens/hh_a');
    expect(tokenSecretId('hh_a', 'wick-dev/ring/tokens')).toBe('wick-dev/ring/tokens/hh_a');
  });

  it('refuses an id that could name another secret', () => {
    for (const id of ['', '../credentials', 'a/b', '*', undefined, 7]) {
      expect(() => tokenSecretId(id), String(id)).toThrow('unsafe_household_id');
    }
  });
});

describe('the start of a Ring sign-in', () => {
  it('remembers the household and the person in the state row, for ten minutes', async () => {
    // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
    const { stateRow, authorizeUrl } = await import('../authorization.mjs');

    const row = stateRow({ table: 'wick', state: 'st4te', verifier: 'v3rifier', householdId: 'hh_a', userId: 'user_sarah', now: NOW });

    expect(row.Item).toMatchObject({ pk: { S: 'OAUTH#st4te' }, householdId: { S: 'hh_a' }, userId: { S: 'user_sarah' }, codeVerifier: { S: 'v3rifier' } });
    expect(Number(row.Item.ttl.N)).toBe(Math.floor(NOW / 1000) + 600);

    const url = new URL(authorizeUrl({ clientId: 'client-1', redirectUri: 'https://wick.test/ring/link', scope: 'ava.v1:read', state: 'st4te', challenge: 'ch4llenge' }));
    expect(url.origin + url.pathname).toBe('https://account.ring.com/account/integrations/partner-link/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'client-1',
      redirect_uri: 'https://wick.test/ring/link',
      response_type: 'code',
      scope: 'ava.v1:read',
      state: 'st4te',
      code_challenge: 'ch4llenge',
      code_challenge_method: 'S256',
    });
    // The household travels in the row, never in the address Ring sends back.
    expect(url.search).not.toContain('hh_a');
  });
});

describe('the hourly refresh, one household at a time', () => {
  const linked = { access_token: 'a', refresh_token: 'r', expiresAt: NOW + 3_600_000 };

  it('refreshes a household that can be refreshed, and moves the row\'s expiry on', async () => {
    // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
    const { refreshHousehold } = await import('../refresh.mjs');
    const recordExpiry = vi.fn(async () => undefined);
    const getAccessToken = vi.fn(async () => 'a');

    const result = await refreshHousehold('hh_a', { readTokens: async () => linked, getAccessToken, recordExpiry });

    expect(result).toMatchObject({ householdId: 'hh_a', ok: true });
    expect(getAccessToken).toHaveBeenCalledWith('hh_a');
    expect(recordExpiry).toHaveBeenCalledWith('hh_a', linked.expiresAt);
  });

  it('skips a pasted Playground token, which has nothing to refresh with', async () => {
    // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
    const { refreshHousehold } = await import('../refresh.mjs');
    const getAccessToken = vi.fn();

    const result = await refreshHousehold('hh_a', { readTokens: async () => ({ access_token: 'p', source: 'playground' }), getAccessToken, recordExpiry: vi.fn() });

    expect(result).toEqual({ householdId: 'hh_a', ok: false, reason: 'no_refresh_token' });
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('reports one household\'s failure without throwing, so the next still gets its turn', async () => {
    // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
    const { refreshHousehold } = await import('../refresh.mjs');

    const result = await refreshHousehold('hh_a', {
      readTokens: async () => linked,
      getAccessToken: async () => {
        throw new Error('refresh_failed');
      },
      recordExpiry: vi.fn(),
    });

    expect(result).toEqual({ householdId: 'hh_a', ok: false, reason: 'refresh_failed' });
  });
});

describe('finishing a sign-in at Ring', () => {
  const COMPLETION = 'c'.repeat(43);

  /**
   * What is in the table once Ring has sent a browser back: the state row
   * authorization.mjs wrote when `startedBy` started the sign-in, and the
   * completion row link.mjs wrote for the browser that came back.
   */
  async function signedInAtRing(table: ReturnType<typeof fakeTable>, startedBy: { householdId: string; userId: string }, code = 'ring-code-1') {
    // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
    const { completionRow, stateRow } = await import('../authorization.mjs');
    table.items.set('OAUTH#state-1|META', stateRow({ table: 'wick', state: 'state-1', verifier: 'verifier-1', ...startedBy, now: NOW }).Item);
    const done = completionRow({ table: 'wick', completion: COMPLETION, state: 'state-1', code, now: NOW }).Item;
    table.items.set(`${done.pk.S}|META`, done);
  }

  const sarah = { householdId: 'hh_a', userId: 'user_sarah' };

  it('links the home for the organiser who started it, and takes its doorbell', async () => {
    const { service, table, secrets, exchange } = harness({ devicesByToken: { [OAUTH_TOKEN]: [CAMERA] } });
    await signedInAtRing(table, sarah);

    const status = await service.complete('hh_a', 'user_sarah', COMPLETION);

    expect(exchange).toHaveBeenCalledWith({ code: 'ring-code-1', codeVerifier: 'verifier-1' });
    expect(secrets.get('wick/ring/tokens/hh_a')).toMatchObject({ access_token: OAUTH_TOKEN, source: 'oauth' });
    expect(status).toMatchObject({ linked: true, source: 'oauth', devices: [CAMERA] });
    expect(table.holderOf(CAMERA.id)).toBe('hh_a');
  });

  it('refuses the organiser of another home: a sign-in someone was sent cannot link their doorbells to the sender\'s home, nor to their own', async () => {
    // Sarah starts a link for hh_a and sends the Ring address to Tom, who
    // signs in with his own Ring account. Tom's browser comes back holding
    // the completion value; Tom's family app is signed in as hh_b's organiser.
    const { service, table, secrets, exchange } = harness({ devicesByToken: { [OAUTH_TOKEN]: [CAMERA] } });
    await signedInAtRing(table, sarah);

    await expect(service.complete('hh_b', 'user_tom', COMPLETION)).rejects.toMatchObject({ code: 'link_not_yours' });

    expect(exchange).not.toHaveBeenCalled();
    expect(secrets.size).toBe(0);
    expect(table.holderOf(CAMERA.id)).toBeUndefined();
  });

  it('refuses another member of the same home: it is the person who started it, not just the home', async () => {
    const { service, table, exchange } = harness();
    await signedInAtRing(table, sarah);

    await expect(service.complete('hh_a', 'user_tom', COMPLETION)).rejects.toMatchObject({ code: 'link_not_yours' });
    expect(exchange).not.toHaveBeenCalled();
  });

  it('is spent by a refused attempt: the starter cannot then finish what someone else signed in to', async () => {
    const { service, table, secrets } = harness({ devicesByToken: { [OAUTH_TOKEN]: [CAMERA] } });
    await signedInAtRing(table, sarah);
    await expect(service.complete('hh_b', 'user_tom', COMPLETION)).rejects.toMatchObject({ code: 'link_not_yours' });

    // Even if Sarah somehow learned the value afterwards.
    await expect(service.complete('hh_a', 'user_sarah', COMPLETION)).rejects.toMatchObject({ code: 'link_expired' });
    expect(secrets.size).toBe(0);
  });

  it('works once: the same value presented again finds nothing', async () => {
    const { service, table, exchange } = harness({ devicesByToken: { [OAUTH_TOKEN]: [CAMERA] } });
    await signedInAtRing(table, sarah);
    await service.complete('hh_a', 'user_sarah', COMPLETION);

    await expect(service.complete('hh_a', 'user_sarah', COMPLETION)).rejects.toMatchObject({ code: 'link_expired' });
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it('knows nothing of a value it never issued, and reads nothing for one that is not the right shape', async () => {
    const { service, table } = harness();
    await signedInAtRing(table, sarah);
    const read = vi.spyOn(table, 'ddb');

    await expect(service.complete('hh_a', 'user_sarah', 'd'.repeat(43))).rejects.toMatchObject({ code: 'link_expired' });
    for (const bad of ['', 'short', '../OAUTH#state-1', undefined, 42, 'x'.repeat(200)]) {
      await expect(service.complete('hh_a', 'user_sarah', bad), String(bad)).rejects.toMatchObject({ code: 'link_expired' });
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps nothing when Ring refuses the code', async () => {
    const { service, table, secrets } = harness();
    await signedInAtRing(table, sarah, 'a-code-ring-will-not-take');

    await expect(service.complete('hh_a', 'user_sarah', COMPLETION)).rejects.toMatchObject({ code: 'exchange_failed' });

    expect(secrets.size).toBe(0);
    expect([...table.items.keys()].filter((k) => k.startsWith('OAUTH'))).toEqual([]);
  });

  it('never stores the completion value itself, only its hash', async () => {
    const { table } = harness();
    await signedInAtRing(table, sarah);

    expect(JSON.stringify([...table.items.entries()])).not.toContain(COMPLETION);
  });
});

describe('what the callback does with a browser Ring sends back', () => {
  const state = (extra: Record<string, { S: string }> = {}, createdAt = NOW) => ({ codeVerifier: { S: 'v' }, createdAt: { N: String(createdAt) }, ...extra });

  it('hands a household\'s sign-in to the family app to finish, whatever the deployment allows', async () => {
    // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
    const { callbackPlan } = await import('../authorization.mjs');
    const household = state({ householdId: { S: 'hh_a' }, userId: { S: 'user_sarah' } });

    expect(callbackPlan(household, { operatorLinkAllowed: false, now: NOW })).toBe('finish_in_app');
    expect(callbackPlan(household, { operatorLinkAllowed: true, now: NOW })).toBe('finish_in_app');
  });

  it('takes a sign-in nobody\'s household started only where the deployment allows the operator\'s link', async () => {
    // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
    const { callbackPlan } = await import('../authorization.mjs');

    expect(callbackPlan(state({ householdId: { S: 'margaret' } }), { operatorLinkAllowed: false, now: NOW })).toBe('refuse');
    expect(callbackPlan(state({ householdId: { S: 'margaret' } }), { operatorLinkAllowed: true, now: NOW })).toBe('operator');
    expect(callbackPlan(state(), { operatorLinkAllowed: true, now: NOW })).toBe('operator');
  });

  it('refuses a sign-in older than ten minutes, even if the table has not removed its row yet', async () => {
    // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
    const { callbackPlan } = await import('../authorization.mjs');
    const household = { householdId: { S: 'hh_a' }, userId: { S: 'user_sarah' } };

    expect(callbackPlan(state(household, NOW - 9 * 60_000), { operatorLinkAllowed: true, now: NOW })).toBe('finish_in_app');
    expect(callbackPlan(state(household, NOW - 11 * 60_000), { operatorLinkAllowed: true, now: NOW })).toBe('refuse');
    expect(callbackPlan({ codeVerifier: { S: 'v' }, ...household }, { operatorLinkAllowed: true, now: NOW })).toBe('refuse');
  });

  it('refuses a state it does not know', async () => {
    // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
    const { callbackPlan } = await import('../authorization.mjs');

    expect(callbackPlan(undefined, { operatorLinkAllowed: true })).toBe('refuse');
    expect(callbackPlan({}, { operatorLinkAllowed: true })).toBe('refuse');
  });
});

describe('a pasted token\'s own word on how long it lasts', () => {
  it('is not taken beyond an hour', () => {
    const farFuture = Math.floor(NOW / 1000) + 365 * 86_400;
    const jwt = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp: farFuture })).toString('base64url')}.sig`;

    expect(pastedTokenExpiry(jwt, NOW)).toBe(NOW + 60 * 60 * 1000);
  });
});

describe('finishing a sign-in that has gone stale', () => {
  it('refuses one started more than ten minutes ago, and keeps nothing', async () => {
    const { service, table, secrets, exchange } = harness();
    // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
    const { completionRow, stateRow } = await import('../authorization.mjs');
    const completion = 'e'.repeat(43);
    const old = NOW - 11 * 60_000;
    table.items.set('OAUTH#state-old|META', stateRow({ table: 'wick', state: 'state-old', verifier: 'v', householdId: 'hh_a', userId: 'user_sarah', now: old }).Item);
    const done = completionRow({ table: 'wick', completion, state: 'state-old', code: 'ring-code-1', now: old }).Item;
    table.items.set(`${done.pk.S}|META`, done);

    await expect(service.complete('hh_a', 'user_sarah', completion)).rejects.toMatchObject({ code: 'link_expired' });

    expect(exchange).not.toHaveBeenCalled();
    expect(secrets.size).toBe(0);
  });
});

describe('linking a home again', () => {
  const FIRST = 'first-accounts-token-0123456789ab';
  const SECOND = 'second-accounts-token-0123456789a';
  const kitchen = { id: 'ava1.ring.device.KITCHEN', name: 'Back Door' };

  it('lets go of a doorbell the new link cannot see, so the home that owns it can connect it', async () => {
    const { service, table } = harness({ devicesByToken: { [FIRST]: [CAMERA], [SECOND]: [kitchen] } });
    await service.playground('hh_a', 'user_sarah', FIRST);

    const status = await service.playground('hh_a', 'user_sarah', SECOND);

    expect(status.devices).toEqual([kitchen]);
    expect(table.holderOf(CAMERA.id)).toBeUndefined();
    expect(table.holderOf(kitchen.id)).toBe('hh_a');

    await service.playground('hh_b', 'user_tom', FIRST);
    expect(table.holderOf(CAMERA.id)).toBe('hh_b');
  });

  it('keeps a doorbell both links can see', async () => {
    const { service, table } = harness({ devicesByToken: { [FIRST]: [CAMERA], [SECOND]: [CAMERA, kitchen] } });
    await service.playground('hh_a', 'user_sarah', FIRST);

    const status = await service.playground('hh_a', 'user_sarah', SECOND);

    expect(status.devices).toEqual([CAMERA, kitchen]);
    expect(table.holderOf(CAMERA.id)).toBe('hh_a');
  });

  it('keeps what the home held when Ring will not list devices: an unread list is not an empty one', async () => {
    const { service, table } = harness({ devicesByToken: { [FIRST]: [CAMERA] } });
    await service.playground('hh_a', 'user_sarah', FIRST);

    // A link finished through Ring's sign-in, at a moment Ring's device list fails.
    const status = await service.recordLink('hh_a', { access_token: 'a-token-the-list-fails-for-0123456', refresh_token: 'r', source: 'oauth' }, 'user_sarah');

    expect(status).toMatchObject({ linked: true, source: 'oauth', devices: [CAMERA] });
    expect(table.holderOf(CAMERA.id)).toBe('hh_a');
    // …and a later disconnect still releases it.
    await service.disconnect('hh_a');
    expect(table.holderOf(CAMERA.id)).toBeUndefined();
  });

  it('never releases a doorbell that has since come to be another home\'s', async () => {
    const { service, table } = harness({ devicesByToken: { [FIRST]: [CAMERA], [SECOND]: [kitchen] } });
    await service.playground('hh_a', 'user_sarah', FIRST);
    table.items.set(`RINGDEV#${CAMERA.id}|META`, { pk: { S: `RINGDEV#${CAMERA.id}` }, sk: { S: 'META' }, householdId: { S: 'hh_b' } });

    await service.playground('hh_a', 'user_sarah', SECOND);

    expect(table.holderOf(CAMERA.id)).toBe('hh_b');
  });
});
