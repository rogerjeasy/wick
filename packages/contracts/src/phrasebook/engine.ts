/**
 * How the phrasebook finds a sentence.
 *
 * A catalogue is a list of whole sentences as the builders write them in
 * English, each with the same sentence written by hand in another language
 * (es.ts). Where a builder puts a value into a sentence the catalogue has a
 * placeholder of a known kind — `{first}` a first name, `{day}` a weekday,
 * `{time}` a clock time — and the hand-written sentence says where that
 * value goes, and in which of its forms.
 *
 * The rules that keep it from ever guessing:
 *
 *   - A sentence is matched against the WHOLE of what it is given, to the
 *     last full stop. Nothing is trimmed and nothing is searched for.
 *   - A field of several sentences is taken sentence by sentence, and is
 *     translated only if every one of them is held. One sentence unknown
 *     and the whole field is: never half in each language.
 *   - A placeholder takes only what its kind can be. A first name is one
 *     word; no name runs across the end of a sentence; a weekday is one of
 *     seven. So a sentence that is not in the catalogue cannot be taken for
 *     a long name inside one that is.
 *   - Where two sentences both fit, the one that says most in its own
 *     words is the one meant ("somebody answers" before "{first} answers").
 *     If that does not settle it, or the field can be read two ways that
 *     come out differently, there is no answer.
 *   - A translation that would not fit the card the English fitted is said
 *     more shortly if the catalogue has a shorter way, and otherwise not
 *     said at all: the English is shown, which is known to fit.
 *
 * Pure, dependency-free, and written to run anywhere the phrasebook does —
 * Node, a Lambda, a television — so the patterns keep to what every engine
 * has: no named groups, no look-behind, no Unicode classes.
 */

/** card.ts MAX_CARD_DETAIL_CHARS, repeated so this file imports nothing (phrasebook.test.ts holds them equal). */
export const FIELD_LIMIT = 240;

/** Longer than anything Wick writes. Past it nothing is looked up: there is nothing to find, and no reason to try. */
const MAX_ENGLISH_CHARS = 2000;
/** More sentences than any field has. Past it only the field as one sentence is tried. */
const MAX_SENTENCES = 10;

/** One sentence of the catalogue. `button` marks a label, held to a button's length. */
export interface Entry {
  readonly en: string;
  readonly to: string;
  /** A shorter way of saying it, for when the long way would not fit the card. */
  readonly short?: string;
  readonly button?: boolean;
}

/** What a placeholder was found to hold. */
export type Slot =
  /** A person as a builder names them: a name, or the noun used where there is none ("the family"). */
  | { readonly kind: 'person'; readonly text: string }
  | { readonly kind: 'people'; readonly list: readonly string[] }
  /** 0 is Monday. */
  | { readonly kind: 'day'; readonly index: number }
  /** On the twenty-four-hour clock. */
  | { readonly kind: 'time'; readonly hour: number; readonly minute: number }
  /** this morning, this afternoon, this evening. */
  | { readonly kind: 'part'; readonly index: number }
  /** mornings, afternoons, evenings, nights. */
  | { readonly kind: 'parts'; readonly index: number }
  /** `weekday` as `day`; `month` from 0. */
  | { readonly kind: 'date'; readonly weekday: number; readonly day: number; readonly month: number }
  | { readonly kind: 'count'; readonly text: string; readonly value: number }
  | { readonly kind: 'title'; readonly text: string };

/**
 * A language's own words for a value: the weekday, the hour as it is
 * written there, the noun for "the family". `form` asks for one of the
 * value's forms (es.ts lists them); undefined when there is no such form.
 */
export type Lexicon = (slot: Slot, form: string | undefined) => string | undefined;

