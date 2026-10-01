/**
 * Six-digit pairing. The television never sees an account password.
 *
 * INV-1: the device ends up holding exactly one device-bound JWT, scoped to
 * receiving cards for one household and posting playback events. Assume it is
 * extractable — Vega documents no hardware-backed keystore (Q4) — and scope
 * accordingly. It grants nothing over Ring or any family surface.
 *
 * See docs/WICK-TECHNICAL.md §4.2.
 */
import type { DeviceToken } from '@wick/contracts';
import type { FileSystemLike } from '../headless/QueueStore.js';

// Flat, directly under /data/ — the only writable root ever shown in the
// Vega SDK's own KeplerFileSystemInterface docs (every documented example
// is a bare filename under /data/, never a subdirectory; there's no
// mkdir/createDirectory method on the interface at all). A path under an
// invented top-level directory like /wick/ fails with a bare, undetailed
// com.amazon.kepler.io.IoError — confirmed empirically 2026-09-19 by
// surfacing that error on-device rather than guessing. See FRICTION.md.
const TOKEN_PATH = '/data/wick-token.json';

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
  /** Needed only for loadToken()'s server-side refresh fallback — see its header comment. */
  readonly householdId?: string;
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

  /**
   * `deviceId` is optional so existing disk-only callers are unaffected; the
   * two real call sites (App.tsx, CardService.ts) always pass it.
   *
   * CardService.ts runs in a separate process from App.tsx with no shared
   * JS memory — the on-disk token file is its only way to learn about a
   * pairing App.tsx already completed. On a device where that file can
   * never actually hold a write (FRICTION.md FL-013), disk alone can never
   * tell CardService "this device is already paired," no matter how many
   * times pairing succeeds in the other process. The fallback below asks
   * the server instead, using the same durable deviceId<->householdId
   * binding pair-claim.mjs already writes — the server, not this device's
   * broken local disk, is the actual source of truth for "is this device
   * paired."
   */
  async loadToken(deviceId?: string): Promise<DeviceToken | null> {
    const cached = await this.#loadTokenFromDisk();
    if (cached) return cached;
    if (!deviceId || !this.#config.householdId) return null;
    return this.#refreshToken(deviceId, this.#config.householdId);
  }

  async #loadTokenFromDisk(): Promise<DeviceToken | null> {
    try {
      if (!(await this.#fs.exists(TOKEN_PATH))) return null;
      const raw = await this.#fs.readFileAsString(TOKEN_PATH, 'utf8');
      if (!raw) return null;
      const token = JSON.parse(raw) as DeviceToken;
      if (token.expiresAt <= Date.now()) return null;
      return token;
    } catch {
      // A throwing exists()/readFileAsString() (observed on-device as the
      // same bare com.amazon.kepler.io.IoError as the write side, FL-013)
      // means "nothing usable is cached", not "give up" — this call was
      // previously unguarded, and an uncaught rejection here inside a
      // headless entry point (CardService.ts) is the likely cause of this
      // session's unexplained background-process SIGABRT crashes.
      return null;
    }
  }

  async #refreshToken(deviceId: string, householdId: string): Promise<DeviceToken | null> {
    const res = await this.#fetch(`${this.#config.pairingApiUrl}/pair/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId, householdId }),
    });
    // Never paired, denylisted, or the refresh call itself failed — the
    // pairing screen is the safe, fail-closed fallback in every case here.
    if (!res.ok) return null;
    const { token } = (await res.json()) as { token: DeviceToken };
    try {
      await this.#fs.writeStringToFile(TOKEN_PATH, JSON.stringify(token), 'utf8');
    } catch (err) {
      console.error('pairing_token_persist_failed', err);
    }
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
        // The server has already confirmed the claim; that must be enough to
        // proceed. Caching the token to disk is a best-effort optimization
        // for skipping re-pairing on the next launch — losing it just means
        // re-pairing then, which is recoverable. Letting a write failure
        // here reject the whole call is not: it was observed on-device as a
        // native "Application data root path is not set" error that leaves
        // the app stuck on the pairing screen forever despite a real,
        // server-confirmed claim. See FRICTION.md.
        try {
          await this.#fs.writeStringToFile(TOKEN_PATH, JSON.stringify(body.token), 'utf8');
        } catch (err) {
          console.error('pairing_token_persist_failed', err);
        }
        return body.token;
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    throw new Error('pairing_timed_out');
  }
}
