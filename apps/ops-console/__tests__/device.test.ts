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
import { MAX_CARD_ACTIONS, type Card } from '../../../packages/contracts/src/card.js';
import { LANGUAGES, LANGUAGE_ACTIONS, LANGUAGE_NAMES, languageCardId, languageQuestion } from '../../../packages/contracts/src/language.js';
import { MAX_MANTEL, MANTEL_FULL_NOTICE, PHOTO_ACTIONS, photoCardId, photoCardWords, readMantelItems } from '../../../packages/contracts/src/mantel.js';
import { WORDS } from '../../tv-vega/src/words/words.js';
import { replyActions } from '../../tv-vega/src/cards/messageActions.js';
import { removesCard } from '../../tv-vega/src/cards/cardActions.js';

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

/*
 * The resident's television in the browser: the television speaks her
 * language (packages/contracts language.ts), the question that asks her,
 * and a card of a kind this page does not know.
 *
 * Here the script is given a page that remembers what is put on it and a
 * socket that remembers what is sent, so what the screen says can be read
 * back as text. How it looks is still checked in a real browser.
 */
interface Node {
  tagName: string;
  className: string;
  textContent: string;
  children: Node[];
  parent: Node | null;
  listeners: Record<string, Array<() => void>>;
  [key: string]: unknown;
}

function page() {
  const make = (tagName: string): Node => {
    const node: Node = {
      tagName,
      className: '',
      textContent: '',
      children: [],
      parent: null,
      listeners: {},
      style: {},
      dataset: {},
      classList: { add() {}, remove() {} },
      disabled: false,
      setAttribute() {},
      focus() {},
      blur() {},
      contains: () => false,
      querySelectorAll: () => [],
      addEventListener(type: string, listener: () => void) {
        (node.listeners[type] ??= []).push(listener);
      },
      removeEventListener() {},
      appendChild(child: Node) {
        child.parent?.children.splice(child.parent.children.indexOf(child), 1);
        child.parent = node;
        node.children.push(child);
        return child;
      },
      insertBefore(child: Node, before: Node | null) {
        child.parent = node;
        const at = before ? node.children.indexOf(before) : -1;
        if (at < 0) node.children.push(child);
        else node.children.splice(at, 0, child);
        return child;
      },
      removeChild(child: Node) {
        node.children.splice(node.children.indexOf(child), 1);
        child.parent = null;
        return child;
      },
      remove() {
        if (node.parent) (node.parent.removeChild as (child: Node) => Node)(node);
      },
      replaceChildren(...next: Node[]) {
        node.children = [];
        for (const child of next) (node.appendChild as (child: Node) => Node)(child);
      },
      get firstChild() {
        return node.children[0] ?? null;
      },
    };
    return node;
  };
  const byId = new Map<string, Node>();
  /** What the page listens for on the document: the keyboard, which is its remote. */
  const keys: Record<string, Array<(event: unknown) => void>> = {};
  const document = {
    getElementById: (id: string) => byId.get(id) ?? (byId.set(id, make('div')), byId.get(id)!),
    createElement: make,
    addEventListener(type: string, listener: (event: unknown) => void) {
      (keys[type] ??= []).push(listener);
    },
    removeEventListener() {},
    head: make('head'),
    hidden: false,
    activeElement: null,
  };
  return { document, keys, screen: () => document.getElementById('tv-screen') };
}

/** Everything written on a node and under it, in the order it is drawn. */
const textOf = (node: Node): string[] => [...(node.textContent ? [node.textContent] : []), ...node.children.flatMap(textOf)];
const buttonsOf = (node: Node): Node[] => [...(node.tagName === 'button' ? [node] : []), ...node.children.flatMap(buttonsOf)];
const marksOf = (node: Node): Node[] => [...(node.tagName === 'span' && String(node.className).includes('tv-read') ? [node] : []), ...node.children.flatMap(marksOf)];
const imagesOf = (node: Node): Node[] => [...(node.tagName === 'img' ? [node] : []), ...node.children.flatMap(imagesOf)];

function television() {
  const { document, keys, screen } = page();
  /** The sounds the page has made: where each is fetched from, and what was done with it. */
  const sounds: Array<{ src: string; played: number; paused: number; onplaying?: () => void; onended?: () => void; onerror?: () => void }> = [];
  class FakeAudio {
    played = 0;
    paused = 0;
    onplaying?: () => void;
    onended?: () => void;
    onerror?: () => void;
    constructor(readonly src: string) {
      sounds.push(this);
    }
    play() {
      this.played += 1;
      return Promise.resolve();
    }
    pause() {
      this.paused += 1;
    }
  }
  const sockets: Array<{ sent: Array<Record<string, unknown>>; onopen?: () => void; onmessage?: (event: { data: string }) => void; readyState: number }> = [];
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 1;
    sent: Array<Record<string, unknown>> = [];
    constructor(readonly url: string) {
      sockets.push(this);
    }
    send(data: string) {
      this.sent.push(JSON.parse(data) as Record<string, unknown>);
    }
    close() {}
  }
  const context = vm.createContext({ document, window: {}, console, URL, setInterval, clearInterval, setTimeout, clearTimeout, WebSocket: FakeWebSocket, Audio: FakeAudio, fetch: () => Promise.reject(new Error('a test asks nobody')) });
  vm.runInContext(readFileSync(fileURLToPath(new URL('../device.js', import.meta.url)), 'utf8'), context, { filename: 'device.js' });

  // Paired as the resident's television, and connected.
  (context.connectWebSocket as (jwt: string, deviceId: string) => void)('a.b.c', 'ops-console-test');
  const socket = sockets[0]!;
  socket.onopen!();

  const receive = (message: unknown): void => socket.onmessage!({ data: JSON.stringify(message) });
  return {
    /** What was sent since connecting, without the times. */
    sent: () => socket.sent.map(({ at: _at, ...event }) => event),
    card: (queued: unknown) => receive({ kind: 'card', card: queued }),
    control: (control: unknown) => receive({ kind: 'control', control }),
    /** A key on the keyboard, which is this page's remote. */
    key: (key: string) => {
      for (const listener of keys.keydown ?? []) listener({ key, preventDefault() {}, target: null });
    },
    sounds,
    /** The marks on the screen that are not buttons and have no words: what each is called. */
    marks: () => marksOf(screen()).map((mark) => mark.title),
    pressMark: () => {
      for (const listener of marksOf(screen())[0]?.listeners.click ?? []) listener();
    },
    /** The pictures on the screen: where each is fetched from, and what it is called. */
    pictures: () => imagesOf(screen()).map((img) => ({ src: img.src, alt: img.alt })),
    /** A picture's address stops answering. */
    failPicture: () => {
      for (const img of imagesOf(screen())) (img.onerror as (() => void) | undefined)?.();
    },
    /** A click on the picture itself: OK, on the television. */
    pressPicture: () => {
      const img = imagesOf(screen())[0];
      if (!img) throw new Error('no picture on the screen');
      for (const listener of img.listeners.click ?? []) listener();
    },
    home: (home: Record<string, unknown>, whole = true) => receive({ kind: 'control', control: { t: 'home', home, ...(whole ? { whole: true } : {}) } }),
    says: () => textOf(screen()),
    buttons: () => buttonsOf(screen()).map((button) => button.textContent),
    press: (label: string) => {
      const button = buttonsOf(screen()).find((b) => b.textContent === label);
      if (!button) throw new Error(`no button says “${label}”: ${buttonsOf(screen()).map((b) => b.textContent).join(', ')}`);
      for (const listener of button.listeners.click ?? []) listener();
    },
    evaluate: (expression: string): unknown => {
      const value: unknown = vm.runInContext(expression, context);
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    },
  };
}

const queuedCard = (card: Record<string, unknown>, urgency = 'DEFERRED') => ({
  id: card.id,
  urgency,
  queuedAt: 1,
  shownCount: 0,
  card: { householdId: 'hh-1', correlationId: 'c', createdAt: 1, actions: [], ...card },
});

const LANGUAGE_CARD = queuedCard({ id: languageCardId('es'), type: 'LANGUAGE', language: 'es', ...languageQuestion('es', 'Sarah') });
const NOTE = (transcript: string) => queuedCard({ id: 'note-1', type: 'MESSAGE', fromName: 'Sarah', transcript, suggestedReplies: [] });

