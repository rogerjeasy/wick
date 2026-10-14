/**
 * Six-digit pairing. The television never sees an account password.
 *
 * INV-1: the device ends up holding exactly one device-bound JWT, scoped to
 * receiving cards for one household and posting playback events. Assume it is
 * extractable — Vega documents no hardware-backed keystore (Q4) — and scope
 * accordingly. It grants nothing over Ring or any family surface.
 *
 * The same six digits connect a television as a family member's own
 * (packages/contracts/src/familyTelevision.ts). Which it is, is chosen in
 * the family app; the token then carries `kind: 'family'`, and it is kept
 * exactly as the server wrote it — from the poll, from disk and from a
 * refresh — because that one field decides what this television runs
 * (family/mode.ts). A token with no kind is the resident's.
 *
 * See docs/WICK-TECHNICAL.md §4.2.
 */
import type { DeviceToken } from '@wick/contracts';
import type { FileSystemLike } from '../headless/QueueStore.js';
import type { TelevisionIdentity } from '../deviceId.js';

// Flat, directly under /data/ — the only writable root ever shown in the
// Vega SDK's own KeplerFileSystemInterface docs (every documented example
// is a bare filename under /data/, never a subdirectory; there's no
// mkdir/createDirectory method on the interface at all). A path under an
// invented top-level directory like /wick/ fails with a bare, undetailed
// com.amazon.kepler.io.IoError — confirmed empirically 2026-09-19 by
// surfacing that error on-device rather than guessing. See FRICTION.md.
export const TOKEN_PATH = '/data/wick-token.json';

export interface PairingStartResponse {
  readonly code: string;
  readonly url: string;
  readonly expiresAt: number;
}

export type PairingStatusResponse =
  | { readonly status: 'pending' }
  /** `proof`: the secret the pairing service made for a television that asked for one (`keeps`), handed over once, with the token. */
  | { readonly status: 'bound'; readonly token: DeviceToken; readonly proof?: string };

export interface PairingConfig {
  readonly pairingApiUrl: string;
  readonly pollIntervalMs?: number;
  readonly pollTimeoutMs?: number;
  /** How long any one request to the pairing service is waited for. */
  readonly requestTimeoutMs?: number;
  /** How long to wait before asking for a refresh again after the server said "too soon". */
  readonly refreshRetryMs?: number;
  /** Injectable so tests do not sit through the wait. */
  readonly wait?: (ms: number) => Promise<void>;
}

/**
 * What asking for a fresh token came to (`renew`). "Not connected" is the
 * server saying so; a request that failed or was asked too soon is only
 * "not now", and must never be read as the television having been removed.
 */
export type RenewResult = { readonly token: DeviceToken } | 'not_connected' | 'try_later';

export interface LoadTokenOptions {
  /**
   * The server lets one television refresh once in 30 seconds. A caller with
   * no screen to fall back to — the card service — sets this, and a "too
   * soon" is waited out and asked again instead of read as "not paired".
   */
  readonly waitIfRefreshedJustNow?: boolean;
  /**
   * The background service is asking (headless/CardService.ts). With no
   * token to show it says so, and a family member's television is then
   * handed the one narrow token the app opened the way for
   * (`openServiceWindow`). The resident's television is answered as always.
   */
  readonly asService?: boolean;
  /**
   * Told the status the pairing service refused a refresh with, when it
   * did. The service uses it to tell "a family television whose way is not
   * open" (401) from "not paired" — the first is worth waiting for.
   */
  readonly onRefusal?: (status: number) => void;
}

/**
 * What one knock at the pairing service came to (`claimForService`): the
 * service's token; no way open just now; this television is no longer
 * connected at all; or it could not be asked.
 */
export type ServiceClaim = { readonly token: DeviceToken } | 'no_way' | 'not_paired' | 'try_later';

/** What `renew` may do to the disk. */
export interface RenewOptions {
  /**
   * False for the background service: it neither writes the fresh token
   * down nor forgets the stored one. The file is the app's.
   */
  readonly remember?: boolean;
}

/**
 * A token narrowed to one purpose (edge-device pair-refresh.mjs: `waiting`,
 * for the background service of a family member's television). The pairing
 * service says so beside the token. It is never the television's own token.
 */
