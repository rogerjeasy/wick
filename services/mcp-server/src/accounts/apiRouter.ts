/**
 * /api — what the family app needs that is not a question for an assistant:
 * who am I, who is in the circle, invite someone, remove someone.
 *
 * Bearer-authenticated with the same token as /mcp. INV-8: the household is
 * the token's, never a path segment or a body field, so there is no request
 * a person can write to reach a household that is not theirs.
 *
 * Connecting a television is passed straight on. The pairing Lambda mints
 * the television's credential and stays the only thing that can
 * (services/edge-device/lambda/pair-claim.mjs); this hands it the code with
 * the caller's own token, and the Lambda decides who they are and whether
 * they may. The family app then has one origin to talk to.
 */
import cors from 'cors';
import express, { type Request, type RequestHandler, type Response } from 'express';
import { CircleError, createInvitation, describeCircle, removeMember, type CircleDeps, type CircleErrorCode } from './circle.js';
import { grantOf } from './oauthProvider.js';

const CIRCLE_ERRORS: Readonly<Record<CircleErrorCode, { status: number; message: string }>> = {
  name_required: { status: 400, message: 'A name is needed.' },
  not_organiser: { status: 403, message: 'Only the person who set this home up can do that.' },
  not_a_member: { status: 404, message: 'That person is not in this family circle.' },
  invitation_invalid: { status: 400, message: 'That invitation has expired. Ask for a new one.' },
  cannot_remove_self: { status: 400, message: 'You cannot remove yourself.' },
};

/** POSTs a code to the pairing service as the caller. Returns its status and raw body. */
export type ClaimTelevision = (accessToken: string, code: string) => Promise<{ status: number; body: string }>;

/** What the pairing Lambda can answer, in words a person can act on. */
const PAIRING_REFUSALS: Readonly<Record<string, string>> = {
  unknown_or_expired_code: 'That code is not on a television right now. Check the six digits.',
  code_expired: 'That code has expired. The television is showing a new one.',
  already_claimed: 'That code has already been used.',
  television_in_another_home: 'That television belongs to another home. It has to be disconnected there first.',
  only_the_organiser_can_connect_a_television: 'Only the person who set this home up can connect a television.',
  sign_in_required: 'Link Wick again.',
  invalid_token: 'Link Wick again.',
};

export function createApiRouter(
  circle: CircleDeps,
  requireAuth: () => RequestHandler,
  claimTelevision?: ClaimTelevision,
): express.Router {
  const { store } = circle;
  const router = express.Router();
  // Any origin: nothing here uses a cookie, and a token is only ever sent by
  // the page that holds it.
  router.use('/api', cors(), requireAuth());

  /** Runs a handler with the token's person and household; turns a CircleError into words. */
  const withGrant =
    (handler: (grant: { userId: string; householdId: string }, req: Request, res: Response) => Promise<void>): RequestHandler =>
    async (req, res) => {
      const grant = grantOf(req.auth);
      if (!grant) {
        res.status(401).json({ error: 'invalid_token', message: 'Link Wick again.' });
        return;
      }
      try {
        await handler(grant, req, res);
      } catch (err) {
        if (err instanceof CircleError) {
          const { status, message } = CIRCLE_ERRORS[err.code];
          res.status(status).json({ error: err.code, message });
          return;
        }
        console.error('[wick/mcp-server] /api failed:', err);
        res.status(500).json({ error: 'server_error', message: 'Something went wrong on my end — try again in a moment.' });
      }
    };

  router.get('/api/me', withGrant(async (grant, _req, res) => {
    const [user, household, membership] = await Promise.all([
      store.getUser(grant.userId),
      store.getHousehold(grant.householdId),
      store.getMembership(grant.householdId, grant.userId),
    ]);
    if (!user || !household || !membership) throw new CircleError('not_a_member');
    res.json({
      user: { userId: user.userId, name: user.name, email: user.email },
      household: { householdId: household.householdId, name: household.name, residentName: household.residentName },
      membership: { role: membership.role, status: membership.status },
    });
  }));

  router.get('/api/circle', withGrant(async (grant, _req, res) => {
    const membership = await store.getMembership(grant.householdId, grant.userId);
    // INV-9: who else is in the circle is the household's to tell, so only
    // once the resident has allowed this person — or to the organiser who
    // set it up, who has to see the television connect before anyone can be
    // asked anything.
    const maySee = membership?.status === 'allowed' || (membership?.role === 'organiser' && membership.status === 'pending');
    if (!maySee) {
      res.status(403).json({ error: 'not_allowed_yet', message: 'You will see the family circle once you have been allowed on the television.' });
      return;
    }
    res.json(await describeCircle(circle, grant.householdId, grant.userId));
  }));

  router.post('/api/circle/invitations', withGrant(async (grant, _req, res) => {
    const invitation = await createInvitation(circle, grant);
    res.status(201).json({ code: invitation.code, expiresAt: invitation.expiresAt });
  }));

  router.post('/api/televisions', withGrant(async (_grant, req, res) => {
    const code = String((req.body as { code?: unknown } | undefined)?.code ?? '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(code)) {
      res.status(400).json({ error: 'bad_code', message: 'Enter the six digits shown on the television.' });
      return;
    }
    const unavailable = () =>
      res.status(502).json({ error: 'pairing_unavailable', message: 'The television could not be connected just now. Try again in a moment.' });
    if (!claimTelevision || !req.auth) return void unavailable();

    const reply = await claimTelevision(req.auth.token, code);
    if (reply.status === 200) {
      res.json({ connected: true });
      return;
    }
    // Only an answer this server recognises is passed on. Anything else from
    // the pairing service could carry an ARN or an account id.
    const message = PAIRING_REFUSALS[reply.body];
    if (!message) {
      console.error('[wick/mcp-server] pairing service answered', reply.status);
      return void unavailable();
    }
    res.status(reply.status).json({ error: reply.body, message });
  }));

  router.delete('/api/circle/members/:userId', withGrant(async (grant, req, res) => {
    await removeMember(circle, grant, String(req.params.userId));
    res.status(204).end();
  }));

  return router;
}
