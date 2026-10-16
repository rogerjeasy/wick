/**
 * An hour on screen, on the Vega simulator's terms: the disk keeps nothing,
 * so the token was minted at launch and lasts an hour.
 *
 * What used to happen: the MQTT session ended when the token did, the
 * channel reconnected with the same token and was refused, and until Wick
 * was launched again her television received no cards — with nothing on
 * the screen to say so.
 *
 * The real pieces — PairingFlow, the standing watch, the card channel's
 * holder — against an edge that behaves as the deployed one does where it
 * matters here: `/pair/refresh` with its cooldown (pairing-code.mjs), a
 * connection refused for a token that has run out or a television that is
 * not connected, and a session cut when its token ends (iot-policy.mjs).
 * ResidentApp.tsx puts the pieces together in React effects; `television`
 * below puts them together the same way, and the last tests hold the
 * component to it.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelState, DeviceToken } from '@wick/contracts';
import { PairingFlow } from '../PairingFlow.js';
import { STANDING_EVERY_MS, STANDING_MIN_GAP_MS, standingWatch } from '../standing.js';
import { TOKEN_MARGIN_MS } from '../held.js';
import { holdCardChannel, type ChannelFactory, type RunningCardChannel } from '../../transport/startCardChannel.js';
import { QueueStore, type FileSystemLike } from '../../headless/QueueStore.js';

const T0 = 1_800_000_000_000;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

// The edge's own numbers (services/edge-device/lambda/pairing-code.mjs). The last test holds them to the file.
const REFRESH_TOKEN_TTL_MS = HOUR;
const REFRESH_WINDOW_MS = 30 * SECOND;
const REFRESH_MAX_PER_WINDOW = 4;

/** These tests run hours of the channel's once-a-second timers; on a busy machine that is more than the usual five seconds. */
const SIMULATED_HOURS_TIMEOUT_MS = 60_000;

const CONFIG = { websocketUrl: 'wss://ws.example', mqttWssUrl: 'wss://mqtt.example' };
const DEVICE_ID = 'wick-tv';

/** The Vega simulator's disk (FL-013): every call fails, and nothing is kept. */
function diskThatKeepsNothing(): FileSystemLike {
  const fail = () => Promise.reject(new Error('com.amazon.kepler.io.IoError'));
  return { exists: fail, readFileAsString: fail, writeStringToFile: fail };
}

const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const nameOf = (token: DeviceToken): string => token.jwt.split('.')[2] ?? '?';

