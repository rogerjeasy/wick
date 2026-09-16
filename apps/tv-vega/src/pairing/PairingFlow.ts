/**
 * Six-digit pairing. The television never sees an account password.
 *
 * INV-1: the device ends up holding exactly one device-bound JWT, scoped to
 * receiving cards for one household and posting playback events. Assume it is
 * extractable — Vega documents no hardware-backed keystore (Q4) — and scope
 * accordingly. It grants nothing over Ring, Bee or any family surface.
 *
 * See docs/WICK-TECHNICAL.md §4.2.
 */
import type { DeviceToken } from '@wick/contracts';
import type { FileSystemLike } from '../headless/QueueStore.js';

const TOKEN_PATH = '/wick/token.json';

export interface PairingStartResponse {
  readonly code: string;
  readonly url: string;
  readonly expiresAt: number;
}

export type PairingStatusResponse =
  | { readonly status: 'pending' }
  | { readonly status: 'bound'; readonly token: DeviceToken };

export interface PairingConfig {
  readonly pairingApiUrl: string;
  readonly pollIntervalMs?: number;
  readonly pollTimeoutMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_POLL_TIMEOUT_MS = 15 * 60 * 1000; // matches the pairing nonce's 15-minute TTL

export class PairingFlow {
  readonly #config: PairingConfig;
  readonly #fs: FileSystemLike;
  readonly #fetch: typeof fetch;

  constructor(config: PairingConfig, fs: FileSystemLike, fetchImpl: typeof fetch = fetch) {
    this.#config = config;
    this.#fs = fs;
    this.#fetch = fetchImpl;
  }

  async loadToken(): Promise<DeviceToken | null> {
    if (!(await this.#fs.exists(TOKEN_PATH))) return null;
    const raw = await this.#fs.readFileAsString(TOKEN_PATH, 'utf8');
    if (!raw) return null;
    const token = JSON.parse(raw) as DeviceToken;
    if (token.expiresAt <= Date.now()) return null;
    return token;
  }

  /** Called when the transport rejects the stored token (revoked, expired, denylisted). */
  async clearToken(): Promise<void> {
    if (await this.#fs.exists(TOKEN_PATH)) {
      await this.#fs.writeStringToFile(TOKEN_PATH, '', 'utf8');
    }
  }

  async start(deviceId: string): Promise<PairingStartResponse> {
    const res = await this.#fetch(`${this.#config.pairingApiUrl}/pair/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId }),
    });
    if (!res.ok) throw new Error(`pairing_start_failed: ${res.status}`);
    return (await res.json()) as PairingStartResponse;
  }

  /** Polls until Sarah claims the code, or the nonce's TTL elapses. Persists the token on success. */
  async pollUntilBound(code: string): Promise<DeviceToken> {
    const interval = this.#config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeout = this.#config.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const res = await this.#fetch(
        `${this.#config.pairingApiUrl}/pair/status?code=${encodeURIComponent(code)}`,
      );
      if (res.status === 404) throw new Error('pairing_code_expired');
      if (!res.ok) throw new Error(`pairing_status_failed: ${res.status}`);

      const body = (await res.json()) as PairingStatusResponse;
      if (body.status === 'bound') {
        await this.#fs.writeStringToFile(TOKEN_PATH, JSON.stringify(body.token), 'utf8');
        return body.token;
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    throw new Error('pairing_timed_out');
  }
}
