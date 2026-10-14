import { describe, expect, it } from 'vitest';
import {
  ECHO_WINDOW_MS,
  REFUSED_COMMANDS,
  Refused,
  fromTimeValue,
  keyEchoes,
  mediaOutcome,
  moveFilm,
  refusesEverything,
  sessionMetadata,
  sessionView,
  shouldPublish,
  toTimeValue,
  type MediaContext,
  type MovablePlayer,
} from '../mediaSession.js';
import { SEEK_STEP_MS } from '../remoteKeys.js';

const FILM = { paused: false, positionMs: 120_000, durationMs: 600_000 };
const PAUSED = { ...FILM, paused: true };
const NOTHING_ON: MediaContext = { cardVisible: false, held: false, suspended: false };
/** A note holding the film on the cut, as it is when it has just come on screen: Play reads it first. */
const NOTE_HOLDING: MediaContext = { cardVisible: true, playReads: true, held: true, suspended: false };
/** The door's card over a film that is playing: it holds nothing, and Play reads it. */
const DOOR_OVER: MediaContext = { cardVisible: true, playReads: true, held: false, suspended: false };

describe('mediaOutcome — a command is her press, by another way', () => {
  it('pauses a playing film on "pause", and plays a paused one on "play"', () => {
    expect(mediaOutcome('pause', NOTHING_ON, FILM)).toEqual({ film: { kind: 'pause' } });
    expect(mediaOutcome('play', NOTHING_ON, PAUSED)).toEqual({ film: { kind: 'play' } });
  });

  it('does nothing to a film already where the command would put it', () => {
    expect(mediaOutcome('play', NOTHING_ON, FILM)).toEqual({});
    expect(mediaOutcome('pause', NOTHING_ON, PAUSED)).toEqual({});
  });

  it('treats Stop as a pause: a film has no stop, and she leaves it with Back', () => {
    expect(mediaOutcome('stop', NOTHING_ON, FILM)).toEqual({ film: { kind: 'pause' } });
  });

  it('treats the platform’s Play/Pause as the key: it toggles the film', () => {
    expect(mediaOutcome('toggle', NOTHING_ON, FILM)).toEqual({ film: { kind: 'toggle' } });
    expect(mediaOutcome('toggle', NOTHING_ON, PAUSED)).toEqual({ film: { kind: 'toggle' } });
  });

  it('over a note holding the film, the platform’s Play/Pause reads it first, as the key does', () => {
    expect(mediaOutcome('toggle', NOTE_HOLDING, PAUSED)).toEqual({ reader: 'toggle' });
    // Once asked for, the next carries on with the film and ends the reading.
    expect(mediaOutcome('toggle', { ...NOTE_HOLDING, playReads: false, reading: true }, PAUSED)).toEqual({ film: { kind: 'toggle' }, reader: 'stop' });
  });

  it('"play" over a note holding the film carries on with the film — it never asks for the card to be read', () => {
    expect(mediaOutcome('play', NOTE_HOLDING, PAUSED)).toEqual({ film: { kind: 'play' } });
    expect(mediaOutcome('play', { ...NOTE_HOLDING, reading: true }, PAUSED)).toEqual({ film: { kind: 'play' }, reader: 'stop' });
  });

  it('"pause" over a note holding the film keeps it paused once the note has gone', () => {
    expect(mediaOutcome('pause', NOTE_HOLDING, PAUSED)).toEqual({ film: { kind: 'pause' } });
  });

  it('"pause" ends a reading under way, whatever the film is doing', () => {
    expect(mediaOutcome('pause', { ...DOOR_OVER, reading: true }, FILM)).toEqual({ film: { kind: 'pause' }, reader: 'stop' });
  });

  it('never starts a reading except by the Play/Pause that is the key', () => {
    for (const command of ['play', 'pause', 'stop', 'startOver', 'skipForward', 'skipBackward'] as const) {
      for (const film of [FILM, PAUSED]) {
        expect(mediaOutcome(command, NOTE_HOLDING, film).reader).not.toBe('toggle');
        expect(mediaOutcome(command, DOOR_OVER, film).reader).not.toBe('toggle');
      }
    }
  });

  it('starts over from the first frame, and plays', () => {
    expect(mediaOutcome('startOver', NOTHING_ON, PAUSED)).toEqual({ film: { kind: 'seek', toMs: 0, thenPlay: true } });
  });

  it('skips by the step the platform names, or by the skip keys’ thirty seconds', () => {
    expect(mediaOutcome('skipForward', NOTHING_ON, FILM, 10_000)).toEqual({ film: { kind: 'seek', toMs: 130_000, thenPlay: false } });
    expect(mediaOutcome('skipBackward', NOTHING_ON, FILM)).toEqual({ film: { kind: 'seek', toMs: 120_000 - SEEK_STEP_MS, thenPlay: false } });
    expect(mediaOutcome('skipForward', NOTHING_ON, FILM, -5)).toEqual({ film: { kind: 'seek', toMs: 120_000 + SEEK_STEP_MS, thenPlay: false } });
  });

  it('never skips past the last second, or before the first frame', () => {
    expect(mediaOutcome('skipForward', NOTHING_ON, { ...FILM, positionMs: 598_000 }, 60_000).film).toEqual({ kind: 'seek', toMs: 599_000, thenPlay: false });
    expect(mediaOutcome('skipBackward', NOTHING_ON, { ...FILM, positionMs: 4_000 }, 60_000).film).toEqual({ kind: 'seek', toMs: 0, thenPlay: false });
  });

  it('does nothing at all while the door camera has the screen', () => {
    for (const command of ['play', 'pause', 'toggle', 'stop', 'startOver', 'skipForward', 'skipBackward'] as const) {
      expect(mediaOutcome(command, { ...NOTHING_ON, suspended: true }, FILM)).toEqual({});
    }
  });
});

