/**
 * How long does the Wick server take to answer a tool call? (issue #47)
 *
 *   npm run latency:mcp                          100 calls to the deployed server
 *   npm run latency:mcp -- -n 200 --every 1000   200 calls, one a second
 *   npm run latency:mcp -- --tool list_regular_visitors --url http://127.0.0.1:3300 --dev-allow
 *
 * Signs in a fresh demo guest the way the family app's "Try the demo" button
 * does (scripts/addon/demo-token.ts), makes N `tools/call` requests over ONE
 * kept-alive connection — so the figures are the server's and the network's,
 * not a TLS handshake per call — prints p50/p95/p99 overall and, when the
 * server sends `Server-Timing` (services/mcp-server/src/timing.ts), per
 * phase, and then deletes the guest and its demo home (DELETE /api/account,
 * as `npm run smoke:live` does), whatever happened before.
 *
 * Defaults to a tool that only reads and is not a look-in (it notes nothing
 * on the resident's home screen). The first call is reported apart: it opens
 * the connection. Needs no AWS credentials, and never prints a token.
 *
 * A guest's resident has not pressed Allow on a television, so on the
 * deployed server every call is answered by the access gate's refusal
 * (INV-9): the token check, the server, the gate — everything but the
 * tool's own reads. `--dev-allow` presses Allow first through the local dev
 * server's stand-in (services/mcp-server/src/__tests__/devServer.ts
 * `/dev/allow`), so the tool itself runs; it means nothing anywhere else.
 *
 * What it does not separate: the network between here and the server. Run it
 * from inside the server's region (CloudShell in us-east-1) for the server's
 * own figure; from elsewhere, `total` in Server-Timing is the server's part.
 */
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { demoSession } from './addon/demo-token.js';
import { SPEC_VERSION } from './addon/preflight.js';
import { LIVE } from './smoke/checks.js';
import { parseServerTiming, phaseSamples, row, summarise } from './latency/stats.js';

const LIMIT_MS = 500;

interface Options {
  readonly url: string;
  readonly n: number;
  readonly everyMs: number;
  readonly tool: string;
  readonly devAllow: boolean;
}

function options(argv: readonly string[]): Options {
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };
  const n = Number(value('-n') ?? value('--calls') ?? 100);
  const everyMs = Number(value('--every') ?? 0);
  if (!Number.isInteger(n) || n < 1) throw new Error('-n must be a whole number of calls, 1 or more');
  if (!Number.isFinite(everyMs) || everyMs < 0) throw new Error('--every must be a number of milliseconds');
  return {
    url: (value('--url') ?? process.env.WICK_SERVER_URL ?? LIVE.server).replace(/\/+$/, ''),
    n,
    everyMs,
    tool: value('--tool') ?? 'get_resident_shared_view',
    devAllow: argv.includes('--dev-allow'),
  };
}

interface Answer {
  readonly status: number;
  readonly ms: number;
  readonly serverTiming: string | undefined;
  readonly body: string;
  /** This request opened a connection (and so paid for its TCP and TLS set-up), rather than reusing one. */
  readonly newConnection: boolean;
  /** The answer said the connection closes after it. */
  readonly closes: boolean;
}

/** POSTs over one kept-alive connection, and counts the connections it took. */
function keptAlive(endpoint: URL) {
  const https = endpoint.protocol === 'https:';
  const agent = https ? new HttpsAgent({ keepAlive: true, maxSockets: 1 }) : new HttpAgent({ keepAlive: true, maxSockets: 1 });
  const sockets = new Set<Socket>();
  /** Per connection: when it opened, when it closed, how many requests it carried. */
  const lives = new Map<Socket, { opened: number; closed?: number; requests: number }>();
  const post = (body: string, token: string): Promise<Answer> =>
    new Promise((resolve, reject) => {
      const started = performance.now();
      let newConnection = false;
      const req = (https ? httpsRequest : httpRequest)(endpoint, {
        method: 'POST',
        agent,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
          'content-length': Buffer.byteLength(body),
        },
      }, (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const header = res.headers['server-timing'];
          resolve({
            status: res.statusCode ?? 0,
            ms: performance.now() - started,
            serverTiming: Array.isArray(header) ? header.join(', ') : header,
            body: Buffer.concat(chunks).toString('utf8'),
            newConnection,
            closes: String(res.headers.connection ?? '').toLowerCase() === 'close',
          });
        });
        res.on('error', reject);
      });
      req.on('socket', (socket: Socket) => {
        newConnection = !sockets.has(socket);
        sockets.add(socket);
        if (newConnection) {
          const life = { opened: performance.now(), requests: 0 } as { opened: number; closed?: number; requests: number };
          lives.set(socket, life);
          socket.once('close', () => (life.closed = performance.now()));
        }
        lives.get(socket)!.requests += 1;
      });
      req.on('error', reject);
      req.end(body);
    });
  /** Each connection the server closed: how long it lived, and how many requests it carried. */
  const closedLives = () => [...lives.values()].filter((l) => l.closed !== undefined).map((l) => ({ seconds: (l.closed! - l.opened) / 1000, requests: l.requests }));
  return { post, connections: () => sockets.size, closedLives, close: () => agent.destroy() };
}

