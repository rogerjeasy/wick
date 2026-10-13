import { describe, expect, it } from 'vitest';
import { FAMILY_TV_WAVE_CARD, type FamilyTvCard, type FamilyTvHome } from '@wick/contracts';
import {
  ALL_RIGHT,
  afterPress,
  afterSeatAnswer,
  startingLines,
  SOMETHING_WAITS,
  somethingWaits,
  waveOf,
  familyLines,
  pictureToShow,
  pressed,
  putAway,
  sentenceAfterPress,
  showing,
  stillPutAway,
  unreachableLine,
  type PutAway,
} from '../familyScreen.js';

const REACH: FamilyTvCard = {
  id: 'ftv-reach-r1',
  kind: 'reach',
  headline: 'Margaret would like you to ring her.',
  detail: 'She asked a minute ago.',
  actions: [
    { id: 'calling', label: 'I’ll ring now', kind: 'primary' },
    { id: 'cannot', label: 'I can’t just now', kind: 'secondary' },
  ],
};
const DOOR: FamilyTvCard = {
  id: 'ftv-door_look-d1',
  kind: 'door_look',
  headline: 'Margaret asks: who is at the door?',
  pictureUrl: 'https://ring.example/snap-1.jpg',
  actions: [{ id: 'known', label: 'I know them', kind: 'primary' }],
};
const STANDING: FamilyTvCard = { id: 'ftv-reach-r0', kind: 'reach', headline: 'Tom said he will ring Margaret.', actions: [] };

const home = (cards: readonly FamilyTvCard[] = [], extra: Partial<FamilyTvHome> = {}): FamilyTvHome => ({ residentName: 'Margaret', memberName: 'Sarah', cards, ...extra });
const NONE: PutAway = {};

describe('familyLines — the words around the cards', () => {
  it('says whose home this looks towards, and whose television it is', () => {
    const lines = familyLines(home(), { unreachable: false, cardShown: false });

    expect(lines.heading).toBe('Margaret’s home');
    expect(lines.owner).toBe('This is Sarah’s television.');
  });

  it('says one calm sentence when nothing is on screen to answer', () => {
    expect(familyLines(home(), { unreachable: false, cardShown: false }).quiet).toEqual(['Nothing is waiting for you.']);
    expect(familyLines(home([REACH]), { unreachable: false, cardShown: true }).quiet).toEqual([]);
  });

  it('gives her light as the one sentence the server wrote', () => {
    const lit = home([], { light: { lit: true, line: 'Margaret’s light is on.' } });

    expect(familyLines(lit, { unreachable: false, cardShown: true }).quiet).toEqual(['Margaret’s light is on.']);
  });

  it('has nothing where the light would be when she keeps it to herself — no line, no gap, no hint', () => {
    const without = familyLines(home([REACH]), { unreachable: false, cardShown: true });

    expect(without.quiet).toEqual([]);
    expect(JSON.stringify(without)).not.toMatch(/light/i);
  });

  it('says a demo home is one, in the words the family app uses', () => {
    expect(familyLines(home([], { simulated: true }), { unreachable: false, cardShown: true }).quiet).toEqual(['This is a demo home. Its history is simulated.']);
  });

  it('says it cannot reach her home after the looks have failed', () => {
    expect(familyLines(home(), { unreachable: true, cardShown: true }).quiet).toEqual(['Wick cannot reach Margaret’s home just now.']);
    expect(unreachableLine('Margaret')).toBe('Wick cannot reach Margaret’s home just now.');
    expect(unreachableLine(undefined)).toBe('Wick cannot reach the home just now.');
  });

  it('puts first what a card must not cover: that the home is a demo, then that it cannot be reached, then the light', () => {
    const all = home([], { simulated: true, light: { lit: false, line: 'Margaret’s light is not lit.' } });

    expect(familyLines(all, { unreachable: true, cardShown: false }).quiet).toEqual([
      'This is a demo home. Its history is simulated.',
      'Wick cannot reach Margaret’s home just now.',
      'Margaret’s light is not lit.',
      'Nothing is waiting for you.',
    ]);
  });
});