describe('the browser television’s own words (the television’s are apps/tv-vega/src/words/words.ts)', () => {
  const tv = television();
  const table = tv.evaluate('TV_WORDS') as Record<string, Record<string, string>>;
  const named = (sentence: string): string[] => [...sentence.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

  it('has a table for each language a household can choose', () => {
    expect(Object.keys(table).sort()).toEqual([...LANGUAGES].sort());
    expect(tv.evaluate('TV_LANGUAGES')).toEqual([...LANGUAGES]);
  });

  it('says in Spanish everything it says in English, with the same values put in, and never the English over again', () => {
    expect(Object.keys(table.es!).sort()).toEqual(Object.keys(table.en!).sort());
    for (const [key, sentence] of Object.entries(table.en!)) {
      expect(table.es![key], key).toBeTruthy();
      expect(table.es![key], key).not.toBe(sentence);
      expect(named(table.es![key]!), key).toEqual(named(sentence));
    }
  });

  it('says what the television says, where they say the same thing', () => {
    for (const language of LANGUAGES) {
      expect(table[language]!.lightOn).toBe(WORDS[language]['home.lightOn']);
      expect(table[language]!.lightOut).toBe(WORDS[language]['home.lightOut']);
      expect(table[language]!.filmBack).toBe(WORDS[language]['live.back']);
      expect(table[language]!.filmWith).toBe(WORDS[language]['watch.companion']);
      // The mantelpiece (packages/contracts mantel.ts).
      expect(table[language]!.mantel).toBe(WORDS[language]['home.mantel']);
      expect(table[language]!.photoUnavailable).toBe(WORDS[language]['photo.unavailable']);
      expect(table[language]!.photoPicture).toBe(WORDS[language]['photo.pictureLabel']);
      expect(table[language]!.mantelFrom).toBe(WORDS[language]['mantel.from']);
      expect(table[language]!.mantelPlace).toBe(WORDS[language]['mantel.place']);
      expect(table[language]!.mantelChoice).toBe(WORDS[language]['mantel.choice']);
      expect(table[language]!.mantelChoiceDetail).toBe(WORDS[language]['mantel.choiceDetail']);
      expect(table[language]!.mantelLeave).toBe(WORDS[language]['mantel.leave']);
      expect(table[language]!.mantelTakeDown).toBe(WORDS[language]['mantel.takeDown']);
    }
  });

  it('keeps the English it had before there was a table', () => {
    expect(table.en).toMatchObject({
      empty: 'No card currently shown.',
      lightOn: 'Light on',
      lightOut: 'Light out',
      door: 'Someone is at the door',
      doorPicture: 'Door camera still',
      message: 'Message from {name}',
      messageUnheard: 'Tap to hear the message',
      week: 'Your week — {week}',
      circle: 'Your family circle',
      sharing: 'What your family sees',
      tell: 'Something is different today',
      watch: 'Watching together',
      light: 'Your light in the window',
      reach: 'You held OK',
      visit: 'A visit',
      filmBack: 'Back',
      filmWith: '{name} is watching with you.',
    });
  });

  it('addresses her as usted in Spanish, and opens every question it closes', () => {
    for (const [key, sentence] of Object.entries(table.es!)) {
      expect(sentence, key).not.toMatch(/(?<!\p{L})(tú|tu|tus|te|ti|contigo)(?!\p{L})/iu);
      expect((sentence.match(/¿/g) ?? []).length, key).toBe((sentence.match(/\?/g) ?? []).length);
    }
  });
});

describe('the browser television — the language comes from the home message, and from nowhere else', () => {
  it('is English until the home says otherwise, and for a language it has not heard of', () => {
    const tv = television();

    expect(tv.evaluate('tvLanguage()')).toBe('en');
    tv.home({ light: 'on' });
    expect(tv.evaluate('tvLanguage()')).toBe('en');
    expect(tv.says()).toEqual(['No card currently shown.', 'Light on']);

    tv.home({ light: 'on', language: 'fr' });
    expect(tv.evaluate('tvLanguage()')).toBe('en');
  });

  it('says its own words in Spanish once the home says so', () => {
    const tv = television();

    tv.home({ light: 'out', language: 'es', lookedIn: { name: 'Sarah', at: Date.now(), line: 'Sarah se asomó esta mañana.' } });

    expect(tv.evaluate('tvLanguage()')).toBe('es');
    // Its own two sentences in Spanish; the line about who looked in is the server's, as it came.
    expect(tv.says()).toEqual(['No hay ninguna tarjeta en pantalla.', 'Sarah se asomó esta mañana.', 'Luz apagada']);
  });

  it('keeps the language through a part of the home that does not speak of it, and goes back to English when the whole of a home names none', () => {
    const tv = television();
    tv.home({ light: 'on', language: 'es' });

    tv.home({ light: 'out' }, false);
    expect(tv.says()).toEqual(['No hay ninguna tarjeta en pantalla.', 'Luz apagada']);

    tv.home({ light: 'on' });
    expect(tv.says()).toEqual(['No card currently shown.', 'Light on']);
  });

  it('says a card’s label in her language, and the card’s own words as the server sent them', () => {
    const tv = television();
    tv.home({ language: 'es' });

    tv.card(NOTE('Nos vemos el domingo.'));

    expect(tv.says()).toEqual(['Mensaje de Sarah', 'Nos vemos el domingo.']);
  });

  it('asks for its cards again, once, when the language changes — not when it first learns it', () => {
    const tv = television();
    expect(tv.sent()).toEqual([{ t: 'reconcile' }]);

    // Connected to a home that already speaks Spanish: the cards it is being sent are in Spanish already.
    tv.home({ language: 'es' });
    expect(tv.sent()).toEqual([{ t: 'reconcile' }]);

    // She goes back to English; the answer brings the home again, and nothing more is asked.
    tv.home({ light: 'on' });
    tv.home({ light: 'on' });
    tv.home({ light: 'out' }, false);
    expect(tv.sent()).toEqual([{ t: 'reconcile' }, { t: 'reconcile' }]);
  });

  it('draws the card on screen again in the new language, and puts the one sent again in its place', () => {
    const tv = television();
    tv.home({});
    tv.card(NOTE('See you on Sunday.'));
    expect(tv.says()).toEqual(['Message from Sarah', 'See you on Sunday.']);

    tv.home({ language: 'es' });
    // Its own label at once; the note's words when the server sends the note again.
    expect(tv.says()).toEqual(['Mensaje de Sarah', 'See you on Sunday.']);
    tv.card(NOTE('Nos vemos el domingo.'));
    expect(tv.says()).toEqual(['Mensaje de Sarah', 'Nos vemos el domingo.']);
  });

  it('leaves a family member’s own television in English: none of its words come from this table', () => {
    const script = readFileSync(fileURLToPath(new URL('../device.js', import.meta.url)), 'utf8');
    const familyMode = script.slice(script.indexOf("/* --- A family member's own television"), script.indexOf('/* --- Telemetry'));

    expect(familyMode.length).toBeGreaterThan(1000);
    expect(familyMode).not.toMatch(/\btvSay\(|\bTV_WORDS\b|\btvLanguage\(/);
  });
});

describe('the browser television — the question that asks which language', () => {
  it('is drawn with the server’s words, in both languages, and its two buttons — the first one first', () => {
    const tv = television();
    tv.home({ light: 'on' });

    tv.card(LANGUAGE_CARD);

    expect(tv.says()).toEqual([
      'English · español',
      '¿Quiere que Wick le hable en español?',
      'Sarah ha pedido que este televisor le hable en español. Solo cambia si usted dice que sí. Sarah asks whether this television should use Spanish. Nothing changes unless you say yes.',
      'Sí, en español',
      'No, keep English',
    ]);
    expect(tv.buttons()).toEqual(['Sí, en español', 'No, keep English']);
    expect(tv.sent()).toEqual([{ t: 'reconcile' }, { t: 'card_shown', cardId: 'language-es' }]);
  });

  it('names both languages the same way the contract does', () => {
    const tv = television();

    expect(tv.evaluate('TV_LANGUAGE_KICKER')).toBe(LANGUAGES.map((language) => LANGUAGE_NAMES[language].own).join(' · '));
  });

  it('sends her yes, puts the card away, and speaks Spanish when the home says so — then asks for its cards again', () => {
    const tv = television();
    tv.home({ light: 'on' });
    tv.card(LANGUAGE_CARD);

    tv.press('Sí, en español');

    expect(tv.sent().slice(2)).toEqual([{ t: 'card_action', cardId: 'language-es', action: LANGUAGE_ACTIONS.yes }]);
    // Nothing changes until the server says so.
    expect(tv.says()).toEqual(['No card currently shown.', 'Light on']);

    tv.home({ light: 'on', language: 'es' });

    expect(tv.says()).toEqual(['No hay ninguna tarjeta en pantalla.', 'Luz encendida']);
    expect(tv.sent().slice(3)).toEqual([{ t: 'reconcile' }]);
  });

  it('sends her no and puts the card away: nothing else changes', () => {
    const tv = television();
    tv.home({ light: 'on' });
    tv.card(LANGUAGE_CARD);

    tv.press('No, keep English');
    tv.home({ light: 'on' });

    expect(tv.sent().slice(2)).toEqual([{ t: 'card_action', cardId: 'language-es', action: LANGUAGE_ACTIONS.no }]);
    expect(tv.says()).toEqual(['No card currently shown.', 'Light on']);
  });
});

describe('the browser television — a card of a kind it does not know', () => {
  const UNKNOWN = queuedCard({ id: 'new-1', type: 'SOMETHING_NEW', headline: 'A new thing', actions: [{ id: 'ok', label: 'OK', kind: 'primary' }] });

  it('knows the kinds of card the contract has today', () => {
    const tv = television();

    expect((tv.evaluate('TV_CARD_TYPES') as string[]).sort()).toEqual(['CIRCLE', 'DOOR', 'LANGUAGE', 'LIGHT', 'MESSAGE', 'PHOTO', 'REACH', 'SHARING', 'TELL', 'VISIT', 'WATCH', 'WEEK']);
  });

  it('is not drawn, has no buttons, and is not said to have been shown', () => {
    const tv = television();
    tv.home({ light: 'on' });

    tv.card(UNKNOWN);

    expect(tv.says()).toEqual(['No card currently shown.', 'Light on']);
    expect(tv.buttons()).toEqual(['Light on']);
    expect(tv.sent()).toEqual([{ t: 'reconcile' }]);
    expect(tv.evaluate('currentQueuedCard')).toBeNull();
  });

  it('does not take the place of the card that is on screen', () => {
    const tv = television();
    tv.home({});
    tv.card(NOTE('See you on Sunday.'));

    tv.card(UNKNOWN);
    tv.card(null);
    tv.card({ id: 'x' });

    expect(tv.says()).toEqual(['Message from Sarah', 'See you on Sunday.']);
    expect(tv.sent()).toEqual([{ t: 'reconcile' }, { t: 'card_shown', cardId: 'note-1' }]);
  });

  it('never writes that it does not recognise a card', () => {
    const script = readFileSync(fileURLToPath(new URL('../device.js', import.meta.url)), 'utf8');

    expect(script).not.toMatch(/Unrecognized card type/);
  });
});

/*
 * The mantelpiece (packages/contracts mantel.ts) on the resident's
 * television in the browser: the picture card, the pill, and a simple
 * viewer. No photograph is used here or anywhere in these tests — a picture
 * is only ever an address, and none is fetched.
 */
const PICTURE = 'https://pictures.example/photos/hh-1/p1.jpg?X-Amz-Signature=abc';
const PHOTO = (over: Record<string, unknown> = {}) =>
  queuedCard({ id: photoCardId('p1'), type: 'PHOTO', photoId: 'p1', fromName: 'Sarah', photoUrl: PICTURE, ...photoCardWords('Sarah'), ...over });
const kept = (photoId: string, fromName = 'Sarah') => ({ photoId, fromName, keptAt: 5, url: `https://pictures.example/${photoId}.jpg` });

describe('the browser television — a picture from the family', () => {
  it('is drawn with its picture, the server’s headline and its two buttons', () => {
    const tv = television();
    tv.home({ light: 'on' });

    tv.card(PHOTO());

    expect(tv.says()).toEqual(['A picture', 'A picture from Sarah.', 'Keep it', 'Thank you']);
    expect(tv.pictures()).toEqual([{ src: PICTURE, alt: 'A picture from Sarah' }]);
    expect(tv.buttons()).toEqual(['Keep it', 'Thank you']);
    expect(tv.sent()).toEqual([{ t: 'reconcile' }, { t: 'card_shown', cardId: 'photo-p1' }]);
  });

  it('fetches a picture only from an https address: anything else is a calm line in its place, and the buttons still work', () => {
    for (const photoUrl of [undefined, '', 'http://pictures.example/p1.jpg', 'javascript:alert(1)', 'data:image/jpeg;base64,AAAA', 7]) {
      const tv = television();
      tv.home({});

      tv.card(PHOTO({ photoUrl }));

      expect(tv.pictures(), String(photoUrl)).toEqual([]);
      expect(tv.says()).toEqual(['A picture', 'A picture from Sarah.', 'The picture cannot be shown just now.', 'Keep it', 'Thank you']);
      tv.press('Thank you');
      expect(tv.sent().slice(2)).toEqual([{ t: 'card_action', cardId: 'photo-p1', action: PHOTO_ACTIONS.thanks }]);
    }
  });

  it('takes the picture away when its address stops answering — one lives an hour — and says so calmly', () => {
    const tv = television();
    tv.home({});
    tv.card(PHOTO());

    tv.failPicture();

    expect(tv.pictures()).toEqual([]);
    expect(tv.says()).toEqual(['A picture', 'A picture from Sarah.', 'The picture cannot be shown just now.', 'Keep it', 'Thank you']);
    expect(tv.buttons()).toEqual(['Keep it', 'Thank you']);
  });

  it('is put away by either answer, and sends which', () => {
    for (const [label, action] of [['Keep it', PHOTO_ACTIONS.keep], ['Thank you', PHOTO_ACTIONS.thanks]] as const) {
      const tv = television();
      tv.home({ light: 'on' });
      tv.card(PHOTO());

      tv.press(label);

      expect(tv.sent().slice(2)).toEqual([{ t: 'card_action', cardId: 'photo-p1', action }]);
      expect(tv.says()).toEqual(['No card currently shown.', 'Light on']);
    }
  });

  it('is shown again when the server sends it back because her mantelpiece is full, with the line that says so', () => {
    const tv = television();
    tv.home({ light: 'on' });
    tv.card(PHOTO());
    tv.press('Keep it');

    tv.card(PHOTO({ notice: MANTEL_FULL_NOTICE }));

    expect(tv.says()).toEqual(['A picture', 'A picture from Sarah.', MANTEL_FULL_NOTICE, 'Keep it', 'Thank you']);
    expect(tv.pictures()).toHaveLength(1);
    expect(tv.sent().slice(2)).toEqual([{ t: 'card_action', cardId: 'photo-p1', action: 'keep' }, { t: 'card_shown', cardId: 'photo-p1' }]);
  });

  it('says its own two lines in Spanish, and the card’s words as the server sent them', () => {
    const tv = television();
    tv.home({ language: 'es' });

    tv.card(PHOTO({ photoUrl: undefined, headline: 'Una foto de Sarah.' }));

    expect(tv.says().slice(0, 3)).toEqual(['Una foto', 'Una foto de Sarah.', 'La foto no se puede mostrar ahora.']);
  });
});

describe('the browser television — her mantelpiece', () => {
  /** Connected, with things on her mantelpiece, and the pill pressed. */
  const opened = (items: unknown[] | undefined, home: Record<string, unknown> = { light: 'on', mantel: 3 }) => {
    const tv = television();
    tv.home(home);
    tv.press(home.language === 'es' ? 'Repisa' : 'Mantelpiece');
    if (items) tv.control({ t: 'mantel', items });
    return tv;
  };

  it('is offered on the home screen only when the home says she has kept something', () => {
    const tv = television();

    tv.home({ light: 'on' });
    expect(tv.buttons()).toEqual(['Light on']);
    tv.home({ light: 'on', mantel: 2 });
    expect(tv.buttons()).toEqual(['Light on', 'Mantelpiece']);
    tv.home({ light: 'on' });
    expect(tv.buttons()).toEqual(['Light on']);
  });

  it('asks the server when it is opened, and waits with three dots until it answers', () => {
    const tv = opened(undefined);

    expect(tv.sent()).toEqual([{ t: 'reconcile' }, { t: 'mantel' }]);
    expect(tv.says()).toEqual(['…', 'Back']);
    expect(tv.pictures()).toEqual([]);
  });

  it('shows one picture at a time, who it is from and where it stands', () => {
    const tv = opened([kept('p1'), kept('p2', 'Tom'), kept('p3')]);

    expect(tv.pictures()).toEqual([{ src: 'https://pictures.example/p1.jpg', alt: 'A picture from Sarah' }]);
    expect(tv.says()).toEqual(['From Sarah · 1 of 3', 'Previous', 'Next', 'Back']);

    tv.press('Next');
    expect(tv.pictures()[0]!.src).toBe('https://pictures.example/p2.jpg');
    expect(tv.says()[0]).toBe('From Tom · 2 of 3');
  });

  it('stays at either end', () => {
    const tv = opened([kept('p1'), kept('p2')]);

    tv.press('Previous');
    expect(tv.says()[0]).toBe('From Sarah · 1 of 2');
    tv.press('Next');
    tv.press('Next');
    tv.press('Next');
    expect(tv.says()[0]).toBe('From Sarah · 2 of 2');
  });

  it('opens a choice on the picture — "Leave it" first — and leaving it sends nothing', () => {
    const tv = opened([kept('p1'), kept('p2')]);

    tv.pressPicture();
    expect(tv.buttons()).toEqual(['Leave it', 'Take it down']);
    expect(tv.says()).toEqual(['From Sarah · 1 of 2', 'A picture from Sarah.', 'Nobody is told if you take it down.', 'Leave it', 'Take it down']);

    tv.press('Leave it');
    expect(tv.buttons()).toEqual(['Previous', 'Next', 'Back']);
    expect(tv.sent()).toEqual([{ t: 'reconcile' }, { t: 'mantel' }]);
  });

  it('takes one down by its id, waits, and shows the mantelpiece as the server says it now stands', () => {
    const tv = opened([kept('p1'), kept('p2'), kept('p3')]);
    tv.press('Next');
    tv.pressPicture();

    tv.press('Take it down');

    expect(tv.sent().slice(2)).toEqual([{ t: 'mantel_take_down', photoId: 'p2' }]);
    expect(tv.says()).toEqual(['…', 'Back']);

    tv.control({ t: 'mantel', items: [kept('p1'), kept('p3')] });
    expect(tv.pictures()[0]!.src).toBe('https://pictures.example/p3.jpg');
    expect(tv.says()[0]).toBe('From Sarah · 2 of 2');
  });

  it('goes back to the home screen when nothing is left on it, or the answer is an empty mantelpiece', () => {
    const tv = opened([kept('p1')]);
    tv.pressPicture();
    tv.press('Take it down');

    tv.control({ t: 'mantel', items: [] });
    tv.home({ light: 'on' });

    expect(tv.says()).toEqual(['No card currently shown.', 'Light on']);

    const empty = opened([]);
    expect(empty.says()).toEqual(['No card currently shown.', 'Light on', 'Mantelpiece']);
  });

  it('closes on Back, and stays open through a change to the rest of the home', () => {
    const tv = opened([kept('p1')]);

    tv.home({ light: 'out', mantel: 3 });
    expect(tv.says()[0]).toBe('From Sarah · 1 of 1');

    tv.press('Back');
    expect(tv.says()).toEqual(['No card currently shown.', 'Light out', 'Mantelpiece']);
  });

  it('reads the server’s answer as the contract does: what is well formed, in order, and no more than a mantelpiece holds', () => {
    const tv = television();
    const answers: unknown[] = [
      [kept('p1'), { ...kept('p2'), url: 'http://pictures.example/p2.jpg' }, null, 'x', { photoId: 'p3' }, { ...kept('p4'), fromName: '' }, { ...kept('p5'), keptAt: 0 }, { ...kept('bad id!') }, kept('p6')],
      Array.from({ length: MAX_MANTEL + 3 }, (_, i) => kept(`p${i}`)),
      'none',
      null,
      {},
    ];

    for (const answer of answers) {
      tv.evaluate(`globalThis.__answer = ${JSON.stringify(answer)}`);
      expect(tv.evaluate('readMantelItems(globalThis.__answer)')).toEqual(readMantelItems(answer));
    }
    expect(tv.evaluate('MAX_MANTEL')).toBe(MAX_MANTEL);
  });

  it('says so calmly when a picture’s address has stopped answering, and asks the server again — once', () => {
    const tv = opened([kept('p1'), kept('p2')]);

    tv.failPicture();
    expect(tv.pictures()).toEqual([]);
    expect(tv.says()).toEqual(['The picture cannot be shown just now.', 'From Sarah · 1 of 2', 'Previous', 'Next', 'Back']);
    expect(tv.sent().slice(2)).toEqual([{ t: 'mantel' }]);

    // The next picture of the same answer fails too: it has been asked already.
    tv.press('Next');
    tv.failPicture();
    expect(tv.sent().slice(2)).toEqual([{ t: 'mantel' }]);

    // The new answer brings new addresses, and the picture is tried again.
    tv.control({ t: 'mantel', items: [kept('p1'), { ...kept('p2'), url: 'https://pictures.example/p2.jpg?again=1' }] });
    expect(tv.pictures()).toEqual([{ src: 'https://pictures.example/p2.jpg?again=1', alt: 'A picture from Sarah' }]);
  });

  it('gives way to a card: on this page every card is drawn as it arrives', () => {
    const tv = opened([kept('p1')]);

    tv.card(NOTE('See you on Sunday.'));

    expect(tv.says()).toEqual(['Message from Sarah', 'See you on Sunday.']);
    // And the mantelpiece is not what is underneath when the card is gone.
    tv.control({ t: 'revoke', cardId: 'note-1' });
    expect(tv.says()).toEqual(['No card currently shown.', 'Light on', 'Mantelpiece']);
  });

  it('keeps an answer that comes when the mantelpiece is not open off the screen', () => {
    const tv = television();
    tv.home({ light: 'on', mantel: 1 });

    tv.control({ t: 'mantel', items: [kept('p1')] });

    expect(tv.says()).toEqual(['No card currently shown.', 'Light on', 'Mantelpiece']);
    expect(tv.pictures()).toEqual([]);
  });

  it('is in Spanish when her television is', () => {
    const tv = opened([kept('p1'), kept('p2')], { mantel: 2, language: 'es' });

    expect(tv.says()).toEqual(['De Sarah · 1 de 2', 'Anterior', 'Siguiente', 'Atrás']);
    tv.pressPicture();
    expect(tv.says().slice(1)).toEqual(['Una foto de Sarah.', 'Nadie se entera si la quita.', 'Dejarla', 'Quitarla']);
  });

  it('leaves a family member’s own television alone: nothing of the mantelpiece is in its part of the page', () => {
    const script = readFileSync(fileURLToPath(new URL('../device.js', import.meta.url)), 'utf8');
    const familyMode = script.slice(script.indexOf("/* --- A family member's own television"), script.indexOf('/* --- Telemetry'));

    expect(familyMode).not.toMatch(/mantel|PHOTO/i);
  });
});

/*
 * Read to me (packages/contracts speech.ts) on the resident's television in
 * the browser: the P key is its Play key. No sound is made here — an
 * `Audio` is only ever an address, and none is fetched.
 */
describe('the browser television — read to me', () => {
  const SPEECH = 'https://speech.example/tts/hh-1/abc.mp3?X-Amz-Signature=s';
  /** Connected, with a note on screen. */
  const withNote = (home: Record<string, unknown> = { light: 'on' }) => {
    const tv = television();
    tv.home(home);
    tv.card(NOTE('See you on Sunday.'));
    return tv;
  };
  const asked = (tv: ReturnType<typeof television>) => tv.sent().filter((event) => event.t === 'read');

  it('asks for the card on screen when P is pressed, once, and waits for the answer', () => {
    const tv = withNote();

    tv.key('p');

    expect(asked(tv)).toEqual([{ t: 'read', cardId: 'note-1' }]);
    expect(tv.sounds).toEqual([]);
  });

  it('takes the browser’s own Play/Pause key and a capital P for the same thing', () => {
    for (const key of ['P', 'MediaPlayPause']) {
      const tv = withNote();
      tv.key(key);
      expect(asked(tv), key).toHaveLength(1);
    }
  });

  it('does nothing on P when no card is on screen, and nothing on any other key', () => {
    const tv = television();
    tv.home({ light: 'on' });
    tv.key('p');

    const note = withNote();
    for (const key of ['Enter', 'ArrowRight', ' ', 'x', 'Escape']) note.key(key);

    expect(asked(tv)).toEqual([]);
    expect(asked(note)).toEqual([]);
  });

  it('plays the answer for that card, from its https address', () => {
    const tv = withNote();
    tv.key('p');

    tv.control({ t: 'speech', cardId: 'note-1', url: SPEECH });

    expect(tv.sounds.map((sound) => [sound.src, sound.played])).toEqual([[SPEECH, 1]]);
  });

  it('stops on P pressed again, and asks for nothing', () => {
    const tv = withNote();
    tv.key('p');
    tv.control({ t: 'speech', cardId: 'note-1', url: SPEECH });

    tv.key('p');

    expect(tv.sounds[0]!.paused).toBe(1);
    expect(asked(tv)).toHaveLength(1);
    // And P after that asks again.
    tv.key('p');
    expect(asked(tv)).toHaveLength(2);
  });

  it('plays nothing for an answer about another card, one it did not ask for, or one with no https address', () => {
    const tv = withNote();
    tv.control({ t: 'speech', cardId: 'note-1', url: SPEECH });
    tv.key('p');
    tv.control({ t: 'speech', cardId: 'door-9', url: SPEECH });
    tv.control({ t: 'speech', cardId: 'note-1' });
    expect(tv.sounds).toEqual([]);

    for (const url of ['http://speech.example/a.mp3', 'javascript:alert(1)', 7]) {
      const other = withNote();
      other.key('p');
      other.control({ t: 'speech', cardId: 'note-1', url });
      expect(other.sounds, String(url)).toEqual([]);
      // A quiet nothing: she can ask again.
      other.key('p');
      expect(asked(other)).toHaveLength(2);
    }
  });

  it('is cut short when the card leaves the screen: another card comes, it is taken back, or it is answered', () => {
    const ways: Record<string, (tv: ReturnType<typeof television>) => void> = {
      'another card': (tv) => tv.card(LANGUAGE_CARD),
      'taken back': (tv) => tv.control({ t: 'revoke', cardId: 'note-1' }),
    };
    for (const [way, out] of Object.entries(ways)) {
      const tv = withNote();
      tv.key('p');
      tv.control({ t: 'speech', cardId: 'note-1', url: SPEECH });

      out(tv);

      expect(tv.sounds[0]!.paused, way).toBe(1);
    }

    const answered = television();
    answered.home({});
    answered.card(LANGUAGE_CARD);
    answered.key('p');
    answered.control({ t: 'speech', cardId: 'language-es', url: SPEECH });
    answered.press('No, keep English');
    expect(answered.sounds[0]!.paused).toBe(1);
  });

  it('goes on when the same card is drawn again', () => {
    const tv = withNote();
    tv.key('p');
    tv.control({ t: 'speech', cardId: 'note-1', url: SPEECH });

    tv.card(NOTE('See you on Sunday.'));
    tv.home({ light: 'out' });

    expect(tv.sounds[0]!.paused).toBe(0);
  });

  it('is over when the reading ends or cannot be played, and P then asks again', () => {
    for (const how of ['onended', 'onerror'] as const) {
      const tv = withNote();
      tv.key('p');
      tv.control({ t: 'speech', cardId: 'note-1', url: SPEECH });

      tv.sounds[0]![how]!();
      tv.key('p');

      expect(asked(tv), how).toHaveLength(2);
    }
  });

  it('turns a film that is playing down for the voice, and puts it back exactly — when the reading ends, and when it is stopped', () => {
    for (const out of ['ended', 'stopped'] as const) {
      const tv = withNote();
      tv.evaluate('film = { video: { volume: 0.8 }, layer: null, timer: 0, together: null }, true');
      tv.key('p');
      tv.control({ t: 'speech', cardId: 'note-1', url: SPEECH });
      expect(tv.evaluate('film.video.volume'), out).toBe(0.8);

      tv.sounds[0]!.onplaying!();
      expect(tv.evaluate('film.video.volume'), out).toBe(0.3);

      if (out === 'ended') tv.sounds[0]!.onended!();
      else tv.key('p');
      expect(tv.evaluate('film.video.volume'), out).toBe(0.8);
      tv.evaluate('film = null, true');
    }
  });

  it('marks every card with the key that reads it — a mark with no words, said in her language, that is not one of the card’s buttons', () => {
    const tv = withNote();
    expect(tv.marks()).toEqual(['Press P to hear this.']);
    expect(tv.buttons()).toEqual([]);
    expect(tv.says()).toEqual(['Message from Sarah', 'See you on Sunday.']);

    const spanish = withNote({ language: 'es' });
    expect(spanish.marks()).toEqual(['Presione P para oír esto.']);

    const none = television();
    none.home({ light: 'on' });
    expect(none.marks()).toEqual([]);
  });

  it('reads on a click on that mark, as on the key', () => {
    const tv = withNote();

    tv.pressMark();

    expect(asked(tv)).toEqual([{ t: 'read', cardId: 'note-1' }]);
  });

  it('leaves a family member’s own television alone: P is not its key, and nothing of reading is in its part of the page', () => {
    const script = readFileSync(fileURLToPath(new URL('../device.js', import.meta.url)), 'utf8');
    const familyMode = script.slice(script.indexOf("/* --- A family member's own television"), script.indexOf('/* --- Telemetry'));

    expect(familyMode).not.toMatch(/toggleRead|stopRead|readHint|t: 'read'/);
    expect(script).toMatch(/function residentKey\(event\) \{\s*if \(family\) return;/);
  });
});

/**
 * The television's requests to the Wick server, with the page's clock and
 * its network stood in for: a timer is fired by hand, and an answer comes
 * only when a test gives one. Nothing here waits in real time.
 */
function televisionAsking(remembered: Record<string, string> = {}) {
  const tab = new Map(Object.entries(remembered));
  const sockets: string[] = [];
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
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const intervals: { fn: () => void; ms: number }[] = [];
  const asked: { path: string; method: string; as: string | undefined; aborted: () => boolean; answer: (status: number, body: unknown) => void }[] = [];
  const context = vm.createContext({
    document: { getElementById: element, createElement: element, addEventListener() {}, removeEventListener() {}, head: element(), hidden: false, activeElement: null },
    window: {},
    console,
    URL,
    AbortController,
    // What this tab remembers, and nothing that outlives it: the page must never reach for localStorage.
    sessionStorage: { getItem: (key: string) => tab.get(key) ?? null, setItem: (key: string, value: string) => void tab.set(key, value), removeItem: (key: string) => void tab.delete(key) },
    get localStorage() { throw new Error('the page reached for localStorage'); },
    WebSocket: class { static OPEN = 1; readyState = 0; constructor(url: string) { sockets.push(url); } send() {} close() {} },
    setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms, cleared: false }) - 1,
    clearTimeout: (id: number) => { if (timers[id]) timers[id].cleared = true; },
    setInterval: (fn: () => void, ms: number) => intervals.push({ fn, ms }) - 1,
    clearInterval() {},
    // As a browser's: no answer until one is given, and a rejection the moment the request is given up.
    fetch: (url: string, init: { method?: string; signal?: AbortSignal; headers?: Record<string, string> } = {}) =>
      new Promise((resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })));
        asked.push({
          // The server's address is a placeholder until the page is published: the path is what follows it.
          path: url.slice(url.indexOf('/tv/')),
          method: init.method ?? 'GET',
          as: init.headers?.Authorization,
          aborted: () => init.signal?.aborted === true,
          answer: (status, body) => resolve({ status, ok: status >= 200 && status < 300, json: async () => body }),
        });
      }),
  });
  vm.runInContext(readFileSync(fileURLToPath(new URL('../device.js', import.meta.url)), 'utf8'), context, { filename: 'device.js' });
  const run = (code: string) => vm.runInContext(code, context) as unknown;
  return {
    asked,
    tab,
    sockets,
    run,
    /** Lets everything that can happen without a timer or an answer happen. */
    settle: () => new Promise<void>((resolve) => setImmediate(resolve)),
    /** The limit running on the request asked most recently on a path. */
    limits: () => timers.filter((t) => !t.cleared && t.ms === run('FAMILY_ASK_LIMIT_MS')),
    fire: (timer: { fn: () => void; cleared: boolean }) => { timer.cleared = true; timer.fn(); },
    /** The page's own interval of that length comes round. */
    tick: (ms: number) => intervals.filter((i) => i.ms === ms).forEach((i) => i.fn()),
    paths: () => asked.map((a) => `${a.method} ${a.path}`),
  };
}

