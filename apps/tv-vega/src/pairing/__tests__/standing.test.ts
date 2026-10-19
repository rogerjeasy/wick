import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceToken } from '@wick/contracts';
import { PAIRING_REQUEST_TIMEOUT_MS, type RenewResult } from '../PairingFlow.js';
import { TOKEN_MARGIN_MS } from '../held.js';
import { STANDING_EVERY_MS, STANDING_MIN_GAP_MS, TROUBLE_QUIET_MS, standingOf, standingWatch, type Standing } from '../standing.js';

const T0 = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A token as the pairing service mints one (edge-device jwt.mjs): `life` long from `at`, both by the service's clock. */
function minted(name: string, at: number, life = HOUR, home = 'h1'): DeviceToken {
  const iat = Math.floor(at / 1000);
  const jwt = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ deviceId: 'd1', householdId: home, iat, exp: iat + life / 1000 })}.${name}`;
  return { jwt, deviceId: 'd1', householdId: home, expiresAt: at + life };
}

/** What the name given to `minted` was: the last part of the token. */
const nameOf = (token: DeviceToken | undefined): string | undefined => token?.jwt.split('.')[2];

/**
 * A television watching its own standing, with a pairing service the test
 * answers for. It holds a thirty-day token read from its disk, mid-life,
 * unless the test gives it another.
 */
function television(options: { token?: DeviceToken; since?: number; serviceClock?: () => number } = {}) {
  let answer: () => Promise<Standing | RenewResult> = async () => 'connected';
  let mints = 0;
  const serviceNow = options.serviceClock ?? (() => Date.now());
  const ask = vi.fn(async (_held: DeviceToken): Promise<RenewResult> => {
    const said = await answer();
    if (said === 'unknown') return 'try_later';
    // Connected: the pairing service hands back an hour's token, as it does for every refresh.
    if (said === 'connected') return { token: minted(`fresh-${(mints += 1)}`, serviceNow()) };
    return said;
  });
  const gone = vi.fn();
  const fresh = vi.fn();
  const token = options.token ?? minted('on-disk', T0 - 15 * DAY, 30 * DAY);
  const watch = standingWatch({ ask, onGone: gone, onFresh: fresh, held: { token, ...(options.since !== undefined ? { since: options.since } : {}) } });
  return {
    watch,
    ask,
    gone,
    /** Told each token the television takes in place of the one it held. */
    fresh,
    /** The tokens taken, by name. */
    taken: (): Array<string | undefined> => fresh.mock.calls.map(([taken]) => nameOf(taken as DeviceToken)),
    /** The token shown at each ask, by name. */
    shown: (): Array<string | undefined> => ask.mock.calls.map(([held]) => nameOf(held)),
    /** What the pairing service says from now on. */
    says(next: Standing | (() => Promise<Standing | RenewResult>)) {
      answer = typeof next === 'function' ? next : async () => next;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

// Seen on the Fire OS emulator, 2026-10-13: the organiser disconnected the
// resident's television from the family app, and it went on showing her
// home screen — for as long as anyone watched, and again after a relaunch.
// It held a token that no longer opened anything, and never asked.
describe('standingWatch — a television the family has disconnected does not go on looking like hers', () => {
  it('disconnected while off, then launched: asks as soon as it is on screen, and is told', async () => {
    const tv = television();
    tv.says('not_connected');

    tv.watch.onScreen(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(tv.ask).toHaveBeenCalledTimes(1);
    expect(tv.gone).toHaveBeenCalledTimes(1);
  });

  it('disconnected while on screen: is told within a minute, with nothing else to prompt it', async () => {
    const tv = television();
    tv.watch.onScreen(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tv.gone).not.toHaveBeenCalled();

    // The organiser presses "Disconnect" in the family app.
    tv.says('not_connected');
    await vi.advanceTimersByTimeAsync(STANDING_EVERY_MS);

    expect(tv.gone).toHaveBeenCalledTimes(1);
    expect(STANDING_EVERY_MS).toBe(60_000);
  });

  it('is told sooner when its channel is refused: that is asked about at once', async () => {
    const tv = television();
    tv.watch.onScreen(true);
    await vi.advanceTimersByTimeAsync(STANDING_MIN_GAP_MS);
    tv.says('not_connected');

    // The edge cuts the television off its channel; every reconnection is refused.
    tv.watch.trouble();
    await vi.advanceTimersByTimeAsync(0);

    expect(tv.gone).toHaveBeenCalledTimes(1);
  });

  it('goes on being asked for as long as it is on screen and connected', async () => {
    const tv = television();
    tv.watch.onScreen(true);

    await vi.advanceTimersByTimeAsync(10 * STANDING_EVERY_MS);

    expect(tv.ask).toHaveBeenCalledTimes(11);
    expect(tv.gone).not.toHaveBeenCalled();
  });

  it('says it once, and asks nothing more after it', async () => {
    const tv = television();
    tv.says('not_connected');
    tv.watch.onScreen(true);
    await vi.advanceTimersByTimeAsync(0);

    for (let i = 0; i < 5; i += 1) tv.watch.trouble();
    await vi.advanceTimersByTimeAsync(10 * STANDING_EVERY_MS);

    expect(tv.ask).toHaveBeenCalledTimes(1);
    expect(tv.gone).toHaveBeenCalledTimes(1);
  });
});

describe('standingWatch — a television must never drop to the pairing screen for a network that is only slow, or gone', () => {
  it('network off: every ask fails, and nothing happens — however long, however much trouble the channel is in', async () => {
    const tv = television();
    tv.says('unknown');
    tv.watch.onScreen(true);

    for (let second = 0; second < 600; second += 1) {
      tv.watch.trouble();
      await vi.advanceTimersByTimeAsync(1_000);
    }

    expect(tv.gone).not.toHaveBeenCalled();
    expect(tv.ask.mock.calls.length).toBeGreaterThan(5);
  });

  it('a request that never answers: given up by the pairing flow after its ten seconds, and nothing happens', async () => {
    const tv = television();
    tv.says(() => new Promise<Standing>((resolve) => setTimeout(() => resolve('unknown'), PAIRING_REQUEST_TIMEOUT_MS)));
    tv.watch.onScreen(true);

    await vi.advanceTimersByTimeAsync(5 * STANDING_EVERY_MS);

    expect(tv.gone).not.toHaveBeenCalled();
  });

  it('an ask that throws is an ask that failed', async () => {
    const tv = television();
    tv.says(async () => {
      throw new Error('boom');
    });
    tv.watch.onScreen(true);
    await vi.advanceTimersByTimeAsync(STANDING_EVERY_MS);

    expect(tv.gone).not.toHaveBeenCalled();
    expect(tv.ask).toHaveBeenCalledTimes(2);
  });

  it('is told when the network comes back and the answer is then "not connected"', async () => {
    const tv = television();
    tv.says('unknown');
    tv.watch.onScreen(true);
    await vi.advanceTimersByTimeAsync(3 * STANDING_EVERY_MS);

    tv.says('not_connected');
    await vi.advanceTimersByTimeAsync(STANDING_EVERY_MS);

    expect(tv.gone).toHaveBeenCalledTimes(1);
  });
});

describe('standingWatch — how often it asks', () => {
  it('asks at most once in half a minute, however often the channel says it is in trouble', async () => {
    const tv = television();
    tv.watch.onScreen(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(tv.ask).toHaveBeenCalledTimes(1);

    for (let second = 0; second < 29; second += 1) {
      tv.watch.trouble();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(tv.ask).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    tv.watch.trouble();
    await vi.advanceTimersByTimeAsync(0);
    expect(tv.ask).toHaveBeenCalledTimes(2);
    expect(STANDING_MIN_GAP_MS).toBe(30_000);
  });

  it('never has two asks out at once', async () => {
    const tv = television();
    let answer: (standing: Standing) => void = () => {};
    tv.says(() => new Promise<Standing>((resolve) => (answer = resolve)));
    tv.watch.onScreen(true);

    await vi.advanceTimersByTimeAsync(3 * STANDING_EVERY_MS);
    tv.watch.trouble();
    expect(tv.ask).toHaveBeenCalledTimes(1);

    answer('connected');
    await vi.advanceTimersByTimeAsync(STANDING_EVERY_MS);
    expect(tv.ask).toHaveBeenCalledTimes(2);
  });

  // The Vega simulator keeps no token: it asks the pairing service for one
  // at every launch, and is told there and then if it is no longer
  // connected (connect.ts shows the pairing screen). It need not ask twice.
  it('does not ask again at launch on a television the pairing service has only just answered', async () => {
    const tv = television({ token: minted('launch', T0 - 500), since: T0 - 500 });
    tv.watch.onScreen(true);

    await vi.advanceTimersByTimeAsync(STANDING_MIN_GAP_MS - 1_000);
    expect(tv.ask).not.toHaveBeenCalled();

    // But it is asked about within the minute, like any other.
    await vi.advanceTimersByTimeAsync(STANDING_EVERY_MS);
    expect(tv.ask).toHaveBeenCalledTimes(1);
  });

  it('asks nothing while Wick is off the screen, and at once when it comes back', async () => {
    const tv = television();
    tv.watch.onScreen(true);
    await vi.advanceTimersByTimeAsync(0);

    tv.watch.onScreen(false);
    await vi.advanceTimersByTimeAsync(10 * STANDING_EVERY_MS);
    expect(tv.ask).toHaveBeenCalledTimes(1);

    tv.watch.onScreen(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(tv.ask).toHaveBeenCalledTimes(2);
  });

  it('stops: nothing more is asked, and an answer still on its way changes nothing', async () => {
    const tv = television();
    let answer: (standing: Standing) => void = () => {};
    tv.says(() => new Promise<Standing>((resolve) => (answer = resolve)));
    tv.watch.onScreen(true);

    tv.watch.stop();
    answer('not_connected');
    tv.watch.trouble();
    await vi.advanceTimersByTimeAsync(5 * STANDING_EVERY_MS);

    expect(tv.ask).toHaveBeenCalledTimes(1);
    expect(tv.gone).not.toHaveBeenCalled();
  });
});

// A refreshed token lasts an hour — every token the Vega simulator ever
// holds, since it keeps none on disk. The MQTT session ends when the token
// does, the channel reconnects with the same token and is refused, and until
// Wick was launched again her television silently received no cards. The
// answer to the question it already asks carries a fresh token: it is taken
// when the one in use is near its end.
describe('standingWatch — a television that is still connected takes a fresh token in good time', () => {
  /** As the Vega simulator launches: handed an hour's token by the pairing service a moment ago. */
  const launched = () => television({ token: minted('launch', T0), since: T0 });

  it('an hour on screen: the routine ask five minutes before the end brings the fresh token — and no ask before it changes anything', async () => {
    const tv = launched();
    tv.watch.onScreen(true);

    await vi.advanceTimersByTimeAsync(HOUR - TOKEN_MARGIN_MS - 1);
    expect(tv.ask).toHaveBeenCalledTimes(54);
    expect(tv.fresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(tv.taken()).toEqual(['fresh-55']);
    expect(tv.gone).not.toHaveBeenCalled();
  });

  it('the fresh token is the one it holds from then on, and has its own hour', async () => {
    const tv = launched();
    tv.watch.onScreen(true);
    await vi.advanceTimersByTimeAsync(HOUR - TOKEN_MARGIN_MS);

    await vi.advanceTimersByTimeAsync(HOUR - TOKEN_MARGIN_MS - 1);
    expect(tv.taken()).toEqual(['fresh-55']);
    expect(tv.shown().at(-1)).toBe('fresh-55');

    await vi.advanceTimersByTimeAsync(1);
    expect(tv.taken()).toEqual(['fresh-55', 'fresh-110']);
  });

  it('a day on screen: a fresh token every fifty-five minutes, and never two for one hour', async () => {
    const tv = launched();
    tv.watch.onScreen(true);

    await vi.advanceTimersByTimeAsync(DAY);

    expect(tv.fresh).toHaveBeenCalledTimes(Math.floor(DAY / (HOUR - TOKEN_MARGIN_MS)));
  });

  it('a token that has run out, and a channel in trouble: asked at once, and the fresh token is taken', async () => {
    // The card service: no screen, so nothing routine — only its channel's trouble.
    const tv = launched();
    await vi.advanceTimersByTimeAsync(HOUR + MINUTE);
    expect(tv.ask).not.toHaveBeenCalled();

    tv.watch.trouble();
    await vi.advanceTimersByTimeAsync(0);

    expect(tv.taken()).toEqual(['fresh-1']);
  });

  it('a channel in trouble while the token has plenty of life: "connected" changes nothing', async () => {
    const tv = launched();
    await vi.advanceTimersByTimeAsync(20 * MINUTE);

    tv.watch.trouble();
    await vi.advanceTimersByTimeAsync(0);

    expect(tv.ask).toHaveBeenCalledTimes(1);
    expect(tv.fresh).not.toHaveBeenCalled();
  });

  it('no network at the margin: nothing is taken, the old token runs out, and the first answer after the network is back brings the fresh one', async () => {
    const tv = launched();
    tv.watch.onScreen(true);
    await vi.advanceTimersByTimeAsync(50 * MINUTE);

    tv.says('unknown');
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(tv.fresh).not.toHaveBeenCalled();
    expect(tv.gone).not.toHaveBeenCalled();

    tv.says('connected');
    await vi.advanceTimersByTimeAsync(STANDING_EVERY_MS);
    expect(tv.fresh).toHaveBeenCalledTimes(1);
  });

  it('a disconnected television takes nothing, however near its token is to its end: it is told it is no longer connected', async () => {
    for (const age of [HOUR - TOKEN_MARGIN_MS, HOUR + MINUTE]) {
      vi.setSystemTime(T0);
      const tv = launched();
      await vi.advanceTimersByTimeAsync(age);
      tv.says('not_connected');

      tv.watch.trouble();
      await vi.advanceTimersByTimeAsync(0);

      expect(tv.fresh).not.toHaveBeenCalled();
      expect(tv.gone).toHaveBeenCalledTimes(1);
    }
  });

  // On the Vega simulator every television has the same id. One disconnected
  // from her home and connected to another is answered with that home's token.
  it('a token for another home is not taken: this television is no longer connected to hers', async () => {
    const tv = launched();
    await vi.advanceTimersByTimeAsync(HOUR);
    tv.says(async () => ({ token: minted('elsewhere', Date.now(), HOUR, 'h2') }));

    tv.watch.trouble();
    await vi.advanceTimersByTimeAsync(0);

    expect(tv.fresh).not.toHaveBeenCalled();
    expect(tv.gone).toHaveBeenCalledTimes(1);
  });

  it('nor a token that names a kind this television is not', async () => {
    const tv = launched();
    await vi.advanceTimersByTimeAsync(HOUR);
    tv.says(async () => ({ token: { ...minted('family', Date.now()), kind: 'family' as const } }));

    tv.watch.trouble();
    await vi.advanceTimersByTimeAsync(0);

    expect(tv.fresh).not.toHaveBeenCalled();
    expect(tv.gone).toHaveBeenCalledTimes(1);
  });

  it('a thirty-day token from the disk, mid-life: hours of "connected" change nothing', async () => {
    const tv = television();
    tv.watch.onScreen(true);

    await vi.advanceTimersByTimeAsync(6 * HOUR);

    expect(tv.ask.mock.calls.length).toBeGreaterThan(300);
    expect(tv.fresh).not.toHaveBeenCalled();
  });

  it('a thirty-day token from the disk that runs out while she watches: the fresh one is taken five minutes before', async () => {
    const tv = television({ token: minted('on-disk', T0 + 10 * MINUTE - 30 * DAY, 30 * DAY) });
    tv.watch.onScreen(true);

    await vi.advanceTimersByTimeAsync(5 * MINUTE - 1);
    expect(tv.fresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(tv.fresh).toHaveBeenCalledTimes(1);
  });

  // Seen on the Vega simulator: its clock was 6.9 hours out.
  it('a television whose clock is hours fast, or hours slow, takes the fresh token at the same fifty-five minutes', async () => {
    for (const ahead of [6.9 * HOUR, -6.9 * HOUR]) {
      vi.setSystemTime(T0);
      const serviceClock = (): number => Date.now() - ahead;
      const tv = television({ token: minted('launch', serviceClock()), since: T0, serviceClock });
      tv.watch.onScreen(true);

      await vi.advanceTimersByTimeAsync(HOUR - TOKEN_MARGIN_MS - 1);
      expect(tv.fresh).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(tv.taken()).toEqual(['fresh-55']);

      // And the fresh one's hour is counted the same way, from when it was taken.
      await vi.advanceTimersByTimeAsync(HOUR - TOKEN_MARGIN_MS - 1);
      expect(tv.taken()).toEqual(['fresh-55']);
      await vi.advanceTimersByTimeAsync(1);
      expect(tv.taken()).toEqual(['fresh-55', 'fresh-110']);
      tv.watch.stop();
    }
  });

  it('stopped: an answer still on its way brings nothing', async () => {
    const tv = launched();
    await vi.advanceTimersByTimeAsync(HOUR);
    let answer: (standing: Standing) => void = () => {};
    tv.says(() => new Promise<Standing>((resolve) => (answer = resolve)));
    tv.watch.trouble();

    tv.watch.stop();
    answer('connected');
    await vi.advanceTimersByTimeAsync(0);

    expect(tv.fresh).not.toHaveBeenCalled();
  });
});

// What the television makes of a token's age rests on its clock, and its
// clock can be wrong, or be put right while it runs. What cannot be wrong:
// the pairing service says "connected", and the channel still will not open.
describe('standingWatch — trouble that goes on after the pairing service has said "connected"', () => {
  /** The channel says it is in trouble once a second, as it does while it is not open (transport/startCardChannel.ts). */
  const troubledFor = async (tv: ReturnType<typeof television>, ms: number): Promise<void> => {
    for (let gone = 0; gone < ms; gone += 1_000) {
      tv.watch.trouble();
      await vi.advanceTimersByTimeAsync(1_000);
    }
  };

  it('the second such answer brings a fresh token, whatever the clock makes of the old one', async () => {
    // A thirty-day token, mid-life by this television's clock.
    const tv = television();

    await troubledFor(tv, STANDING_MIN_GAP_MS);
    expect(tv.ask).toHaveBeenCalledTimes(1);
    expect(tv.fresh).not.toHaveBeenCalled();

    await troubledFor(tv, 1_000);
    expect(tv.ask).toHaveBeenCalledTimes(2);
    expect(tv.taken()).toEqual(['fresh-2']);
  });

  it('and if the trouble still goes on, again after two more — never at every answer', async () => {
    const tv = television();

    await troubledFor(tv, 5 * MINUTE);

    // Asked every half minute: ten answers, every second one taken.
    expect(tv.ask).toHaveBeenCalledTimes(10);
    expect(tv.fresh).toHaveBeenCalledTimes(5);
  });

  it('trouble that ends: one "connected" in it changes nothing, and later trouble is counted from the start', async () => {
    const tv = television();
    await troubledFor(tv, 3_000);
    expect(tv.ask).toHaveBeenCalledTimes(1);

    // The channel reconnected by itself, as it does after a network that came back.
    await vi.advanceTimersByTimeAsync(TROUBLE_QUIET_MS + 1_000);
    await troubledFor(tv, 3_000);

    expect(tv.ask).toHaveBeenCalledTimes(2);
    expect(tv.fresh).not.toHaveBeenCalled();
    expect(TROUBLE_QUIET_MS).toBe(60_000);
  });

  it('an answer to the routine ask, with the channel in no trouble, is not counted', async () => {
    const tv = television();
    tv.watch.onScreen(true);
    await troubledFor(tv, 3_000);

    // Open again; two minutes of routine asks.
    await vi.advanceTimersByTimeAsync(2 * STANDING_EVERY_MS + 1_000);
    await troubledFor(tv, 2_000);

    expect(tv.ask.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(tv.fresh).not.toHaveBeenCalled();
  });

  it('no network: asks that fail are not "connected", however long the trouble', async () => {
    const tv = television();
    tv.says('unknown');

    await troubledFor(tv, 10 * MINUTE);

    expect(tv.fresh).not.toHaveBeenCalled();
    expect(tv.gone).not.toHaveBeenCalled();
  });
});

describe('standingOf — what each answer of the pairing service means', () => {
  const token: DeviceToken = { jwt: 'fresh', deviceId: 'd1', householdId: 'h1', expiresAt: 1 };

  it('"not connected" only when the pairing service says so: the television is unknown to it (404), revoked (403), or its token is not its own (401)', () => {
    expect(standingOf('not_connected')).toBe('not_connected');
  });

  it('"connected" when it is handed a token: the television still belongs to a home', () => {
    expect(standingOf({ token })).toBe('connected');
  });

  it('nothing known for everything else: asked too soon, the service in trouble, no answer, no network', () => {
    expect(standingOf('try_later')).toBe('unknown');
  });
});

// The watch is a few lines in two components. This holds them in place.
describe('where the watch is wired', () => {
  const read = (file: string): string => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../..', file), 'utf8');
  const app = read('App.tsx');
  const resident = read('ResidentApp.tsx');

  it('App.tsx asks the pairing service by the television’s id, showing the token in use, and writes nothing down for the asking', () => {
    expect(app).toMatch(/ask: \(held: DeviceToken\) => pairing\.renew\(held\.deviceId, held\.jwt, \{ remember: false \}\)/);
  });

  it('App.tsx takes "no longer connected" the way it takes a family television signed out: the token forgotten, the pairing screen, and no token asked for again', () => {
    expect(app).toMatch(/onGone: handleSignedOut/);
    expect(app).toMatch(/<ResidentApp[^>]*standing/);
  });

  it('ResidentApp.tsx forgets what it holds of the home before it says so', () => {
    expect(resident).toMatch(/store\s*\.forget\(\)\s*\.then\(/);
    expect(resident.indexOf('.forget()')).toBeLessThan(resident.indexOf('?.onGone()'));
  });

  it('ResidentApp.tsx tells the watch when Wick is on screen, and when its channel is in trouble', () => {
    expect(resident).toMatch(/watch\.onScreen\(onScreen\)/);
    expect(resident).toMatch(/holdCardChannel\([^)]*questionLeft, watch\.trouble, handleLink\)/);
  });
});
