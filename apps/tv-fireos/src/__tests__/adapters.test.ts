import { describe, expect, it, vi } from 'vitest';
import { storageFileSystem, type KeyValueStorage } from '../adapters/storageFileSystem.js';
import { remoteKeyEvents, type AndroidRemoteEvent } from '../adapters/remoteEvents.js';
import { VideoPlayer } from '../adapters/videoPlayer.js';
import { deriveSnapshot, PlayerService, type MediaElementLike, type PlayerSnapshot } from '../../../tv-vega/src/player/PlayerService.js';
import { watchCommand } from '../../../tv-vega/src/watch/remoteKeys.js';
import { HOLD_MS, okHold } from '../../../tv-vega/src/watch/hold.js';
import { pressGuard } from '../../../tv-vega/src/family/presses.js';
import { pressSettle } from '../../../tv-vega/src/press/settle.js';
import { QueueStore } from '../../../tv-vega/src/headless/QueueStore.js';
import { resolveDeviceId, SIMULATOR_DEVICE_ID } from '../../../tv-vega/src/deviceId.js';

function memoryStorage(): KeyValueStorage & { readonly kept: Map<string, string> } {
  const kept = new Map<string, string>();
  return {
    kept,
    getItem: async (key) => kept.get(key) ?? null,
    setItem: async (key, value) => {
      kept.set(key, value);
    },
  };
}

describe('storageFileSystem', () => {
  it('reads back what was written, and says how much was written', async () => {
    const fs = storageFileSystem(memoryStorage());

    expect(await fs.writeStringToFile('/data/wick-token.json', '{"jwt":"a"}', 'utf8')).toBe(11);
    expect(await fs.readFileAsString('/data/wick-token.json', 'utf8')).toBe('{"jwt":"a"}');
  });

  it('knows a file that exists from one that does not, and refuses to read the second', async () => {
    const fs = storageFileSystem(memoryStorage());
    await fs.writeStringToFile('/data/a.json', '', 'utf8');

    expect(await fs.exists('/data/a.json')).toBe(true);
    expect(await fs.exists('/data/b.json')).toBe(false);
    await expect(fs.readFileAsString('/data/b.json', 'utf8')).rejects.toThrow('no such file');
  });

  it('keeps its files apart from anything else in the same storage', async () => {
    const storage = memoryStorage();
    storage.kept.set('/data/a.json', 'not ours');

    expect(await storageFileSystem(storage).exists('/data/a.json')).toBe(false);
  });

  it('gives this television an id of its own that is the same on the next launch — not the simulator\'s', async () => {
    const storage = memoryStorage();

    const first = await resolveDeviceId(storageFileSystem(storage));
    const again = await resolveDeviceId(storageFileSystem(storage));

    expect(first).not.toBe(SIMULATOR_DEVICE_ID);
    expect(again).toBe(first);
  });

  it('holds the card queue the Vega app keeps in files', async () => {
    const storage = memoryStorage();
    const card = { id: 'c1', urgency: 'DOOR', receivedAt: 1, card: { type: 'DOOR', line: 'Someone is at the door.' } };

    await new QueueStore(storageFileSystem(storage)).upsert(card as never);

    expect((await new QueueStore(storageFileSystem(storage)).readAll()).map((c) => c.id)).toEqual(['c1']);
  });
});

/** The first thing each Android event becomes: the press, or the key coming up after it. */
const remotePresses = () => {
  const keys = remoteKeyEvents();
  return (event: AndroidRemoteEvent | null | undefined) => keys(event)[0];
};

