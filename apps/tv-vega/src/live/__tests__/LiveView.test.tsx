/**
 * Watch live, drawn (live/LiveView.tsx): the front door camera, full screen,
 * because she asked for it — and every way it can go: still opening, the
 * picture with Ring's countdown under it, and one plain sentence with Back
 * when there is no picture, or no more. Back, the button or the remote's
 * key, always closes it.
 *
 * The network is a stand-in `fetch` that answers as the edge does
 * (services/edge-device live.mjs); the player is media.ts's, which plays
 * nothing and is told what the platform would say.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CalmPreferencesProvider } from '@wick/vega-calm-ui';
import type { HouseholdLanguage } from '@wick/contracts';
import { LiveView } from '../LiveView.js';
import { pressBack, resetPlatform } from '../../__tests__/render/platform.js';
import { players, resetMedia } from '../../__tests__/render/media.js';
import { EASIER_TO_SEE, all, buttons, headers, illegible, preferred, press, render, settle, textOf, texts } from '../../__tests__/render/render.js';

vi.mock('@amazon-devices/react-native-kepler', () => import('../../__tests__/render/platform.js'));
vi.mock('@amazon-devices/react-native-w3cmedia', () => import('../../__tests__/render/media.js'));

const API = 'https://pair.example.com';
const T = 1_800_000_000_000;
const PLAYLIST = 'https://live.example.com/s_1/index.m3u8';

interface Asked {
  readonly method: string;
  readonly url: string;
  readonly token: string | undefined;
}
let asked: Asked[] = [];

/** The edge, as far as live view meets it: what it answers to starting a session, to the playlist, and to stopping. */
function edge(start: () => Promise<Response>): void {
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const token = (init?.headers as Record<string, string> | undefined)?.Authorization?.replace('Bearer ', '');
    asked.push({ method, url, token });
    if (method === 'POST') return start();
    if (method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.resolve(new Response('#EXTM3U\n#EXTINF:2.0,\nseg0.ts\n', { status: 200 }));
  });
}

const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
const opens = () => json(201, { sessionId: 's_1', playlistUrl: PLAYLIST, endsAt: T + 42_000 });

beforeEach(() => {
  asked = [];
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(T);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetPlatform();
  resetMedia();
});

function live(props: { jwt?: string; language?: HouseholdLanguage; onClose?: () => void } = {}, preferences = EASIER_TO_SEE[0]![1]) {
  return (
    <CalmPreferencesProvider preferences={preferences}>
      <LiveView pairingApiUrl={API} jwt={props.jwt ?? 'token-1'} cardId="door-evt-1" language={props.language ?? 'en'} onClose={props.onClose ?? (() => undefined)} />
    </CalmPreferencesProvider>
  );
}

describe('opening', () => {
  it('says what it is doing, in words, with Back to leave — never a spinner alone', async () => {
    edge(() => new Promise(() => undefined));
    const { root } = await render(live());

    expect(headers(root).map(textOf)).toEqual(['Opening the front door camera…']);
    expect(buttons(root).map((b) => b.props.accessibilityLabel)).toEqual(['Back']);
    expect(preferred(root)).toEqual(['Back']);
    expect(asked).toEqual([{ method: 'POST', url: `${API}/live/sessions`, token: 'token-1' }]);
  });

  it('closes on its Back button, and on the remote’s Back key', async () => {
    edge(() => new Promise(() => undefined));
    const onClose = vi.fn();
    const { root } = await render(live({ onClose }));

    await press(buttons(root)[0]!);
    await settle(() => {
      expect(pressBack()).toBe(true);
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('when there is no picture', () => {
  it.each([
    [410, 'card_too_old', 'en', "That visit was a while ago, so there's nothing live to show."],
    [404, 'no_such_card', 'en', "There's no live picture for that visit."],
    [503, 'camera_unavailable', 'es', 'La cámara del timbre no responde ahora.'],
    [401, undefined, 'en', 'The television needs to be paired again before it can show the camera.'],
  ] as const)('answered %i (%s): says so in one plain sentence, in her language, and waits with Back', async (status, error, language, sentence) => {
    edge(() => json(status, error ? { error } : {}));
    const { root } = await render(live({ language }));

    expect(headers(root).map(textOf)).toEqual([sentence]);
    expect(buttons(root).length).toBe(1);
    expect(players.length).toBe(0);
  });

  it.each(EASIER_TO_SEE)('is legible with %s', async (_name, preferences) => {
    edge(() => json(410, { error: 'card_too_old' }));
    const { root } = await render(live({}, preferences));
    expect(illegible(root, preferences)).toEqual([]);
  });
});

describe('the picture', () => {
  async function playing(props: { jwt?: string; onClose?: () => void; language?: HouseholdLanguage } = {}) {
    edge(opens);
    const drawn = await render(live(props));
    return drawn;
  }

  it('plays the door’s stream full screen once its first playlist names a segment, with Ring’s countdown and Back under it', async () => {
    const { root } = await playing();

    const [player] = players;
    expect(player!.src).toBe(PLAYLIST);
    expect(player!.playing).toBe(true);
    const [view] = all(root, 'KeplerVideoView');
    expect(view!.props.videoPlayer).toBe(player);
    expect(texts(root)).toEqual(['Live from the front door · 42 seconds left', 'Back']);
    expect(preferred(root)).toEqual(['Back']);
  });

  it('counts down once a second, and at zero lets the player go and says it has ended — it waits for her, it does not close', async () => {
    const onClose = vi.fn();
    const { root } = await playing({ onClose });

    await settle(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(texts(root)[0]).toBe('Live from the front door · 32 seconds left');

    await settle(() => {
      vi.advanceTimersByTime(32_000);
    });
    expect(headers(root).map(textOf)).toEqual(['Live view has ended.']);
    expect(players[0]!.released).toBe(true);
    expect(asked.filter((a) => a.method === 'DELETE').map((a) => a.url)).toEqual([`${API}/live/sessions/s_1`]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('says the camera is not answering when the player stops before a picture, and that it ended after one', async () => {
    const before = await playing();
    await settle(() => players[0]!.emit('error'));
    expect(headers(before.root).map(textOf)).toEqual(["The doorbell camera isn't answering right now."]);
    await before.unmount();
    resetMedia();

    const after = await playing();
    await settle(() => {
      players[0]!.emit('playing');
      players[0]!.emit('ended');
    });
    expect(headers(after.root).map(textOf)).toEqual(['Live view has ended.']);
  });

  it('keeps the token it was opened with: a fresh one taken meanwhile does not start the picture again', async () => {
    const onClose = vi.fn();
    const drawn = await playing({ jwt: 'token-1', onClose });
    await drawn.update(live({ jwt: 'token-2', onClose }));

    expect(asked.filter((a) => a.method === 'POST').length).toBe(1);
    expect(players.length).toBe(1);

    await press(buttons(drawn.root)[0]!);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(players[0]!.released).toBe(true);
    expect(asked.filter((a) => a.method === 'DELETE').map((a) => a.token)).toEqual(['token-1']);
  });

  it('lets the player and the session go when it is closed by the remote’s Back', async () => {
    const onClose = vi.fn();
    await playing({ onClose });
    await settle(() => {
      pressBack();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(players[0]!.released).toBe(true);
    expect(asked.filter((a) => a.method === 'DELETE').length).toBe(1);
  });

  it('says its countdown in Spanish when that is her language', async () => {
    const { root } = await playing({ language: 'es' });
    expect(texts(root)).toEqual(['La puerta en vivo · segundos restantes: 42', 'Atrás']);
  });
});
