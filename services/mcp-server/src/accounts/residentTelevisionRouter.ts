/**
 * /tv/stop — the resident stops Wick from her own television
 * (accounts/residentTelevision.ts decides all of it; this only carries it).
 * CORS as the family television's routes: the virtual television is a
 * browser tab on another origin, and sends an `authorization` header.
 */
import cors from 'cors';
import express from 'express';
import { createResidentTelevision, type ResidentTelevisionDeps } from './residentTelevision.js';

export function createResidentTelevisionRouter(deps: ResidentTelevisionDeps): express.Router {
  const television = createResidentTelevision(deps);
  const router = express.Router();
  const tvCors = cors();
  router.options('/tv/stop', tvCors);
  router.post('/tv/stop', tvCors, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const reply = await television.stop(req.headers.authorization, req.body as unknown);
      if (reply.status === 401) res.set('WWW-Authenticate', 'Bearer');
      res.status(reply.status).json(reply.body);
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: 'resident_stop_failed', err: err instanceof Error ? err.name : 'unknown' }));
      if (!res.headersSent) res.status(500).json({ error: 'server_error', say: 'Something went wrong on my end — try again in a moment.' });
    }
  });
  return router;
}
