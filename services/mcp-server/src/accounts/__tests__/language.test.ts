import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import {
  HOUSEHOLD_LANGUAGE_ATTRS,
  LANGUAGE_ASK_AFTER_TAKING_BACK_MS,
  LANGUAGE_ASK_AGAIN_AFTER_MS,
  MAX_CARD_DETAIL_CHARS,
  languageQuestion,
  type QueuedCard,
} from '@wick/contracts';
import { CircleError } from '../circle.js';
import {
  LanguageRefusal,
  askForLanguage,
  buildLanguageCard,
  languageView,
  readLanguage,
  takeBackLanguageQuestion,
  type LanguageDeps,
} from '../language.js';
import { createDynamoAccountStore, type AccountStore, type DdbSend } from '../store.js';
import type { Household, Membership } from '../types.js';
import { createMemoryTable } from '../../__tests__/memoryTable.js';
import { createMemoryStore } from './memoryStore.js';

const NOW = 1_790_000_000_000;
const HH = 'hh_1';
const SARAH = { householdId: HH, userId: 'u_sarah' };
const TOM = { householdId: HH, userId: 'u_tom' };

const HOME: Household = { householdId: HH, name: 'Mum’s house', residentName: 'Margaret', createdBy: 'u_sarah', createdAt: 1 };

type Item = Record<string, AttributeValue>;
interface Sent {
  readonly constructor: { readonly name: string };
  readonly input: {
    readonly Key?: Item;
    readonly Item?: Item;
    readonly UpdateExpression?: string;
    readonly ConditionExpression?: string;
    readonly ExpressionAttributeNames?: Record<string, string>;
    readonly ExpressionAttributeValues?: Record<string, AttributeValue>;
  };
}

const member = (over: Partial<Membership> = {}): Membership => ({
  householdId: HH,
  userId: 'u_sarah',
  name: 'Sarah Bennett',
  role: 'organiser',
  status: 'allowed',
  requestedAt: 1,
  ...over,
});

/**
 * The household's own row in a table that checks the store's real
 * conditions (memoryTable.ts), with every request recorded; the circle and
 * the televisions in the memory store, as everywhere else.
 */
async function setup(options: { television?: boolean; sarah?: Partial<Membership>; timeZone?: string } = {}) {
  const table = createMemoryTable();
  const sent: Sent[] = [];
  const events: string[] = [];
  const before: ((command: Sent) => void)[] = [];
  const send = (async (command: Sent) => {
    for (const hook of before.splice(0)) hook(command);
    sent.push(command);
    events.push(command.constructor.name);
    return (table.ddb as unknown as { send: (c: unknown) => Promise<object> }).send(command);
  }) as unknown as DdbSend;
  const dynamo = createDynamoAccountStore(send, 'wick', () => NOW);
  const memory = createMemoryStore(() => NOW);
  const store: AccountStore = {
    ...memory,
    createHousehold: dynamo.createHousehold,
    getHousehold: dynamo.getHousehold,
    askLanguage: dynamo.askLanguage,
    takeBackLanguageQuestion: dynamo.takeBackLanguageQuestion,
    clearLanguageQuestion: dynamo.clearLanguageQuestion,
  };

  await store.createHousehold(HOME);
  await store.putMembership(member(options.sarah));
  await store.putMembership(member({ userId: 'u_tom', name: 'Tom', role: 'family' }));
  if (options.television !== false) memory.addTelevision(HH, { deviceId: 'tv-1', pairedAt: 5, connected: true });
  sent.length = 0;
  events.length = 0;

  const cards: QueuedCard[] = [];
  const withdrawn: { householdId: string; cardId: string }[] = [];
  const world = { sendFails: false, clock: NOW };
  const deps: LanguageDeps = {
    store,
    sendCard: async (card) => {
      if (world.sendFails) throw new Error('egress is down');
      events.push(`card ${card.id}`);
      cards.push(card);
    },
    withdrawCard: async (householdId, cardId) => {
      if (world.sendFails) throw new Error('egress is down');
      events.push(`withdraw ${cardId}`);
      withdrawn.push({ householdId, cardId });
    },
    now: () => world.clock,
    timeZone: options.timeZone ?? 'Europe/London',
  };

  const meta = (): Item => table.rows(`HH#${HH}`).find((row) => row.sk?.S === 'META')!;
  /** The household's row, written whole — only ever by this test, standing in for the edge. */
  const writeMeta = (change: (row: Item) => void): void => {
    const row = { ...meta() };
    change(row);
    table.put(row);
  };
  /**
   * What the resident's press on the LANGUAGE card does (the edge, written
   * elsewhere): only a question still open is answered; "yes" makes it the
   * television's language and forgets any no; "no" is kept, with when;
   * either answer closes the question.
   */
  const residentPresses = (answer: 'yes' | 'no'): void =>
    writeMeta((row) => {
      const asked = row.languageAsked?.S;
      if (!asked) return;
      if (answer === 'yes') {
        row.language = { S: asked };
        delete row.languageDeclined;
        delete row.languageDeclinedAt;
      } else {
        row.languageDeclined = { S: asked };
        row.languageDeclinedAt = { N: String(world.clock) };
      }
      delete row.languageAsked;
      delete row.languageAskedBy;
      delete row.languageAskedAt;
    });

  const updates = (): Sent[] => sent.filter((command) => command.constructor.name === 'UpdateItemCommand');
  return { deps, store, memory, table, sent, events, cards, withdrawn, world, meta, writeMeta, residentPresses, updates, beforeNext: (hook: (command: Sent) => void) => void before.push(hook) };
}

const refusal = async (attempt: Promise<unknown>): Promise<LanguageRefusal> => {
  const err: unknown = await attempt.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(err).toBeInstanceOf(LanguageRefusal);
  return err as LanguageRefusal;
};

