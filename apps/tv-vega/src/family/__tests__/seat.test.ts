import { describe, expect, it } from 'vitest';
import type { FamilyTvSeat } from '@wick/contracts';
import { pressGuard, PRESS_SETTLE_MS } from '../presses.js';
import { FILM_OVER, FOLLOW_DRIFT_MS, SEEK_LEAD_MS, SEEK_SETTLE_MS, asksAgain, follow, maySeek, seatNotice, seatSurface, seatView, type SeatView } from '../seat.js';

type Playback = NonNullable<FamilyTvSeat['playback']>;
const hers = (state: Playback['state'], positionMs: number, ageMs = 0): Playback => ({ state, positionMs, ageMs });
/** A reply that arrived at 10_000 on this television's clock, looked at `since` ms later. */
const at = (since = 0) => ({ arrivedAt: 10_000, now: 10_000 + since });
const mine = (positionMs: number, playing: boolean) => ({ positionMs, playing });

describe('follow — this television keeps up with her film, and never leads it', () => {
  it('plays when hers plays, and leaves a picture that is already level alone', () => {
    expect(follow(hers('PLAYING', 60_000), at(), mine(60_000, false))).toEqual({ run: 'play' });
    expect(follow(hers('PLAYING', 60_000), at(), mine(60_400, true))).toEqual({});
  });

  it('aims for where her film is now: where it was, how long before the server said so, and how long since', () => {
    // 60 s when her television said it; that was 1.5 s before the reply; the reply came 2 s ago.
    const level = 60_000 + 1_500 + 2_000;

    expect(follow(hers('PLAYING', 60_000, 1_500), at(2_000), mine(level, true))).toEqual({});
    expect(follow(hers('PLAYING', 60_000, 1_500), at(2_000), mine(level - FOLLOW_DRIFT_MS, true))).toEqual({});
    expect(follow(hers('PLAYING', 60_000, 1_500), at(2_000), mine(level - FOLLOW_DRIFT_MS - 1, true))).toEqual({ seekToMs: level + SEEK_LEAD_MS });
  });

  it('jumps only when it is more than about two seconds out, ahead or behind', () => {
    expect(FOLLOW_DRIFT_MS).toBeGreaterThanOrEqual(2_000);
    expect(FOLLOW_DRIFT_MS).toBeLessThanOrEqual(3_000);
    expect(follow(hers('PLAYING', 60_000), at(), mine(62_000, true))).toEqual({});
    expect(follow(hers('PLAYING', 60_000), at(), mine(70_000, true))).toEqual({ seekToMs: 60_000 + SEEK_LEAD_MS });
    expect(follow(hers('PLAYING', 60_000), at(), mine(0, false))).toEqual({ seekToMs: 60_000 + SEEK_LEAD_MS, run: 'play' });
  });

  it('stops where hers stops: paused, and held to the very place', () => {
    expect(follow(hers('PAUSED', 60_000), at(), mine(60_200, true))).toEqual({ run: 'pause' });
    expect(follow(hers('PAUSED', 60_000), at(), mine(60_200, false))).toEqual({});
    expect(follow(hers('PAUSED', 60_000), at(), mine(61_000, false))).toEqual({ seekToMs: 60_000 });
  });

  it('does not count time on a film that is not moving, however old the word of it', () => {
    expect(follow(hers('PAUSED', 60_000, 30_000), at(20_000), mine(60_000, false))).toEqual({});
    expect(follow(hers('WAITING', 60_000, 30_000), at(20_000), mine(60_000, false))).toEqual({});
  });

  it('waits while hers waits for its picture', () => {
    expect(follow(hers('WAITING', 60_000), at(), mine(60_000, true))).toEqual({ run: 'pause' });
  });

  it('stops, and goes nowhere, when hers has been stopped or there is no word of it at all', () => {
    expect(follow(hers('STOPPED', 0), at(), mine(60_000, true))).toEqual({ run: 'pause' });
    expect(follow(hers('STOPPED', 0), at(), mine(60_000, false))).toEqual({});
    expect(follow(undefined, at(), mine(60_000, true))).toEqual({ run: 'pause' });
    expect(follow(undefined, at(), mine(0, false))).toEqual({});
  });

  it('never aims past the end of the film', () => {
    expect(follow(hers('PLAYING', 595_000, 4_000), at(4_000), mine(0, true), 596_000)).toEqual({ seekToMs: 596_000 });
    expect(follow(hers('PLAYING', 595_000, 4_000), at(4_000), mine(596_000, true), 596_000)).toEqual({});
  });
});

