import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAMILY_TV_WAITING_EVERY_MS, type DeviceToken } from '@wick/contracts';
import type { WaitingAnswer } from '../../family/familyClient.js';
import type { ToastContent } from '../../notify/doorToast.js';
import { KNOCK_EVERY_MS, KNOCK_TIMEOUT_MS, NARROW_RENEW_AFTER_MS, RENEW_RETRY_MS, renewAfterMs, runWaitingService, type Claimed, type WaitingClient } from '../waitingService.js';

const T0 = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const NARROW = { jwt: 'scoped-1', deviceId: 'd1', householdId: 'h1', expiresAt: T0 + HOUR, kind: 'family', scope: 'waiting' } as DeviceToken;
const FULL: DeviceToken = { jwt: 'full-1', deviceId: 'd1', householdId: 'h1', expiresAt: T0 + 30 * 24 * HOUR, kind: 'family' };

const waits = (...items: Array<[string, string]>): WaitingAnswer => ({ kind: 'waiting', waiting: items.map(([id, line]) => ({ id, line })) });
const NOTHING = waits();

/** A service with a Wick server and a pairing service the test answers for. */
function harness() {
  const toasts: ToastContent[] = [];
  const answers: WaitingAnswer[] = [];
  const renewals: Array<'renewed' | 'signedOut' | 'later'> = [];
  const claims: Claimed[] = [];
  const clients: Array<{ token: DeviceToken; waiting: ReturnType<typeof vi.fn>; renewNow: ReturnType<typeof vi.fn> }> = [];
  const claim = vi.fn(async (): Promise<Claimed> => claims.shift() ?? 'no_way');
  const clientFor = (token: DeviceToken): WaitingClient => {
    const client = {
      token,
      waiting: vi.fn(async (): Promise<WaitingAnswer> => answers.shift() ?? NOTHING),
      renewNow: vi.fn(async () => renewals.shift() ?? 'renewed'),
    };
    clients.push(client);
    return client;
  };
  const said = new Set<string>();
  const start = (first: DeviceToken | undefined) => runWaitingService(first, { claim, clientFor, announce: (toast) => void toasts.push(toast), said });
  return { start, toasts, answers, renewals, claims, clients, claim, said, titles: () => toasts.map((t) => t.mTitle) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('runWaitingService — a family television says what waits, while Wick is off the screen', () => {
  it('asks at once, and then every FAMILY_TV_WAITING_EVERY_MS', async () => {
    const h = harness();
    h.start(NARROW);

    await vi.advanceTimersByTimeAsync(0);
    expect(h.clients).toHaveLength(1);
    expect(h.clients[0]!.waiting).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(FAMILY_TV_WAITING_EVERY_MS - 1);
    expect(h.clients[0]!.waiting).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.clients[0]!.waiting).toHaveBeenCalledTimes(2);
  });

  it('puts up one toast for each new thing, with the server’s sentence', async () => {
    const h = harness();
    h.answers.push(waits(['ftv-door_look-d1', 'Margaret asks who is at her door.'], ['ftv-wave-w1', 'Margaret waved back.']));
    h.start(NARROW);

    await vi.advanceTimersByTimeAsync(0);

    expect(h.titles()).toEqual(['Margaret asks who is at her door.', 'Margaret waved back.']);
  });

  it('says each thing once: not again while it goes on waiting, and not again if it goes away and comes back', async () => {
    const h = harness();
    const door = ['ftv-door_look-d1', 'Margaret asks who is at her door.'] as [string, string];
    h.answers.push(waits(door), waits(door), NOTHING, waits(door), waits(door, ['ftv-reach-r1', 'Margaret would like you to ring her.']));
    h.start(NARROW);

    await vi.advanceTimersByTimeAsync(FAMILY_TV_WAITING_EVERY_MS * 4);

    expect(h.titles()).toEqual(['Margaret asks who is at her door.', 'Margaret would like you to ring her.']);
  });

  it('says nothing for an ask that failed, and goes on asking', async () => {
    const h = harness();
    h.answers.push({ kind: 'failed' }, { kind: 'failed' }, waits(['a', 'One thing.']));
    h.start(NARROW);

    await vi.advanceTimersByTimeAsync(FAMILY_TV_WAITING_EVERY_MS * 2);

    expect(h.clients[0]!.waiting).toHaveBeenCalledTimes(3);
    expect(h.titles()).toEqual(['One thing.']);
  });

  it('stops: nothing more is asked of anyone', async () => {
    const h = harness();
    const service = h.start(NARROW);
    await vi.advanceTimersByTimeAsync(0);

    service.stop();
    await vi.advanceTimersByTimeAsync(3 * HOUR);

    expect(h.clients[0]!.waiting).toHaveBeenCalledTimes(1);
    expect(h.clients[0]!.renewNow).not.toHaveBeenCalled();
    expect(h.claim).not.toHaveBeenCalled();
  });
});

describe('runWaitingService — the narrow token is renewed while it is still good', () => {
  it('asks for a fresh one at three quarters of its life, and again at three quarters of the next', async () => {
    const h = harness();
    h.start(NARROW);

    await vi.advanceTimersByTimeAsync(NARROW_RENEW_AFTER_MS - 1);
    expect(h.clients[0]!.renewNow).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.clients[0]!.renewNow).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(NARROW_RENEW_AFTER_MS);
    expect(h.clients[0]!.renewNow).toHaveBeenCalledTimes(2);
  });

  it('tries again a minute later when it could not be asked, well inside the quarter that is left', async () => {
    const h = harness();
    h.renewals.push('later', 'later', 'renewed');
    h.start(NARROW);

    await vi.advanceTimersByTimeAsync(NARROW_RENEW_AFTER_MS + RENEW_RETRY_MS * 2);

    expect(h.clients[0]!.renewNow).toHaveBeenCalledTimes(3);
    expect(RENEW_RETRY_MS * 5).toBeLessThan(HOUR - NARROW_RENEW_AFTER_MS);
  });

  it('does not renew the television’s own token ahead of time: that one is good as proof even after it has run out', async () => {
    const h = harness();
    h.start(FULL);

    await vi.advanceTimersByTimeAsync(3 * HOUR);

    expect(h.clients[0]!.renewNow).not.toHaveBeenCalled();
  });

  it('works out three quarters from the token’s own expiry, when this television’s clock can be believed', () => {
    expect(NARROW_RENEW_AFTER_MS).toBe(45 * 60 * 1000);
    expect(renewAfterMs(NARROW, T0)).toBe(45 * 60 * 1000);
    // Handed over late: twenty minutes are left of it.
    expect(renewAfterMs(NARROW, T0 + 40 * 60 * 1000)).toBe(15 * 60 * 1000);
  });

  it('falls back to three quarters of an hour when the clock cannot be: a television’s can be hours out', () => {
    // By this clock the token has already run out, or lasts for most of a day.
    expect(renewAfterMs(NARROW, T0 + 7 * HOUR)).toBe(NARROW_RENEW_AFTER_MS);
    expect(renewAfterMs(NARROW, T0 - 7 * HOUR)).toBe(NARROW_RENEW_AFTER_MS);
  });
});

