/**
 * POST /api/hear — ask by voice, as the family app reaches it.
 *
 * The body is one short utterance and nothing else: mono, 16 kHz, signed
 * 16-bit little-endian PCM, sent as `audio/l16; rate=16000` (or
 * `application/octet-stream`), at most MAX_HEAR_BYTES — read by a parser
 * that belongs to this one route. The answer is `{ text }`: the words
 * Transcribe heard (hear/transcribe.ts), which the page then asks exactly as
 * if they had been typed. Empty text is an answer too — nothing was
 * understood — and the page says so in its own words.
 *
 * In this order, so that nothing is read that will not be used: who is
 * asking (the token's person, still in the circle), what kind of thing the
 * body says it is, whether this person has asked too often, and only then
 * the bytes.
 *
 * INV-8: there is no household here at all. Hearing touches nobody's rows;
 * the question it becomes is asked through the same gated paths as a typed
 * one. Nothing in the address, the query, the headers or the body is read
 * but the content type and the bytes.
 *
 * Nothing of the audio is kept or logged: not the bytes, not their length,
 * not the words. One line is logged per hearing — its outcome, and how many
 * milliseconds it took — and an error by its name alone.
 */
import express, { type ErrorRequestHandler, type Request, type RequestHandler, type Response } from 'express';
import { HEAR_SAMPLE_RATE, MAX_HEAR_BYTES } from '@wick/contracts';
import { accessOf } from '../accounts/circle.js';
import { isGuest } from '../accounts/demo.js';
import { grantOf } from '../accounts/oauthProvider.js';
import type { AccountStore } from '../accounts/store.js';
import type { Hear } from './transcribe.js';

/** The two names the page may give its audio. Anything else is not what this route takes. */
const AUDIO_TYPES = ['audio/l16', 'application/octet-stream'];

/** One person, in a minute. Speaking a question takes a few seconds; six a minute is more than anyone asks. */
export const HEARINGS_PER_PERSON_PER_MINUTE = 6;
/** Everyone in one budget together (guests, or people with accounts), in ten minutes. */
export const HEARINGS_PER_WINDOW = 120;
/** The same, in a day: Transcribe is paid for by the second, and a day has a known worst cost. */
export const HEARINGS_PER_DAY = 1_000;

const MINUTE_MS = 60_000;
const WINDOW_MS = 10 * MINUTE_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;

export const HEAR_WORDS = {
  signIn: 'Link Wick again.',
  notAudio: 'That is not something Wick can listen to. Try again, or type it.',
  empty: 'Nothing was heard. Try again, or type it.',
  tooLong: 'That was too long for Wick to hear in one go. Ask in ten seconds or less, or type it.',
  busy: 'That is a lot of asking out loud. Type it, or try again in a minute.',
  unavailable: 'This Wick cannot hear a question yet. Type it instead.',
  failed: 'Wick could not hear that just now. Try again, or type it.',
} as const;

interface Budget {
  windowStart: number;
  windowTaken: number;
  dayStart: number;
  dayTaken: number;
}

/**
 * Whether one more hearing may be had now, counting it if so. Held in this
 * process, as the assistant's budgets are (assistant/router.ts): one
 * instance serves the deployment (infra/mcp.tf), and a restart forgets —
 * a looser limit, never a wrong answer.
 *
 * Each person is held to a sliding minute. Guests and people with accounts
 * are counted apart, each against the same caps, so a flood of one-click
 * guest accounts can spend the guests' hearings but never the hearing of
 * the person who signed up to look after their mother.
 */
export function createHearingLimiter(now: () => number): (userId: string) => boolean {
  const fresh = (): Budget => ({ windowStart: now(), windowTaken: 0, dayStart: now(), dayTaken: 0 });
  const budgets = { guest: fresh(), account: fresh() };
  const recent = new Map<string, number[]>();

  return (userId) => {
    const at = now();
    const budget = isGuest(userId) ? budgets.guest : budgets.account;
    if (at - budget.windowStart >= WINDOW_MS) {
      budget.windowStart = at;
      budget.windowTaken = 0;
    }
    if (at - budget.dayStart >= DAY_MS) {
      budget.dayStart = at;
      budget.dayTaken = 0;
    }
    // Only the last minute of anybody's hearings is remembered.
    for (const [who, times] of recent) {
      const kept = times.filter((t) => at - t < MINUTE_MS);
      if (kept.length) recent.set(who, kept);
      else recent.delete(who);
    }
    const mine = recent.get(userId) ?? [];
    if (mine.length >= HEARINGS_PER_PERSON_PER_MINUTE || budget.windowTaken >= HEARINGS_PER_WINDOW || budget.dayTaken >= HEARINGS_PER_DAY) return false;
    recent.set(userId, [...mine, at]);
    budget.windowTaken += 1;
    budget.dayTaken += 1;
    return true;
  };
}

