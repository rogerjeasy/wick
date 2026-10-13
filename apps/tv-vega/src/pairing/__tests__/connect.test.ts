import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceToken } from '@wick/contracts';
import { unreachableLine } from '../../family/familyScreen.js';
import { HOLD_AFTER_MS, STILL_TRYING, connectTelevision, retryDelayMs, type Connecting } from '../connect.js';
import { PAIRING_REQUEST_TIMEOUT_MS } from '../PairingFlow.js';
import type { PairingStartResponse } from '../PairingFlow.js';

const TOKEN: DeviceToken = { jwt: 'j', deviceId: 'd1', householdId: 'h1', expiresAt: 1 };
const CODE: PairingStartResponse = { code: '123456', url: 'https://wick.example/?pair=123456', expiresAt: 2 };
const NEXT_CODE: PairingStartResponse = { code: '654321', url: 'https://wick.example/?pair=654321', expiresAt: 3 };

/** A pairing flow whose every step the test decides. */
function harness(signedOut = false) {
  const states: Connecting[] = [];
  const pairing = {
    loadToken: vi.fn(async (): Promise<DeviceToken | null> => null),
    start: vi.fn(async (): Promise<PairingStartResponse> => CODE),
    pollUntilBound: vi.fn((): Promise<DeviceToken> => new Promise(() => {})),
    clearToken: vi.fn(async () => undefined),
    /** The token on this television's disk, run out or not — none, unless the test says so. */
    rememberedToken: vi.fn(async (): Promise<DeviceToken | null> => null),
  };
  const deviceId = vi.fn(async () => 'd1');
  const begin = () => connectTelevision({ deviceId, pairing, signedOut, onChange: (state) => void states.push(state) });
  return { states, pairing, deviceId, begin, last: () => states[states.length - 1] };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('connectTelevision — getting a television its token', () => {
  it('is ready at once with the token it has, and asks for no code', async () => {
    const h = harness();
    h.pairing.loadToken.mockResolvedValue(TOKEN);
    h.begin();

    await vi.advanceTimersByTimeAsync(0);

    expect(h.states).toEqual([{ kind: 'ready', token: TOKEN, asked: true }]);
    expect(h.pairing.loadToken).toHaveBeenCalledWith('d1');
    expect(h.pairing.start).not.toHaveBeenCalled();
  });

  it('shows a code when it has no token, and is ready when the code has been entered', async () => {
    const h = harness();
    let entered: (token: DeviceToken) => void = () => {};
    h.pairing.pollUntilBound.mockReturnValue(new Promise((resolve) => (entered = resolve)));
    h.begin();

    await vi.advanceTimersByTimeAsync(0);
    expect(h.states).toEqual([{ kind: 'pairing', info: CODE }]);
    expect(h.pairing.pollUntilBound).toHaveBeenCalledWith('123456');

    entered(TOKEN);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.last()).toEqual({ kind: 'ready', token: TOKEN, asked: true });
  });
});

