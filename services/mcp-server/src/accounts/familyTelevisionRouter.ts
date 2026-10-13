/**
 * /tv — the two things a family member's own television asks of the Wick
 * server (accounts/familyTelevision.ts decides both; this only carries them).
 *
 *   GET  /tv/home    everything the television shows   → FamilyTvHome
 *   POST /tv/press   a press on one of its cards        → FamilyTvPressResult
 *
 * Authenticated by the television's own device token and by nothing else:
 * not by a person's access token, so `requireAuth` is not used here. INV-8:
 * what is handed on is the Authorization header and, for a press, the JSON
 * body, of which only a card id and an answer's key are ever read. No path
 * segment, query or other header reaches the logic at all.
 *
 * A television is a native app, but the virtual television is a browser tab
 * on another origin (apps/ops-console), and it sends an `authorization`
 * header — so a preflight comes first. Allowed exactly as /mcp is
 * (server.ts `mcpCors`): any origin, because nothing here uses a cookie and
 * a token is only ever sent by the page that holds it.
 */
import cors from 'cors';
import express, { type Request, type RequestHandler } from 'express';
import { createFamilyTelevision, type FamilyTelevisionDeps, type TvReply } from './familyTelevision.js';

export function createFamilyTelevisionRouter(deps: FamilyTelevisionDeps): express.Router {
  const television = createFamilyTelevision(deps);
  const router = express.Router();
  const tvCors = cors();

  const answer =
    (ask: (req: Request) => Promise<TvReply<object>>): RequestHandler =>
    async (req, res) => {
      // A home screen carries a picture's address and a person's name: it is for this television, now, and for no cache.
      res.set('Cache-Control', 'no-store');
      try {
        const reply = await ask(req);
        if (reply.status === 401) res.set('WWW-Authenticate', 'Bearer');
        res.status(reply.status).json(reply.body);
      } catch (err) {
        // The error's name and nothing else: never a token, a claim or a row.
        console.error(JSON.stringify({ level: 'error', msg: 'family_tv_failed', err: err instanceof Error ? err.name : 'unknown' }));
        if (!res.headersSent) res.status(500).json({ error: 'server_error', say: 'Something went wrong on my end — try again in a moment.' });
      }
    };

  router.options(['/tv/home', '/tv/press'], tvCors);
  router.get('/tv/home', tvCors, answer((req) => television.home(req.headers.authorization)));
  router.post('/tv/press', tvCors, answer((req) => television.press(req.headers.authorization, req.body as unknown)));

  return router;
}