export interface HearDeps {
  /** Absent where this Wick cannot reach Transcribe: the route then says so, in words. */
  readonly hear?: Hear | undefined;
  readonly store: AccountStore;
  readonly now: () => number;
}

const refuse = (res: Response, status: number, error: string, message: string): void => void res.status(status).json({ error, message });

/** One line per hearing: what came of it and how long it took. Never the audio, its length, or the words. */
function logHearing(outcome: string, ms: number, err?: unknown): void {
  console.log(JSON.stringify({
    level: outcome === 'failed' ? 'error' : 'info',
    msg: 'hear',
    outcome,
    ms,
    ...(err === undefined ? {} : { err: err instanceof Error ? err.name || 'Error' : 'unknown' }),
  }));
}

/** Whether the content type's own parameters, if it names any, are this route's: 16 kHz, one channel. */
function rightShape(req: Request): boolean {
  const type = req.get('content-type') ?? '';
  const params = new Map(
    type.split(';').slice(1).map((part) => {
      const [name, value] = part.split('=');
      return [String(name).trim().toLowerCase(), String(value ?? '').trim().replace(/^"|"$/g, '')] as const;
    }),
  );
  const rate = params.get('rate');
  const channels = params.get('channels');
  return (rate === undefined || rate === String(HEAR_SAMPLE_RATE)) && (channels === undefined || channels === '1');
}

/** POST /api/hear's handlers, in order — who is asking, what kind of thing it is, how often, the bytes, the hearing. */
export function createHearRoute(deps: HearDeps): readonly (RequestHandler | ErrorRequestHandler)[] {
  const mayHear = createHearingLimiter(deps.now);

  const whoFirst: RequestHandler = async (req, res, next) => {
    const grant = grantOf(req.auth);
    if (!grant) return refuse(res, 401, 'invalid_token', HEAR_WORDS.signIn);
    try {
      // Someone still in the circle — allowed, or still waiting for her press, who may ask the app what to do next.
      // Somebody turned down or removed is told what stands, and nothing is heard.
      const [membership, household] = await Promise.all([deps.store.getMembership(grant.householdId, grant.userId), deps.store.getHousehold(grant.householdId)]);
      const access = accessOf(membership, household);
      if (!access.ok && access.reason !== 'waiting') return refuse(res, 403, 'not_a_member', access.say);
      next();
    } catch (err) {
      logHearing('failed', 0, err);
      refuse(res, 500, 'server_error', HEAR_WORDS.failed);
    }
  };

  const audioOnly: RequestHandler = (req, res, next) => {
    if (!req.is(AUDIO_TYPES) || !rightShape(req)) return refuse(res, 415, 'not_audio', HEAR_WORDS.notAudio);
    if (!deps.hear) return refuse(res, 503, 'hearing_unavailable', HEAR_WORDS.unavailable);
    next();
  };

  const notTooOften: RequestHandler = (req, res, next) => {
    const grant = grantOf(req.auth)!;
    if (!mayHear(grant.userId)) {
      logHearing('busy', 0);
      return refuse(res, 429, 'too_many', HEAR_WORDS.busy);
    }
    next();
  };

  /** This route's own parser: raw bytes, no more of them than ten seconds of audio. */
  const bytes = express.raw({ type: AUDIO_TYPES, limit: MAX_HEAR_BYTES });

  const unread: ErrorRequestHandler = (err: { type?: string }, _req, res, _next) => {
    if (err?.type === 'entity.too.large') return refuse(res, 413, 'too_long', HEAR_WORDS.tooLong);
    // A body that stopped half way, or was not what its length said: nothing to hear.
    refuse(res, 400, 'not_audio', HEAR_WORDS.notAudio);
  };

  const hear: RequestHandler = async (req, res) => {
    const body: unknown = req.body;
    const pcm = Buffer.isBuffer(body) ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength) : new Uint8Array();
    if (pcm.length === 0) return refuse(res, 400, 'empty', HEAR_WORDS.empty);
    // Sixteen-bit samples come in pairs of bytes: an odd count is not this audio.
    if (pcm.length % 2 !== 0) return refuse(res, 400, 'not_audio', HEAR_WORDS.notAudio);

    const started = deps.now();
    try {
      const text = await deps.hear!(pcm);
      logHearing(text ? 'heard' : 'nothing_heard', deps.now() - started);
      res.json({ text });
    } catch (err) {
      logHearing('failed', deps.now() - started, err);
      refuse(res, 502, 'hearing_failed', HEAR_WORDS.failed);
    }
  };

  return [whoFirst, audioOnly, notTooOften, bytes, unread, hear];
}