describe('runWaitingService — when its token is gone', () => {
  it('falls silent, and knocks at the pairing service until the app opens the way again', async () => {
    const h = harness();
    h.answers.push(NOTHING, { kind: 'signedOut' });
    h.start(NARROW);

    await vi.advanceTimersByTimeAsync(FAMILY_TV_WAITING_EVERY_MS);
    expect(h.claim).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(KNOCK_EVERY_MS * 2);
    expect(h.claim).toHaveBeenCalledTimes(3);
    // Nothing is asked of the Wick server with a token it has refused.
    expect(h.clients[0]!.waiting).toHaveBeenCalledTimes(2);
    expect(h.clients[0]!.renewNow).not.toHaveBeenCalled();
  });

  it('takes up again with the token the way gives it, and does not say again what it has said', async () => {
    const h = harness();
    const door = ['ftv-door_look-d1', 'Margaret asks who is at her door.'] as [string, string];
    h.answers.push(waits(door), { kind: 'signedOut' });
    h.start(NARROW);
    await vi.advanceTimersByTimeAsync(FAMILY_TV_WAITING_EVERY_MS);

    const next = { ...NARROW, jwt: 'scoped-2' } as DeviceToken;
    // The first knock, the moment it fell silent, found no way open. The app has since opened one.
    h.claims.push({ token: next });
    h.answers.push(waits(door, ['ftv-reach-r1', 'Margaret would like you to ring her.']));
    await vi.advanceTimersByTimeAsync(KNOCK_EVERY_MS);

    expect(h.clients).toHaveLength(2);
    expect(h.clients[1]!.token).toBe(next);
    expect(h.titles()).toEqual(['Margaret asks who is at her door.', 'Margaret would like you to ring her.']);
    // And it stops knocking once it has been let in.
    const knocks = h.claim.mock.calls.length;
    await vi.advanceTimersByTimeAsync(KNOCK_EVERY_MS * 3);
    expect(h.claim).toHaveBeenCalledTimes(knocks);
  });

  it('does the same when the renewal is what was refused', async () => {
    const h = harness();
    h.renewals.push('signedOut');
    h.start(NARROW);

    await vi.advanceTimersByTimeAsync(NARROW_RENEW_AFTER_MS);

    expect(h.claim).toHaveBeenCalledTimes(1);
    const asked = h.clients[0]!.waiting.mock.calls.length;
    await vi.advanceTimersByTimeAsync(FAMILY_TV_WAITING_EVERY_MS * 3);
    expect(h.clients[0]!.waiting).toHaveBeenCalledTimes(asked);
  });

  it('starts by knocking when it was given no token: the way was not open yet', async () => {
    const h = harness();
    h.claims.push('try_later', { token: NARROW });
    h.start(undefined);

    await vi.advanceTimersByTimeAsync(0);
    expect(h.claim).toHaveBeenCalledTimes(1);
    expect(h.clients).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(KNOCK_EVERY_MS);
    expect(h.clients).toHaveLength(1);
  });

  it('gives up for good when the pairing service says this television is no longer connected', async () => {
    const h = harness();
    h.claims.push('not_paired');
    h.start(undefined);

    await vi.advanceTimersByTimeAsync(KNOCK_EVERY_MS * 5);

    expect(h.claim).toHaveBeenCalledTimes(1);
    expect(h.clients).toHaveLength(0);
  });
});

