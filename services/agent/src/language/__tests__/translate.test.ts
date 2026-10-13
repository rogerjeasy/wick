import { describe, expect, it, vi } from 'vitest';
import type { DoorCard, MessageCard, WeekCard } from '@wick/contracts';
import { MAX_CARD_DETAIL_CHARS } from '@wick/contracts';
import { TRANSLATE_TIMEOUT_MS, knownNames, readTranslation, translateFree, translationRequest, type TranslateCall, type TranslateInput } from '../translate.js';

type Fake = TranslateCall & ReturnType<typeof vi.fn<TranslateCall>>;

/** Amazon Translate, standing in: it answers each request with what this says of it. */
const answering = (answer: (input: TranslateInput) => string | undefined): Fake => vi.fn<TranslateCall>(async (input) => ({ TranslatedText: answer(input) }));
const isMarked = (input: TranslateInput): boolean => input.Text.includes('<span translate="no">');
const quiet = { log: () => {} };

/**
 * What Amazon Translate really answered (en → es, Formality FORMAL), run by
 * hand on 2026-10-13 and kept here word for word.
 *
 * A marked name comes back intact, but the engine takes it for a thing and
 * puts an article before it — "con el Rose", which is wrong. The same kind
 * of sentence sent plain comes back right, its names left alone. So plain
 * goes first, and the marks are only for a name the engine would not leave.
 *
 * (The plain sentence was reported with its first words elided; they are
 * filled in here from the marked result, which begins the same way.)
 */
const LIVE = {
  marked: {
    english: 'A woman in a blue coat is at the door with Rose. She is holding a parcel & a letter for Tears of Steel.',
    sent: 'A woman in a blue coat is at the door with <span translate="no">Rose</span>. She is holding a parcel &amp; a letter for <span translate="no">Tears of Steel</span>.',
    answered: 'Una mujer con un abrigo azul está en la puerta con el <span translate="no">Rose</span>. Tiene en sus manos un paquete y una carta para <span translate="no">Tears of Steel</span>.',
    read: 'Una mujer con un abrigo azul está en la puerta con el Rose. Tiene en sus manos un paquete y una carta para Tears of Steel.',
  },
  plain: {
    english: 'A woman in a blue coat is at the door with Rose. Tears of Steel is on at three.',
    answered: 'Una mujer con un abrigo azul está en la puerta con Rose. Tears of Steel sale a las tres.',
  },
} as const;
const LIVE_NAMES = ['Wick', 'Big Buck Bunny', 'Sintel', 'Tears of Steel', 'Rose'];

describe('translationRequest — exactly what Amazon Translate is asked', () => {
  it('first sends the text plain: escaped, so nothing in it can be taken for markup, from English to her language, with no name marked', () => {
    const request = translationRequest({
      text: 'Tom & Sarah say <hello> — "Big Buck Bunny" is on at 5 > 4, Sarah.',
      language: 'es',
      names: ['Sarah', 'Big Buck Bunny', 'Wick'],
      field: 'transcript',
    });

    expect(request).toEqual({
      Text: 'Tom &amp; Sarah say &lt;hello&gt; — "Big Buck Bunny" is on at 5 &gt; 4, Sarah.',
      SourceLanguageCode: 'en',
      TargetLanguageCode: 'es',
    });
  });

  it('and when asked to mark them, wraps every known name so it is not translated', () => {
    const request = translationRequest({
      text: 'Tom & Sarah say <hello> — "Big Buck Bunny" is on at 5 > 4, Sarah.',
      language: 'es',
      names: ['Sarah', 'Big Buck Bunny', 'Wick'],
      field: 'transcript',
      marked: true,
    });

    expect(request).toEqual({
      Text:
        'Tom &amp; <span translate="no">Sarah</span> say &lt;hello&gt; — "<span translate="no">Big Buck Bunny</span>" is on at 5 &gt; 4, <span translate="no">Sarah</span>.',
      SourceLanguageCode: 'en',
      TargetLanguageCode: 'es',
    });
  });

  it('marks the live sentence exactly as it was sent by hand', () => {
    expect(translationRequest({ text: LIVE.marked.english, language: 'es', names: LIVE_NAMES, field: 'description', marked: true })).toEqual({
      Text: LIVE.marked.sent,
      SourceLanguageCode: 'en',
      TargetLanguageCode: 'es',
      Settings: { Formality: 'FORMAL' },
    });
  });

  it('asks for the formal address in what Wick itself says to her — the phrasebook’s "usted" — and leaves a note in its writer’s own voice', () => {
    const wicks = { Settings: { Formality: 'FORMAL' } };
    expect(translationRequest({ text: 'A man with a parcel.', language: 'es', names: [], field: 'description' })).toMatchObject(wicks);
    expect(translationRequest({ text: 'You had a quiet week.', language: 'es', names: [], field: 'text' })).toMatchObject(wicks);
    expect(translationRequest({ text: 'Ring me, Mum.', language: 'es', names: [], field: 'transcript' }).Settings).toBeUndefined();
  });

  it('marks a whole name and never part of a word, the longer name first', () => {
    const { Text } = translationRequest({ text: 'Wickham saw Sintel; Ann and Ann Marie called Wick.', language: 'es', names: ['Wick', 'Ann', 'Ann Marie', 'Sintel'], field: 'transcript', marked: true });

    expect(Text).toBe(
      'Wickham saw <span translate="no">Sintel</span>; <span translate="no">Ann</span> and <span translate="no">Ann Marie</span> called <span translate="no">Wick</span>.',
    );
  });

  it('takes a name for what it is, whatever it contains', () => {
    const { Text } = translationRequest({ text: 'Lunch at M&S (Leeds) with A.J.', language: 'es', names: ['M&S (Leeds)', 'A.J', '', '  '], field: 'transcript', marked: true });

    expect(Text).toBe('Lunch at <span translate="no">M&amp;S (Leeds)</span> with <span translate="no">A.J</span>.');
  });
});

