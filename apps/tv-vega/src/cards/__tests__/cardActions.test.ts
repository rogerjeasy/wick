import { describe, it, expect } from 'vitest';
import type { Card } from '@wick/contracts';
import { opensLiveView, removesCard, startsFilm } from '../cardActions.js';

const door = { type: 'DOOR', id: 'd', householdId: 'h', correlationId: 'c', createdAt: 0, line: 'x', actions: [] } as Card;
const week = { type: 'WEEK', id: 'week-2026-W40', householdId: 'h', correlationId: 'c', createdAt: 0, isoWeek: '2026-W40', text: 't', actions: [] } as Card;
const sharing = {
  type: 'SHARING', id: 'sharing', householdId: 'h', correlationId: 'c', createdAt: 0, actions: [],
  factClass: 'DOOR_EVENT', page: 0, pages: 4, headline: 'h', detail: 'd',
} as Card;

const circle = {
  type: 'CIRCLE', id: 'circle-u_sarah', householdId: 'h', correlationId: 'c', createdAt: 0, actions: [],
  personName: 'Sarah', role: 'organiser', headline: 'h', detail: 'd',
} as Card;

describe('removesCard', () => {
  it('removes the Circle card on either answer: the resident is asked once', () => {
    expect(removesCard(circle, 'allow')).toBe(true);
    expect(removesCard(circle, 'decline')).toBe(true);
  });

  it('keeps a door card on screen while the chime answer is on its way', () => {
    expect(removesCard(door, 'hallway_chime')).toBe(false);
  });

  it('keeps a door card under the live view, so Back returns to it', () => {
    expect(removesCard(door, 'watch_live')).toBe(false);
  });

  it('removes a door card on Not now', () => {
    expect(removesCard(door, 'dismiss')).toBe(true);
  });

  it('removes the Week card on OK', () => {
    expect(removesCard(week, 'seen')).toBe(true);
  });

  it('keeps the Week card behind "What Sarah sees", so Done returns to it', () => {
    expect(removesCard(week, 'sharing')).toBe(false);
  });

  it('keeps the sharing card through its toggle and Next — the server replaces it in place — and removes it on Done', () => {
    expect(removesCard(sharing, 'toggle')).toBe(false);
    expect(removesCard(sharing, 'next')).toBe(false);
    expect(removesCard(sharing, 'done')).toBe(true);
  });
});

describe('opensLiveView', () => {
  it('is only the door card\'s Watch live', () => {
    expect(opensLiveView(door, 'watch_live')).toBe(true);
    expect(opensLiveView(door, 'hallway_chime')).toBe(false);
    expect(opensLiveView(week, 'watch_live')).toBe(false);
  });
});

describe('startsFilm — the one press that opens a film to watch together', () => {
  const NOW = 1_790_900_000_000;
  const watch = (over: Record<string, unknown> = {}): Card => ({
    type: 'WATCH', id: 'watch-ready-s-1', householdId: 'h', correlationId: 'c', createdAt: 0, actions: [],
    sessionId: 's-1', withName: 'Sarah', headline: 'Sarah is ready to watch Sintel with you.',
    programmeId: 'sintel', followedUntil: NOW + 60_000, ...over,
  }) as Card;

  it('opens the film the card names, with the person who is following it', () => {
    expect(startsFilm(watch(), 'start', NOW)).toEqual({
      programmeId: 'sintel',
      together: { sessionId: 's-1', programmeId: 'sintel', withName: 'Sarah', until: NOW + 60_000 },
    });
  });

  it('opens the film for her alone once nobody is following any more', () => {
    expect(startsFilm(watch(), 'start', NOW + 60_000)).toEqual({ programmeId: 'sintel' });
    expect(startsFilm(watch({ followedUntil: undefined }), 'start', NOW)).toEqual({ programmeId: 'sintel' });
  });

  it('is only that button, on a card that names a film', () => {
    expect(startsFilm(watch(), 'not_now', NOW)).toBeUndefined();
    expect(startsFilm(watch({ programmeId: undefined }), 'start', NOW)).toBeUndefined();
    // The invitation says yes or no. It starts nothing, whatever it is sent with.
    expect(startsFilm(watch({ id: 'watch-invite-s-1' }), 'accept', NOW)).toBeUndefined();
    expect(startsFilm(door, 'start', NOW)).toBeUndefined();
  });

  it('finishes every watch card on any press: each is answered once', () => {
    for (const action of ['accept', 'decline', 'start', 'not_now', 'loved_it', 'ok']) expect(removesCard(watch(), action)).toBe(true);
  });
});

describe('the question about her language (packages/contracts language.ts)', () => {
  const language = {
    type: 'LANGUAGE', id: 'language-es', householdId: 'h', correlationId: 'c', createdAt: 0, language: 'es',
    headline: '¿Quiere que Wick le hable en español?', detail: 'd',
    actions: [
      { id: 'yes', label: 'Sí, en español', kind: 'primary' },
      { id: 'no', label: 'No, keep English', kind: 'secondary' },
    ],
  } as Card;

  it('is finished by either answer: she is asked once, and the server keeps what she said', () => {
    expect(removesCard(language, 'yes')).toBe(true);
    expect(removesCard(language, 'no')).toBe(true);
  });

  it('opens nothing: no door camera, no film', () => {
    for (const action of ['yes', 'no', 'watch_live', 'start']) {
      expect(opensLiveView(language, action)).toBe(false);
      expect(startsFilm(language, action, 0)).toBeUndefined();
    }
  });
});

describe('a picture from the family (packages/contracts mantel.ts)', () => {
  const photo = {
    type: 'PHOTO', id: 'photo-p1', householdId: 'h', correlationId: 'c', createdAt: 0, photoId: 'p1', fromName: 'Sarah',
    headline: 'A picture from Sarah.', photoUrl: 'https://pictures.example/p1.jpg',
    actions: [
      { id: 'keep', label: 'Keep it', kind: 'primary' },
      { id: 'thanks', label: 'Thank you', kind: 'secondary' },
    ],
  } as Card;

  it('is put away by either answer: keeping it and thanking for it look the same from here', () => {
    expect(removesCard(photo, 'keep')).toBe(true);
    expect(removesCard(photo, 'thanks')).toBe(true);
  });

  it('opens nothing: no door camera, no film', () => {
    for (const action of ['keep', 'thanks', 'watch_live', 'start']) {
      expect(opensLiveView(photo, action)).toBe(false);
      expect(startsFilm(photo, action, 0)).toBeUndefined();
    }
  });
});
