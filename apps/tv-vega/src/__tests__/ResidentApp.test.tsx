/**
 * The resident's television, drawn whole (ResidentApp.tsx): the app as
 * App.tsx mounts it, with its real queue, its real Natural-Break Engine,
 * its real one-second look and every screen it draws.
 *
 * What stands in, and why:
 *   - the platform, the disk and the media player (src/__tests__/render);
 *   - the card channel (transport/startCardChannel.ts `holdCardChannel`):
 *     here it is the test that delivers a card, into the very queue the app
 *     handed the channel — which is what the channel does;
 *   - the film's screen (watch/WatchScreen.tsx), which needs a video
 *     player: here it says where the film is, as the real one does on
 *     every tick of its player, so the break engine is fed what it is fed
 *     on the television.
 *
 * It is a smoke test of the whole: a door card arrives and is on screen at
 * the next look, over the home or over a film; a note sent during a film
 * waits for the credits.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOOR_ACTIONS, NOTE_ACTIONS, type DeviceEvent, type DeviceToken, type QueuedCard } from '@wick/contracts';
import { act } from 'react-test-renderer';
import { ResidentApp } from '../ResidentApp.js';
import type { QueueStore } from '../headless/QueueStore.js';
import type { PlayerSnapshot } from '../player/PlayerService.js';
import { CARD_SERVICE_URI } from '../headless/launchCardService.js';
import { CATALOG } from '../catalog/catalog.js';
import { SETTLED_AFTER_MS } from '../break/types.js';
import { moveApp, opened, pressBack, resetPlatform } from './render/platform.js';
import { resetFiles } from './render/files.js';
import { resetMedia } from './render/media.js';
import { button, buttons, headers, pressOk, render, shows, textOf, type Drawn } from './render/render.js';

vi.mock('@amazon-devices/react-native-kepler', () => import('./render/platform.js'));
vi.mock('react-native', () => import('./render/platform.js'));
vi.mock('@amazon-devices/kepler-file-system', () => import('./render/files.js'));
vi.mock('@amazon-devices/react-native-w3cmedia', () => import('./render/media.js'));
vi.mock('../home/posters.js', () => ({ POSTERS: {} }));

/** The card channel, as far as the app can tell: it is handed the queue, and puts cards in it. */
const channel = vi.hoisted(() => ({
  store: undefined as QueueStore | undefined,
  token: undefined as string | undefined,
  stopped: 0,
  /** What the channel tells the screen about being open (holdCardChannel's last argument). */
  link: undefined as ((open: boolean) => void) | undefined,
}));
vi.mock('../transport/startCardChannel.js', () => ({
  holdCardChannel: (store: QueueStore, token: { jwt: string }, _create: unknown, _config: unknown, _announce: unknown, _sent: unknown, _trouble: unknown, link?: (open: boolean) => void) => {
    channel.store = store;
    channel.token = token.jwt;
    channel.link = link;
    return { stop: () => void (channel.stopped += 1), reconcile: () => undefined };
  },
}));

/** The film's screen: it says where the film is, as WatchScreen's player does. */
const film = vi.hoisted(() => ({ props: undefined as Record<string, unknown> | undefined }));
vi.mock('../watch/WatchScreen.js', async () => {
  const React = await import('react');
  return {
    WatchScreen: (props: Record<string, unknown>) => {
      film.props = props;
      return React.createElement('View', { testID: 'film' });
    },
  };
});

const T = 1_800_000_000_000;
const TOKEN: DeviceToken = { jwt: 'jwt-launch', deviceId: 'wick-tv', householdId: 'hh_test', expiresAt: T + 60 * 60 * 1000 };
const CONFIG = { pairingApiUrl: 'https://pair.example.com', websocketUrl: 'wss://ws.example.com', wickServerUrl: 'https://wick.example.com' } as const;
const [BUNNY] = CATALOG;