describe('familyAsk — a request that never answers does not freeze the television', () => {
  it('waits ten seconds for an answer, and no longer', () => {
    expect(device.constant('FAMILY_ASK_LIMIT_MS')).toBe(10_000);
  });

  it('gives a home look up after the limit — and the next look goes out when its turn comes round', async () => {
    const tv = televisionAsking();
    tv.run('enterFamilyView("the.television.token", "tv-1")');
    await tv.settle();
    expect(tv.paths()).toEqual(['GET /tv/home']);

    // Nothing answers. The interval comes round twice: no second look is sent on top of the one still out.
    tv.tick(FAMILY_TV_LOOK_EVERY_MS);
    await tv.settle();
    expect(tv.paths()).toEqual(['GET /tv/home']);

    // The limit passes: the request is given up, as a failed ask like any other.
    expect(tv.limits()).toHaveLength(1);
    tv.fire(tv.limits()[0]!);
    await tv.settle();
    expect(tv.asked[0]!.aborted()).toBe(true);

    // And the television is asking again at the very next interval.
    tv.tick(FAMILY_TV_LOOK_EVERY_MS);
    await tv.settle();
    expect(tv.paths()).toEqual(['GET /tv/home', 'GET /tv/home']);
    expect(tv.asked[1]!.aborted()).toBe(false);
  });

  it('stops the clock on a request that is answered', async () => {
    const tv = televisionAsking();
    tv.run('enterFamilyView("the.television.token", "tv-1")');
    await tv.settle();
    tv.asked[0]!.answer(200, { residentName: 'Margaret', memberName: 'Sarah', cards: [] });
    await tv.settle();

    expect(tv.limits()).toEqual([]);
    expect(tv.asked[0]!.aborted()).toBe(false);
  });

  it('fails a press that never answers after the limit, so its button can be pressed again', async () => {
    const tv = televisionAsking();
    tv.run('enterFamilyView("the.television.token", "tv-1")');
    await tv.settle();
    tv.asked[0]!.answer(200, { residentName: 'Margaret', memberName: 'Sarah', cards: [] });
    await tv.settle();

    const press = tv.run('familyAsk(family, "/tv/press", { method: "POST", body: "{}" })') as Promise<unknown>;
    const outcome = press.then(() => 'answered', (err: Error) => `failed: ${err.message}`);
    await tv.settle();
    expect(tv.paths()).toEqual(['GET /tv/home', 'POST /tv/press']);
    tv.fire(tv.limits()[0]!);

    expect(await outcome).toMatch(/^failed: .*no answer/);
  });
});