/** The JSON-RPC result of a JSON or one-event SSE answer. */
function resultOf(answer: Answer): { isError?: boolean; content?: { text?: string }[] } | undefined {
  const raw = answer.body.trim().startsWith('{') ? answer.body : answer.body.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).at(-1);
  try {
    return (JSON.parse(raw ?? '') as { result?: { isError?: boolean; content?: { text?: string }[] } }).result;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const opts = options(process.argv.slice(2));
  const endpoint = new URL(`${opts.url}/mcp`);
  console.log(`${opts.n} × tools/call ${opts.tool} → ${endpoint.toString()}${opts.everyMs ? `, one every ${opts.everyMs} ms` : ', back to back'}`);

  const session = await demoSession(opts.url, fetch, 'the Wick latency check');
  console.log('signed in as a fresh demo guest');
  if (opts.devAllow) {
    const allowed = await fetch(`${opts.url}/dev/allow`);
    console.log(allowed.ok ? 'the dev server pressed Allow' : `/dev/allow answered ${allowed.status}`);
  }
  const conn = keptAlive(endpoint);
  try {
    let id = 0;
    const rpc = (method: string, params: object) => conn.post(JSON.stringify({ jsonrpc: '2.0', id: (id += 1), method, params }), session.accessToken);

    // Not counted: it opens the connection (and the TLS session) the calls then share.
    const hello = await rpc('initialize', { protocolVersion: SPEC_VERSION, capabilities: {}, clientInfo: { name: 'wick-latency', version: '1.0.0' } });
    if (hello.status !== 200) throw new Error(`initialize answered ${hello.status}`);
    console.log(`initialize (opens the connection, not counted): ${hello.ms.toFixed(0)} ms`);

    const totals: number[] = [];
    const reused: number[] = [];
    const opened: number[] = [];
    let closes = 0;
    const timings: Record<string, number>[] = [];
    let refused = 0;
    let firstSaid: string | undefined;
    for (let i = 0; i < opts.n; i += 1) {
      const answer = await rpc('tools/call', { name: opts.tool, arguments: {} });
      if (answer.status !== 200) throw new Error(`call ${i + 1} answered ${answer.status}`);
      const result = resultOf(answer);
      if (!result || result.isError) refused += 1;
      firstSaid ??= result?.content?.[0]?.text?.slice(0, 80);
      totals.push(answer.ms);
      (answer.newConnection ? opened : reused).push(answer.ms);
      if (answer.closes) closes += 1;
      const timing = parseServerTiming(answer.serverTiming);
      if (Object.keys(timing).length > 0) timings.push(timing);
      if (opts.everyMs) await sleep(opts.everyMs);
    }

    console.log(`\nfirst answer began: ${JSON.stringify(firstSaid ?? '')}${refused ? ` (${refused} answered with an error)` : ''}`);
    console.log(`connections opened: ${conn.connections()} (${opened.length} by a counted call; ${closes} answer${closes === 1 ? '' : 's'} said the connection closes)`);
    console.log('\nround trip, measured here (ms)');
    console.log(`  ${row('tools/call', summarise(totals, LIMIT_MS)!, LIMIT_MS)}`);
    const lived = conn.closedLives();
    if (lived.length > 0) {
      const secs = lived.map((l) => l.seconds.toFixed(1)).join(', ');
      console.log(`  connections the server closed lived ${secs} s, carrying ${lived.map((l) => l.requests).join(', ')} requests`);
    }
    const reusedSummary = summarise(reused, LIMIT_MS);
    const openedSummary = summarise(opened, LIMIT_MS);
    if (reusedSummary) console.log(`  ${row('  reused', reusedSummary, LIMIT_MS)}   on a connection already open`);
    if (openedSummary) console.log(`  ${row('  opened', openedSummary, LIMIT_MS)}   on a new connection (TCP + TLS first)`);
    if (timings.length === 0) {
      console.log('\nthe server sent no Server-Timing header: no phases to show (a server from before issue #47)');
    } else {
      console.log(`\non the server, from Server-Timing (ms; ${timings.length} of ${opts.n} answers carried it)`);
      for (const [phase, samples] of Object.entries(phaseSamples(timings))) console.log(`  ${row(phase, summarise(samples, LIMIT_MS)!, LIMIT_MS)}`);
    }
  } finally {
    conn.close();
    const res = await fetch(`${opts.url}/api/account`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({ closeHomes: true }),
    });
    console.log(res.status === 200 ? '\nthe guest and its demo home are deleted' : `\nthe guest could not be deleted: DELETE /api/account answered ${res.status}`);
    if (res.status !== 200) process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
