/**
 * /api/language over a real socket: the television speaks her language, the
 * asking (accounts/language.ts). Who may read, who may ask, what is refused
 * and in which words — and that no request can name a household (INV-8).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { languageQuestion, type QueuedCard } from '@wick/contracts';
import type { AppDeps } from '../server.js';
import { createMemoryStore } from '../accounts/__tests__/memoryStore.js';
import {
  Browser,
  beginAuthorize,
  exchangeCode,
  linkInvited,
  linkNewOrganiser,
  registerClient,
  residentAllows,
  startServer,
  TOM,
  type Harness,
  type Linked,
  type Tokens,
} from './harness.js';

const closers: (() => Promise<void>)[] = [];

interface World {
  readonly h: Harness;
  readonly withdrawn: { householdId: string; cardId: string }[];
  /** The LANGUAGE cards sent so far — the Circle cards a new home sends are not this file's. */
  languageCards(): QueuedCard[];
}

async function server(overrides: Partial<AppDeps> = {}): Promise<World> {
  const withdrawn: World['withdrawn'] = [];
  const h = await startServer({ withdrawCard: async (householdId, cardId) => void withdrawn.push({ householdId, cardId }), ...overrides });
  closers.push(h.close);
  return { h, withdrawn, languageCards: () => h.cards.filter((card) => card.card.type === 'LANGUAGE') };
}

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

type Who = Pick<Linked, 'tokens'>;

const call = (h: Harness, who: Who, method: string, path: string, body?: unknown) =>
  fetch(`${h.base}${path}`, {
    method,
    headers: { authorization: `Bearer ${who.tokens.access_token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const read = (h: Harness, who: Who, path = '/api/language') => call(h, who, 'GET', path);
const ask = (h: Harness, who: Who, body: unknown, path = '/api/language') => call(h, who, 'POST', path, body);
const takeBack = (h: Harness, who: Who, path = '/api/language/question') => call(h, who, 'DELETE', path);

const CHOICES = [
  { language: 'en', name: 'English', own: 'English' },
  { language: 'es', name: 'Spanish', own: 'español' },
];
const JUNE = { name: 'June', email: 'june@example.com', password: 'a neighbourly passphrase' };
const PRIYA = { name: 'Priya', email: 'priya@example.com', password: 'another long passphrase' };

async function invite(h: Harness, organiser: Linked, role?: 'neighbour'): Promise<string> {
  const res = await call(h, organiser, 'POST', '/api/circle/invitations', role ? { role } : undefined);
  return ((await res.json()) as { code: string }).code;
}

/** Margaret's home with her television connected, Sarah its organiser. */
async function home(options: { television?: boolean } = {}) {
  const w = await server();
  const sarah = await linkNewOrganiser(w.h);
  if (options.television !== false) w.h.store.addTelevision(sarah.householdId, { deviceId: 'tv-1', pairedAt: 5, connected: true });
  return { ...w, sarah };
}

describe('GET /api/language — which language her television speaks', () => {
  it('is English until she chooses another, with what can be asked for', async () => {
    const { h, sarah } = await home();
    await residentAllows(h, sarah.householdId, sarah.userId);

    const res = await read(h, sarah);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ language: 'en', choices: CHOICES });
    // The family app is served from another origin.
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('answers the organiser while they wait, and a family member she allows', async () => {
    const { h, sarah } = await home();
    const tom = await linkInvited(h, TOM, await invite(h, sarah));
    await residentAllows(h, tom.householdId, tom.userId);

    expect((await read(h, sarah)).status).toBe(200);
    expect(await (await read(h, tom)).json()).toEqual({ language: 'en', choices: CHOICES });
  });

  it('INV-9: answers a family member nothing until she allows them, and nothing once they are removed', async () => {
    const { h, sarah } = await home();
    const tom = await linkInvited(h, TOM, await invite(h, sarah));

    const waiting = await read(h, tom);
    expect(waiting.status).toBe(403);
    expect(await waiting.json()).toEqual({
      error: 'not_allowed_yet',
      message: 'Margaret hasn’t allowed this yet. A card is waiting on the television, and it only takes one press.',
    });

    await residentAllows(h, tom.householdId, tom.userId);
    expect((await read(h, tom)).status).toBe(200);

    await call(h, sarah, 'DELETE', `/api/circle/members/${tom.userId}`);
    const removed = await read(h, tom);
    expect(removed.status).toBe(403);
    expect(await removed.json()).toEqual({ error: 'not_allowed_yet', message: 'You are no longer part of this family circle.' });
  });

  it('INV-9: answers somebody she turned down nothing', async () => {
    const { h, sarah } = await home();
    const tom = await linkInvited(h, TOM, await invite(h, sarah));
    await h.store.setMemberStatus(tom.householdId, tom.userId, 'declined', Date.now());

    const res = await read(h, tom);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_allowed_yet', message: 'Margaret chose not to share this with you.' });
  });

  it('is not for a neighbour, allowed or not', async () => {
    const { h, sarah } = await home();
    const june = await linkInvited(h, JUNE, await invite(h, sarah, 'neighbour'));

    for (const allowed of [false, true]) {
      if (allowed) await residentAllows(h, june.householdId, june.userId);
      const res = await read(h, june);

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'not_for_a_neighbour', message: 'The language of the television is not shown to a neighbour.' });
    }
  });

  it('is for someone signed in', async () => {
    const { h } = await home();

    expect((await fetch(`${h.base}/api/language`)).status).toBe(401);
    expect((await fetch(`${h.base}/api/language`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${h.base}/api/language/question`, { method: 'DELETE' })).status).toBe(401);
  });
});

