/**
 * Counts, as the facts state them and as a person would say them. Shared by
 * the week's own facts (weekFacts.ts) and its comparisons (comparisons.ts).
 */

/** "1 time", "3 times" — the form the model is shown, so the number is unmistakable. */
export const times = (n: number): string => `${n} ${n === 1 ? 'time' : 'times'}`;

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

/** "once", "twice", "three times" … "13 times". */
export function spokenTimes(n: number): string {
  if (n === 1) return 'once';
  if (n === 2) return 'twice';
  return `${WORDS[n] ?? String(n)} times`;
}
