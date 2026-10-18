import { describe, expect, it } from 'vitest';
import { MAX_CARD_SHOWS, NOTE_ACTIONS, type Card, type QueuedCard } from '@wick/contracts';
import { BreakController } from '../../break/BreakController.js';
import { SETTLED_AFTER_MS } from '../../break/types.js';
import { backClosesOpened, backOnShownCard, putAway, putsAway, waitingLine } from '../waiting.js';

const base = { id: 'c1', householdId: 'hh-1', correlationId: 'c', createdAt: 0, actions: [] } as const;
const queued = (card: Card): QueuedCard => ({ id: card.id, urgency: 'DEFERRED', card, queuedAt: 0, shownCount: 2 });

describe('waitingLine — what the home screen says is waiting', () => {
  it('names who a note is from', () => {
    expect(waitingLine(queued({ ...base, type: 'MESSAGE', fromName: 'Sarah', suggestedReplies: [] }))).toBe('A note from Sarah is waiting.');
  });

  it('says the week is ready', () => {
    expect(waitingLine(queued({ ...base, type: 'WEEK', isoWeek: '2026-W41', text: 'A quiet week.' }))).toBe('Your week is ready to read.');
  });

  it('names who would like to join', () => {
    const circle: Card = { ...base, type: 'CIRCLE', personName: 'Tom', role: 'family', headline: 'h', detail: 'd' } as Card;

    expect(waitingLine(queued(circle))).toBe('Tom would like to join your family circle.');
  });

  it('says there is a question waiting, without saying what it is about', () => {
    const tell: Card = { ...base, type: 'TELL', headline: 'Shall I tell Sarah?', detail: 'Maria usually comes on Friday mornings.' };

    expect(waitingLine(queued(tell))).toBe('Wick has a question for you.');
  });

  it('says what a watch-together card says: the server wrote the line', () => {
    const watch: Card = { ...base, type: 'WATCH', sessionId: 's-1', withName: 'Sarah', headline: 'Sarah would like to watch a film with you.' } as Card;

    expect(waitingLine(queued(watch))).toBe('Sarah would like to watch a film with you.');
  });
});

describe('backClosesOpened — Back on a waiting card the resident opened', () => {
  it('puts the card back to waiting: Back is not an answer, and must not leave Wick', () => {
    expect(backClosesOpened({ openedId: 'note-1', shownId: 'note-1', liveOpen: false })).toBe(true);
  });

  it('is not for a card that came on screen by itself: nothing was opened', () => {
    expect(backClosesOpened({ openedId: null, shownId: 'note-1', liveOpen: false })).toBe(false);
    expect(backClosesOpened({ openedId: null, shownId: null, liveOpen: false })).toBe(false);
  });

  it('leaves Back alone while the door is in front of the opened card', () => {
    expect(backClosesOpened({ openedId: 'note-1', shownId: 'door-9', liveOpen: false })).toBe(false);
    expect(backClosesOpened({ openedId: 'note-1', shownId: 'note-1', liveOpen: true })).toBe(false);
  });
});

describe('waitingLine — in the language she chose', () => {
  const circle = { ...base, type: 'CIRCLE', personName: 'Tom', role: 'family', headline: 'h', detail: 'd' } as Card;
  const sharing = { ...base, type: 'SHARING', factClass: 'DOOR_EVENT', page: 0, pages: 4, headline: 'h', detail: 'd' } as Card;
  const tell: Card = { ...base, type: 'TELL', headline: '¿Se lo digo a Sarah?', detail: 'd' };
  const visit = { ...base, type: 'VISIT', headline: '¿Es correcto?', detail: 'd' } as Card;

  it('says its own sentences in Spanish', () => {
    expect(waitingLine(queued({ ...base, type: 'MESSAGE', fromName: 'Sarah', suggestedReplies: [] }), 'es')).toBe('Hay una nota de Sarah esperando.');
    expect(waitingLine(queued({ ...base, type: 'WEEK', isoWeek: '2026-W41', text: 'Una semana tranquila.' }), 'es')).toBe('Su semana está lista para leer.');
    expect(waitingLine(queued(circle), 'es')).toBe('Tom quiere unirse a su círculo familiar.');
    expect(waitingLine(queued(sharing), 'es')).toBe('Ya puede revisar lo que ve su familia.');
  });

  it('still does not say what a question is about', () => {
    expect(waitingLine(queued(tell), 'es')).toBe('Wick tiene una pregunta para usted.');
    expect(waitingLine(queued(visit), 'es')).toBe('Wick tiene una pregunta para usted.');
  });

  it('says a card’s own line as the server wrote it, whatever the language: it came in hers', () => {
    const watch = { ...base, type: 'WATCH', sessionId: 's-1', withName: 'Sarah', headline: 'Sarah quiere ver una película con usted.' } as Card;

    expect(waitingLine(queued(watch), 'es')).toBe('Sarah quiere ver una película con usted.');
  });

  it('says something for a card it has no line for', () => {
    const unknown = { ...base, type: 'SOMETHING_NEW' } as unknown as Card;

    expect(waitingLine(queued(unknown))).toBe('Something is waiting for you.');
    expect(waitingLine(queued(unknown), 'es')).toBe('Algo le está esperando.');
  });
});

