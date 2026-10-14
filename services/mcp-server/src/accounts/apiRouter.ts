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
 *
 * A television can also be connected as the caller's own (`as: 'family'`,
 * packages/contracts familyTelevision.ts). The Lambda decides that too; this
 * router asks first only so the refusal can be a sentence with the
 * resident's name in it.
 *
 * And the language the resident's television speaks (`/api/language`,
 * accounts/language.ts): the organiser asks for another, and that is all
 * this server does about it. The answer is hers, on her television.
 */
import cors from 'cors';
import express, { type ErrorRequestHandler, type Request, type RequestHandler, type Response } from 'express';
import { FAMILY_TV_KIND } from '@wick/contracts';
import {
  CircleError,
  accessOf,
  createInvitation,
  describeCircle,
  isInvitedRole,
  removeFamilyTelevision,
  removeMember,
  removeTelevision,
  requireOrganiser,
  type CircleDeps,
  type CircleErrorCode,
} from './circle.js';
import { isGuest } from './demo.js';
import { DemoDoorRefusal, ringDemoDoorbell, type DemoDoorbellDeps } from './demoDoorbell.js';
import { LanguageRefusal, askForLanguage, readLanguage, takeBackLanguageQuestion, type LanguageDeps } from './language.js';
import { grantOf } from './oauthProvider.js';
import { parseSubscription, type PushStore } from './push.js';
import type { PhotoRoutes } from '../photos/routes.js';

const CIRCLE_ERRORS: Readonly<Record<CircleErrorCode, { status: number; message: string }>> = {
  name_required: { status: 400, message: 'A name is needed.' },
  not_organiser: { status: 403, message: 'Only the person who set this home up can do that.' },
  not_a_member: { status: 404, message: 'That person is not in this family circle.' },
  invitation_invalid: { status: 400, message: 'That invitation has expired. Ask for a new one.' },
  cannot_remove_self: { status: 400, message: 'You cannot remove yourself.' },
  not_a_television: { status: 404, message: 'That television is not connected to this home.' },
  not_your_television: { status: 403, message: 'Only the person whose television it is, or the person who set this home up, can disconnect it.' },
};

/** What a television is connected as, when it is not the resident's: the caller's own. */
export type TelevisionKind = typeof FAMILY_TV_KIND;

/**
 * POSTs a code to the pairing service as the caller. Returns its status and
 * raw body. With `as: 'family'` the television is to be the caller's own.
 * INV-8: a token, a code and a kind — there is no household to pass.
 */
export type ClaimTelevision = (accessToken: string, code: string, as?: TelevisionKind) => Promise<{ status: number; body: string }>;

/** Said to someone the resident has not allowed yet, by this router and for the pairing Lambda's `not_allowed_yet`. */
const ownTelevisionOnceAllowed = (resident: string): string => `You can connect a television of your own once ${resident} has allowed you.`;

/** What the pairing Lambda can answer, in words a person can act on. `resident` is the name to say, where one is said. */
const PAIRING_REFUSALS: Readonly<Record<string, string | ((resident: string) => string)>> = {
  unknown_or_expired_code: 'That code is not on a television right now. Check the six digits.',
  code_expired: 'That code has expired. The television is showing a new one.',
  already_claimed: 'That code has already been used.',
  television_in_another_home: 'That television belongs to another home. It has to be disconnected there first.',
  only_the_organiser_can_connect_a_television: 'Only the person who set this home up can connect a television.',
  not_allowed_yet: ownTelevisionOnceAllowed,
  bad_kind: 'This Wick cannot connect a television of that kind.',
  sign_in_required: 'Link Wick again.',
  invalid_token: 'Link Wick again.',
};

/** Whether the pairing Lambda's answer says it connected the television as a member's own. Its word, never the request's. */
function connectedAsFamily(body: string): boolean {
  try {
    return (JSON.parse(body) as { kind?: unknown } | null)?.kind === FAMILY_TV_KIND;
  } catch {
    return false;
  }
}

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
  /** Finish a sign-in at Ring: only for the organiser and the home that started it. */
  complete(householdId: string, userId: string, completion: string): Promise<RingLinkAnswer>;
  playground(householdId: string, userId: string, token: string): Promise<RingLinkAnswer>;
  disconnect(householdId: string): Promise<RingLinkAnswer>;
}

