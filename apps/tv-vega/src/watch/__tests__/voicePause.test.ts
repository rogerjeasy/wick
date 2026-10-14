/**
 * The flow the media session exists for: "Alexa, pause" → the film pauses →
 * the note that was waiting comes on screen at that break, holding the film
 * → she answers it with the D-pad, or says "Alexa, play" → the film goes on.
 *
 * The parts are the real ones — the command rule (mediaSession.ts), the
 * move done to the player, and the BreakController the app runs — with a
 * player that only keeps where it is. The same steps with her Play/Pause
 * key come out the same, which is the point: a pause made by voice is a
 * pause.
 */
import { describe, expect, it } from 'vitest';
import type { MessageCard, QueuedCard } from '@wick/contracts';
import { BreakController } from '../../break/BreakController.js';
import { PAUSE_IS_BREAK_MS } from '../../break/types.js';
import type { PlayerSnapshot } from '../../player/PlayerService.js';
import { mediaOutcome, moveFilm, type MediaCommand, type MediaContext } from '../mediaSession.js';
import { playIsTheCards, watchCommand } from '../remoteKeys.js';

const FILM_ID = 'sintel';
const DURATION_MS = 888_000;
const CREDITS_MS = 744_000;
const CALM_POINT_MS = 184_000;

function note(): QueuedCard {
  const card: MessageCard = {
    type: 'MESSAGE', id: 'note-1', householdId: 'hh-1', correlationId: 'c1', createdAt: 0, actions: [],
    fromName: 'Sarah', suggestedReplies: [],
  };
  return { id: 'note-1', urgency: 'DEFERRED', card, queuedAt: 0, shownCount: 0 };
}

/** Her television, as far as this flow goes: one player, the app's BreakController, and what is on screen. */
function television(startMs: number) {
  const player = {
    paused: false,
    currentTime: startMs / 1000,
    play() {
      this.paused = false;
    },
    pause() {
      this.paused = true;
    },
  };
  const breaks = new BreakController({ calmPointsOf: (id) => (id === FILM_ID ? [CALM_POINT_MS] : undefined) });
  breaks.setForeground(true, 0);
  const queue = [note()];
  let resumeAfterCard = false;
  let card: QueuedCard | undefined;
  let askedFor: string | null = null;

  const snapshot = (): PlayerSnapshot => ({
    state: player.paused ? 'PAUSED' : 'PLAYING',
    positionMs: Math.round(player.currentTime * 1000),
    durationMs: DURATION_MS,
    creditsPositionMs: CREDITS_MS,
    contentId: FILM_ID,
  });

  const tv = {
    player,
    /** One look, as the app's one-second tick makes it: the player reports, the engine picks, the held film waits. */
    look(now: number) {
      breaks.setPlayback(snapshot(), now);
      const before = card;
      card = breaks.pickCard(queue, now);
      breaks.noteShown(card, queue, now);
      if (card?.id !== before?.id) askedFor = null;
      const held = breaks.holdsProgramme(card);
      // WatchScreen's `held` effect: the film waits on the cut, and goes on after if it was going.
      if (held && !before) {
        resumeAfterCard = !player.paused;
        player.pause();
        // The player says so at once (PlayerService reports every pause).
        breaks.setPlayback(snapshot(), now);
      } else if (!card && before && resumeAfterCard) {
        resumeAfterCard = false;
        player.play();
      }
      return card;
    },
    context(): MediaContext {
      const held = breaks.holdsProgramme(card);
      const playReads = playIsTheCards({ card: card?.id, holdsFilm: held, askedFor });
      return { cardVisible: card !== undefined, playReads, held, suspended: false };
    },
    /** A command from the platform's media controls, done as WatchScreen does it. */
    say(command: MediaCommand) {
      const outcome = mediaOutcome(command, tv.context(), { paused: player.paused, positionMs: player.currentTime * 1000, durationMs: DURATION_MS });
      if (outcome.reader === 'toggle' && card) askedFor = card.id;
      if (outcome.film) moveFilm(player, outcome.film, () => (resumeAfterCard = false));
      return outcome;
    },
    /** Her Play/Pause key, done as WatchScreen does it. */
    press(key: string) {
      const command = watchCommand({ eventType: key, eventKeyAction: 0 }, tv.context());
      if (command === 'toggle') {
        if (player.paused) player.play();
        else player.pause();
      }
    },
    /** She answers the card: it is gone from the queue (ResidentApp.handleAction). */
    answer() {
      if (!card) return;
      breaks.answered(card.id);
      queue.splice(queue.findIndex((q) => q.id === card!.id), 1);
    },
  };
  return tv;
}