describe('familyAsk — the seat has a lane of its own', () => {
  const asking = async () => {
    const tv = televisionAsking();
    tv.run('enterFamilyView("the.television.token", "tv-1")');
    await tv.settle();
    // The home look is out, and slow.
    expect(tv.paths()).toEqual(['GET /tv/home']);
    return tv;
  };

  it('asks for the seat at once, though a home look is still out', async () => {
    const tv = await asking();

    void (tv.run('familyAsk(family, "/tv/seat")') as Promise<unknown>).catch(() => {});
    await tv.settle();

    expect(tv.paths()).toEqual(['GET /tv/home', 'GET /tv/seat']);
  });

  it('never has two seat requests out at once', async () => {
    const tv = await asking();

    void (tv.run('familyAsk(family, "/tv/seat")') as Promise<unknown>).catch(() => {});
    void (tv.run('familyAsk(family, "/tv/seat")') as Promise<unknown>).catch(() => {});
    await tv.settle();
    expect(tv.paths()).toEqual(['GET /tv/home', 'GET /tv/seat']);

    tv.asked[1]!.answer(200, {});
    await tv.settle();
    expect(tv.paths()).toEqual(['GET /tv/home', 'GET /tv/seat', 'GET /tv/seat']);
  });

  it('keeps a press behind a home look, and a home look behind a press: never two of those at once', async () => {
    const tv = await asking();

    void (tv.run('familyAsk(family, "/tv/press", { method: "POST", body: "{}" })') as Promise<unknown>).catch(() => {});
    await tv.settle();
    expect(tv.paths()).toEqual(['GET /tv/home']);

    tv.asked[0]!.answer(200, { residentName: 'Margaret', memberName: 'Sarah', cards: [] });
    await tv.settle();
    expect(tv.paths()).toEqual(['GET /tv/home', 'POST /tv/press']);

    void (tv.run('familyAsk(family, "/tv/home")') as Promise<unknown>).catch(() => {});
    await tv.settle();
    expect(tv.paths()).toEqual(['GET /tv/home', 'POST /tv/press']);
  });

  it('is not held up by a home look that never answers at all', async () => {
    const tv = await asking();

    for (let look = 0; look < 3; look += 1) {
      const seat = tv.run('familyAsk(family, "/tv/seat")') as Promise<unknown>;
      await tv.settle();
      tv.asked.at(-1)!.answer(200, {});
      await seat;
    }

    expect(tv.paths()).toEqual(['GET /tv/home', 'GET /tv/seat', 'GET /tv/seat', 'GET /tv/seat']);
    expect(tv.asked[0]!.aborted()).toBe(false);
  });
});

