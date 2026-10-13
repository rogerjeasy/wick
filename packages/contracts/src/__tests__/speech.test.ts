import { describe, expect, it } from 'vitest';
import {
  MAX_SPEECH_CHARS,
  SPEECH_URL_TTL_SEC,
  SPEECH_VOICES,
  speechObjectKey,
  speechTextOf,
  type Card,
} from '../index.js';

const base = { id: 'c1', householdId: 'hh_1', correlationId: 'x', createdAt: 1 };

describe('what is read aloud when she asks to hear a card', () => {
  it('is the card as it is on her screen: its sentences in order, then what she can press', () => {
    const card: Card = {
      ...base,
      type: 'TELL',
      headline: 'Shall I tell Sarah?',
      detail: 'Maria usually comes on Friday mornings. There was no visit on Friday.',
      actions: [
        { id: 'tell', label: 'Tell Sarah', kind: 'primary' },
        { id: 'keep', label: 'Keep it to myself', kind: 'secondary' },
      ],
    };
    expect(speechTextOf(card)).toEqual([
      'Shall I tell Sarah?',
      'Maria usually comes on Friday mornings. There was no visit on Friday.',
      'Tell Sarah.',
      'Keep it to myself.',
    ]);
  });

  it('reads a note’s words and its replies, the door’s line and what it sees, and the week’s paragraph', () => {
    const note: Card = { ...base, type: 'MESSAGE', actions: [], fromName: 'Sarah', transcript: 'I will ring you at six.', suggestedReplies: ['Thank you!', 'Not right now.'] };
    expect(speechTextOf(note)).toEqual(['Sarah.', 'I will ring you at six.', 'Thank you!', 'Not right now.']);

    const door: Card = { ...base, type: 'DOOR', actions: [{ id: 'live', label: 'Watch live', kind: 'primary' }], line: "Someone's at the front door.", description: 'A woman in a blue coat with a parcel.', notice: 'The hallway chime has rung.' };
    expect(speechTextOf(door)).toEqual(["Someone's at the front door.", 'A woman in a blue coat with a parcel.', 'The hallway chime has rung.', 'Watch live.']);

    const week: Card = { ...base, type: 'WEEK', actions: [{ id: 'ok', label: 'OK', kind: 'primary' }], isoWeek: '2026-W41', text: 'A quiet week.' };
    expect(speechTextOf(week)).toEqual(['A quiet week.', 'OK.']);
  });

  it('never reads an address, an id or a time, and ends a button’s words like a sentence only when they are not one already', () => {
    const photo: Card = { ...base, type: 'PHOTO', photoId: 'p_1', fromName: 'Sarah', headline: 'A picture from Sarah.', photoUrl: 'https://photos.example/p_1.jpg?sig=abc', actions: [{ id: 'keep', label: 'Keep it', kind: 'primary' }, { id: 'thanks', label: 'Thank you', kind: 'secondary' }] };
    const said = speechTextOf(photo);
    expect(said).toEqual(['A picture from Sarah.', 'Keep it.', 'Thank you.']);
    expect(said.join(' ')).not.toMatch(/https|p_1|sig/);
  });

  it('stops at a length a person would sit through, on a whole sentence', () => {
    const long: Card = { ...base, type: 'WEEK', actions: [], isoWeek: '2026-W41', text: Array.from({ length: 80 }, (_, i) => `Sentence number ${i}.`).join(' ') };
    const said = speechTextOf(long).join(' ');
    expect(said.length).toBeLessThanOrEqual(MAX_SPEECH_CHARS);
    expect(said.endsWith('.')).toBe(true);
  });

  it('has nothing to read on a card with no words', () => {
    expect(speechTextOf({ ...base, type: 'WEEK', actions: [], isoWeek: '2026-W41', text: '' })).toEqual([]);
  });
});

describe('the voice, and where a reading is kept', () => {
  it('has one neural voice for each language her television can speak', () => {
    expect(SPEECH_VOICES).toEqual({ en: { voiceId: 'Amy', languageCode: 'en-GB' }, es: { voiceId: 'Lupe', languageCode: 'es-US' } });
  });

  it('keeps a reading under its household, named by what was said and in which voice — so the same card read twice is made once', () => {
    expect(speechObjectKey('hh_1', 'a'.repeat(64))).toBe(`tts/hh_1/${'a'.repeat(64)}.mp3`);
    expect(() => speechObjectKey('hh_1', '../x')).toThrow();
    expect(SPEECH_URL_TTL_SEC).toBe(300);
  });
});