describe('readTranslation — what comes back, made text again', () => {
  const plain = (translated: string | undefined, sent: readonly string[] = []) => readTranslation(translated, sent, { marked: false });
  const marked = (translated: string | undefined, sent: readonly string[] = []) => readTranslation(translated, sent, { marked: true });

  it('turns the entities back into characters, whether the engine kept them or had already done it', () => {
    expect(plain('Tom &amp; Sarah dicen a las 5 &gt; 4 &#39;hoy&#39; &quot;ya&quot; &#xE9;, te &lt;3')).toEqual({ text: 'Tom & Sarah dicen a las 5 > 4 \'hoy\' "ya" é, te <3' });
    expect(plain('Tom & Sarah dicen a las 5 > 4, te <3')).toEqual({ text: 'Tom & Sarah dicen a las 5 > 4, te <3' });
  });

  it('reads the live answers: the plain one as it is, the marked one with its marks taken off', () => {
    expect(plain(LIVE.plain.answered, ['Rose', 'Tears of Steel'])).toEqual({ text: LIVE.plain.answered });
    expect(marked(LIVE.marked.answered, ['Rose', 'Tears of Steel'])).toEqual({ text: LIVE.marked.read });
  });

  it('copes with the marks however the service writes them back, and the spaces they leave', () => {
    expect(marked('  <SPAN translate = "no" >Sarah</SPAN>  llamará  esta noche. ', ['Sarah'])).toEqual({ text: 'Sarah llamará esta noche.' });
    expect(marked('Un hombre <span translate="no">alto.')).toEqual({ text: 'Un hombre alto.' });
  });

  it('is nothing when nothing came back', () => {
    for (const empty of [undefined, '', '   ']) expect(plain(empty)).toEqual({ lost: 'empty' });
    expect(marked('<span translate="no"></span>')).toEqual({ lost: 'empty' });
  });

  it('is nothing when markup that was never sent comes back — never a string with a tag in it', () => {
    expect(marked('Un hombre <b>alto</b>.')).toEqual({ lost: 'markup' });
    expect(plain('Un hombre <b>alto</b>.')).toEqual({ lost: 'markup' });
    // No mark was sent with a plain request: one that comes back is not ours, and is not taken off.
    expect(plain('Llámame, <span translate="no">Sarah</span>.', ['Sarah'])).toEqual({ lost: 'markup' });
  });

  it('is nothing when a name did not come back as it went — as a word of its own, not as part of another', () => {
    expect(plain('Sara llamará esta noche.', ['Sarah'])).toEqual({ lost: 'name' });
    expect(plain('Rosemary llamará esta noche.', ['Rose'])).toEqual({ lost: 'name' });
    expect(marked('Lágrimas de acero empieza a las tres.', ['Tears of Steel'])).toEqual({ lost: 'name' });
    expect(plain('Sarah llamará esta noche.', ['Sarah'])).toEqual({ text: 'Sarah llamará esta noche.' });
  });
});