describe('POST /api/language — the organiser asks, and nothing changes until she says yes', () => {
  it('puts one card on her television, in both languages, under the organiser’s first name', async () => {
    const { h, sarah, languageCards } = await home();
    const before = Date.now();

    const res = await ask(h, sarah, { language: 'es' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { language: string; asked: { language: string; by: string; at: number }; choices: unknown; say: string };
    expect(body).toEqual({
      language: 'en',
      asked: { language: 'es', by: 'Sarah', at: expect.any(Number) as number },
      choices: CHOICES,
      say: 'I have asked Margaret on her television. Nothing changes until she says yes.',
    });
    expect(body.asked.at).toBeGreaterThanOrEqual(before);

    expect(languageCards()).toEqual([
      {
        id: 'language-es',
        urgency: 'DEFERRED',
        queuedAt: body.asked.at,
        shownCount: 0,
        card: {
          type: 'LANGUAGE',
          id: 'language-es',
          householdId: sarah.householdId,
          correlationId: 'language-es',
          createdAt: body.asked.at,
          language: 'es',
          ...languageQuestion('es', 'Sarah'),
        },
      },
    ]);
    // And the question is what everyone who may read is now told.
    expect(await (await read(h, sarah)).json()).toEqual({ language: 'en', asked: body.asked, choices: CHOICES });
  });

  it('takes the asker’s name from their membership, never from the request', async () => {
    const { h, sarah, languageCards } = await home();

    await ask(h, sarah, { language: 'es', by: 'Margaret’s doctor', askedBy: 'Dr Patel', name: 'Dr Patel' });

    expect(languageCards()[0]!.card).toMatchObject({ detail: languageQuestion('es', 'Sarah').detail });
    expect(await (await read(h, sarah)).json()).toMatchObject({ asked: { by: 'Sarah' } });
  });

  it.each([[{ language: 'fr' }], [{ language: 'ES' }], [{ language: 7 }], [{ language: ['es'] }], [{}], [undefined]])(
    'refuses %j: not a language Wick has',
    async (body) => {
      const { h, sarah, languageCards } = await home();

      const res = await ask(h, sarah, body);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_language', message: 'Wick does not have that language yet. It has English and Spanish.' });
      expect(languageCards()).toEqual([]);
    },
  );

  it('refuses the language her television already speaks', async () => {
    const { h, sarah, languageCards } = await home();

    const english = await ask(h, sarah, { language: 'en' });
    expect(english.status).toBe(409);
    expect(await english.json()).toEqual({ error: 'already_speaks', message: 'Margaret’s television already speaks English.' });

    await ask(h, sarah, { language: 'es' });
    h.store.answerLanguage(sarah.householdId, 'yes');

    const spanish = await ask(h, sarah, { language: 'es' });
    expect(spanish.status).toBe(409);
    expect(await spanish.json()).toEqual({ error: 'already_speaks', message: 'Margaret’s television already speaks Spanish.' });
    expect(languageCards()).toHaveLength(1);
  });

  it('refuses while no television is paired: nothing could ask her', async () => {
    const { h, sarah, languageCards } = await home({ television: false });

    const res = await ask(h, sarah, { language: 'es' });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'no_television',
      message: 'Connect Margaret’s television first. She is asked on it, and there is nowhere to ask her yet.',
    });
    expect(languageCards()).toEqual([]);
    expect(await (await read(h, sarah)).json()).toEqual({ language: 'en', choices: CHOICES });
  });

  it('is the organiser’s alone: a family member she allows is refused, and so is a neighbour', async () => {
    const { h, sarah, languageCards, withdrawn } = await home();
    const tom = await linkInvited(h, TOM, await invite(h, sarah));
    await residentAllows(h, tom.householdId, tom.userId);
    const june = await linkInvited(h, JUNE, await invite(h, sarah, 'neighbour'));
    await residentAllows(h, june.householdId, june.userId);
    await ask(h, sarah, { language: 'es' });

    for (const who of [tom, june]) {
      const asked = await ask(h, who, { language: 'es' });
      expect(asked.status).toBe(403);
      expect(await asked.json()).toEqual({ error: 'not_organiser', message: 'Only the person who set this home up can do that.' });

      const taken = await takeBack(h, who);
      expect(taken.status).toBe(403);
      expect(await taken.json()).toMatchObject({ error: 'not_organiser' });
    }
    // Sarah's question stands, untouched by either of them.
    expect(languageCards()).toHaveLength(1);
    expect(withdrawn).toEqual([]);
    expect(await (await read(h, sarah)).json()).toMatchObject({ asked: { language: 'es', by: 'Sarah' } });
  });

  it('asked again while the question is open, sends nothing again and says it is still on her television', async () => {
    const { h, sarah, languageCards } = await home();
    const first = (await (await ask(h, sarah, { language: 'es' })).json()) as { asked: unknown };

    const again = await ask(h, sarah, { language: 'es' });

    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({
      language: 'en',
      asked: first.asked,
      choices: CHOICES,
      say: 'That question is still on Margaret’s television. Nothing changes until she says yes.',
    });
    expect(languageCards()).toHaveLength(1);
  });

  it('says so in plain words, and leaves no question open, when her television could not be reached', async () => {
    let down = true;
    const cards: QueuedCard[] = [];
    const { h } = await server({
      sendCard: async (card) => {
        if (down && card.card.type === 'LANGUAGE') throw new Error('egress is down: arn:aws:iot:eu-west-2:123456789012:thing/x');
        cards.push(card);
      },
    });
    const sarah = await linkNewOrganiser(h);
    h.store.addTelevision(sarah.householdId, { deviceId: 'tv-1', pairedAt: 5, connected: true });

    const res = await ask(h, sarah, { language: 'es' });

    expect(res.status).toBe(503);
    const body = await res.text();
    expect(JSON.parse(body)).toMatchObject({
      error: 'not_sent',
      message: 'Wick could not be sure the question reached Margaret’s television, so it has taken it back. It can be asked again in a day.',
    });
    expect(body).not.toContain('arn:aws');
    // No question is open, and the day's wait has begun: it counts as asked and taken back.
    const after = (await (await read(h, sarah)).json()) as { language: string; asked?: unknown; takenBack?: { language: string } };
    expect(after.language).toBe('en');
    expect(after.asked).toBeUndefined();
    expect(after.takenBack?.language).toBe('es');

    down = false;
    const again = await ask(h, sarah, { language: 'es' });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe('taken_back_lately');
    expect(cards.filter((card) => card.card.type === 'LANGUAGE')).toHaveLength(0);
  });
});

