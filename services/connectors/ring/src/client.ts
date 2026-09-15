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
}

export class RingClient {
  readonly #getToken: TokenProvider;
  readonly #base: string;
  readonly #fetch: typeof fetch;

  constructor(options: RingClientOptions) {
    this.#getToken = options.getToken;
    this.#base = options.baseUrl ?? RING_API_BASE;
    this.#fetch = options.fetchImpl ?? fetch;
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