describe('languageView — what the family app is told', () => {
  it('is English until she has chosen another, with what can be asked for, each named in English and in itself', () => {
    expect(languageView(HOME)).toEqual({
      language: 'en',
      choices: [
        { language: 'en', name: 'English', own: 'English' },
        { language: 'es', name: 'Spanish', own: 'español' },
      ],
    });
  });

  it('names the language she chose, and a question still open on her television', () => {
    const view = languageView({ ...HOME, language: 'es', languageAsked: { language: 'en', by: 'Sarah', at: NOW } });

    expect(view.language).toBe('es');
    expect(view.asked).toEqual({ language: 'en', by: 'Sarah', at: NOW });
  });

  it('does not call a question open when it asks for the language her television already speaks', () => {
    expect(languageView({ ...HOME, language: 'es', languageAsked: { language: 'es', by: 'Sarah', at: NOW } })).not.toHaveProperty('asked');
  });
});

describe('buildLanguageCard — the question, in both languages at once', () => {
  it('is one deferred card whose id names the language, carrying the contract’s own words unchanged', () => {
    expect(buildLanguageCard(HOME, { language: 'es', by: 'Sarah', at: NOW })).toEqual({
      id: 'language-es',
      urgency: 'DEFERRED',
      queuedAt: NOW,
      shownCount: 0,
      card: {
        type: 'LANGUAGE',
        id: 'language-es',
        householdId: HH,
        correlationId: 'language-es',
        createdAt: NOW,
        language: 'es',
        ...languageQuestion('es', 'Sarah'),
      },
    });
  });

  it('asks for English back in the same way', () => {
    const { card } = buildLanguageCard({ ...HOME, language: 'es' }, { language: 'en', by: 'Sarah', at: NOW });

    expect(card).toMatchObject({ type: 'LANGUAGE', id: 'language-en', language: 'en', headline: 'Shall Wick speak English again?' });
    expect(card.actions.map((action) => action.id)).toEqual(['yes', 'no']);
  });
});