// Seen on the Vega simulator, 2026-10-13: the first launch after a cold
// boot sat on "Getting a code…" for over a minute. One request had failed —
// or never answered — and nothing ever asked again.
describe('connectTelevision — when the pairing service cannot be reached', () => {
  it('says so, and tries again after a few seconds — not never', async () => {
    const h = harness();
    h.pairing.loadToken.mockRejectedValueOnce(new Error('pairing_request_timed_out')).mockResolvedValue(TOKEN);
    h.begin();

    await vi.advanceTimersByTimeAsync(0);
    expect(h.states).toEqual([{ kind: 'pairing', trying: true }]);

    await vi.advanceTimersByTimeAsync(retryDelayMs(1) - 1);
    expect(h.pairing.loadToken).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(h.pairing.loadToken).toHaveBeenCalledTimes(2);
    expect(h.last()).toEqual({ kind: 'ready', token: TOKEN, asked: true });
  });

  it('tries again when it is the code that could not be had', async () => {
    const h = harness();
    h.pairing.start.mockRejectedValueOnce(new Error('pairing_start_failed: 503')).mockResolvedValue(CODE);
    h.begin();

    await vi.advanceTimersByTimeAsync(0);
    expect(h.last()).toEqual({ kind: 'pairing', trying: true });

    await vi.advanceTimersByTimeAsync(retryDelayMs(1));
    expect(h.last()).toEqual({ kind: 'pairing', info: CODE });
  });

  it('asks for its token again on every try: by then the television may be known', async () => {
    const h = harness();
    h.pairing.start.mockRejectedValue(new Error('no network'));
    h.pairing.loadToken.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue(TOKEN);
    h.begin();

    await vi.advanceTimersByTimeAsync(retryDelayMs(1) + retryDelayMs(2));

    expect(h.pairing.loadToken).toHaveBeenCalledTimes(3);
    expect(h.last()).toEqual({ kind: 'ready', token: TOKEN, asked: true });
  });

  it('tries calmly: a few seconds at first, backing off to a quarter of a minute and no further', () => {
    expect([1, 2, 3, 4, 5, 20].map(retryDelayMs)).toEqual([3_000, 6_000, 12_000, 15_000, 15_000, 15_000]);
  });

  it('goes on trying for as long as it takes, at that calm pace', async () => {
    const h = harness();
    h.pairing.loadToken.mockRejectedValue(new Error('no network'));
    h.begin();

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    // 3 + 6 + 12 = 21 s for the first four tries, then one every 15 s.
    expect(h.pairing.loadToken).toHaveBeenCalledTimes(4 + Math.floor((5 * 60 - 21) / 15));
    expect(h.states).toEqual([{ kind: 'pairing', trying: true }]);
  });

  it('starts the count again once something has worked', async () => {
    const h = harness();
    h.pairing.start.mockRejectedValueOnce(new Error('x')).mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(CODE).mockRejectedValueOnce(new Error('x')).mockResolvedValue(NEXT_CODE);
    h.pairing.pollUntilBound.mockRejectedValueOnce(new Error('pairing_code_expired'));
    h.begin();

    await vi.advanceTimersByTimeAsync(retryDelayMs(1) + retryDelayMs(2));
    expect(h.last()).toEqual({ kind: 'pairing', info: CODE });

    // The code ran out; the next code could not be had; one short wait, not the long one.
    await vi.advanceTimersByTimeAsync(retryDelayMs(1));
    expect(h.pairing.start).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(retryDelayMs(1));
    expect(h.last()).toEqual({ kind: 'pairing', info: NEXT_CODE });
  });

  it('says it in the words Wick already uses for not reaching a home', () => {
    expect(STILL_TRYING).toBe(unreachableLine(undefined));
  });
});

describe('connectTelevision — a code that has run out', () => {
  it('is replaced by a new one, with the old one left on screen until the new one is there', async () => {
    const h = harness();
    h.pairing.start.mockResolvedValueOnce(CODE).mockResolvedValue(NEXT_CODE);
    h.pairing.pollUntilBound.mockRejectedValueOnce(new Error('pairing_code_expired'));
    h.begin();

    await vi.advanceTimersByTimeAsync(0);
    expect(h.states).toEqual([{ kind: 'pairing', info: CODE }]);

    await vi.advanceTimersByTimeAsync(retryDelayMs(1));
    expect(h.states).toEqual([
      { kind: 'pairing', info: CODE },
      { kind: 'pairing', info: NEXT_CODE },
    ]);
    expect(h.pairing.pollUntilBound).toHaveBeenLastCalledWith('654321');
  });
});

describe('connectTelevision — a family television told it is no longer connected', () => {
  it('forgets its token once, and never asks for it again: a refresh that still answered would only bring it straight back', async () => {
    const h = harness(true);
    h.pairing.start.mockRejectedValueOnce(new Error('no network')).mockResolvedValue(CODE);
    h.begin();

    await vi.advanceTimersByTimeAsync(retryDelayMs(1));

    expect(h.pairing.clearToken).toHaveBeenCalledTimes(1);
    expect(h.pairing.loadToken).not.toHaveBeenCalled();
    expect(h.last()).toEqual({ kind: 'pairing', info: CODE });
  });
});

describe('connectTelevision — cancelled', () => {
  it('says nothing more and tries nothing more', async () => {
    const h = harness();
    h.pairing.loadToken.mockRejectedValue(new Error('no network'));
    const connecting = h.begin();
    await vi.advanceTimersByTimeAsync(0);

    connecting.cancel();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(h.pairing.loadToken).toHaveBeenCalledTimes(1);
    expect(h.states).toHaveLength(1);
  });

  it('does not make a television ready that was already let go of', async () => {
    const h = harness();
    let answer: (token: DeviceToken | null) => void = () => {};
    h.pairing.loadToken.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const connecting = h.begin();
    await vi.advanceTimersByTimeAsync(0);

    connecting.cancel();
    answer(TOKEN);
    await vi.advanceTimersByTimeAsync(0);

    expect(h.states).toEqual([]);
  });
});

