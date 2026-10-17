/**
 * The Guardian's reading of free text: what protected class, if any, a
 * sentence is about, and whether it may be shown to the family.
 *
 * `evaluate` decides by class. This decides which class a string is in.
 * The two together are the content gate: `clearForFamily` reads the
 * string with the lexicon (lexicon.ts), and asks `evaluate` about every
 * class it finds. Deterministic, pure, and the same answer every time for
 * the same words. No model is asked, because a model is what the gate is
 * for.
 *
 * Fail closed. A string the lexicon cannot read is not cleared:
 *   - a letter outside a–z once accents are taken off (another script, or a
 *     look-alike letter: Cyrillic "о" in "dоctor"),
 *   - an invisible character (a zero-width space splitting a word),
 *   - a pictograph (an emoji is a word the lexicon has no entry for: 💊).
 * English is the language every family-bound string is written in (the
 * resident's language changes only what her own television shows), so
 * this withholds nothing Wick itself wrote.
 *
 * VERBATIM has no entry in the lexicon. Her own words never become text:
 * her television has no microphone, and her replies are keys to sentences
 * Wick wrote (send_note_to_tv.ts). The class is refused by `evaluate`, so
 * anything labelled VERBATIM still never reaches the family.
 *
 * What this cannot do: catch what the lexicon does not list. "How was
 * Tuesday at St Mary's?" passes. So does a word spelt to dodge it
 * ("d0ctor"). The gate stops Wick being the way a protected fact reaches
 * the family by accident — a vision model naming a uniform, a family
 * member's question, a name typed as a role — not a person set on
 * smuggling one past it.
 */
import type { FactClass } from '@wick/contracts';
import { evaluate } from './evaluate.js';
import { LEXICON, type ListedClass } from './lexicon.js';
import { DEFAULT_POLICY } from './policy.js';
import type { HouseholdPolicy } from './types.js';

/** Letters that do not come apart into a plain letter and an accent. */
const PLAIN: Readonly<Record<string, string>> = {
  ł: 'l', ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', đ: 'd', ð: 'd', þ: 'th', ı: 'i', ħ: 'h', ŧ: 't',
};

/** Typographic punctuation, straightened so the lexicon sees one apostrophe and one dash, and four marks spelt out. */
const STRAIGHT: Readonly<Record<string, string>> = {
  '\u2018': "'", '\u2019': "'", '\u02BC': "'", '\u2032': "'",
  '\u201C': '"', '\u201D': '"',
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2212': '-',
  '\u2026': '...', '\u00A0': ' ',
  // Marks that are symbols, not words: a film's attribution carries one.
  '\u00A9': '(c)', '\u00AE': '(r)', '\u2122': '(tm)', '\u00B0': ' degrees',
};

/**
 * Anything still in the text after normalising that the lexicon cannot
 * read: a letter outside a-z, a digit outside 0-9, a control or invisible
 * character other than ordinary white space, or a pictograph.
 */
const UNREADABLE = /[^\P{L}a-z]|[^\P{N}0-9]|[^\P{C}\t\n\r]|\p{So}|\p{M}/u;

export type Reading =
  | { readonly readable: true; readonly classes: readonly ListedClass[] }
  | { readonly readable: false };

/**
 * The text as the lexicon reads it: compatibility forms folded (a
 * full-width "Ｄｒ" is "Dr"), accents taken off ("dóctor" is "doctor"), lower
 * case, typographic quotes and dashes straightened. Undefined when what is
 * left holds something the lexicon cannot read.
 */
export function normalise(text: string): string | undefined {
  const folded = text
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u02BC\u2032\u201C\u201D\u2010-\u2014\u2212\u2026\u00A0\u00A9\u00AE\u2122\u00B0]/g, (c) => STRAIGHT[c] ?? c)
    .toLowerCase()
    .replace(/[\u0142\u00F8\u00E6\u0153\u00DF\u0111\u00F0\u00FE\u0131\u0127\u0167]/g, (c) => PLAIN[c] ?? c)
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  return UNREADABLE.test(folded) ? undefined : folded;
}