describe('askForLanguage — the organiser asks, and nothing changes', () => {
  it('writes the question with one conditional update, then puts one card on her television', async () => {
    const w = await setup();

    const answer = await askForLanguage(w.deps, SARAH, 'es');

    expect(w.updates()).toHaveLength(1);
    expect(w.updates()[0]!.input.ConditionExpression).toBeDefined();
    expect(w.cards).toEqual([buildLanguageCard(HOME, { language: 'es', by: 'Sarah', at: NOW })]);
    // The question is on the household before the card is on the television: her press only answers one still open.
    expect(w.events.filter((event) => event !== 'GetItemCommand')).toEqual(['UpdateItemCommand', 'card language-es']);
    expect(w.meta()).toMatchObject({ languageAsked: { S: 'es' }, languageAskedBy: { S: 'Sarah' }, languageAskedAt: { N: String(NOW) } });
    // Nothing has changed: her television speaks what it spoke.
    expect(w.meta().language).toBeUndefined();
    expect(answer).toEqual({
      view: { language: 'en', asked: { language: 'es', by: 'Sarah', at: NOW }, choices: languageView(HOME).choices },
      say: 'I have asked Margaret on her television. Nothing changes until she says yes.',
    });
  });

  it('names the organiser by their first name, from their membership', async () => {
    const w = await setup({ sarah: { name: '  Sarah   Bennett ' } });

    await askForLanguage(w.deps, SARAH, 'es');

    expect(w.cards[0]!.card).toMatchObject({ detail: languageQuestion('es', 'Sarah').detail });
  });

  it('keeps the name whole beside the question, and leaves fitting it on the card to the contract', async () => {
    // Somebody with no name is known by their email address (circle.ts), and that can be long.
    const long = 'sarah.elizabeth.bennett-hargreaves@example.com'.slice(0, 40);
    const w = await setup({ sarah: { name: long } });

    await askForLanguage(w.deps, SARAH, 'es');

    // Not cut here: the contract cuts a long name where the card is worded, once.
    expect(w.meta().languageAskedBy).toEqual({ S: long });
    const card = w.cards[0]!.card as { detail: string };
    expect(card.detail).toBe(languageQuestion('es', long).detail);
    expect(card.detail.length).toBeLessThanOrEqual(MAX_CARD_DETAIL_CHARS);
    // The sentence she agrees by is all there, in both languages.
    expect(card.detail).toContain('Solo cambia si usted dice que sí.');
    expect(card.detail.endsWith('Nothing changes unless you say yes.')).toBe(true);
  });

  it('can be asked by an organiser she has not allowed yet: the card that would allow them is one she may not be able to read', async () => {
    const w = await setup({ sarah: { status: 'pending' } });

    await askForLanguage(w.deps, SARAH, 'es');

    expect(w.cards.map((card) => card.id)).toEqual(['language-es']);
  });

  it.each([['fr'], ['ES'], [''], [7], [null], [undefined], [['es']], [{ language: 'es' }]])('refuses %j: not a language Wick has', async (wanted) => {
    const w = await setup();

    const refused = await refusal(askForLanguage(w.deps, SARAH, wanted));

    expect(refused).toMatchObject({ status: 400, code: 'bad_language', message: 'Wick does not have that language yet. It has English and Spanish.' });
    expect(w.updates()).toEqual([]);
    expect(w.cards).toEqual([]);
  });

  it('refuses the language her television already speaks — English, when she has chosen none', async () => {
    const w = await setup();

    const refused = await refusal(askForLanguage(w.deps, SARAH, 'en'));

    expect(refused).toMatchObject({ status: 409, code: 'already_speaks', message: 'Margaret’s television already speaks English.' });
    expect(w.updates()).toEqual([]);
    expect(w.cards).toEqual([]);
  });

  it('refuses Spanish once she has said yes to it, and can then ask for English back', async () => {
    const w = await setup();
    await askForLanguage(w.deps, SARAH, 'es');
    w.residentPresses('yes');

    const refused = await refusal(askForLanguage(w.deps, SARAH, 'es'));
    expect(refused.message).toBe('Margaret’s television already speaks Spanish.');

    w.world.clock = NOW + 60_000;
    await askForLanguage(w.deps, SARAH, 'en');
    expect(w.cards.map((card) => card.id)).toEqual(['language-es', 'language-en']);
    expect(w.cards[1]).toEqual(buildLanguageCard(HOME, { language: 'en', by: 'Sarah', at: NOW + 60_000 }));
  });

  it('refuses while no television is paired: there is nowhere to ask her', async () => {
    const w = await setup({ television: false });

    const refused = await refusal(askForLanguage(w.deps, SARAH, 'es'));

    expect(refused).toMatchObject({
      status: 409,
      code: 'no_television',
      message: 'Connect Margaret’s television first. She is asked on it, and there is nowhere to ask her yet.',
    });
    expect(w.updates()).toEqual([]);
    expect(w.cards).toEqual([]);
  });

  it('is the organiser’s alone: not a family member she allows, not a neighbour, not an organiser she turned down', async () => {
    const w = await setup();
    await w.store.putMembership(member({ userId: 'u_june', name: 'June', role: 'neighbour' }));
    await w.store.putMembership(member({ userId: 'u_old', name: 'Olive', role: 'organiser', status: 'declined' }));

    for (const userId of ['u_tom', 'u_june', 'u_old', 'u_nobody']) {
      await expect(askForLanguage(w.deps, { householdId: HH, userId }, 'es')).rejects.toMatchObject({ code: 'not_organiser' });
      await expect(takeBackLanguageQuestion(w.deps, { householdId: HH, userId })).rejects.toBeInstanceOf(CircleError);
    }
    expect(w.sent).toEqual([]);
    expect(w.cards).toEqual([]);
  });

  it('asked again while the same question is open, sends nothing again and says it is still there', async () => {
    const w = await setup();
    await askForLanguage(w.deps, SARAH, 'es');
    w.world.clock = NOW + 60_000;

    w.sent.length = 0;
    w.events.length = 0;

    const again = await askForLanguage(w.deps, SARAH, 'es');

    // Nothing reaches her television and nothing is written: the card she has is the card she had, with the
    // showings it has used. (A second card of the same id would be stored over it, and start them again.)
    expect(w.events).toEqual(['GetItemCommand']);
    expect(w.cards).toHaveLength(1);
    expect(w.withdrawn).toEqual([]);
    expect(w.meta().languageAskedAt).toEqual({ N: String(NOW) });
    expect(again).toEqual({
      view: { language: 'en', asked: { language: 'es', by: 'Sarah', at: NOW }, choices: languageView(HOME).choices },
      say: 'That question is still on Margaret’s television. Nothing changes until she says yes.',
    });
  });

  it('sends no card when her answer got there first: the write is refused, and that is said', async () => {
    const w = await setup();
    // Read as English with nothing open — and then, before the write, another question is asked and answered yes.
    w.beforeNext(() =>
      w.beforeNext(() => w.writeMeta((row) => void (row.language = { S: 'es' }))),
    );

    const refused = await refusal(askForLanguage(w.deps, SARAH, 'es'));

    expect(refused).toMatchObject({ status: 409, code: 'changed', message: 'Something changed on Margaret’s television just then. Look again before asking.' });
    expect(w.cards).toEqual([]);
    expect(w.meta().languageAsked).toBeUndefined();
  });

  it('leaves no question open when the card could not be sent: nobody is told she was asked when she was not', async () => {
    const w = await setup();
    w.world.sendFails = true;

    await expect(askForLanguage(w.deps, SARAH, 'es')).rejects.toThrow('egress is down');

    expect(w.meta().languageAsked).toBeUndefined();
    expect(w.meta().languageAskedBy).toBeUndefined();
    expect(w.meta().languageAskedAt).toBeUndefined();

    // She was never asked, so this is not a taking back: nothing is recorded, and it can be asked at once.
    expect(w.meta().languageTakenBack).toBeUndefined();
    w.world.sendFails = false;
    await askForLanguage(w.deps, SARAH, 'es');
    expect(w.cards.map((card) => card.id)).toEqual(['language-es']);
  });

  it('takes a card that may have been half sent off her television again, as far as it can', async () => {
    const w = await setup();
    // The card is stored before it is pushed (egress.ts): a push that fails can leave one that would arrive later.
    let calls = 0;
    const deps: LanguageDeps = {
      ...w.deps,
      sendCard: async () => {
        calls += 1;
        throw new Error('push failed');
      },
    };

    await expect(askForLanguage(deps, SARAH, 'es')).rejects.toThrow('push failed');

    expect(calls).toBe(1);
    expect(w.withdrawn).toEqual([{ householdId: HH, cardId: 'language-es' }]);
    expect(w.meta().languageAsked).toBeUndefined();
  });

  it('replaces a question for another language: the old card is taken back, then the new one sent, with one update', async () => {
    const w = await setup();
    // With two languages this is only ever a question left over for the language she has since chosen.
    w.writeMeta((row) => {
      row.language = { S: 'es' };
      row.languageAsked = { S: 'es' };
      row.languageAskedBy = { S: 'Sarah' };
      row.languageAskedAt = { N: String(NOW - 5) };
    });

    const answer = await askForLanguage(w.deps, SARAH, 'en');

    expect(w.updates()).toHaveLength(1);
    expect(w.updates()[0]!.input.ConditionExpression).toContain('#asked = :replacing');
    expect(w.events.filter((event) => event !== 'GetItemCommand')).toEqual(['UpdateItemCommand', 'withdraw language-es', 'card language-en']);
    expect(w.withdrawn).toEqual([{ householdId: HH, cardId: 'language-es' }]);
    expect(w.meta()).toMatchObject({ language: { S: 'es' }, languageAsked: { S: 'en' }, languageAskedAt: { N: String(NOW) } });
    expect(answer.view).toMatchObject({ language: 'es', asked: { language: 'en', by: 'Sarah', at: NOW } });
    // The one left over was not a question on her television: nothing is recorded as taken back.
    expect(w.meta().languageTakenBack).toBeUndefined();
  });

  it('cannot use a question left over to get round her no, or a taking back: the language wanted is refused first, and nothing is touched', async () => {
    for (const standing of ['languageDeclined', 'languageTakenBack'] as const) {
      const w = await setup();
      w.writeMeta((row) => {
        row.language = { S: 'es' };
        row.languageAsked = { S: 'es' };
        row.languageAskedBy = { S: 'Sarah' };
        row.languageAskedAt = { N: String(NOW - 5) };
        row[standing] = { S: 'en' };
        row[`${standing}At`] = { N: String(NOW - 1000) };
      });
      const before = w.meta();

      const refused = await refusal(askForLanguage(w.deps, SARAH, 'en'));

      expect(refused.code).toBe(standing === 'languageDeclined' ? 'declined_lately' : 'taken_back_lately');
      expect(w.updates()).toEqual([]);
      expect(w.withdrawn).toEqual([]);
      expect(w.cards).toEqual([]);
      expect(w.meta()).toEqual(before);
    }
  });
});