describe('showing — which card is on screen, and its buttons', () => {
  it('is nothing when the home has no cards, or there is no home yet', () => {
    expect(showing(home(), NONE, undefined)).toEqual({ kind: 'nothing' });
    expect(showing(undefined, NONE, undefined)).toEqual({ kind: 'nothing' });
  });

  it('is the first card, with the headline, detail and buttons the server wrote', () => {
    const shown = showing(home([REACH, DOOR]), NONE, undefined);

    expect(shown).toMatchObject({ kind: 'card', card: REACH, actions: REACH.actions });
  });

  it('gives a card with no answers one button, "All right"', () => {
    const shown = showing(home([STANDING, REACH]), NONE, undefined);

    expect(shown).toMatchObject({ kind: 'card', card: STANDING, actions: [ALL_RIGHT] });
    expect(ALL_RIGHT.label).toBe('All right');
  });

  it('shows the next card once that one has been put away', () => {
    const put = putAway(NONE, STANDING);

    expect(showing(home([STANDING, REACH]), put, undefined)).toMatchObject({ kind: 'card', card: REACH });
    expect(showing(home([STANDING]), put, undefined)).toEqual({ kind: 'nothing' });
  });

  it('shows what the server said in place of the card, with one button, until it is pressed', () => {
    const shown = showing(home([REACH]), NONE, 'Margaret has been told you will ring.');

    expect(shown).toMatchObject({ kind: 'said', say: 'Margaret has been told you will ring.', actions: [ALL_RIGHT] });
  });

  it('remounts the card when it is another card or its buttons change, and not when only its words do', () => {
    const key = (h: FamilyTvHome, said?: string) => {
      const shown = showing(h, NONE, said);
      return shown.kind === 'nothing' ? undefined : shown.key;
    };

    expect(key(home([REACH]))).toBe(key(home([{ ...REACH, detail: 'She asked two minutes ago.' }])));
    expect(key(home([REACH]))).not.toBe(key(home([DOOR])));
    expect(key(home([REACH]))).not.toBe(key(home([{ ...REACH, actions: [REACH.actions[0]!] }])));
    expect(key(home([REACH]))).not.toBe(key(home([REACH]), 'Done.'));
  });
});