describe('a note’s replies are its buttons — as on the television (apps/tv-vega cards/messageActions.ts)', () => {
  const note = (suggestedReplies: unknown, actions: unknown = []) => ({ type: 'MESSAGE', id: 'note-1', fromName: 'Sarah', transcript: 'The plumber is coming at ten.', suggestedReplies, actions });

  it('draws each reply as a button that sends reply_<n>, the first one first', () => {
    for (const replies of [['Thank you'], ['Wave back', 'Not now'], ['Yes', 'No', 'Later']]) {
      expect(device.cardButtons!(note(replies))).toEqual(replyActions(replies));
    }
    expect(device.cardButtons!(note(['Wave back', 'Not now']))).toEqual([
      { id: 'reply_0', label: 'Wave back', kind: 'primary' },
      { id: 'reply_1', label: 'Not now', kind: 'secondary' },
    ]);
  });

  it('never draws a fourth, and none for a note with nothing to answer', () => {
    expect(device.cardButtons!(note(['One', 'Two', 'Three', 'Four']))).toEqual(replyActions(['One', 'Two', 'Three', 'Four']));
    expect(device.cardButtons!(note(['One', 'Two', 'Three', 'Four']))).toHaveLength(MAX_CARD_ACTIONS);
    expect(device.cardButtons!(note([]))).toEqual([]);
    expect(device.cardButtons!(note(undefined))).toEqual([]);
  });

  it('leaves every other card its own buttons', () => {
    const actions = [{ id: 'allow', label: 'Allow Sarah', kind: 'primary' }, { id: 'decline', label: 'No, thank you', kind: 'secondary' }];

    expect(device.cardButtons!({ type: 'CIRCLE', id: 'circle-u1', actions })).toEqual(actions);
    expect(device.cardButtons!({ type: 'WEEK', id: 'week-1' })).toEqual([]);
  });
});