describe('her answer — given on her television, read here', () => {
  it('yes: the television speaks Spanish, the question is gone, and English can be asked for back', async () => {
    const { h, sarah, languageCards } = await home();
    await ask(h, sarah, { language: 'es' });

    expect(h.store.answerLanguage(sarah.householdId, 'yes')).toBe('es');

    expect(await (await read(h, sarah)).json()).toEqual({ language: 'es', choices: CHOICES });
    const back = await ask(h, sarah, { language: 'en' });
    expect(await back.json()).toMatchObject({ language: 'es', asked: { language: 'en', by: 'Sarah' } });
    expect(languageCards().map((card) => card.id)).toEqual(['language-es', 'language-en']);
    expect(languageCards()[1]!.card).toMatchObject({ headline: 'Shall Wick speak English again?' });
  });

  it('no: nothing changed, the question is gone — and her no stands, so the same language is not asked for again that week', async () => {
    const { h, sarah, languageCards } = await home();
    const asked = ((await (await ask(h, sarah, { language: 'es' })).json()) as { asked: { at: number } }).asked;

    h.store.answerLanguage(sarah.householdId, 'no');

    const seen = (await (await read(h, sarah)).json()) as { declined: { language: string; at: number; askAgainAt: number; say: string } };
    expect(seen).toEqual({ language: 'en', choices: CHOICES, declined: { language: 'es', at: expect.any(Number) as number, askAgainAt: expect.any(Number) as number, say: expect.any(String) as string } });
    expect(seen.declined.at).toBeGreaterThanOrEqual(asked.at);
    expect(seen.declined.askAgainAt).toBe(seen.declined.at + 7 * 24 * 60 * 60_000);
    // By day, where the house is — and the same weekday a week on.
    expect(seen.declined.say).toMatch(/^Margaret said no to Spanish on (\w+day)\. You can ask again from \1 \d{1,2} \w+\.$/);

    const again = await ask(h, sarah, { language: 'es' });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'declined_lately', message: seen.declined.say });
    expect(languageCards()).toHaveLength(1);
    expect(await (await read(h, sarah)).json()).not.toHaveProperty('asked');
  });

  it('a week on, the same language is asked as before', async () => {
    // A Tuesday afternoon, well ahead of the day this runs: the sign-in library checks a token's expiry against the real clock.
    let clock = Date.UTC(2031, 9, 14, 14, 0);
    const { h, languageCards } = await server({ now: () => clock, store: createMemoryStore(() => clock) });
    const sarah = await linkNewOrganiser(h);
    h.store.addTelevision(sarah.householdId, { deviceId: 'tv-1', pairedAt: 5, connected: true });
    await ask(h, sarah, { language: 'es' });
    h.store.answerLanguage(sarah.householdId, 'no');

    // The app's own token lasts an hour: days on, it has been renewed, as the family app renews it.
    const renewed = async (who: { tokens: Tokens }): Promise<{ tokens: Tokens }> => {
      const res = await fetch(`${h.base}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: who.tokens.refresh_token, client_id: sarah.client.clientId }),
      });
      return { tokens: (await res.json()) as Tokens };
    };

    clock += 6 * 24 * 60 * 60_000;
    const sixDaysOn = await renewed(sarah);
    const early = await ask(h, sixDaysOn, { language: 'es' });
    expect(early.status).toBe(409);
    expect(await early.json()).toEqual({
      error: 'declined_lately',
      message: 'Margaret said no to Spanish on Tuesday. You can ask again from Tuesday 21 October.',
    });

    clock += 24 * 60 * 60_000;
    const aWeekOn = await renewed(sixDaysOn);
    const res = await ask(h, aWeekOn, { language: 'es' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ say: 'I have asked Margaret on her television. Nothing changes until she says yes.' });
    expect(languageCards()).toHaveLength(2);
    expect(await (await read(h, aWeekOn)).json()).not.toHaveProperty('declined');
  });

  it('her no is told to the organiser who asked, and to nobody else in the family', async () => {
    const { h, sarah } = await home();
    const tom = await linkInvited(h, TOM, await invite(h, sarah));
    await residentAllows(h, tom.householdId, tom.userId);
    await ask(h, sarah, { language: 'es' });
    h.store.answerLanguage(sarah.householdId, 'no');

    expect(await (await read(h, sarah)).json()).toHaveProperty('declined');
    expect(await (await read(h, tom)).json()).toEqual({ language: 'en', choices: CHOICES });
  });

  it('a question taken back is not a no — nothing of hers is recorded', async () => {
    const { h, sarah } = await home();
    await ask(h, sarah, { language: 'es' });
    await takeBack(h, sarah);

    expect(await (await read(h, sarah)).json()).not.toHaveProperty('declined');
    expect((await h.store.getHousehold(sarah.householdId))?.languageDeclined).toBeUndefined();
  });
});

describe('asking and taking back is not a way to put the question to her over and over', () => {
  const TOOK_BACK = /^You took that question back this (morning|afternoon|evening)\. You can ask Margaret again tomorrow \1\.$/;

  it('ask, take back, ask, take back …: the question reaches her television once, and each further asking is refused in words', async () => {
    const { h, sarah, languageCards, withdrawn } = await home();

    expect((await ask(h, sarah, { language: 'es' })).status).toBe(200);
    for (let round = 0; round < 4; round += 1) {
      expect((await takeBack(h, sarah)).status).toBe(200);
      const again = await ask(h, sarah, { language: 'es' });
      expect(again.status).toBe(409);
      const body = (await again.json()) as { error: string; message: string };
      expect(body.error).toBe('taken_back_lately');
      expect(body.message).toMatch(TOOK_BACK);
    }

    expect(languageCards()).toHaveLength(1);
    expect(withdrawn).toHaveLength(1);
    expect(await (await read(h, sarah)).json()).not.toHaveProperty('asked');
  });

  it('tells the organiser, while the day runs, when it can be asked again — and nobody else in the family', async () => {
    const { h, sarah } = await home();
    const tom = await linkInvited(h, TOM, await invite(h, sarah));
    await residentAllows(h, tom.householdId, tom.userId);
    const before = Date.now();
    await ask(h, sarah, { language: 'es' });
    await takeBack(h, sarah);

    const seen = (await (await read(h, sarah)).json()) as { takenBack: { language: string; at: number; askAgainAt: number; say: string } };
    expect(seen).toEqual({
      language: 'en',
      choices: CHOICES,
      takenBack: { language: 'es', at: expect.any(Number) as number, askAgainAt: expect.any(Number) as number, say: expect.stringMatching(TOOK_BACK) as string },
    });
    expect(seen.takenBack.at).toBeGreaterThanOrEqual(before);
    expect(seen.takenBack.askAgainAt).toBe(seen.takenBack.at + 24 * 60 * 60_000);
    expect(await (await read(h, tom)).json()).toEqual({ language: 'en', choices: CHOICES });
  });

  it('a day on, the same language is asked as before', async () => {
    // A Tuesday afternoon, well ahead of the day this runs: the sign-in library checks a token's expiry against the real clock.
    let clock = Date.UTC(2031, 9, 14, 14, 0);
    const { h, languageCards } = await server({ now: () => clock, store: createMemoryStore(() => clock) });
    const sarah = await linkNewOrganiser(h);
    h.store.addTelevision(sarah.householdId, { deviceId: 'tv-1', pairedAt: 5, connected: true });
    await ask(h, sarah, { language: 'es' });
    await takeBack(h, sarah);
    const renewed = async (who: { tokens: Tokens }): Promise<{ tokens: Tokens }> => {
      const res = await fetch(`${h.base}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: who.tokens.refresh_token, client_id: sarah.client.clientId }),
      });
      return { tokens: (await res.json()) as Tokens };
    };

    clock += 20 * 60 * 60_000;
    const nextMorning = await renewed(sarah);
    const early = await ask(h, nextMorning, { language: 'es' });
    expect(early.status).toBe(409);
    expect(await early.json()).toEqual({
      error: 'taken_back_lately',
      message: 'You took that question back yesterday afternoon. You can ask Margaret again this afternoon.',
    });

    clock += 4 * 60 * 60_000;
    const aDayOn = await renewed(nextMorning);
    expect((await ask(h, aDayOn, { language: 'es' })).status).toBe(200);
    expect(languageCards()).toHaveLength(2);
    expect(await (await read(h, aDayOn)).json()).not.toHaveProperty('takenBack');
  });

  it('counts every wait by the server’s own clock: no time in a request is read', async () => {
    const { h, sarah, languageCards } = await home();
    const longAgo = 1_000;
    const times = { at: longAgo, now: longAgo, askedAt: longAgo, takenBackAt: longAgo, languageAskedAt: longAgo, languageTakenBackAt: longAgo, languageDeclinedAt: longAgo, askAgainAt: longAgo };
    const before = Date.now();

    const asked = (await (await ask(h, sarah, { language: 'es', ...times })).json()) as { asked: { at: number } };
    expect(asked.asked.at).toBeGreaterThanOrEqual(before);

    await call(h, sarah, 'DELETE', '/api/language/question?at=1000&now=1000&takenBackAt=1000', times);
    const seen = (await (await read(h, sarah, '/api/language?now=9999999999999&at=1000')).json()) as { takenBack: { at: number } };
    expect(seen.takenBack.at).toBeGreaterThanOrEqual(before);

    // A request that claims the day is long over is refused like any other.
    const again = await fetch(`${h.base}/api/language?now=9999999999999`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sarah.tokens.access_token}`, 'content-type': 'application/json', date: 'Tue, 01 Jan 2099 00:00:00 GMT', 'x-now': '9999999999999' },
      body: JSON.stringify({ language: 'es', now: 9_999_999_999_999, at: 9_999_999_999_999 }),
    });
    expect(again.status).toBe(409);
    expect(languageCards()).toHaveLength(1);
  });
});

describe('who may ask — the organiser, while she has not said no to them', () => {
  it.each(['declined', 'removed'] as const)('refuses an organiser who is %s on all three routes, and touches nothing', async (status) => {
    const { h, sarah, languageCards, withdrawn } = await home();
    await ask(h, sarah, { language: 'es' });
    await h.store.setMemberStatus(sarah.householdId, sarah.userId, status, Date.now());

    const seen = await read(h, sarah);
    expect(seen.status).toBe(403);
    expect(await seen.json()).toEqual({
      error: 'not_allowed_yet',
      message: status === 'declined' ? 'Margaret chose not to share this with you.' : 'You are no longer part of this family circle.',
    });
    for (const res of [await ask(h, sarah, { language: 'es' }), await ask(h, sarah, { language: 'en' }), await takeBack(h, sarah)]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'not_organiser', message: 'Only the person who set this home up can do that.' });
    }

    expect(languageCards()).toHaveLength(1);
    expect(withdrawn).toEqual([]);
    expect((await h.store.getHousehold(sarah.householdId))?.languageAsked).toMatchObject({ language: 'es' });
  });

  it('bounds an organiser still waiting for her by the same two waits', async () => {
    const { h, sarah, languageCards } = await home();
    expect(await h.store.getMembership(sarah.householdId, sarah.userId)).toMatchObject({ role: 'organiser', status: 'pending' });

    await ask(h, sarah, { language: 'es' });
    await takeBack(h, sarah);
    expect(await (await ask(h, sarah, { language: 'es' })).json()).toMatchObject({ error: 'taken_back_lately' });

    // Her no, to a question asked before any of that.
    const other = await home();
    await ask(other.h, other.sarah, { language: 'es' });
    other.h.store.answerLanguage(other.sarah.householdId, 'no');
    expect(await (await ask(other.h, other.sarah, { language: 'es' })).json()).toMatchObject({ error: 'declined_lately' });

    expect(languageCards()).toHaveLength(1);
    expect(other.languageCards()).toHaveLength(1);
  });
});

describe('the stand-in television’s press is the dev server’s alone', () => {
  it('is no route of the server that is deployed', async () => {
    const { h, sarah } = await home();
    await ask(h, sarah, { language: 'es' });

    for (const path of ['/dev/language', '/dev/language?press=no', '/dev/allow', '/api/dev/language']) {
      for (const method of ['GET', 'POST']) {
        const res = await fetch(`${h.base}${path}`, { method, headers: { authorization: `Bearer ${sarah.tokens.access_token}` } });
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    }
    expect(await (await read(h, sarah)).json()).toMatchObject({ language: 'en', asked: { language: 'es' } });
  });

  it('and nothing the deployed server runs imports a test’s stand-in', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const sources = (readdirSync(root, { recursive: true }) as string[])
      .filter((file) => file.endsWith('.ts') && !file.split(/[\\/]/).includes('__tests__'))
      .map((file) => ({ file, text: readFileSync(join(root, file), 'utf8') }));
    expect(sources.length).toBeGreaterThan(40);

    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/from\s+['"][^'"]*__tests__/);
      expect(text, file).not.toMatch(/['"`]\/dev\//);
      expect(text, file).not.toMatch(/answerLanguage/);
    }
  });
});