describe('putAway / stillPutAway — put away on this screen until what it says changes', () => {
  it('stays put away while the server goes on sending the same card', () => {
    const put = putAway(NONE, STANDING);

    expect(stillPutAway(put, home([STANDING, REACH]))).toBe(put);
  });

  it('comes back when the card says something else', () => {
    const put = putAway(NONE, STANDING);
    const changed = { ...STANDING, headline: 'Tom rang Margaret.' };

    expect(stillPutAway(put, home([changed]))).toEqual({});
    expect(showing(home([changed]), stillPutAway(put, home([changed])), undefined)).toMatchObject({ kind: 'card', card: changed });
  });

  it('comes back when the card gains an answer to give', () => {
    const put = putAway(NONE, STANDING);
    const asks = { ...STANDING, actions: REACH.actions };

    expect(stillPutAway(put, home([asks]))).toEqual({});
  });

  // Seen on the Fire OS emulator, 2026-10-13: a settled film card put away
  // with "All right" was showing again after a second film. The server had
  // stopped listing it during the second film and listed it again after —
  // and a card that one answer did not list used to be forgotten.
  it('stays put away while the server does not list it, and when it lists it again with the same words', () => {
    let put = putAway(NONE, STANDING);

    for (const look of [home([REACH]), home(), home([REACH, DOOR])]) put = stillPutAway(put, look);
    expect(put).toEqual(putAway(NONE, STANDING));

    const back = home([STANDING, REACH]);
    put = stillPutAway(put, back);
    expect(showing(back, put, undefined)).toMatchObject({ kind: 'card', card: REACH });
    expect(showing(home([STANDING]), put, undefined)).toEqual({ kind: 'nothing' });
  });

  it('is shown when it is listed again with different words', () => {
    let put = putAway(NONE, STANDING);
    for (const look of [home([REACH]), home()]) put = stillPutAway(put, look);

    const changed = { ...STANDING, headline: 'Tom rang Margaret.' };
    put = stillPutAway(put, home([changed]));

    expect(showing(home([changed]), put, undefined)).toMatchObject({ kind: 'card', card: changed });
  });

  it('keeps the very same memory when a look changes nothing in it, so nothing is drawn again for it', () => {
    const put = putAway(NONE, STANDING);

    expect(stillPutAway(put, home([REACH]))).toBe(put);
    expect(stillPutAway(put, home())).toBe(put);
  });

  it('remembers fifty cards at most, and lets go of the one put away longest ago', () => {
    const card = (n: number): FamilyTvCard => ({ id: `ftv-reach-${n}`, kind: 'reach', headline: `Card ${n}.`, actions: [] });
    let put: PutAway = NONE;
    for (let n = 1; n <= 51; n += 1) put = putAway(put, card(n));

    expect(Object.keys(put)).toHaveLength(50);
    expect(put).not.toHaveProperty('ftv-reach-1');
    expect(put).toHaveProperty('ftv-reach-2');
    expect(put).toHaveProperty('ftv-reach-51');
  });

  it('counts a card put away again as put away just now', () => {
    const card = (n: number): FamilyTvCard => ({ id: `ftv-reach-${n}`, kind: 'reach', headline: `Card ${n}.`, actions: [] });
    let put: PutAway = NONE;
    for (let n = 1; n <= 50; n += 1) put = putAway(put, card(n));
    put = putAway(put, card(1));
    put = putAway(put, card(51));

    expect(put).toHaveProperty('ftv-reach-1');
    expect(put).not.toHaveProperty('ftv-reach-2');
  });

  it('does not come back because the address of its picture changed', () => {
    const withPicture = { ...STANDING, pictureUrl: 'https://ring.example/a.jpg?sig=1' };
    const put = putAway(NONE, withPicture);

    expect(stillPutAway(put, home([{ ...withPicture, pictureUrl: 'https://ring.example/a.jpg?sig=2' }]))).toBe(put);
  });
});

describe('pressed — what a press on the card does', () => {
  it('sends the server the card and the action for one of its own buttons', () => {
    expect(pressed(showing(home([REACH]), NONE, undefined), 'calling')).toEqual({ do: 'send', press: { cardId: 'ftv-reach-r1', action: 'calling' } });
  });

  it('sends nothing for a button the card does not have', () => {
    expect(pressed(showing(home([REACH]), NONE, undefined), ALL_RIGHT.id)).toEqual({ do: 'nothing' });
    expect(pressed({ kind: 'nothing' }, 'calling')).toEqual({ do: 'nothing' });
  });

  it('only puts a card with no answers away: "All right" tells the server nothing', () => {
    expect(pressed(showing(home([STANDING]), NONE, undefined), ALL_RIGHT.id)).toEqual({ do: 'putAway', card: STANDING });
  });

  it('only takes the sentence away after a press was answered', () => {
    expect(pressed(showing(home([REACH]), NONE, 'Margaret has been told.'), ALL_RIGHT.id)).toEqual({ do: 'clearSaid' });
  });
});

describe('sentenceAfterPress — what takes the card\'s place', () => {
  it('is the server\'s sentence, whether or not the answer was done', () => {
    expect(sentenceAfterPress({ kind: 'said', done: true, say: 'Margaret has been told you will ring.' }, 'Margaret')).toBe('Margaret has been told you will ring.');
    expect(sentenceAfterPress({ kind: 'said', done: false, say: 'Tom has already answered.' }, 'Margaret')).toBe('Tom has already answered.');
  });

  it('says so, without claiming either way, when the press may not have arrived', () => {
    expect(sentenceAfterPress({ kind: 'failed' }, 'Margaret')).toBe('Wick could not reach Margaret’s home, so that may not have been sent.');
  });

  it('is nothing when the screen is about to change altogether', () => {
    expect(sentenceAfterPress({ kind: 'notAllowed', say: 'No longer.' }, 'Margaret')).toBeUndefined();
    expect(sentenceAfterPress({ kind: 'signedOut' }, 'Margaret')).toBeUndefined();
  });
});

