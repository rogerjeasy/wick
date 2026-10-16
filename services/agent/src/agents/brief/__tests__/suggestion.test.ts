import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '@wick/policy';
import { NO_SUGGESTION, allowedActions, judgeSuggestion, suggestionSchema } from '../suggestion.js';

const quiet = { missedUsualVisit: false, watchedFilms: false };
const anyText = () => true;

describe('allowedActions — what code allows the suggester to choose this week', () => {
  it('always allows a note or nothing', () => {
    expect(allowedActions(quiet)).toEqual(['send_note', 'nothing']);
  });

  it('allows arranging a visit only when a usual visit was missed, and watching together only when she watched films', () => {
    expect(allowedActions({ missedUsualVisit: true, watchedFilms: false })).toEqual(['send_note', 'arrange_visit', 'nothing']);
    expect(allowedActions({ missedUsualVisit: false, watchedFilms: true })).toEqual(['send_note', 'watch_together', 'nothing']);
  });
});

describe('judgeSuggestion — the suggester’s answer, checked by code', () => {
  it('keeps a suggestion the week allows, its reason trimmed', () => {
    expect(judgeSuggestion({ action: 'send_note', reason: ' A quiet week: a note would be nice. ' }, quiet, DEFAULT_POLICY, anyText)).toEqual({
      ok: true,
      suggestion: { action: 'send_note', reason: 'A quiet week: a note would be nice.' },
    });
  });

  it('refuses arranging a visit when no usual visit was missed', () => {
    const verdict = judgeSuggestion({ action: 'arrange_visit', reason: 'Maria did not come.' }, quiet, DEFAULT_POLICY, anyText);
    expect(verdict).toEqual({ ok: false, why: 'action_not_allowed' });
  });

  it('refuses watching together when she watched no films that week', () => {
    expect(judgeSuggestion({ action: 'watch_together', reason: 'She likes films.' }, quiet, DEFAULT_POLICY, anyText)).toEqual({ ok: false, why: 'action_not_allowed' });
    expect(judgeSuggestion({ action: 'watch_together', reason: 'A film was played this week.' }, { ...quiet, watchedFilms: true }, DEFAULT_POLICY, anyText).ok).toBe(true);
  });

  it('refuses what is not a suggestion at all: an action off the menu, no reason, or one too long for the card', () => {
    expect(judgeSuggestion({ action: 'phone_her', reason: 'x' }, quiet, DEFAULT_POLICY, anyText)).toEqual({ ok: false, why: 'not_a_suggestion' });
    expect(judgeSuggestion({ action: 'send_note', reason: '   ' }, quiet, DEFAULT_POLICY, anyText)).toEqual({ ok: false, why: 'not_a_suggestion' });
    expect(judgeSuggestion({ action: 'send_note', reason: 'x'.repeat(141) }, quiet, DEFAULT_POLICY, anyText)).toEqual({ ok: false, why: 'not_a_suggestion' });
    expect(judgeSuggestion(undefined, quiet, DEFAULT_POLICY, anyText)).toEqual({ ok: false, why: 'not_a_suggestion' });
  });

  it('refuses a reason the Guardian will not let the family read', () => {
    const verdict = judgeSuggestion({ action: 'send_note', reason: 'Ask whether the doctor changed her medication.' }, quiet, DEFAULT_POLICY, anyText);
    expect(verdict).toEqual({ ok: false, why: 'guardian' });
  });

  it('refuses a reason the week’s own number check refuses', () => {
    const verdict = judgeSuggestion({ action: 'send_note', reason: 'Nine people came.' }, quiet, DEFAULT_POLICY, () => false);
    expect(verdict).toEqual({ ok: false, why: 'unsupported' });
  });
});

describe('NO_SUGGESTION — what an invalid suggestion becomes', () => {
  it('is “nothing”, in words that claim nothing about the week', () => {
    expect(NO_SUGGESTION.action).toBe('nothing');
    expect(NO_SUGGESTION.reason).toBe('Nothing to suggest this week.');
  });
});

describe('suggestionSchema — the structured output the suggester must give', () => {
  it('accepts one action from the menu and a short reason, and nothing else', () => {
    expect(suggestionSchema.safeParse({ action: 'nothing', reason: 'A usual week.' }).success).toBe(true);
    expect(suggestionSchema.safeParse({ action: 'call_her', reason: 'x' }).success).toBe(false);
    expect(suggestionSchema.safeParse({ action: 'send_note', reason: 'x'.repeat(141) }).success).toBe(false);
    expect(suggestionSchema.safeParse({ action: 'send_note' }).success).toBe(false);
  });
});
