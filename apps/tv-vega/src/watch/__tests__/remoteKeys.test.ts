import { describe, expect, it } from 'vitest';
import { SEEK_STEP_MS, playIsTheCards, readCommand, seekTarget, watchCommand } from '../remoteKeys.js';

const press = (eventType: string) => ({ eventType, eventKeyAction: 0 });
const release = (eventType: string) => ({ eventType, eventKeyAction: 1 });

describe('watchCommand', () => {
  it('toggles play and pause on Play/Pause and on OK', () => {
    expect(watchCommand(press('playpause'), { cardVisible: false })).toBe('toggle');
    expect(watchCommand(press('select'), { cardVisible: false })).toBe('toggle');
  });

  it('seeks with the skip keys and with left and right', () => {
    expect(watchCommand(press('skip_forward'), { cardVisible: false })).toBe('forward');
    expect(watchCommand(press('right'), { cardVisible: false })).toBe('forward');
    expect(watchCommand(press('skip_backward'), { cardVisible: false })).toBe('back');
    expect(watchCommand(press('left'), { cardVisible: false })).toBe('back');
  });

  it('understands the names the Vega Virtual Device really sends — not the ones the SDK documents', () => {
    // Seen in the device log, 2026-10-02: KEY_PLAYPAUSE arrives as "play",
    // KEY_ENTER as "enter", KEY_FASTFORWARD as "forward" (FRICTION.md FL-021).
    expect(watchCommand(press('play'), { cardVisible: false })).toBe('toggle');
    expect(watchCommand(press('enter'), { cardVisible: false })).toBe('toggle');
    expect(watchCommand(press('forward'), { cardVisible: false })).toBe('forward');
    expect(watchCommand(press('rewind'), { cardVisible: false })).toBe('back');
    expect(watchCommand(press('enter'), { cardVisible: true })).toBeUndefined();
    expect(watchCommand(press('play'), { cardVisible: true })).toBe('toggle');
  });

  it('acts once per press — on key down, not again on key up', () => {
    expect(watchCommand(release('playpause'), { cardVisible: false })).toBeUndefined();
  });

  it('leaves OK and the arrows to a card that is on screen', () => {
    expect(watchCommand(press('select'), { cardVisible: true })).toBeUndefined();
    expect(watchCommand(press('left'), { cardVisible: true })).toBeUndefined();
    expect(watchCommand(press('right'), { cardVisible: true })).toBeUndefined();
  });

  it('still obeys the dedicated media keys while a card is on screen', () => {
    expect(watchCommand(press('playpause'), { cardVisible: true })).toBe('toggle');
    expect(watchCommand(press('skip_forward'), { cardVisible: true })).toBe('forward');
  });

  it('ignores keys it has no use for', () => {
    expect(watchCommand(press('up'), { cardVisible: false })).toBeUndefined();
    expect(watchCommand(press('menu'), { cardVisible: false })).toBeUndefined();
  });
});

describe('seekTarget', () => {
  it('moves by one step', () => {
    expect(seekTarget(60_000, 'forward', 600_000)).toBe(60_000 + SEEK_STEP_MS);
    expect(seekTarget(60_000, 'back', 600_000)).toBe(60_000 - SEEK_STEP_MS);
  });

  it('never seeks before the start', () => {
    expect(seekTarget(5_000, 'back', 600_000)).toBe(0);
  });

  it('stops just short of the end, so the programme ends by playing rather than by a jump', () => {
    expect(seekTarget(595_000, 'forward', 600_000)).toBe(599_000);
  });

  it('does not clamp to an unknown duration', () => {
    expect(seekTarget(60_000, 'forward', 0)).toBe(60_000 + SEEK_STEP_MS);
  });
});

/*
 * Read to me (packages/contracts speech.ts). Everything above is as it was
 * before there was reading, and still holds: when the app does not say that
 * Play is the card's, Play is the film's. What follows is the one new
 * thing — Play over a card that can be read — and how it gives way again.
 */
const CARD = { cardVisible: true, playReads: true } as const;
const PLAY_KEYS = ['play', 'playpause'] as const;

