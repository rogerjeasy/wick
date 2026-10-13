import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LANGUAGE as CONTRACT_DEFAULT,
  HOUSEHOLD_LANGUAGE_ATTRS as CONTRACT_ATTRS,
  LANGUAGES as CONTRACT_LANGUAGES,
  LANGUAGE_ACTIONS as CONTRACT_ACTIONS,
  languageCardId,
  languageOfCardId as contractLanguageOfCardId,
  readHomeState,
} from '@wick/contracts';
import {
  DEFAULT_LANGUAGE,
  HOUSEHOLD_LANGUAGE_ATTRS,
  LANGUAGES,
  LANGUAGE_ACTIONS,
  freeOfRow,
  inHerLanguage,
  languageAnswerUpdate,
  languageOfCardId,
  languageOfMeta,
  languageOfRows,
  languagePress,
  translationAttribute,
  // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
} from '../language.mjs';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { replayedCard } from '../card-acted.mjs';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { buildHomeChangedEntry, homeState } from '../light.mjs';
// The agent plane's name for the same attribute: what one writes, the other reads.
import { translationAttribute as egressTranslationAttribute } from '../../../agent/src/egress.js';

const meta = (attrs: Record<string, unknown> = {}) => ({ pk: { S: 'HH#hh-1' }, sk: { S: 'META' }, ...attrs });

describe('held to the contract', () => {
  it('knows the same languages, the same default, the same attributes and the same two buttons', () => {
    expect(LANGUAGES).toEqual(CONTRACT_LANGUAGES);
    expect(DEFAULT_LANGUAGE).toBe(CONTRACT_DEFAULT);
    expect(HOUSEHOLD_LANGUAGE_ATTRS).toEqual(CONTRACT_ATTRS);
    expect(LANGUAGE_ACTIONS).toEqual(CONTRACT_ACTIONS);
  });

  it('reads the language from the question’s card id exactly as the contract does', () => {
    for (const id of [...CONTRACT_LANGUAGES.map(languageCardId), 'language-fr', 'language-', 'language-es-2', 'circle-es', 'note-1', '', 7, undefined, null]) {
      expect(languageOfCardId(id)).toBe(contractLanguageOfCardId(id));
    }
  });

  it('looks for a stored card’s translation where the agent plane put it', () => {
    for (const language of CONTRACT_LANGUAGES.filter((l) => l !== CONTRACT_DEFAULT)) {
      expect(translationAttribute(language)).toBe(egressTranslationAttribute(language));
    }
    expect(translationAttribute('es')).toBe('tr_es');
  });
});

describe('languageOfMeta — the household’s language, from its own row', () => {
  it('is the language the row names', () => {
    expect(languageOfMeta(meta({ language: { S: 'es' } }))).toBe('es');
  });

  it('is English when the row says nothing, or something that is not a language, or is not there', () => {
    for (const item of [meta(), meta({ language: { S: 'fr' } }), meta({ language: { N: '7' } }), undefined]) expect(languageOfMeta(item)).toBe('en');
  });

  it('is found among the rows the home screen is read from', () => {
    const rows = [{ pk: { S: 'HH#hh-1' }, sk: { S: 'LIGHT' } }, { pk: { S: 'HH#hh-1' }, sk: { S: 'MEM#u1' }, language: { S: 'fr' } }, meta({ language: { S: 'es' } })];

    expect(languageOfRows(rows)).toBe('es');
    expect(languageOfRows(rows.slice(0, 2))).toBe('en');
  });
});

describe('languagePress — her answer, read from the card id alone', () => {
  it('is yes or no to the language the card asks about', () => {
    expect(languagePress('language-es', 'yes')).toEqual({ language: 'es', answer: 'yes' });
    expect(languagePress('language-es', 'no')).toEqual({ language: 'es', answer: 'no' });
    expect(languagePress('language-en', 'yes')).toEqual({ language: 'en', answer: 'yes' });
  });

  it('is nothing for any other card, any other press, or a language Wick does not speak', () => {
    expect(languagePress('language-fr', 'yes')).toBeUndefined();
    expect(languagePress('circle-u1', 'yes')).toBeUndefined();
    expect(languagePress('note-1', 'no')).toBeUndefined();
    expect(languagePress('language-es', 'allow')).toBeUndefined();
    expect(languagePress('language-es', 'toString')).toBeUndefined();
    expect(languagePress('language-es', undefined)).toBeUndefined();
  });
});