const RING_UNAVAILABLE = { status: 502, message: 'The doorbell could not be reached just now. Try again in a moment.' };
const RING_REFUSALS: Readonly<Record<string, { status: number; message: string }>> = {
  playground_not_allowed: { status: 403, message: 'This Wick does not take a Playground token.' },
  bad_token: { status: 400, message: 'That does not look like a token. Paste the whole token from Ring’s Developer Playground.' },
  token_refused: { status: 400, message: 'Ring did not accept that token. A Playground token lasts about half an hour: get a fresh one and paste it again.' },
  ring_unreachable: RING_UNAVAILABLE,
  link_expired: { status: 400, message: 'That Ring sign-in has expired or was already used. Start again from the Doorbell card.' },
  link_not_yours: { status: 403, message: 'That Ring sign-in was started by someone else, for another home. Nothing was connected.' },
  exchange_failed: { status: 502, message: 'Ring did not confirm the sign-in. Nothing was connected: start again from the Doorbell card.' },
};

/** The only place a sign-in may send a browser: Ring's own account pages. */
const RING_SIGN_IN = 'https://account.ring.com/';

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
  /** The browsers that asked to be told (accounts/push.ts). Absent: nothing is offered. */
  readonly push?: PushStore | undefined;
  /** The households' IANA time zone (one for the deployment, as the Narrator's). */
  readonly timeZone?: string | undefined;
  /**
   * egress.ts's takeBackFromDevices (INV-2): how a question about the
   * television's language leaves her television when the organiser takes it
   * back. Absent, `/api/language` is read-only — a question that could not
   * be taken back is not one this server will ask.
   */
  readonly withdrawCard?: LanguageDeps['withdrawCard'] | undefined;
  /** The mantelpiece: a picture for her television, and how the sender's own stand (photos/routes.ts). */
  readonly photos?: PhotoRoutes | undefined;
  /** A demo home's stand-in doorbell (accounts/demoDoorbell.ts). Absent, the route is not there. */
  readonly demoDoorbell?: DemoDoorbellDeps | undefined;
  /** Ask by voice: one spoken question, turned into words (hear/routes.ts). */
  readonly hear?: readonly (RequestHandler | ErrorRequestHandler)[] | undefined;
}