describe('translateFree — plain first, the names marked only when one was lost', () => {
  it('takes the plain translation when every name came through: one call, and the marked form — "con el Rose" — is never asked for', async () => {
    const call = answering((input) => (isMarked(input) ? LIVE.marked.answered : LIVE.plain.answered));

    const free = await translateFree({ free: { description: LIVE.plain.english }, language: 'es', names: LIVE_NAMES, call, ...quiet });

    expect(free).toEqual({ description: 'Una mujer con un abrigo azul está en la puerta con Rose. Tears of Steel sale a las tres.' });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]![0]).toEqual({ Text: LIVE.plain.english, SourceLanguageCode: 'en', TargetLanguageCode: 'es', Settings: { Formality: 'FORMAL' } });
  });

  it('asks once more, with the names marked, only when the plain translation lost one — and takes that, names intact', async () => {
    // The film's title, translated: the one thing the plain form can get wrong.
    const call = answering((input) =>
      isMarked(input) ? LIVE.marked.answered : 'Una mujer con un abrigo azul está en la puerta con Rose. Tiene un paquete y una carta para Lágrimas de acero.',
    );

    const free = await translateFree({ free: { description: LIVE.marked.english }, language: 'es', names: LIVE_NAMES, call, ...quiet });

    expect(free).toEqual({ description: LIVE.marked.read });
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls.map(([input]) => input.Text)).toEqual([
      'A woman in a blue coat is at the door with Rose. She is holding a parcel &amp; a letter for Tears of Steel.',
      LIVE.marked.sent,
    ]);
  });

  it('gives no translation when the name is lost marked as well', async () => {
    const call = answering(() => 'Rosa está en la puerta.');

    expect(await translateFree({ free: { description: 'Rose is at the door.' }, language: 'es', names: ['Rose'], call, ...quiet })).toEqual({});
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('does not ask again for an answer that was empty: marking is for a name that was lost, and nothing else', async () => {
    const call = answering(() => '');

    expect(await translateFree({ free: { transcript: 'Ring me tonight.' }, language: 'es', names: ['Sarah', 'Wick'], call, ...quiet })).toEqual({});
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('translates every field given, and looks only for the names each text had', async () => {
    const call = answering(({ Text }) => Text.replace('Ring me tonight', 'Llámame esta noche').replace('A quiet week', 'Una semana tranquila'));

    const free = await translateFree({ free: { transcript: 'Ring me tonight, Sarah.', text: 'A quiet week.' }, language: 'es', names: ['Sarah', 'Big Buck Bunny', 'Wick'], call, ...quiet });

    expect(free).toEqual({ transcript: 'Llámame esta noche, Sarah.', text: 'Una semana tranquila.' });
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls.map(([input]) => input.TargetLanguageCode)).toEqual(['es', 'es']);
  });

  it('asks for nothing when there is nothing to translate', async () => {
    const call = answering(() => 'x');

    expect(await translateFree({ free: {}, language: 'es', names: [], call, ...quiet })).toEqual({});
    expect(await translateFree({ free: { transcript: '   ' }, language: 'es', names: [], call, ...quiet })).toEqual({});
    expect(call).not.toHaveBeenCalled();
  });

  it('gives no translation for a field whose call fails — it is not asked again — and keeps the others', async () => {
    const call = vi.fn<TranslateCall>(async (input) => {
      if (input.Text.includes('quiet')) throw Object.assign(new Error('boom'), { name: 'ServiceUnavailableException' });
      return { TranslatedText: 'Llámame.' };
    });

    expect(await translateFree({ free: { transcript: 'Ring me.', text: 'A quiet week.' }, language: 'es', names: [], call, ...quiet })).toEqual({ transcript: 'Llámame.' });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('gives no translation when the answer is empty', async () => {
    expect(await translateFree({ free: { transcript: 'Ring me.' }, language: 'es', names: [], call: answering(() => ''), ...quiet })).toEqual({});
    expect(await translateFree({ free: { transcript: 'Ring me.' }, language: 'es', names: [], call: answering(() => undefined), ...quiet })).toEqual({});
  });
});

describe('translateFree — what a family note may contain', () => {
  const note = 'Tom & I <3 you, and 5 > 4.';

  it('sends &, < and > escaped, and reads the same text back whether the engine keeps the entities or turns them back itself', async () => {
    const kept = answering(({ Text }) => Text.replace('you, and', 'a ti, y'));
    const decoded = answering(() => 'Tom & I <3 a ti, y 5 > 4.');

    expect(await translateFree({ free: { transcript: note }, language: 'es', names: [], call: kept, ...quiet })).toEqual({ transcript: 'Tom & I <3 a ti, y 5 > 4.' });
    expect(await translateFree({ free: { transcript: note }, language: 'es', names: [], call: decoded, ...quiet })).toEqual({ transcript: 'Tom & I <3 a ti, y 5 > 4.' });
    expect(kept.mock.calls[0]![0].Text).toBe('Tom &amp; I &lt;3 you, and 5 &gt; 4.');
  });

  it('never sends a tag the note’s writer typed as a tag, and takes none back from it: text that looks like markup stays text, or stays English', async () => {
    const written = 'See <b>this</b>, Sarah.';
    // The engine keeps the entities: the note's own characters come back, as characters.
    const kept = answering(({ Text }) => Text.replace('See', 'Mira').replace('this', 'esto'));
    expect(await translateFree({ free: { transcript: written }, language: 'es', names: ['Sarah'], call: kept, ...quiet })).toEqual({ transcript: 'Mira <b>esto</b>, Sarah.' });
    expect(kept.mock.calls[0]![0].Text).toBe('See &lt;b&gt;this&lt;/b&gt;, Sarah.');

    // The engine hands them back as a tag: not trusted, not stripped — no translation.
    const decoded = answering(() => 'Mira <b>esto</b>, Sarah.');
    expect(await translateFree({ free: { transcript: written }, language: 'es', names: ['Sarah'], call: decoded, ...quiet })).toEqual({});
  });

  it('cannot be made to pass for one of the marks: a note that writes the mark itself is never sent marked, so no mark that comes back is taken for ours', async () => {
    const forged = 'Ring <span translate="no">Tom</span>, not Sarah.';
    // The plain answer loses the name; a marked attempt would follow — and its marks could not be told from the note's own.
    const call = answering(() => 'Llama a &lt;span translate="no"&gt;Tom&lt;/span&gt;, no a Sara.');

    expect(await translateFree({ free: { transcript: forged }, language: 'es', names: ['Sarah'], call, ...quiet })).toEqual({});
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]![0].Text).toBe('Ring &lt;span translate="no"&gt;Tom&lt;/span&gt;, not Sarah.');
  });
});

describe('translateFree — one time limit, and never more than three calls for a field', () => {
  it('stops waiting at the time limit, tells the call to stop, and gives no translation', async () => {
    let stopped = false;
    const never: TranslateCall = (_input, signal) =>
      new Promise(() => {
        signal.addEventListener('abort', () => { stopped = true; });
      });

    const started = Date.now();
    const free = await translateFree({ free: { transcript: 'Ring me.' }, language: 'es', names: [], call: never, timeoutMs: 30, ...quiet });

    expect(free).toEqual({});
    expect(stopped).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('waits two and a half seconds at most for the whole card, however many calls that is', async () => {
    expect(TRANSLATE_TIMEOUT_MS).toBe(2500);
    vi.useFakeTimers();
    try {
      // The plain answer loses the name after a second; the marked one never comes.
      const call = vi.fn<TranslateCall>((input) =>
        isMarked(input) ? new Promise(() => {}) : new Promise((resolve) => { setTimeout(() => resolve({ TranslatedText: 'Rosa está en la puerta.' }), 1000); }),
      );
      let free: unknown;
      void translateFree({ free: { description: 'Rose is at the door.' }, language: 'es', names: ['Rose'], call, ...quiet }).then((f) => { free = f; });

      await vi.advanceTimersByTimeAsync(2499);
      expect(free).toBeUndefined();
      expect(call).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(free).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  const long = 'palabra '.repeat(40).trim(); // 319 characters

  it('never uses a translation too long for a card — it asks once more for a shorter one, and failing that gives none', async () => {
    expect(long.length).toBeGreaterThan(MAX_CARD_DETAIL_CHARS);

    const shorter = answering((input) => (input.Settings?.Brevity === 'ON' ? 'Una semana tranquila.' : long));
    expect(await translateFree({ free: { text: 'A quiet week.' }, language: 'es', names: [], call: shorter, ...quiet })).toEqual({ text: 'Una semana tranquila.' });
    expect(shorter.mock.calls.map(([input]) => input.Settings)).toEqual([{ Formality: 'FORMAL' }, { Formality: 'FORMAL', Brevity: 'ON' }]);

    const alwaysLong = answering(() => long);
    expect(await translateFree({ free: { text: 'A quiet week.' }, language: 'es', names: [], call: alwaysLong, ...quiet })).toEqual({});
    expect(alwaysLong).toHaveBeenCalledTimes(2);
  });

  it('makes three calls at the very most: plain, marked for the name it lost, and marked again for a shorter one', async () => {
    const call = answering((input) =>
      !isMarked(input) ? 'Rosa está en la puerta.'
      : input.Settings?.Brevity === 'ON' ? '<span translate="no">Rose</span> está en la puerta.'
      : `<span translate="no">Rose</span> ${long}`,
    );

    expect(await translateFree({ free: { description: 'Rose is at the door.' }, language: 'es', names: ['Rose'], call, ...quiet })).toEqual({ description: 'Rose está en la puerta.' });
    expect(call.mock.calls.map(([input]) => [isMarked(input), input.Settings?.Brevity ?? 'OFF'])).toEqual([[false, 'OFF'], [true, 'OFF'], [true, 'ON']]);
  });

  it('and stops at three whatever comes back: too long, then shorter but a name lost, then marked and still too long', async () => {
    const call = answering((input) => (isMarked(input) ? `<span translate="no">Rose</span> ${long}` : input.Settings?.Brevity === 'ON' ? 'Rosa está en la puerta.' : `Rose ${long}`));

    expect(await translateFree({ free: { description: 'Rose is at the door.' }, language: 'es', names: ['Rose'], call, ...quiet })).toEqual({});
    expect(call.mock.calls.map(([input]) => [isMarked(input), input.Settings?.Brevity ?? 'OFF'])).toEqual([[false, 'OFF'], [false, 'ON'], [true, 'ON']]);
  });
});

describe('translateFree — what is said when there is no translation', () => {
  const reasonOf = async (call: TranslateCall, free = { transcript: 'Ring me tonight, Sarah.' }) => {
    const lines: string[] = [];
    await translateFree({ free, language: 'es', names: ['Sarah'], call, log: (line) => lines.push(JSON.stringify(line)) });
    return lines;
  };

  it('says that a translation was not to be had, for which field and why — and never what the text was', async () => {
    const lines = await reasonOf(async () => { throw Object.assign(new Error('Ring me tonight is secret'), { name: 'ThrottlingException' }); });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ level: 'warn', msg: 'translation_unavailable', field: 'transcript', language: 'es', reason: 'ThrottlingException' });
    expect(lines.join('')).not.toMatch(/Ring me|Sarah|secret/);
  });

  it('names each way it can fail', async () => {
    const reason = async (call: TranslateCall) => JSON.parse((await reasonOf(call))[0]!).reason;

    expect(await reason(answering(() => ''))).toBe('empty');
    expect(await reason(answering(() => 'Llámame, Sara.'))).toBe('name_lost');
    expect(await reason(answering(() => 'Llámame <i>hoy</i>, Sarah.'))).toBe('markup');
    expect(await reason(answering(() => `Sarah ${'palabra '.repeat(40)}`))).toBe('too_long');
  });

  it('says nothing when there is one', async () => {
    expect(await reasonOf(answering(() => 'Llámame esta noche, Sarah.'))).toEqual([]);
  });
});

describe('knownNames — the names a card itself carries, and nothing fetched', () => {
  const base = { householdId: 'hh-1', correlationId: 'c', createdAt: 1, actions: [] };

  it('always knows Wick and the films', () => {
    const week: WeekCard = { ...base, type: 'WEEK', id: 'week-2026-W41', isoWeek: '2026-W41', text: 'A quiet week.' };

    expect(knownNames(week)).toEqual(expect.arrayContaining(['Wick', 'Big Buck Bunny', 'Sintel', 'Tears of Steel']));
  });

  it('knows who a note is from, by their whole name and their first', () => {
    const note: MessageCard = { ...base, type: 'MESSAGE', id: 'note-1', fromName: 'Sarah Hughes', suggestedReplies: [] };

    expect(knownNames(note)).toEqual(expect.arrayContaining(['Sarah Hughes', 'Sarah']));
  });

  it('knows who the door took the visitor for', () => {
    const door: DoorCard = { ...base, type: 'DOOR', id: 'door-1', line: 'Maria is at the door.', match: { personId: 'p1', name: 'Maria', basis: 'schedule', expectedToday: true, confidence: 0.9 } };

    expect(knownNames(door)).toContain('Maria');
    const { match, ...unmatched } = door;
    expect(knownNames(unmatched, { cardId: 'door-1', match: { ...match!, name: 'Ana' } })).toContain('Ana');
  });
});
