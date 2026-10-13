/**
 * Test-only: how each package proves that everything it builds for the
 * resident's television is in the phrasebook (phrasebookCoverage.test.ts,
 * one beside each set of builders).
 *
 * The rule the proof rests on is written once, here: which fields of a card
 * are Wick's own words. A coverage test runs the real builders, puts every
 * card through `cardIn`, and this says which of those fields came back
 * still in English.
 */
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import type { Card, CardPatch } from '../../card.js';

export type Builders = 'contracts' | 'agent' | 'mcp-server' | 'edge';

/**
 * Where each kind of card is built, and so where its coverage is proved.
 * Typed on the union, and checked against card.ts as it is written
 * (cardTypesInTheUnion): a card added later fails here until somebody says
 * where its words are proved.
 */
export const COVERED_IN: Readonly<Record<Card['type'], readonly Builders[]>> = {
  DOOR: ['agent', 'mcp-server'],
  MESSAGE: ['mcp-server'],
  WEEK: ['agent'],
  SHARING: ['edge'],
  CIRCLE: ['mcp-server'],
  TELL: ['agent'],
  WATCH: ['mcp-server', 'edge'],
  LIGHT: ['edge'],
  REACH: ['contracts', 'edge', 'agent', 'mcp-server'],
  VISIT: ['contracts', 'agent'],
  LANGUAGE: ['contracts'],
  // Its words are the contracts' own (mantel.ts photoCardWords, MANTEL_FULL_NOTICE). The server puts them on the card
  // (photos/send.ts), and the edge sends it back with the notice when her mantelpiece is full (mantel.mjs cardBack).
  PHOTO: ['contracts', 'mcp-server', 'edge'],
};

/** Every `type` a card can have, read out of card.ts itself: the union as it stands, not as it stood when this was written. */
export function cardTypesInTheUnion(): string[] {
  const source = readFileSync(new URL('../../card.ts', import.meta.url), 'utf8');
  const union = /export type Card =([^;]+);/.exec(source)?.[1] ?? '';
  const members = union.split('|').map((name) => name.trim()).filter(Boolean);
  return members.map((name) => new RegExp(`interface ${name} extends CardBase \\{\\s*readonly type: '([A-Z_]+)'`).exec(source)?.[1] ?? `?${name}`);
}

/** A wave's card is a note whose one sentence is Wick's own (mcp-server accounts/familyTvWave.ts). */
const isWave = (card: Card): boolean => card.type === 'MESSAGE' && card.id.startsWith('note-wave-');

/** Every field of a card that Wick itself wrote, by where it is. Free text and names are not among them. */
export function wickWords(card: Card): Record<string, string> {
  const words: Record<string, string> = {};
  // The Language card is already in both languages: none of it is the phrasebook's.
  if (card.type === 'LANGUAGE') return words;
  card.actions.forEach((action, i) => (words[`actions[${i}].label`] = action.label));
  switch (card.type) {
    case 'DOOR':
      words.line = card.line;
      if (card.notice !== undefined) words.notice = card.notice;
      break;
    case 'MESSAGE':
      card.suggestedReplies.forEach((reply, i) => (words[`suggestedReplies[${i}]`] = reply));
      if (isWave(card) && card.transcript !== undefined) words.transcript = card.transcript;
      break;
    // The week's paragraph is free text.
    case 'WEEK':
      break;
    // A picture carries no words of the family's: the headline and what is said when the mantelpiece is full are Wick's.
    case 'PHOTO':
      words.headline = card.headline;
      if (card.notice !== undefined) words.notice = card.notice;
      break;
    default:
      words.headline = card.headline;
      if (card.detail !== undefined) words.detail = card.detail;
  }
  return words;
}

/** The same for a patch to a card already on her television. */
export function wickWordsOfPatch(patch: CardPatch): Record<string, string> {
  const words: Record<string, string> = {};
  if (patch.line !== undefined) words.line = patch.line;
  if (patch.notice !== undefined) words.notice = patch.notice;
  patch.actions?.forEach((action, i) => (words[`actions[${i}].label`] = action.label));
  return words;
}

const BLANK = '…';

/** A card with Wick's words blanked: what must come through a translation exactly as it went in. */
export function withoutWords<C extends Card>(card: C): C {
  const copy = structuredClone(card) as unknown as Record<string, unknown> & { actions: { label: string }[]; suggestedReplies?: string[] };
  copy.actions.forEach((action) => (action.label = BLANK));
  for (const field of ['line', 'notice', 'headline', 'detail'] as const) if (typeof copy[field] === 'string') copy[field] = BLANK;
  if (card.type === 'MESSAGE') {
    copy.suggestedReplies = copy.suggestedReplies?.map(() => BLANK) ?? [];
    if (isWave(card) && typeof copy.transcript === 'string') copy.transcript = BLANK;
  }
  if (card.type === 'LANGUAGE') return card;
  return copy as unknown as C;
}

type CardIn = (language: 'es', card: Card) => Card;
type PatchIn = (language: 'es', patch: CardPatch) => CardPatch;

/**
 * One package's proof. `spanish(card)` is the card as her television shows
 * it, having checked that no word of Wick's is still English and that
 * nothing else moved; `missing()` is the kinds of card this package builds
 * that were never put through it.
 */
export function coverageOf(builders: Builders, translate: { readonly cardIn: CardIn; readonly patchIn?: PatchIn }) {
  const seen = new Set<Card['type']>();
  return {
    spanish<C extends Card>(card: C): C {
      const out = translate.cardIn('es', card);
      const before = wickWords(card);
      const after = wickWords(out);
      const english = Object.keys(before).filter((where) => after[where] === before[where]).map((where) => `${where}: ${before[where]}`);
      expect(english, `left in English on a ${card.type} card`).toEqual([]);
      expect(withoutWords(out as C), 'only the words may change').toEqual(withoutWords(card));
      seen.add(card.type);
      return out as C;
    },
    spanishPatch(patch: CardPatch): CardPatch {
      const out = translate.patchIn!('es', patch);
      const before = wickWordsOfPatch(patch);
      const after = wickWordsOfPatch(out);
      const english = Object.keys(before).filter((where) => after[where] === before[where]).map((where) => `${where}: ${before[where]}`);
      expect(english, 'left in English on a patch').toEqual([]);
      // A patch is only ever to a door card (card.ts CardPatch).
      seen.add('DOOR');
      expect({ ...out, line: undefined, notice: undefined, actions: out.actions?.map((a) => ({ ...a, label: BLANK })) }).toEqual({
        ...patch,
        line: undefined,
        notice: undefined,
        actions: patch.actions?.map((a) => ({ ...a, label: BLANK })),
      });
      return out;
    },
    missing(): string[] {
      return (Object.keys(COVERED_IN) as Card['type'][]).filter((type) => COVERED_IN[type].includes(builders) && !seen.has(type));
    },
  };
}