export interface Phrasebook {
  /** The sentence in this language — or undefined when the catalogue does not hold the whole of it. */
  readonly say: (english: string) => string | undefined;
  /** How many sentences it holds. */
  readonly size: number;
  /** Entries left out because they were written wrongly. Empty, or the catalogue has a mistake in it (phrasebook.test.ts). */
  readonly problems: readonly string[];
}

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const PARTS_OF_TODAY = ['this morning', 'this afternoon', 'this evening'];
const PARTS_OF_A_DAY = ['mornings', 'afternoons', 'evenings', 'nights'];

/**
 * One word of a name: anything without a space that does not end a
 * sentence or a clause — or a short capitalised abbreviation with its full
 * stop ("Dr.", "J."). That is what stops a name running on into the next
 * sentence.
 */
const WORD = '(?:[^\\s]*[^\\s.,:;!?]|[A-Z][^\\s.,:;!?]{0,2}\\.)';
/** One word of a film's title: the same, but a title may carry a comma or a colon. */
const TITLE_WORD = '(?:[^\\s]*[^\\s.!?]|[A-Z][^\\s.!?]{0,2}\\.)';

interface Kind {
  /** One capturing group, and no other. */
  readonly pattern: string;
  readonly read: (raw: string) => Slot | undefined;
}

const oneOf = (words: readonly string[]): string => `(${words.join('|')})`;
const indexIn = (words: readonly string[], kind: 'day' | 'part' | 'parts') => (raw: string): Slot | undefined => {
  const index = words.indexOf(raw);
  return index < 0 ? undefined : { kind, index };
};

/**
 * What may stand between the minutes and "am": a space, or one of the
 * no-break spaces some runtimes' Intl writes there. Spelt by number, so
 * that no invisible character is ever in this file or in a copy of it.
 */
const BEFORE_AM = `[ ${String.fromCharCode(0xa0, 0x202f)}]?`;
const CLOCK_TIME = new RegExp(`^(\\d{1,2})(?::(\\d{2}))?${BEFORE_AM}([ap])m$`);

function readTime(raw: string): Slot | undefined {
  const match = CLOCK_TIME.exec(raw);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? '0');
  if (hour > 12 || minute > 59) return undefined;
  return { kind: 'time', hour: (hour % 12) + (match[3] === 'p' ? 12 : 0), minute };
}

function readDate(raw: string): Slot | undefined {
  const [weekday, day, month] = raw.split(' ');
  const slot = { kind: 'date' as const, weekday: DAYS.indexOf(weekday ?? ''), day: Number(day), month: MONTHS.indexOf(month ?? '') };
  return slot.weekday < 0 || slot.month < 0 || slot.day < 1 || slot.day > 31 ? undefined : slot;
}

function readPeople(raw: string): Slot {
  const parts = raw.split(', ');
  const last = parts.pop() ?? '';
  return { kind: 'people', list: [...parts, ...last.split(' and ')] };
}

const person = (raw: string): Slot => ({ kind: 'person', text: raw });

/** The kinds of placeholder an English sentence can have. */
const KINDS: Readonly<Record<string, Kind>> = {
  /** A first name — one word — or the noun a builder uses in its place. */
  first: { pattern: `(${WORD}|[Tt]he family|[Yy]our family)`, read: person },
  /** A name as somebody typed it: several words. */
  name: { pattern: `(${WORD}(?: ${WORD}){0,5})`, read: person },
  /** "Sarah", "Sarah and David", "Sarah, David and Tom": first names. */
  names: { pattern: `(${WORD}(?:, ${WORD})*(?: and ${WORD})?)`, read: readPeople },
  day: { pattern: oneOf(DAYS), read: indexIn(DAYS, 'day') },
  /** "9:02 am", "3 pm" — with whichever space the runtime's Intl puts before am. */
  time: { pattern: `(\\d{1,2}(?::\\d{2})?${BEFORE_AM}[ap]m)`, read: readTime },
  part: { pattern: oneOf(PARTS_OF_TODAY), read: indexIn(PARTS_OF_TODAY, 'part') },
  parts: { pattern: oneOf(PARTS_OF_A_DAY), read: indexIn(PARTS_OF_A_DAY, 'parts') },
  /** "Sunday 18 October". */
  date: { pattern: `((?:${DAYS.join('|')}) \\d{1,2} (?:${MONTHS.join('|')}))`, read: readDate },
  n: { pattern: '(\\d{1,4})', read: (raw) => ({ kind: 'count', text: raw, value: Number(raw) }) },
  title: { pattern: `(${TITLE_WORD}(?: ${TITLE_WORD}){0,11})`, read: (raw) => ({ kind: 'title', text: raw }) },
};