describe('pictureToShow — the door picture, held still', () => {
  it('is the card\'s picture, and nothing for a card without one', () => {
    expect(pictureToShow(undefined, DOOR)).toEqual({ cardId: DOOR.id, url: 'https://ring.example/snap-1.jpg' });
    expect(pictureToShow(undefined, REACH)).toBeUndefined();
    expect(pictureToShow(undefined, undefined)).toBeUndefined();
  });

  it('keeps the address it already shows for the same card, so a look every few seconds does not load it again', () => {
    const first = pictureToShow(undefined, DOOR);

    expect(pictureToShow(first, { ...DOOR, pictureUrl: 'https://ring.example/snap-1.jpg?sig=2' })).toBe(first);
  });

  it('goes when the server no longer sends one, and changes with the card', () => {
    const first = pictureToShow(undefined, DOOR);
    const { pictureUrl: _gone, ...closed } = DOOR;

    expect(pictureToShow(first, closed)).toBeUndefined();
    expect(pictureToShow(first, { ...DOOR, id: 'ftv-door_look-d2', pictureUrl: 'https://ring.example/snap-2.jpg' })).toEqual({
      cardId: 'ftv-door_look-d2',
      url: 'https://ring.example/snap-2.jpg',
    });
  });
});

const WEEK: FamilyTvCard = {
  id: 'ftv-week-2026-W41',
  kind: 'week',
  headline: 'Margaret’s week is ready to read.',
  pages: ['A quiet week.', 'Maria came on Tuesday.'],
  actions: [
    { id: 'ftv-read', label: 'Read it', kind: 'primary' },
    { id: 'ftv-later', label: 'Later', kind: 'secondary' },
  ],
};
const FILM: FamilyTvCard = {
  id: 'ftv-watch-s1',
  kind: 'watch',
  headline: 'Margaret said yes to Big Buck Bunny.',
  actions: [
    { id: 'sit', label: 'Sit down', kind: 'primary' },
    { id: 'ftv-later', label: 'Later', kind: 'secondary' },
  ],
};
const SEATED: FamilyTvCard = { ...FILM, headline: 'Big Buck Bunny is on.', actions: [{ id: 'ftv-seat', label: 'Take your seat', kind: 'primary' }] };
const WAVED_BACK: FamilyTvCard = { id: 'ftv-wave-w1', kind: 'wave', headline: 'Margaret waved back.', actions: [{ id: 'seen', label: 'Lovely', kind: 'primary' }] };

