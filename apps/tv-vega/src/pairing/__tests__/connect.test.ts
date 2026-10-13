import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceToken } from '@wick/contracts';
import { unreachableLine } from '../../family/familyScreen.js';
import { STILL_TRYING, connectTelevision, retryDelayMs, type Connecting } from '../connect.js';
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

    expect(h.states).toEqual([{ kind: 'ready', token: TOKEN }]);
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
    expect(h.last()).toEqual({ kind: 'ready', token: TOKEN });
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
    expect(h.last()).toEqual({ kind: 'ready', token: TOKEN });
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
    expect(h.last()).toEqual({ kind: 'ready', token: TOKEN });
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