describe('finishesCard — what a press does to the card, as the television’s own app decides it (cardActions.ts removesCard)', () => {
  const PRESSES = ['reply_0', 'reply_1', 'dismiss', 'watch_live', 'hallway_chime', 'ask_family', 'seen', 'sharing', 'toggle', 'next', 'done', 'ring_me', 'say_hello', 'not_now', 'ok', 'allow', 'decline', 'tell_family', 'keep_private', 'accept', 'start', 'loved_it', 'right', 'wrong', ...Object.values(LANGUAGE_ACTIONS), ...Object.values(PHOTO_ACTIONS)];
  const TYPES = ['DOOR', 'MESSAGE', 'WEEK', 'SHARING', 'CIRCLE', 'TELL', 'WATCH', 'LIGHT', 'REACH', 'VISIT', 'LANGUAGE', 'PHOTO'];

  it.each(TYPES)('agrees with it for every press on a %s card', (type) => {
    for (const press of PRESSES) {
      expect([press, device.finishesCard!({ type, id: 'c1' }, press)]).toEqual([press, removesCard({ type, id: 'c1' } as unknown as Card, press)]);
    }
  });

  it('finishes a note when one of its replies is pressed: “Wave back” is an answer, and the card is done', () => {
    expect(device.finishesCard!({ type: 'MESSAGE', id: 'note-wave-1' }, 'reply_0')).toBe(true);
  });

  it('finishes the question about her language on either answer: her yes and her no are both the whole of it', () => {
    for (const press of Object.values(LANGUAGE_ACTIONS)) expect(device.finishesCard!({ type: 'LANGUAGE', id: languageCardId('es') }, press)).toBe(true);
  });

  it('finishes a picture’s card on either answer: “Keep it” and “Thank you” both put it away', () => {
    for (const press of Object.values(PHOTO_ACTIONS)) expect(device.finishesCard!({ type: 'PHOTO', id: photoCardId('p1') }, press)).toBe(true);
  });
});

describe('the cards this television has been sent and not finished', () => {
  const queued = (id: string, extra: object = {}, urgency = 'DEFERRED') => ({ id, urgency, queuedAt: 1, shownCount: 0, card: { type: 'WATCH', id, headline: id }, ...extra });
  const NOW = 1_791_900_000_000;
  const ids = (kept: unknown) => (kept as { id: string }[]).map((q) => q.id);
  const shown = (kept: unknown) => (device.cardToShow!(kept, NOW) as { id: string } | undefined)?.id;

  it('shows the newest, and keeps what it covers', () => {
    const kept = device.keepCard!(device.keepCard!([], queued('watch-question-s1')), queued('watch-answer-s1'));

    expect(ids(kept)).toEqual(['watch-question-s1', 'watch-answer-s1']);
    expect(shown(kept)).toBe('watch-answer-s1');
  });

  it('brings back the one before when the newest is finished: her open question is not lost to a later card', () => {
    const kept = device.keepCard!(device.keepCard!([], queued('watch-question-s1')), queued('watch-answer-s1'));

    const after = device.dropCard!(kept, 'watch-answer-s1');

    expect(shown(after)).toBe('watch-question-s1');
    expect(shown(device.dropCard!(after, 'watch-question-s1'))).toBeUndefined();
  });

  it('replaces a card sent again under the same id, and shows it as the newest', () => {
    let kept = device.keepCard!([], queued('reach-1', { card: { type: 'REACH', id: 'reach-1', headline: 'Ask Sarah to ring you?' } }));
    kept = device.keepCard!(kept, queued('note-1'));
    kept = device.keepCard!(kept, queued('reach-1', { card: { type: 'REACH', id: 'reach-1', headline: 'Sarah has been asked to ring you.' } }));

    expect(ids(kept)).toEqual(['note-1', 'reach-1']);
    expect((device.cardToShow!(kept, NOW) as { card: { headline: string } }).card.headline).toBe('Sarah has been asked to ring you.');
  });

  it('takes a revoked card away, wherever it was', () => {
    const kept = [queued('a'), queued('b'), queued('c')];

    expect(ids(device.dropCard!(kept, 'b'))).toEqual(['a', 'c']);
    expect(ids(device.dropCard!(kept, 'not-there'))).toEqual(['a', 'b', 'c']);
  });

  it('gives a patch to the card with that id, whether or not it is the one showing', () => {
    const kept = [queued('door-1', { card: { type: 'DOOR', id: 'door-1', line: 'Someone is at the door.', actions: [{ id: 'dismiss', label: 'Not now', kind: 'dismiss' }] } }), queued('note-1')];

    const patched = device.patchCard!(kept, { cardId: 'door-1', notice: 'Sarah has been asked to look.', description: undefined }) as { id: string; card: Record<string, unknown> }[];

    expect(ids(patched)).toEqual(['door-1', 'note-1']);
    expect(patched[0]!.card).toEqual({ type: 'DOOR', id: 'door-1', line: 'Someone is at the door.', actions: [{ id: 'dismiss', label: 'Not now', kind: 'dismiss' }], notice: 'Sarah has been asked to look.' });
    expect(patched[1]).toEqual(kept[1]);
    // A patch for a card this television does not hold changes nothing.
    expect(device.patchCard!(kept, { cardId: 'gone', notice: 'x' })).toEqual(kept);
  });

  it('shows the door card over anything, the moment it arrives', () => {
    const kept = device.keepCard!([queued('watch-question-s1'), queued('note-1')], queued('door-9', { expiresAt: NOW + 300_000 }, 'DOOR'));

    expect(shown(kept)).toBe('door-9');
  });

  it('does not bring back a card whose time has passed: a doorbell of ten minutes ago is not shown again', () => {
    const kept = [queued('note-1'), queued('door-9', { expiresAt: NOW - 1 }, 'DOOR')];

    expect(shown(kept)).toBe('note-1');
    expect(shown([queued('door-9', { expiresAt: NOW - 1 }, 'DOOR')])).toBeUndefined();
  });
});