/** A META row after the update has run, so the tests say what the row comes to and not only what was asked. */
function apply(row: Record<string, { S?: string; N?: string }>, update: { UpdateExpression: string; ConditionExpression: string; ExpressionAttributeNames: Record<string, string>; ExpressionAttributeValues: Record<string, { S?: string; N?: string }> }) {
  const names = update.ExpressionAttributeNames;
  const values = update.ExpressionAttributeValues;
  const condition = /^(#\w+) = (:\w+)$/.exec(update.ConditionExpression);
  if (!condition) throw new Error(`unreadable condition: ${update.ConditionExpression}`);
  if (row[names[condition[1]!]!]?.S !== values[condition[2]!]!.S) return { row, applied: false };

  const next = { ...row };
  const [, set = '', remove = ''] = /^(?:SET (.*?))?(?: ?REMOVE (.*))?$/.exec(update.UpdateExpression) ?? [];
  for (const assignment of set.split(',').map((part) => part.trim()).filter(Boolean)) {
    const [name, value] = assignment.split('=').map((part) => part.trim()) as [string, string];
    next[names[name]!] = values[value]!;
  }
  for (const name of remove.split(',').map((part) => part.trim()).filter(Boolean)) delete next[names[name]!];
  return { row: next, applied: true };
}

describe('languageAnswerUpdate — only a question still open can be answered', () => {
  const asked = (language: string, extra: Record<string, { S?: string; N?: string }> = {}) => ({
    policy: { S: '{}' },
    languageAsked: { S: language },
    languageAskedBy: { S: 'Sarah' },
    languageAskedAt: { N: '100' },
    ...extra,
  });
  const update = (language: string, answer: string) => languageAnswerUpdate({ table: 'wick', householdId: 'hh-1', language, answer, at: 5_000 });
  /** Her no to this language, on record from an earlier question. */
  const declinedBefore = (language: string) => ({ languageDeclined: { S: language }, languageDeclinedAt: { N: '50' } });

  it('is an update of the household’s own row — the edge may not delete', () => {
    expect(update('es', 'yes')).toMatchObject({ TableName: 'wick', Key: { pk: { S: 'HH#hh-1' }, sk: { S: 'META' } } });
  });

  it('yes sets the language and closes the question', () => {
    const { row, applied } = apply(asked('es'), update('es', 'yes'));

    expect(applied).toBe(true);
    expect(row).toEqual({ policy: { S: '{}' }, language: { S: 'es' } });
  });

  it('yes to English takes the language away — English is the absence of one — and closes the question', () => {
    const { row, applied } = apply(asked('en', { language: { S: 'es' } }), update('en', 'yes'));

    expect(applied).toBe(true);
    expect(row).toEqual({ policy: { S: '{}' } });
    expect(update('en', 'yes').UpdateExpression).not.toMatch(/SET/);
  });

  it('yes takes an earlier no off the record: what she said before no longer stands in the way of anything', () => {
    expect(apply(asked('es', declinedBefore('es')), update('es', 'yes'))).toEqual({ applied: true, row: { policy: { S: '{}' }, language: { S: 'es' } } });
    expect(apply(asked('en', { language: { S: 'es' }, ...declinedBefore('en') }), update('en', 'yes'))).toEqual({ applied: true, row: { policy: { S: '{}' } } });
  });

  it('no leaves the language as it was, closes the question, and is kept as her answer — which language she said no to, and when — in the same write', () => {
    expect(apply(asked('es'), update('es', 'no'))).toEqual({
      applied: true,
      row: { policy: { S: '{}' }, languageDeclined: { S: 'es' }, languageDeclinedAt: { N: '5000' } },
    });
    expect(apply(asked('en', { language: { S: 'es' } }), update('en', 'no'))).toEqual({
      applied: true,
      row: { policy: { S: '{}' }, language: { S: 'es' }, languageDeclined: { S: 'en' }, languageDeclinedAt: { N: '5000' } },
    });
    // One conditional update: the answer is never on record without the question having been hers to answer.
    expect(update('es', 'no').UpdateExpression).toBe('SET #declined = :language, #declinedAt = :at REMOVE #asked, #askedBy, #askedAt');
  });

  it('a later no replaces an earlier one', () => {
    expect(apply(asked('en', { language: { S: 'es' }, ...declinedBefore('es') }), update('en', 'no')).row).toEqual({
      policy: { S: '{}' },
      language: { S: 'es' },
      languageDeclined: { S: 'en' },
      languageDeclinedAt: { N: '5000' },
    });
  });

  it('changes nothing when the question is no longer open: a stale or replayed press', () => {
    const closed = { policy: { S: '{}' } };

    expect(apply(closed, update('es', 'yes'))).toEqual({ applied: false, row: closed });
    expect(apply(closed, update('es', 'no'))).toEqual({ applied: false, row: closed });
    expect(apply({ ...closed, language: { S: 'es' } }, update('en', 'yes'))).toEqual({ applied: false, row: { ...closed, language: { S: 'es' } } });
    // Not even her no is written, or taken away, by a press on a question that is closed.
    const said = { ...closed, ...declinedBefore('es') };
    expect(apply(said, update('es', 'no'))).toEqual({ applied: false, row: said });
    expect(apply(said, update('es', 'yes'))).toEqual({ applied: false, row: said });
  });

  it('names nothing in an update that the update does not use — DynamoDB refuses one that does', () => {
    for (const [language, answer] of [['es', 'yes'], ['en', 'yes'], ['es', 'no'], ['en', 'no']] as const) {
      const made = update(language, answer);
      const used = `${made.UpdateExpression} ${made.ConditionExpression}`;
      for (const name of Object.keys(made.ExpressionAttributeNames)) expect(used, `${language}/${answer} ${name}`).toMatch(new RegExp(`${name}\\b`));
      for (const value of Object.keys(made.ExpressionAttributeValues)) expect(used, `${language}/${answer} ${value}`).toMatch(new RegExp(`${value}\\b`));
    }
  });

  it('changes nothing when the question open is about another language: a television cannot choose one it was not asked about', () => {
    const openForEnglish = asked('en', { language: { S: 'es' } });

    expect(apply(openForEnglish, update('es', 'yes'))).toEqual({ applied: false, row: openForEnglish });
    expect(apply(openForEnglish, update('es', 'no'))).toEqual({ applied: false, row: openForEnglish });
    expect(update('es', 'yes').ConditionExpression).toBe('#asked = :language');
    expect(update('es', 'no').ConditionExpression).toBe('#asked = :language');
  });

  it('refuses anything that is not her answer, or not a language', () => {
    expect(() => update('es', 'maybe')).toThrow();
    expect(() => update('fr', 'yes')).toThrow();
  });
});

describe('homeState — the home is told the language beside the light', () => {
  const NOW = Date.UTC(2026, 9, 12, 9, 30);
  const member = { pk: { S: 'HH#hh-1' }, sk: { S: 'MEM#u1' }, name: { S: 'Sarah' }, status: { S: 'allowed' } };
  const state = (items: object[]) => homeState({ items, now: NOW, timeZone: 'Europe/London' });

  it('carries the language when it is not English', () => {
    expect(state([meta({ language: { S: 'es' } }), member])).toEqual({ light: 'on', language: 'es' });
    expect(state([meta({ language: { S: 'es' } })])).toEqual({ language: 'es' });
  });

  it('says nothing of it for English: what an English home is told is what it was always told', () => {
    expect(state([meta(), member])).toEqual({ light: 'on' });
    expect(state([meta({ language: { S: 'en' } }), member])).toEqual({ light: 'on' });
    expect(state([meta({ language: { S: 'fr' } })])).toEqual({});
  });

  it('reaches every television through the bus: the contract keeps it on the way to the agent plane', () => {
    const home = state([meta({ language: { S: 'es' } }), member]);
    const entry = buildHomeChangedEntry({ busName: 'wick', householdId: 'hh-1', deviceId: 'tv-1', home, at: NOW });

    expect(readHomeState(JSON.parse(entry.Detail).home)).toEqual({ light: 'on', language: 'es' });
  });
});

describe('freeOfRow — a stored card’s free text in her language, kept beside it by the agent plane', () => {
  it('is what the row holds for that language', () => {
    expect(freeOfRow({ tr_es: { S: '{"transcript":"Llámame esta noche."}' } }, 'es')).toEqual({ transcript: 'Llámame esta noche.' });
  });

  it('is nothing when there is none, when it cannot be read, or when it is not text by field', () => {
    for (const row of [undefined, {}, { tr_es: { S: 'not json' } }, { tr_es: { S: '"a string"' } }, { tr_es: { S: 'null' } }, { tr_es: { N: '7' } }]) {
      expect(freeOfRow(row, 'es')).toBeUndefined();
    }
    expect(freeOfRow({ tr_es: { S: '{"transcript":7,"description":"","text":"Hola."}' } }, 'es')).toEqual({ text: 'Hola.' });
  });
});

describe('inHerLanguage — every card and every home message the edge sends, put into her language once', () => {
  /** A phrasebook of this file's own: Wick's sentences are marked, free text is replaced only by what is handed in. */
  const phrasebook = {
    cardIn: vi.fn((language: string, card: Record<string, unknown>, free: Record<string, string> = {}) => ({
      ...card,
      ...(typeof card.headline === 'string' ? { headline: `[${language}] ${card.headline}` } : {}),
      ...free,
    })),
    patchIn: vi.fn((language: string, patch: Record<string, unknown>) => ({ ...patch, ...(typeof patch.notice === 'string' ? { notice: `[${language}] ${patch.notice}` } : {}) })),
    homeIn: vi.fn((language: string, home: { lookedIn?: { line: string } }) => ({ ...home, ...(home.lookedIn ? { lookedIn: { ...home.lookedIn, line: `[${language}] ${home.lookedIn.line}` } } : {}) })),
  };

  function television(language: string | Error = 'es') {
    const cards: unknown[] = [];
    const controls: unknown[] = [];
    const readLanguage = vi.fn(async () => {
      if (language instanceof Error) throw language;
      return language;
    });
    const voice = inHerLanguage({
      sendCard: async (card: unknown) => { cards.push(card); return true; },
      sendControl: async (control: unknown) => { controls.push(control); return true; },
      readLanguage,
      phrasebook,
      log: () => {},
    });
    return { ...voice, cards, controls, readLanguage };
  }

  const note = { type: 'MESSAGE', id: 'note-1', householdId: 'hh-1', correlationId: 'c', createdAt: 1, fromName: 'Sarah', transcript: 'Ring me tonight, Mum.', suggestedReplies: ['I will'], actions: [] };
  const queuedNote = { id: 'note-1', urgency: 'DEFERRED', card: note, queuedAt: 2, shownCount: 0 };
  const light = { id: 'light', urgency: 'DEFERRED', queuedAt: 3, shownCount: 0, card: { type: 'LIGHT', id: 'light', householdId: 'hh-1', correlationId: 'light', createdAt: 3, headline: 'Your light is on.', detail: 'x', actions: [] } };

  it('sends an English household the very card it was handed', async () => {
    const tv = television('en');

    expect(await tv.sendCard(queuedNote, { row: { tr_es: { S: '{"transcript":"Llámame."}' } } })).toBe(true);
    await tv.sendCard(light);

    expect(tv.cards[0]).toBe(queuedNote);
    expect(tv.cards[1]).toBe(light);
    expect(phrasebook.cardIn).not.toHaveBeenCalled();
  });

  it('reconcile: sends a stored card again through the phrasebook, with the free text the agent plane kept beside it', async () => {
    const tv = television('es');
    // The row as egress.ts wrote it, shown once since: what reconcile hands on (card-acted.mjs replayedCard).
    const row = { pk: { S: 'HH#hh-1' }, sk: { S: 'CARD#note-1' }, data: { S: JSON.stringify(queuedNote) }, shown: { N: '1' }, tr_es: { S: '{"transcript":"Llámame esta noche, mamá."}' } };

    await tv.sendCard(replayedCard(row), { row });

    expect(tv.cards).toEqual([{ ...queuedNote, shownCount: 1, card: { ...note, transcript: 'Llámame esta noche, mamá.' } }]);
    expect(phrasebook.cardIn).toHaveBeenLastCalledWith('es', note, { transcript: 'Llámame esta noche, mamá.' });
    // The stored English is what it was.
    expect(JSON.parse(row.data.S).card.transcript).toBe('Ring me tonight, Mum.');
  });

  it('sends a stored card with no translation beside it in Wick’s own sentences, its free text as it was written', async () => {
    const tv = television('es');
    const row = { data: { S: JSON.stringify(queuedNote) } };

    await tv.sendCard(replayedCard(row), { row });

    expect(phrasebook.cardIn).toHaveBeenLastCalledWith('es', note, undefined);
    expect((tv.cards[0] as typeof queuedNote).card.transcript).toBe('Ring me tonight, Mum.');
  });

  it('puts a card built on the spot through the phrasebook too, with no free text', async () => {
    const tv = television('es');

    await tv.sendCard(light);

    expect(tv.cards).toEqual([{ ...light, card: { ...light.card, headline: '[es] Your light is on.' } }]);
  });

  it('reads the language once for all the cards of one event, and not at all when nothing is sent', async () => {
    const tv = television('es');
    expect(tv.readLanguage).not.toHaveBeenCalled();

    await tv.sendCard(queuedNote);
    await tv.sendCard(light);
    await tv.sendCard(light);

    expect(tv.readLanguage).toHaveBeenCalledTimes(1);
  });

  it('takes the language from the home’s rows when the caller has just read them, and makes no read of its own', async () => {
    const tv = television(new Error('must not be read'));

    await tv.sendCard(light, { rows: [meta({ language: { S: 'es' } })] });
    await tv.sendCard(light);

    expect(tv.readLanguage).not.toHaveBeenCalled();
    expect(tv.cards).toHaveLength(2);
    expect((tv.cards[1] as typeof light).card.headline).toBe('[es] Your light is on.');
  });

  it('says what the underlying send said: false once the television has gone', async () => {
    const voice = inHerLanguage({ sendCard: async () => false, sendControl: async () => false, readLanguage: async () => 'es', phrasebook, log: () => {} });

    expect(await voice.sendCard(light)).toBe(false);
    expect(await voice.sendControl({ t: 'revoke', cardId: 'note-1' })).toBe(false);
  });

  it('sends the English card when the language cannot be read, or the phrasebook fails — never nothing', async () => {
    const unread = television(new Error('table down'));
    await unread.sendCard(light);
    expect(unread.cards).toEqual([light]);

    const failing = inHerLanguage({
      sendCard: async (card: unknown) => { unread.cards.push(card); return true; },
      sendControl: async () => true,
      readLanguage: async () => 'es',
      phrasebook: { ...phrasebook, cardIn: () => { throw new Error('no such sentence'); } },
      log: () => {},
    });
    await failing.sendCard(light);
    expect(unread.cards[1]).toBe(light);
  });

  it('tells the home in the language the home itself names — read a moment ago from the household’s row — without another read', async () => {
    const tv = television(new Error('must not be read'));
    const home = { light: 'on', lookedIn: { name: 'Sarah', at: 5, line: 'Sarah looked in this morning.' }, language: 'es' };

    await tv.sendControl({ t: 'home', home, whole: true });

    expect(tv.controls).toEqual([{ t: 'home', home: { ...home, lookedIn: { ...home.lookedIn, line: '[es] Sarah looked in this morning.' } }, whole: true }]);
    expect(tv.readLanguage).not.toHaveBeenCalled();
  });

  it('tells an English home exactly what it was handed', async () => {
    const tv = television(new Error('must not be read'));
    const control = { t: 'home', home: { light: 'on', lookedIn: { name: 'Sarah', at: 5, line: 'Sarah looked in this morning.' } }, whole: true };

    await tv.sendControl(control);

    expect(tv.controls[0]).toBe(control);
    expect(phrasebook.homeIn).not.toHaveBeenCalledWith('en', expect.anything());
  });

  it('goes by what a whole home says from then on: after her yes, the cards that follow are in the new language', async () => {
    const tv = television('en');
    await tv.sendCard(light);
    expect((tv.cards[0] as typeof light).card.headline).toBe('Your light is on.');

    await tv.sendControl({ t: 'home', home: { language: 'es' }, whole: true });
    await tv.sendCard(light);
    expect((tv.cards[1] as typeof light).card.headline).toBe('[es] Your light is on.');

    await tv.sendControl({ t: 'home', home: {}, whole: true });
    await tv.sendCard(light);
    expect(tv.cards[2]).toBe(light);
  });

  describe('a picture’s card gets its address here, on the way out, and nowhere else', () => {
    const photo = { type: 'PHOTO', id: 'photo-p1', householdId: 'hh-1', correlationId: 'c', createdAt: 1, photoId: 'p1', fromName: 'Sarah', headline: 'A picture from Sarah.', actions: [] };
    const queuedPhoto = { id: 'photo-p1', urgency: 'DEFERRED', card: photo, queuedAt: 4, shownCount: 0 };

    function withPictures(language: string, pictureAddress: (photoId: string) => string | undefined) {
      const cards: { card: Record<string, unknown> }[] = [];
      const controls: unknown[] = [];
      const voice = inHerLanguage({
        sendCard: async (card: { card: Record<string, unknown> }) => { cards.push(card); return true; },
        sendControl: async (control: unknown) => { controls.push(control); return true; },
        readLanguage: async () => language,
        phrasebook,
        pictureAddress,
        log: () => {},
      });
      return { ...voice, cards, controls };
    }

    it('mints one for an English household too, and changes nothing else of the card', async () => {
      const asked: string[] = [];
      const tv = withPictures('en', (photoId) => { asked.push(photoId); return `https://photos.example/${photoId}?sig=1`; });

      await tv.sendCard(queuedPhoto, { row: { data: { S: JSON.stringify(queuedPhoto) } } });

      expect(tv.cards).toEqual([{ ...queuedPhoto, card: { ...photo, photoUrl: 'https://photos.example/p1?sig=1' } }]);
      expect(asked).toEqual(['p1']);
      // What was handed in — the stored card — is as it was.
      expect(queuedPhoto.card).not.toHaveProperty('photoUrl');
    });

    it('mints one after the phrasebook has had the card', async () => {
      const tv = withPictures('es', () => 'https://photos.example/p1?sig=2');

      await tv.sendCard(queuedPhoto);

      expect(tv.cards[0]!.card).toEqual({ ...photo, headline: '[es] A picture from Sarah.', photoUrl: 'https://photos.example/p1?sig=2' });
    });

    it('sends the card without one when none can be minted — the words still go', async () => {
      const none = withPictures('en', () => undefined);
      await none.sendCard(queuedPhoto);
      expect(none.cards).toEqual([queuedPhoto]);

      const throwing = withPictures('en', () => { throw new Error('no credentials'); });
      await throwing.sendCard(queuedPhoto);
      expect(throwing.cards).toEqual([queuedPhoto]);
    });

    it('never passes on an address that came with the card: only one minted now is sent', async () => {
      const carrying = { ...queuedPhoto, card: { ...photo, photoUrl: 'https://stale.example/old' } };

      const fresh = withPictures('en', () => 'https://photos.example/p1?sig=3');
      await fresh.sendCard(carrying);
      expect(fresh.cards[0]!.card.photoUrl).toBe('https://photos.example/p1?sig=3');

      const none = withPictures('es', () => undefined);
      await none.sendCard(carrying);
      expect(none.cards[0]!.card).not.toHaveProperty('photoUrl');
    });

    it('mints nothing for any other kind of card, and hands an English one on untouched', async () => {
      const asked: string[] = [];
      const tv = withPictures('en', (photoId) => { asked.push(photoId); return 'https://photos.example/x'; });

      await tv.sendCard(queuedNote);
      await tv.sendCard(light);

      expect(tv.cards[0]).toBe(queuedNote);
      expect(tv.cards[1]).toBe(light);
      expect(asked).toEqual([]);
    });

    it('hands on what she has kept exactly as it was built: the mantelpiece carries names and addresses, and no words of Wick’s', async () => {
      const tv = withPictures('es', () => 'https://photos.example/x');
      const control = { t: 'mantel', items: [{ photoId: 'p1', fromName: 'Sarah', keptAt: 5, url: 'https://photos.example/p1?sig=9' }] };

      await tv.sendControl(control);

      expect(tv.controls[0]).toBe(control);
    });
  });

  it('leaves a revoke as it is — it carries no words — and reads nothing for it', async () => {
    const tv = television('es');
    const revoke = { t: 'revoke', cardId: 'note-1' };

    await tv.sendControl(revoke);

    expect(tv.controls[0]).toBe(revoke);
    expect(tv.readLanguage).not.toHaveBeenCalled();
  });

  it('puts a patch through the phrasebook', async () => {
    const tv = television('es');

    await tv.sendControl({ t: 'patch', patch: { cardId: 'door-1', notice: 'The hallway chime rang.' } });

    expect(tv.controls).toEqual([{ t: 'patch', patch: { cardId: 'door-1', notice: '[es] The hallway chime rang.' } }]);
  });
});

describe('the edge never asks a translator', () => {
  it('has no file that names Amazon Translate: what it sends in her language is the phrasebook and what the agent plane kept', () => {
    const lambda = fileURLToPath(new URL('..', import.meta.url));
    const sources = readdirSync(lambda).filter((name) => name.endsWith('.mjs'));
    expect(sources).toContain('language.mjs');

    for (const name of sources) {
      const source = readFileSync(`${lambda}/${name}`, 'utf8');
      expect(source, name).not.toMatch(/client-translate|TranslateClient|TranslateTextCommand/);
    }
  });

  it('wraps what it is handed once, where every event comes in', () => {
    const source = readFileSync(fileURLToPath(new URL('../device-event.mjs', import.meta.url)), 'utf8');

    expect(source.match(/inHerLanguage\(/g)).toHaveLength(1);
    expect(source).toMatch(/from '\.\/phrasebook\.generated\.mjs'/);
  });
});
