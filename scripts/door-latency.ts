/**
 * How long the door takes, measured once against the deployed stack.
 *
 *   npm run latency:door            # five rings
 *   npm run latency:door -- 3       # three
 *
 * What it does, as a visitor trying Wick would, and nothing more:
 *
 *   1. makes a fresh demo guest ("Try the demo", scripts/addon/demo-token.ts);
 *   2. pairs a virtual television to the guest's demo home the way the
 *      browser television does (apps/ops-console/device.js): asks the
 *      pairing service for a code, the guest enters it (`POST
 *      /api/televisions`), the television collects its token, opens the edge
 *      WebSocket and asks for what it is owed (`reconcile`);
 *   3. presses Allow on the Circle card on that television, a second after it
 *      came, so the guest is allowed (INV-9) and may ring;
 *   4. rings the stand-in doorbell (`POST /api/demo/doorbell`) R times,
 *      waiting out its 20-second cooldown between rings, and times, per ring,
 *      from the request being sent to: the door card on the socket, the
 *      picture patched onto it, and the sentence patched onto it;
 *   5. prints the median and max of each, then disconnects the television
 *      and deletes the guest and its demo home.
 *
 * What it measures is the stand-in path: Wick server → the Door agent Lambda,
 * invoked directly. A real Ring press reaches the agent another way — Ring →
 * API Gateway → the webhook Lambda → EventBridge — and that hop is not in
 * these numbers (Ring's Playground sends no webhook, FRICTION.md FL-027). All
 * times are on this machine's monotonic clock, so they include its network
 * to us-east-1 both ways.
 *
 * It never prints a token, a device id or a code.
 *
 * Another stack: WICK_SERVER_URL, and WICK_VIRTUAL_TV_URL (whose device.js
 * names the pairing service and WebSocket), or WICK_PAIRING_URL and
 * WICK_WEBSOCKET_URL directly.
 */
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { demoSession } from './addon/demo-token.js';
import { LIVE } from './smoke/checks.js';
import { DOOR_STEPS, RingTimer, circleCardId, doorSignals, edgeUrlsIn, seconds, summarise, waitBeforeNextRing, type DoorStep } from './door-latency/measure.js';

/** services/mcp-server accounts/demoDoorbell.ts. */
const DEMO_DOOR_COOLDOWN_MS = 20_000;
const DEMO_DOOR_RINGS_PER_HOUR = 10;
/** A somebody she does not know presses the bell: a card, a picture and the vision model's sentence. */
const VISITOR = process.env.WICK_DOOR_VISITOR || 'stranger';
/** How long one ring's steps are waited for. The sentence is cancelled at 2.5 s after the picture; this is generous. */
const RING_WAIT_MS = 30_000;
const TIMEOUT_MS = 30_000;

const trim = (url: string) => url.replace(/\/+$/, '');
const now = () => performance.now();
const fetchT: typeof fetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
const urlSafe = (bytes: number) => randomBytes(bytes).toString('base64url');

async function edgeUrls(virtualTv: string): Promise<{ pairing: string; websocket: string }> {
  let pairing = process.env.WICK_PAIRING_URL;
  let websocket = process.env.WICK_WEBSOCKET_URL;
  if (!pairing || !websocket) {
    const res = await fetchT(`${virtualTv}/device.js`);
    if (!res.ok) throw new Error(`${virtualTv}/device.js answered ${res.status}`);
    const found = edgeUrlsIn(await res.text());
    pairing ||= found.pairing;
    websocket ||= found.websocket;
  }
  if (!pairing || !websocket) throw new Error('the pairing service and WebSocket could not be found; set WICK_PAIRING_URL and WICK_WEBSOCKET_URL');
  return { pairing: trim(pairing), websocket };
}

