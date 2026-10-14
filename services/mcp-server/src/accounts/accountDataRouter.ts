/**
 * /api/account — a person's own data (myData.ts): the file of everything
 * Wick holds about them, what deleting their account would take, and the
 * deletion.
 *
 * Bearer-authenticated with the same token as the rest of /api, and about
 * the token's person only (INV-8): there is no user id or household in any
 * of these requests to read.
 */
import cors from 'cors';
import express, { type RequestHandler, type Response } from 'express';
import { grantOf } from './oauthProvider.js';
import { AccountRefusal, deleteAccount, deletionPlan, exportMyData, type MyDataDeps } from './myData.js';

export function createAccountDataRouter(deps: MyDataDeps, requireAuth: () => RequestHandler): express.Router {
  const router = express.Router();
  router.use('/api/account', cors(), requireAuth());

  /** Runs a handler with the token's person; a refusal becomes its sentence. */
  const forThePerson =
    (handler: (asker: { userId: string; token: string }, req: express.Request, res: Response) => Promise<void>): RequestHandler =>
    async (req, res) => {
      const grant = grantOf(req.auth);
      if (!grant || !req.auth) {
        res.status(401).json({ error: 'invalid_token', message: 'Link Wick again.' });
        return;
      }
      res.setHeader('cache-control', 'no-store');
      try {
        await handler({ userId: grant.userId, token: req.auth.token }, req, res);
      } catch (err) {
        if (err instanceof AccountRefusal) {
          res.status(err.status).json({ error: err.code, message: err.message });
          return;
        }
        console.error('[wick/mcp-server] /api/account failed:', (err as Error).name);
        res.status(500).json({ error: 'server_error', message: 'Something went wrong on my end. Nothing more was deleted: try again in a moment.' });
      }
    };

  router.get('/api/account/export', forThePerson(async ({ userId }, _req, res) => {
    const file = await exportMyData(deps, userId);
    res.setHeader('content-disposition', `attachment; filename="wick-my-data-${file.exportedAt.slice(0, 10)}.json"`);
    res.type('application/json').send(`${JSON.stringify(file, null, 2)}\n`);
  }));

  router.get('/api/account/deletion', forThePerson(async ({ userId }, _req, res) => {
    res.json(await deletionPlan(deps, userId));
  }));

  // The body carries the password again and the choice to close a home, and nothing else is read from it.
  router.delete('/api/account', forThePerson(async (asker, req, res) => {
    const body = (req.body ?? {}) as { password?: unknown; closeHomes?: unknown };
    await deleteAccount(deps, asker, { password: body.password, closeHomes: body.closeHomes });
    res.json({ deleted: true });
  }));

  return router;
}
