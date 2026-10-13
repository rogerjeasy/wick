/**
 * /api/photos — the mantelpiece, as the family app reaches it.
 *
 *   POST /api/photos   one picture, as raw JPEG bytes, for her television
 *   GET  /api/photos   how the caller's own pictures stand
 *
 * Not tools: a picture is a file, and a model cannot hand one over. What
 * the sending does, and in which order it checks, is photos/send.ts; this
 * is how a picture arrives.
 *
 * It arrives as the request's body and nothing else — `image/jpeg`, at
 * most MAX_PHOTO_BYTES — read by a parser that belongs to this one route.
 * The rest of the server goes on reading JSON at its small default limit.
 * And who is sending is settled before that parser runs: somebody she has
 * not allowed, or a neighbour, is refused without a byte of what they sent
 * being kept.
 *
 * INV-8: the household is the token's. Nothing in the address, the query,
 * the headers or the body names a household, a bucket, a key, an address
 * or a name. One header is read, `Idempotency-Key`: the id the app made
 * for this picture, so that sending it twice sends it once (INV-6). It can
 * name a picture only within the sender's own household, and only one that
 * is theirs.
 */
import express, { type ErrorRequestHandler, type Request, type RequestHandler, type Response } from 'express';
import { MAX_PHOTO_BYTES } from '@wick/contracts';
import { grantOf } from '../accounts/oauthProvider.js';
import { loadSentPictures } from './pictures.js';
import { NOT_A_JPEG, PhotoRefusal, allowedSender, photosAvailable, sendPhoto, type PhotoActor, type PhotoDeps } from './send.js';

/** "1.5 MB", from the contract's own number. */
const LARGEST = `${(MAX_PHOTO_BYTES / 1_000_000).toFixed(1).replace(/\.0$/, '')} MB`;

const refuse = (res: Response, refusal: PhotoRefusal): void => void res.status(refusal.status).json({ error: refusal.code, message: refusal.message });

/** Answers a refusal in its own words, and anything else in words that say nothing of what went wrong. */
function answerError(res: Response, err: unknown): void {
  if (err instanceof PhotoRefusal) return refuse(res, err);
  // The error's name only: a picture's bytes, or an AWS message with an ARN in it, are never logged from here.
  console.error(JSON.stringify({ level: 'error', msg: 'photos_route_failed', err: err instanceof Error ? err.name : 'unknown' }));
  res.status(500).json({ error: 'server_error', message: 'Something went wrong on my end — try again in a moment.' });
}

/** The person and household the token names, or the refusal a request with no such token gets. */
function actorOf(req: Request, res: Response): PhotoActor | undefined {
  const grant = grantOf(req.auth);
  if (!grant) res.status(401).json({ error: 'invalid_token', message: 'Link Wick again.' });
  return grant;
}

export interface PhotoRoutes {
  /** POST: in this order — who is sending, what kind of thing it is, the bytes, the sending. */
  readonly send: readonly (RequestHandler | ErrorRequestHandler)[];
  readonly list: RequestHandler;
}

export function createPhotoRoutes(deps: PhotoDeps): PhotoRoutes {
  /** Before the body is read: somebody she has allowed, on a Wick that can send pictures at all. */
  const allowedFirst: RequestHandler = async (req, res, next) => {
    const actor = actorOf(req, res);
    if (!actor) return;
    try {
      await allowedSender(deps, actor);
      photosAvailable(deps);
      next();
    } catch (err) {
      answerError(res, err);
    }
  };

  /** A JPEG, by what the request calls it. What its bytes are is asked once they are read. */
  const jpegOnly: RequestHandler = (req, res, next) => {
    if (req.is('image/jpeg') !== 'image/jpeg') return refuse(res, new PhotoRefusal(415, 'not_a_jpeg', NOT_A_JPEG));
    next();
  };

  /** This route's own parser: raw bytes, and no more of them than a picture may be. */
  const bytes = express.raw({ type: 'image/jpeg', limit: MAX_PHOTO_BYTES });

  const unread: ErrorRequestHandler = (err: { type?: string }, _req, res, _next) => {
    if (err?.type === 'entity.too.large') return refuse(res, new PhotoRefusal(413, 'too_large', `That picture is too large. Wick takes pictures up to ${LARGEST}.`));
    // A body that stopped half way, or was not what its length said: not a picture.
    refuse(res, new PhotoRefusal(415, 'not_a_jpeg', NOT_A_JPEG));
  };

  const send: RequestHandler = async (req, res) => {
    const actor = actorOf(req, res);
    if (!actor) return;
    try {
      const body: unknown = req.body;
      // One header, and nothing else of the request: the id the app made for this picture.
      const key = req.get('idempotency-key');
      res.json(await sendPhoto(deps, actor, Buffer.isBuffer(body) ? body : new Uint8Array(), key));
    } catch (err) {
      answerError(res, err);
    }
  };

  const list: RequestHandler = async (req, res) => {
    const actor = actorOf(req, res);
    if (!actor) return;
    try {
      const { household } = await allowedSender(deps, actor);
      res.json({ photos: await loadSentPictures(deps.ddb, actor, household.residentName, deps.now()) });
    } catch (err) {
      answerError(res, err);
    }
  };

  return { send: [allowedFirst, jpegOnly, bytes, unread, send], list };
}