export function isNarrowToken(token: DeviceToken): boolean {
  return (token as { readonly scope?: unknown }).scope !== undefined;
}

/**
 * No request to the pairing service is waited for longer than this. One
 * that has not answered by then has failed, like one the network refused —
 * and whoever asked decides what a failure means: the launch tries again
 * (connect.ts), a renewal is "not now". Without it, a request that never
 * answers holds the television on "Getting a code…" for as long as it likes
 * (seen on the Vega simulator after a cold boot, 2026-10-13).
 */
export const PAIRING_REQUEST_TIMEOUT_MS = 10_000;

const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_POLL_TIMEOUT_MS = 15 * 60 * 1000; // matches the pairing nonce's 15-minute TTL
// A little over the server's window (edge-device pairing-code.mjs REFRESH_WINDOW_MS, 30 s): by then it has opened a new one.
const DEFAULT_REFRESH_RETRY_MS = 32_000;
const REFRESH_RETRIES = 3;

/** The pairing service handed over a secret this television could not write down. */
class SecretNotKept extends Error {
  constructor() {
    super('pairing_secret_not_kept');
    this.name = 'SecretNotKept';
  }
}

/** The code on screen is no longer one the pairing service knows. */
class CodeExpired extends Error {
  constructor() {
    super('pairing_code_expired');
    this.name = 'CodeExpired';
  }
}

/**
 * What the pairing flow needs of this television's identity (deviceId.ts):
 * the secret to prove a refresh with, who to ask for a code as, and being
 * told when a code was entered. Without one, nothing is proved — as on a
 * television that keeps nothing.
 */
export type PairingIdentitySource = Pick<TelevisionIdentity, 'proofFor'> & Partial<Pick<TelevisionIdentity, 'forPairing' | 'paired'>>;

export class PairingFlow {
  readonly #config: PairingConfig;
  readonly #fs: FileSystemLike;
  readonly #fetch: typeof fetch;
  readonly #wait: (ms: number) => Promise<void>;
  readonly #identity: PairingIdentitySource | undefined;