describe('a question taken back is not asked again for a day', () => {
  const DAY = LANGUAGE_ASK_AFTER_TAKING_BACK_MS;
  // NOW is Monday 21 September 2026, 15:13 where the house is (Europe/London).
  const TOOK_BACK = 'You took that question back this afternoon. You can ask Margaret again tomorrow afternoon.';

  async function takenBack(options: Parameters<typeof setup>[0] = {}) {
    const w = await setup(options);
    await askForLanguage(w.deps, SARAH, 'es');
    await takeBackLanguageQuestion(w.deps, SARAH);
    w.sent.length = 0;
    w.cards.length = 0;
    w.withdrawn.length = 0;
    return w;
  }

  it('records the taking back in the same update that clears the question: which language, and when by this server’s clock', async () => {
    const w = await setup();
    await askForLanguage(w.deps, SARAH, 'es');
    w.world.clock = NOW + 90_000;
    w.sent.length = 0;

    await takeBackLanguageQuestion(w.deps, SARAH);

    expect(w.updates()).toHaveLength(1);
    expect(w.updates()[0]!.input.UpdateExpression).toBe('SET #takenBack = :asked, #takenBackAt = :takenBackAt REMOVE #asked, #by, #at');
    expect(w.meta()).toMatchObject({ languageTakenBack: { S: 'es' }, languageTakenBackAt: { N: String(NOW + 90_000) } });
    expect(w.meta().languageAsked).toBeUndefined();
  });

  it('refuses that language again inside the day, and says when — by the part of the day, where the house is', async () => {
    const w = await takenBack();
    w.world.clock = NOW + 60_000;

    const refused = await refusal(askForLanguage(w.deps, SARAH, 'es'));

    expect(refused).toMatchObject({ status: 409, code: 'taken_back_lately', message: TOOK_BACK });
    expect(w.updates()).toEqual([]);
    expect(w.cards).toEqual([]);
    expect(w.meta().languageAsked).toBeUndefined();
  });

  it('ask, take back, ask, take back: the question reaches her television once', async () => {
    const w = await setup();

    for (let round = 0; round < 5; round += 1) {
      w.world.clock = NOW + round * 60_000;
      await askForLanguage(w.deps, SARAH, 'es').catch(() => undefined);
      await takeBackLanguageQuestion(w.deps, SARAH);
    }

    expect(w.cards.map((card) => card.id)).toEqual(['language-es']);
    expect(w.withdrawn).toHaveLength(1);
    // And taking back again, with nothing open, did not move the moment the day is counted from.
    expect(w.meta().languageTakenBackAt).toEqual({ N: String(NOW) });
  });

  it('counts the day to the moment: refused until it has passed, asked as before once it has', async () => {
    const w = await takenBack();

    w.world.clock = NOW + DAY - 1;
    const last = await refusal(askForLanguage(w.deps, SARAH, 'es'));
    // The afternoon it can be asked again has come, and the minute has not: said as it is.
    expect(last.message).toBe('You took that question back yesterday afternoon. You can ask Margaret again later this afternoon.');
    expect(w.cards).toEqual([]);

    w.world.clock = NOW + DAY;
    const answer = await askForLanguage(w.deps, SARAH, 'es');
    expect(answer.say).toBe('I have asked Margaret on her television. Nothing changes until she says yes.');
    expect(answer.view).not.toHaveProperty('takenBack');
    expect(w.cards.map((card) => card.id)).toEqual(['language-es']);
  });

  it.each([
    // Taken back at half past eleven at night; asked again at nine the next morning.
    [Date.UTC(2026, 9, 13, 22, 30), 9.5 * 60 * 60_000, 'You took that question back yesterday evening. You can ask Margaret again this evening.'],
    // Taken back at eight in the morning; asked again that evening.
    [Date.UTC(2026, 9, 13, 7, 0), 12 * 60 * 60_000, 'You took that question back this morning. You can ask Margaret again tomorrow morning.'],
    // Taken back just before midnight; asked again just after it.
    [Date.UTC(2026, 9, 13, 22, 55), 10 * 60_000, 'You took that question back yesterday evening. You can ask Margaret again this evening.'],
  ])('words both moments from the times themselves (%#)', async (tookBackAt, later, sentence) => {
    const w = await setup();
    w.world.clock = tookBackAt;
    await askForLanguage(w.deps, SARAH, 'es');
    await takeBackLanguageQuestion(w.deps, SARAH);
    w.world.clock = tookBackAt + later;

    expect((await refusal(askForLanguage(w.deps, SARAH, 'es'))).message).toBe(sentence);
  });

  it('names the parts of the day as they are at the house, not where the server is', async () => {
    // Half past eleven in UTC is half past twelve in London, in September.
    const beforeNoonUtc = Date.UTC(2026, 8, 21, 11, 30);
    for (const [timeZone, sentence] of [
      ['Europe/London', TOOK_BACK],
      ['UTC', 'You took that question back this morning. You can ask Margaret again tomorrow morning.'],
    ] as const) {
      const w = await setup({ timeZone });
      w.world.clock = beforeNoonUtc;
      await askForLanguage(w.deps, SARAH, 'es');
      await takeBackLanguageQuestion(w.deps, SARAH);
      w.world.clock = beforeNoonUtc + 60_000;

      expect((await refusal(askForLanguage(w.deps, SARAH, 'es'))).message).toBe(sentence);
    }
  });

  it('holds against a request that read the household a moment before the question was taken back', async () => {
    const w = await setup();
    // Read with nothing open and nothing taken back — and before the write, a question from another tab is asked and taken back.
    w.beforeNext(() =>
      w.beforeNext(() =>
        w.writeMeta((row) => {
          row.languageTakenBack = { S: 'es' };
          row.languageTakenBackAt = { N: String(NOW) };
        }),
      ),
    );

    const refused = await refusal(askForLanguage(w.deps, SARAH, 'es'));

    expect(refused.code).toBe('changed');
    expect(w.cards).toEqual([]);
    expect(w.meta().languageAsked).toBeUndefined();
  });

  it('is not a no: nothing of hers is written, and her own no still stands as she left it', async () => {
    const w = await takenBack();

    expect(w.meta().languageDeclined).toBeUndefined();
    expect(w.meta().languageDeclinedAt).toBeUndefined();

    w.world.clock = NOW + DAY;
    await askForLanguage(w.deps, SARAH, 'es');
    w.residentPresses('no');
    // A no, and then a day's wait served out, is still a no for the rest of the week.
    w.world.clock = NOW + 3 * DAY;
    expect((await refusal(askForLanguage(w.deps, SARAH, 'es'))).code).toBe('declined_lately');
  });

  it('records nothing when a question left over for the language she speaks is cleared away — so it cannot overwrite a taking back that stands', async () => {
    const w = await setup();
    w.writeMeta((row) => {
      row.language = { S: 'es' };
      row.languageAsked = { S: 'es' };
      row.languageAskedAt = { N: String(NOW - 5) };
      row.languageTakenBack = { S: 'en' };
      row.languageTakenBackAt = { N: String(NOW - 1000) };
    });

    await takeBackLanguageQuestion(w.deps, SARAH);

    expect(w.meta().languageAsked).toBeUndefined();
    expect(w.meta()).toMatchObject({ languageTakenBack: { S: 'en' }, languageTakenBackAt: { N: String(NOW - 1000) } });
    expect((await refusal(askForLanguage(w.deps, SARAH, 'en'))).code).toBe('taken_back_lately');
  });

  it('bounds an organiser she has not allowed yet by the same two waits', async () => {
    const w = await setup({ sarah: { status: 'pending' } });
    await askForLanguage(w.deps, SARAH, 'es');
    await takeBackLanguageQuestion(w.deps, SARAH);
    expect((await refusal(askForLanguage(w.deps, SARAH, 'es'))).code).toBe('taken_back_lately');

    w.world.clock = NOW + DAY;
    await askForLanguage(w.deps, SARAH, 'es');
    w.residentPresses('no');
    w.world.clock = NOW + 2 * DAY;
    expect((await refusal(askForLanguage(w.deps, SARAH, 'es'))).code).toBe('declined_lately');
    expect(w.cards.map((card) => card.id)).toEqual(['language-es', 'language-es']);
  });

  it('is told to the organiser while it stands, in what a taking back answers and in every reading after', async () => {
    const w = await setup();
    await askForLanguage(w.deps, SARAH, 'es');

    const answer = await takeBackLanguageQuestion(w.deps, SARAH);

    const standing = { language: 'es', at: NOW, askAgainAt: NOW + DAY, say: TOOK_BACK };
    expect(answer).toEqual({
      view: { language: 'en', choices: languageView(HOME).choices, takenBack: standing },
      say: 'I have taken the question back. Margaret’s television still speaks English.',
    });
    expect(await readLanguage(w.deps, SARAH)).toEqual({ language: 'en', choices: languageView(HOME).choices, takenBack: standing });

    w.world.clock = NOW + DAY;
    expect(await readLanguage(w.deps, SARAH)).toEqual({ language: 'en', choices: languageView(HOME).choices });
  });

  it('is not told to a family member who is not the organiser', async () => {
    const w = await takenBack();

    expect(await readLanguage(w.deps, TOM)).toEqual({ language: 'en', choices: languageView(HOME).choices });
  });
});

