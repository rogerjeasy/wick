/**
 * The authenticated Ring Partner API client.
 *
 * INV-1: server-side only. Nothing in apps/tv-vega may import this — the
 * television holds a device-bound JWT and nothing that speaks to Ring.
 *
 * The token is injected rather than read here, so the same client works behind
 * Secrets Manager in Lambda and behind an env var in a local demo, and so tests
 * never need a credential.
 */
export const RING_API_BASE = 'https://api.amazonvision.com';

export type TokenProvider = () => Promise<string> | string;

/**
 * How long one call to Ring may take, response and body together, before it
 * is given up. Ring answers a device list in well under a second and a
 * frame's presigned download in about two (FL-005). Without a bound, a Ring
 * that accepts the connection and never answers holds the calling Lambda
 * until its own timeout, and the door Lambda's is 30 seconds: the picture
 * and the sentence are lost with it, and the failure says only "timed out".
 * Five seconds is past every call measured and well inside every Lambda that
 * makes one (agent.tf, card-action.tf, live.tf).
 */
export const RING_REQUEST_TIMEOUT_MS = 5_000;

/**
 * `fetchImpl` with a deadline on every call. A caller's own signal still
 * counts: whichever ends first ends the call. An aborted call rejects, as
 * fetch does, with the signal's reason (a `TimeoutError` for the deadline).
 */
export function withDeadline(fetchImpl: typeof fetch, timeoutMs: number): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    return fetchImpl(input, { ...init, signal });
  }) as typeof fetch;
}

export class RingApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly detail: string | null;

  constructor(status: number, code: string | null, detail: string | null) {
    super(`ring_api_${status}${code ? `_${code}` : ''}`);
    this.name = 'RingApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

async function toError(res: Response): Promise<RingApiError> {
  let code: string | null = null;
  let detail: string | null = null;
  try {
    const body = (await res.json()) as { errors?: { code?: string; detail?: string }[] };
    const first = body.errors?.[0];
    code = first?.code ?? null;
    detail = first?.detail ?? null;
  } catch {
    // A non-JSON error body is itself only worth its status.
  }
  return new RingApiError(res.status, code, detail);
}

export interface RingClientOptions {
  readonly getToken: TokenProvider;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /** Every call's deadline (RING_REQUEST_TIMEOUT_MS unless given). */
  readonly timeoutMs?: number;
}

export class RingClient {
  readonly #getToken: TokenProvider;
  readonly #base: string;
  readonly #fetch: typeof fetch;

  constructor(options: RingClientOptions) {
    this.#getToken = options.getToken;
    this.#base = options.baseUrl ?? RING_API_BASE;
    // The presigned download goes through this same function (fetchImpl,
    // below), so it is held to the same deadline as every API call.
    this.#fetch = withDeadline(options.fetchImpl ?? fetch, options.timeoutMs ?? RING_REQUEST_TIMEOUT_MS);
  }

  /**
   * The HTTP implementation this client was built with.
   *
   * Exposed so that presigned-URL fetches — which carry no Authorization
   * header and so do not belong on a `get`/`post` method — still go through
   * one configured path rather than silently reaching for global fetch.
   */
  get fetchImpl(): typeof fetch {
    return this.#fetch;
  }

  /** The API origin this client talks to — the only host a bearer token may be sent to. */
  get baseUrl(): string {
    return this.#base;
  }

  async #headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.#getToken()}`, ...extra };
  }

  /** A JSON:API GET. Returns the raw document; parsing lives in jsonapi.ts. */
  async get(path: string): Promise<unknown> {
    const res = await this.#fetch(`${this.#base}${path}`, {
      headers: await this.#headers(),
    });
    if (!res.ok) throw await toError(res);
    return res.json();
  }

  async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.#fetch(`${this.#base}${path}`, {
      method: 'POST',
      headers: await this.#headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await toError(res);
    return res.json();
  }

  /**
   * A POST of a non-JSON body (WHEP's application/sdp) whose answer is text,
   * plus the Location header the session is managed by.
   */
  async postText(path: string, body: string, contentType: string): Promise<{ text: string; location: string | null }> {
    const res = await this.#fetch(`${this.#base}${path}`, {
      method: 'POST',
      headers: await this.#headers({ 'Content-Type': contentType }),
      body,
    });
    if (!res.ok) throw await toError(res);
    return { text: await res.text(), location: res.headers.get('location') };
  }

  /** DELETE an absolute URL Ring handed back (a WHEP session's Location). Same origin only. */
  async deleteUrl(url: string): Promise<void> {
    if (new URL(url).origin !== new URL(this.#base).origin) throw new Error('foreign_session_url');
    const res = await this.#fetch(url, { method: 'DELETE', headers: await this.#headers() });
    if (!res.ok) throw await toError(res);
  }

  /**
   * A POST whose success is a 303 to somewhere else.
   *
   * Redirects are NOT followed: the Location is a presigned URL, and handing
   * that to the caller costs one round trip instead of also pulling the bytes
   * through this process. Media is large and the caller may not want it here.
   */
  async postForRedirect(path: string, body: unknown): Promise<string> {
    const res = await this.#fetch(`${this.#base}${path}`, {
      method: 'POST',
      headers: await this.#headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      redirect: 'manual',
    });

    const location = res.headers.get('location');
    if (location) return location;

    // A 2xx with no Location means the contract changed under us; a 4xx is the
    // ordinary failure. Both are errors, and they are different errors.
    throw res.ok
      ? new RingApiError(res.status, 'NO_LOCATION', 'expected a redirect to the media URL')
      : await toError(res);
  }
}