/** A piece of a hand-written sentence: its own words, a value in one of its forms, or a choice by how many. */
type Piece =
  | string
  | { readonly key: string; readonly form: string | undefined }
  | { readonly key: string; readonly one: string; readonly many: string };

interface Template {
  readonly match: RegExp;
  readonly keys: readonly string[];
  readonly kinds: readonly Kind[];
  /** How much of the sentence is its own words: what decides between two that both fit. */
  readonly weight: number;
  readonly to: readonly Piece[];
  readonly short: readonly Piece[] | undefined;
}

interface Rendering {
  readonly long: string;
  readonly short: string;
}

const escaped = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `{key}` a value, `{key|form}` one of its forms, `{key?one:many}` words that go by how many there are. */
function pieces(text: string, keys: readonly string[]): Piece[] {
  const out: Piece[] = [];
  const reference = /\{([a-z]+\d?)(?:\|([a-z]+)|\?([^{}:]*):([^{}]*))?\}/g;
  let from = 0;
  for (let found = reference.exec(text); found; found = reference.exec(text)) {
    const [whole, key, form, one, many] = found;
    if (key === undefined || !keys.includes(key)) throw new Error(`no {${key}} in the English`);
    if (found.index > from) out.push(text.slice(from, found.index));
    out.push(one !== undefined && many !== undefined ? { key, one, many } : { key, form });
    from = found.index + whole.length;
  }
  if (from < text.length) out.push(text.slice(from));
  if (out.some((piece) => typeof piece === 'string' && /[{}]/.test(piece))) throw new Error('a placeholder written wrongly');
  return out;
}

function template(entry: Entry): Template {
  const keys: string[] = [];
  const kinds: Kind[] = [];
  let source = '';
  let weight = 0;
  let from = 0;
  const placeholder = /\{([a-z]+)(\d?)\}/g;
  for (let found = placeholder.exec(entry.en); found; found = placeholder.exec(entry.en)) {
    const kind = Object.prototype.hasOwnProperty.call(KINDS, found[1]!) ? KINDS[found[1]!] : undefined;
    const key = `${found[1]}${found[2]}`;
    if (!kind) throw new Error(`no kind of placeholder called {${found[1]}}`);
    if (keys.includes(key)) throw new Error(`{${key}} twice`);
    const literal = entry.en.slice(from, found.index);
    source += escaped(literal) + kind.pattern;
    weight += literal.length;
    keys.push(key);
    kinds.push(kind);
    from = found.index + found[0].length;
  }
  const rest = entry.en.slice(from);
  if (/[{}]/.test(entry.en.replace(placeholder, ''))) throw new Error('a placeholder written wrongly');
  return {
    match: new RegExp(`^${source}${escaped(rest)}$`),
    keys,
    kinds,
    weight: weight + rest.length,
    to: pieces(entry.to, keys),
    short: entry.short === undefined ? undefined : pieces(entry.short, keys),
  };
}

const isMany = (slot: Slot): boolean => (slot.kind === 'people' ? slot.list.length > 1 : slot.kind === 'count' ? slot.value !== 1 : false);