describe('a television survives a reload of its tab', () => {
  const HOME_OK = { residentName: 'Margaret', memberName: 'Sarah', cards: [] };
  const KEY = 'wick_virtual_television';

  it('keeps a “Mine” television’s token in this tab’s own storage, and nowhere that outlives the tab', () => {
    const tv = televisionAsking();

    tv.run('rememberTelevision({ kind: "family", jwt: "the.family.token", deviceId: "tv-1" })');

    expect(JSON.parse(tv.tab.get(KEY)!)).toEqual({ kind: 'family', jwt: 'the.family.token', deviceId: 'tv-1' });
    // localStorage in this harness throws if it is so much as read: getting here means it was not.
  });

  it('goes straight to the family view on load when the tab remembers one, asking with that token — and opens no device channel', async () => {
    const tv = televisionAsking({ [KEY]: JSON.stringify({ kind: 'family', jwt: 'the.family.token', deviceId: 'tv-1' }) });
    await tv.settle();

    expect(tv.asked.map((a) => [a.method, a.path, a.as])).toEqual([['GET', '/tv/home', 'Bearer the.family.token']]);
    expect(tv.sockets).toEqual([]);
  });

  it('asks nobody on load when the tab remembers nothing, or something it cannot read', async () => {
    for (const remembered of [{}, { [KEY]: 'not json' }, { [KEY]: JSON.stringify({ kind: 'family', deviceId: 'tv-1' }) }, { [KEY]: JSON.stringify({ kind: 'other', jwt: 't', deviceId: 'tv-1' }) }]) {
      const tv = televisionAsking(remembered);
      await tv.settle();

      expect(tv.asked).toEqual([]);
      expect(tv.sockets).toEqual([]);
    }
  });

  it('forgets a remembered television the server no longer knows (401), and asks no more', async () => {
    const tv = televisionAsking({ [KEY]: JSON.stringify({ kind: 'family', jwt: 'the.family.token', deviceId: 'tv-1' }) });
    await tv.settle();
    tv.asked[0]!.answer(401, { error: 'unauthorized' });
    await tv.settle();

    expect(tv.tab.has(KEY)).toBe(false);
    expect(tv.run('family')).toBe(null);
    tv.tick(FAMILY_TV_LOOK_EVERY_MS);
    await tv.settle();
    expect(tv.asked).toHaveLength(1);
  });

  it('keeps it through an answer that the resident does not allow this member just now (403): that can change', async () => {
    const tv = televisionAsking({ [KEY]: JSON.stringify({ kind: 'family', jwt: 'the.family.token', deviceId: 'tv-1' }) });
    await tv.settle();
    tv.asked[0]!.answer(403, { error: 'not_allowed', say: 'Margaret chose not to share this with you.' });
    await tv.settle();

    expect(tv.tab.has(KEY)).toBe(true);
  });

  it('opens the resident’s own television’s channel again on load when that is what the tab remembers — and asks the Wick server nothing', async () => {
    const tv = televisionAsking({ [KEY]: JSON.stringify({ kind: 'resident', jwt: 'the.device.token', deviceId: 'tv-2' }) });
    await tv.settle();

    expect(tv.sockets).toHaveLength(1);
    expect(tv.sockets[0]).toContain('token=the.device.token');
    expect(tv.asked).toEqual([]);
    void HOME_OK;
  });
});

/*
 * Where the two meet: the cards this television keeps until they are
 * finished (keptCards), and the language she chose.
 */
describe('the browser television — the cards it keeps, and her language', () => {
  it('brings back the card under the question when she says yes, and has it again in her language without calling it shown anew', () => {
    const tv = television();
    tv.home({ light: 'on' });
    tv.card(NOTE('See you on Sunday.'));
    tv.card(LANGUAGE_CARD);

    tv.press('Sí, en español');

    // Her answer finishes the question; the note it covered is back, and is said to be shown again.
    expect(tv.says()).toEqual(['Message from Sarah', 'See you on Sunday.']);
    expect(tv.sent().slice(3)).toEqual([
      { t: 'card_action', cardId: 'language-es', action: LANGUAGE_ACTIONS.yes },
      { t: 'card_shown', cardId: 'note-1' },
    ]);

    // The home says Spanish: the page's own label at once, and the cards asked for again, once.
    tv.home({ light: 'on', language: 'es' });
    expect(tv.says()).toEqual(['Mensaje de Sarah', 'See you on Sunday.']);

    // The note sent again takes the place of the one kept under its id.
    tv.card(NOTE('Nos vemos el domingo.'));
    expect(tv.says()).toEqual(['Mensaje de Sarah', 'Nos vemos el domingo.']);
    expect(tv.sent().slice(5)).toEqual([{ t: 'reconcile' }]);
    expect(tv.evaluate('keptCards.map((queued) => queued.card.id)')).toEqual(['note-1']);
  });

  it('brings back the card under the question when she says no, too', () => {
    const tv = television();
    tv.home({ light: 'on' });
    tv.card(NOTE('See you on Sunday.'));
    tv.card(LANGUAGE_CARD);

    tv.press('No, keep English');

    expect(tv.says()).toEqual(['Message from Sarah', 'See you on Sunday.']);
    expect(tv.evaluate('keptCards.map((queued) => queued.card.id)')).toEqual(['note-1']);
  });

  it('never keeps a card of a kind it does not know: nothing unknown comes back when the card on screen is put away', () => {
    const tv = television();
    tv.home({ light: 'on' });
    tv.card(queuedCard({ id: 'new-1', type: 'SOMETHING_NEW', headline: 'A new thing', actions: [{ id: 'ok', label: 'OK', kind: 'primary' }] }));
    tv.card(LANGUAGE_CARD);
    tv.card(queuedCard({ id: 'new-2', type: 'SOMETHING_NEW', headline: 'Another', actions: [{ id: 'ok', label: 'OK', kind: 'primary' }] }));

    expect(tv.evaluate('keptCards.map((queued) => queued.card.id)')).toEqual(['language-es']);

    tv.press('No, keep English');

    expect(tv.says()).toEqual(['No card currently shown.', 'Light on']);
    expect(tv.evaluate('keptCards')).toEqual([]);
  });
});

/*
 * Where three things meet on the resident's television in the browser: the
 * cards it keeps until they are finished (keptCards), a picture from the
 * family and her mantelpiece, and a card read aloud. Each is tested by
 * itself above; here, what one does to another.
 */