describe('pressed — the buttons the television answers itself', () => {
  it('puts a card away on "later", and tells the server nothing', () => {
    expect(pressed(showing(home([WEEK]), NONE, undefined), 'ftv-later')).toEqual({ do: 'putAway', card: WEEK });
  });

  it('keeps it away until it changes, like any card put away here', () => {
    const put = putAway(NONE, WEEK);

    expect(showing(home([WEEK, REACH]), put, undefined)).toMatchObject({ kind: 'card', card: REACH });
    expect(showing(home([{ ...WEEK, headline: 'Margaret’s new week is ready to read.' }]), stillPutAway(put, home([{ ...WEEK, headline: 'Margaret’s new week is ready to read.' }])), undefined)).toMatchObject({ kind: 'card' });
  });

  it('opens the pages on "read", at the first, and tells the server nothing yet', () => {
    expect(pressed(showing(home([WEEK]), NONE, undefined), 'ftv-read')).toEqual({ do: 'read', reading: { cardId: WEEK.id, pages: WEEK.pages, page: 0 } });
  });

  it('does nothing on "read" for a card that brought nothing to read', () => {
    const { pages: _pages, ...bare } = WEEK;

    expect(pressed(showing(home([bare]), NONE, undefined), 'ftv-read')).toEqual({ do: 'nothing' });
  });

  it('opens the seat on "seat", and tells the server nothing', () => {
    expect(pressed(showing(home([SEATED]), NONE, undefined), 'ftv-seat')).toEqual({ do: 'seat' });
  });

  it('never sends one of its own buttons, even on a card that did not offer it', () => {
    for (const own of ['ftv-read', 'ftv-later', 'ftv-seat']) {
      expect(pressed(showing(home([REACH]), NONE, undefined), own)).toEqual({ do: 'nothing' });
    }
  });

  it('sends every other button as it is: sitting down, and seeing a wave that came back', () => {
    expect(pressed(showing(home([FILM]), NONE, undefined), 'sit')).toEqual({ do: 'send', press: { cardId: FILM.id, action: 'sit' } });
    expect(pressed(showing(home([WAVED_BACK]), NONE, undefined), 'seen')).toEqual({ do: 'send', press: { cardId: WAVED_BACK.id, action: 'seen' } });
  });
});

describe('afterPress — what the screen does once the server has answered', () => {
  const said = (done: boolean, say = 'As it stands.') => ({ kind: 'said' as const, done, say });

  it('shows the server’s sentence for an ordinary answer', () => {
    expect(afterPress({ cardId: REACH.id, action: 'calling' }, said(true, 'Margaret has been told.'), 'Margaret')).toEqual({ say: 'Margaret has been told.', seat: false, hide: false });
  });

  it('shows nothing for a quiet press — the week read to its end, a wave seen — whatever came back', () => {
    expect(afterPress({ cardId: WEEK.id, action: 'read' }, said(true), 'Margaret')).not.toHaveProperty('say');
    expect(afterPress({ cardId: WAVED_BACK.id, action: 'seen' }, said(false, 'That wave is not here any more.'), 'Margaret')).not.toHaveProperty('say');
    expect(afterPress({ cardId: WEEK.id, action: 'read' }, { kind: 'failed' }, 'Margaret')).not.toHaveProperty('say');
  });

  it('takes the card of a quiet press off this screen at once when it was done, without waiting for the next look', () => {
    expect(afterPress({ cardId: WEEK.id, action: 'read' }, said(true), 'Margaret')).toEqual({ seat: false, hide: true });
    expect(afterPress({ cardId: WAVED_BACK.id, action: 'seen' }, said(true), 'Margaret')).toEqual({ seat: false, hide: true });
  });

  it('leaves the card of a quiet press to whatever the home next says when it was not done, or may not have arrived', () => {
    expect(afterPress({ cardId: WEEK.id, action: 'read' }, said(false, 'That week is not here to read.'), 'Margaret')).toEqual({ seat: false, hide: false });
    expect(afterPress({ cardId: WAVED_BACK.id, action: 'seen' }, { kind: 'failed' }, 'Margaret')).toEqual({ seat: false, hide: false });
  });

  it('never hides the card of an ordinary answer: the sentence takes its place, and the server takes it away', () => {
    expect(afterPress({ cardId: REACH.id, action: 'calling' }, said(true), 'Margaret').hide).toBe(false);
  });

  it('opens the seat when sitting down was done — the first time or when already sat — and says nothing over it', () => {
    expect(afterPress({ cardId: FILM.id, action: 'sit' }, said(true, 'You are sat down.'), 'Margaret')).toEqual({ seat: true, hide: false });
    expect(afterPress({ cardId: FILM.id, action: 'sit' }, said(true, 'You have already sat down.'), 'Margaret')).toEqual({ seat: true, hide: false });
  });

  it('says why, and opens nothing, when sitting down was not done', () => {
    expect(afterPress({ cardId: FILM.id, action: 'sit' }, said(false, 'It is not time yet.'), 'Margaret')).toEqual({ say: 'It is not time yet.', seat: false, hide: false });
    expect(afterPress({ cardId: FILM.id, action: 'sit' }, { kind: 'failed' }, 'Margaret')).toEqual({
      say: 'Wick could not reach Margaret’s home, so that may not have been sent.',
      seat: false,
      hide: false,
    });
  });

  it('shows the sentence a wave was answered with', () => {
    expect(afterPress({ cardId: FAMILY_TV_WAVE_CARD, action: 'wave' }, said(true, 'Your wave is on its way.'), 'Margaret')).toEqual({ say: 'Your wave is on its way.', seat: false, hide: false });
  });

  it('shows nothing when the whole screen is about to change', () => {
    expect(afterPress({ cardId: REACH.id, action: 'calling' }, { kind: 'signedOut' }, 'Margaret')).toEqual({ seat: false, hide: false });
    expect(afterPress({ cardId: FILM.id, action: 'sit' }, { kind: 'notAllowed', say: 'No.' }, 'Margaret')).toEqual({ seat: false, hide: false });
  });
});