describe('Play over a card that can be read — the first press is the card’s', () => {
  it('asks for the card to be read, by every name the two televisions give the key, and leaves the film as it is', () => {
    // "play" is what the Vega simulator sends for KEY_PLAYPAUSE; "playpause" is the SDK's name, and what the
    // Fire OS adapter renames Android's "playPause" to (FRICTION.md FL-021, FL-028).
    for (const key of PLAY_KEYS) {
      expect(readCommand(press(key), CARD), key).toBe('toggle');
      expect(watchCommand(press(key), CARD), key).toBeUndefined();
    }
  });

  it('stops the reading on the same key while it is the card’s: the door’s card, and a card on the home screen', () => {
    for (const key of PLAY_KEYS) {
      expect(readCommand(press(key), { ...CARD, reading: true }), key).toBe('toggle');
      expect(watchCommand(press(key), { ...CARD, reading: true }), key).toBeUndefined();
    }
  });

  it('acts once for a press: on the key going down, or on an event that is the whole press — never on the key coming up', () => {
    expect(readCommand(release('play'), CARD)).toBeUndefined();
    expect(readCommand({ eventType: 'play' }, CARD)).toBe('toggle');
  });

  it('is no other key: OK and the arrows are the card’s buttons, and the skip keys the film’s', () => {
    for (const key of ['select', 'enter', 'left', 'right', 'up', 'down', 'skip_forward', 'forward', 'rewind', 'menu', 'back', 'constructor']) {
      expect(readCommand(press(key), CARD), key).toBeUndefined();
    }
    expect(watchCommand(press('skip_forward'), CARD)).toBe('forward');
  });

  it('never both reads a card and moves the film on one press', () => {
    for (const key of [...PLAY_KEYS, 'pause', 'select', 'left', 'forward']) {
      for (const context of [CARD, { ...CARD, reading: true }, { cardVisible: true }, { cardVisible: true, reading: true }, { cardVisible: false }]) {
        const asks = readCommand(press(key), context) === 'toggle';
        expect(asks && watchCommand(press(key), context) !== undefined, `${key} ${JSON.stringify(context)}`).toBe(false);
      }
    }
  });
});

describe('Play when it is the film’s again — as before there was reading', () => {
  it('pauses and resumes the film over a card, and ends at once any reading that is under way', () => {
    for (const key of PLAY_KEYS) {
      // The next Play over a note that holds the film: the film goes on, and the note is put away as it always was.
      expect(watchCommand(press(key), { cardVisible: true, playReads: false, reading: true }), key).toBe('toggle');
      expect(readCommand(press(key), { cardVisible: true, playReads: false, reading: true }), key).toBe('stop');
      // …the same when the reading has ended, or never started.
      expect(watchCommand(press(key), { cardVisible: true, playReads: false }), key).toBe('toggle');
    }
  });

  it('is the film’s when the app does not say otherwise — where reading cannot work, nothing about Play changes', () => {
    for (const key of [...PLAY_KEYS, 'pause']) {
      expect(watchCommand(press(key), { cardVisible: true }), key).toBe('toggle');
      expect(watchCommand(press(key), { cardVisible: false }), key).toBe('toggle');
      expect(readCommand(press(key), { cardVisible: false }), key).toBeUndefined();
    }
  });
});

describe('a key that is only Pause', () => {
  it('stops a reading that is under way, and does nothing else then: the film is not touched', () => {
    for (const context of [{ ...CARD, reading: true }, { cardVisible: true, playReads: false, reading: true }]) {
      expect(readCommand(press('pause'), context)).toBe('stop');
      expect(watchCommand(press('pause'), context)).toBeUndefined();
    }
  });

  it('never asks for a reading, and with none under way is the film’s as before', () => {
    for (const context of [CARD, { cardVisible: true, playReads: false }, { cardVisible: false }]) {
      expect(readCommand(press('pause'), context)).toBeUndefined();
      expect(watchCommand(press('pause'), context)).toBe('toggle');
    }
  });
});

describe('playIsTheCards — whose the next Play is', () => {
  it('is nobody’s card’s when no card that can be read is on screen', () => {
    expect(playIsTheCards({ card: undefined, holdsFilm: false, askedFor: null })).toBe(false);
    expect(playIsTheCards({ card: undefined, holdsFilm: true, askedFor: 'note-1' })).toBe(false);
  });

  it('is the card’s on the home screen and over a film the card does not hold, however often it has been pressed', () => {
    expect(playIsTheCards({ card: 'note-1', holdsFilm: false, askedFor: null })).toBe(true);
    expect(playIsTheCards({ card: 'note-1', holdsFilm: false, askedFor: 'note-1' })).toBe(true);
    expect(playIsTheCards({ card: 'door-1', holdsFilm: false, askedFor: 'door-1' })).toBe(true);
  });

  it('is the card’s over a film the card is holding too, however often it has been pressed: the film goes on only when she answers', () => {
    expect(playIsTheCards({ card: 'note-1', holdsFilm: true, askedFor: null })).toBe(true);
    expect(playIsTheCards({ card: 'note-1', holdsFilm: true, askedFor: 'note-1' })).toBe(true);
    expect(playIsTheCards({ card: 'note-2', holdsFilm: true, askedFor: 'note-1' })).toBe(true);
  });
});
