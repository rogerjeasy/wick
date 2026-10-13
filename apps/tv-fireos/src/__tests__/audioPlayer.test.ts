/**
 * Read to me on Fire OS (packages/contracts/src/speech.ts): the audio
 * player the shared code asks for, standing on react-native-video
 * (adapters/audioPlayer.ts, AudioHost.tsx).
 *
 * What is tested here is the object's own logic — what it tells the unseen
 * view to do, and what it says back — and that the shared reader
 * (apps/tv-vega/src/read/reading.ts) can read a card through it. Whether a
 * voice is heard, and whether the film's sound goes on under it, cannot be
 * known here: it has not been run on a device.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AudioContentType, AudioPlayer, AudioUsageType, audioStage } from '../adapters/audioPlayer.js';
import { Reader, type SpeechPlayer } from '../../../tv-vega/src/read/reading.js';

const ADDRESS = 'https://speech.example/tts/hh-1/abc.mp3';
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

/** The unseen view, mounted for one test. */
let unmount: (() => void) | undefined;
const hosted = (): void => {
  unmount = audioStage.mount();
};
afterEach(async () => {
  // The stage is the app's one: nothing is left standing on it for the next test.
  for (const player of audioStage.players()) await player.deinitialize();
  unmount?.();
  unmount = undefined;
});

/** A player made ready, with what it says written down. */
async function ready() {
  hosted();
  const player = new AudioPlayer(AudioContentType.CONTENT_TYPE_SPEECH, AudioUsageType.USAGE_MEDIA);
  const said: string[] = [];
  await player.initialize();
  for (const type of ['playing', 'ended', 'error']) player.addEventListener(type, () => said.push(type));
  return { player, said };
}

describe('the names the shared code asks for', () => {
  it('are the same numbers as Vega’s own: speech, and media', () => {
    const vega = createRequire(import.meta.url)('../../../../node_modules/@amazon-devices/react-native-w3cmedia/dist/interface/MediaTypes.js') as {
      AudioContentType: Record<string, number>;
      AudioUsageType: Record<string, number>;
    };

    expect(AudioContentType.CONTENT_TYPE_SPEECH).toBe(vega.AudioContentType.CONTENT_TYPE_SPEECH);
    expect(AudioUsageType.USAGE_MEDIA).toBe(vega.AudioUsageType.USAGE_MEDIA);
  });
});

describe('AudioPlayer — where it can play at all', () => {
  it('cannot until the unseen view is on the screen: it says so, and making one ready fails', async () => {
    expect(AudioPlayer.available).toBe(false);
    await expect(new AudioPlayer().initialize()).rejects.toThrow();
    expect(audioStage.players()).toEqual([]);
  });

  it('can once it is, and cannot again when it has gone', async () => {
    hosted();
    expect(AudioPlayer.available).toBe(true);
    await expect(new AudioPlayer().initialize()).resolves.toBeUndefined();

    unmount!();
    unmount = undefined;
    expect(AudioPlayer.available).toBe(false);
  });
});

describe('AudioPlayer — what it tells the view', () => {
  it('is on the stage from being made ready until it is let go', async () => {
    const { player } = await ready();
    expect(audioStage.players()).toEqual([player]);

    await player.deinitialize();
    expect(audioStage.players()).toEqual([]);
  });

  it('has nothing to play until it is given an address, and is paused until it is told to play', async () => {
    const { player } = await ready();
    expect(player.src).toBe('');
    expect(player.paused).toBe(true);

    player.src = ADDRESS;
    await player.play();

    expect(player.src).toBe(ADDRESS);
    expect(player.paused).toBe(false);
  });

  it('tells the view to draw again when the address, playing or the volume changes', async () => {
    const { player } = await ready();
    let drawn = 0;
    const stop = audioStage.watch(() => (drawn += 1));

    player.src = ADDRESS;
    await player.play();
    player.volume = 0.5;
    player.pause();
    expect(drawn).toBe(4);

    await player.deinitialize();
    expect(drawn).toBe(5);
    stop();
  });

  it('keeps its volume between nothing and full', async () => {
    const { player } = await ready();
    expect(player.volume).toBe(1);

    player.volume = 0.3;
    expect(player.volume).toBe(0.3);
    player.volume = 7;
    expect(player.volume).toBe(1);
    player.volume = -1;
    expect(player.volume).toBe(0);
  });

  it('gives each player its own key, so two readings one after another are two views', async () => {
    const first = await ready();
    const second = new AudioPlayer();
    await second.initialize();

    expect(first.player.key).not.toBe(second.key);
  });
});