const door: QueuedCard = {
  id: 'door-evt-1',
  urgency: 'DOOR',
  queuedAt: T,
  expiresAt: T + 5 * 60 * 1000,
  shownCount: 0,
  card: {
    type: 'DOOR',
    id: 'door-evt-1',
    householdId: 'hh_test',
    correlationId: 'door-evt-1',
    createdAt: T,
    line: "Someone's at the front door.",
    actions: [
      { id: DOOR_ACTIONS.watchLive, label: 'Watch live', kind: 'primary' },
      { id: DOOR_ACTIONS.dismiss, label: 'Not now', kind: 'dismiss' },
    ],
  },
};

const note: QueuedCard = {
  id: 'note-1',
  urgency: 'DEFERRED',
  queuedAt: T,
  shownCount: 0,
  card: {
    type: 'MESSAGE',
    id: 'note-1',
    householdId: 'hh_test',
    correlationId: 'note-1',
    createdAt: T,
    fromName: 'Sarah',
    transcript: 'I will pop round on Saturday.',
    suggestedReplies: ['Lovely!', 'Not this week.'],
    actions: [],
  },
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(T);
  channel.store = undefined;
  channel.token = undefined;
  channel.stopped = 0;
  channel.link = undefined;
  film.props = undefined;
});
afterEach(() => {
  vi.useRealTimers();
  resetPlatform();
  resetFiles();
  resetMedia();
});

