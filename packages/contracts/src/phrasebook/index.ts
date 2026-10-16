/**
 * The phrasebook — everything Wick itself says to the resident, in her
 * language (language.ts).
 *
 * Whole sentences, written by hand (es.ts), matched against the English
 * that the builders already produce (engine.ts) — so English stays every
 * builder's output, every stored row and every test, and this is the one
 * place another language lives. A sentence the phrasebook does not hold is
 * left exactly as it was: `sayIn` never guesses, and nothing she consents
 * by is ever handed to a machine.
 *
 * Pure and dependency-free, because it runs in three places: bundled into
 * the agent plane and the Wick server (services/agent egress.ts), and as a
 * generated copy beside the edge Lambdas, which are deployed as plain .mjs
 * (`npm run phrasebook:build` writes services/edge-device/lambda/
 * phrasebook.generated.mjs from this directory; a test holds it to it).
 */
import type { Card, CardPatch } from '../card.js';
import type { OtherLanguage } from '../language.js';
import type { HomeState } from '../light.js';
import type { Phrasebook } from './engine.js';
import { SPANISH } from './es.js';

/**
 * The fields of a card that are not Wick's own sentences: a note the family
 * wrote, the door's description of who is there, the week's paragraph.
 * These, and only these, may be machine-translated (services/agent).
 */
export type FreeField = 'transcript' | 'description' | 'text';
export type FreeText = Partial<Record<FreeField, string>>;

const BOOKS: Readonly<Record<OtherLanguage, Phrasebook>> = { es: SPANISH };

/**
 * A wave's card is a note — a MESSAGE card — whose one sentence is Wick's
 * own (mcp-server accounts/familyTvWave.ts WAVE_CARD_PREFIX, held to this
 * by that package's coverage test). It is the phrasebook's, and never free.
 */
const WAVE_CARD_PREFIX = 'note-wave-';

/** The cards whose words are a headline and, on most, a sentence or two beneath it. */
const HEADLINE_CARDS: readonly string[] = ['SHARING', 'CIRCLE', 'TELL', 'WATCH', 'LIGHT', 'REACH', 'VISIT'];

type Fields = Record<string, unknown>;

const isFields = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
/**
 * The same for her reminder of a visit the family arranged (errand.ts
 * ERRAND_REMINDER_CARD_PREFIX, services/agent agents/errand/reminder.ts):
 * a note from them, in Wick's own sentence. Spelt here, not imported, so the
 * edge's generated copy of this directory stays this directory alone; the
 * agent's coverage test builds the reminder with errand.ts's own id and
 * fails if its sentence is not translated.
 */
const ERRAND_REMINDER_CARD_PREFIX = 'note-errand-';

const isWicksOwnNote = (card: Fields): boolean =>
  card.type === 'MESSAGE' && typeof card.id === 'string' && (card.id.startsWith(WAVE_CARD_PREFIX) || card.id.startsWith(ERRAND_REMINDER_CARD_PREFIX));

/** One of Wick's own sentences in her language — or undefined when the phrasebook does not hold it. */
export function sayIn(language: OtherLanguage, english: string): string | undefined {
  const book = Object.prototype.hasOwnProperty.call(BOOKS, language) ? BOOKS[language] : undefined;
  return book?.say(english);
}

/** The Spanish where there is one, and otherwise exactly what was there. */
const said = (language: OtherLanguage, value: unknown): unknown => (typeof value === 'string' ? (sayIn(language, value) ?? value) : value);

/** The buttons, with their labels in her language. An id is never touched: it is what a press sends back. */
function actionsIn(language: OtherLanguage, actions: unknown): unknown {
  if (!Array.isArray(actions)) return actions;
  return actions.map((action: unknown) => (isFields(action) && typeof action.label === 'string' ? { ...action, label: said(language, action.label) } : action));
}

/** The free text a card carries, by field. Empty for most cards. */
export function freeTextOf(card: Card): FreeText {
  const fields: unknown = card;
  if (!isFields(fields)) return {};
  const only = (field: FreeField): FreeText => (isText(fields[field]) ? { [field]: fields[field] } : {});
  if (fields.type === 'MESSAGE') return isWicksOwnNote(fields) ? {} : only('transcript');
  if (fields.type === 'DOOR') return only('description');
  if (fields.type === 'WEEK') return only('text');
  return {};
}

function translated(language: OtherLanguage, card: Fields, free: FreeText | undefined): Fields | undefined {
  const out: Fields = { ...card };
  /** One of Wick's own fields. */
  const wicks = (field: string): void => {
    if (typeof card[field] === 'string') out[field] = said(language, card[field]);
  };
  /** A free field: only ever the translation handed in, and only where the card has the text it translates. */
  const freely = (field: FreeField): void => {
    const translation: unknown = free?.[field];
    if (isText(translation) && isText(card[field])) out[field] = translation;
  };

  if (card.type === 'DOOR') {
    wicks('line');
    wicks('notice');
    freely('description');
  } else if (card.type === 'MESSAGE') {
    // The fixed replies, one by one. What a press sends back is still which button, and the family still reads the English.
    if (Array.isArray(card.suggestedReplies)) out.suggestedReplies = card.suggestedReplies.map((reply: unknown) => said(language, reply));
    if (isWicksOwnNote(card)) wicks('transcript');
    else freely('transcript');
  } else if (card.type === 'WEEK') {
    freely('text');
  } else if (card.type === 'PHOTO') {
    // A picture carries no words of the family's (mantel.ts): the headline and the notice are Wick's, and nothing is free.
    wicks('headline');
    wicks('notice');
  } else if (typeof card.type === 'string' && HEADLINE_CARDS.includes(card.type)) {
    wicks('headline');
    wicks('detail');
  } else {
    // The Language card is already in both languages, and a kind of card not known here is not this file's to change.
    return undefined;
  }
  if ('actions' in card) out.actions = actionsIn(language, card.actions);
  return out;
}

/**
 * A card as her television should show it. Every sentence of Wick's own
 * goes through `sayIn` and stays English where there is none; a free field
 * is replaced only by the translation handed in `free`. Ids, action ids,
 * names, times and addresses are never touched, and a LANGUAGE card is
 * returned as it is.
 */
export function cardIn(language: OtherLanguage, card: Card, free?: FreeText): Card {
  try {
    const fields: unknown = card;
    if (!isFields(fields)) return card;
    return (translated(language, fields, isFields(free) ? free : undefined) as Card | undefined) ?? card;
  } catch {
    return card;
  }
}

/** The same for a patch to a card already on her television. */
export function patchIn(language: OtherLanguage, patch: CardPatch, free?: FreeText): CardPatch {
  try {
    const fields: unknown = patch;
    if (!isFields(fields)) return patch;
    const out: Fields = { ...fields };
    for (const field of ['line', 'notice']) if (typeof fields[field] === 'string') out[field] = said(language, fields[field]);
    const description: unknown = isFields(free) ? free.description : undefined;
    if (isText(description) && isText(fields.description)) out.description = description;
    if ('actions' in fields) out.actions = actionsIn(language, fields.actions);
    return out as unknown as CardPatch;
  } catch {
    return patch;
  }
}

/** The same for what the home screen is told ("Sarah looked in this morning."). */
export function homeIn(language: OtherLanguage, home: HomeState): HomeState {
  try {
    const fields: unknown = home;
    if (!isFields(fields) || !isFields(fields.lookedIn) || typeof fields.lookedIn.line !== 'string') return home;
    return { ...fields, lookedIn: { ...fields.lookedIn, line: said(language, fields.lookedIn.line) } } as HomeState;
  } catch {
    return home;
  }
}
