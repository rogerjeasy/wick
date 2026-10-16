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
import { DOOR_ACTIONS, type DeviceEvent, type DeviceToken, type QueuedCard } from '@wick/contracts';
import { act } from 'react-test-renderer';
import { ResidentApp } from '../ResidentApp.js';
import type { QueueStore } from '../headless/QueueStore.js';
import type { PlayerSnapshot } from '../player/PlayerService.js';
import { CARD_SERVICE_URI } from '../headless/launchCardService.js';
import { CATALOG } from '../catalog/catalog.js';
import { SETTLED_AFTER_MS } from '../break/types.js';
import { opened, resetPlatform } from './render/platform.js';
import { resetFiles } from './render/files.js';
import { resetMedia } from './render/media.js';
import { button, buttons, headers, pressOk, render, shows, textOf, type Drawn } from './render/render.js';

vi.mock('@amazon-devices/react-native-kepler', () => import('./render/platform.js'));
vi.mock('react-native', () => import('./render/platform.js'));
vi.mock('@amazon-devices/kepler-file-system', () => import('./render/files.js'));
vi.mock('@amazon-devices/react-native-w3cmedia', () => import('./render/media.js'));
vi.mock('../home/posters.js', () => ({ POSTERS: {} }));

/** The card channel, as far as the app can tell: it is handed the queue, and puts cards in it. */
const channel = vi.hoisted(() => ({ store: undefined as QueueStore | undefined, token: undefined as string | undefined, stopped: 0 }));
vi.mock('../transport/startCardChannel.js', () => ({
  holdCardChannel: (store: QueueStore, token: { jwt: string }) => {
    channel.store = store;
    channel.token = token.jwt;
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
    await wait(1_000);
    await pressOk(button(root, 'Not now'));
    await filmAt(40_000);
    await wait(1_000);
    expect(shows(root, 'A message from Sarah.')).toBe(false);

    // The credits: a natural break, and the note.
    await filmAt(BUNNY!.creditsPositionMs + 1_000);
    await wait(1_000);
    expect(headers(root).map(textOf)).toEqual(['A message from Sarah.']);
    expect(shows(root, 'I will pop round on Saturday.')).toBe(true);
  });
});