/** The resident's television, on the edge WebSocket: every message is timed as it arrives. */
class Television {
  private readonly ws: WebSocket;
  private readonly listeners = new Set<(msg: unknown, at: number) => void>();
  readonly cardsSeen = new Set<string>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (event) => {
      const at = now();
      let msg: unknown;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      for (const signal of doorSignals(msg)) if (signal.step === 'card') this.cardsSeen.add(signal.cardId);
      for (const listener of this.listeners) listener(msg, at);
    });
  }

  static open(url: string, jwt: string): Promise<Television> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${url}?token=${encodeURIComponent(jwt)}`);
      const tv = new Television(ws);
      ws.addEventListener('open', () => resolve(tv), { once: true });
      ws.addEventListener('error', () => reject(new Error('the edge WebSocket would not open')), { once: true });
    });
  }

  send(event: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(event));
  }

  listen(listener: (msg: unknown, at: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The first message `pick` says yes to, within `ms`. */
  waitFor<T>(pick: (msg: unknown) => T | undefined, ms: number): Promise<T | undefined> {
    return new Promise((resolve) => {
      const stop = this.listen((msg) => {
        const found = pick(msg);
        if (found !== undefined) {
          clearTimeout(timer);
          stop();
          resolve(found);
        }
      });
      const timer = setTimeout(() => {
        stop();
        resolve(undefined);
      }, ms);
    });
  }

  close(): void {
    this.ws.close();
  }
}

async function main(): Promise<void> {
  const rings = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 5);
  if (!(rings >= 1 && rings <= DEMO_DOOR_RINGS_PER_HOUR)) throw new Error(`rings must be 1 to ${DEMO_DOOR_RINGS_PER_HOUR} (the stand-in doorbell's hourly limit)`);
  const server = trim(process.env.WICK_SERVER_URL || LIVE.server);
  const virtualTv = trim(process.env.WICK_VIRTUAL_TV_URL || LIVE.virtualTv);
  const edge = await edgeUrls(virtualTv);
  console.log(`door latency against ${server}, ${rings} ring${rings === 1 ? '' : 's'} of the stand-in doorbell (visitor: ${VISITOR})`);
  console.log(`  started ${new Date().toISOString()}`);

  const session = await demoSession(server, fetchT, 'the Wick door latency measurement');
  console.log('  · a fresh demo guest is signed in');
  const api = (path: string, init: RequestInit = {}) =>
    fetchT(`${server}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}), authorization: `Bearer ${session.accessToken}` } });

  let tv: Television | undefined;
  try {
    const me = (await (await api('/api/me')).json()) as { user: { userId: string }; household: { simulated?: boolean } };
    if (me.household.simulated !== true) throw new Error('the guest’s home is not a demo home; nothing is rung');
    const userId = me.user.userId;

    // 2 — a television, paired as the browser television pairs (device.js pairAndConnect).
    const deviceId = `latency-${randomBytes(12).toString('hex')}`;
    const started = await fetchT(`${edge.pairing}/pair/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId, proof: urlSafe(32) }),
    });
    if (!started.ok) throw new Error(`pair/start answered ${started.status}`);
    const { code } = (await started.json()) as { code: string };
    const claimed = await api('/api/televisions', { method: 'POST', body: JSON.stringify({ code }) });
    if (!claimed.ok) throw new Error(`POST /api/televisions answered ${claimed.status}: ${(await claimed.text()).slice(0, 160)}`);
    let jwt: string | undefined;
    for (let i = 0; i < 15 && !jwt; i += 1) {
      const status = await fetchT(`${edge.pairing}/pair/status?code=${encodeURIComponent(code)}`);
      const body = (await status.json()) as { status?: string; token?: { jwt?: string } };
      if (body.status === 'bound') jwt = body.token?.jwt;
      else await sleep(1_000);
    }
    if (!jwt) throw new Error('the television was never handed its token');
    tv = await Television.open(edge.websocket, jwt);
    const circleCard = tv.waitFor((msg) => circleCardId(msg, userId), 15_000);
    tv.send({ t: 'reconcile' });
    console.log('  · a virtual television is paired and on the edge WebSocket');

    // 3 — her press on Allow, a second after the card came (tv-vega press/settle.ts).
    const cardId = await circleCard;
    if (!cardId) throw new Error('no Circle card came for the guest');
    tv.send({ t: 'card_shown', cardId, at: Date.now() });
    await sleep(1_100);
    tv.send({ t: 'card_action', cardId, action: 'allow', at: Date.now() });
    let allowed = false;
    for (let i = 0; i < 10 && !allowed; i += 1) {
      await sleep(1_000);
      const mine = (await (await api('/api/me')).json()) as { membership?: { status?: string } };
      allowed = mine.membership?.status === 'allowed';
    }
    if (!allowed) throw new Error('the press on Allow did not allow the guest');
    console.log('  · Allow pressed on the television: the guest is allowed');

    // 4 — the rings.
    const timers: RingTimer[] = [];
    const answered: number[] = [];
    let lastSentAt: number | undefined;
    for (let r = 1; r <= rings; r += 1) {
      const wait = waitBeforeNextRing(lastSentAt, now(), DEMO_DOOR_COOLDOWN_MS);
      if (wait > 0) await sleep(wait);
      const sentAt = now();
      const ring = new RingTimer(sentAt, tv.cardsSeen);
      const done = new Promise<void>((resolve) => {
        const stop = tv!.listen((msg, at) => {
          for (const signal of doorSignals(msg)) ring.note(signal, at);
          if (ring.complete) {
            stop();
            resolve();
          }
        });
        setTimeout(() => {
          stop();
          resolve();
        }, RING_WAIT_MS);
      });
      lastSentAt = sentAt;
      const res = await api('/api/demo/doorbell', { method: 'POST', headers: { 'idempotency-key': urlSafe(18) }, body: JSON.stringify({ visitor: VISITOR }) });
      answered.push(now() - sentAt);
      if (!res.ok) throw new Error(`ring ${r}: POST /api/demo/doorbell answered ${res.status}: ${(await res.text()).slice(0, 160)}`);
      await done;
      if (ring.cardId) tv.send({ t: 'card_shown', cardId: ring.cardId, at: Date.now() });
      timers.push(ring);
      console.log(`  ring ${r}: answered ${seconds(answered[answered.length - 1])} · card ${seconds(ring.at.card)} · picture ${seconds(ring.at.picture)} · sentence ${seconds(ring.at.description)}`);
    }

    // 5 — what was measured.
    const label: Record<DoorStep, string> = { card: 'door card on the socket', picture: 'picture patched on', description: 'sentence patched on' };
    console.log(`\n  from the ring's request being sent (${rings} rings, ${new Date().toISOString().slice(0, 10)}):`);
    const http = summarise(answered);
    console.log(`    ${'server answered the ring'.padEnd(26)} median ${seconds(http.median)}, max ${seconds(http.max)} (${http.n}/${rings})`);
    for (const step of DOOR_STEPS) {
      const s = summarise(timers.flatMap((t) => (t.at[step] === undefined ? [] : [t.at[step]!])));
      console.log(`    ${label[step].padEnd(26)} median ${seconds(s.median)}, max ${seconds(s.max)} (${s.n}/${rings})`);
    }
    console.log('  the stand-in path: Wick server → Door agent Lambda, invoked directly. Ring → API Gateway → webhook → EventBridge is not in these numbers.');
  } finally {
    // The television is disconnected and the guest, with its demo home, deleted — whatever happened before.
    try {
      const circle = (await (await api('/api/circle')).json()) as { televisions?: { ref: string }[] };
      for (const { ref } of circle.televisions ?? []) {
        const res = await api(`/api/televisions/${encodeURIComponent(ref)}`, { method: 'DELETE' });
        console.log(`  · television disconnected (${res.status})`);
      }
    } catch (err) {
      console.log(`  ✗ the television could not be disconnected: ${err instanceof Error ? err.message : String(err)}`);
    }
    tv?.close();
    const deleted = await api('/api/account', { method: 'DELETE', body: JSON.stringify({ closeHomes: true }) });
    console.log(deleted.status === 200 ? '  · the guest and its demo home are deleted' : `  ✗ the guest could not be deleted (${deleted.status})`);
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(`door latency: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