describe('DELETE /api/language/question — the organiser takes the question back', () => {
  it('takes the card off her television and closes the question', async () => {
    const { h, sarah, withdrawn } = await home();
    await ask(h, sarah, { language: 'es' });

    const res = await takeBack(h, sarah);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { takenBack: unknown };
    expect(body).toEqual({
      language: 'en',
      choices: CHOICES,
      // Taking it back is the organiser's to do, and it is kept: that language is not asked for again for a day.
      takenBack: { language: 'es', at: expect.any(Number) as number, askAgainAt: expect.any(Number) as number, say: expect.any(String) as string },
      say: 'I have taken the question back. Margaret’s television still speaks English.',
    });
    expect(withdrawn).toEqual([{ householdId: sarah.householdId, cardId: 'language-es' }]);
    expect(await (await read(h, sarah)).json()).toEqual({ language: 'en', choices: CHOICES, takenBack: body.takenBack });
    // A press on a card she still had in front of her answers nothing: there is no question open.
    expect(h.store.answerLanguage(sarah.householdId, 'yes')).toBeUndefined();
    expect(await (await read(h, sarah)).json()).toMatchObject({ language: 'en' });
  });

  it('is idempotent: a second time, or with nothing asked, it changes nothing and withdraws nothing', async () => {
    const { h, sarah, withdrawn } = await home();

    const nothing = await takeBack(h, sarah);
    expect(nothing.status).toBe(200);
    expect(await nothing.json()).toEqual({ language: 'en', choices: CHOICES, say: 'There is no question on Margaret’s television to take back.' });

    await ask(h, sarah, { language: 'es' });
    const first = (await (await takeBack(h, sarah)).json()) as { takenBack: { at: number } };
    const again = await takeBack(h, sarah);

    expect(again.status).toBe(200);
    // The same record, to the millisecond: a second taking back does not start the day again.
    expect(await again.json()).toEqual({ language: 'en', choices: CHOICES, takenBack: first.takenBack, say: 'There is no question on Margaret’s television to take back.' });
    expect(withdrawn).toHaveLength(1);
  });

  it('cannot take back her answer: once she has said yes, her television speaks Spanish', async () => {
    const { h, sarah, withdrawn } = await home();
    await ask(h, sarah, { language: 'es' });
    h.store.answerLanguage(sarah.householdId, 'yes');

    const res = await takeBack(h, sarah);

    expect(await res.json()).toMatchObject({ language: 'es' });
    expect(withdrawn).toEqual([]);
    expect(await (await read(h, sarah)).json()).toEqual({ language: 'es', choices: CHOICES });
  });
});