describe('her no is an answer, and it stands for a week', () => {
  const WEEK = LANGUAGE_ASK_AGAIN_AFTER_MS;
  // NOW is Monday 21 September 2026, 15:13 where the house is (Europe/London).
  const SAID_NO = 'Margaret said no to Spanish on Monday. You can ask again from Monday 28 September.';

  async function declined(options: Parameters<typeof setup>[0] = {}) {
    const w = await setup(options);
    await askForLanguage(w.deps, SARAH, 'es');
    w.residentPresses('no');
    w.sent.length = 0;
    w.cards.length = 0;
    return w;
  }

  it('refuses the language she said no to, and says when it can be asked again — by day, where the house is', async () => {
    const w = await declined();
    w.world.clock = NOW + 3 * 24 * 60 * 60_000;

    const refused = await refusal(askForLanguage(w.deps, SARAH, 'es'));

    expect(refused).toMatchObject({ status: 409, code: 'declined_lately', message: SAID_NO });
    expect(w.updates()).toEqual([]);
    expect(w.cards).toEqual([]);
    expect(w.meta().languageAsked).toBeUndefined();
  });

  it('counts the week to the moment: refused until it has passed, asked as before once it has', async () => {
    const w = await declined();

    w.world.clock = NOW + WEEK - 1;
    const last = await refusal(askForLanguage(w.deps, SARAH, 'es'));
    // The day it can be asked again has come, and the hour has not: said as it is.
    expect(last.message).toBe('Margaret said no to Spanish on Monday. You can ask again later today.');
    expect(w.cards).toEqual([]);

    w.world.clock = NOW + WEEK;
    const answer = await askForLanguage(w.deps, SARAH, 'es');
    expect(answer.say).toBe('I have asked Margaret on her television. Nothing changes until she says yes.');
    expect(w.cards.map((card) => card.id)).toEqual(['language-es']);
    // The no is hers: it is still on the household's row, untouched by the asking.
    expect(w.meta().languageDeclined).toEqual({ S: 'es' });
  });

  it('names the days as they are at the house, not where the server is', async () => {
    // 23:30 on Tuesday in UTC is half past midnight on Wednesday in London, in October.
    const lateTuesday = Date.UTC(2026, 9, 13, 23, 30);
    for (const [timeZone, sentence] of [
      ['Europe/London', 'Margaret said no to Spanish on Wednesday. You can ask again from Wednesday 21 October.'],
      ['UTC', 'Margaret said no to Spanish on Tuesday. You can ask again from Tuesday 20 October.'],
    ] as const) {
      const w = await setup({ timeZone });
      w.world.clock = lateTuesday;
      await askForLanguage(w.deps, SARAH, 'es');
      w.residentPresses('no');
      w.world.clock = lateTuesday + 60_000;

      expect((await refusal(askForLanguage(w.deps, SARAH, 'es'))).message).toBe(sentence);
    }
  });

  it('leaves a different language to be asked for at any time', async () => {
    // With two languages this is only ever a no to the language her television has since come to speak some other way.
    const w = await setup();
    w.writeMeta((row) => {
      row.languageDeclined = { S: 'en' };
      row.languageDeclinedAt = { N: String(NOW - 1000) };
    });

    await askForLanguage(w.deps, SARAH, 'es');

    expect(w.cards.map((card) => card.id)).toEqual(['language-es']);
  });

  it('holds against a request that read the household a moment before she said no', async () => {
    const w = await setup();
    // Read with nothing open and no no — and before the write, a question from elsewhere is asked and answered no.
    w.beforeNext(() =>
      w.beforeNext(() =>
        w.writeMeta((row) => {
          row.languageDeclined = { S: 'es' };
          row.languageDeclinedAt = { N: String(NOW) };
        }),
      ),
    );

    const refused = await refusal(askForLanguage(w.deps, SARAH, 'es'));

    expect(refused.code).toBe('changed');
    expect(w.cards).toEqual([]);
    expect(w.meta().languageAsked).toBeUndefined();
  });

  it('is forgotten by her yes: after it, the other language can be asked for at once', async () => {
    const w = await declined();
    w.world.clock = NOW + WEEK;
    await askForLanguage(w.deps, SARAH, 'es');
    w.residentPresses('yes');

    await askForLanguage(w.deps, SARAH, 'en');

    expect(w.cards.map((card) => card.id)).toEqual(['language-es', 'language-en']);
  });

  it('is told to the organiser who asked, while it stands — with the day it can be asked again, and the sentence', async () => {
    const w = await declined();
    w.world.clock = NOW + 60_000;

    expect(await readLanguage(w.deps, SARAH)).toEqual({
      language: 'en',
      choices: languageView(HOME).choices,
      declined: { language: 'es', at: NOW, askAgainAt: NOW + WEEK, say: SAID_NO },
    });

    w.world.clock = NOW + WEEK;
    expect(await readLanguage(w.deps, SARAH)).toEqual({ language: 'en', choices: languageView(HOME).choices });
  });

  it('is not told to a family member who is not the organiser: they see the language, as before', async () => {
    const w = await declined();

    expect(await readLanguage(w.deps, TOM)).toEqual({ language: 'en', choices: languageView(HOME).choices });
  });

  it('is in what a taking back answers, so the card can go on saying it', async () => {
    const w = await declined();

    const answer = await takeBackLanguageQuestion(w.deps, SARAH);

    expect(answer.view.declined).toEqual({ language: 'es', at: NOW, askAgainAt: NOW + WEEK, say: SAID_NO });
    // And nothing here took her no away.
    expect(w.updates()).toEqual([]);
    expect(w.meta().languageDeclined).toEqual({ S: 'es' });
  });
});

