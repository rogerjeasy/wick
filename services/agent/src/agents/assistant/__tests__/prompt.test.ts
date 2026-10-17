import { describe, expect, it } from 'vitest';
import { assistantPrompt, localWhen, systemPrompt, todayLine, type Who } from '../prompt.js';

const WHO: Who = { memberName: 'Sarah', residentName: 'Margaret', householdName: 'Mum’s house', simulated: false };
// Tuesday 13 October 2026, 12:00 UTC — 13:00 in London.
const NOW = new Date(Date.UTC(2026, 9, 13, 12));
const TZ = 'Europe/London';

describe('the assistant’s rules, one set for both assistants', () => {
  it('keeps the rule the Narrator lives by: no fact the tools did not return', () => {
    const prompt = assistantPrompt(WHO, NOW, TZ);

    expect(prompt).toMatch(/You know nothing about the house except what Wick's tools return/);
    expect(prompt).toMatch(/Never guess, estimate, or add anything the tools did not return/);
    expect(prompt).toMatch(/Use every number, date and time exactly as the results give it/);
  });

  it('asks for a day or a time that is missing, and never guesses one', () => {
    expect(assistantPrompt(WHO, NOW, TZ)).toMatch(/If a day or the time is missing, ask for it; never guess one/);
  });

  it('names the films, with their lengths, when it asks which one: the number check knows the catalogue (brain.ts)', () => {
    expect(assistantPrompt(WHO, NOW, TZ)).toMatch(/The films are Big Buck Bunny \(10 minutes\), Sintel \(15 minutes\) and Tears of Steel \(12 minutes\)\./);
  });

  it('works a relative time out from now, instead of asking for one it was given', () => {
    // Live, "the window cleaner is coming in five minutes" was answered with "what day, and what time exactly?".
    expect(assistantPrompt(WHO, NOW, TZ)).toMatch(/"in five minutes".*are a day and a time: work them out from now/);
  });

  it('arranges a visit with arrange_visit and send_note_to_tv', () => {
    const prompt = assistantPrompt(WHO, NOW, TZ);

    expect(prompt).toMatch(/To arrange a visit .*call arrange_visit and send_note_to_tv/);
    expect(prompt).toMatch(/get_errands/);
    expect(prompt).toMatch(/cancel_errand/);
  });

  it('says every change waits for the member’s yes in the app, and a no is final', () => {
    const prompt = assistantPrompt(WHO, NOW, TZ);

    expect(prompt).toMatch(/Nothing that changes anything happens until Sarah says yes in the app/);
    expect(prompt).toMatch(/if a result says they chose not to, accept that and do not try again/);
  });

  it('treats what it remembers as the member’s own words, never as facts about the resident', () => {
    const prompt = assistantPrompt(WHO, NOW, TZ);

    expect(prompt).toMatch(/what Sarah told you before/);
    expect(prompt).toMatch(/never a fact about Margaret/);
  });

  it('is the stand-in assistant’s prompt with the agent’s rules added — the same day, the same names', () => {
    const shared = systemPrompt(WHO, NOW, TZ);
    const agent = assistantPrompt(WHO, NOW, TZ);

    for (const line of shared.split('\n')) expect(agent).toContain(line);
    expect(shared).not.toMatch(/arrange_visit/);
  });

  it('says what day it is where the house is, in both clocks', () => {
    expect(todayLine(NOW, TZ)).toBe(
      'Now it is Tuesday 13 October 2026, 13:00 (1pm) where the house is (Europe/London); today\'s date is 2026-10-13, and the current ISO week is 2026-W42.',
    );
    expect(localWhen(Date.UTC(2026, 9, 17, 14), TZ)).toBe('Saturday 17 October 2026, 15:00 (3pm)');
  });
});
