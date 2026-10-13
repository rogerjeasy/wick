/**
 * The television speaks her language — the machine's small part of it
 * (packages/contracts language.ts).
 *
 * Wick's own sentences come from the phrasebook, written by hand. Only free
 * text goes to a machine: a note the family wrote, the door's description of
 * who is there, the week's paragraph. It goes to Amazon Translate on its way
 * to her television and nowhere else (egress.ts is the one caller, and the
 * one module that holds the client — eslint.config.js keeps it so).
 *
 * What is sent is the English that already passed whatever checks it had to
 * pass: the door description's validator and the week's number check run
 * where they always ran, before this. Nothing here judges the text; it only
 * carries it across.
 *
 * Four rules, each a test:
 *
 *   - A name is never translated. The names the card itself carries, the
 *     films' titles and "Wick" must come back exactly as they went, or the
 *     translation is not used.
 *   - Plain first, marked only at need. Amazon Translate can be told to
 *     leave a name alone (`<span translate="no">`), and does — but it then
 *     takes the name for a thing and puts an article before it ("con el
 *     Rose"), where the same sentence sent plain comes back right, the name
 *     untouched (both seen live, 2026-10-13; kept in translate.test.ts). So
 *     the text is sent plain, and only if a name did not survive is it sent
 *     once more with the names marked.
 *   - A translation is whole or it is nothing. A failure, the time limit, an
 *     empty answer, markup that was never sent, a text too long for a card:
 *     each means no translation for that field, and the television shows the
 *     English. Never an error, never half a sentence.
 *   - The text is never logged — only that a translation was not to be had,
 *     for which field, and why.
 *
 * And one about what a note may contain. The text always goes escaped, so a
 * `<` its writer typed reaches the engine as a character and never as
 * markup. Nothing that comes back as a tag is trusted: from a plain request
 * any tag at all means no translation, and the marks are only ever taken
 * off an answer to a request that carried them — which a text that itself
 * looks like markup is never given, so no mark coming back can be the
 * note's own.
 *
 * Pure: the call to Amazon Translate is handed in.
 */
import { MAX_CARD_DETAIL_CHARS, PROGRAMMES, type Card, type CardPatch, type FreeField, type FreeText, type OtherLanguage } from '@wick/contracts';

/** What `TranslateText` is asked (the fields of `@aws-sdk/client-translate`'s TranslateTextRequest that are used). */
export interface TranslateInput {
  readonly Text: string;
  readonly SourceLanguageCode: 'en';
  readonly TargetLanguageCode: OtherLanguage;
  readonly Settings?: { readonly Formality?: 'FORMAL'; readonly Brevity?: 'ON' };
}

/** One call to Amazon Translate. It must stop when the signal says so. */
export type TranslateCall = (input: TranslateInput, signal: AbortSignal) => Promise<{ readonly TranslatedText?: string | undefined }>;

/**
 * How long the television waits for words in her language before it shows
 * the English: one limit for the whole card, however many calls that takes.
 * Two and a half seconds, because a field may need a second call (the names
 * marked) or a third (a shorter wording) — and the usual case, one plain
 * call, is nowhere near it.
 */
export const TRANSLATE_TIMEOUT_MS = 2500;

/** Plain; marked, if a name was lost; shorter, if it was too long for a card. Never more. */
export const MAX_CALLS_PER_FIELD = 3;

const FREE_FIELDS: readonly FreeField[] = ['transcript', 'description', 'text'];

/**
 * The fields Wick itself wrote — the door's description, the week's
 * paragraph — are asked for in the formal address, where her language has
 * one Amazon Translate can be asked for: the phrasebook says "usted", and a
 * card should not change its manner halfway down. A note is its writer's
 * own voice and is left to the translator.
 */
const WICKS_OWN: readonly FreeField[] = ['description', 'text'];
const FORMAL_IN: Readonly<Record<OtherLanguage, boolean>> = { es: true };

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const cleaned = (names: readonly string[]): string[] =>
  [...new Set(names.map((name) => name.trim()).filter((name) => name.length > 0))]
    // The longer name first: "Ann Marie" is marked whole, not as "Ann".
    .sort((a, b) => b.length - a.length);

