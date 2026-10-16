/**
 * Her film as Android's media session on Fire OS (media/filmSession.ts,
 * adapters/mediaControls.ts): the Vega app's own session code
 * (apps/tv-vega/src/watch/mediaControls.ts, media/noFilm.ts) run against
 * the Fire OS stand-in, with a stand-in for the Android module in place of
 * android/.../media/FilmSessionModule.kt. What a command then does to the
 * film is the shared rules', tested in apps/tv-vega
 * (watch/__tests__/mediaSession.test.ts); this holds the Fire OS session
 * to delivering every command to them, and to having a session only while
 * a film of hers is on the screen. Android's half was run on the emulator
 * (apps/tv-fireos/README.md).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeCommand, NativeFilm } from '../media/filmSession.js';

const android = vi.hoisted(() => {
  const calls: Array<{ readonly kind: 'publish'; readonly film: NativeFilm } | { readonly kind: 'release' }> = [];
  let listener: ((command: NativeCommand) => void) | undefined;
  return {
    calls,
    say: (command: NativeCommand) => listener?.(command),
    native: {
      publish: async (film: NativeFilm) => {
        calls.push({ kind: 'publish', film });
      },
      release: async () => {
        calls.push({ kind: 'release' });
      },
      onCommand(next: (command: NativeCommand) => void) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    },
  };
});

vi.mock('../media/native', () => ({ nativeFilmSession: android.native }));
vi.mock('@amazon-devices/kepler-media-controls', () => import('../adapters/mediaControls'));

const { startFilmSession } = await import('../../../tv-vega/src/watch/mediaControls.js');
const { refuseFilmCommands } = await import('../../../tv-vega/src/media/noFilm.js');
const { HANDLER_FOR, nativeFilm } = await import('../media/filmSession.js');

const COMPONENT = { name: 'com.wick.tv.main', type: 0, id: 'fireos' };
const PROGRAMME = { id: 'big-buck-bunny', title: 'Big Buck Bunny', attribution: '(c) Blender Foundation, CC BY 3.0' };
const playing = { state: 'PLAYING' as const, positionMs: 95_000, durationMs: 596_000, contentId: 'big-buck-bunny' };
const paused = { ...playing, state: 'PAUSED' as const };

/** Lets the adapter's queue, and a command's promise, run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

const published = (): NativeFilm[] => android.calls.flatMap((c) => (c.kind === 'publish' ? [c.film] : []));

function startHerFilm() {
  const commands: Array<[string, number | undefined]> = [];
  const session = startFilmSession({ component: COMPONENT, programme: PROGRAMME, command: (command, deltaMs) => commands.push([command, deltaMs]) });
  return { session, commands };
}

beforeEach(async () => {
  // The film of the test before is let go, so each starts with no session.
  refuseFilmCommands(COMPONENT);
  await settle();
  android.calls.length = 0;
});

describe('her film, as Android’s media session', () => {
  it('publishes the film playing — its name, its length, where it is and what can be done to it', async () => {
    const { session } = startHerFilm();
    session.publish(playing);
    await settle();

    expect(published()).toEqual([
      {
        status: 'PLAYING',
        positionMs: 95_000,
        speed: 1,
        durationMs: 596_000,
        contentId: 'big-buck-bunny',
        title: 'Big Buck Bunny',
        description: '(c) Blender Foundation, CC BY 3.0',
        actions: ['Pause', 'TogglePlayPause', 'Stop', 'StartOver', 'SkipForward', 'SkipBackward'],
      },
    ]);
    session.end();
  });

  it('says Play, not Pause, once the film is paused', async () => {
    const { session } = startHerFilm();
    session.publish(playing);
    session.publish(paused);
    await settle();

    expect(published().map((f) => [f.status, f.speed, f.actions[0]])).toEqual([
      ['PLAYING', 1, 'Pause'],
      ['PAUSED', 0, 'Play'],
    ]);
    session.end();
  });

  it('hands every command to the shared rules by its own name, and a skip with the distance asked for', async () => {
    const { session, commands } = startHerFilm();
    session.publish(playing);
    await settle();

    for (const command of ['pause', 'play', 'toggle', 'stop', 'startOver', 'skipForward', 'skipBackward']) android.say({ command });
    android.say({ command: 'skipBackward', deltaMs: 30_000 });
    await settle();

    expect(commands).toEqual([
      ['pause', undefined],
      ['play', undefined],
      ['toggle', undefined],
      ['stop', undefined],
      ['startOver', undefined],
      ['skipForward', undefined],
      ['skipBackward', undefined],
      ['skipBackward', 30_000],
    ]);
    session.end();
  });

  it('lets anything else Android could send go by: there is no next, no previous, no seek to a time', async () => {
    const { session, commands } = startHerFilm();
    session.publish(playing);
    for (const command of ['next', 'previous', 'seek', 'handlePlay', 'toString', '__proto__']) android.say({ command });
    await settle();

    expect(commands).toEqual([]);
    session.end();
  });

  it('releases the session when the film is let go, and obeys nothing after', async () => {
    const { session, commands } = startHerFilm();
    session.publish(playing);
    session.end();
    await settle();

    expect(android.calls.map((c) => c.kind)).toEqual(['publish', 'release']);
    android.say({ command: 'play' });
    android.say({ command: 'pause' });
    await settle();
    expect(commands).toEqual([]);
  });

  it('never makes a session on a family member’s seat, whose handler refuses everything', async () => {
    refuseFilmCommands(COMPONENT);
    android.say({ command: 'pause' });
    await settle();

    expect(published()).toEqual([]);
  });

  it('names each command for one of Vega’s handlers, and only the seven a film obeys', () => {
    expect(HANDLER_FOR).toEqual({
      play: 'handlePlay',
      pause: 'handlePause',
      toggle: 'handleTogglePlayPause',
      stop: 'handleStop',
      startOver: 'handleStartOver',
      skipForward: 'handleSkipForward',
      skipBackward: 'handleSkipBackward',
    });
  });

  it('reads “no film” as Vega says it: a state that offers nothing', () => {
    expect(nativeFilm(undefined, { title: '', description: '' })).toBeUndefined();
  });
});