describe('moveFilm — done to the one player, as the keys do it', () => {
  const player = (paused: boolean): MovablePlayer & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      paused,
      currentTime: 100,
      play() {
        calls.push('play');
      },
      pause() {
        calls.push('pause');
      },
    };
  };

  it('pauses, plays and toggles', () => {
    const playing = player(false);
    moveFilm(playing, { kind: 'toggle' }, () => undefined);
    moveFilm(playing, { kind: 'pause' }, () => undefined);
    expect(playing.calls).toEqual(['pause', 'pause']);
    const paused = player(true);
    moveFilm(paused, { kind: 'play' }, () => undefined);
    moveFilm(paused, { kind: 'toggle' }, () => undefined);
    expect(paused.calls).toEqual(['play', 'play']);
  });

  it('says a pause is hers, even when the film is already paused under a note', () => {
    let hers = 0;
    const paused = player(true);
    moveFilm(paused, { kind: 'pause' }, () => (hers += 1));
    expect(hers).toBe(1);
    expect(paused.calls).toEqual([]);
  });

  it('seeks, and plays after only when asked to', () => {
    const p = player(true);
    moveFilm(p, { kind: 'seek', toMs: 30_500, thenPlay: false }, () => undefined);
    expect(p.currentTime).toBe(30.5);
    expect(p.calls).toEqual([]);
    moveFilm(p, { kind: 'seek', toMs: 0, thenPlay: true }, () => undefined);
    expect(p.currentTime).toBe(0);
    expect(p.calls).toEqual(['play']);
  });
});

