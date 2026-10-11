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
import { CircleError, createInvitation, describeCircle, removeMember, requireOrganiser, type CircleDeps, type CircleErrorCode } from './circle.js';
import { isGuest } from './demo.js';
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

/**
 * What the Ring linking function answers (services/edge-ring/lambda/
 * household-link.mjs). It never holds a token: that function keeps them in
 * the household's own secret and tells this server only what is linked.
 */
export interface RingLinkAnswer {
  readonly ok: boolean;
  readonly error?: string;
  readonly linked?: boolean;
  readonly source?: string;
  readonly simulated?: boolean;
  readonly linkedAt?: number;
  readonly expiresAt?: number;
  readonly refreshable?: boolean;
  readonly expired?: boolean;
  readonly devices?: readonly { readonly id?: string; readonly name?: string | null }[];
  readonly heldElsewhere?: number;
  readonly playgroundAllowed?: boolean;
  readonly url?: string;
}

/**
 * A household's Ring link, asked for by household. This server decides who
 * may ask and for which home — the organiser, for the home in their own
 * access token — and passes that household on; the function it calls takes
 * no household from anyone else.
 */
export interface RingLinks {
  status(householdId: string): Promise<RingLinkAnswer>;
  start(householdId: string, userId: string): Promise<RingLinkAnswer>;
  playground(householdId: string, userId: string, token: string): Promise<RingLinkAnswer>;
  disconnect(householdId: string): Promise<RingLinkAnswer>;
}

const RING_UNAVAILABLE = { status: 502, message: 'The doorbell could not be reached just now. Try again in a moment.' };
const RING_REFUSALS: Readonly<Record<string, { status: number; message: string }>> = {
  playground_not_allowed: { status: 403, message: 'This Wick does not take a Playground token.' },
  bad_token: { status: 400, message: 'That does not look like a token. Paste the whole token from Ring’s Developer Playground.' },
  token_refused: { status: 400, message: 'Ring did not accept that token. A Playground token lasts about half an hour: get a fresh one and paste it again.' },
  ring_unreachable: RING_UNAVAILABLE,
};

/**
 * What the family app is shown of a link. Named fields only, so nothing the
 * linking function might one day add reaches a browser unreviewed — and a
 * camera is its name, never Ring's identifier for it.
 */
export function ringLinkView(answer: RingLinkAnswer): Record<string, unknown> {
  if (!answer.linked) return { linked: false, playgroundAllowed: answer.playgroundAllowed === true };
  return {
    linked: true,
    source: answer.source === 'playground' ? 'playground' : 'ring',
    simulated: answer.simulated === true,
    linkedAt: answer.linkedAt,
    ...(answer.expiresAt === undefined ? {} : { expiresAt: answer.expiresAt }),
    refreshable: answer.refreshable === true,
    expired: answer.expired === true,
    cameras: (answer.devices ?? []).map((d) => d.name || 'A Ring device'),
    heldElsewhere: answer.heldElsewhere ?? 0,
    playgroundAllowed: answer.playgroundAllowed === true,
  };
}

export interface ApiOptions {
  readonly claimTelevision?: ClaimTelevision | undefined;
  /** Connecting a home's own Ring account. Absent where the deployment has no Ring. */
  readonly ringLinks?: RingLinks | undefined;
  /** A television in a browser tab, offered to anyone with no Fire TV to hand. */
  readonly virtualTelevisionUrl?: string | undefined;
  /** The households' IANA time zone (one for the deployment, as the Narrator's). */
  readonly timeZone?: string | undefined;
}

export function createApiRouter(circle: CircleDeps, requireAuth: () => RequestHandler, options: ApiOptions = {}): express.Router {
  const { store } = circle;
  const { claimTelevision, ringLinks, virtualTelevisionUrl, timeZone } = options;
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
      user: { userId: user.userId, name: user.name, email: user.email, guest: isGuest(user.userId) },
      household: {
        householdId: household.householdId,
        name: household.name,
        residentName: household.residentName,
        // Where the house is, so the app shows a time as it was there.
        ...(timeZone ? { timeZone } : {}),
        // A demo home's history is written, not lived: the app says so (demoHome.ts).
        ...(household.simulated ? { simulated: true } : {}),
      },
      membership: { role: membership.role, status: membership.status },
      ...(virtualTelevisionUrl ? { virtualTelevisionUrl } : {}),
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

  // --- The home's own Ring link -------------------------------------------
  //
  // The organiser's alone, like inviting and connecting a television: what a
  // home is connected to is theirs to decide. And for the home in their own
  // token — there is no household in any of these requests to read (INV-8).

  /** Runs a Ring action for the organiser of the token's household, and turns its answer into words. */
  const ringAction =
    (act: (links: RingLinks, grant: { userId: string; householdId: string }, req: Request) => Promise<RingLinkAnswer | undefined>): RequestHandler =>
    withGrant(async (grant, req, res) => {
      await requireOrganiser(circle, grant);
      if (!ringLinks) return void res.status(RING_UNAVAILABLE.status).json({ error: 'ring_unavailable', message: RING_UNAVAILABLE.message });

      let answer: RingLinkAnswer | undefined;
      try {
        answer = await act(ringLinks, grant, req);
      } catch (err) {
        console.error('[wick/mcp-server] ring link failed:', (err as Error).name);
        answer = undefined;
      }
      if (!answer) return void res.status(400).json({ error: 'bad_token', message: RING_REFUSALS.bad_token!.message });
      if (!answer.ok) {
        // Only an answer this server recognises is passed on, as with pairing.
        const refusal = (answer.error && RING_REFUSALS[answer.error]) || RING_UNAVAILABLE;
        return void res.status(refusal.status).json({ error: answer.error && RING_REFUSALS[answer.error] ? answer.error : 'ring_unavailable', message: refusal.message });
      }
      res.json(answer.url ? { url: answer.url } : ringLinkView(answer));
    });

  router.get('/api/ring', ringAction((links, grant) => links.status(grant.householdId)));

  router.post('/api/ring/link', ringAction((links, grant) => links.start(grant.householdId, grant.userId)));

  router.post('/api/ring/playground', ringAction(async (links, grant, req) => {
    const token = (req.body as { token?: unknown } | undefined)?.token;
    return typeof token === 'string' ? links.playground(grant.householdId, grant.userId, token) : undefined;
  }));

  router.delete('/api/ring', ringAction((links, grant) => links.disconnect(grant.householdId)));

  return router;
}
