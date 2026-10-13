/**
 * The home looks and the seat's asking, side by side, over the real client.
 *
 * In the browser television one queue carried every request, and a
 * 12-second /tv/home held the next look at the seat back by 13.7 seconds —
 * so her pause went unfollowed. Here the two are separate: the home looker
 * (looker.ts) has at most one look out, the seat's asking (repeat.ts) has
 * at most one of its own, and neither waits for the other.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAMILY_TV_LOOK_EVERY_MS, FAMILY_TV_SEAT_EVERY_MS, type FamilyTvHome, type FamilyTvSeat } from '@wick/contracts';
import { createFamilyClient, type SeatAnswer } from '../familyClient.js';
import { FamilyLooker, type LookState } from '../looker.js';
import { repeat } from '../repeat.js';

const HOME: FamilyTvHome = { residentName: 'Margaret', memberName: 'Sarah', cards: [] };
const SEAT: FamilyTvSeat = {
  cardId: 'ftv-watch-s1',
  film: 'Big Buck Bunny',
  state: 'watching',
  line: 'You are watching Big Buck Bunny with Margaret.',
  stream: { url: 'https://films.example/bbb/index.m3u8', durationMs: 596_000, attribution: '© Blender Foundation' },
  playback: { state: 'PLAYING', positionMs: 61_000, ageMs: 200 },
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A Wick server whose /tv/home takes `homeMs` to answer (or never does), and whose /tv/seat answers at once. */
function serverWith(homeMs: number | 'never') {
  const asked: Array<{ path: string; at: number }> = [];
  const started = Date.now();
  const fetchImpl = ((url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    asked.push({ path, at: Date.now() - started });
    if (path === '/tv/seat') return Promise.resolve(new Response(JSON.stringify({ seat: SEAT }), { status: 200 }));
    return new Promise<Response>((resolve, reject) => {
      // As a real request does: told to stop, it ends.
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      if (homeMs !== 'never') setTimeout(() => resolve(new Response(JSON.stringify(HOME), { status: 200 })), homeMs);
    });
  }) as unknown as typeof fetch;
  const client = createFamilyClient({
    serverUrl: 'https://wick.example',
    jwt: 'j',
    renew: async () => {
      throw new Error('no renewal expected');
    },
    fetchImpl,
  });
  const at = (path: string): number[] => asked.filter((a) => a.path === path).map((a) => a.at);
  return { client, asked, at };
}

/** The family screen while sat at a film: the home looker and the seat's asking both running, as FamilyApp and FamilySeat run them. */
function seated(client: ReturnType<typeof createFamilyClient>) {
  const looks: LookState[] = [];
  const seats: SeatAnswer[] = [];
  const looker = new FamilyLooker({ look: () => client.home(), onChange: (state) => void looks.push(state) });
  looker.start();
  const asking = repeat({ ask: () => client.seat(), onAnswer: (answer) => void seats.push(answer), everyMs: FAMILY_TV_SEAT_EVERY_MS });
  return { looks, seats, stop: () => (looker.stop(), asking.stop()) };
}

describe('the seat keeps its rhythm whatever the home is doing', () => {
  it('goes on asking where her film is every two seconds while a look at the home takes twelve', async () => {
    const server = serverWith(12_000);
    const screen = seated(server.client);

    await vi.advanceTimersByTimeAsync(12_000);

    expect(server.at('/tv/seat')).toEqual([0, 2_000, 4_000, 6_000, 8_000, 10_000, 12_000]);
    expect(screen.seats).toHaveLength(7);
    expect(screen.seats.every((answer) => answer.kind === 'seat')).toBe(true);
    screen.stop();
  });

  it('goes on while a look at the home never answers at all', async () => {
    const server = serverWith('never');
    const screen = seated(server.client);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(server.at('/tv/seat')).toHaveLength(31);
    expect(Math.max(...server.at('/tv/seat').map((at, i, all) => (i === 0 ? 0 : at - all[i - 1]!)))).toBe(FAMILY_TV_SEAT_EVERY_MS);
    screen.stop();
  });

  it('has at most one look at the home out, and at most one at the seat, each on its own', async () => {
    const server = serverWith('never');
    const out = { home: 0, seat: 0, most: { home: 0, seat: 0 } };
    const client = {
      home: async () => {
        out.home += 1;
        out.most.home = Math.max(out.most.home, out.home);
        try {
          return await server.client.home();
        } finally {
          out.home -= 1;
        }
      },
      seat: async () => {
        out.seat += 1;
        out.most.seat = Math.max(out.most.seat, out.seat);
        try {
          return await server.client.seat();
        } finally {
          out.seat -= 1;
        }
      },
    };
    const screen = seated(client as unknown as ReturnType<typeof createFamilyClient>);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(out.most).toEqual({ home: 1, seat: 1 });
    screen.stop();
  });
});

describe('a look at the home that never answers', () => {
  it('is given up after six seconds, so the next look is asked on time — not three minutes later', async () => {
    const server = serverWith('never');
    const screen = seated(server.client);

    await vi.advanceTimersByTimeAsync(3 * FAMILY_TV_LOOK_EVERY_MS);

    expect(server.at('/tv/home')).toEqual([0, 8_000, 16_000, 24_000]);
    screen.stop();
  });

  it('is only a failed look: after three, the screen says Wick cannot reach the home, and goes on looking', async () => {
    const server = serverWith('never');
    const screen = seated(server.client);

    await vi.advanceTimersByTimeAsync(2 * FAMILY_TV_LOOK_EVERY_MS + 5_999);
    expect(screen.looks).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(screen.looks).toEqual([{ kind: 'starting', unreachable: true }]);

    await vi.advanceTimersByTimeAsync(FAMILY_TV_LOOK_EVERY_MS);
    expect(server.at('/tv/home')).toHaveLength(4);
    screen.stop();
  });
});
