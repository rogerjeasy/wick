import { afterEach, describe, expect, it, vi } from 'vitest';
import { FAMILY_TV_WAVE_CARD, type FamilyTvHome, type FamilyTvSeat } from '@wick/contracts';
import { FAMILY_REQUEST_TIMEOUT_MS, MAX_PAGES, NOT_ALLOWED_FALLBACK, createFamilyClient, readHome, readSeat, type Renewed } from '../familyClient.js';

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

describe('readHome — the later cards: a film, a wave, her week', () => {
  const card = HOME.cards[0]!;

  it('keeps cards of the new kinds', () => {
    const cards = [
      { ...card, id: 'ftv-watch-s1', kind: 'watch' },
      { ...card, id: 'ftv-wave-w1', kind: 'wave' },
      { ...card, id: 'ftv-week-2026-W41', kind: 'week' },
    ];

    expect(readHome({ ...HOME, cards })?.cards.map((c) => c.kind)).toEqual(['watch', 'wave', 'week']);
  });

  it('keeps the pages of something to read, in order', () => {
    const week = { ...card, id: 'ftv-week-2026-W41', kind: 'week', pages: ['A quiet week.', 'Maria came on Tuesday.'] };

    expect(readHome({ ...HOME, cards: [week] })?.cards[0]).toEqual(week);
  });

  it('keeps the line breaks inside a page: a day of her week is a line for the day and a line for each thing', () => {
    const day = 'Monday 5 October\n10:15 — Maria visited.\n13:40 — Someone was at the door.\n16:05 — Tom rang.\n19:30 — A film in the evening.';
    const week = { ...card, id: 'ftv-week-2026-W41', kind: 'week', pages: ['A quiet week.', day] };

    const read = readHome(JSON.parse(JSON.stringify({ ...HOME, cards: [week] })));

    expect(read?.cards[0]?.pages?.[1]).toBe(day);
    expect(read?.cards[0]?.pages?.[1]?.split('\n')).toHaveLength(5);
  });

  it('has no pages for a card that brings none, or an empty list of them', () => {
    expect(readHome({ ...HOME, cards: [card] })?.cards[0]).not.toHaveProperty('pages');
    expect(readHome({ ...HOME, cards: [{ ...card, pages: [] }] })?.cards[0]).not.toHaveProperty('pages');
  });

  it('leaves out the whole card when its pages are not pages: half a week is not shown as a week', () => {
    const tooMany = Array.from({ length: MAX_PAGES + 1 }, (_, i) => `Page ${i + 1}.`);

    for (const pages of ['A quiet week.', ['A quiet week.', ''], ['A quiet week.', 7], [null], tooMany]) {
      expect(readHome({ ...HOME, cards: [{ ...card, pages }] })?.cards).toEqual([]);
    }
    expect(readHome({ ...HOME, cards: [{ ...card, pages: tooMany.slice(1) }] })?.cards).toHaveLength(1);
  });

  it('keeps a wave that can be sent: its button, and the one card it is pressed on', () => {
    const wave = { label: 'Wave to Margaret', cardId: FAMILY_TV_WAVE_CARD };

    expect(readHome({ ...HOME, wave })?.wave).toEqual(wave);
  });

  it('keeps how the last wave stands, with nothing to press', () => {
    const wave = { label: 'Wave to Margaret', line: 'Your wave is on Margaret’s television.' };

    expect(readHome({ ...HOME, wave })?.wave).toEqual(wave);
  });

  it('never takes a wave to be pressed on any other card: an OK on it could then answer something else', () => {
    const read = readHome({ ...HOME, wave: { label: 'Wave to Margaret', cardId: 'ftv-reach-r1', line: 'x' } });

    expect(read?.wave).toEqual({ label: 'Wave to Margaret', line: 'x' });
  });

  it('has no wave at all without its words, and carries nothing else of it', () => {
    expect(readHome(HOME)).not.toHaveProperty('wave');
    expect(readHome({ ...HOME, wave: { cardId: FAMILY_TV_WAVE_CARD } })).not.toHaveProperty('wave');
    expect(readHome({ ...HOME, wave: 'wave' })).not.toHaveProperty('wave');
    expect(readHome({ ...HOME, wave: { label: 'Wave', cardId: FAMILY_TV_WAVE_CARD, userId: 'u-1' } })?.wave).not.toHaveProperty('userId');
  });
});

const SEAT: FamilyTvSeat = {
  cardId: 'ftv-watch-s1',
  film: 'Big Buck Bunny',
  state: 'watching',
  line: 'Big Buck Bunny is on. Your television follows Margaret’s.',
  stream: { url: 'https://films.example/bbb/index.m3u8', durationMs: 596_000, attribution: '© Blender Foundation' },
  playback: { state: 'PLAYING', positionMs: 61_000, ageMs: 1_200 },
};

