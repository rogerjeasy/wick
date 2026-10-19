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
 * One exception, narrow on purpose: a name in another script (foreign.ts). A
 * word wholly in one other script that says nothing of a doctor, a hospital,
 * medicine, a bank or a debt may stand as a person's name, and where the
 * household's own people are given (`people`), the same words are set aside
 * inside a sentence. Without that, a household whose resident or carer is
 * written in Cyrillic or Chinese was told "Something went wrong" to every
 * question. Everything else in another script is unreadable still.
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
import { personIdFor, type FactClass } from '@wick/contracts';
import { evaluate } from './evaluate.js';
import { isForeignNameWord } from './foreign.js';
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
 * A person whose name is also a word: "Anna Cash" is not money, and "Mrs
 * Banks" is not her bank. The household's own people (a regular visitor, a
 * member of the circle) are passed by the caller (`people`), and a string
 * that IS one of their names, or the id made from it ("anna-cash"), is
 * cleared as a name. Nothing is ever set aside inside a sentence: a name
 * is matched only as the whole string, and only a name that passes
 * clearNameForFamily counts, so a member who calls themselves "Pension" or
 * "Council Tax" clears nothing but their own name, and not even that.
 */
/** The id a name is filed under: "Mary-Jo O'Neil" is "mary-jo-o-neil" (contracts personIdFor, which the roster uses). */
const idOf = personIdFor;

function isOneOf(text: string, people: readonly string[]): boolean {
  const read = normalise(text.trim());
  if (read === undefined) return false;
  return people.some((person) => clearNameForFamily(person) && (read === normalise(person.trim()) || read === idOf(person)));
}

export interface ClearOptions {
  /** The household's own people, by name: a string that is exactly one of them is cleared as a name (isOneOf). */
  readonly people?: readonly string[];
}

/**
 * The words of the household's own people that are written in another
 * script, set aside as "someone" so the lexicon reads the sentence around
 * them. Only a word that clearNameForFamily would take as part of a name, only
 * of a person who passes it, and only where it stands alone (not inside a
 * longer run of letters). A Latin name is never set aside here: "Anna Cash"
 * is cleared as a whole string or not at all, as above.
 */
function maskNames(text: string, people: readonly string[] | undefined): string {
  if (!people?.length) return text;
  const names = new Set<string>();
  for (const person of people) {
    if (!clearNameForFamily(person)) continue;
    for (const word of person.trim().split(/\s+/)) {
      if (isForeignNameWord(word)) names.add(word);
    }
  }
  if (names.size === 0) return text;
  const alternatives = [...names].sort((a, b) => b.length - a.length).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const standingAlone = new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}\\p{M}])`, 'giu');
  return text.replace(standingAlone, 'someone');
}

/** Which protected classes a string is about, by the lexicon — or that it cannot be read. */
export function classify(text: string, options: ClearOptions = {}): Reading {
  const plain = normalise(maskNames(text, options.people));
  if (plain === undefined) return { readable: false };
  if (options.people?.length && isOneOf(text, options.people)) return { readable: true, classes: [] };
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

/** A title before a surname, as a name is typed ("Mrs Banks"). Not "Dr": that is a fact about her health. */
const TITLES: ReadonlySet<string> = new Set(['Mr', 'Mrs', 'Ms', 'Miss', 'Mx']);

/**
 * Surnames that are also words in the lexicon. Only these are read as a
 * surname, and only after a first name or a title: a list, not a guess, so
 * "Council Tax", "Universal Credit" and "Anna Pension" are still refused.
 */
const SURNAMES_THAT_ARE_WORDS: ReadonlySet<string> = new Set(['cash', 'banks', 'bank', 'money', 'pounds']);

/** Words a name can start with that are not a first name: "the nurse", "Her Solicitor". */
const NOT_A_FIRST_NAME: ReadonlySet<string> = new Set(['the', 'a', 'an', 'her', 'his', 'my', 'our', 'their', 'your', 'mum', 'dad', 'mums', "mum's", "dad's"]);

/**
 * Whether a name typed for a person (a regular visitor) may be kept and
 * shown to the family. A known surname that is also a word (Cash, Banks,
 * Money) is read as a surname when it follows a first name or a title;
 * every other word is read as any word is, so "Dr Patel", "Benefits
 * Officer", "the nurse" and "Her Solicitor" are still refused.
 */
export function clearNameForFamily(name: string, policy: HouseholdPolicy = DEFAULT_POLICY): boolean {
  const words = name.trim().split(/\s+/);
  const first = words[0] ?? '';
  const startsAsAName = words.length > 1 && (/^[A-Z]/.test(first) || isForeignNameWord(first)) && !NOT_A_FIRST_NAME.has(first.toLowerCase());
  const read = words
    .map((word, i) => {
      // A word in another script that says nothing protected is a name (foreign.ts).
      if (isForeignNameWord(word)) return 'someone';
      if (i === 0 && TITLES.has(word.replace(/\.$/, ''))) return 'someone';
      if (i > 0 && startsAsAName && /^[A-Z]/.test(word) && SURNAMES_THAT_ARE_WORDS.has(word.toLowerCase())) return 'someone';
      return word;
    })
    .join(' ');
  return clearForFamily(read, policy).cleared;
}