describe('takeBackLanguageQuestion — the organiser thinks better of it', () => {
  it('takes the card off her television and closes the question, and says what stands', async () => {
    const w = await setup();
    await askForLanguage(w.deps, SARAH, 'es');
    w.sent.length = 0;
    w.events.length = 0;

    const answer = await takeBackLanguageQuestion(w.deps, SARAH);

    expect(w.withdrawn).toEqual([{ householdId: HH, cardId: 'language-es' }]);
    expect(w.updates()).toHaveLength(1);
    expect(w.meta().languageAsked).toBeUndefined();
    expect(answer.say).toBe('I have taken the question back. Margaret’s television still speaks English.');
    expect(answer.view).toMatchObject({ language: 'en', choices: languageView(HOME).choices });
    expect(answer.view).not.toHaveProperty('asked');
    // The card left her television before the question was closed.
    expect(w.events.filter((event) => event !== 'GetItemCommand')).toEqual(['withdraw language-es', 'UpdateItemCommand']);
  });

  it('does nothing the second time, or when nothing was asked', async () => {
    const w = await setup();
    await askForLanguage(w.deps, SARAH, 'es');
    await takeBackLanguageQuestion(w.deps, SARAH);
    w.sent.length = 0;
    w.withdrawn.length = 0;

    const again = await takeBackLanguageQuestion(w.deps, SARAH);

    expect(w.updates()).toEqual([]);
    expect(w.withdrawn).toEqual([]);
    expect(again.say).toBe('There is no question on Margaret’s television to take back.');
    expect(again.view).toMatchObject({ language: 'en' });

    // And with nothing ever asked, nothing is recorded as taken back.
    const fresh = await setup();
    expect(await takeBackLanguageQuestion(fresh.deps, SARAH)).toEqual({ view: languageView(HOME), say: 'There is no question on Margaret’s television to take back.' });
    expect(fresh.sent.filter((command) => command.constructor.name !== 'GetItemCommand')).toEqual([]);
  });

  it('tells the truth when she answered a moment before: her yes stands', async () => {
    const w = await setup();
    await askForLanguage(w.deps, SARAH, 'es');
    // Read as still open — and she presses yes before the question is cleared.
    w.beforeNext(() => w.beforeNext(() => w.residentPresses('yes')));

    const answer = await takeBackLanguageQuestion(w.deps, SARAH);

    expect(w.meta().language).toEqual({ S: 'es' });
    expect(answer).toEqual({
      view: { language: 'es', choices: languageView(HOME).choices },
      say: 'Margaret had already answered. Her television speaks Spanish.',
    });
    // Her answer was the end of that question, not the organiser's taking back: none is recorded.
    expect(w.meta().languageTakenBack).toBeUndefined();
  });

  it('tells the truth when she said no a moment before: her no stands, and is not turned into a taking back', async () => {
    const w = await setup();
    await askForLanguage(w.deps, SARAH, 'es');
    w.beforeNext(() => w.beforeNext(() => w.residentPresses('no')));

    const answer = await takeBackLanguageQuestion(w.deps, SARAH);

    expect(answer.say).toBe('Margaret had already answered. Her television speaks English.');
    expect(answer.view.declined).toMatchObject({ language: 'es', at: NOW });
    expect(w.meta()).toMatchObject({ languageDeclined: { S: 'es' } });
    expect(w.meta().languageTakenBack).toBeUndefined();
  });

  it('after a no, there is nothing to take back and her television speaks what it spoke', async () => {
    const w = await setup();
    await askForLanguage(w.deps, SARAH, 'es');
    w.residentPresses('no');

    const { view } = await takeBackLanguageQuestion(w.deps, SARAH);
    expect(view).toMatchObject({ language: 'en', choices: languageView(HOME).choices });
    expect(view).not.toHaveProperty('asked');
    expect(w.withdrawn).toEqual([]);
  });
});