describe('afterSeatAnswer — an answer given at the credits, from the seat', () => {
  it('says nothing of its own when the answer was taken: the seat’s next sentence says what each said', () => {
    expect(afterSeatAnswer({ kind: 'said', done: true, say: 'Margaret has been told.' }, 'Margaret')).toBeUndefined();
  });

  it('says the server’s sentence when the answer was not taken', () => {
    expect(afterSeatAnswer({ kind: 'said', done: false, say: 'That film is not here to answer any more.' }, 'Margaret')).toBe('That film is not here to answer any more.');
  });

  it('says so when it may not have arrived, so it can be given again', () => {
    expect(afterSeatAnswer({ kind: 'failed' }, 'Margaret')).toBe('Wick could not reach Margaret’s home, so that may not have been sent.');
  });

  it('says so without a name when it has none to say', () => {
    expect(afterSeatAnswer({ kind: 'failed' }, undefined)).toBe('Wick could not reach the home, so that may not have been sent.');
  });

  it('says nothing when the whole screen is about to change', () => {
    expect(afterSeatAnswer({ kind: 'signedOut' }, 'Margaret')).toBeUndefined();
    expect(afterSeatAnswer({ kind: 'notAllowed', say: 'No.' }, 'Margaret')).toBeUndefined();
  });
});

describe('a film card with nothing to press — her answer, kept until the invitation closes', () => {
  const kept: FamilyTvCard = { id: FILM.id, kind: 'watch', headline: 'Big Buck Bunny has ended.', detail: 'Margaret said: “I loved it.”', actions: [] };

  it('is drawn like any card that only says how something stands, with the television’s own "All right"', () => {
    expect(showing(home([kept]), NONE, undefined)).toMatchObject({ kind: 'card', card: kept, actions: [ALL_RIGHT] });
  });

  it('is put away on this screen by that button, and tells the server nothing', () => {
    expect(pressed(showing(home([kept]), NONE, undefined), ALL_RIGHT.id)).toEqual({ do: 'putAway', card: kept });
  });
});

describe('waveOf — one button for whoever is in the room', () => {
  it('is a button with the server’s words, pressed on the wave’s own card, while a wave can be sent', () => {
    const h = home([], { wave: { label: 'Wave to Margaret', cardId: FAMILY_TV_WAVE_CARD } });

    expect(waveOf(h)).toEqual({ kind: 'button', label: 'Wave to Margaret', press: { cardId: FAMILY_TV_WAVE_CARD, action: 'wave' } });
  });

  it('is a sentence, with nothing to press, while the last wave is still on her television', () => {
    const h = home([], { wave: { label: 'Wave to Margaret', line: 'Your wave is on Margaret’s television.' } });

    expect(waveOf(h)).toEqual({ kind: 'line', line: 'Your wave is on Margaret’s television.' });
  });

  it('is nothing for a member who may not send one, or before there is a home', () => {
    expect(waveOf(home())).toBeUndefined();
    expect(waveOf(undefined)).toBeUndefined();
    expect(waveOf(home([], { wave: { label: 'Wave to Margaret' } }))).toBeUndefined();
  });
});