describe('remoteKeyEvents — one press at a time', () => {
  const DOWN = 0;
  const UP = 1;

  it('renames the media keys to the names the Vega app listens for', () => {
    const press = remotePresses();

    expect(press({ eventType: 'playPause', eventKeyAction: DOWN })?.eventType).toBe('playpause');
    expect(press({ eventType: 'fastForward', eventKeyAction: DOWN })?.eventType).toBe('skip_forward');
    expect(press({ eventType: 'rewind', eventKeyAction: DOWN })?.eventType).toBe('skip_backward');
  });

  it('passes the D-pad and select through as they are', () => {
    const press = remotePresses();

    expect(press({ eventType: 'select', eventKeyAction: DOWN })).toEqual({ eventType: 'select', eventKeyAction: 0 });
    expect(press({ eventType: 'left' })).toEqual({ eventType: 'left', eventKeyAction: 0 });
  });

  it('is one press when a key goes down and comes back up: the second half is passed on as the key coming up, never as a press', () => {
    const press = remotePresses();

    expect(press({ eventType: 'select', eventKeyAction: DOWN })).toEqual({ eventType: 'select', eventKeyAction: 0 });
    // Vega's own "key up" (HWEvent 1): what tells a hold from a press (apps/tv-vega/src/watch/hold.ts).
    const released = press({ eventType: 'select', eventKeyAction: UP });
    expect(released).toEqual({ eventType: 'select', eventKeyAction: 1 });
    expect(watchCommand(released!, { cardVisible: false })).toBeUndefined();
  });

  it('gives the media keys their Vega names on the way up as well', () => {
    const press = remotePresses();
    press({ eventType: 'playPause', eventKeyAction: DOWN });
    expect(press({ eventType: 'playPause', eventKeyAction: UP })).toEqual({ eventType: 'playpause', eventKeyAction: 1 });
  });

  it('is still one press when only the key coming up arrives — what the Android TV emulator sends for play/pause', () => {
    const press = remotePresses();

    expect(press({ eventType: 'playPause', eventKeyAction: UP })).toEqual({ eventType: 'playpause', eventKeyAction: 0 });
  });

  it('is two presses when a key is pressed twice, however each arrives', () => {
    const press = remotePresses();
    const heard = [
      press({ eventType: 'playPause', eventKeyAction: UP }),
      press({ eventType: 'playPause', eventKeyAction: UP }),
      press({ eventType: 'select', eventKeyAction: DOWN }),
      press({ eventType: 'select', eventKeyAction: UP }),
      press({ eventType: 'select', eventKeyAction: DOWN }),
      press({ eventType: 'select', eventKeyAction: UP }),
    ].filter((e) => e?.eventKeyAction === 0);

    // A press is a key going down, as the Vega app hears it; the key coming up after it is not one.
    expect(heard.map((e) => e!.eventType)).toEqual(['playpause', 'playpause', 'select', 'select']);
  });

  it('is one press while a key is held and Android repeats it', () => {
    const press = remotePresses();
    const heard = [DOWN, DOWN, DOWN, UP].map((eventKeyAction) => press({ eventType: 'fastForward', eventKeyAction })).filter(Boolean);

    // Down once, however long it is held, and then up: so a hold can be timed and is never a run of presses.
    expect(heard).toEqual([{ eventType: 'skip_forward', eventKeyAction: 0 }, { eventType: 'skip_forward', eventKeyAction: 1 }]);
  });

  it('keeps each key\'s press apart from another\'s', () => {
    const press = remotePresses();

    expect(press({ eventType: 'left', eventKeyAction: DOWN })).toBeDefined();
    expect(press({ eventType: 'right', eventKeyAction: DOWN })).toBeDefined();
    expect(press({ eventType: 'left', eventKeyAction: UP })).toEqual({ eventType: 'left', eventKeyAction: 1 });
    expect(press({ eventType: 'right', eventKeyAction: UP })).toEqual({ eventType: 'right', eventKeyAction: 1 });
  });

  it('says nothing for focus moving, which arrives the same way', () => {
    const press = remotePresses();

    expect(press({ eventType: 'focus' })).toBeUndefined();
    expect(press({ eventType: 'blur' })).toBeUndefined();
    expect(press(null)).toBeUndefined();
  });

  it('gives the Vega app\'s own key map what it acts on', () => {
    const press = remotePresses();
    const command = (eventType: string) => watchCommand(press({ eventType, eventKeyAction: UP })!, { cardVisible: false });

    expect(command('playPause')).toBe('toggle');
    expect(command('fastForward')).toBe('forward');
    expect(command('rewind')).toBe('back');
    expect(command('select')).toBe('toggle');
  });
});