describe('maySeek — a player is sent somewhere once, and given time to get there', () => {
  it('is not sent anywhere before it knows the film', () => {
    expect(maySeek({ readyState: 0 }, undefined, 0)).toBe(false);
    expect(maySeek({ readyState: 1 }, undefined, 0)).toBe(true);
  });

  it('is not sent somewhere else while it is still finding the last place', () => {
    expect(maySeek({ readyState: 2 }, 1_000, 1_000 + SEEK_SETTLE_MS - 1)).toBe(false);
    expect(maySeek({ readyState: 2 }, 1_000, 1_000 + SEEK_SETTLE_MS)).toBe(true);
    expect(maySeek({ readyState: 4 }, 1_000, 1_500)).toBe(true);
  });
});

const SEAT: FamilyTvSeat = {
  cardId: 'ftv-watch-s1',
  film: 'Big Buck Bunny',
  state: 'watching',
  line: 'Big Buck Bunny is on. Your television follows Margaret’s.',
  stream: { url: 'https://films.example/bbb/index.m3u8', durationMs: 596_000, attribution: '© Blender Foundation' },
  playback: { state: 'PLAYING', positionMs: 61_000, ageMs: 1_200 },
};
const OPENING: SeatView = { kind: 'opening' };

describe('seatView — what the seat shows', () => {
  it('shows nothing before the first answer', () => {
    expect(OPENING).toEqual({ kind: 'opening' });
  });

  it('sits at the film while she is watching it, or has yet to start it', () => {
    expect(seatView(OPENING, { kind: 'seat', seat: SEAT })).toEqual({ kind: 'sitting', seat: SEAT });
    const { stream: _stream, playback: _playback, ...waiting } = { ...SEAT, state: 'waiting' as const, line: 'Waiting for Margaret to start the film.' };
    expect(seatView(OPENING, { kind: 'seat', seat: waiting })).toEqual({ kind: 'sitting', seat: waiting });
  });

  it('asks the one question at the credits, with the answers the server offers', () => {
    const asked: FamilyTvSeat = { ...SEAT, state: 'asked', line: 'The credits are playing.', question: 'Did you enjoy that?', answers: [{ id: 'lovely', label: 'Lovely', kind: 'primary' }] };

    expect(seatView({ kind: 'sitting', seat: SEAT }, { kind: 'seat', seat: asked })).toEqual({ kind: 'asked', cardId: 'ftv-watch-s1', question: 'Did you enjoy that?', answers: asked.answers });
  });

  it('says how it stands, with nothing to answer, when the question has no answers left to give', () => {
    const answered: FamilyTvSeat = { cardId: 'ftv-watch-s1', film: 'Big Buck Bunny', state: 'asked', line: 'You said: lovely. Waiting for Margaret.' };

    expect(seatView(OPENING, { kind: 'seat', seat: answered })).toEqual({ kind: 'over', line: 'You said: lovely. Waiting for Margaret.' });
  });

  it('is over with the server’s last sentence', () => {
    const over: FamilyTvSeat = { cardId: 'ftv-watch-s1', film: 'Big Buck Bunny', state: 'over', line: 'You both said: lovely.' };

    expect(seatView({ kind: 'sitting', seat: SEAT }, { kind: 'seat', seat: over })).toEqual({ kind: 'over', line: 'You both said: lovely.' });
  });

  it('is over in the television’s own words when there is no seat any more', () => {
    expect(seatView({ kind: 'sitting', seat: SEAT }, { kind: 'seat' })).toEqual({ kind: 'over', line: FILM_OVER });
    expect(seatView(OPENING, { kind: 'seat' })).toEqual({ kind: 'over', line: FILM_OVER });
    expect(FILM_OVER).toBe('The film is over.');
  });

  // Once the member has answered, the server's last sentence says what each said — and hers arrives later.
  it('goes on redrawing the last sentence while it is over: her answer appears when it comes', () => {
    const base = { cardId: 'ftv-watch-s1', film: 'Big Buck Bunny', state: 'over' as const };
    const waitingForHers: SeatView = { kind: 'over', line: 'You said: “I loved it.” Margaret has not answered yet.' };

    expect(seatView({ kind: 'sitting', seat: SEAT }, { kind: 'seat', seat: { ...base, line: waitingForHers.line } })).toEqual(waitingForHers);
    expect(seatView(waitingForHers, { kind: 'seat', seat: { ...base, line: 'You said: “I loved it.” Margaret said: “I loved it.”' } })).toEqual({
      kind: 'over',
      line: 'You said: “I loved it.” Margaret said: “I loved it.”',
    });
  });

  it('composes nothing of its own from the two answers: the sentence is the server’s', () => {
    const over = { cardId: 'ftv-watch-s1', film: 'Big Buck Bunny', state: 'over' as const, line: 'Big Buck Bunny has ended.', yourAnswer: 'I loved it.', theirAnswer: 'I loved it.' };

    expect(seatView({ kind: 'opening' }, { kind: 'seat', seat: over })).toEqual({ kind: 'over', line: 'Big Buck Bunny has ended.' });
  });

  it('ends in the television’s own words when the seat is gone, whatever it said last', () => {
    const over: SeatView = { kind: 'over', line: 'You both said: lovely.' };

    expect(seatView(over, { kind: 'seat' })).toEqual({ kind: 'over', line: FILM_OVER });
  });

  it('keeps what it shows when an ask fails: the film is not taken away by a bad moment on the network', () => {
    const sitting: SeatView = { kind: 'sitting', seat: SEAT };

    expect(seatView(sitting, { kind: 'failed' })).toBe(sitting);
    expect(seatView(OPENING, { kind: 'failed' })).toBe(OPENING);
  });

  it('keeps the very same view when nothing has changed, so nothing is drawn again every two seconds', () => {
    const sitting: SeatView = { kind: 'sitting', seat: SEAT };

    expect(seatView(sitting, { kind: 'seat', seat: { ...SEAT, playback: { state: 'PLAYING', positionMs: 63_000, ageMs: 900 } } })).not.toBe(sitting);
    expect(seatView(sitting, { kind: 'seat', seat: { ...SEAT } })).toBe(sitting);
  });
});

