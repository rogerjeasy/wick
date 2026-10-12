/**
 * Whether a model's sentence about a calm point may go on the break map.
 *
 * The model is asked to fill a form — "From <the first frame> to <the
 * second>." — and this is what holds it to that when it does not. A
 * validator, not only a prompt: a prompt is a request (the same reasoning
 * as the door's description, services/agent door/index.ts).
 *
 * Pure. A sentence that fails is simply not shown: the page has the two
 * frames, and they say it anyway.
 */
export const MAX_SENTENCE_WORDS = 18;

/** Words that mark a guess about feeling, intent or likelihood rather than something in the frame. */
const GUESSES = [
  'seems', 'seem', 'appears', 'appear', 'probably', 'possibly', 'maybe', 'might', 'likely', 'apparently',
  'presumably', 'trying', 'wants', 'intends', 'afraid', 'angry', 'happy', 'sad', 'nervous', 'calm moment',
];

export function fitToShow(sentence: string): boolean {
  const text = sentence.trim();
  if (!/^From .+ to .+\.$/.test(text)) return false;
  // One sentence: no full stop, question or exclamation mark before the last character.
  if (/[.!?]/.test(text.slice(0, -1))) return false;
  if (text.split(/\s+/).length > MAX_SENTENCE_WORDS) return false;
  const lower = text.toLowerCase();
  return !GUESSES.some((word) => new RegExp(`\\b${word}\\b`).test(lower));
}