/** Any of these names standing as a word of its own — in plain text, or (`escaped`) in text that has been escaped. */
const nameIn = (names: readonly string[], escaped: boolean): RegExp | undefined => {
  const known = cleaned(names);
  if (known.length === 0) return undefined;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${known.map((name) => escapeRegExp(escaped ? escapeHtml(name) : name)).join('|')})(?![\\p{L}\\p{N}])`, 'gu');
};

/** Whether the text has this name as a word of its own: "Rose", not "Rosemary". */
const standsIn = (text: string, name: string): boolean => nameIn([name], false)?.test(text) ?? true;

/** Which of these names the text has. */
const namesIn = (text: string, names: readonly string[]): string[] => cleaned(names).filter((name) => standsIn(text, name));

const NOT_TRANSLATED_OPEN = '<span translate="no">';
const NOT_TRANSLATED_CLOSE = '</span>';

/**
 * The request for one field. The text always goes escaped, so that nothing
 * in a note is taken for markup. Plain, that is all. `marked`, each known
 * name is put inside `<span translate="no">`, which Amazon Translate leaves
 * as it is — the second try, for a translation that lost a name.
 */
export function translationRequest(input: {
  readonly text: string;
  readonly language: OtherLanguage;
  readonly names: readonly string[];
  readonly field: FreeField;
  /** Mark the names not to be translated. */
  readonly marked?: boolean;
  /** Ask for the shorter of the ways to say it: for a translation too long for a card. */
  readonly brief?: boolean;
}): TranslateInput {
  const escaped = escapeHtml(input.text);
  const name = input.marked ? nameIn(input.names, true) : undefined;
  const settings = {
    ...(WICKS_OWN.includes(input.field) && FORMAL_IN[input.language] ? { Formality: 'FORMAL' as const } : {}),
    ...(input.brief ? { Brevity: 'ON' as const } : {}),
  };
  return {
    Text: name ? escaped.replace(name, (found) => `${NOT_TRANSLATED_OPEN}${found}${NOT_TRANSLATED_CLOSE}`) : escaped,
    SourceLanguageCode: 'en',
    TargetLanguageCode: input.language,
    ...(Object.keys(settings).length > 0 ? { Settings: settings } : {}),
  };
}

const SPAN_TAG = /<\/?span\b[^>]*>/gi;
const ANY_TAG = /<\/?[a-z][^>]*>/i;
const ENTITY = /&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi;
const NAMED: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function unescapeHtml(text: string): string {
  return text.replace(ENTITY, (whole, body: string) => {
    const key = body.toLowerCase();
    if (key.startsWith('#')) {
      const code = key.startsWith('#x') ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[key] ?? whole;
  });
}

/** Why an answer cannot be used: there was none, it carried markup that was never sent, or a name did not come back as it went. */
export type TranslationLost = 'empty' | 'markup' | 'name';

/**
 * What came back, made plain text again: the entities turned back into
 * characters — the engine may keep them or may already have done it — and,
 * for an answer to a `marked` request only, the marks taken off.
 *
 * No translation when there is nothing; when a tag comes back that was not
 * sent (from a plain request, any tag at all — the marks included); or when
 * one of the names the text had (`sent`) did not come back as it went.
 */
export function readTranslation(
  translated: string | undefined,
  sent: readonly string[],
  options: { readonly marked: boolean },
): { readonly text: string } | { readonly lost: TranslationLost } {
  if (typeof translated !== 'string') return { lost: 'empty' };
  const unmarked = options.marked ? translated.replace(SPAN_TAG, '') : translated;
  if (ANY_TAG.test(unmarked)) return { lost: 'markup' };
  const text = unescapeHtml(unmarked).replace(/[ \t ]{2,}/g, ' ').trim();
  if (text.length === 0) return { lost: 'empty' };
  if (sent.some((name) => !standsIn(text, name))) return { lost: 'name' };
  return { text };
}

export interface TranslateFreeInput {
  /** The free text of a card, in English, by field (phrasebook freeTextOf). */
  readonly free: FreeText;
  readonly language: OtherLanguage;
  /** The names that must not be translated (knownNames). */
  readonly names: readonly string[];
  readonly call: TranslateCall;
  readonly timeoutMs?: number;
  /** The longest text a card may carry: a longer translation is not used. */
  readonly maxChars?: number;
  /** Where "no translation" is said. Never handed the text. */
  readonly log?: (line: Record<string, unknown>) => void;
}

const say = (line: Record<string, unknown>): void => console.log(JSON.stringify(line));

/**
 * Each free field in her language — or absent, for a field that could not
 * be had whole and in time. Never throws, and never takes longer than the
 * time limit: one limit for the whole card, with its fields asked for at
 * once, and at most three calls for any one of them.
 */
export async function translateFree(input: TranslateFreeInput): Promise<FreeText> {
  const { free, language, names, call, timeoutMs = TRANSLATE_TIMEOUT_MS, maxChars = MAX_CARD_DETAIL_CHARS, log = say } = input;
  const wanted = FREE_FIELDS.flatMap((field) => {
    const text = free[field];
    return typeof text === 'string' && text.trim().length > 0 ? [{ field, text }] : [];
  });
  if (wanted.length === 0) return {};

  const stop = new AbortController();
  const TIMED_OUT = Symbol('timed out');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      stop.abort();
      resolve(TIMED_OUT);
    }, timeoutMs);
  });

  /** One field: its translation, or the reason there is none. */
  const one = async (field: FreeField, text: string): Promise<{ readonly text: string } | { readonly reason: string }> => {
    const sent = namesIn(text, names);
    // A text that itself looks like markup is never sent marked: a mark that came back could be its own.
    const canMark = sent.length > 0 && !ANY_TAG.test(text);
    let marked = false;
    let brief = false;
    for (let calls = 0; calls < MAX_CALLS_PER_FIELD; calls += 1) {
      const answer = await call(translationRequest({ text, language, names, field, marked, brief }), stop.signal);
      const read = readTranslation(answer?.TranslatedText, sent, { marked });
      if ('text' in read) {
        if (read.text.length <= maxChars) return { text: read.text };
        // Too long for a card: once more, shorter — and if that was the shorter one, there is none.
        if (brief) return { reason: 'too_long' };
        brief = true;
      } else if (read.lost === 'name' && !marked && canMark) {
        // Plain lost a name: once more, with the names marked.
        marked = true;
      } else {
        return { reason: read.lost === 'name' ? 'name_lost' : read.lost };
      }
    }
    return { reason: 'too_long' };
  };

  try {
    const results = await Promise.all(
      wanted.map(async ({ field, text }) => {
        let outcome: { readonly text: string } | { readonly reason: string };
        try {
          const raced = await Promise.race([one(field, text), limit]);
          outcome = raced === TIMED_OUT ? { reason: 'timeout' } : raced;
        } catch (err) {
          outcome = { reason: stop.signal.aborted ? 'timeout' : ((err as { name?: unknown } | undefined)?.name?.toString() ?? 'error') };
        }
        if ('reason' in outcome) log({ level: 'warn', msg: 'translation_unavailable', field, language, reason: outcome.reason });
        return 'text' in outcome ? ([field, outcome.text] as const) : undefined;
      }),
    );
    return Object.fromEntries(results.filter((entry): entry is readonly [FreeField, string] => entry !== undefined));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Whatever is still on its way is told to stop: nothing of it will be used.
    stop.abort();
  }
}

const personNames = (name: string | undefined): string[] => {
  if (typeof name !== 'string') return [];
  const first = name.trim().split(/\s+/)[0];
  return first ? [name, first] : [];
};

/**
 * The names that must come through a translation untouched: the ones the
 * card itself carries — who a note is from, who the door took the visitor
 * for — the titles of the films, and Wick. Nothing is read to find more.
 */
export function knownNames(card: Card, patch?: CardPatch): string[] {
  const people =
    card.type === 'MESSAGE' ? personNames(card.fromName)
    : card.type === 'DOOR' ? personNames(card.match?.name)
    : card.type === 'WATCH' ? personNames(card.withName)
    : card.type === 'CIRCLE' ? personNames(card.personName)
    : [];
  return [...new Set(['Wick', ...PROGRAMMES.map((programme) => programme.title), ...people, ...personNames(patch?.match?.name)])];
}
