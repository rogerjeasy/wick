/**
 * The television speaks her language.
 *
 * A household has one language for the resident's television: English
 * unless she has said otherwise. The organiser can ask for another from the
 * family app; nothing changes until she answers the question on her own
 * television — asked in both languages at once, because she may read only
 * one of them — and it is hers to change back the same way.
 *
 * What changes is only what her television shows her:
 *
 *   - Everything Wick itself writes — the door's headline, every question
 *     she consents by, every button — comes from a hand-written phrasebook
 *     of whole sentences (phrasebook/). A sentence the phrasebook does not
 *     hold stays in English: words she agrees to are never left to a
 *     machine.
 *   - Only free text is machine-translated: a note the family wrote, the
 *     door's description of who is there, the week's paragraph. It is
 *     translated on its way to her television and nowhere else.
 *
 * Nothing translated ever leaves the house. Her answers are keys; a note's
 * replies are the stored English words; every row keeps the English it was
 * written in, and every family tool reads what it read before.
 *
 * The language is `language` on `HH#<household>` / `META`; a question still
 * open is `languageAsked` beside it. The television learns it on the home
 * message (`HomeState.language`, light.ts) — so the pairing screen, before
 * there is a household, is always English.
 */
import type { CardAction } from './card.js';

export const LANGUAGES = ['en', 'es'] as const;
export type HouseholdLanguage = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE = 'en' satisfies HouseholdLanguage;
/** A language a household can choose in place of the default. */
export type OtherLanguage = Exclude<HouseholdLanguage, typeof DEFAULT_LANGUAGE>;

export const isHouseholdLanguage = (value: unknown): value is HouseholdLanguage =>
  typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);

/** The attributes on the household's META row. `language` is absent for English. */
export const HOUSEHOLD_LANGUAGE_ATTRS = {
  /** The language she chose. */
  language: 'language',
  /** The language of a question still open on her television. */
  asked: 'languageAsked',
  /** The first name of the organiser who asked, for the card. */
  askedBy: 'languageAskedBy',
  askedAt: 'languageAskedAt',
  /** The language she last said no to, and when — her no is an answer too. */
  declined: 'languageDeclined',
  declinedAt: 'languageDeclinedAt',
} as const;

/**
 * How long her no stands. The same language is not asked for again sooner:
 * a question she has answered is not put to her every day until she gives
 * in. A different language can be asked for at any time, and so can the
 * same one once this has passed.
 */
export const LANGUAGE_ASK_AGAIN_AFTER_MS = 7 * 24 * 60 * 60_000;

/** The longest name the question carries twice and still fits a card. A longer one is cut, never the sentence. */
const MAX_ASKER_CHARS = 24;
const askerName = (name: string): string => (name.length > MAX_ASKER_CHARS ? `${name.slice(0, MAX_ASKER_CHARS - 1)}…` : name);

/** How each language is named, in English (for the family app) and in itself. */
export const LANGUAGE_NAMES: Readonly<Record<HouseholdLanguage, { readonly inEnglish: string; readonly own: string }>> = {
  en: { inEnglish: 'English', own: 'English' },
  es: { inEnglish: 'Spanish', own: 'español' },
};

const CARD_PREFIX = 'language-';

/** Deterministic, like the Circle card's: the press names the language without the television holding anything. */
export const languageCardId = (language: HouseholdLanguage): string => `${CARD_PREFIX}${language}`;

export function languageOfCardId(cardId: unknown): HouseholdLanguage | undefined {
  if (typeof cardId !== 'string' || !cardId.startsWith(CARD_PREFIX)) return undefined;
  const language = cardId.slice(CARD_PREFIX.length);
  return isHouseholdLanguage(language) ? language : undefined;
}

export const LANGUAGE_ACTIONS = { yes: 'yes', no: 'no' } as const;

/**
 * The question, in both languages — the one asked for first. Fixed
 * sentences, written by hand: this is the one card that cannot go through
 * the phrasebook, because it is how she comes to have one.
 */
export function languageQuestion(
  language: HouseholdLanguage,
  askedBy: string,
): { readonly headline: string; readonly detail: string; readonly actions: readonly CardAction[] } {
  askedBy = askerName(askedBy);
  if (language === 'es') {
    return {
      headline: '¿Quiere que Wick le hable en español?',
      detail:
        `${askedBy} ha pedido que este televisor le hable en español. Solo cambia si usted dice que sí. ` +
        `${askedBy} asks whether this television should use Spanish. Nothing changes unless you say yes.`,
      actions: [
        { id: LANGUAGE_ACTIONS.yes, label: 'Sí, en español', kind: 'primary' },
        { id: LANGUAGE_ACTIONS.no, label: 'No, keep English', kind: 'secondary' },
      ],
    };
  }
  return {
    headline: 'Shall Wick speak English again?',
    detail:
      `${askedBy} asks whether this television should go back to English. Nothing changes unless you say yes. ` +
      `${askedBy} pregunta si este televisor debe volver al inglés. Solo cambia si usted dice que sí.`,
    actions: [
      { id: LANGUAGE_ACTIONS.yes, label: 'Yes, in English', kind: 'primary' },
      { id: LANGUAGE_ACTIONS.no, label: 'No, seguir en español', kind: 'secondary' },
    ],
  };
}