describe('readLanguage — who is told which language her television speaks', () => {
  it('tells the organiser and a family member she allows, and reads the household as it is now', async () => {
    const w = await setup();
    await askForLanguage(w.deps, SARAH, 'es');

    for (const who of [SARAH, TOM]) {
      expect(await readLanguage(w.deps, who)).toEqual({ language: 'en', asked: { language: 'es', by: 'Sarah', at: NOW }, choices: languageView(HOME).choices });
    }

    w.residentPresses('yes');
    expect(await readLanguage(w.deps, TOM)).toEqual({ language: 'es', choices: languageView(HOME).choices });
  });

  it('tells an organiser still waiting for her: they have to see whether the question took', async () => {
    const w = await setup({ sarah: { status: 'pending' } });

    expect((await readLanguage(w.deps, SARAH)).language).toBe('en');
  });

  it.each([
    ['pending', 'Margaret hasn’t allowed this yet. A card is waiting on the television, and it only takes one press.'],
    ['declined', 'Margaret chose not to share this with you.'],
    ['removed', 'You are no longer part of this family circle.'],
  ] as const)('INV-9: tells a family member who is %s nothing', async (status, message) => {
    const w = await setup();
    await w.store.putMembership(member({ userId: 'u_tom', name: 'Tom', role: 'family', status }));
    w.writeMeta((row) => void (row.language = { S: 'es' }));

    const refused = await refusal(readLanguage(w.deps, TOM));

    expect(refused).toMatchObject({ status: 403, code: 'not_allowed_yet', message });
    expect(`${refused.message} ${JSON.stringify(refused)}`).not.toMatch(/Spanish|español|\bes\b/);
  });

  it('tells a neighbour nothing, allowed or not: a neighbour is asked two things and shown nothing', async () => {
    const w = await setup();
    for (const status of ['allowed', 'pending'] as const) {
      await w.store.putMembership(member({ userId: 'u_june', name: 'June', role: 'neighbour', status }));

      const refused = await refusal(readLanguage(w.deps, { householdId: HH, userId: 'u_june' }));

      expect(refused).toMatchObject({ status: 403, code: 'not_for_a_neighbour', message: 'The language of the television is not shown to a neighbour.' });
    }
  });

  it('tells somebody who is in no circle here nothing', async () => {
    const w = await setup();

    expect(await refusal(readLanguage(w.deps, { householdId: HH, userId: 'u_stranger' }))).toMatchObject({ status: 403, message: 'You are not part of this family circle.' });
  });
});