describe('VideoPlayer', () => {
  it('is everything PlayerService reads from a player', () => {
    const media: MediaElementLike = new VideoPlayer();

    expect(media.paused).toBe(true);
  });

  it('starts paused with nothing loaded', () => {
    const player = new VideoPlayer();

    expect(deriveSnapshot(player, 'sintel', undefined)).toMatchObject({ state: 'PAUSED', positionMs: 0, durationMs: 0 });
  });

  it('is buffering from play until the picture moves, then playing', async () => {
    const player = new VideoPlayer();
    const heard: string[] = [];
    for (const type of ['play', 'playing', 'waiting']) player.addEventListener(type, () => heard.push(type));
    player.src = 'https://wick.test/sintel.m3u8';

    await player.play();
    expect(deriveSnapshot(player, 'sintel', undefined).state).toBe('BUFFERING');

    player.reportLoaded(888);
    player.reportProgress(0.25);
    player.reportProgress(0.5);

    expect(deriveSnapshot(player, 'sintel', undefined)).toMatchObject({ state: 'PLAYING', positionMs: 500, durationMs: 888_000 });
    expect(heard).toEqual(['play', 'playing']);
  });

  it('is buffering again when the stream stalls, and playing when it comes back', async () => {
    const player = new VideoPlayer();
    const heard: string[] = [];
    for (const type of ['playing', 'waiting']) player.addEventListener(type, () => heard.push(type));
    await player.play();
    player.reportProgress(1);

    player.reportBuffering(true);
    expect(deriveSnapshot(player, 'sintel', undefined).state).toBe('BUFFERING');

    player.reportBuffering(false);
    player.reportProgress(1.2);
    expect(deriveSnapshot(player, 'sintel', undefined).state).toBe('PLAYING');
    expect(heard).toEqual(['playing', 'waiting', 'playing']);
  });

  it('pauses once, and tells the view each time what it should be doing changes', async () => {
    const player = new VideoPlayer();
    const redraw = vi.fn();
    const paused = vi.fn();
    player.watch(redraw);
    player.addEventListener('pause', paused);

    await player.play();
    player.pause();
    player.pause();

    expect(deriveSnapshot(player, 'sintel', undefined).state).toBe('PAUSED');
    expect(paused).toHaveBeenCalledTimes(1);
    expect(redraw).toHaveBeenCalledTimes(2);
  });

  it('takes a seek at once, so two quick presses skip twice, and passes each to the view', async () => {
    const player = new VideoPlayer();
    const seek = vi.fn();
    player.attach({ seek });
    await player.play();
    player.reportProgress(10);

    player.currentTime = player.currentTime + 30;
    player.currentTime = player.currentTime + 30;

    expect(player.currentTime).toBe(70);
    expect(seek.mock.calls).toEqual([[40], [70]]);
  });

  it('has ended when the programme has, which the watch screen takes as stopped', async () => {
    const player = new VideoPlayer();
    const ended = vi.fn();
    player.addEventListener('ended', ended);
    await player.play();
    player.reportProgress(887);

    player.reportEnded();

    expect(deriveSnapshot(player, 'sintel', undefined).state).toBe('STOPPED');
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('plays a second programme from the start after the first ended', async () => {
    const player = new VideoPlayer();
    await player.play();
    player.reportProgress(887);
    player.reportEnded();

    player.src = 'https://wick.test/big-buck-bunny.m3u8';
    await player.play();

    expect(deriveSnapshot(player, 'bbb', undefined)).toMatchObject({ state: 'BUFFERING', positionMs: 0 });
  });

  it('reports a failure to whoever asked, and stops listening to anyone once it is given up', async () => {
    const player = new VideoPlayer();
    const failed = vi.fn();
    player.addEventListener('error', failed);

    player.reportError();
    await player.deinitialize();
    player.reportError();

    expect(failed).toHaveBeenCalledTimes(1);
    expect(player.src).toBe('');
  });

  it('gives PlayerService a snapshot on each change of state, as the Vega player does', async () => {
    const player = new VideoPlayer();
    const service = new PlayerService(player, { setIntervalImpl: (() => 0) as never, clearIntervalImpl: (() => {}) as never });
    const states: PlayerSnapshot['state'][] = [];
    service.onSnapshot((s) => states.push(s.state));
    service.start();
    service.load('sintel');

    await player.play();
    player.reportProgress(1);
    player.pause();
    player.reportEnded();

    expect(states).toEqual(['PAUSED', 'BUFFERING', 'PLAYING', 'PAUSED', 'STOPPED']);
  });
});

describe('remoteKeyEvents — a press, and a hold, as Fire OS really reports them', () => {
  const UP = 1;
  const DOWN = 0;

  it('makes a whole press of a key that is only reported coming up: down, then up — never a key left down', () => {
    // React Native on Android sends no key-down to JavaScript unless a flag is set, so a short OK is one `select`, action 1.
    const keys = remoteKeyEvents();
    expect(keys({ eventType: 'select', eventKeyAction: UP })).toEqual([
      { eventType: 'select', eventKeyAction: 0 },
      { eventType: 'select', eventKeyAction: 1 },
    ]);
    // And the next press is a press again, not a key "still held".
    expect(keys({ eventType: 'select', eventKeyAction: UP })).toHaveLength(2);
  });

  it('says a held OK as OK going down and, when it is let go, coming up — Android calls both "longSelect"', () => {
    const keys = remoteKeyEvents();
    expect(keys({ eventType: 'longSelect', eventKeyAction: DOWN })).toEqual([{ eventType: 'select', eventKeyAction: 0 }]);
    expect(keys({ eventType: 'longSelect', eventKeyAction: DOWN })).toEqual([]);
    expect(keys({ eventType: 'longSelect', eventKeyAction: UP })).toEqual([{ eventType: 'select', eventKeyAction: 1 }]);
  });

  it('is one press when a key-down was reported and the hold is then noticed', () => {
    const keys = remoteKeyEvents();
    expect(keys({ eventType: 'select', eventKeyAction: DOWN })).toHaveLength(1);
    expect(keys({ eventType: 'longSelect', eventKeyAction: DOWN })).toEqual([]);
    expect(keys({ eventType: 'longSelect', eventKeyAction: UP })).toEqual([{ eventType: 'select', eventKeyAction: 1 }]);
  });
});

describe('holding OK on Fire OS (apps/tv-vega/src/watch/hold.ts, fed through this adapter)', () => {
  const feed = () => {
    const keys = remoteKeyEvents();
    const onHold = vi.fn();
    const hold = okHold({ onHold, canHold: () => true });
    const send = (event: AndroidRemoteEvent) => keys(event).forEach((e) => hold.onEvent(e));
    return { send, onHold, hold };
  };

  it('is never begun by a short press — the press that used to bring the card two seconds later', () => {
    vi.useFakeTimers();
    try {
      const { send, onHold, hold } = feed();
      send({ eventType: 'select', eventKeyAction: 1 });
      vi.advanceTimersByTime(10 * HOLD_MS);
      expect(onHold).not.toHaveBeenCalled();
      expect(hold.held()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is never begun by a press reported with no halves at all', () => {
    vi.useFakeTimers();
    try {
      const { send, onHold } = feed();
      send({ eventType: 'select' });
      vi.advanceTimersByTime(10 * HOLD_MS);
      expect(onHold).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is a hold when OK stays down two seconds, and can be made again afterwards', () => {
    vi.useFakeTimers();
    try {
      const { send, onHold } = feed();
      for (let i = 0; i < 2; i += 1) {
        send({ eventType: 'longSelect', eventKeyAction: 0 });
        vi.advanceTimersByTime(HOLD_MS);
        send({ eventType: 'longSelect', eventKeyAction: 1 });
      }
      expect(onHold).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is not one when a long-ish press is let go before two seconds: that pauses the film, once', () => {
    vi.useFakeTimers();
    try {
      const keys = remoteKeyEvents();
      const heard = [...keys({ eventType: 'longSelect', eventKeyAction: 0 })];
      vi.advanceTimersByTime(1_000);
      heard.push(...keys({ eventType: 'longSelect', eventKeyAction: 1 }));
      expect(heard.filter((e) => watchCommand(e, { cardVisible: false }) === 'toggle')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});


// A wave is sent only by a press aimed at it: one made after an arrow key
// (apps/tv-vega/src/family/presses.ts). Here the keys are the shapes Fire OS
// really sends (FRICTION.md FL-028), through this adapter, as the family
// screen hears them.
describe('the wave on Fire OS (apps/tv-vega/src/family/presses.ts, fed through this adapter)', () => {
  /** Android's KeyEvent.ACTION_DOWN and ACTION_UP. */
  const DOWN = 0;
  const UP = 1;
  const T = 1_800_000_000_000;

  /** The family home with nothing in front, and the remote's keys reaching the guard as they do on Fire OS. */
  function home() {
    const keys = remoteKeyEvents();
    const guard = pressGuard();
    guard.surface('home', T);
    return {
      guard,
      /** One Android key event, at `ms` after the home appeared. */
      android(event: AndroidRemoteEvent, ms: number) {
        for (const key of keys(event)) guard.key(key, T + ms);
      },
    };
  }

  it('is not armed by OK pressed short — the key coming up and nothing else — however many times', () => {
    const tv = home();
    // The platform has handed the focus to the wave.
    tv.guard.waveFocused(T + 100);

    for (let press = 0; press < 3; press += 1) tv.android({ eventType: 'select', eventKeyAction: UP }, 600 + press * 500);

    expect(tv.guard.waveActs(T + 2_000)).toBe(false);
  });

  it('is not armed by OK held, which Fire OS calls by another name', () => {
    const tv = home();
    tv.guard.waveFocused(T + 100);

    tv.android({ eventType: 'longSelect', eventKeyAction: DOWN }, 500);
    tv.android({ eventType: 'longSelect', eventKeyAction: UP }, 2_600);

    expect(tv.guard.waveActs(T + 3_000)).toBe(false);
  });

  it('is armed by Down pressed short: the focus moves as the key goes down, and the key is heard only as it comes up', () => {
    const tv = home();

    // The focus arrives on the wave first; the only word of the key comes a moment later.
    tv.guard.waveFocused(T + 5_000);
    expect(tv.guard.waveActs(T + 5_010)).toBe(false);
    tv.android({ eventType: 'down', eventKeyAction: UP }, 5_080);

    expect(tv.guard.waveActs(T + 5_500)).toBe(true);
  });

  it('is armed by Down heard in both halves, once', () => {
    const tv = home();

    tv.android({ eventType: 'down', eventKeyAction: DOWN }, 5_000);
    tv.guard.waveFocused(T + 5_010);
    tv.android({ eventType: 'down', eventKeyAction: UP }, 5_090);

    expect(tv.guard.waveActs(T + 5_500)).toBe(true);
  });

  it('is not armed by the focus moving, which Fire OS reports through the same channel as the keys', () => {
    const tv = home();
    tv.guard.waveFocused(T + 100);

    tv.android({ eventType: 'focus' }, 100);
    tv.android({ eventType: 'blur' }, 100);

    expect(tv.guard.waveActs(T + 1_000)).toBe(false);
  });

  it('the accident itself, in Fire OS’s own keys: OK, the focus handed over, OK again — no wave; then Down, OK — a wave', () => {
    const tv = home();
    // A card was in front, and OK on "Not now" put it away: the home is what is left.
    tv.guard.surface('card:ftv-week-2026-W41:ftv-read,ftv-later', T + 1_000);
    tv.android({ eventType: 'select', eventKeyAction: UP }, 9_000);
    tv.guard.surface('home', T + 9_000);
    tv.guard.waveFocused(T + 9_020);

    tv.android({ eventType: 'select', eventKeyAction: UP }, 9_500);
    expect(tv.guard.waveActs(T + 9_500)).toBe(false);

    tv.android({ eventType: 'down', eventKeyAction: UP }, 12_000);
    tv.android({ eventType: 'select', eventKeyAction: UP }, 13_000);
    expect(tv.guard.waveActs(T + 13_000)).toBe(true);
  });
});

// A card's buttons take no press in the card's first second on screen
// (apps/tv-vega/src/press/settle.ts). On Fire OS a short press is heard only
// as the key coming up (FRICTION.md FL-028): there is no telling when it
// began. So the rule compares when the press is SEEN with when the card
// appeared — which is all this television can know.
describe('a card’s first second on Fire OS (apps/tv-vega/src/press/settle.ts, with this adapter’s keys)', () => {
  const UP = 1;
  const T = 1_800_000_000_000;

  it('hears a short OK whole and at one moment — the moment it came up: that is when the press is seen', () => {
    const keys = remoteKeyEvents();

    expect(keys({ eventType: 'select', eventKeyAction: UP })).toEqual([
      { eventType: 'select', eventKeyAction: 0 },
      { eventType: 'select', eventKeyAction: 1 },
    ]);
  });

  it('does not answer a card with a short OK seen 300 ms after the card appeared, and does with one seen at 1.1 s', () => {
    const keys = remoteKeyEvents();
    const settle = pressSettle();
    const acted: number[] = [];
    /** The press reaches the card's focused button when the key comes up; the guard is asked then. */
    const okSeenAt = (ms: number): void => {
      const press = keys({ eventType: 'select', eventKeyAction: UP });
      if (press.some((key) => key.eventKeyAction === 0) && settle.acts(T + ms)) acted.push(ms);
    };

    // She answered the card before; the next one is released, its first button focused.
    settle.appeared('tell-d7', T);
    okSeenAt(300);
    expect(acted).toEqual([]);
    okSeenAt(1_100);
    expect(acted).toEqual([1_100]);
  });

  it('never swallows the D-pad: an arrow in the card’s first second still moves the focus', () => {
    const keys = remoteKeyEvents();
    const settle = pressSettle();
    settle.appeared('tell-d7', T);

    // The guard is asked about presses on a button and about nothing else: an arrow is passed on as it always was.
    expect(keys({ eventType: 'right', eventKeyAction: UP })).toEqual([
      { eventType: 'right', eventKeyAction: 0 },
      { eventType: 'right', eventKeyAction: 1 },
    ]);
    expect(settle.acts(T + 200)).toBe(false);
  });

  it('holds a long OK to the same second, under the name Fire OS gives it', () => {
    const keys = remoteKeyEvents();
    const settle = pressSettle();
    settle.appeared('reach-1', T);

    expect(keys({ eventType: 'longSelect', eventKeyAction: 0 })).toEqual([{ eventType: 'select', eventKeyAction: 0 }]);
    expect(settle.acts(T + 400)).toBe(false);
    expect(settle.acts(T + 1_000)).toBe(true);
  });
});
