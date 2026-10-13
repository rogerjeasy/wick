import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FamilyTvHome } from '@wick/contracts';
import { NOT_ALLOWED_FALLBACK, createFamilyClient, readHome, type Renewed } from '../familyClient.js';

const HOME: FamilyTvHome = {
  residentName: 'Margaret',
  memberName: 'Sarah',
  light: { lit: true, line: 'Margaret’s light is on.' },
  cards: [
    {
      id: 'ftv-reach-r1',
      kind: 'reach',
      headline: 'Margaret would like you to ring her.',
      detail: 'She asked a minute ago.',
      actions: [
        { id: 'calling', label: 'I’ll ring now', kind: 'primary' },
        { id: 'cannot', label: 'I can’t just now', kind: 'secondary' },
      ],
    },
  ],
};

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** A server that answers from a list, and remembers what it was asked. */
function server(answers: Array<Response | Error | 'never'>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (next === undefined) throw new Error('no answer left');
    if (next === 'never') return new Promise<Response>(() => {});
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const header = (call: Call | undefined, name: string): string | undefined => (call?.init?.headers as Record<string, string> | undefined)?.[name];

const neverRenews = async (): Promise<Renewed> => {
  throw new Error('renew should not be called');
};

afterEach(() => {
  vi.useRealTimers();
});

describe('familyClient.home — GET /tv/home', () => {
  it('asks the Wick server with the device token, and hands back the home it wrote', async () => {
    const { calls, fetchImpl } = server([json(200, HOME)]);
    const client = createFamilyClient({ serverUrl: 'https://wick.example', jwt: 'device-jwt', renew: neverRenews, fetchImpl });

    expect(await client.home()).toEqual({ kind: 'home', home: HOME });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://wick.example/tv/home');
    expect(calls[0]!.init?.method).toBe('GET');
    expect(header(calls[0], 'Authorization')).toBe('Bearer device-jwt');
    expect(calls[0]!.init?.body).toBeUndefined();
  });

  it('says "not allowed" with the server\'s own sentence on a 403', async () => {
    const { fetchImpl } = server([json(403, { error: 'not_allowed', say: 'Margaret has not said yes yet.' })]);
    const client = createFamilyClient({ serverUrl: 'https://wick.example', jwt: 'j', renew: neverRenews, fetchImpl });

    expect(await client.home()).toEqual({ kind: 'notAllowed', say: 'Margaret has not said yes yet.' });
  });

  it('still shows nothing of the home on a 403 that carries no sentence', async () => {
    const { fetchImpl } = server([new Response('forbidden', { status: 403 })]);
    const client = createFamilyClient({ serverUrl: 'https://wick.example', jwt: 'j', renew: neverRenews, fetchImpl });

    expect(await client.home()).toEqual({ kind: 'notAllowed', say: NOT_ALLOWED_FALLBACK });
  });

  it('is a failed look — not a sign-out — when the server errs, is not there, or nothing answers', async () => {
    for (const answer of [json(500, {}), json(404, {}), new TypeError('Network request failed'), new Response('<html>', { status: 200 })]) {
      const { fetchImpl } = server([answer]);
      const client = createFamilyClient({ serverUrl: 'https://wick.example', jwt: 'j', renew: neverRenews, fetchImpl });

      expect(await client.home()).toEqual({ kind: 'failed' });
    }
  });

  it('gives up on a request that has not answered in time, and tells the request to stop', async () => {
    vi.useFakeTimers();
    const { calls, fetchImpl } = server(['never']);
    const client = createFamilyClient({ serverUrl: 'https://wick.example', jwt: 'j', renew: neverRenews, fetchImpl, timeoutMs: 6000 });

    const looking = client.home();
    await vi.advanceTimersByTimeAsync(5999);
    const signal = calls[0]!.init?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(await looking).toEqual({ kind: 'failed' });
    expect(signal.aborted).toBe(true);
  });
});

describe('familyClient — a token the server no longer takes (401)', () => {
  it('asks once for a fresh token and looks again with it: an hour-old token is not a television removed', async () => {
    const { calls, fetchImpl } = server([json(401, {}), json(200, HOME)]);
    const renew = vi.fn(async (): Promise<Renewed> => ({ jwt: 'fresh-jwt' }));
    const client = createFamilyClient({ serverUrl: 'https://wick.example', jwt: 'old-jwt', renew, fetchImpl });

    expect(await client.home()).toEqual({ kind: 'home', home: HOME });
    expect(renew).toHaveBeenCalledTimes(1);
    expect(header(calls[0], 'Authorization')).toBe('Bearer old-jwt');
    expect(header(calls[1], 'Authorization')).toBe('Bearer fresh-jwt');
  });

  // The edge mints a family television's token only for one that shows the
  // token it held (edge-device pair-refresh.mjs). On the Vega simulator the
  // disk keeps nothing, so the one in this client's hand is the only proof.
  it('hands the renewal the very token that was refused, as its proof — and next time, the one that replaced it', async () => {
    const { fetchImpl } = server([json(401, {}), json(200, HOME), json(401, {}), json(200, HOME)]);
    const renew = vi.fn(async (held: string): Promise<Renewed> => ({ jwt: `after-${held}` }));
    const client = createFamilyClient({ serverUrl: 'https://wick.example', jwt: 'first', renew, fetchImpl });

    await client.home();
    await client.home();

    expect(renew.mock.calls).toEqual([['first'], ['after-first']]);
  });

  it('goes on using the fresh token afterwards', async () => {
    const { calls, fetchImpl } = server([json(401, {}), json(200, HOME), json(200, HOME)]);
    const client = createFamilyClient({ serverUrl: 'https://wick.example', jwt: 'old-jwt', renew: async () => ({ jwt: 'fresh-jwt' }), fetchImpl });

    await client.home();
    await client.home();

    expect(header(calls[2], 'Authorization')).toBe('Bearer fresh-jwt');
  });

  it('is signed out when the server that mints tokens says this television is no longer connected', async () => {
    const { calls, fetchImpl } = server([json(401, {})]);
    const renew = vi.fn(async (): Promise<Renewed> => 'not_connected');
    const client = createFamilyClient({ serverUrl: 'https://wick.example', jwt: 'j', renew, fetchImpl });

    expect(await client.home()).toEqual({ kind: 'signedOut' });
    // A refresh refused (401 token_required / invalid_token, 403, 404) ends it: one renewal, and no request after it.
    expect(renew).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it('is signed out when the fresh token is refused too — it never asks for a third', async () => {
    const { calls, fetchImpl } = server([json(401, {}), json(401, {})]);
    const renew = vi.fn(async (): Promise<Renewed> => ({ jwt: 'fresh-jwt' }));
    const client = createFamilyClient({ serverUrl: 'https://wick.example', jwt: 'j', renew, fetchImpl });

    expect(await client.home()).toEqual({ kind: 'signedOut' });
    expect(renew).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
  });

  it('is only a failed look when a fresh token cannot be had just now', async () => {
    const { fetchImpl } = server([json(401, {})]);
    const client = createFamilyClient({ serverUrl: 'https://wick.example', jwt: 'j', renew: async () => 'try_later', fetchImpl });

    expect(await client.home()).toEqual({ kind: 'failed' });
  });

  it('asks for one fresh token, not two, when a look and a press are refused together', async () => {
    const { fetchImpl } = server([json(401, {}), json(401, {}), json(200, HOME), json(200, { done: true, say: 'Margaret has been told.' })]);
    let hand: (r: Renewed) => void = () => {};
    const renew = vi.fn(() => new Promise<Renewed>((resolve) => (hand = resolve)));
    const client = createFamilyClient({ serverUrl: 'https://wick.example', jwt: 'j', renew, fetchImpl });

    const look = client.home();
    const press = client.press({ cardId: 'ftv-reach-r1', action: 'calling' });
    await vi.waitFor(() => expect(renew).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    hand({ jwt: 'fresh-jwt' });

    expect((await look).kind).toBe('home');
    expect((await press).kind).toBe('said');
    expect(renew).toHaveBeenCalledTimes(1);
  });
});

describe('familyClient.press — POST /tv/press', () => {
  it('posts the card and the action with the device token, and hands back what to say', async () => {
    const { calls, fetchImpl } = server([json(200, { done: true, say: 'Margaret has been told you will ring.' })]);
    const client = createFamilyClient({ serverUrl: 'https://wick.example', jwt: 'device-jwt', renew: neverRenews, fetchImpl });

    expect(await client.press({ cardId: 'ftv-reach-r1', action: 'calling' })).toEqual({ kind: 'said', done: true, say: 'Margaret has been told you will ring.' });
    expect(calls[0]!.url).toBe('https://wick.example/tv/press');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(header(calls[0], 'Authorization')).toBe('Bearer device-jwt');
    expect(header(calls[0], 'Content-Type')).toBe('application/json');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ cardId: 'ftv-reach-r1', action: 'calling' });
  });

  it('sends nothing but the card and the action: no household, no member, no television (INV-8)', async () => {
    const { calls, fetchImpl } = server([json(200, { done: true, say: 'ok' })]);
    const client = createFamilyClient({ serverUrl: 'https://wick.example', jwt: 'j', renew: neverRenews, fetchImpl });

    await client.press({ cardId: 'c', action: 'a', householdId: 'hh-other' } as never);

    expect(Object.keys(JSON.parse(String(calls[0]!.init?.body))).sort()).toEqual(['action', 'cardId']);
  });

  it('hands back an answer that was not done as an ordinary answer, with its sentence', async () => {
    const { fetchImpl } = server([json(200, { done: false, say: 'Tom has already answered.' })]);
    const client = createFamilyClient({ serverUrl: 'https://wick.example', jwt: 'j', renew: neverRenews, fetchImpl });

    expect(await client.press({ cardId: 'c', action: 'a' })).toEqual({ kind: 'said', done: false, say: 'Tom has already answered.' });
  });

  it('says "not allowed" on a 403, signed out on a 401 that a fresh token does not mend, and failed otherwise', async () => {
    const refused = server([json(403, { error: 'not_allowed', say: 'Margaret no longer shares this.' })]);
    expect(await createFamilyClient({ serverUrl: 'https://w', jwt: 'j', renew: neverRenews, fetchImpl: refused.fetchImpl }).press({ cardId: 'c', action: 'a' })).toEqual({
      kind: 'notAllowed',
      say: 'Margaret no longer shares this.',
    });

    const gone = server([json(401, {})]);
    expect(await createFamilyClient({ serverUrl: 'https://w', jwt: 'j', renew: async () => 'not_connected', fetchImpl: gone.fetchImpl }).press({ cardId: 'c', action: 'a' })).toEqual({
      kind: 'signedOut',
    });

    for (const answer of [json(500, {}), new TypeError('Network request failed'), json(200, { done: true })]) {
      const { fetchImpl } = server([answer]);
      expect(await createFamilyClient({ serverUrl: 'https://w', jwt: 'j', renew: neverRenews, fetchImpl }).press({ cardId: 'c', action: 'a' })).toEqual({ kind: 'failed' });
    }
  });
});

describe('readHome — only what the contract names is kept, and a card that would break the floor is not shown', () => {
  it('keeps a whole home as it is', () => {
    expect(readHome(HOME)).toEqual(HOME);
    expect(readHome({ ...HOME, simulated: true })).toEqual({ ...HOME, simulated: true });
  });

  it('is nothing at all without the two names or a list of cards', () => {
    expect(readHome(null)).toBeUndefined();
    expect(readHome('home')).toBeUndefined();
    expect(readHome({ ...HOME, residentName: '' })).toBeUndefined();
    expect(readHome({ ...HOME, memberName: undefined })).toBeUndefined();
    expect(readHome({ ...HOME, cards: 'none' })).toBeUndefined();
  });

  it('has no light unless the server gave one with its sentence', () => {
    const { light: _light, ...withoutLight } = HOME;

    expect(readHome(withoutLight)).not.toHaveProperty('light');
    expect(readHome({ ...HOME, light: { lit: true } })).not.toHaveProperty('light');
    expect(readHome({ ...HOME, light: null })).not.toHaveProperty('light');
  });

  it('is simulated only when the server says exactly that', () => {
    expect(readHome({ ...HOME, simulated: false })).not.toHaveProperty('simulated');
    expect(readHome({ ...HOME, simulated: 'yes' })).not.toHaveProperty('simulated');
  });

  it('leaves out a card with no id or headline, or with more than three actions (three items, never four)', () => {
    const card = HOME.cards[0]!;
    const action = card.actions[0]!;
    const four = { ...card, id: 'four', actions: [action, { ...action, id: 'b' }, { ...action, id: 'c' }, { ...action, id: 'd' }] };

    expect(readHome({ ...HOME, cards: [{ ...card, headline: '' }, four, { kind: 'reach' }, card] })?.cards).toEqual([card]);
  });

  it('keeps a card that only says how something stands, and the picture of one that has it', () => {
    const standing = { id: 'ftv-door_look-d1', kind: 'door_look', headline: 'Tom is looking at the door.', actions: [] };
    const picture = { ...HOME.cards[0]!, pictureUrl: 'https://ring.example/snap.jpg' };

    expect(readHome({ ...HOME, cards: [standing, picture] })?.cards).toEqual([standing, picture]);
  });

  it('carries nothing the contract does not name', () => {
    const read = readHome({ ...HOME, householdId: 'hh-1', cards: [{ ...HOME.cards[0]!, userId: 'u-1' }] });

    expect(read).not.toHaveProperty('householdId');
    expect(read?.cards[0]).not.toHaveProperty('userId');
  });
});