describe('AudioPlayer — what it says back: playing, ended, error, and nothing else', () => {
  it('says "playing" when the view reports sound — once for each play, and not from play() itself', async () => {
    const { player, said } = await ready();
    player.src = ADDRESS;

    await player.play();
    expect(said).toEqual([]);

    player.reportPlaying();
    player.reportPlaying();
    player.reportPlaying();
    expect(said).toEqual(['playing']);
  });

  it('does not say "playing" for a report that comes while it is paused or has no address', async () => {
    const { player, said } = await ready();
    player.reportPlaying();
    player.src = ADDRESS;
    player.reportPlaying();
    await player.play();
    player.pause();
    player.reportPlaying();

    expect(said).toEqual([]);
  });

  it('says "ended" when the reading is over, and is paused then', async () => {
    const { player, said } = await ready();
    player.src = ADDRESS;
    await player.play();
    player.reportPlaying();

    player.reportEnded();

    expect(said).toEqual(['playing', 'ended']);
    expect(player.paused).toBe(true);
  });

  it('says "error" when the view cannot play the address', async () => {
    const { player, said } = await ready();
    player.src = ADDRESS;
    await player.play();

    player.reportError();

    expect(said).toEqual(['error']);
  });

  it('says nothing more once it has been let go', async () => {
    const { player, said } = await ready();
    player.src = ADDRESS;
    await player.play();
    await player.deinitialize();

    player.reportPlaying();
    player.reportEnded();
    player.reportError();

    expect(said).toEqual([]);
    expect(player.src).toBe('');
    expect(player.paused).toBe(true);
  });

  it('stops telling a listener that was taken away', async () => {
    const { player } = await ready();
    const heard: string[] = [];
    const listener = (): void => void heard.push('ended');
    player.addEventListener('ended', listener);
    player.removeEventListener('ended', listener);

    player.reportEnded();

    expect(heard).toEqual([]);
  });
});

describe('the shared reader, reading through this player (apps/tv-vega/src/read/reading.ts)', () => {
  /** What apps/tv-vega/src/read/speechPlayer.ts makes of the platform's player. */
  const speechPlayer = (): SpeechPlayer => {
    const player = new AudioPlayer(AudioContentType.CONTENT_TYPE_SPEECH, AudioUsageType.USAGE_MEDIA);
    return {
      initialize: () => player.initialize(),
      deinitialize: () => player.deinitialize(),
      on: (type, listener) => player.addEventListener(type, listener),
      load: (url) => {
        player.src = url;
      },
      play: () => player.play(),
      pause: () => player.pause(),
    };
  };

  it('reads a card: the view is given the address, the voice is heard, and when it ends the view is taken away', async () => {
    hosted();
    const states: string[] = [];
    const reader = new Reader({ createPlayer: speechPlayer, ask: () => undefined, onChange: (state) => states.push(state) });
    reader.showing('note-1');
    reader.press('toggle');
    reader.speech('note-1', ADDRESS);
    await settle();

    const [onStage] = audioStage.players();
    expect(onStage!.src).toBe(ADDRESS);
    expect(onStage!.paused).toBe(false);

    onStage!.reportPlaying();
    onStage!.reportEnded();
    await settle();

    expect(states).toEqual(['asking', 'starting', 'speaking', 'idle']);
    expect(audioStage.players()).toEqual([]);
  });

  it('is silenced at once when Play is pressed again, and the view taken away', async () => {
    hosted();
    const reader = new Reader({ createPlayer: speechPlayer, ask: () => undefined });
    reader.showing('note-1');
    reader.press('toggle');
    reader.speech('note-1', ADDRESS);
    await settle();
    const [onStage] = audioStage.players();
    onStage!.reportPlaying();

    reader.press('toggle');
    expect(onStage!.paused).toBe(true);
    await settle();

    expect(audioStage.players()).toEqual([]);
  });

  it('fails quietly where there is no view to play through', async () => {
    const reader = new Reader({ createPlayer: speechPlayer, ask: () => undefined });
    reader.showing('note-1');
    reader.press('toggle');
    reader.speech('note-1', ADDRESS);
    await settle();

    expect(reader.state).toBe('idle');
    expect(audioStage.players()).toEqual([]);
  });
});

describe('AudioHost.tsx — the unseen view', () => {
  const host = readFileSync(fileURLToPath(new URL('../adapters/AudioHost.tsx', import.meta.url)), 'utf8');

  it('does not ask Android for the sound: the film keeps it, and its sound goes on under the reading', () => {
    expect(host).toMatch(/\bdisableFocus\b/);
  });

  it('never takes the remote, and shows nothing', () => {
    expect(host).toMatch(/focusable=\{false\}/);
    expect(host).toMatch(/controls=\{false\}/);
    expect(host).not.toMatch(/hasTVPreferredFocus/);
  });

  it('says back only what the player understands', () => {
    expect(host).toMatch(/onEnd=\{\(\) => player\.reportEnded\(\)\}/);
    expect(host).toMatch(/onError=\{\(\) => player\.reportError\(\)\}/);
    expect(host).toMatch(/player\.reportPlaying\(\)/);
  });

  it('is put on the screen once, beside the app, by the app’s root', () => {
    const root = readFileSync(fileURLToPath(new URL('../Root.tsx', import.meta.url)), 'utf8');
    const index = readFileSync(fileURLToPath(new URL('../../index.js', import.meta.url)), 'utf8');

    expect(root.match(/<AudioHost \/>/g)).toHaveLength(1);
    expect(root).toMatch(/<App \/>/);
    expect(index).toMatch(/registerComponent\('Wick', \(\) => Root\)/);
  });
});