/** The edge, as far as a television's token goes. Its clock is the test's. */
function edge() {
  /** Everything the edge saw, in order. */
  const saw: string[] = [];
  let pairingService = true;
  let network = true;
  let connected = true;
  let minted = 0;
  let windowAt = 0;
  let count = 0;
  const live = new Set<{ token: DeviceToken; state: ChannelState }>();

  const mint = (): DeviceToken => {
    const now = Date.now();
    const iat = Math.floor(now / 1000);
    const jwt = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ deviceId: DEVICE_ID, householdId: 'h1', iat, exp: iat + REFRESH_TOKEN_TTL_MS / 1000 })}.t${(minted += 1)}`;
    return { jwt, deviceId: DEVICE_ID, householdId: 'h1', expiresAt: now + REFRESH_TOKEN_TTL_MS };
  };

  /** `POST /pair/refresh` (pair-refresh.mjs), for the resident's television: by its id, counted, an hour's token. */
  const fetchImpl = (async (url: string) => {
    if (!network || !pairingService) throw new TypeError('Network request failed');
    if (!String(url).endsWith('/pair/refresh')) return new Response('not_here', { status: 500 });
    if (!connected) {
      saw.push('refresh: 404');
      return new Response('device_not_paired', { status: 404 });
    }
    // pairing-code.mjs nextRefreshWindow: the window runs from its first refresh.
    const now = Date.now();
    if (!windowAt || now - windowAt >= REFRESH_WINDOW_MS) {
      windowAt = now;
      count = 1;
    } else if (count >= REFRESH_MAX_PER_WINDOW) {
      saw.push('refresh: 429');
      return new Response('refresh_rate_limited', { status: 429 });
    } else {
      count += 1;
    }
    const token = mint();
    saw.push(`refresh: ${nameOf(token)}`);
    return new Response(JSON.stringify({ token }), { status: 200 });
  }) as unknown as typeof fetch;

  /** Whether the edge lets this token on: connect.mjs and iot-authorize.mjs both check the same two things. */
  const refusal = (token: DeviceToken): string | undefined => {
    if (!connected) return 'not connected';
    return token.expiresAt <= Date.now() ? 'token run out' : undefined;
  };

  const createChannel: ChannelFactory = async (_config, token) => {
    if (!network) throw new Error('Network request failed');
    const why = refusal(token);
    if (why) {
      saw.push(`connect ${nameOf(token)}: refused, ${why}`);
      throw new Error(why);
    }
    saw.push(`connect ${nameOf(token)}`);
    const session = { token, state: 'open' as ChannelState };
    live.add(session);
    // The session ends when the token does (iot-policy.mjs `sessionSeconds`).
    // The channel then reconnects by itself, with the token it was given —
    // and is refused, every time.
    const end = setTimeout(() => {
      if (session.state !== 'open') return;
      session.state = 'backoff';
      saw.push(`cut ${nameOf(token)}: token run out`);
    }, token.expiresAt - Date.now());
    return {
      get state() {
        return session.state;
      },
      connect: async () => undefined,
      onCard: () => () => undefined,
      onControl: () => () => undefined,
      send: async (event) => {
        saw.push(`event ${event.t}${'state' in event ? ` ${String(event.state)}` : ''}`);
      },
      close: () => {
        clearTimeout(end);
        if (session.state === 'closed') return;
        session.state = 'closed';
        live.delete(session);
        saw.push(`close ${nameOf(token)}`);
      },
    };
  };

  return {
    saw,
    fetchImpl,
    createChannel,
    /** The channels open now, by the token each was opened with. */
    open: (): string[] => [...live].filter((session) => session.state === 'open').map((session) => nameOf(session.token)),
    /** The pairing service alone cannot be reached; the channel is untouched. */
    pairingService(up: boolean): void {
      pairingService = up;
    },
    /** The television's network, all of it. Back, a channel reconnects by itself with the token it was given. */
    network(up: boolean): void {
      network = up;
      for (const session of live) {
        if (!up) session.state = 'backoff';
        else if (refusal(session.token)) saw.push(`connect ${nameOf(session.token)}: refused, ${refusal(session.token)}`);
        else session.state = 'open';
      }
    },
    /** The organiser presses "Disconnect": the edge cuts the television off and refuses it from then on. */
    disconnect(): void {
      connected = false;
      for (const session of live) session.state = 'backoff';
    },
  };
}

/**
 * Her television, launched and on screen: what App.tsx and ResidentApp.tsx
 * do with the token, without React.
 */
async function television(the: ReturnType<typeof edge>) {
  const pairing = new PairingFlow({ pairingApiUrl: 'https://pair.example' }, diskThatKeepsNothing(), the.fetchImpl);
  const store = new QueueStore(diskThatKeepsNothing());
  const gone = vi.fn();
  const taken: string[] = [];

  // App.tsx: nothing on disk, so the launch asks the pairing service for a token.
  const token = await pairing.loadToken(DEVICE_ID);
  if (!token) throw new Error('not connected at launch');

  let held: RunningCardChannel | undefined;
  let inUse = token;
  const watch = standingWatch({
    held: { token, since: Date.now() },
    ask: (inUse) => pairing.renew(inUse.deviceId, inUse.jwt, { remember: false }),
    onGone: () => {
      held?.stop();
      gone();
    },
    // ResidentApp.tsx: the token in use changes, and the effect that holds the channel runs again.
    onFresh: (fresh) => {
      void pairing.keepIfLonger(fresh);
      taken.push(nameOf(fresh));
      inUse = fresh;
      if (!held) return;
      held.stop();
      held = hold();
    },
  });
  const hold = (): RunningCardChannel => holdCardChannel(store, inUse, the.createChannel, CONFIG, undefined, undefined, watch.trouble);
  // ResidentApp.tsx: the watch is told first, then the channel is held — and neither while Wick is off the screen.
  const onScreen = (now: boolean): void => {
    watch.onScreen(now);
    held?.stop();
    held = now ? hold() : undefined;
  };
  onScreen(true);

  return {
    gone,
    /** The fresh tokens taken, in order. */
    taken,
    /** Another app comes in front of Wick, or Wick comes back. */
    onScreen,
    stop(): void {
      watch.stop();
      held?.stop();
    },
  };
}

const refusedOrCut = (saw: string[]): string[] => saw.filter((line) => /refused|^cut|429/.test(line));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('an hour on screen, on a television whose token was minted at launch and lasts an hour', { timeout: SIMULATED_HOURS_TIMEOUT_MS }, () => {
  it('at fifty-five minutes the routine ask brings a fresh token and the channel carries on with it: never cut, never refused', async () => {
    const the = edge();
    const tv = await television(the);
    await vi.advanceTimersByTimeAsync(0);
    expect(the.open()).toEqual(['t1']);

    await vi.advanceTimersByTimeAsync(HOUR - TOKEN_MARGIN_MS - SECOND);
    expect(tv.taken).toEqual([]);
    expect(the.open()).toEqual(['t1']);

    // The fifty-fifth routine ask: its answer is the fifty-sixth token minted, the launch's being the first.
    await vi.advanceTimersByTimeAsync(2 * SECOND);
    expect(tv.taken).toEqual(['t56']);
    expect(the.open()).toEqual(['t56']);

    // Past the hour the old token would have ended at, and on.
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(the.open()).toHaveLength(1);
    expect(refusedOrCut(the.saw)).toEqual([]);
    expect(tv.gone).not.toHaveBeenCalled();
    tv.stop();
  });

  it('what the edge sees at the change: the question it is asked every minute, the old connection closed, the new one opened — once', async () => {
    const the = edge();
    const tv = await television(the);
    await vi.advanceTimersByTimeAsync(HOUR - TOKEN_MARGIN_MS - SECOND);
    const before = the.saw.length;

    await vi.advanceTimersByTimeAsync(STANDING_EVERY_MS);

    expect(the.saw.slice(before)).toEqual(['refresh: t56', 'close t1', 'connect t56']);
    tv.stop();
  });

  it('three hours on screen: three changes, each to a token with most of its hour left', async () => {
    const the = edge();
    const tv = await television(the);

    await vi.advanceTimersByTimeAsync(3 * HOUR);

    expect(tv.taken).toHaveLength(3);
    expect(the.saw.filter((line) => line.startsWith('connect'))).toHaveLength(4);
    expect(refusedOrCut(the.saw)).toEqual([]);
    tv.stop();
  });

  it('the pairing service out of reach at the margin: the channel is cut at the hour, its trouble prompts the ask, and it is back when the service is', async () => {
    const the = edge();
    const tv = await television(the);
    await vi.advanceTimersByTimeAsync(HOUR - TOKEN_MARGIN_MS - 30 * SECOND);

    the.pairingService(false);
    await vi.advanceTimersByTimeAsync(TOKEN_MARGIN_MS + 30 * SECOND + 2 * MINUTE);
    // Cut when its token ended, and nothing to be done about it yet. Not the pairing screen.
    expect(the.saw).toContain('cut t1: token run out');
    expect(the.open()).toEqual([]);
    expect(tv.taken).toEqual([]);
    expect(tv.gone).not.toHaveBeenCalled();

    the.pairingService(true);
    await vi.advanceTimersByTimeAsync(STANDING_MIN_GAP_MS + SECOND);

    expect(tv.taken).toHaveLength(1);
    expect(the.open()).toEqual(tv.taken);
    expect(tv.gone).not.toHaveBeenCalled();
    tv.stop();
  });

  it('no network at all from the margin until after the hour: when it returns the old token is refused, the ask is answered, and the channel opens with the fresh one', async () => {
    const the = edge();
    const tv = await television(the);
    await vi.advanceTimersByTimeAsync(HOUR - TOKEN_MARGIN_MS - 30 * SECOND);

    the.network(false);
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(the.open()).toEqual([]);
    expect(tv.gone).not.toHaveBeenCalled();

    the.network(true);
    await vi.advanceTimersByTimeAsync(STANDING_MIN_GAP_MS + SECOND);

    expect(the.saw).toContain('connect t1: refused, token run out');
    expect(tv.taken).toHaveLength(1);
    expect(the.open()).toEqual(tv.taken);
    expect(tv.gone).not.toHaveBeenCalled();
    tv.stop();
  });

  it('back on screen after two hours behind another app: one refusal for the token that ran out meanwhile, and the channel opens with a fresh one', async () => {
    const the = edge();
    const tv = await television(the);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);

    tv.onScreen(false);
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    // Nothing is asked, and nothing held, while it is off the screen.
    expect(the.saw.filter((line) => line.startsWith('refresh'))).toHaveLength(1 + 10);
    expect(the.open()).toEqual([]);

    tv.onScreen(true);
    await vi.advanceTimersByTimeAsync(SECOND);

    expect(tv.taken).toHaveLength(1);
    expect(the.open()).toEqual(tv.taken);
    expect(refusedOrCut(the.saw)).toEqual(['connect t1: refused, token run out']);
    tv.stop();
  });

  it('a network that drops and returns mid-hour changes nothing: the channel reconnects by itself, with the token it has', async () => {
    const the = edge();
    const tv = await television(the);
    await vi.advanceTimersByTimeAsync(20 * MINUTE);

    the.network(false);
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    the.network(true);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);

    expect(tv.taken).toEqual([]);
    expect(the.open()).toEqual(['t1']);
    tv.stop();
  });
});

describe('a television the family disconnects still goes to the pairing screen, and takes nothing', { timeout: SIMULATED_HOURS_TIMEOUT_MS }, () => {
  it('mid-hour: told within the minute', async () => {
    const the = edge();
    const tv = await television(the);
    await vi.advanceTimersByTimeAsync(20 * MINUTE);

    the.disconnect();
    await vi.advanceTimersByTimeAsync(STANDING_EVERY_MS);

    expect(tv.gone).toHaveBeenCalledTimes(1);
    expect(tv.taken).toEqual([]);
    expect(the.open()).toEqual([]);
  });

  it('at the margin, and after its token has run out: the answer is 404, and no token comes with it', async () => {
    for (const after of [HOUR - TOKEN_MARGIN_MS - 30 * SECOND, HOUR + 10 * MINUTE]) {
      vi.setSystemTime(T0);
      const the = edge();
      const tv = await television(the);
      // Until then the pairing service cannot be reached, so nothing fresh has been taken.
      the.pairingService(false);
      await vi.advanceTimersByTimeAsync(after);

      the.disconnect();
      the.pairingService(true);
      await vi.advanceTimersByTimeAsync(STANDING_EVERY_MS);

      expect(tv.gone).toHaveBeenCalledTimes(1);
      expect(tv.taken).toEqual([]);
      expect(the.saw.filter((line) => line.startsWith('connect') && !line.includes('refused'))).toEqual(['connect t1']);
    }
  });
});

// INV-1: the resident's refresh needs no proof, and is bounded by a
// cooldown on the television's row and an hour's life. The television now
// relies on it for a working token once an hour.
describe('the cooldown on /pair/refresh leaves the television room', { timeout: SIMULATED_HOURS_TIMEOUT_MS }, () => {
  it('two hours on screen: never asked too soon, and never more than one question a minute', async () => {
    const the = edge();
    const tv = await television(the);

    await vi.advanceTimersByTimeAsync(2 * HOUR);

    const refreshes = the.saw.filter((line) => line.startsWith('refresh'));
    expect(refreshes.filter((line) => line.endsWith('429'))).toEqual([]);
    // The launch, and one a minute.
    expect(refreshes).toHaveLength(1 + (2 * HOUR) / STANDING_EVERY_MS);
    tv.stop();
  });

  it('the worst half minute still fits: the launch, the card service’s own launch, and one ask from each', () => {
    // App at launch + its card service a second later (both where the disk
    // keeps nothing), then at most one ask from each watch: they never ask
    // twice inside STANDING_MIN_GAP_MS, which is the edge's whole window.
    const inOneWindow = 2 + 2 * Math.ceil(REFRESH_WINDOW_MS / STANDING_MIN_GAP_MS);
    expect(inOneWindow).toBeLessThanOrEqual(REFRESH_MAX_PER_WINDOW);
    // And in the steady state there is room for a launch on top: two of the four.
    expect(REFRESH_MAX_PER_WINDOW - 2 * Math.ceil(REFRESH_WINDOW_MS / STANDING_MIN_GAP_MS)).toBeGreaterThanOrEqual(2);
  });

  it('a television cannot starve itself: asked too soon, it is answered again as soon as the window it was counted in has run', async () => {
    const the = edge();
    const pairing = new PairingFlow({ pairingApiUrl: 'https://pair.example' }, diskThatKeepsNothing(), the.fetchImpl);

    // Far more than it ever asks: every second for two minutes.
    const answers: string[] = [];
    for (let second = 0; second < 120; second += 1) {
      const answer = await pairing.renew(DEVICE_ID, undefined, { remember: false });
      answers.push(typeof answer === 'object' ? 'token' : answer);
      await vi.advanceTimersByTimeAsync(SECOND);
    }

    // Four in every half minute, however hard it is pushed: a refusal does not push the window out.
    expect(answers.filter((answer) => answer === 'token')).toHaveLength(4 * (120 / 30));
    expect(answers.slice(30, 34)).toEqual(['token', 'token', 'token', 'token']);
  });

  it('these are the edge’s numbers', () => {
    const edgeFile = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../services/edge-device/lambda/pairing-code.mjs'), 'utf8');
    expect(edgeFile).toMatch(/export const REFRESH_TOKEN_TTL_SEC = 60 \* 60;/);
    expect(edgeFile).toMatch(/export const REFRESH_WINDOW_MS = 30 \* 1000;/);
    expect(edgeFile).toMatch(/export const REFRESH_MAX_PER_WINDOW = 4;/);
    expect(edgeFile).toMatch(/if \(!at \|\| now - at >= REFRESH_WINDOW_MS\) return \{ at: now, count: 1 \};/);
  });
});

// `television` above is ResidentApp.tsx without React. This holds the component to it.
describe('where it is wired', () => {
  const read = (file: string): string => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../..', file), 'utf8');
  const resident = read('ResidentApp.tsx');
  const app = read('App.tsx');

  it('ResidentApp.tsx opens the channel with the token in use, and again when a fresh one is taken', () => {
    expect(resident).toMatch(/const inUse = fresh\?\.of === token \? fresh\.token : token;/);
    expect(resident).toMatch(/holdCardChannel\(store, inUse, /);
    expect(resident).toMatch(/\}, \[inUse, onScreen, store, config, questionLeft, watch\]\);/);
    expect(resident).toMatch(/onFresh: \(next\) => \{[^}]*setFresh\(\{ of: token, token: next \}\)/);
  });

  it('a fresh token is not a new television: the watch, the card service and "Wick is in front" go by the token it was launched with', () => {
    // One watch for as long as the launch's token stands: it is the watch that holds the fresh ones.
    expect(resident).toMatch(/\[store, token\],\n  \);\n  React\.useEffect\(\(\) => watch\.onScreen\(onScreen\)/);
    // The effect that says `app_lifecycle fg` to the edge, and the one that starts the card service.
    expect(resident).toMatch(/\}, \[token, store, breakController\]\);/);
    expect(resident).toMatch(/void launchCardService\(\(uri\) => Linking\.openURL\(uri\)\);\n  \}, \[token, onScreen\]\);/);
    expect(resident).not.toMatch(/\[inUse, store, breakController\]/);
  });

  // After an hour on screen "Watch live" was refused too: it showed the launch's token.
  it('live view asks for the door with the token in use', () => {
    expect(resident).toMatch(/jwt=\{inUse\.jwt\}/);
    expect(resident).not.toMatch(/jwt=\{token\.jwt\}/);
  });

  it('App.tsx writes a fresh token down only over one that ends sooner, and asks with the token in use', () => {
    expect(app).toMatch(/keep: \(fresh: DeviceToken\) => pairing\.keepIfLonger\(fresh\)/);
    expect(app).toMatch(/ask: \(held: DeviceToken\) => pairing\.renew\(held\.deviceId, held\.jwt, \{ remember: false \}\)/);
    expect(resident).toMatch(/standingNow\.current\?\.keep\(next\)/);
  });
});