describe('waitingLine — the question that asks which language', () => {
  const language = (asked: 'en' | 'es', headline: string): Card =>
    ({ ...base, id: `language-${asked}`, type: 'LANGUAGE', language: asked, headline, detail: 'd' }) as Card;

  it('is said in the language asked for, whichever the television speaks now: it may be the only one she reads', () => {
    const toSpanish = language('es', '¿Quiere que Wick le hable en español?');
    const toEnglish = language('en', 'Shall Wick speak English again?');

    expect(waitingLine(queued(toSpanish))).toBe('¿Quiere que Wick le hable en español?');
    expect(waitingLine(queued(toSpanish), 'en')).toBe('¿Quiere que Wick le hable en español?');
    expect(waitingLine(queued(toEnglish), 'es')).toBe('Shall Wick speak English again?');
  });
});

describe('waitingLine — a picture that has waited through two breaks', () => {
  const photo = { ...base, id: 'photo-p1', type: 'PHOTO', photoId: 'p1', fromName: 'Sarah', headline: 'A picture from Sarah.' } as Card;

  it('says who it is from, in her language — and nothing of the picture', () => {
    expect(waitingLine(queued(photo))).toBe('A picture from Sarah is waiting.');
    expect(waitingLine(queued(photo), 'es')).toBe('Hay una foto de Sarah esperando.');
  });
});

describe('backOnShownCard — Back on a card that came to her, during a film or on the home screen', () => {
  const card = (actions: { id: string; kind: 'primary' | 'secondary' | 'dismiss' }[]) =>
    ({ type: 'DOOR', id: 'door-1', householdId: 'hh', correlationId: 'c', createdAt: 0, actions: actions.map((a) => ({ ...a, label: a.id })) }) as never;

  it("is the card's own 'Not now': Back puts it away as that button does, and never ends her film", () => {
    expect(backOnShownCard(card([{ id: 'ask', kind: 'primary' }, { id: 'not-now', kind: 'dismiss' }]))).toBe('not-now');
  });

  it('does nothing on a card without one: Back is taken, so it cannot reach the film or leave Wick', () => {
    expect(backOnShownCard(card([{ id: 'yes', kind: 'primary' }]))).toBeUndefined();
    expect(backOnShownCard(undefined)).toBeUndefined();
  });

  it("is a note's own \"later\": a note has no Not now button, and Back must not be a reply", () => {
    const note: Card = { ...base, type: 'MESSAGE', fromName: 'Sarah', suggestedReplies: ['Thank you!', 'Not right now.'] };

    expect(backOnShownCard(note)).toBe(NOTE_ACTIONS.later);
  });
});

describe('putAway — a note she said "later" to', () => {
  const note: QueuedCard = { ...queued({ ...base, type: 'MESSAGE', fromName: 'Sarah', suggestedReplies: [] }), shownCount: 0 };

  it('is never brought to her again by itself, and waits on the home screen at once', () => {
    const breaks = new BreakController();
    breaks.setForeground(true, 0);
    const now = SETTLED_AFTER_MS + 1_000;
    expect(breaks.pickCard([note], now)?.id).toBe('c1');

    const away = [putAway(note)];

    expect(breaks.pickCard(away, now)).toBeUndefined();
    expect(breaks.pickCard(away, now + 60 * 60 * 1000)).toBeUndefined();
    expect(breaks.waiting(away, now)?.id).toBe('c1');
  });

  it('is only the count of its showings: the note itself is the one that came', () => {
    const away = putAway(note);

    expect(away.shownCount).toBe(MAX_CARD_SHOWS);
    expect({ ...away, shownCount: 0 }).toEqual(note);
  });

  it('is said of a note, and of Back on it, and of nothing else', () => {
    expect(putsAway(note.card, NOTE_ACTIONS.later)).toBe(true);
    expect(putsAway(note.card, 'reply_2')).toBe(false);
    expect(putsAway({ ...base, type: 'WEEK', isoWeek: '2026-W41', text: 'A quiet week.' }, NOTE_ACTIONS.later)).toBe(false);
  });
});