// Every time the app comes on screen it opens the way at the pairing
// service — and that ends the service's session (edge-device
// pair-refresh.mjs), so a copy of its token stops working. The service's
// own next question is then refused, and it has ninety seconds from the
// opening to be let in again.
describe('runWaitingService — let in again after the app has opened the way', () => {
  /** How long the way stays open (edge-device family-television.mjs SERVICE_WINDOW_MS). */
  const WAY_OPEN_MS = 90_000;

  it('holds a new token within one question of the opening: the first knock is at once, not an interval later', async () => {
    const h = harness();
    h.start(NARROW);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.clients[0]!.waiting).toHaveBeenCalledTimes(1);

    // The app opens the way a moment after that question. The next is refused, and the way is open.
    const next = { ...NARROW, jwt: 'scoped-2' } as DeviceToken;
    h.answers.push({ kind: 'signedOut' });
    h.claims.push({ token: next });
    await vi.advanceTimersByTimeAsync(FAMILY_TV_WAITING_EVERY_MS);

    expect(h.claim).toHaveBeenCalledTimes(1);
    expect(h.clients).toHaveLength(2);
    expect(h.clients[1]!.token).toBe(next);
    expect(h.clients[1]!.waiting).toHaveBeenCalledTimes(1);
    expect(FAMILY_TV_WAITING_EVERY_MS).toBeLessThan(WAY_OPEN_MS / 3);
  });

  it('is still inside the way after one question that failed outright', async () => {
    const h = harness();
    h.start(NARROW);
    await vi.advanceTimersByTimeAsync(0);

    h.answers.push({ kind: 'failed' }, { kind: 'signedOut' });
    h.claims.push({ token: { ...NARROW, jwt: 'scoped-2' } as DeviceToken });
    await vi.advanceTimersByTimeAsync(FAMILY_TV_WAITING_EVERY_MS * 2);

    expect(h.clients).toHaveLength(2);
    expect(FAMILY_TV_WAITING_EVERY_MS * 2 + KNOCK_TIMEOUT_MS).toBeLessThan(WAY_OPEN_MS);
  });

  it('finds a way opened while it was silent within one knock, well inside the ninety seconds', () => {
    expect(KNOCK_EVERY_MS + KNOCK_TIMEOUT_MS).toBeLessThan(WAY_OPEN_MS / 2);
  });

  it('gives a knock that does not answer its time and no more: the next knock is not held up by it', async () => {
    const h = harness();
    const hung = new Promise<Claimed>(() => {});
    h.claim.mockImplementationOnce(() => hung);
    h.claims.push({ token: NARROW });
    h.start(undefined);

    await vi.advanceTimersByTimeAsync(KNOCK_EVERY_MS);
    expect(h.claim).toHaveBeenCalledTimes(2);
    expect(h.clients).toHaveLength(1);
    expect(KNOCK_TIMEOUT_MS).toBeLessThan(KNOCK_EVERY_MS);
  });
});