describe('INV-8: the household is the token’s — no request can name another', () => {
  async function twoHomes() {
    const w = await server();
    const sarah = await linkNewOrganiser(w.h);
    const priya = await linkNewOrganiser(w.h, PRIYA, 'Asha');
    for (const who of [sarah, priya]) w.h.store.addTelevision(who.householdId, { deviceId: `tv-${who.userId}`, pairedAt: 5, connected: true });
    return { ...w, sarah, priya };
  }

  it('asks only the asker’s own home, whatever household a body, an address or a header names', async () => {
    const { h, sarah, priya, languageCards } = await twoHomes();
    const theirs = priya.householdId;

    const res = await fetch(`${h.base}/api/language?householdId=${theirs}&household=${theirs}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sarah.tokens.access_token}`, 'content-type': 'application/json', 'x-household-id': theirs },
      body: JSON.stringify({ language: 'es', householdId: theirs, household: theirs, hh: theirs }),
    });

    expect(res.status).toBe(200);
    expect(languageCards().map((card) => card.card.householdId)).toEqual([sarah.householdId]);
    expect(await (await read(h, priya)).json()).toEqual({ language: 'en', choices: CHOICES });
    expect((await h.store.getHousehold(theirs))?.languageAsked).toBeUndefined();
  });

  it('reads and takes back only in the asker’s own home', async () => {
    const { h, sarah, priya, withdrawn } = await twoHomes();
    await ask(h, sarah, { language: 'es' });

    // Priya, naming Sarah's home every way a request could.
    const seen = await read(h, priya, `/api/language?householdId=${sarah.householdId}`);
    expect(await seen.json()).toEqual({ language: 'en', choices: CHOICES });

    const taken = await fetch(`${h.base}/api/language/question?householdId=${sarah.householdId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${priya.tokens.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ householdId: sarah.householdId }),
    });
    expect(taken.status).toBe(200);
    expect(withdrawn).toEqual([]);
    expect(await (await read(h, sarah)).json()).toMatchObject({ asked: { language: 'es', by: 'Sarah' } });
  });

  it('there is no route that takes a household in its address', async () => {
    const { h, sarah } = await twoHomes();

    for (const path of [`/api/language/${sarah.householdId}`, `/api/households/${sarah.householdId}/language`]) {
      expect((await read(h, sarah, path)).status).toBe(404);
      expect((await ask(h, sarah, { language: 'es' }, path)).status).toBe(404);
    }
  });
});

describe('the demo home — a guest is its organiser, so the asking works there unchanged', () => {
  it('lets a guest ask on the demo home’s television, as Guest, and take the question back', async () => {
    const { h, languageCards, withdrawn } = await server({ demoAccounts: true });
    // One click on the family app's demo button (demo.test.ts).
    const browser = new Browser(h.base);
    const client = await registerClient(h.base);
    const tx = await beginAuthorize(browser, client, { demo: '1' });
    const landed = await browser.get(`/account?tx=${tx}`);
    const code = new URL(landed.headers.get('location')!).searchParams.get('code')!;
    const guest = { tokens: (await (await exchangeCode(h.base, client, code)).json()) as Tokens };
    const me = (await (await call(h, guest, 'GET', '/api/me')).json()) as { household: { householdId: string; simulated?: boolean }; membership: { role: string } };
    expect(me).toMatchObject({ household: { simulated: true }, membership: { role: 'organiser' } });

    // No television yet: the virtual one has not been connected.
    expect((await ask(h, guest, { language: 'es' })).status).toBe(409);
    h.store.addTelevision(me.household.householdId, { deviceId: 'virtual-tv', pairedAt: 5, connected: true });

    const res = await ask(h, guest, { language: 'es' });

    expect(res.status).toBe(200);
    expect(languageCards()).toHaveLength(1);
    expect(languageCards()[0]!.card).toMatchObject({ householdId: me.household.householdId, detail: languageQuestion('es', 'Guest').detail });

    h.store.answerLanguage(me.household.householdId, 'yes');
    expect(await (await read(h, guest)).json()).toEqual({ language: 'es', choices: CHOICES });
    // The demo home's mark is the household's own, and is still there.
    expect((await h.store.getHousehold(me.household.householdId))?.simulated).toBe(true);
    expect(withdrawn).toEqual([]);
  });
});
