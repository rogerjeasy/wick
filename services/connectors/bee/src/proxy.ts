/**
 * Bee local proxy client — 127.0.0.1:8787 (or ~/.bee/proxy.sock).
 * Only /v1/* forwards. Default idle timeout 120s.
 *
 *   GET  /v1/me · /v1/changes · /v1/facts · /v1/todos · /v1/daily · /v1/conversations
 *   POST /v1/search/conversations[/neural]
 *   GET  /v1/stream   (SSE — see sse.ts)
 *
 * The proxy runs on a small always-on machine in the household (§7.2) —
 * loopback-only, so there is no bearer token here the way there is for
 * ring/client.ts's Ring calls. `fetchImpl` is injected the same way, so
 * tests never touch a network.
 */
import type {
  BeeChangesResponse,
  BeeConversationRaw,
  BeeDailyRaw,
  BeeFactRaw,
  BeeMe,
  BeeSearchResult,
  BeeTodoRaw,
} from './types.js';

export const BEE_PROXY_BASE = 'http://127.0.0.1:8787';

export class BeeProxyError extends Error {
  readonly status: number;

  constructor(status: number, path: string) {
    super(`bee_proxy_${status}_${path}`);
    this.name = 'BeeProxyError';
    this.status = status;
  }
}

export interface BeeProxyClientOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

export class BeeProxyClient {
  readonly baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: BeeProxyClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? BEE_PROXY_BASE;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  get fetchImpl(): typeof fetch {
    return this.#fetch;
  }

  async get<T>(path: string): Promise<T> {
    const res = await this.#fetch(`${this.baseUrl}${path}`);
    if (!res.ok) throw new BeeProxyError(res.status, path);
    return res.json() as Promise<T>;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.#fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new BeeProxyError(res.status, path);
    return res.json() as Promise<T>;
  }
}

export function getMe(client: BeeProxyClient): Promise<BeeMe> {
  return client.get('/v1/me');
}

export function getChanges(client: BeeProxyClient, cursor?: string): Promise<BeeChangesResponse> {
  return client.get(`/v1/changes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
}

export function listFacts(client: BeeProxyClient): Promise<readonly BeeFactRaw[]> {
  return client.get('/v1/facts');
}

export function listTodos(client: BeeProxyClient): Promise<readonly BeeTodoRaw[]> {
  return client.get('/v1/todos');
}

export function getDaily(client: BeeProxyClient, id?: string): Promise<BeeDailyRaw | readonly BeeDailyRaw[]> {
  return client.get(id ? `/v1/daily/${encodeURIComponent(id)}` : '/v1/daily');
}

/**
 * Raw conversation metadata/utterances. Callers in this package may use
 * `id`/`startedAt`/`endedAt` freely; `utterances` must never reach
 * normalise.ts or any FactClass — INV-4. See types.ts's header.
 */
export function getConversations(
  client: BeeProxyClient,
  id?: string,
): Promise<BeeConversationRaw | readonly BeeConversationRaw[]> {
  return client.get(id ? `/v1/conversations/${encodeURIComponent(id)}` : '/v1/conversations');
}

export function searchConversations(client: BeeProxyClient, query: string): Promise<readonly BeeSearchResult[]> {
  return client.post('/v1/search/conversations', { query });
}

export function searchConversationsNeural(client: BeeProxyClient, query: string): Promise<readonly BeeSearchResult[]> {
  return client.post('/v1/search/conversations/neural', { query });
}