describe('the browser television — a picture among the cards it keeps', () => {
  const keptIds = (tv: ReturnType<typeof television>) => tv.evaluate('keptCards.map((queued) => queued.card.id)');

  it('brings back the card under a picture she has answered, and shows the picture again over it when the server sends it back because her mantelpiece is full', () => {
    const tv = television();
    tv.home({ light: 'on' });
    tv.card(NOTE('See you on Sunday.'));
    tv.card(PHOTO());

    tv.press('Keep it');
    // Her answer finishes the picture's card; the note it covered is back, and said to be shown again.
    expect(tv.says()).toEqual(['Message from Sarah', 'See you on Sunday.']);
    expect(keptIds(tv)).toEqual(['note-1']);

    tv.card(PHOTO({ notice: MANTEL_FULL_NOTICE }));

    expect(tv.says()).toEqual(['A picture', 'A picture from Sarah.', MANTEL_FULL_NOTICE, 'Keep it', 'Thank you']);
    expect(keptIds(tv)).toEqual(['note-1', 'photo-p1']);
    expect(tv.sent().slice(3)).toEqual([
      { t: 'card_action', cardId: 'photo-p1', action: PHOTO_ACTIONS.keep },
      { t: 'card_shown', cardId: 'note-1' },
      { t: 'card_shown', cardId: 'photo-p1' },
    ]);

    // "Thank you" then puts it away for good, and the note is still there under it.
    tv.press('Thank you');
    expect(tv.says()).toEqual(['Message from Sarah', 'See you on Sunday.']);
    expect(keptIds(tv)).toEqual(['note-1']);
  });

  it('replaces the copy it keeps when a picture is sent again under the same id, and shows it as the newest — once', () => {
    const tv = television();
    tv.home({ light: 'on' });
    tv.card(PHOTO());
    tv.card(NOTE('See you on Sunday.'));
    expect(keptIds(tv)).toEqual(['photo-p1', 'note-1']);

    tv.card(PHOTO({ notice: MANTEL_FULL_NOTICE }));

    // One copy, the one with the line that says so, and it is the one on screen.
    expect(keptIds(tv)).toEqual(['note-1', 'photo-p1']);
    expect(tv.says()).toEqual(['A picture', 'A picture from Sarah.', MANTEL_FULL_NOTICE, 'Keep it', 'Thank you']);
    expect(tv.sent().slice(1)).toEqual([
      { t: 'card_shown', cardId: 'photo-p1' },
      { t: 'card_shown', cardId: 'note-1' },
      { t: 'card_shown', cardId: 'photo-p1' },
    ]);

    // Sent once more while it is the card on screen: drawn again in place, and not said to be shown anew.
    tv.card(PHOTO({ notice: MANTEL_FULL_NOTICE }));
    expect(keptIds(tv)).toEqual(['note-1', 'photo-p1']);
    expect(tv.sent()).toHaveLength(4);
  });

  it('closes her mantelpiece for any card that arrives, and it is the card kept under that one — never the mantelpiece — that comes back', () => {
    const tv = television();
    tv.home({ light: 'on', mantel: 3 });
    tv.press('Mantelpiece');
    tv.control({ t: 'mantel', items: [kept('p1')] });

    tv.card(NOTE('See you on Sunday.'));
    tv.card(PHOTO());
    expect(tv.says()).toEqual(['A picture', 'A picture from Sarah.', 'Keep it', 'Thank you']);

    tv.press('Thank you');
    expect(tv.says()).toEqual(['Message from Sarah', 'See you on Sunday.']);

    tv.control({ t: 'revoke', cardId: 'note-1' });
    expect(tv.says()).toEqual(['No card currently shown.', 'Light on', 'Mantelpiece']);
    expect(keptIds(tv)).toEqual([]);
  });

  it('leaves her mantelpiece open for a card of a kind it does not know: nothing arrived that can be shown', () => {
    const tv = television();
    tv.home({ light: 'on', mantel: 3 });
    tv.press('Mantelpiece');
    tv.control({ t: 'mantel', items: [kept('p1')] });
    const open = tv.says();

    tv.card(queuedCard({ id: 'new-1', type: 'SOMETHING_NEW', headline: 'A new thing', actions: [] }));

    expect(tv.says()).toEqual(open);
    expect(keptIds(tv)).toEqual([]);
  });
});

describe('the browser television — a reading, and the cards it keeps', () => {
  const SPEECH = 'https://speech.example/tts/hh-1/abc.mp3?X-Amz-Signature=s';
  const OTHER = 'https://speech.example/tts/hh-1/def.mp3?X-Amz-Signature=s';
  const asked = (tv: ReturnType<typeof television>) => tv.sent().filter((event) => event.t === 'read');
  /** Connected, with a note kept under the question about her language, and that question being read aloud. */
  const readingOverANote = () => {
    const tv = television();
    tv.home({ light: 'on' });
    tv.card(NOTE('See you on Sunday.'));
    tv.card(LANGUAGE_CARD);
    tv.key('p');
    tv.control({ t: 'speech', cardId: 'language-es', url: SPEECH });
    return tv;
  };

  it('is cut short when the card on screen is answered and the one kept under it comes back — which is not read unasked', () => {
    const tv = readingOverANote();
    tv.evaluate('film = { video: { volume: 0.8 }, layer: null, timer: 0, together: null }, true');
    tv.sounds[0]!.onplaying!();
    expect(tv.evaluate('film.video.volume')).toBe(0.3);

    tv.press('No, keep English');

    expect(tv.says()).toEqual(['Message from Sarah', 'See you on Sunday.']);
    expect(tv.sounds[0]!.paused).toBe(1);
    // The film's sound is put back exactly, and nothing is asked or played for the card that came back.
    expect(tv.evaluate('film.video.volume')).toBe(0.8);
    expect(asked(tv)).toEqual([{ t: 'read', cardId: 'language-es' }]);
    expect(tv.sounds).toHaveLength(1);
  });

  it('reads the card that is on screen after the queue brings one back: P asks for that card, once, and only its answer is played', () => {
    const tv = readingOverANote();
    tv.press('No, keep English');

    tv.key('p');
    expect(asked(tv)).toEqual([{ t: 'read', cardId: 'language-es' }, { t: 'read', cardId: 'note-1' }]);

    // An answer that comes late for the card she has put away is not played over this one.
    tv.control({ t: 'speech', cardId: 'language-es', url: SPEECH });
    expect(tv.sounds).toHaveLength(1);

    tv.control({ t: 'speech', cardId: 'note-1', url: OTHER });
    expect(tv.sounds.map((sound) => [sound.src, sound.played, sound.paused])).toEqual([[SPEECH, 1, 1], [OTHER, 1, 0]]);
  });

  it('is cut short when a card arrives over the one being read, and is not taken up again when that card is put away', () => {
    const tv = television();
    tv.home({ light: 'on' });
    tv.card(NOTE('See you on Sunday.'));
    tv.key('p');
    tv.control({ t: 'speech', cardId: 'note-1', url: SPEECH });

    tv.card(PHOTO());
    expect(tv.sounds[0]!.paused).toBe(1);

    tv.press('Thank you');

    expect(tv.says()).toEqual(['Message from Sarah', 'See you on Sunday.']);
    expect(tv.sounds).toHaveLength(1);
    expect(asked(tv)).toEqual([{ t: 'read', cardId: 'note-1' }]);
    // She can ask again, for the note that is back.
    tv.key('p');
    expect(asked(tv)).toEqual([{ t: 'read', cardId: 'note-1' }, { t: 'read', cardId: 'note-1' }]);
  });

  it('goes on while a card kept underneath is changed or taken back, and stops when the one on screen is — the one under it then shows', () => {
    const tv = readingOverANote();

    tv.control({ t: 'patch', patch: { cardId: 'note-1', transcript: 'See you on Monday.' } });
    expect(tv.sounds[0]!.paused).toBe(0);
    expect(tv.says()[0]).toBe('English · español');

    tv.control({ t: 'revoke', cardId: 'language-es' });
    expect(tv.sounds[0]!.paused).toBe(1);
    // The note, as the patch left it while it was covered.
    expect(tv.says()).toEqual(['Message from Sarah', 'See you on Monday.']);

    const other = readingOverANote();
    other.control({ t: 'revoke', cardId: 'note-1' });
    expect(other.sounds[0]!.paused).toBe(0);
    expect(other.evaluate('keptCards.map((queued) => queued.card.id)')).toEqual(['language-es']);
  });

  it('goes on through a picture sent again under the id of the one being read, with the line that says her mantelpiece is full', () => {
    const tv = television();
    tv.home({ light: 'on' });
    tv.card(PHOTO());
    tv.key('p');
    tv.control({ t: 'speech', cardId: 'photo-p1', url: SPEECH });

    tv.card(PHOTO({ notice: MANTEL_FULL_NOTICE }));

    expect(tv.says()).toContain(MANTEL_FULL_NOTICE);
    expect(tv.sounds[0]!.paused).toBe(0);
  });
});

describe('device.html — what the page says about the resident’s television', () => {
  const html = readFileSync(fileURLToPath(new URL('../device.html', import.meta.url)), 'utf8');
  const count = (said: string): number => html.split(said).length - 1;

  it('says each thing once: the cards it keeps, the key that reads a card, and the mantelpiece', () => {
    expect(count('one still unanswered is kept')).toBe(1);
    expect(count('Reloading the tab keeps its television')).toBe(1);
    expect(count('<strong>P</strong> is the Play key')).toBe(1);
    expect(count('On the mantelpiece, a click on the picture is OK')).toBe(1);
    expect(count('As the resident’s television,')).toBe(2);
    expect(count('class="muted remote-hint"')).toBe(4);
  });
});