describe('the session the platform is told about', () => {
  const snapshot = { state: 'PLAYING' as const, positionMs: 60_000, durationMs: 600_000, contentId: 'sintel' };

  it('says which film, where it is, and offers only what Wick does', () => {
    const view = sessionView(snapshot, 5_000);
    expect(view).toMatchObject({ status: 'PLAYING', speed: 1, positionMs: 60_000, updatedAtMs: 5_000, durationMs: 600_000, contentId: 'sintel', skipStepMs: SEEK_STEP_MS });
    expect(view.actions).toEqual(['PAUSE', 'TOGGLE_PLAY_PAUSE', 'STOP', 'START_OVER', 'SKIP_FORWARD', 'SKIP_BACKWARD']);
    expect(sessionView({ ...snapshot, state: 'PAUSED' }, 5_000).actions[0]).toBe('PLAY');
    expect(sessionView({ ...snapshot, state: 'STOPPED' }, 5_000)).toMatchObject({ status: 'NOT_PLAYING', speed: 0 });
  });

  it('is told again on a change of state, a seek or a stall — not on every tick', () => {
    const first = sessionView(snapshot, 0);
    expect(shouldPublish(undefined, first)).toBe(true);
    expect(shouldPublish(first, sessionView({ ...snapshot, positionMs: 61_000 }, 1_000))).toBe(false);
    expect(shouldPublish(first, sessionView({ ...snapshot, state: 'PAUSED', positionMs: 61_000 }, 1_000))).toBe(true);
    expect(shouldPublish(first, sessionView({ ...snapshot, positionMs: 91_000 }, 1_000))).toBe(true);
    expect(shouldPublish(first, sessionView({ ...snapshot, positionMs: 60_000 }, 5_000))).toBe(true);
    expect(shouldPublish(first, sessionView({ ...snapshot, contentId: 'tears-of-steel' }, 1_000))).toBe(true);
  });

  it('names the film and the line that credits it, as her screen does', () => {
    expect(sessionMetadata({ title: 'Sintel', attribution: '© Blender Foundation | durian.blender.org' })).toEqual({
      title: 'Sintel',
      description: '© Blender Foundation | durian.blender.org',
      mediaType: 'video',
    });
  });

  it('turns milliseconds into the platform’s time and back', () => {
    expect(toTimeValue(61_250)).toEqual({ seconds: 61, nanoseconds: 250_000_000 });
    expect(fromTimeValue({ seconds: 30, nanoseconds: 500_000_000 })).toBe(30_500);
    expect(fromTimeValue(undefined)).toBeUndefined();
  });
});

describe('refusesEverything — the seat beside her film, and Wick with no film on', () => {
  it('refuses every command the platform can send, and touches nothing', async () => {
    const handler = refusesEverything();
    for (const name of REFUSED_COMMANDS) {
      await expect(handler[name]()).rejects.toBeInstanceOf(Refused);
    }
  });

  it('answers the platform’s question with the state it is given for “no film”', async () => {
    await expect(refusesEverything().handleGetSessionState()).resolves.toEqual([]);
    await expect(refusesEverything([{ status: 'NOT_PLAYING' }]).handleGetSessionState()).resolves.toEqual([{ status: 'NOT_PLAYING' }]);
  });

  it('names every command handler the platform calls', () => {
    // IMediaControlHandlerAsync (kepler-media-controls 1.0.25): 23 methods, the session-state question answered apart.
    expect(new Set(REFUSED_COMMANDS).size).toBe(22);
    expect(REFUSED_COMMANDS).toEqual(expect.arrayContaining(['handlePlay', 'handlePause', 'handleTogglePlayPause', 'handleNext', 'handlePrevious', 'handleSeek']));
  });
});

describe('keyEchoes — one press of the remote is one press', () => {
  it('knows the session’s Play/Pause that follows the key a moment later for the same press', () => {
    // Seen on the Vega Virtual Device: the key at .104 s, the session's command at .163 s.
    const echoes = keyEchoes();
    echoes.key('play', 1_000);
    expect(echoes.echoes('toggle', 1_060)).toBe(true);
  });

  it('knows it when the command comes first, too', () => {
    const echoes = keyEchoes();
    echoes.key('playpause', 1_200);
    expect(echoes.echoes('toggle', 1_000)).toBe(true);
  });

  it('lets a command with no key near it through: that is a voice, or the system’s controls', () => {
    const echoes = keyEchoes();
    expect(echoes.echoes('pause', 1_000)).toBe(false);
    echoes.key('play', 1_000);
    expect(echoes.echoes('pause', 1_000 + ECHO_WINDOW_MS + 1)).toBe(false);
  });

  it('matches a command only to its own button', () => {
    const echoes = keyEchoes();
    echoes.key('forward', 1_000);
    expect(echoes.echoes('skipForward', 1_050)).toBe(true);
    expect(echoes.echoes('skipBackward', 1_050)).toBe(false);
    expect(echoes.echoes('toggle', 1_050)).toBe(false);
    // OK and the arrows are never a media button, and start over has none.
    echoes.key('select', 2_000);
    echoes.key('right', 2_000);
    expect(echoes.echoes('toggle', 2_010)).toBe(false);
    expect(echoes.echoes('startOver', 1_010)).toBe(false);
  });

  it('never takes a key named like an object’s own property for a button', () => {
    const echoes = keyEchoes();
    echoes.key('constructor', 1_000);
    expect(echoes.echoes('toggle', 1_000)).toBe(false);
  });
});