export function createApiRouter(circle: CircleDeps, requireAuth: () => RequestHandler, options: ApiOptions = {}): express.Router {
  const { store } = circle;
  const { claimTelevision, ringLinks, virtualTelevisionUrl, timeZone, push, withdrawCard, photos, demoDoorbell, hear } = options;
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

  // `role: 'neighbour'` invites somebody for the door and for ringing only (packages/contracts circle.ts); with none it is family.
  router.post('/api/circle/invitations', withGrant(async (grant, req, res) => {
    const asked: unknown = (req.body as { role?: unknown } | undefined)?.role;
    if (asked !== undefined && !isInvitedRole(asked)) {
      res.status(400).json({ error: 'bad_role', message: 'An invitation is for family or for a neighbour.' });
      return;
    }
    const invitation = await createInvitation(circle, grant, asked);
    res.status(201).json({ code: invitation.code, expiresAt: invitation.expiresAt, role: invitation.role ?? 'family' });
  }));

  // With no `as` the television is the resident's, and the organiser's to connect — as it always was.
  // With `as: 'family'` it is the caller's own: for the organiser or a family member the resident has allowed.
  router.post('/api/televisions', withGrant(async (grant, req, res) => {
    const body = req.body as { code?: unknown; as?: unknown } | undefined;
    const code = String(body?.code ?? '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(code)) {
      res.status(400).json({ error: 'bad_code', message: 'Enter the six digits shown on the television.' });
      return;
    }
    const as: unknown = body?.as;
    if (as !== undefined && as !== FAMILY_TV_KIND) {
      res.status(400).json({ error: 'bad_kind', message: PAIRING_REFUSALS.bad_kind });
      return;
    }

    // The name said in a refusal. Read only for a television of one's own: the resident's is connected as it always was.
    let resident = 'the person at home';
    if (as === FAMILY_TV_KIND) {
      const [membership, household] = await Promise.all([
        store.getMembership(grant.householdId, grant.userId),
        store.getHousehold(grant.householdId),
      ]);
      // A neighbour is asked two things and shown nothing (AGENTS.md): there is nothing for a television of theirs
      // to show. Said first, so a neighbour still waiting is not told that being allowed would change it.
      if (membership?.role === 'neighbour') {
        res.status(403).json({ error: 'not_for_a_neighbour', message: 'A neighbour cannot connect a television.' });
        return;
      }
      // INV-9: nothing of the home goes to a television before the resident has allowed its owner. Somebody still
      // waiting is told what will change that; somebody turned down or removed, what stands (circle.ts's own words).
      const access = accessOf(membership, household);
      if (!access.ok) {
        const message = access.reason === 'waiting' && household ? ownTelevisionOnceAllowed(household.residentName) : access.say;
        res.status(403).json({ error: 'not_allowed_yet', message });
        return;
      }
      resident = access.household.residentName;
    }

    const unavailable = () =>
      res.status(502).json({ error: 'pairing_unavailable', message: 'The television could not be connected just now. Try again in a moment.' });
    if (!claimTelevision || !req.auth) return void unavailable();

    const reply = as === undefined ? await claimTelevision(req.auth.token, code) : await claimTelevision(req.auth.token, code, as);
    if (reply.status === 200) {
      res.json({ connected: true, ...(connectedAsFamily(reply.body) ? { kind: FAMILY_TV_KIND } : {}) });
      return;
    }
    // Only an answer this server recognises is passed on. Anything else from
    // the pairing service could carry an ARN or an account id.
    const refusal = PAIRING_REFUSALS[reply.body];
    if (!refusal) {
      console.error('[wick/mcp-server] pairing service answered', reply.status);
      return void unavailable();
    }
    res.status(reply.status).json({ error: reply.body, message: typeof refusal === 'string' ? refusal : refusal(resident) });
  }));

  // Disconnects a television from the home in the caller's own token (INV-8): there is no household here to name.
  router.delete('/api/televisions/:deviceId', withGrant(async (grant, req, res) => {
    const deviceId = String(req.params.deviceId);
    // A television's id as pairing makes it. Anything else is not one, and is not looked for.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(deviceId)) throw new CircleError('not_a_television');
    await removeTelevision(circle, grant, deviceId);
    res.status(204).end();
  }));

  // Disconnects a member's own television: theirs to do, and the organiser's for anyone's. Never the resident's television.
  router.delete('/api/family-televisions/:deviceId', withGrant(async (grant, req, res) => {
    const deviceId = String(req.params.deviceId);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(deviceId)) throw new CircleError('not_a_television');
    await removeFamilyTelevision(circle, grant, deviceId);
    res.status(204).end();
  }));

  router.delete('/api/circle/members/:userId', withGrant(async (grant, req, res) => {
    await removeMember(circle, grant, String(req.params.userId));
    res.status(204).end();
  }));

  // --- The language her television speaks ----------------------------------
  //
  // Read by the family she allows; asked for by the organiser alone; changed
  // by nobody here — only her press on her own television does that
  // (accounts/language.ts). The household is the token's in all three: there
  // is none in any of these requests to read (INV-8).

  /** Runs one of the three, and turns a refusal into the sentence it carries. */
  const languageRoute =
    (act: (grant: { userId: string; householdId: string }, req: Request) => Promise<object>): RequestHandler =>
    withGrant(async (grant, req, res) => {
      try {
        res.json(await act(grant, req));
      } catch (err) {
        if (!(err instanceof LanguageRefusal)) throw err;
        res.status(err.status).json({ error: err.code, message: err.message });
      }
    });

  router.get('/api/language', languageRoute((grant) => readLanguage({ store, now: circle.now, timeZone }, grant)));

  if (withdrawCard) {
    const language: LanguageDeps = { store, sendCard: circle.sendCard, withdrawCard, now: circle.now, timeZone };

    router.post('/api/language', languageRoute(async (grant, req) => {
      // The language, and nothing else: who is asking, and for which home, are the token's.
      const { view, say } = await askForLanguage(language, grant, (req.body as { language?: unknown } | undefined)?.language);
      return { ...view, say };
    }));

    router.delete('/api/language/question', languageRoute(async (grant) => {
      const { view, say } = await takeBackLanguageQuestion(language, grant);
      return { ...view, say };
    }));
  }

  // --- The mantelpiece: a picture for her television -------------------------
  //
  // Behind the same sign-in as everything above. What the two routes do,
  // and why the body of one is read the way it is, is photos/routes.ts.
  if (photos) {
    router.post('/api/photos', ...photos.send);
    router.get('/api/photos', photos.list);
  }

  // --- A demo home's stand-in doorbell ---------------------------------------
  //
  // Somebody made to arrive at a demo home's door, for the Door agent to take
  // through its own path (accounts/demoDoorbell.ts). The body names a visitor
  // and nothing else is read from it: the home is the token's (INV-8).
  if (demoDoorbell) {
    router.post('/api/demo/doorbell', withGrant(async (grant, req, res) => {
      try {
        res.json(await ringDemoDoorbell(demoDoorbell, grant, req.body, req.get('idempotency-key')));
      } catch (err) {
        if (!(err instanceof DemoDoorRefusal)) throw err;
        res.status(err.status).json({ error: err.code, message: err.message });
      }
    }));
  }
  // --- Ask by voice ------------------------------------------------------------
  //
  // Behind the same sign-in. One short utterance in, its words out; the page
  // then asks them as if they had been typed. What is read, in which order,
  // and what is never kept, is hear/routes.ts.
  if (hear) router.post('/api/hear', ...hear);

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
      if (answer.url !== undefined) {
        // The page opens this address. It is Ring's sign-in or it is nothing.
        if (!answer.url.startsWith(RING_SIGN_IN)) return void res.status(RING_UNAVAILABLE.status).json({ error: 'ring_unavailable', message: RING_UNAVAILABLE.message });
        return void res.json({ url: answer.url });
      }
      res.json(ringLinkView(answer));
    });

  // Being told when the family app is closed (Web Push). A browser is kept
  // under the person the token is for; nothing here names a household.
  const NO_PUSH = { error: 'push_unavailable', message: 'This Wick cannot send notifications yet.' };

  router.get('/api/push', withGrant(async (_grant, _req, res) => {
    const publicKey = await push?.publicKey();
    res.json(publicKey ? { available: true, publicKey } : { available: false });
  }));

  router.post('/api/push', withGrant(async (grant, req, res) => {
    if (!push || !(await push.publicKey())) return void res.status(503).json(NO_PUSH);
    const subscription = parseSubscription(req.body);
    if (!subscription) return void res.status(400).json({ error: 'invalid_subscription', message: 'That is not something a browser can be told through.' });
    await push.save(grant.userId, subscription, Date.now());
    res.status(204).end();
  }));

  router.delete('/api/push', withGrant(async (grant, req, res) => {
    const endpoint = (req.body as { endpoint?: unknown } | undefined)?.endpoint;
    if (push && typeof endpoint === 'string' && endpoint.length <= 2048) await push.remove(grant.userId, endpoint);
    res.status(204).end();
  }));

  router.get('/api/ring', ringAction((links, grant) => links.status(grant.householdId)));

  router.post('/api/ring/link', ringAction((links, grant) => links.start(grant.householdId, grant.userId)));

  router.post('/api/ring/link/complete', ringAction(async (links, grant, req) => {
    const completion = (req.body as { completion?: unknown } | undefined)?.completion;
    // Not a completion value at all: answered as an expired one, without asking.
    return typeof completion === 'string' ? links.complete(grant.householdId, grant.userId, completion) : { ok: false, error: 'link_expired' };
  }));

  router.post('/api/ring/playground', ringAction(async (links, grant, req) => {
    const token = (req.body as { token?: unknown } | undefined)?.token;
    return typeof token === 'string' ? links.playground(grant.householdId, grant.userId, token) : undefined;
  }));

  router.delete('/api/ring', ringAction((links, grant) => links.disconnect(grant.householdId)));

  return router;
}