// While sat at her film the television goes on asking for the home. A
// doorstep question lasts five minutes and a film fifteen: without a word
// over the seat it would be missed.
describe('somethingWaits — one calm line over the seat', () => {
  it('says so, in the television’s own words, and says which key', () => {
    expect(SOMETHING_WAITS).toBe('Something is waiting for you. Press Back to see it.');
  });

  it('is so when the card Back would show waits for an answer: her question from the door, her asking to be rung', () => {
    expect(somethingWaits(home([DOOR, SEATED]), NONE, SEATED.id)).toBe(true);
    expect(somethingWaits(home([REACH]), NONE, SEATED.id)).toBe(true);
  });

  it('is not so when Back would show this film’s own card first — whatever waits behind it: the sentence must stay true', () => {
    expect(somethingWaits(home([SEATED]), NONE, SEATED.id)).toBe(false);
    expect(somethingWaits(home([FILM]), NONE, FILM.id)).toBe(false);
    // A wave that came back ranks after the film's card: it says nothing in the middle of the film.
    expect(somethingWaits(home([SEATED, WAVED_BACK]), NONE, SEATED.id)).toBe(false);
    expect(somethingWaits(home([SEATED, DOOR]), NONE, SEATED.id)).toBe(false);
  });

  it('takes any film’s card for this film’s until the seat has said which card is its own', () => {
    expect(somethingWaits(home([FILM]), NONE, undefined)).toBe(false);
    expect(somethingWaits(home([REACH, FILM]), NONE, undefined)).toBe(true);
  });

  it('is not so when Back would show a card that only says how something stands, or offers only the television’s own buttons', () => {
    expect(somethingWaits(home([STANDING, REACH]), NONE, SEATED.id)).toBe(false);
    expect(somethingWaits(home([WEEK]), NONE, SEATED.id)).toBe(false);
  });

  it('looks past a card put away on this screen, as Back does', () => {
    const put = putAway(NONE, STANDING);

    expect(somethingWaits(home([STANDING, REACH]), put, SEATED.id)).toBe(true);
    expect(somethingWaits(home([STANDING]), put, SEATED.id)).toBe(false);
  });

  it('is the very card the home screen then shows', () => {
    const h = home([STANDING, DOOR, SEATED]);
    const put = putAway(NONE, STANDING);

    expect(somethingWaits(h, put, SEATED.id)).toBe(true);
    expect(showing(h, put, undefined)).toMatchObject({ kind: 'card', card: DOOR });
  });

  it('is not so with nothing on the home, or no home yet', () => {
    expect(somethingWaits(home(), NONE, SEATED.id)).toBe(false);
    expect(somethingWaits(undefined, NONE, SEATED.id)).toBe(false);
  });
});

// Before the first answer there is no home to name. The screen is laid out
// as the home will be all the same — a heading, and under it what there is
// to say — so that it is never blank, and never one stray sentence.
describe('startingLines — the family screen before it has reached a home', () => {
  it('has its heading from the first moment: the name of the thing, since there is no home to name yet', () => {
    expect(startingLines(false)).toEqual({ heading: 'Wick', quiet: [] });
  });

  it('says under it that Wick cannot reach the home, once a look has failed — in the words the home screen uses', () => {
    expect(startingLines(true)).toEqual({ heading: 'Wick', quiet: ['Wick cannot reach the home just now.'] });
    expect(startingLines(true).quiet[0]).toBe(unreachableLine(undefined));
  });

  it('claims nothing it does not know: no name, no "nothing is waiting", no word of a light', () => {
    expect(JSON.stringify(startingLines(true))).not.toMatch(/waiting for you|light|television/i);
  });
});