/**
 * A person, set aside before the lexicon reads a sentence, so that a
 * surname is not taken for a fact: "Mrs Banks" is not her bank, and
 * "Anna Cash" is not money. Only what is certainly a person is set aside:
 *   - a title and the capitalised word after it ("Mrs Banks", "Mr. Cash"),
 *     read before the text is lower-cased, so "mrs banks" is not a title;
 *   - the household's own people, by the names Wick holds for them (a
 *     regular visitor, a member of the circle), and by the id made from that
 *     name ("anna-cash"). A caller passes them (`people`).
 * Never a capitalised phrase on its own: "Universal Credit" and "Council
 * Tax" are capitalised too. The words around a person are read as ever.
 */
const TITLE_AND_SURNAME = /\b(?:Mrs|Mr|Ms|Miss|Mx)\.?\s+[A-Z][A-Za-z'-]*/g;
const SOMEONE = 'someone';

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The id a name is filed under: "Mary-Jo O'Neil" is "mary-jo-o-neil" (add_regular_visitor personIdFor). */
const idOf = (name: string): string =>
  name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function setPeopleAside(text: string, people: readonly string[]): string {
  let out = text.replace(TITLE_AND_SURNAME, SOMEONE);
  for (const person of people) {
    const name = person.trim();
    if (name.length < 2) continue;
    for (const form of new Set([name, idOf(name)])) {
      if (form.length < 2) continue;
      out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(form)}(?![\\p{L}\\p{N}])`, 'giu'), SOMEONE);
    }
  }
  return out;
}

export interface ClearOptions {
  /** The household's own people, by name: set aside before the lexicon reads the text (setPeopleAside). */
  readonly people?: readonly string[];
}

/** Which protected classes a string is about, by the lexicon — or that it cannot be read. */
export function classify(text: string, options: ClearOptions = {}): Reading {
  const plain = normalise(setPeopleAside(text, options.people ?? []));
  if (plain === undefined) return { readable: false };
  const classes = new Set<ListedClass>();
  for (const marker of LEXICON) {
    if (marker.pattern.test(plain)) classes.add(marker.class);
  }
  return { readable: true, classes: [...classes] };
}

export type Clearance =
  | { readonly cleared: true; readonly text: string }
  /** `classes` is empty when the string could not be read at all. Never sent: for the log, and for tests. */
  | { readonly cleared: false; readonly classes: readonly FactClass[] };

/**
 * Whether a string may be shown to the family as it stands.
 *
 * Every class the lexicon finds is put to `evaluate`, with this household's
 * policy, for the FAMILY audience; the string is cleared only if every one
 * is allowed, and only if it could be read. Each class the lexicon finds is
 * in NEVER_TO_FAMILY, which `evaluate` refuses under any policy at all
 * (its step 3, and evaluate.property.test.ts) — so for these four classes
 * the policy cannot change the answer, and a caller that has not read the
 * household's policy loses nothing by passing none.
 */
export function clearForFamily(text: string, policy: HouseholdPolicy = DEFAULT_POLICY, options: ClearOptions = {}): Clearance {
  const reading = classify(text, options);
  if (!reading.readable) return { cleared: false, classes: [] };
  const refused = reading.classes.filter((c) => !evaluate({ class: c, content: text, sourceIds: [] }, 'FAMILY', policy).allow);
  return refused.length === 0 ? { cleared: true, text } : { cleared: false, classes: refused };
}

/** Words a name can start with that are not a first name: "the nurse", "Her Solicitor". */
const NOT_A_FIRST_NAME: ReadonlySet<string> = new Set(['the', 'a', 'an', 'her', 'his', 'my', 'our', 'their', 'your', 'mum', 'dad', 'mums', "mum's", "dad's"]);

/**
 * Whether a name typed for a person (a regular visitor) may be kept and
 * shown to the family. The words after a first name are a surname, set aside
 * like a title's ("Anna Cash", "Tom Banks"); the first word is read as any
 * word is, so "Dr Patel", "Benefits Officer", "the nurse" and "Her
 * Solicitor" are still refused.
 */
export function clearNameForFamily(name: string, policy: HouseholdPolicy = DEFAULT_POLICY): boolean {
  const words = name.trim().split(/\s+/);
  const first = words[0] ?? '';
  const surnameAside =
    words.length > 1 && /^[A-Z]/.test(first) && !NOT_A_FIRST_NAME.has(first.toLowerCase()) && words.slice(1).every((w) => /^[A-Z]/.test(w))
      ? [first, ...words.slice(1).map(() => SOMEONE)].join(' ')
      : name;
  return clearForFamily(surnameAside, policy).cleared;
}