// Seen on both televisions, 2026-10-13, with the network gone: nothing was
// drawn at all until the first request gave up, ten seconds in — and on a
// television already connected, nothing of its own screen for longer.
describe('connectTelevision — what is on screen while the first request has not answered', () => {
  /** A request that fails when its ten seconds are up, as PairingFlow's do. */
  const hangs = <T,>(): Promise<T> => new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error('pairing_request_timed_out')), PAIRING_REQUEST_TIMEOUT_MS));
  const after = <T,>(ms: number, value: T): Promise<T> => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
  const STALE: DeviceToken = { jwt: 'run-out', deviceId: 'd1', householdId: 'h1', expiresAt: 0 };
  const FAMILY_STALE: DeviceToken = { ...STALE, kind: 'family' };

  it('waits a second before it shows anything: a television that is answered in that time shows only its own screen', () => {
    expect(HOLD_AFTER_MS).toBe(1_000);
  });

  describe('a television that has never been connected', () => {
    it('shows the pairing screen after a second, says it cannot reach the home when the request gives up, and shows the code when it comes', async () => {
      const h = harness();
      h.pairing.loadToken.mockImplementationOnce(() => hangs()).mockResolvedValue(null);
      h.begin();

      await vi.advanceTimersByTimeAsync(HOLD_AFTER_MS - 1);
      expect(h.states).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      // "Set up Wick" / "Getting a code…"
      expect(h.states).toEqual([{ kind: 'pairing' }]);

      await vi.advanceTimersByTimeAsync(PAIRING_REQUEST_TIMEOUT_MS - HOLD_AFTER_MS);
      expect(h.last()).toEqual({ kind: 'pairing', trying: true });

      await vi.advanceTimersByTimeAsync(retryDelayMs(1));
      expect(h.last()).toEqual({ kind: 'pairing', info: CODE });
    });

    it('shows the code as soon as it has one, with nothing before it, on a network that answers', async () => {
      const h = harness();
      h.pairing.loadToken.mockImplementation(() => after(300, null));
      h.pairing.start.mockImplementation(() => after(300, CODE));
      h.begin();

      await vi.advanceTimersByTimeAsync(5_000);

      expect(h.states).toEqual([{ kind: 'pairing', info: CODE }]);
    });

    it('says it cannot reach the home at once when the first request is refused outright, without the second’s wait', async () => {
      const h = harness();
      h.pairing.loadToken.mockRejectedValue(new TypeError('Network request failed'));
      h.begin();

      await vi.advanceTimersByTimeAsync(0);

      expect(h.states).toEqual([{ kind: 'pairing', trying: true }]);
    });
  });

  describe('a television that was connected before', () => {
    it('shows its own screen after a second, with the token it remembers, and never the pairing screen while it only cannot reach', async () => {
      const h = harness();
      h.pairing.rememberedToken.mockResolvedValue(STALE);
      h.pairing.loadToken.mockImplementation(() => hangs());
      h.begin();

      await vi.advanceTimersByTimeAsync(HOLD_AFTER_MS - 1);
      expect(h.states).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.states).toEqual([{ kind: 'ready', token: STALE }]);

      // Ten seconds, twenty, a minute: the request gives up and is tried again, and the screen stays its own.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.states).toEqual([{ kind: 'ready', token: STALE }]);
      expect(h.pairing.loadToken.mock.calls.length).toBeGreaterThan(2);
      expect(h.pairing.start).not.toHaveBeenCalled();
    });

    it('is given its fresh token when the pairing service answers again', async () => {
      const h = harness();
      h.pairing.rememberedToken.mockResolvedValue(FAMILY_STALE);
      h.pairing.loadToken.mockImplementationOnce(() => hangs()).mockResolvedValue({ ...FAMILY_STALE, jwt: 'fresh', expiresAt: 9 });
      h.begin();

      await vi.advanceTimersByTimeAsync(PAIRING_REQUEST_TIMEOUT_MS + retryDelayMs(1));

      expect(h.states).toEqual([
        { kind: 'ready', token: FAMILY_STALE },
        { kind: 'ready', token: { ...FAMILY_STALE, jwt: 'fresh', expiresAt: 9 }, asked: true },
      ]);
    });

    it('shows only its own screen, once, on a network that answers: exactly what it showed before', async () => {
      const h = harness();
      h.pairing.rememberedToken.mockResolvedValue(STALE);
      h.pairing.loadToken.mockImplementation(() => after(300, TOKEN));
      h.begin();

      await vi.advanceTimersByTimeAsync(5_000);

      expect(h.states).toEqual([{ kind: 'ready', token: TOKEN, asked: true }]);
    });

    it('shows its own screen at once when the first request is refused outright', async () => {
      const h = harness();
      h.pairing.rememberedToken.mockResolvedValue(STALE);
      h.pairing.loadToken.mockRejectedValue(new TypeError('Network request failed'));
      h.begin();

      await vi.advanceTimersByTimeAsync(0);

      expect(h.states).toEqual([{ kind: 'ready', token: STALE }]);
    });

    it('goes to the pairing screen when the pairing service says it is no longer connected', async () => {
      const h = harness();
      h.pairing.rememberedToken.mockResolvedValue(STALE);
      // Slow to say so; and by then the token has been forgotten.
      h.pairing.loadToken.mockImplementation(() => after(3_000, null));
      h.begin();

      await vi.advanceTimersByTimeAsync(3_000);

      expect(h.states).toEqual([
        { kind: 'ready', token: STALE },
        { kind: 'pairing', info: CODE },
      ]);
    });

    it('does not go back to an old token once a code is on screen: from there on it is being set up', async () => {
      const h = harness();
      h.pairing.rememberedToken.mockResolvedValue(STALE);
      h.pairing.start.mockResolvedValueOnce(CODE).mockRejectedValue(new Error('no network'));
      h.pairing.pollUntilBound.mockRejectedValueOnce(new Error('pairing_code_expired'));
      h.begin();

      await vi.advanceTimersByTimeAsync(retryDelayMs(1));

      expect(h.states).toEqual([
        { kind: 'pairing', info: CODE },
        { kind: 'pairing', trying: true },
      ]);
    });
  });

  it('remembers nothing for a family television that was just told it is no longer connected', async () => {
    const h = harness(true);
    h.pairing.rememberedToken.mockResolvedValue(STALE);
    h.pairing.start.mockImplementation(() => hangs());
    h.begin();

    await vi.advanceTimersByTimeAsync(HOLD_AFTER_MS);

    expect(h.states).toEqual([{ kind: 'pairing' }]);
    expect(h.pairing.rememberedToken).not.toHaveBeenCalled();
  });

  it('takes a disk that cannot be read as a television that remembers nothing', async () => {
    const h = harness();
    h.pairing.rememberedToken.mockRejectedValue(new Error('[com.amazon.kepler.io.IoError]: '));
    h.pairing.loadToken.mockImplementation(() => hangs());
    h.begin();

    await vi.advanceTimersByTimeAsync(HOLD_AFTER_MS);

    expect(h.states).toEqual([{ kind: 'pairing' }]);
  });

  it('shows nothing after it has been let go of', async () => {
    const h = harness();
    h.pairing.loadToken.mockImplementation(() => hangs());
    const connecting = h.begin();

    connecting.cancel();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(h.states).toEqual([]);
  });
});