describe('familyClient.seat — GET /tv/seat', () => {
  it('asks with the device token, and hands back the seat as the server wrote it', async () => {
    const { calls, fetchImpl } = server([json(200, { seat: SEAT })]);
    const client = createFamilyClient({ serverUrl: 'https://wick.example', jwt: 'device-jwt', renew: neverRenews, fetchImpl });

    expect(await client.seat()).toEqual({ kind: 'seat', seat: SEAT });
    expect(calls[0]!.url).toBe('https://wick.example/tv/seat');
    expect(calls[0]!.init?.method).toBe('GET');
    expect(header(calls[0], 'Authorization')).toBe('Bearer device-jwt');
    expect(calls[0]!.init?.body).toBeUndefined();
  });

  it('hands back no seat when the server gives none: there is no film, or it is not this member’s to sit at', async () => {
    const { fetchImpl } = server([json(200, {})]);
    const client = createFamilyClient({ serverUrl: 'https://wick.example', jwt: 'j', renew: neverRenews, fetchImpl });

    expect(await client.seat()).toEqual({ kind: 'seat' });
  });

  it('is refused as a look at the home is: not allowed, signed out after one fresh token, failed otherwise', async () => {
    const refused = server([json(403, { error: 'not_allowed', say: 'Margaret no longer shares this.' })]);
    expect(await createFamilyClient({ serverUrl: 'https://w', jwt: 'j', renew: neverRenews, fetchImpl: refused.fetchImpl }).seat()).toEqual({ kind: 'notAllowed', say: 'Margaret no longer shares this.' });

    const gone = server([json(401, {})]);
    expect(await createFamilyClient({ serverUrl: 'https://w', jwt: 'j', renew: async () => 'not_connected', fetchImpl: gone.fetchImpl }).seat()).toEqual({ kind: 'signedOut' });

    const renewed = server([json(401, {}), json(200, { seat: SEAT })]);
    expect((await createFamilyClient({ serverUrl: 'https://w', jwt: 'j', renew: async () => ({ jwt: 'fresh' }), fetchImpl: renewed.fetchImpl }).seat()).kind).toBe('seat');

    for (const answer of [json(500, {}), new TypeError('Network request failed'), json(200, { seat: { film: 'x' } }), new Response('<html>', { status: 200 })]) {
      const { fetchImpl } = server([answer]);
      expect(await createFamilyClient({ serverUrl: 'https://w', jwt: 'j', renew: neverRenews, fetchImpl }).seat()).toEqual({ kind: 'failed' });
    }
  });
});

describe('readSeat — only what the contract names', () => {
  it('keeps a whole seat, at each of its states', () => {
    expect(readSeat(SEAT)).toEqual(SEAT);
    const asked: FamilyTvSeat = {
      cardId: 'ftv-watch-s1',
      film: 'Big Buck Bunny',
      state: 'asked',
      line: 'The credits are playing.',
      question: 'Did you enjoy that?',
      answers: [
        { id: 'lovely', label: 'Lovely', kind: 'primary' },
        { id: 'again', label: 'Let’s do it again', kind: 'secondary' },
      ],
    };
    expect(readSeat(asked)).toEqual(asked);
    const over: FamilyTvSeat = { cardId: 'ftv-watch-s1', film: 'Big Buck Bunny', state: 'over', line: 'You both said: lovely.', yourAnswer: 'Lovely', theirAnswer: 'Lovely' };
    expect(readSeat(over)).toEqual(over);
  });

  it('is no seat without its card, its film, its sentence or a state it knows', () => {
    expect(readSeat(null)).toBeUndefined();
    expect(readSeat({ ...SEAT, cardId: '' })).toBeUndefined();
    expect(readSeat({ ...SEAT, film: undefined })).toBeUndefined();
    expect(readSeat({ ...SEAT, line: 7 })).toBeUndefined();
    expect(readSeat({ ...SEAT, state: 'rewinding' })).toBeUndefined();
  });

  it('plays a film only from an https address: this player drops anything else without a word (FL-016)', () => {
    expect(readSeat({ ...SEAT, stream: { ...SEAT.stream, url: 'http://films.example/bbb/index.m3u8' } })).not.toHaveProperty('stream');
    expect(readSeat({ ...SEAT, stream: { ...SEAT.stream, url: 'javascript:alert(1)' } })).not.toHaveProperty('stream');
    expect(readSeat({ ...SEAT, stream: { url: 'https://films.example/a.m3u8' } })?.stream).toEqual({ url: 'https://films.example/a.m3u8', durationMs: 0, attribution: '' });
  });

  it('follows nothing it cannot read: a place in the film is a state it knows and two numbers', () => {
    expect(readSeat({ ...SEAT, playback: { state: 'REWINDING', positionMs: 1, ageMs: 1 } })).not.toHaveProperty('playback');
    expect(readSeat({ ...SEAT, playback: { state: 'PLAYING', positionMs: '61000', ageMs: 1 } })).not.toHaveProperty('playback');
    expect(readSeat({ ...SEAT, playback: { state: 'PAUSED', positionMs: 61_000, ageMs: Number.NaN } })).not.toHaveProperty('playback');
    expect(readSeat({ ...SEAT, playback: { state: 'WAITING', positionMs: 0, ageMs: 0 } })?.playback).toEqual({ state: 'WAITING', positionMs: 0, ageMs: 0 });
  });

  it('offers no answers rather than four, or one that is not whole', () => {
    const answer = { id: 'lovely', label: 'Lovely', kind: 'primary' };

    expect(readSeat({ ...SEAT, state: 'asked', question: 'Well?', answers: [answer, answer, answer, answer] })).not.toHaveProperty('answers');
    expect(readSeat({ ...SEAT, state: 'asked', question: 'Well?', answers: [answer, { id: 'x' }] })).not.toHaveProperty('answers');
  });

  it('carries nothing the contract does not name', () => {
    expect(readSeat({ ...SEAT, sessionId: 's-1', householdId: 'hh-1' })).toEqual(SEAT);
  });
});