/** Time passes on the television: its one-second look runs, and whatever it awaited. */
async function wait(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** What the channel brings: a card, into the app's own queue. */
async function deliver(card: QueuedCard): Promise<void> {
  await act(async () => {
    await channel.store!.upsert(card);
  });
}

/** Where the film has got to, said by its player. */
async function filmAt(positionMs: number): Promise<void> {
  const snapshot: PlayerSnapshot = { state: 'PLAYING', positionMs, durationMs: BUNNY!.durationMs, creditsPositionMs: BUNNY!.creditsPositionMs, contentId: BUNNY!.id };
  await act(async () => {
    (film.props!.onSnapshot as (s: PlayerSnapshot) => void)(snapshot);
  });
}

async function sent(): Promise<DeviceEvent['t'][]> {
  return (await channel.store!.drainOutbound()).map((event) => event.t);
}

async function launch(): Promise<Drawn> {
  const app = await render(<ResidentApp token={TOKEN} config={CONFIG} />);
  await wait(0);
  return app;
}

describe('ResidentApp, drawn whole', () => {
  it('comes up on the home screen, holds the card channel with its token, and starts the card service', async () => {
    const { root } = await launch();

    expect(headers(root).map(textOf)).toEqual(['What would you like to watch?']);
    expect(channel.token).toBe('jwt-launch');
    expect(opened).toContain(CARD_SERVICE_URI);
  });

  it('puts a door card that arrives on screen at the next look, alone on the ground — and Not now puts it away', async () => {
    const { root } = await launch();
    await deliver(door);
    await wait(1_000);

    expect(headers(root).map(textOf)).toEqual(["Someone's at the front door."]);
    expect(shows(root, 'What would you like to watch?')).toBe(false);
    expect(buttons(root).map((b) => b.props.accessibilityLabel)).toEqual(['Watch live', 'Not now']);
    expect(await sent()).toContain('card_shown');

    // A second for her to read it, then her answer.
    await wait(1_000);
    await pressOk(button(root, 'Not now'));
    expect(shows(root, "Someone's at the front door.")).toBe(false);
    expect(headers(root).map(textOf)).toEqual(['What would you like to watch?']);
    const events = await channel.store!.drainOutbound();
    expect(events).toContainEqual(expect.objectContaining({ t: 'card_action', cardId: 'door-evt-1', action: DOOR_ACTIONS.dismiss }));
  });

  it('says a demo home’s stand-in doorbell in a quiet line of its own, never in the sentence she reads', async () => {
    const { root } = await launch();
    await deliver({ ...door, id: 'door-evt-2', card: { ...door.card, id: 'door-evt-2', correlationId: 'door-evt-2', standIn: true } } as QueuedCard);
    await wait(1_000);

    expect(headers(root).map(textOf)).toEqual(["Someone's at the front door."]);
    expect(shows(root, 'Stand-in doorbell, for the demo')).toBe(true);
  });

  it('draws nothing of the home behind the Easier to see card either: it is a card like any other', async () => {
    const { root } = await launch();
    await wait(1_000);
    await pressOk(button(root, 'Easier to see. Press OK for larger text or higher contrast.'));

    expect(headers(root).map(textOf)).toEqual(['Easier to see']);
    expect(shows(root, 'What would you like to watch?')).toBe(false);
    expect(buttons(root).map((b) => b.props.accessibilityLabel)).toEqual(['Larger text: off', 'Higher contrast: off', 'Back']);
  });

  it('shows a note at once on a home screen that has settled — the break the film below does not give', async () => {
    const { root } = await launch();
    await wait(SETTLED_AFTER_MS);
    await deliver(note);
    await wait(1_000);

    expect(headers(root).map(textOf)).toEqual(['A message from Sarah.']);
  });

  it('keeps a note sent during a film off the screen while the film plays, lets the door through, and shows the note at the credits', async () => {
    const { root } = await launch();
    // Settled: on the home screen a note would be shown now (above).
    await wait(SETTLED_AFTER_MS);
    await pressOk(button(root, 'Big Buck Bunny. 10 minutes'));
    expect(film.props?.programme).toBe(BUNNY);

    await filmAt(30_000);
    await deliver(note);
    for (const at of [31_000, 32_000, 33_000, 34_000, 35_000]) {
      await filmAt(at);
      await wait(1_000);
      expect(shows(root, 'A message from Sarah.'), String(at)).toBe(false);
    }
    expect(film.props?.cardVisible).toBe(false);

    // The door comes straight through, over the film.
    await deliver(door);
    await wait(1_000);
    expect(headers(root).map(textOf)).toEqual(["Someone's at the front door."]);
    // The film stays in view under it: only the home screen is left out behind a card.
    expect(root.findAll((n) => n.props.testID === 'film').length).toBe(1);
    expect(film.props?.cardVisible).toBe(true);
    // And it waits for her: she may get up to answer the door. Nothing of hers has put the card away yet.
    expect(film.props?.held).toBe(true);
    expect((film.props?.putAwayByHer as () => boolean)()).toBe(false);
    await wait(1_000);
    await pressOk(button(root, 'Not now'));
    // She put it away herself: the film goes on.
    expect(film.props?.held).toBe(false);
    expect((film.props?.putAwayByHer as () => boolean)()).toBe(true);
    await filmAt(40_000);
    await wait(1_000);
    expect(shows(root, 'A message from Sarah.')).toBe(false);

    // The credits: a natural break, and the note.
    await filmAt(BUNNY!.creditsPositionMs + 1_000);
    await wait(1_000);
    expect(headers(root).map(textOf)).toEqual(['A message from Sarah.']);
    expect(shows(root, 'I will pop round on Saturday.')).toBe(true);
  });

  it('behind another app shows no note and tells the edge so; back in front, the note waits the settled twenty seconds again', async () => {
    const { root } = await launch();
    await wait(SETTLED_AFTER_MS);
    await channel.store!.drainOutbound();

    // Another app comes in front. Vega lets the app's JavaScript run on for some seconds; Fire OS may keep it running.
    await act(async () => moveApp('background'));
    await deliver(note);
    await wait(5_000);
    expect(shows(root, 'A message from Sarah.')).toBe(false);
    expect(await channel.store!.drainOutbound()).toContainEqual(expect.objectContaining({ t: 'app_lifecycle', state: 'bg' }));

    await act(async () => moveApp('active'));
    await wait(SETTLED_AFTER_MS - 1_000);
    expect(shows(root, 'A message from Sarah.')).toBe(false);
    expect(await channel.store!.drainOutbound()).toContainEqual(expect.objectContaining({ t: 'app_lifecycle', state: 'fg' }));
    await wait(1_000);
    expect(headers(root).map(textOf)).toEqual(['A message from Sarah.']);
  });

  it('Back on a note at her home screen puts it away: she reaches her films, it waits on the home screen, and no reply is sent', async () => {
    const { root } = await launch();
    await deliver(note);
    await wait(SETTLED_AFTER_MS + 1_000);
    expect(headers(root).map(textOf)).toEqual(['A message from Sarah.']);
    await channel.store!.drainOutbound();

    // A second for her to read it, then Back.
    await wait(1_000);
    await act(async () => void pressBack());
    await wait(1_000);

    expect(headers(root).map(textOf)).toEqual(['What would you like to watch?']);
    expect(shows(root, 'A note from Sarah is waiting.')).toBe(true);
    const out = await channel.store!.drainOutbound();
    expect(out).toContainEqual(expect.objectContaining({ t: 'card_action', cardId: 'note-1', action: NOTE_ACTIONS.later }));
    expect(out.filter((event) => event.t === 'card_action' && event.action.startsWith('reply_'))).toEqual([]);

    // Still settled on her home screen, and it does not come back by itself.
    await wait(SETTLED_AFTER_MS);
    expect(shows(root, 'I will pop round on Saturday.')).toBe(false);
  });

  describe('when the connection to home goes', () => {
    const NOT_REACHED = "Wick can't reach home just now.";
    /** The channel reports whether it is open, once a second, as holdCardChannel does. */
    async function connection(open: boolean, forMs: number): Promise<void> {
      for (let at = 0; at < forMs; at += 1_000) {
        await act(async () => channel.link!(open));
        await wait(1_000);
      }
    }

    it('says nothing while it is connected, or for a drop of a few seconds', async () => {
      const { root } = await launch();
      await connection(true, 3_000);
      await connection(false, 5_000);
      await connection(true, 2_000);
      expect(shows(root, NOT_REACHED)).toBe(false);
    });

    it('says plainly that Wick cannot reach home once it has been down for a while, and stops when it is back', async () => {
      const { root } = await launch();
      await wait(1_000);
      await connection(false, 25_000);
      expect(shows(root, NOT_REACHED)).toBe(true);
      expect(headers(root).map(textOf)).toEqual(['What would you like to watch?']);

      await connection(true, 2_000);
      expect(shows(root, NOT_REACHED)).toBe(false);
    });

    it('says it in her language', async () => {
      const { root } = await launch();
      await act(async () => {
        channel.store!.setHome({ language: 'es' }, { whole: true });
      });
      await wait(1_000);
      await connection(false, 25_000);
      expect(shows(root, 'Wick no puede conectarse ahora.')).toBe(true);
    });

    it('puts it in place of a waiting note’s line, and gives the note’s line back with the connection', async () => {
      const { root } = await launch();
      await deliver(note);
      await wait(SETTLED_AFTER_MS + 1_000);
      await wait(1_000);
      await act(async () => void pressBack()); // the note goes to the home screen's quiet line
      await wait(1_000);
      expect(shows(root, 'A note from Sarah is waiting.')).toBe(true);

      await connection(false, 25_000);
      expect(shows(root, NOT_REACHED)).toBe(true);
      expect(shows(root, 'A note from Sarah is waiting.')).toBe(false);

      await connection(true, 2_000);
      expect(shows(root, 'A note from Sarah is waiting.')).toBe(true);
      expect(shows(root, NOT_REACHED)).toBe(false);
    });

    it('does not carry the trouble of one connection over to the next: behind another app, then back', async () => {
      const { root } = await launch();
      await connection(false, 15_000);
      await act(async () => moveApp('background'));
      await wait(1_000);
      await act(async () => moveApp('active'));
      await wait(1_000);
      // A new channel was made; it has been down for 5 seconds, not 20.
      await connection(false, 5_000);
      expect(shows(root, NOT_REACHED)).toBe(false);
    });
  });
});
