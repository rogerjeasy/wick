/**
 * The virtual television's family mode: the parts of device.js that decide
 * something without a screen — what is read from the server's answers, what
 * a button does, where a reader's page turns to, and where a following
 * player should be.
 *
 * device.js is a plain browser script (one file, no build step: it is
 * published as it stands, infra/ops-console.tf), so it is run here in a
 * context of its own with just enough of a page for it to load. What it
 * draws is checked in a real browser, not here.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  FAMILY_TV_CARD_KINDS,
  FAMILY_TV_LOOK_EVERY_MS,
  FAMILY_TV_OWN_ACTIONS,
  FAMILY_TV_PRESSES,
  FAMILY_TV_SEAT_EVERY_MS,
  FAMILY_TV_WAVE_CARD,
  isFamilyTvOwnAction,
  isFamilyTvQuietPress,
} from '../../../packages/contracts/src/familyTelevision.js';
import { MAX_CARD_ACTIONS } from '../../../packages/contracts/src/card.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an untyped browser script, called by name
type Device = Record<string, (...args: any[]) => any> & { constant(name: string): unknown };

function loadDevice(): Device {
  const element = () => ({
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    removeChild() {},
    remove() {},
    setAttribute() {},
    children: [],
    style: {},
    dataset: {},
    classList: { add() {}, remove() {} },
  });
  const context = vm.createContext({
    document: { getElementById: element, createElement: element, addEventListener() {}, removeEventListener() {}, head: element(), hidden: false, activeElement: null },
    window: {},
    console,
    URL,
    setInterval,
    clearInterval,
    setTimeout,
    fetch: () => Promise.reject(new Error('a test asks nobody')),
  });
  vm.runInContext(readFileSync(fileURLToPath(new URL('../device.js', import.meta.url)), 'utf8'), context, { filename: 'device.js' });
  // Out of that context as plain data, so what comes back compares like anything made here.
  const plain = (value: unknown) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  return new Proxy({} as Device, {
    get: (_target, name: string) =>
      name === 'constant'
        ? (constant: string) => plain(vm.runInContext(constant, context))
        : (...args: unknown[]) => plain((context[name] as (...a: unknown[]) => unknown)(...args)),
  });
}

const device = loadDevice();

const HOME = { residentName: 'Margaret', memberName: 'Sarah', cards: [] };
const cardsOf = (...cards: unknown[]) => device.readFamilyHome!({ ...HOME, cards }).cards;

describe('what it shares with the contract (packages/contracts familyTelevision.ts)', () => {
  it('asks for the home screen and for the seat as often as the contract says', () => {
    expect(device.constant('FAMILY_LOOK_EVERY_MS')).toBe(FAMILY_TV_LOOK_EVERY_MS);
    expect(device.constant('FAMILY_SEAT_EVERY_MS')).toBe(FAMILY_TV_SEAT_EVERY_MS);
  });

  it('knows the same kinds of card, and draws no more answers on one than a card holds', () => {
    expect(device.constant('FAMILY_CARD_KINDS')).toEqual([...FAMILY_TV_CARD_KINDS]);
    expect(device.constant('FAMILY_MAX_ACTIONS')).toBe(MAX_CARD_ACTIONS);
  });

  it('answers the television’s own buttons itself: later, read and seat are never sent', () => {
    expect(device.familyPressKind!(FAMILY_TV_OWN_ACTIONS.later)).toBe('later');
    expect(device.familyPressKind!(FAMILY_TV_OWN_ACTIONS.read)).toBe('read');
    expect(device.familyPressKind!(FAMILY_TV_OWN_ACTIONS.seat)).toBe('seat');
  });

  it('shows nothing in answer to the quiet presses, opens the seat after sitting down, and says the answer to anything else', () => {
    expect(device.familyPressKind!(FAMILY_TV_PRESSES.read)).toBe('quiet');
    expect(device.familyPressKind!(FAMILY_TV_PRESSES.seen)).toBe('quiet');
    expect(device.familyPressKind!(FAMILY_TV_PRESSES.sit)).toBe('sit');
    for (const answer of [FAMILY_TV_PRESSES.wave, 'expected', 'now', 'loved_it', 'accept']) {
      expect(device.familyPressKind!(answer)).toBe('say');
      // The contract agrees these are answers: none is the television's own, none is quiet.
      expect(isFamilyTvOwnAction(answer) || isFamilyTvQuietPress(answer)).toBe(false);
    }
  });
});

describe('readFamilyHome — only what the contract says a home screen is', () => {
  const DOOR = { id: 'ftv-door_look-a1', kind: 'door_look', headline: 'Margaret asks: who is at the door?', actions: [{ id: 'expected', label: 'It’s who you’re expecting', kind: 'primary' }] };

  it('reads nothing that is not a home screen', () => {
    for (const body of [null, 'home', {}, { residentName: 'Margaret', cards: [] }, { ...HOME, cards: 'none' }, { ...HOME, residentName: '' }]) {
      expect(device.readFamilyHome!(body)).toBe(null);
    }
  });

  it('keeps the names, her light’s one sentence and that a demo home is one', () => {
    expect(device.readFamilyHome!({ ...HOME, light: { lit: true, line: 'The light is on.' }, simulated: true, extra: 'unread' })).toEqual({
      residentName: 'Margaret',
      memberName: 'Sarah',
      light: { line: 'The light is on.' },
      cards: [],
      wave: null,
      simulated: true,
    });
    expect(device.readFamilyHome!({ ...HOME, light: { lit: true, line: 7 } }).light).toBe(null);
  });

  it('keeps a card of every kind the contract names', () => {
    for (const kind of FAMILY_TV_CARD_KINDS) {
      expect(cardsOf({ ...DOOR, id: `ftv-${kind}-x`, kind })).toHaveLength(1);
    }
  });

  it('drops a card of a kind it has not heard of, and one with no id or nothing to say — never drawn', () => {
    expect(cardsOf({ ...DOOR, kind: 'alarm' }, { ...DOOR, kind: undefined }, { ...DOOR, id: '' }, { ...DOOR, headline: 7 }, null, 'card')).toEqual([]);
  });

  it('keeps what is well formed on a card and drops the field that is not', () => {
    const [card] = cardsOf({ ...DOOR, detail: 7, pictureUrl: 'http://pictures.example/door.png', unknown: 'x' });

    expect(card).toEqual({ id: DOOR.id, kind: 'door_look', headline: DOOR.headline, detail: null, pictureUrl: null, pages: null, actions: [{ id: 'expected', label: 'It’s who you’re expecting', primary: true }] });
    expect(cardsOf({ ...DOOR, detail: 'A moment ago.', pictureUrl: 'https://pictures.example/door.png' })[0]).toMatchObject({
      detail: 'A moment ago.',
      pictureUrl: 'https://pictures.example/door.png',
    });
  });

  it('draws at most three answers, and none that is not a button', () => {
    const actions = [{ id: 'a', label: 'A' }, { id: '', label: 'no id' }, { id: 'b', label: 'B' }, null, { id: 'c', label: 'C' }, { id: 'd', label: 'D' }];

    expect(cardsOf({ ...DOOR, actions })[0].actions.map((a: { id: string }) => a.id)).toEqual(['a', 'b', 'c']);
    expect(cardsOf({ ...DOOR, actions: 'none' })[0].actions).toEqual([]);
  });

  describe('pages — something to read, a screenful at a time', () => {
    const READ = { id: FAMILY_TV_OWN_ACTIONS.read, label: 'Read it', kind: 'primary' };
    const LATER = { id: FAMILY_TV_OWN_ACTIONS.later, label: 'Later', kind: 'secondary' };
    const WEEK = { id: 'ftv-week-2026-W41', kind: 'week', headline: 'Margaret’s week is ready to read.', actions: [READ, LATER] };
    const pagesOf = (pages: unknown) => cardsOf({ ...WEEK, pages })[0];

    it('keeps the pages as they were written, in order', () => {
      expect(pagesOf(['A quiet week.', 'Maria came on Tuesday.']).pages).toEqual(['A quiet week.', 'Maria came on Tuesday.']);
    });

    it('keeps a page’s line breaks exactly as written: a day is a line for its date and a line for each thing in it', () => {
      const day = 'Monday 5 October\n10:15 — Maria visited.\n11:40 — The front door was answered.\n14:05 — A parcel was left.\n16:30 — Someone was at the door.';

      expect(pagesOf(['A quiet week.', day]).pages).toEqual(['A quiet week.', day]);
      expect(pagesOf([day]).pages[0].split('\n')).toHaveLength(5);
      // Line breaks and nothing else is not a page.
      expect(pagesOf(['A quiet week.', '\n\n']).pages).toBe(null);
    });

    it('drops pages that are not a list of sentences to read — and with them the button that would open them', () => {
      for (const pages of [undefined, 'A quiet week.', [], ['A quiet week.', ''], ['A quiet week.', 7], [['nested']], { 0: 'A quiet week.' }]) {
        const card = pagesOf(pages);
        expect(card.pages).toBe(null);
        // "Later" is still there: the card says the week is ready, and can be put away.
        expect(card.actions.map((a: { id: string }) => a.id)).toEqual([FAMILY_TV_OWN_ACTIONS.later]);
      }
    });

    it('reads as many pages as the server writes at most, and the native television reads: twelve', () => {
      expect(device.constant('FAMILY_MAX_PAGES')).toBe(12);
    });

    it('never shows part of something and calls it read: too many pages, or a page too long for a screen, is not read at all', () => {
      const maxPages = device.constant('FAMILY_MAX_PAGES') as number;
      const maxChars = device.constant('FAMILY_MAX_PAGE_CHARS') as number;

      expect(pagesOf(Array.from({ length: maxPages }, (_, i) => `Page ${i + 1}.`)).pages).toHaveLength(maxPages);
      expect(pagesOf(Array.from({ length: maxPages + 1 }, (_, i) => `Page ${i + 1}.`)).pages).toBe(null);
      expect(pagesOf(['x'.repeat(maxChars)]).pages).toHaveLength(1);
      expect(pagesOf(['x'.repeat(maxChars + 1)]).pages).toBe(null);
    });
  });

  describe('wave — one button on the home screen, or the sentence that stands in its place', () => {
    const waveOf = (wave: unknown) => device.readFamilyHome!({ ...HOME, wave }).wave;

    it('is a button while a wave can be sent', () => {
      expect(waveOf({ label: 'Wave to Margaret', cardId: FAMILY_TV_WAVE_CARD })).toEqual({ label: 'Wave to Margaret', cardId: FAMILY_TV_WAVE_CARD, line: null });
    });

    it('is only a sentence while the last one is still on her television', () => {
      expect(waveOf({ label: 'Wave to Margaret', line: 'Your wave is on Margaret’s television.' })).toEqual({
        label: 'Wave to Margaret',
        cardId: null,
        line: 'Your wave is on Margaret’s television.',
      });
    });

    it('is nothing at all when it is malformed, has no words for the button, or is pressed on something that is not a wave', () => {
      for (const wave of [undefined, null, 'wave', {}, { label: 'Wave to Margaret' }, { cardId: FAMILY_TV_WAVE_CARD }, { label: 7, cardId: FAMILY_TV_WAVE_CARD }, { label: 'Wave', cardId: 'ftv-door_look-a1' }, { label: 'Wave', cardId: 7 }, { label: 'Wave', line: 7 }]) {
        expect(waveOf(wave)).toBe(null);
      }
    });
  });
});

describe('readFamilySeat — the seat beside her film', () => {
  const SEAT = {
    cardId: 'ftv-watch-s1',
    film: 'Sintel',
    state: 'watching',
    line: 'You are watching Sintel with Margaret.',
    stream: { url: 'https://films.example/sintel/index.m3u8', durationMs: 888_000, attribution: '© Blender Foundation | durian.blender.org' },
    playback: { state: 'PLAYING', positionMs: 60_000, ageMs: 400 },
  };
  const seatOf = (seat: unknown) => device.readFamilySeat!({ seat });

  it('reads a reply with no seat as there being no film', () => {
    expect(device.readFamilySeat!({})).toEqual({ seat: null });
    expect(device.readFamilySeat!({ seat: null })).toEqual({ seat: null });
  });

  it('cannot read something that is not a reply, or a seat it does not understand — which is not the film being over', () => {
    for (const body of [null, 'seat', 7]) expect(device.readFamilySeat!(body)).toBe(null);
    for (const seat of ['seat', { ...SEAT, state: 'rewinding' }, { ...SEAT, cardId: '' }, { ...SEAT, line: undefined }]) expect(seatOf(seat)).toBe(null);
  });

  it('reads the film, where hers is, and the line the screen says', () => {
    expect(seatOf(SEAT)).toEqual({
      seat: { cardId: 'ftv-watch-s1', state: 'watching', line: SEAT.line, stream: SEAT.stream, playback: SEAT.playback, question: null, answers: [], yourAnswer: null, theirAnswer: null },
    });
  });

  it('plays a film only from an https address, or from this machine', () => {
    const urlOf = (url: unknown) => seatOf({ ...SEAT, stream: { ...SEAT.stream, url } })!.seat.stream;

    expect(urlOf('http://127.0.0.1:4599/films/sintel/index.m3u8')).toMatchObject({ url: 'http://127.0.0.1:4599/films/sintel/index.m3u8' });
    for (const url of ['http://films.example/sintel/index.m3u8', 'javascript:alert(1)', 'https://films.example/a b', 7, undefined]) expect(urlOf(url)).toBe(null);
  });

  it('follows nothing it cannot place: a playback with no state or no position is none', () => {
    for (const playback of [undefined, { state: 'REWINDING', positionMs: 0, ageMs: 0 }, { state: 'PLAYING', positionMs: 'soon', ageMs: 0 }, { state: 'PLAYING', positionMs: 0 }]) {
      expect(seatOf({ ...SEAT, playback })!.seat.playback).toBe(null);
    }
  });

  it('reads the question at the credits, at most three answers, and what was answered', () => {
    const answers = [{ id: 'loved_it', label: 'I loved it.' }, { id: 'all_right', label: 'It was all right.' }, { id: 'not_for_me', label: 'Not really for me.' }, { id: 'fourth', label: 'A fourth' }, { label: 'no id' }];
    const { seat } = seatOf({ ...SEAT, state: 'asked', question: 'How was it?', answers, yourAnswer: 'I loved it.', theirAnswer: 'It was all right.' })!;

    expect(seat.question).toBe('How was it?');
    expect(seat.answers.map((a: { id: string }) => a.id)).toEqual(['loved_it', 'all_right', 'not_for_me']);
    expect(seat).toMatchObject({ yourAnswer: 'I loved it.', theirAnswer: 'It was all right.' });
  });
});

describe('familySeatAfterPress — what the seat shows once an answer at the credits has been pressed', () => {
  const after = (outcome: unknown) => device.familySeatAfterPress!(outcome);
  const NOT_SENT = 'That could not be sent just now. Try again in a moment.';

  it('shows nothing extra when the answer was taken: the answers go, and the seat’s own line says the rest', () => {
    expect(after({ arrived: true, done: true, say: 'It is on the television now: “Sarah says: I loved it.”' })).toEqual({ answered: true, said: null });
  });

  it('says the server’s sentence when it was not taken, and the question is still there to answer', () => {
    expect(after({ arrived: true, done: false, say: 'That question is not open any more.' })).toEqual({ answered: false, said: 'That question is not open any more.' });
    expect(after({ arrived: true, done: false, say: null })).toEqual({ answered: false, said: null });
  });

  it('says so when the press did not arrive, and the question is still there to answer', () => {
    expect(device.constant('FAMILY_NOT_SENT')).toBe(NOT_SENT);
    expect(after({ arrived: false })).toEqual({ answered: false, said: NOT_SENT });
  });
});

describe('familyCardWaits — whether something on the home screen waits for an answer while this television is in the seat', () => {
  const FILM = 'ftv-watch-s1';
  const card = (id: string, kind: string, ...actions: string[]) => cardsOf({ id, kind, headline: 'A card.', actions: actions.map((action) => ({ id: action, label: action })) })[0];
  const waits = (c: unknown, film: unknown = FILM) => device.familyCardWaits!(c, film);

  it('says the one line the seat shows, and nothing of what is waiting', () => {
    expect(device.constant('FAMILY_WAITING_LINE')).toBe('Something is waiting for you. Press Back to see it.');
  });

  it('is so for her question from the door, her asking to be rung, and anything else with an answer to give', () => {
    expect(waits(card('ftv-door_look-a1', 'door_look', 'expected', 'unknown', 'ring_me'))).toBe(true);
    expect(waits(card('ftv-reach-1791900967785', 'reach', 'now', 'within_hour'))).toBe(true);
    expect(waits(card('ftv-wave-1791900967785', 'wave', FAMILY_TV_PRESSES.seen))).toBe(true);
    // Another film, with a seat to sit down to.
    expect(waits(card('ftv-watch-s2', 'watch', FAMILY_TV_PRESSES.sit, FAMILY_TV_OWN_ACTIONS.later))).toBe(true);
  });

  it('is not so for this film’s own card, whatever it offers', () => {
    expect(waits(card(FILM, 'watch', FAMILY_TV_OWN_ACTIONS.seat, FAMILY_TV_OWN_ACTIONS.later))).toBe(false);
    // The home screen as it was a moment before sitting down: still this film.
    expect(waits(card(FILM, 'watch', FAMILY_TV_PRESSES.sit, FAMILY_TV_OWN_ACTIONS.later))).toBe(false);
  });

  it('is not so for a card whose buttons are all the television’s own, or that has none: nothing is asked', () => {
    expect(waits(cardsOf({ id: 'ftv-week-2026-W41', kind: 'week', headline: 'Her week.', pages: ['A quiet week.'], actions: [{ id: FAMILY_TV_OWN_ACTIONS.read, label: 'Read it' }, { id: FAMILY_TV_OWN_ACTIONS.later, label: 'Not now' }] })[0])).toBe(false);
    expect(waits(card('ftv-watch-s2', 'watch', FAMILY_TV_OWN_ACTIONS.seat, FAMILY_TV_OWN_ACTIONS.later))).toBe(false);
    expect(waits(card('ftv-reach-1791900967785', 'reach'))).toBe(false);
    expect(waits(undefined)).toBe(false);
  });

  it('counts a film’s card as any other before the seat knows which film it is beside', () => {
    expect(waits(card(FILM, 'watch', FAMILY_TV_PRESSES.sit), null)).toBe(true);
    expect(waits(card(FILM, 'watch', FAMILY_TV_OWN_ACTIONS.seat), null)).toBe(false);
  });
});

describe('familyFollow — where this television should be, given where hers is (the family app’s rule, apps/sim-alexa surface.js follow)', () => {
  const follow = (...args: unknown[]) => device.familyFollow!(...args);

  it('plays on from where her film was, by as long ago as that was', () => {
    expect(follow({ state: 'PLAYING', positionMs: 60_000, ageMs: 1_200 }, 300, { positionMs: 61_400, paused: false })).toEqual({ play: true, seekToMs: null });
  });

  it('jumps when it has fallen behind, or she skipped — and not for less than about two seconds', () => {
    expect(follow({ state: 'PLAYING', positionMs: 90_000, ageMs: 500 }, 0, { positionMs: 61_000, paused: false })).toEqual({ play: true, seekToMs: 90_500 });
    expect(follow({ state: 'PLAYING', positionMs: 30_000, ageMs: 0 }, 0, { positionMs: 61_000, paused: false })).toEqual({ play: true, seekToMs: 30_000 });
    expect(follow({ state: 'PLAYING', positionMs: 60_000, ageMs: 0 }, 0, { positionMs: 62_000, paused: false })).toEqual({ play: true, seekToMs: null });
    expect(follow({ state: 'PLAYING', positionMs: 60_000, ageMs: 0 }, 0, { positionMs: 57_400, paused: false })).toEqual({ play: true, seekToMs: 60_000 });
  });

  it('starts playing when hers does', () => {
    expect(follow({ state: 'PLAYING', positionMs: 60_000, ageMs: 0 }, 0, { positionMs: 60_000, paused: true })).toEqual({ play: true, seekToMs: null });
  });

  it('pauses where she paused, to the frame it stopped near', () => {
    expect(follow({ state: 'PAUSED', positionMs: 75_000, ageMs: 40_000 }, 5_000, { positionMs: 76_200, paused: false })).toEqual({ play: false, seekToMs: 75_000 });
    expect(follow({ state: 'PAUSED', positionMs: 75_000, ageMs: 0 }, 0, { positionMs: 75_100, paused: true })).toEqual({ play: false, seekToMs: null });
  });

  it('waits where hers was when it has gone quiet, and does not run on', () => {
    expect(follow({ state: 'WAITING', positionMs: 120_000, ageMs: 30_000 }, 0, { positionMs: 121_000, paused: false })).toEqual({ play: false, seekToMs: 120_000 });
  });

  it('stops where it is when the film is stopped, and before anything is known', () => {
    expect(follow({ state: 'STOPPED', positionMs: 5_000, ageMs: 0 }, 0, { positionMs: 300_000, paused: false })).toEqual({ play: false, seekToMs: null });
    expect(follow(null, 0, { positionMs: 0, paused: true })).toEqual({ play: false, seekToMs: null });
  });

  it('never asks for a place past the end of the film', () => {
    expect(follow({ state: 'PLAYING', positionMs: 887_000, ageMs: 60_000 }, 0, { positionMs: 0, paused: true }, 888_000)).toEqual({ play: true, seekToMs: 888_000 });
  });
});

describe('turnFamilyPage — the reader, one page at a time', () => {
  const turn = (index: number, count: number, move: string) => device.turnFamilyPage!(index, count, move);

  it('goes on a page, and back a page', () => {
    expect(turn(0, 5, 'next')).toEqual({ index: 1 });
    expect(turn(3, 5, 'back')).toEqual({ index: 2 });
  });

  it('stays where it is at either end: turning a page never leaves the reader by itself', () => {
    expect(turn(0, 5, 'back')).toEqual({ index: 0 });
    expect(turn(4, 5, 'next')).toEqual({ index: 4 });
  });

  it('counts as read only when it is left from the last page', () => {
    expect(turn(4, 5, 'close')).toEqual({ leave: true, read: true });
    expect(turn(0, 1, 'close')).toEqual({ leave: true, read: true });
    for (const index of [0, 1, 2, 3]) expect(turn(index, 5, 'close')).toEqual({ leave: true, read: false });
  });

  it('says which page this is, in words', () => {
    expect(device.familyPageLine!(1, 5)).toBe('Page 2 of 5');
    expect(device.familyPageLine!(0, 1)).toBe('Page 1 of 1');
  });
});