describe('familyClient.waiting — GET /tv/waiting, asked by the background service', () => {
  it('asks with the token it was given, and hands back a sentence for each thing that waits', async () => {
    const waiting = [
      { id: 'ftv-door_look-d1', line: 'Margaret asks who is at her door.' },
      { id: 'ftv-wave-w1', line: 'Margaret waved back.' },
    ];
    const { calls, fetchImpl } = server([json(200, { waiting })]);
    const client = createFamilyClient({ serverUrl: 'https://wick.example', jwt: 'scoped-jwt', renew: neverRenews, fetchImpl });

    expect(await client.waiting()).toEqual({ kind: 'waiting', waiting });
    expect(calls[0]!.url).toBe('https://wick.example/tv/waiting');
    expect(calls[0]!.init?.method).toBe('GET');
    expect(header(calls[0], 'Authorization')).toBe('Bearer scoped-jwt');
  });

  it('leaves out what is not whole, and carries nothing but the id and the sentence', () => {
    const { fetchImpl } = server([json(200, { waiting: [{ id: 'a', line: 'One.', detail: 'more' }, { id: 'b' }, { line: 'Three.' }, 'four'] })]);
    const client = createFamilyClient({ serverUrl: 'https://wick.example', jwt: 'j', renew: neverRenews, fetchImpl });

    return expect(client.waiting()).resolves.toEqual({ kind: 'waiting', waiting: [{ id: 'a', line: 'One.' }] });
  });

  it('asks once for a fresh token when its own is refused, showing the one it holds — and is signed out if that fails', async () => {
    const renewed = server([json(401, {}), json(200, { waiting: [] })]);
    const renew = vi.fn(async (): Promise<Renewed> => ({ jwt: 'scoped-2' }));
    const client = createFamilyClient({ serverUrl: 'https://w', jwt: 'scoped-1', renew, fetchImpl: renewed.fetchImpl });

    expect(await client.waiting()).toEqual({ kind: 'waiting', waiting: [] });
    expect(renew.mock.calls).toEqual([['scoped-1']]);
    expect(header(renewed.calls[1], 'Authorization')).toBe('Bearer scoped-2');

    const gone = server([json(401, {})]);
    expect(await createFamilyClient({ serverUrl: 'https://w', jwt: 'j', renew: async () => 'not_connected', fetchImpl: gone.fetchImpl }).waiting()).toEqual({ kind: 'signedOut' });
  });

  it('is only a failed ask when the server errs, refuses this member, or answers something else', async () => {
    for (const answer of [json(500, {}), json(403, { say: 'no' }), new TypeError('Network request failed'), json(200, { waiting: 'none' })]) {
      const { fetchImpl } = server([answer]);
      expect(await createFamilyClient({ serverUrl: 'https://w', jwt: 'j', renew: neverRenews, fetchImpl }).waiting()).toEqual({ kind: 'failed' });
    }
  });
});