describe('seatNotice — the sentence over the picture', () => {
  it('is the server’s sentence while there is something to say', () => {
    expect(seatNotice({ ...SEAT, state: 'waiting', line: 'Waiting for Margaret to start the film.' })).toBe('Waiting for Margaret to start the film.');
    expect(seatNotice({ ...SEAT, line: 'Paused on Margaret’s television.', playback: { state: 'PAUSED', positionMs: 1, ageMs: 0 } })).toBe('Paused on Margaret’s television.');
  });

  it('is nothing while her film is playing: the picture is left alone', () => {
    expect(seatNotice(SEAT)).toBeUndefined();
  });
});

describe('asksAgain — when the seat stops asking', () => {
  it('goes on asking at every state of a seat, over included: the last sentence can still change', () => {
    expect(asksAgain({ kind: 'seat', seat: SEAT })).toBe(true);
    expect(asksAgain({ kind: 'seat', seat: { cardId: 'c', film: 'f', state: 'over', line: 'It has ended.' } })).toBe(true);
    expect(asksAgain({ kind: 'failed' })).toBe(true);
  });

  it('stops when there is no seat any more, or this television may not sit here', () => {
    expect(asksAgain({ kind: 'seat' })).toBe(false);
    expect(asksAgain({ kind: 'notAllowed', say: 'No.' })).toBe(false);
    expect(asksAgain({ kind: 'signedOut' })).toBe(false);
  });
});

// While the film is on, OK does nothing in the seat — and somebody will
// press it to find that out. At the credits a card arrives with its first
// answer under that thumb.
describe('seatSurface — what there is to press in the seat', () => {
  const asked: SeatView = { kind: 'asked', cardId: 'ftv-watch-s1', question: 'Did you enjoy that?', answers: [{ id: 'lovely', label: 'Lovely', kind: 'primary' }, { id: 'again', label: 'Again soon', kind: 'secondary' }] };

  it('is nothing to press while the film is on, the question at the credits, the last sentence, or what was said of an answer', () => {
    expect(seatSurface({ kind: 'opening' }, undefined, false)).toBe('opening');
    expect(seatSurface({ kind: 'sitting', seat: SEAT }, undefined, false)).toBe('sitting');
    expect(seatSurface(asked, undefined, false)).toBe('asked:lovely,again');
    expect(seatSurface({ kind: 'over', line: 'It has ended.' }, undefined, false)).toBe('over');
    expect(seatSurface(asked, 'That may not have been sent.', false)).toBe('said:That may not have been sent.');
  });

  it('is the same last sentence when its words change: her answer arriving does not hold the remote up', () => {
    expect(seatSurface({ kind: 'over', line: 'You said: lovely. Margaret has not answered yet.' }, undefined, false)).toBe(seatSurface({ kind: 'over', line: 'You both said: lovely.' }, undefined, false));
  });

  it('is something else while an answer is on its way: its buttons are gone', () => {
    expect(seatSurface(asked, undefined, true)).not.toBe(seatSurface(asked, undefined, false));
  });

  it('gives the question a second on screen before OK can answer it: a thumb already pressing during the film answers nothing', () => {
    const guard = pressGuard();
    const T = 1_800_000_000_000;
    guard.surface(seatSurface({ kind: 'sitting', seat: SEAT }, undefined, false), T);

    // Fifteen minutes of film, then the credits: the question arrives.
    const credits = T + 15 * 60_000;
    guard.surface(seatSurface(asked, undefined, false), credits);
    expect(guard.cardActs(credits + 300)).toBe(false);
    expect(guard.cardActs(credits + PRESS_SETTLE_MS)).toBe(true);
  });
});