  constructor(config: PairingConfig, fs: FileSystemLike, fetchImpl: typeof fetch = fetch, identity?: PairingIdentitySource) {
    this.#config = config;
    this.#fs = fs;
    this.#identity = identity;
    this.#fetch = (url, init) => PairingFlow.#inTime(fetchImpl, url, init, config.requestTimeoutMs ?? PAIRING_REQUEST_TIMEOUT_MS);
    this.#wait = config.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * One request, over when it answers or when its time is up — whichever
   * comes first. Out of time is a failure like any other: it throws. React
   * Native has AbortController on both televisions; the timer holds even
   * where it is missing.
   */
  static async #inTime(fetchImpl: typeof fetch, url: Parameters<typeof fetch>[0], init: RequestInit | undefined, timeoutMs: number): Promise<Response> {
    const controller = typeof AbortController === 'undefined' ? undefined : new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tooLong = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller?.abort();
        reject(new Error('pairing_request_timed_out'));
      }, timeoutMs);
    });
    try {
      return await Promise.race([fetchImpl(url, { ...init, ...(controller ? { signal: controller.signal } : {}) }), tooLong]);
    } finally {
      clearTimeout(timer);
    }
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
   * the server instead, using the same durable binding pair-claim.mjs
   * already writes — the server, not this device's broken local disk, is
   * the actual source of truth for "is this device paired," and for which
   * household it belongs to (INV-8: the television only says who it is).
   *
   * A token on disk that has run out is not thrown away: it is shown to the
   * server as the proof a refresh needs (`#askForRefresh`).
   */
  async loadToken(deviceId?: string, options: LoadTokenOptions = {}): Promise<DeviceToken | null> {
    const stored = await this.#storedToken();
    if (stored && !(stored.expiresAt <= Date.now())) return stored;
    if (!deviceId) return null;
    // Only a service with nothing to show says it is the service: with a token in hand it refreshes like anyone, and opens no way.
    return this.#refreshToken(deviceId, options.waitIfRefreshedJustNow === true, stored?.jwt, options.asService === true && !stored, options.onRefusal);
  }

  /**
   * What this television last held, whether or not it has run out — or
   * null where nothing is kept. Read from the disk and from nowhere else:
   * nobody is asked. It says which television this was, the resident's or a
   * family member's own, before the pairing service has answered anything
   * (connect.ts shows that television's own screen meanwhile).
   */
  rememberedToken(): Promise<DeviceToken | null> {
    return this.#storedToken();
  }

  /** The token on disk, whether or not it has run out — or null when the disk holds none. */
  async #storedToken(): Promise<DeviceToken | null> {
    try {
      if (!(await this.#fs.exists(TOKEN_PATH))) return null;
      const raw = await this.#fs.readFileAsString(TOKEN_PATH, 'utf8');
      if (!raw) return null;
      const token = JSON.parse(raw) as DeviceToken;
      if (typeof token?.jwt !== 'string' || token.jwt.length === 0) return null;
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

  /**
   * `POST /pair/refresh`. The body is the device id and nothing else (INV-8).
   *
   * `heldJwt` is the token this television holds, or held: whenever there is
   * one to hand it goes as the bearer. A family member's own television is
   * minted a token only on that proof — never from the device id alone,
   * which can be guessed — and one that has run out will do (edge-device
   * pair-refresh.mjs). The resident's television needs none, and sending
   * one is harmless.
   *
   * `forService` is said in two cases only, both about a family television's
   * background service: by the app, with its token, to open the way for it
   * (`openServiceWindow`); and by the service, with none, to take it.
   *
   * `proof` is this television's secret (deviceId.ts), whenever it keeps
   * one: a television whose row keeps a secret is answered for nothing
   * else, and one whose row has none yet enrols it with a token it was
   * paired with (edge-device pair-refresh.mjs). A family television's
   * service knocking without a token needs none — it is answered inside the
   * way its app opened — and sending it there changes nothing.
   */
  async #askForRefresh(deviceId: string, heldJwt: string | undefined, forService = false): Promise<Response> {
    const proof = await this.#proofFor(deviceId);
    return this.#fetch(`${this.#config.pairingApiUrl}/pair/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(heldJwt ? { Authorization: `Bearer ${heldJwt}` } : {}) },
      body: JSON.stringify({ deviceId, ...(forService ? { forService: true } : {}), ...(proof ? { proof } : {}) }),
    });
  }

  /** The secret for this id, or nothing — a disk that cannot be read proves nothing, and is no reason not to ask. */
  async #proofFor(deviceId: string): Promise<string | undefined> {
    try {
      return await this.#identity?.proofFor(deviceId);
    } catch {
      return undefined;
    }
  }

  /**
   * The server, shown the token this television held, says it is no longer
   * connected: 401 (not this television's token), 403 (revoked), 404 (not
   * paired). Only then is a stored token forgotten — one that has merely run
   * out is the proof for the next refresh, and "not now" (429, a server
   * error, no network) says nothing about whether it is still good.
   */
  static #saysNotConnected(status: number): boolean {
    return status === 401 || status === 403 || status === 404;
  }

  /**
   * Best-effort, like every write here (FL-013): the token in hand is what
   * counts. A narrow token is never written: this file is where the app
   * finds its own, and the service's must not be found there instead.
   */
  async #keep(token: DeviceToken): Promise<void> {
    if (isNarrowToken(token)) return;
    try {
      await this.#fs.writeStringToFile(TOKEN_PATH, JSON.stringify(token), 'utf8');
    } catch (err) {
      console.error('pairing_token_persist_failed', err);
    }
  }

  async #refreshToken(
    deviceId: string,
    patient: boolean,
    heldJwt: string | undefined,
    asService: boolean,
    onRefusal?: (status: number) => void,
  ): Promise<DeviceToken | null> {
    const ask = (): Promise<Response> => this.#askForRefresh(deviceId, heldJwt, asService);
    let res = await ask();
    // 429: this television refreshed a moment ago — where the disk keeps
    // nothing (FL-013), that was the app, a second before its card service.
    // It is paired; the answer is only late.
    for (let tries = 0; res.status === 429 && patient && tries < REFRESH_RETRIES; tries += 1) {
      await this.#wait(this.#config.refreshRetryMs ?? DEFAULT_REFRESH_RETRY_MS);
      res = await ask();
    }
    // Never paired, denylisted, or the refresh call itself failed — the
    // pairing screen is the safe, fail-closed fallback in every case here.
    // So is 401: a family member's television with no token to show
    // (`token_required` — every relaunch on the Vega simulator, whose disk
    // keeps nothing, FL-013) or one whose token is not its own. Asked once
    // and never again from here: only a 429 is ever waited out above.
    if (!res.ok) {
      if (heldJwt && PairingFlow.#saysNotConnected(res.status)) await this.clearToken();
      onRefusal?.(res.status);
      return null;
    }
    const { token } = (await res.json()) as { token: DeviceToken };
    await this.#keep(token);
    return token;
  }

  /**
   * A fresh token for a television that is already on screen and has just
   * been told its token is no good — a refresh's token lasts an hour, and a
   * family member's television asks the Wick server something every few
   * seconds (family/familyClient.ts). The same request as the launch-time
   * fallback above, whatever the disk holds, and with the three answers kept
   * apart. The token comes back as the server wrote it: a family member's
   * television keeps its `kind`.
   *
   * `heldJwt` is the token the television has in its hand — the one just
   * refused, which is its proof. Where the disk keeps nothing (FL-013) that
   * is the only copy; handed none, the one on disk is shown instead.
   *
   * Asked once. A refusal is final: the caller is signed out, and nothing
   * here or there asks again on the strength of the same token.
   *
   * Never throws.
   */
  async renew(deviceId: string, heldJwt?: string, options: RenewOptions = {}): Promise<RenewResult> {
    const remember = options.remember !== false;
    try {
      const held = heldJwt ?? (await this.#storedToken())?.jwt;
      const res = await this.#askForRefresh(deviceId, held);
      // token_required / invalid_token, device_denylisted, device_not_paired (edge-device pair-refresh.mjs).
      if (PairingFlow.#saysNotConnected(res.status)) {
        if (remember) await this.clearToken();
        return 'not_connected';
      }
      if (!res.ok) return 'try_later';
      const { token } = (await res.json()) as { token?: DeviceToken };
      if (!token || typeof token.jwt !== 'string' || token.jwt.length === 0) return 'try_later';
      if (remember) await this.#keep(token);
      return { token };
    } catch {
      return 'try_later';
    }
  }

  /**
   * Writes down a fresh token the resident's television took while it was
   * running (pairing/standing.ts) — but only over nothing, or over a token
   * that ends sooner than this one. A fresh token lasts an hour and the one
   * a pairing writes lasts thirty days: mid-life, that one stays, and the
   * next launch goes on using it without asking anybody. One that has run
   * out, or is about to, gives way, so a launch in the next hour finds a
   * token that still opens the channel.
   *
   * The two ends compared are both the pairing service's, so this
   * television's clock, which may be hours out, is not asked. Nobody else
   * is asked either. A narrow token is never written (`#keep`).
   *
   * A family member's television does not come here: its own renewal shows
   * the token it holds as proof, and keeps what it is handed (`renew`).
   *
   * Best-effort and never throws, like every write here (FL-013): where the
   * disk keeps nothing the token in hand is the only copy, as it always was.
   */
  async keepIfLonger(token: DeviceToken): Promise<void> {
    const stored = await this.#storedToken();
    if (stored && !(stored.expiresAt < token.expiresAt)) return;
    await this.#keep(token);
  }

  /**
   * Opens the way for this television's background service: a refresh that
   * shows the app's own token and says it is for the service. The pairing
   * service then answers one request without a token, for a short while,
   * with a token good for one thing — asking what waits (edge-device
   * pair-refresh.mjs). It is how a family member's television hands its
   * service anything at all: on the television itself nothing passes from
   * the app to the service (FL-013).
   *
   * The answer is not kept and not used: the app has its token already, and
   * this one is no better. A failure is nobody's business but the service's,
   * which then holds nothing. Never throws.
   */
  /**
   * The background service knocking: one request without a token, saying it
   * is the service. Answered with the service's narrow token only inside a
   * way the app has opened (`openServiceWindow`), from the same address,
   * once. The disk is neither read nor written: the file there is the app's.
   *
   * Never throws.
   */
  async claimForService(deviceId: string): Promise<ServiceClaim> {
    try {
      const res = await this.#askForRefresh(deviceId, undefined, true);
      if (res.status === 401) return 'no_way';
      if (res.status === 403 || res.status === 404) return 'not_paired';
      if (!res.ok) return 'try_later';
      const { token } = (await res.json()) as { token?: DeviceToken };
      if (!token || typeof token.jwt !== 'string' || token.jwt.length === 0) return 'try_later';
      return { token };
    } catch {
      return 'try_later';
    }
  }

  async openServiceWindow(deviceId: string, heldJwt: string): Promise<void> {
    try {
      await this.#askForRefresh(deviceId, heldJwt, true);
    } catch (err) {
      console.error('pairing_service_window_failed', err);
    }
  }

  /**
   * Called when the stored token is refused for good (revoked, removed,
   * denylisted). Never throws: storage that cannot be written (FL-013) holds
   * no token to forget.
   */
  async clearToken(): Promise<void> {
    try {
      if (await this.#fs.exists(TOKEN_PATH)) {
        await this.#fs.writeStringToFile(TOKEN_PATH, '', 'utf8');
      }
    } catch (err) {
      console.error('pairing_token_clear_failed', err);
    }
  }

  /**
   * Asks for a code. Where this television makes its own secret it is paired
   * with it; where it keeps a file but cannot make one it asks for one
   * (`keeps`), handed over with the token (`pollUntilBound`). A television
   * that was paired before asks as a new one, saying which it was
   * (deviceId.ts `forPairing`): the id it had stops being its.
   */
  async start(deviceId: string): Promise<PairingStartResponse> {
    const who = this.#identity?.forPairing ? await this.#identity.forPairing(deviceId) : { deviceId };
    const res = await this.#fetch(`${this.#config.pairingApiUrl}/pair/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: who.deviceId,
        ...(who.proof ? { proof: who.proof } : {}),
        ...(who.keeps ? { keeps: true } : {}),
        ...(who.replaces ? { replaces: who.replaces } : {}),
      }),
    });
    if (!res.ok) throw new Error(`pairing_start_failed: ${res.status}`);
    return (await res.json()) as PairingStartResponse;
  }

  /**
   * Polls until the code is entered in the family app, or the nonce's TTL
   * elapses. Persists the token on success.
   *
   * One question that fails — not answered in time, the network gone for a
   * moment, the pairing service in trouble — does not end the wait: the
   * code on screen is still good, and it is asked again at the next
   * interval. Only the code having gone (404), or its time being over,
   * ends it.
   */
  async pollUntilBound(code: string): Promise<DeviceToken> {
    const interval = this.#config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeout = this.#config.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      let body: PairingStatusResponse | undefined;
      try {
        const res = await this.#fetch(`${this.#config.pairingApiUrl}/pair/status?code=${encodeURIComponent(code)}`);
        if (res.status === 404) throw new CodeExpired();
        if (res.ok) body = (await res.json()) as PairingStatusResponse;
      } catch (err) {
        if (err instanceof CodeExpired) throw err;
        // Asked again below.
      }

      if (body?.status === 'bound') {
        // The server has already confirmed the claim; that must be enough to
        // proceed. Caching the token to disk is a best-effort optimization
        // for skipping re-pairing on the next launch — losing it just means
        // re-pairing then, which is recoverable. Letting a write failure
        // here reject the whole call is not: it was observed on-device as a
        // native "Application data root path is not set" error that leaves
        // the app stuck on the pairing screen forever despite a real,
        // server-confirmed claim. See FRICTION.md.
        await this.#keep(body.token);
        // The identity the code was asked for with is this television's from now on (deviceId.ts), with the secret the
        // pairing service made for it if it asked for one — kept there, never in the token's file.
        let kept = false;
        try {
          kept = (await this.#identity?.paired?.(body.token.deviceId, body.proof)) === true;
        } catch (err) {
          console.error('pairing_identity_not_kept', err);
        }
        // A secret the pairing service made, and this television could not write down, would lock it out at its next
        // refresh: its row now asks for a secret nobody has. So the pairing is not finished here — the token is let
        // go and a new code is shown, under the same identity, and the server makes a new secret for it (the one it
        // made is handed over once, and is gone). Otherwise the token in hand is what counts, as it always was.
        if (body.proof !== undefined && !kept) {
          await this.clearToken();
          throw new SecretNotKept();
        }
        return body.token;
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    throw new Error('pairing_timed_out');
  }
}
