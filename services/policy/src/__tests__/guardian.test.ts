import { describe, expect, it } from 'vitest';
import { NEVER_TO_FAMILY } from '@wick/contracts';
import { DEFAULT_POLICY, LEXICON, classify, clearForFamily, normalise } from '../index.js';
import type { HouseholdPolicy } from '../types.js';

const classesOf = (text: string) => {
  const reading = classify(text);
  return reading.readable ? [...reading.classes].sort() : 'unreadable';
};

describe('the lexicon', () => {
  it('finds only classes the family may never be shown', () => {
    for (const marker of LEXICON) expect(NEVER_TO_FAMILY).toContain(marker.class);
  });

  it('catches every example it lists, as its own class', () => {
    for (const marker of LEXICON) {
      for (const example of marker.examples) {
        expect({ example, classes: classesOf(example) }).toEqual({ example, classes: expect.arrayContaining([marker.class]) });
      }
    }
  });
});

describe('what reached the family before the gate', () => {
  it('withholds the door sentence about a nurse and a medication box', () => {
    expect(classesOf('A woman in a nurse’s uniform holding a medication box.')).toEqual(['HEALTH']);
  });

  it('withholds the note that asks after her hip and her pension', () => {
    expect(classesOf('Is your hip still bad? Did the pension come?')).toEqual(['FINANCIAL', 'HEALTH']);
  });

  it('withholds a visitor named by a clinical role', () => {
    expect(classesOf('Dr Patel GP')).toEqual(['HEALTH']);
    expect(classesOf('Nurse Joy')).toEqual(['HEALTH']);
  });

  it('withholds a stroke followed by "of", unless it is one of the idioms', () => {
    // Found by the property suite on seed 150: "A STROKE of" was cleared, because the
    // exception for "a stroke of luck" let every "stroke of" through.
    expect(classesOf('She had a stroke of some kind.')).toEqual(['HEALTH']);
    expect(classesOf('A STROKE of')).toEqual(['HEALTH']);
  });

  it('withholds a relationship and an address', () => {
    expect(classesOf('Her boyfriend came round after the divorce.')).toEqual(['RELATIONSHIP']);
    expect(classesOf('Send it to 14 Elm Road, SW1A 1AA.')).toEqual(['LOCATION']);
  });

  // An outside review fed "She is at 12 Broadway." to the gate on 2026-10-20, and it was cleared.
  it('withholds a house number with a bare street name after it', () => {
    for (const sentence of ['She is at 12 Broadway.', 'She is at 12 Broadway', 'Take it to 10 Downing.', 'A parcel came from 7 Larchmont.', 'She is at number 4 Kingsway.', 'She is at 12 Marlborough.', 'Meet at 7 Market.', 'Go to 3 Augustine.', 'At 5 Decker, by the shop.', 'At 4 Juniper.']) {
      expect(classesOf(sentence), sentence).toEqual(['LOCATION']);
    }
  });
});

describe('what it must not catch', () => {
  // Each of these is an ordinary sentence a door camera, a note or the week could hold.
  const ordinary = [
    'A man in a delivery uniform, holding a parcel.',
    'An empty porch with a parcel on the step.',
    'A man in a yellow jacket holding a clipboard.',
    'A courier holding a tablet and scanning a parcel.',
    'Two men walking down the road.',
    'A woman with a pin badge on her coat.',
    'It may rain later.',
    'The light appears to be on.',
    'Margaret’s hip-hop playlist is on.',
    'Bill is at the door.',
    'Will you come on Saturday?',
    'Penny and Grace visited.',
    'See you on the Bank Holiday.',
    'Doctor Who is on tonight.',
    'I’ll call you soon.',
    'I\'ll call you soon.',
    'Thanks for letting me know!',
    'Maria paid a visit on Tuesday.',
    'Ade the carer came on Tuesday and Friday.',
    'Someone was at the front door three times this week, as usual.',
    'Big Buck Bunny on Saturday at 3pm.',
    'A stroke of luck.',
    'What a stroke of genius.',
    'At the stroke of midnight.',
    // A time, a date or a count after "at", "to" or "from" is not an address.
    'I’ll be back at 3 pm.',
    'Dinner at 7 tomorrow?',
    'Call me at 6 tonight.',
    'Maria comes from 9 till 5.',
    'See you at 2 o’clock.',
    'The film starts at 8 sharp.',
    'It moved from 12 March to 19 March.',
    'From 3 Sept to 9 Oct.',
    'Back at 1 June.',
    'Up to 3 people can come.',
    'Back at 10 or so.',
  ];

  for (const sentence of ordinary) {
    it(`clears “${sentence}”`, () => {
      expect(clearForFamily(sentence)).toEqual({ cleared: true, text: sentence });
    });
  }
});

describe('what it does not catch, said plainly (docs/WICK-TECHNICAL.md §6.5)', () => {
  // These pass. They are here so that the limit is a fact the suite states, not a surprise.
  for (const sentence of ['How was Tuesday at St Mary’s?', 'The d0ctor came.', 'The p e n s i o n came.']) {
    it(`clears “${sentence}”: no word in it is listed`, () => {
      expect(clearForFamily(sentence).cleared).toBe(true);
    });
  }
});

describe('reading what it cannot read', () => {
  it('takes accents, full-width letters and typographic quotes as the plain word', () => {
    expect(normalise('Ｄｏｃｔｏｒ’s')).toBe("doctor's");
    expect(classesOf('The dóctor came.')).toEqual(['HEALTH']);
    expect(classesOf('Zoë and Łukasz came round.')).toEqual([]);
  });

  it('withholds a string in a script the lexicon does not read, a look-alike letter, or an invisible character', () => {
    expect(classesOf('李医生来了')).toBe('unreadable');
    // Cyrillic о (U+043E) in "doctor".
    expect(classesOf('The d\u043Ector came.')).toBe('unreadable');
    // A zero-width space splitting "pension".
    expect(classesOf('The pen\u200Bsion came.')).toBe('unreadable');
    expect(classesOf('Her 💊 box.')).toBe('unreadable');
    expect(clearForFamily('李医生来了')).toEqual({ cleared: false, classes: [] });
  });
});

describe('clearForFamily, through evaluate', () => {
  it('names every class it refused', () => {
    expect(clearForFamily('Her pills and her pension.')).toEqual({ cleared: false, classes: ['HEALTH', 'FINANCIAL'] });
  });

  it('refuses a protected class even when a policy opts the family in to it and excludes nothing', () => {
    const permissive: HouseholdPolicy = { ...DEFAULT_POLICY, familyPermitted: [...NEVER_TO_FAMILY] };
    expect(clearForFamily('The doctor came.', permissive).cleared).toBe(false);
  });
});