// The background service's token is the one that cannot be brought back
// once it has run out (edge-device pair-refresh.mjs), so it is renewed
// while it is still good — not only when it is refused.
describe('familyClient.renewNow — a fresh token before the old one runs out', () => {
  it('shows the token it holds, and uses the fresh one from then on', async () => {
    const { calls, fetchImpl } = server([json(200, { waiting: [] })]);
    const renew = vi.fn(async (): Promise<Renewed> => ({ jwt: 'scoped-2' }));
    const client = createFamilyClient({ serverUrl: 'https://w', jwt: 'scoped-1', renew, fetchImpl });

    expect(await client.renewNow()).toBe('renewed');
    expect(renew.mock.calls).toEqual([['scoped-1']]);

    await client.waiting();
    expect(header(calls[0], 'Authorization')).toBe('Bearer scoped-2');
  });

  it('says the token is gone for good when the pairing service says so, and "later" when it only could not be asked', async () => {
    const { fetchImpl } = server([]);

    expect(await createFamilyClient({ serverUrl: 'https://w', jwt: 'j', renew: async () => 'not_connected', fetchImpl }).renewNow()).toBe('signedOut');
    expect(await createFamilyClient({ serverUrl: 'https://w', jwt: 'j', renew: async () => 'try_later', fetchImpl }).renewNow()).toBe('later');
    expect(
      await createFamilyClient({
        serverUrl: 'https://w',
        jwt: 'j',
        renew: async () => {
          throw new Error('boom');
        },
        fetchImpl,
      }).renewNow(),
    ).toBe('later');
  });
});

// The pairing service is asked for a fresh token with no time limit of its
// own. A request that never answers must not hold up everything after it:
// the background service asks one thing at a time.
describe('familyClient — a renewal that does not answer', () => {
  it('is "not now" once its time is up: the ask that needed it is only a failed ask, and the next can try again', async () => {
    vi.useFakeTimers();
    const { fetchImpl } = server([json(401, {}), json(401, {}), json(200, { waiting: [] })]);
    const answers: Array<Promise<Renewed>> = [new Promise<Renewed>(() => {}), Promise.resolve({ jwt: 'scoped-2' })];
    const renew = vi.fn(() => answers.shift()!);
    const client = createFamilyClient({ serverUrl: 'https://w', jwt: 'scoped-1', renew, fetchImpl, timeoutMs: 6000 });

    const first = client.waiting();
    await vi.advanceTimersByTimeAsync(5999);
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await first).toEqual({ kind: 'failed' });

    expect(await client.waiting()).toEqual({ kind: 'waiting', waiting: [] });
    expect(renew).toHaveBeenCalledTimes(2);
  });

  it('is "later" for a renewal asked for ahead of time', async () => {
    vi.useFakeTimers();
    const { fetchImpl } = server([]);
    const client = createFamilyClient({ serverUrl: 'https://w', jwt: 'j', renew: () => new Promise<Renewed>(() => {}), fetchImpl, timeoutMs: 6000 });

    const renewing = client.renewNow();
    await vi.advanceTimersByTimeAsync(6000);

    expect(await renewing).toBe('later');
  });
});

// In the browser television one stalled /tv request froze the family view
// for three minutes. Here every request to the Wick server goes through the
// one place that gives it a time limit; this holds each of the four to it.
describe('familyClient — no request to the Wick server is waited for without limit', () => {
  const asks: Array<[string, (client: ReturnType<typeof createFamilyClient>) => Promise<{ kind: string }>]> = [
    ['/tv/home', (client) => client.home()],
    ['/tv/seat', (client) => client.seat()],
    ['/tv/waiting', (client) => client.waiting()],
    ['/tv/press', (client) => client.press({ cardId: 'ftv-reach-r1', action: 'calling' })],
  ];

  for (const [path, ask] of asks) {
    it(`gives up on ${path} once its time is up, tells the request to stop, and calls it only a failed ask`, async () => {
      vi.useFakeTimers();
      const { calls, fetchImpl } = server(['never']);
      const client = createFamilyClient({ serverUrl: 'https://wick.example', jwt: 'j', renew: neverRenews, fetchImpl });

      const asking = ask(client);
      await vi.advanceTimersByTimeAsync(FAMILY_REQUEST_TIMEOUT_MS - 1);
      expect(calls[0]!.url).toBe(`https://wick.example${path}`);
      const signal = calls[0]!.init?.signal as AbortSignal;
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(await asking).toEqual({ kind: 'failed' });
      expect(signal.aborted).toBe(true);
    });
  }

  it('is six seconds: under the eight between looks at the home', () => {
    expect(FAMILY_REQUEST_TIMEOUT_MS).toBe(6000);
  });
});
