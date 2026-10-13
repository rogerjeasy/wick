/**
 * Watch live (M2), the television's half. Pure and RN-import-free, so it is
 * tested like messageActions.ts; LiveView.tsx only renders what this decides.
 *
 * The device asks the edge API for a session with its device token and
 * gets an HTTPS HLS playlist back (spec §4.3). It holds nothing that speaks
 * to Ring (INV-1): the playlist URL is all it ever learns.
 *
 * Every failure becomes one plain sentence and a Back button — never a
 * spinner without words, never a code (D6).
 */
import { DEFAULT_LANGUAGE, type HouseholdLanguage, type LiveRefusal, type LiveSessionResponse } from '@wick/contracts';
import { words, type PlainWordKey } from '../words/words.js';

export type LiveFailure = LiveRefusal | 'unauthorized';
export type LiveOutcome = LiveFailure | 'ended';

export type StartResult =
  | { readonly ok: true; readonly session: LiveSessionResponse }
  | { readonly ok: false; readonly reason: LiveFailure };

const KNOWN: readonly LiveFailure[] = ['no_such_card', 'card_too_old', 'camera_unavailable', 'camera_unsupported', 'unauthorized'];

export async function startLiveSession(args: {
  readonly pairingApiUrl: string;
  readonly jwt: string;
  readonly cardId: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}): Promise<StartResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const now = args.now ?? Date.now;
  try {
    const res = await fetchImpl(`${args.pairingApiUrl}/live/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${args.jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardId: args.cardId }),
    });
    const body = (await res.json().catch(() => ({}))) as Partial<LiveSessionResponse> & { error?: string };
    if (res.status === 201 && body.sessionId && body.playlistUrl && typeof body.endsAt === 'number') {
      const endsAt = onOwnClock(body.endsAt, res.headers?.get?.('Date') ?? null, now());
      return { ok: true, session: { sessionId: body.sessionId, playlistUrl: body.playlistUrl, endsAt } };
    }
    const reason = KNOWN.find((k) => k === body.error) ?? (res.status === 401 || res.status === 403 ? 'unauthorized' : 'camera_unavailable');
    return { ok: false, reason };
  } catch {
    return { ok: false, reason: 'camera_unavailable' };
  }
}

/**
 * Ring's deadline, moved onto the television's own clock. The server says
 * when the session ends on its clock; a TV's clock can be hours out (the VVD's
 * was 6.9h), so the countdown is what is left by the server's Date header,
 * counted from now here. Without the header, the server's time stands.
 */
function onOwnClock(serverEndsAt: number, dateHeader: string | null, localNow: number): number {
  const serverNow = dateHeader ? Date.parse(dateHeader) : Number.NaN;
  return Number.isFinite(serverNow) ? localNow + (serverEndsAt - serverNow) : serverEndsAt;
}

/** Back pressed: tell the bridge to stop. Never throws — Ring ends the session within a minute regardless. */
export async function stopLiveSession(args: {
  readonly pairingApiUrl: string;
  readonly jwt: string;
  readonly sessionId: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = args.fetchImpl ?? fetch;
  try {
    await fetchImpl(`${args.pairingApiUrl}/live/sessions/${args.sessionId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${args.jwt}` },
    });
  } catch {
    // Nothing the resident can do about it, and nothing they need to know.
  }
}

const POLL_MS = 500;

/**
 * The bridge publishes its first playlist ~6s after the start (SP-3). Loading
 * the player before then gets a 404 (or CloudFront's 403 for a missing key)
 * that the player may not retry, so wait until the playlist names a segment.
 */
export async function waitForPlaylist(args: {
  readonly url: string;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly cancelled?: () => boolean;
}): Promise<boolean> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const now = args.now ?? Date.now;
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + args.timeoutMs;

  while (now() < deadline) {
    try {
      const res = await fetchImpl(args.url, { headers: { 'Cache-Control': 'no-cache' } });
      if (res.ok && /\.ts\s*$/m.test(await res.text())) return true;
    } catch {
      // Not there yet, or a blip; keep waiting until the deadline.
    }
    if (args.cancelled?.()) return false;
    await sleep(POLL_MS);
  }
  return false;
}

/** Which of the television's own sentences says each outcome (words/words.ts). */
const MESSAGES: Record<LiveOutcome, PlainWordKey> = {
  camera_unavailable: 'live.cameraUnavailable',
  camera_unsupported: 'live.cameraUnsupported',
  card_too_old: 'live.cardTooOld',
  no_such_card: 'live.noSuchCard',
  unauthorized: 'live.unauthorized',
  ended: 'live.ended',
};

/** One plain sentence, in her language. An outcome with no sentence of its own is the camera not answering — never a code, never nothing. */
export function liveMessage(outcome: LiveOutcome, language: HouseholdLanguage = DEFAULT_LANGUAGE): string {
  const key = Object.prototype.hasOwnProperty.call(MESSAGES, outcome) ? MESSAGES[outcome] : MESSAGES.camera_unavailable;
  return words(language)(key);
}

/**
 * The player stopped (an error, or the stream ran out). Once the resident has
 * seen a picture, that is Ring ending the session — it can close a Playground
 * or battery stream before its stated limit — so say it ended, not that the
 * camera isn't answering.
 */
export function outcomeWhenPlayerStops(args: { readonly hadPicture: boolean }): LiveOutcome {
  return args.hadPicture ? 'ended' : 'camera_unavailable';
}

export function secondsLeft(endsAt: number, now: number): number {
  return Math.max(0, Math.ceil((endsAt - now) / 1000));
}
