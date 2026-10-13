import { describe, expect, it } from 'vitest';
import type { FamilyTvCard, FamilyTvHome } from '@wick/contracts';
import {
  ALL_RIGHT,
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

describe('putAway / stillPutAway — put away on this screen until it changes or leaves', () => {
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

  it('is forgotten when the card leaves, so the same id sent again later is shown', () => {
    const put = putAway(NONE, STANDING);
    const after = stillPutAway(put, home([REACH]));

    expect(after).toEqual({});
    expect(showing(home([STANDING]), after, undefined)).toMatchObject({ kind: 'card', card: STANDING });
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