/**
 * The reasoning of INV-9's "never write `status: 'allowed'` from the family
 * side": the language is hers to choose, and the only thing that sets it is
 * her press on her own television, at the edge. This server reads it, and
 * names it in a condition, and that is all.
 */
describe('nothing in this server writes the language itself', () => {
  const LANGUAGE = HOUSEHOLD_LANGUAGE_ATTRS.language;

  /** The attributes an UpdateExpression sets or removes, by their real names. */
  function written(command: Sent): string[] {
    const names = command.input.ExpressionAttributeNames ?? {};
    const expression = command.input.UpdateExpression ?? '';
    const targets: string[] = [];
    for (const clause of expression.split(/\b(?=SET |REMOVE |ADD |DELETE )/)) {
      const body = clause.replace(/^(SET|REMOVE|ADD|DELETE) /, '');
      for (const part of body.split(',')) {
        const target = /^\s*(#?\w+)/.exec(part)?.[1];
        if (target) targets.push(names[target] ?? target);
      }
    }
    return targets;
  }

  it('through every way of asking, replacing and taking back, only the question and the organiser’s own taking back are ever written', async () => {
    const w = await setup();
    const DAY = LANGUAGE_ASK_AFTER_TAKING_BACK_MS;
    const later = (ms: number) => void (w.world.clock += ms);

    await askForLanguage(w.deps, SARAH, 'es');
    await askForLanguage(w.deps, SARAH, 'es');
    await takeBackLanguageQuestion(w.deps, SARAH);
    await askForLanguage(w.deps, SARAH, 'es').catch(() => undefined);
    later(DAY);
    await askForLanguage(w.deps, SARAH, 'es');
    w.residentPresses('no');
    const saidNoAt = w.world.clock;
    await askForLanguage(w.deps, SARAH, 'es').catch(() => undefined);
    await takeBackLanguageQuestion(w.deps, SARAH);
    // Her no, exactly as her press left it: nothing above wrote it, moved it or took it away.
    expect(w.meta()).toMatchObject({ languageDeclined: { S: 'es' }, languageDeclinedAt: { N: String(saidNoAt) } });
    later(LANGUAGE_ASK_AGAIN_AFTER_MS);
    await askForLanguage(w.deps, SARAH, 'es');
    w.residentPresses('yes');
    await askForLanguage(w.deps, SARAH, 'en');
    await askForLanguage(w.deps, SARAH, 'es').catch(() => undefined);
    await takeBackLanguageQuestion(w.deps, SARAH);
    later(DAY);
    w.writeMeta((row) => {
      row.languageAsked = { S: 'es' };
      row.languageAskedAt = { N: '1' };
    });
    await askForLanguage(w.deps, SARAH, 'en');
    await takeBackLanguageQuestion(w.deps, SARAH);
    later(DAY);
    w.world.sendFails = true;
    await askForLanguage(w.deps, SARAH, 'en').catch(() => undefined);

    expect(w.updates().length).toBeGreaterThanOrEqual(9);
    const everWritten = new Set<string>();
    for (const command of w.sent) {
      // Never a whole row put over the household's, which would write — or wipe — the language with it.
      expect(command.constructor.name).not.toBe('PutItemCommand');
      expect(command.constructor.name).not.toBe('TransactWriteItemsCommand');
      if (command.constructor.name !== 'UpdateItemCommand') continue;
      for (const attribute of written(command)) everWritten.add(attribute);
    }
    // The question, and what the organiser did with it. Never the language, and never her no.
    expect([...everWritten].sort()).toEqual(['languageAsked', 'languageAskedAt', 'languageAskedBy', 'languageTakenBack', 'languageTakenBackAt']);
    expect(everWritten.has(LANGUAGE)).toBe(false);
    expect(everWritten.has(HOUSEHOLD_LANGUAGE_ATTRS.declined)).toBe(false);
    expect(everWritten.has(HOUSEHOLD_LANGUAGE_ATTRS.declinedAt)).toBe(false);
    // What she chose is what she chose.
    expect(w.meta().language).toEqual({ S: 'es' });
  });

  it('no source file of this server names the language in anything it sets, removes or puts', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const sources = (readdirSync(root, { recursive: true }) as string[])
      .filter((file) => file.endsWith('.ts') && !file.split(/[\\/]/).includes('__tests__'))
      .map((file) => ({ file, text: readFileSync(join(root, file), 'utf8') }));
    expect(sources.length).toBeGreaterThan(40);

    // The attribute is named in exactly one place: where the household's row is read and the question's condition is written.
    const naming = sources.filter(({ text }) => /HOUSEHOLD_LANGUAGE_ATTRS/.test(text)).map(({ file }) => file.replace(/\\/g, '/'));
    expect(naming).toEqual(['accounts/store.ts']);

    for (const { file, text } of sources) {
      // Every update expression in the source, as written: none sets or removes `language` or its placeholder.
      for (const match of text.matchAll(/UpdateExpression:\s*([^\n]*(?:\n\s+[`'"][^\n]*)*)/g)) {
        expect(match[1], file).not.toMatch(/#language\b|\blanguage\b(?!Asked)|LANGUAGE\.language/);
        // Nor her no, which is hers in the same way.
        expect(match[1], file).not.toMatch(/declined/i);
      }
      // And no item is built with either as a key.
      expect(text, file).not.toMatch(/\[LANGUAGE\.(language|declined|declinedAt)\]\s*:|(?<![\w.])(language|languageDeclined|languageDeclinedAt):\s*\{\s*[SN]:/);
    }
  });
});
