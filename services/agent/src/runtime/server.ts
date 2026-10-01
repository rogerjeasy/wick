/**
 * The Bedrock AgentCore Runtime service contract, on node:http.
 *
 *   GET  /ping         { status: 'Healthy' | 'HealthyBusy', time_of_last_update }
 *   POST /invocations  JSON payload { kind, ... } → the graph for that kind
 *
 * AgentCore runs this container in one isolated microVM per runtime session,
 * and Wick's session id is the household (invoke.ts) — so every graph a
 * household's door, chime and live view run lands in that household's own
 * microVM. `busy()` reports background work (a live bridge streaming
 * after its invocation returned) as HealthyBusy, which is AgentCore's signal
 * not to reclaim the session while it runs.
 *
 * Errors are logged with the kind only and answered as a bare 500: a handler
 * message can carry anything (a Ring error detail, a card's text), and the
 * caller's correct response to every failure is the same.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';

export const SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id';

export interface InvocationContext {
  readonly sessionId: string;
}

export type RuntimeHandler = (payload: Record<string, unknown>, ctx: InvocationContext) => Promise<unknown>;
export type RuntimeHandlers = Readonly<Record<string, RuntimeHandler>>;

export interface RuntimeServerOptions {
  readonly handlers: RuntimeHandlers;
  readonly busy: () => boolean;
  readonly log?: (line: Record<string, unknown>) => void;
}

/** The runtime's own payloads are small; anything bigger is not ours. */
const MAX_BODY_BYTES = 1_000_000;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('body_too_large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createRuntimeServer(options: RuntimeServerOptions): Server {
  const log = options.log ?? ((line) => console.log(JSON.stringify(line)));

  return createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && req.url === '/ping') {
      return reply(200, {
        status: options.busy() ? 'HealthyBusy' : 'Healthy',
        time_of_last_update: Math.floor(Date.now() / 1000),
      });
    }

    if (req.method !== 'POST' || req.url !== '/invocations') return reply(404, { error: 'not_found' });

    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(await readBody(req));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not_an_object');
      payload = parsed as Record<string, unknown>;
    } catch {
      return reply(400, { error: 'bad_payload' });
    }

    const kind = typeof payload.kind === 'string' ? payload.kind : '';
    const handler = Object.hasOwn(options.handlers, kind) ? options.handlers[kind] : undefined;
    if (!handler) return reply(400, { error: 'unknown_kind' });

    const sessionId = String(req.headers[SESSION_HEADER] ?? '');
    const started = Date.now();
    try {
      const result = await handler(payload, { sessionId });
      log({ level: 'info', msg: 'invocation', kind, ms: Date.now() - started });
      return reply(200, result ?? {});
    } catch (err) {
      log({ level: 'error', msg: 'invocation_failed', kind, ms: Date.now() - started, err: err instanceof Error ? err.name : 'unknown' });
      return reply(500, { error: 'internal' });
    }
  });
}