describe('"Alexa, pause" is a natural break, exactly as the key is', () => {
  it('holds a note in the middle of a scene, and shows it once the voice pause has lasted', () => {
    const tv = television(60_000);
    expect(tv.look(0)).toBeUndefined();

    expect(tv.say('pause')).toEqual({ film: { kind: 'pause' } });
    expect(tv.player.paused).toBe(true);

    expect(tv.look(1_000)).toBeUndefined();
    expect(tv.look(1_000 + PAUSE_IS_BREAK_MS)).toBeUndefined();
    // The pause has lasted: the note comes on screen over it, and holds the film.
    expect(tv.look(1_001 + PAUSE_IS_BREAK_MS)?.id).toBe('note-1');
    expect(tv.context()).toMatchObject({ cardVisible: true, held: true, playReads: true });
  });

  it('comes out exactly as the same pause made with her key', () => {
    const byVoice = television(60_000);
    const byKey = television(60_000);
    byVoice.look(0);
    byKey.look(0);
    byVoice.say('pause');
    byKey.press('playpause');
    for (const at of [1_000, 3_000, 6_500, 7_500]) expect(byVoice.look(at)?.id).toBe(byKey.look(at)?.id);
  });

  it('answered with the D-pad, the note goes and the film stays paused — it was her pause', () => {
    const tv = television(60_000);
    tv.look(0);
    tv.say('pause');
    tv.look(1_000);
    tv.look(7_000);
    tv.answer();
    expect(tv.look(8_000)).toBeUndefined();
    expect(tv.player.paused).toBe(true);
    // "Alexa, play": the film goes on.
    expect(tv.say('play')).toEqual({ film: { kind: 'play' } });
    expect(tv.player.paused).toBe(false);
  });

  it('"Alexa, play" over the note carries on with the film and puts the note away — it does not read it', () => {
    const tv = television(60_000);
    tv.look(0);
    tv.say('pause');
    tv.look(1_000);
    expect(tv.look(7_000)?.id).toBe('note-1');
    const outcome = tv.say('play');
    expect(outcome.reader).toBeUndefined();
    expect(tv.player.paused).toBe(false);
    expect(tv.look(8_000)).toBeUndefined();
  });
});

describe('a note holding the film on a calm point, and the voice', () => {
  it('"Alexa, play" carries on with the film, as her second Play there does', () => {
    const tv = television(CALM_POINT_MS - 2_000);
    expect(tv.look(0)).toBeUndefined();
    tv.player.currentTime = (CALM_POINT_MS + 500) / 1000;
    expect(tv.look(1_000)?.id).toBe('note-1');
    expect(tv.player.paused).toBe(true);

    tv.say('play');
    expect(tv.player.paused).toBe(false);
    // She chose the film: the note goes, and the calm point she played on from is not a break again.
    expect(tv.look(2_000)).toBeUndefined();
  });

  it('the remote’s Play/Pause through the session reads the note first, like the key', () => {
    const tv = television(CALM_POINT_MS - 2_000);
    tv.look(0);
    tv.player.currentTime = (CALM_POINT_MS + 500) / 1000;
    tv.look(1_000);
    expect(tv.say('toggle')).toEqual({ reader: 'toggle' });
    expect(tv.player.paused).toBe(true);
    // The next is the film's again.
    expect(tv.say('toggle').film).toEqual({ kind: 'toggle' });
    expect(tv.player.paused).toBe(false);
  });

  it('"Alexa, pause" while the note holds the film keeps it paused once the note is answered', () => {
    const tv = television(CALM_POINT_MS - 2_000);
    tv.look(0);
    tv.player.currentTime = (CALM_POINT_MS + 500) / 1000;
    tv.look(1_000);
    tv.say('pause');
    tv.answer();
    expect(tv.look(2_000)).toBeUndefined();
    expect(tv.player.paused).toBe(true);
  });

  it('without that, answering the note lets the film go on, as it always did', () => {
    const tv = television(CALM_POINT_MS - 2_000);
    tv.look(0);
    tv.player.currentTime = (CALM_POINT_MS + 500) / 1000;
    tv.look(1_000);
    tv.answer();
    expect(tv.look(2_000)).toBeUndefined();
    expect(tv.player.paused).toBe(false);
  });
});
