import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LANGUAGE,
  HOUSEHOLD_LANGUAGE_ATTRS,
  LANGUAGES,
  LANGUAGE_ASK_AFTER_TAKING_BACK_MS,
  LANGUAGE_ASK_AGAIN_AFTER_MS,
  LANGUAGE_ACTIONS,
  MAX_CARD_ACTIONS,
  MAX_CARD_DETAIL_CHARS,
  isHouseholdLanguage,
  languageCardId,
  languageOfCardId,
  languageQuestion,
  readHomeState,
} from '../index.js';

describe('the language a household’s television speaks', () => {
  it('is English unless she has said otherwise, and Spanish is the first other', () => {
    expect(LANGUAGES).toEqual(['en', 'es']);
    expect(DEFAULT_LANGUAGE).toBe('en');
    expect(isHouseholdLanguage('es')).toBe(true);
    for (const not of ['fr', 'ES', '', undefined, 7, null]) expect(isHouseholdLanguage(not)).toBe(false);
  });

  it('names the question’s card by the language asked for, so the press says which without the television holding anything', () => {
    expect(languageCardId('es')).toBe('language-es');
    expect(languageOfCardId('language-es')).toBe('es');
    expect(languageOfCardId('language-en')).toBe('en');
    for (const not of ['language-fr', 'language-', 'circle-es', 'language-es-2', 7, undefined]) expect(languageOfCardId(not)).toBeUndefined();
  });

  it('is asked in both languages at once: she may read only one of them, and it is hers to answer', () => {
    const toSpanish = languageQuestion('es', 'Sarah');
    expect(toSpanish.headline).toBe('¿Quiere que Wick le hable en español?');
    expect(toSpanish.detail).toContain('Sarah');
    expect(toSpanish.detail).toMatch(/Spanish/);
    expect(toSpanish.detail).toMatch(/español/);
    expect(toSpanish.actions).toEqual([
      { id: LANGUAGE_ACTIONS.yes, label: 'Sí, en español', kind: 'primary' },
      { id: LANGUAGE_ACTIONS.no, label: 'No, keep English', kind: 'secondary' },
    ]);

    const back = languageQuestion('en', 'Sarah');
    expect(back.headline).toBe('Shall Wick speak English again?');
    expect(back.detail).toMatch(/inglés/);
    expect(back.actions.map((a) => a.label)).toEqual(['Yes, in English', 'No, seguir en español']);
  });

  it('never outgrows a card, whoever asks — a very long name is cut, not the sentence', () => {
    for (const language of LANGUAGES) {
      const long = languageQuestion(language, 'someone.with.no.name.known.only.by.an.address@example.org');
      expect(long.detail.length).toBeLessThanOrEqual(MAX_CARD_DETAIL_CHARS);
      expect(long.detail).toContain('someone.with.no.name.kn…');
      expect(long.detail).toMatch(/say yes\.|dice que sí\./);
      const q = languageQuestion(language, 'Bartholomew-Alexander');
      expect(q.detail).toContain('Bartholomew-Alexander ');
      expect(q.detail.length).toBeLessThanOrEqual(MAX_CARD_DETAIL_CHARS);
      expect(q.actions.length).toBeLessThanOrEqual(MAX_CARD_ACTIONS);
    }
  });
});

describe('the home screen is told the language beside the light', () => {
  it('carries it when it is not English, and through the bus between the edge and the agent plane', () => {
    expect(readHomeState({ light: 'on', language: 'es' })).toEqual({ light: 'on', language: 'es' });
    expect(readHomeState({ language: 'es' })).toEqual({ language: 'es' });
  });

  it('says nothing for English — the default needs no telling — and drops anything that is not a language', () => {
    expect(readHomeState({ light: 'on', language: 'en' })).toEqual({ light: 'on' });
    expect(readHomeState({ light: 'on', language: 'fr' })).toEqual({ light: 'on' });
    expect(readHomeState({ light: 'on', language: 7 })).toEqual({ light: 'on' });
  });
});

describe('a question the organiser takes back', () => {
  it('is kept beside the language too, so taking it back and asking again is not a way to put it to her over and over', () => {
    expect(HOUSEHOLD_LANGUAGE_ATTRS.takenBack).toBe('languageTakenBack');
    expect(HOUSEHOLD_LANGUAGE_ATTRS.takenBackAt).toBe('languageTakenBackAt');
    expect(LANGUAGE_ASK_AFTER_TAKING_BACK_MS).toBe(24 * 60 * 60_000);
  });
});

describe('her no is an answer', () => {
  it('is kept beside the language, so the same question is not put to her again within a week', () => {
    expect(HOUSEHOLD_LANGUAGE_ATTRS.declined).toBe('languageDeclined');
    expect(HOUSEHOLD_LANGUAGE_ATTRS.declinedAt).toBe('languageDeclinedAt');
    expect(LANGUAGE_ASK_AGAIN_AFTER_MS).toBe(7 * 24 * 60 * 60_000);
  });
});