function written(parts: readonly Piece[], slots: ReadonlyMap<string, Slot>, lexicon: Lexicon): string | undefined {
  let out = '';
  for (const piece of parts) {
    if (typeof piece === 'string') {
      out += piece;
      continue;
    }
    const slot = slots.get(piece.key);
    if (!slot) return undefined;
    const word = 'one' in piece ? (isMany(slot) ? piece.many : piece.one) : lexicon(slot, piece.form);
    if (word === undefined) return undefined;
    out += word;
  }
  return out;
}

/** Where a field can be divided: after a full stop, a question or an exclamation that a single space follows. */
function sentenceStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i + 2 < text.length; i += 1) {
    const mark = text[i];
    if ((mark === '.' || mark === '!' || mark === '?') && text[i + 1] === ' ' && text[i + 2] !== ' ') starts.push(i + 2);
  }
  return starts;
}

const distinct = (renderings: readonly Rendering[]): Rendering[] => renderings.filter((r, i) => renderings.findIndex((other) => other.long === r.long) === i);

/** A catalogue, ready to be asked. Never throws: an entry written wrongly is left out and named in `problems`. */
export function compile(entries: readonly Entry[], lexicon: Lexicon): Phrasebook {
  const templates: Template[] = [];
  const problems: string[] = [];
  for (const entry of entries) {
    try {
      templates.push(template(entry));
    } catch (err) {
      problems.push(`${entry.en}: ${err instanceof Error ? err.message : 'unreadable'}`);
    }
  }

  /** One sentence, by the template that says most of it in its own words. Several only when templates of equal weight disagree. */
  function sentence(text: string): Rendering[] {
    let best: Rendering[] = [];
    let weight = -1;
    for (const candidate of templates) {
      if (candidate.weight < weight) continue;
      const found = candidate.match.exec(text);
      if (!found) continue;
      const slots = new Map<string, Slot>();
      let read = true;
      candidate.keys.forEach((key, i) => {
        const slot = candidate.kinds[i]!.read(found[i + 1] ?? '');
        if (slot) slots.set(key, slot);
        else read = false;
      });
      if (!read) continue;
      const long = written(candidate.to, slots, lexicon);
      if (long === undefined) continue;
      const short = candidate.short === undefined ? long : (written(candidate.short, slots, lexicon) ?? long);
      if (candidate.weight > weight) best = [];
      weight = candidate.weight;
      best.push({ long, short });
    }
    return distinct(best);
  }

  function say(english: string): string | undefined {
    if (typeof english !== 'string' || english === '' || english.length > MAX_ENGLISH_CHARS) return undefined;
    let starts = sentenceStarts(english);
    if (starts.length > MAX_SENTENCES) starts = [0];
    const ends = [...starts.slice(1).map((start) => start - 1), english.length];

    // Every way of reading the field from sentence `i` on, as whole sentences of the catalogue.
    const known = new Map<number, Rendering[]>();
    const readFrom = (i: number): Rendering[] => {
      if (i === starts.length) return [{ long: '', short: '' }];
      const before = known.get(i);
      if (before) return before;
      const readings: Rendering[] = [];
      for (let j = i; j < starts.length && readings.length < 4; j += 1) {
        const heads = sentence(english.slice(starts[i], ends[j]));
        if (heads.length === 0) continue;
        for (const tail of readFrom(j + 1)) {
          for (const head of heads) {
            readings.push(tail.long === '' ? head : { long: `${head.long} ${tail.long}`, short: `${head.short} ${tail.short}` });
          }
        }
      }
      const unique = distinct(readings);
      known.set(i, unique);
      return unique;
    };

    const readings = readFrom(0);
    const only = readings[0];
    if (readings.length !== 1 || !only) return undefined;
    // The English that fitted the card must not become a translation that does not.
    if (only.long.length <= FIELD_LIMIT || english.length > FIELD_LIMIT) return only.long;
    return only.short.length <= FIELD_LIMIT ? only.short : undefined;
  }

  return {
    say: (english) => {
      try {
        return say(english);
      } catch {
        return undefined;
      }
    },
    size: templates.length,
    problems,
  };
}