// Whether the pairing service has just answered for this television matters
// to what comes next: a television that was only read from its own disk has
// asked nobody, and may have been disconnected since (standing.ts).
describe('connectTelevision — whether the token is fresh from the pairing service', () => {
  const ON_DISK: DeviceToken = { jwt: 'kept', deviceId: 'd1', householdId: 'h1', expiresAt: Number.MAX_SAFE_INTEGER };

  it('says a token read from the disk was not asked for', async () => {
    const h = harness();
    h.pairing.rememberedToken.mockResolvedValue(ON_DISK);
    h.pairing.loadToken.mockResolvedValue(ON_DISK);
    h.begin();

    await vi.advanceTimersByTimeAsync(0);

    expect(h.states).toEqual([{ kind: 'ready', token: ON_DISK }]);
  });

  it('says a token the pairing service has just handed over was', async () => {
    const h = harness();
    h.pairing.loadToken.mockResolvedValue(TOKEN);
    h.begin();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.states).toEqual([{ kind: 'ready', token: TOKEN, asked: true }]);

    const refreshed = harness();
    refreshed.pairing.rememberedToken.mockResolvedValue({ ...ON_DISK, expiresAt: 0 });
    refreshed.pairing.loadToken.mockResolvedValue(TOKEN);
    refreshed.begin();
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshed.last()).toEqual({ kind: 'ready', token: TOKEN, asked: true });
  });

  it('says so of the token that comes when the code is entered', async () => {
    const h = harness();
    h.pairing.pollUntilBound.mockResolvedValue(TOKEN);
    h.begin();

    await vi.advanceTimersByTimeAsync(0);

    expect(h.last()).toEqual({ kind: 'ready', token: TOKEN, asked: true });
  });

  it('does not say it of a token it remembers and shows while nothing has answered', async () => {
    const h = harness();
    h.pairing.rememberedToken.mockResolvedValue({ ...ON_DISK, expiresAt: 0 });
    h.pairing.loadToken.mockRejectedValue(new TypeError('Network request failed'));
    h.begin();

    await vi.advanceTimersByTimeAsync(0);

    expect(h.last()).toEqual({ kind: 'ready', token: { ...ON_DISK, expiresAt: 0 } });
  });
});
