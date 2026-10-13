/**
 * Read to me — a card read aloud, when she asks.
 *
 * Not everyone who watches television can read one from across the room.
 * While a card is on her screen, the Play key on the remote asks for it to
 * be read: the television sends `{t:'read', cardId}`, and the edge answers
 * that one television with a short-lived address of the reading
 * (`{t:'speech', cardId, url}`), which it plays beside the held film.
 *
 * What is read is the card as her television shows it — in her language
 * (language.ts), its sentences in order and then what she can press — and
 * nothing that is not on the screen: no address, no id, no time, no name of
 * a file. `speechTextOf` is that reading, pure, so it is tested without a
 * voice.
 *
 * THE RULES.
 *   - Only when she asks. Wick never speaks by itself: a card that read
 *     itself aloud would be the beep the product promises not to make.
 *   - A fourth button would break "three, never four", so it is a key, said
 *     on the card in one short line.
 *   - The reading is made by Amazon Polly from the words already bound for
 *     her screen, kept a day as `tts/<household>/<hash>.mp3` so the same
 *     card read twice is made once, and its address is answered only to the
 *     television that asked — never across the bus, never into a row or a
 *     log (the same exception as the mantelpiece's, INV-2).
 *   - Nothing about the reading reaches the family: not that she asked, not
 *     how often.
 */
import type { Card } from './card.js';
import type { HouseholdLanguage } from './language.js';

/** The longest reading, in characters: about forty seconds of speech. It stops on a whole sentence. */
export const MAX_SPEECH_CHARS = 600;

/** How long the address of a reading is good for: long enough to play it, and no longer. */
export const SPEECH_URL_TTL_SEC = 300;

/** One neural voice for each language her television can speak. */
export const SPEECH_VOICES: Readonly<Record<HouseholdLanguage, { readonly voiceId: string; readonly languageCode: string }>> = {
  en: { voiceId: 'Amy', languageCode: 'en-GB' },
  es: { voiceId: 'Lupe', languageCode: 'es-US' },
};

const HASH = /^[0-9a-f]{64}$/;

/** Where a reading is kept. `hash` names what was said and in which voice (SHA-256, hex). */
export function speechObjectKey(householdId: string, hash: string): string {
  if (!HASH.test(hash)) throw new Error('speech_hash_malformed');
  return `tts/${householdId}/${hash}.mp3`;
}

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** A button's words, ended like a sentence so the voice pauses after them. */
const spoken = (label: string): string => (/[.!?…]$/.test(label.trim()) ? label.trim() : `${label.trim()}.`);

/** The card's own sentences, in the order they are on the screen. */
function body(card: Card): string[] {
  switch (card.type) {
    case 'DOOR':
      return [card.line, card.description, card.notice].filter(text);
    case 'MESSAGE':
      return [text(card.fromName) ? spoken(card.fromName) : undefined, card.transcript].filter(text);
    case 'WEEK':
      return [card.text].filter(text);
    case 'PHOTO':
      return [card.headline, card.notice].filter(text);
    case 'SHARING':
    case 'CIRCLE':
    case 'TELL':
    case 'WATCH':
    case 'LIGHT':
    case 'REACH':
    case 'VISIT':
    case 'LANGUAGE':
      return [card.headline, card.detail].filter(text);
    default:
      return [];
  }
}

/** What she can press, as it is written on the buttons. */
function choices(card: Card): string[] {
  const labels = card.type === 'MESSAGE' ? card.suggestedReplies : card.actions.map((action) => action.label);
  return labels.filter(text).map(spoken);
}

/** As much of `passage` as fits in `room`, ending on a whole sentence — or nothing. */
function fitted(passage: string, room: number): string {
  if (passage.length <= room) return passage;
  const sentences = passage.match(/[^.!?…]+[.!?…]+(\s+|$)/g);
  if (!sentences) return '';
  let kept = '';
  for (const sentence of sentences) {
    if ((kept + sentence).trimEnd().length > room) break;
    kept += sentence;
  }
  return kept.trimEnd();
}

/**
 * What is read aloud for a card: each passage, in order. The buttons are
 * always read whole — they are what she is being asked — so it is the
 * sentences before them that give way when a card is long.
 */
export function speechTextOf(card: Card): string[] {
  const pressed = choices(card);
  let room = MAX_SPEECH_CHARS - pressed.reduce((sum, label) => sum + label.length + 1, 0);
  const said: string[] = [];
  for (const passage of body(card)) {
    const fits = fitted(passage.trim(), room - (said.length ? 1 : 0));
    if (!fits) break;
    said.push(fits);
    room -= fits.length + 1;
    if (fits.length < passage.trim().length) break;
  }
  return said.length || pressed.length ? [...said, ...pressed] : [];
}
