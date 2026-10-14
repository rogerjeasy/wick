/**
 * /account — where a person signs in and decides, between /authorize and
 * the redirect back to the app.
 *
 * Every page belongs to one parked /authorize request, named by `tx`
 * (oauthProvider.ts). A `tx` is 120 random bits known only to the browser
 * that began the request, so a form post that carries one was not forged
 * from another site; the sign-in cookie is SameSite=Lax as well.
 *
 * The order is fixed, and each step is skipped once it is true:
 *
 *   signed in?  ->  invited somewhere?  ->  belongs to a home?  ->  Approve
 *
 * Only Approve issues a code, and only for a household the signed-in
 * person belongs to (INV-8).
 */
import cors from 'cors';
import express, { type Request, type Response } from 'express';
import { acceptInvitation, CircleError, createHousehold, describeInvitation, invitationNeedsAnswer, type CircleDeps } from './circle.js';
import { createDemoLimiter, DEMO_HOME_NAME, DEMO_RESIDENT_NAME, isGuest, newGuest } from './demo.js';
import { IdentityError, type Identity, type IdentityErrorCode, type IdentityProvider } from './identity.js';
import type { PendingAuthorization, WickOAuth } from './oauthProvider.js';
import {
  consentPage,
  demoBusyPage,
  expiredPage,
  forgotPage,
  householdPage,
  joinPage,
  refusedPage,
  resetPage,
  signInPage,
  signUpPage,
  signedOutPage,
  verifyPage,
  type ConsentHousehold,
} from './pages.js';
import { hashToken, randomToken } from './tokens.js';

const SESSION_COOKIE = 'wick_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD_CHARS = 8;

const IDENTITY_MESSAGES: Readonly<Record<IdentityErrorCode, string>> = {
  email_taken: 'There is already an account with that email. Sign in instead.',
  weak_password: `Choose a password of ${MIN_PASSWORD_CHARS} characters or more.`,
  wrong_credentials: 'That email and password do not match. Try again, or reset your password.',
  not_confirmed: 'Confirm your email first. We have sent you a code.',
  bad_code: 'That code is not right. Check the email and try again.',
  expired_code: 'That code has expired. Ask for a new one.',
  too_many_attempts: 'Too many attempts. Wait a few minutes and try again.',
  unavailable: 'Sign-in is not working right now. Try again in a moment.',
};

const messageFor = (err: unknown): string =>
  err instanceof IdentityError ? IDENTITY_MESSAGES[err.code] : IDENTITY_MESSAGES.unavailable;

export interface AccountRouterDeps {
  readonly circle: CircleDeps;
  readonly identity: IdentityProvider;
  readonly oauth: WickOAuth;
  /** Decides whether the cookie is marked Secure. */
  readonly issuerUrl: URL;
  /** Whether a visitor may become an anonymous guest in one click (demo.ts). Off unless set. */
  readonly demoAccounts?: boolean | undefined;
  /** How many guests an hour (demo.ts DEMO_ACCOUNTS_PER_HOUR unless set). */
  readonly demoAccountsPerHour?: number | undefined;
  /** Writes a new demo home its simulated history (demoHome.ts). Never called for any other home. */
  readonly seedDemoHome?: ((householdId: string) => Promise<void>) | undefined;
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=') || undefined;
  }
  return undefined;
}

const field = (req: Request, name: string): string => {
  const value = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' ? value : '';
};

export function createAccountRouter(deps: AccountRouterDeps): express.Router {
  const { circle, identity, oauth } = deps;
  const { store, now } = circle;
  const secure = deps.issuerUrl.protocol === 'https:';
  const demo = deps.demoAccounts === true;
  const demoLimiter = createDemoLimiter(now, deps.demoAccountsPerHour);
  const router = express.Router();
  router.use('/account', express.urlencoded({ extended: false }));

  const html = (res: Response, page: string, status = 200): void => {
    res.status(status).setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(page);
  };
  /**
   * Back to the page for this request. `home` names a household the person
   * has just joined or set up: the index that lists a person's homes lags a
   * write by a moment, and the page must not ask "Who is this for?" twice.
   * It is only a hint — the page checks the membership itself.
   */
  const back = (res: Response, tx: string, home?: string): void =>
    res.redirect(303, `/account?tx=${encodeURIComponent(tx)}${home ? `&home=${encodeURIComponent(home)}` : ''}`);

  /**
   * One click, one guest: an account Wick names itself and a demo home of
   * their own, waiting for its resident like any other (demo.ts). Returns
   * undefined, having said so, when the hour's guests have all been made.
   */
  const startDemo = async (res: Response, tx: string): Promise<{ guest: Identity; householdId: string } | undefined> => {
    if (!demoLimiter.take()) {
      html(res, demoBusyPage(tx), 429);
      return undefined;
    }
    const guest = newGuest(circle.newId());
    await store.putUser({ ...guest, createdAt: now() });
    const household = await createHousehold(circle, guest, { residentName: DEMO_RESIDENT_NAME, name: DEMO_HOME_NAME, simulated: true });
    // An empty demo home is a poorer demo, not a failed one: the guest is made either way.
    await deps.seedDemoHome?.(household.householdId).catch((err: unknown) => {
      console.warn(JSON.stringify({ level: 'warn', msg: 'demo_home_not_seeded', householdId: household.householdId, error: (err as Error).name || String(err) }));
    });
    await setSession(res, guest);
    return { guest, householdId: household.householdId };
  };

  const setSession = async (res: Response, who: Identity): Promise<void> => {
    const token = randomToken();
    // Filed under the person too: deleting their account ends every browser's sign-in (myData.ts).
    await store.putRecord('SESSION', hashToken(token), who, now() + SESSION_TTL_MS, who.userId);
    res.setHeader(
      'set-cookie',
      `${SESSION_COOKIE}=${token}; Path=/account; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`,
    );
  };

  const currentUser = async (req: Request): Promise<Identity | undefined> => {
    const token = readCookie(req, SESSION_COOKIE);
    return token ? store.getRecord<Identity>('SESSION', hashToken(token)) : undefined;
  };

  /** The parked request this page belongs to, or the "expired" page if there is none. */
  const pendingFor = async (res: Response, tx: string): Promise<PendingAuthorization | undefined> => {
    const pending = tx ? await oauth.loadPending(tx) : undefined;
    if (!pending) html(res, expiredPage(), 400);
    return pending;
  };

  /** Everything after sign-in: join, set up a home, or approve. */
  const renderSignedIn = async (
    res: Response,
    tx: string,
    pending: PendingAuthorization,
    user: Identity,
    opts: { newHome?: boolean; error?: string; home?: string | undefined } = {},
  ): Promise<void> => {
    let invitedTo: string | undefined;
    if (pending.invite) {
      const view = await describeInvitation(circle, pending.invite);
      if (view) {
        invitedTo = view.household.householdId;
        const existing = await store.getMembership(view.household.householdId, user.userId);
        if (invitationNeedsAnswer(existing, view.invitation)) {
          return html(res, joinPage({
            tx,
            userName: user.name,
            invitedByName: view.invitedByName,
            householdName: view.household.name,
            residentName: view.household.residentName,
          }));
        }
      }
    }

    const memberships = (await store.listMemberships(user.userId)).filter((m) => m.status !== 'removed');
    // A home the index has not caught up with yet. Read directly, and for
    // this person: a `home` they do not belong to finds nothing.
    const hinted = opts.home ?? invitedTo;
    if (hinted && !memberships.some((m) => m.householdId === hinted)) {
      const direct = await store.getMembership(hinted, user.userId);
      if (direct && direct.status !== 'removed') memberships.push(direct);
    }
    if (memberships.length === 0 || opts.newHome) {
      return html(res, householdPage({ tx, userName: user.name, canGoBack: memberships.length > 0, error: opts.error }));
    }

    const households: ConsentHousehold[] = [];
    for (const m of memberships) {
      const household = await store.getHousehold(m.householdId);
      if (household) households.push({ householdId: m.householdId, name: household.name, residentName: household.residentName, status: m.status });
    }
    const client = await oauth.provider.clientsStore.getClient(pending.clientId);
    html(res, consentPage({
      tx,
      userName: user.name,
      clientName: client?.client_name ?? 'this app',
      households,
      selected: opts.home ?? invitedTo,
      error: opts.error,
    }));
  };

  router.get('/account', async (req, res) => {
    const tx = typeof req.query.tx === 'string' ? req.query.tx : '';
    const pending = await pendingFor(res, tx);
    if (!pending) return;
    const view = req.query.view;
    const home = typeof req.query.home === 'string' ? req.query.home : undefined;
    const user = await currentUser(req);

    // The app's demo button. It acts only for a browser nobody is signed in
    // on, or one a guest is: a real account is never approved without its
    // owner pressing Approve.
    if (demo && pending.demo && (!user || isGuest(user.userId))) {
      let guest = user;
      let householdId: string | undefined;
      if (!guest) {
        const started = await startDemo(res, tx);
        if (!started) return;
        ({ guest, householdId } = started);
      } else {
        householdId = (await store.listMemberships(guest.userId)).find((m) => m.status !== 'removed')?.householdId;
      }
      if (householdId) return res.redirect(302, await oauth.approve(tx, pending, guest.userId, householdId));
      return renderSignedIn(res, tx, pending, guest);
    }

    if (user) return renderSignedIn(res, tx, pending, user, { newHome: view === 'new-home', home });
    if (view === 'sign-up') return html(res, signUpPage({ tx }));
    if (view === 'forgot') return html(res, forgotPage({ tx }));
    html(res, signInPage({ tx, demo }));
  });

  /** Whether the family app should offer its demo button. Nothing here is private. */
  router.get('/account/options', cors(), (_req, res) => {
    res.json({ demo });
  });

  /** The demo button on the sign-in page. It ends on the ordinary Approve page. */
  router.post('/account/demo', async (req, res) => {
    if (!demo) return html(res, refusedPage('There is no demo here. Sign in, or create an account.'), 404);
    const tx = field(req, 'tx');
    if (!(await pendingFor(res, tx))) return;
    const started = await startDemo(res, tx);
    if (started) back(res, tx, started.householdId);
  });

  router.post('/account/sign-in', async (req, res) => {
    const tx = field(req, 'tx');
    if (!(await pendingFor(res, tx))) return;
    const email = field(req, 'email');
    try {
      const who = await identity.signIn({ email, password: field(req, 'password') });
      await store.putUser({ ...who, createdAt: now() });
      await setSession(res, who);
      back(res, tx);
    } catch (err) {
      if (err instanceof IdentityError && err.code === 'not_confirmed') {
        await identity.resendCode({ email }).catch(() => undefined);
        return html(res, verifyPage({ tx, email, notice: IDENTITY_MESSAGES.not_confirmed }));
      }
      html(res, signInPage({ tx, email, demo, error: messageFor(err) }));
    }
  });

  router.post('/account/sign-up', async (req, res) => {
    const tx = field(req, 'tx');
    if (!(await pendingFor(res, tx))) return;
    const name = field(req, 'name').trim();
    const email = field(req, 'email').trim();
    const password = field(req, 'password');
    const refuse = (error: string) => html(res, signUpPage({ tx, name, email, error }));
    if (!name) return refuse('Tell us your name. It is what appears on their television.');
    if (password.length < MIN_PASSWORD_CHARS) return refuse(IDENTITY_MESSAGES.weak_password);
    try {
      await identity.signUp({ email, password, name });
      html(res, verifyPage({ tx, email }));
    } catch (err) {
      refuse(messageFor(err));
    }
  });

  router.post('/account/verify', async (req, res) => {
    const tx = field(req, 'tx');
    if (!(await pendingFor(res, tx))) return;
    const email = field(req, 'email');
    try {
      await identity.confirmSignUp({ email, code: field(req, 'code') });
      html(res, signInPage({ tx, email, demo, notice: 'Your email is confirmed. Sign in to continue.' }));
    } catch (err) {
      html(res, verifyPage({ tx, email, error: messageFor(err) }));
    }
  });

  router.post('/account/resend', async (req, res) => {
    const tx = field(req, 'tx');
    if (!(await pendingFor(res, tx))) return;
    const email = field(req, 'email');
    try {
      await identity.resendCode({ email });
      html(res, verifyPage({ tx, email, notice: 'We sent the code again.' }));
    } catch (err) {
      html(res, verifyPage({ tx, email, error: messageFor(err) }));
    }
  });

  router.post('/account/forgot', async (req, res) => {
    const tx = field(req, 'tx');
    if (!(await pendingFor(res, tx))) return;
    const email = field(req, 'email');
    try {
      await identity.forgotPassword({ email });
    } catch (err) {
      // Only a rate limit is worth telling them about. Anything else would
      // say whether this email has an account.
      if (err instanceof IdentityError && err.code === 'too_many_attempts') {
        return html(res, forgotPage({ tx, email, error: messageFor(err) }));
      }
    }
    html(res, resetPage({ tx, email }));
  });

  router.post('/account/reset', async (req, res) => {
    const tx = field(req, 'tx');
    if (!(await pendingFor(res, tx))) return;
    const email = field(req, 'email');
    const password = field(req, 'password');
    if (password.length < MIN_PASSWORD_CHARS) return html(res, resetPage({ tx, email, error: IDENTITY_MESSAGES.weak_password }));
    try {
      await identity.resetPassword({ email, code: field(req, 'code'), password });
      html(res, signInPage({ tx, email, demo, notice: 'Your password is changed. Sign in with the new one.' }));
    } catch (err) {
      html(res, resetPage({ tx, email, error: messageFor(err) }));
    }
  });

  /** Forgets this browser's sign-in: the row it names, and the cookie. */
  const endSession = async (req: Request, res: Response): Promise<void> => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) await store.deleteRecord('SESSION', hashToken(token));
    res.setHeader('set-cookie', `${SESSION_COOKIE}=; Path=/account; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
  };

  router.post('/account/sign-out', async (req, res) => {
    const tx = field(req, 'tx');
    await endSession(req, res);
    back(res, tx);
  });

  /**
   * Signing out of the family app, last of all. The app has already revoked
   * its own tokens (/revoke); what is left is this server's sign-in cookie,
   * which would otherwise have the next person to press "Sign in" on this
   * browser approved as the last one with a single press. The cookie is
   * SameSite=Lax and lives on this server's origin, so only a page the
   * browser itself goes to — never the app's own fetch — is sent it and can
   * clear it: the app goes here, and is sent back.
   *
   * Back only to an address the app registered as its own (`redirect_uris`),
   * the same addresses /authorize would send it to; anything else ends on a
   * page that says it is done. Signing somebody out is all a link to this
   * can do.
   */
  router.get('/account/sign-out', async (req, res) => {
    await endSession(req, res);
    const clientId = typeof req.query.client_id === 'string' ? req.query.client_id : '';
    const redirectUri = typeof req.query.redirect_uri === 'string' ? req.query.redirect_uri : '';
    const client = clientId ? await oauth.provider.clientsStore.getClient(clientId) : undefined;
    if (redirectUri && client?.redirect_uris.some((uri) => String(uri) === redirectUri)) return res.redirect(303, redirectUri);
    html(res, signedOutPage());
  });

  router.post('/account/household', async (req, res) => {
    const tx = field(req, 'tx');
    const pending = await pendingFor(res, tx);
    if (!pending) return;
    const user = await currentUser(req);
    if (!user) return back(res, tx);
    try {
      const household = await createHousehold(circle, user, { residentName: field(req, 'residentName') });
      back(res, tx, household.householdId);
    } catch (err) {
      if (err instanceof CircleError && err.code === 'name_required') {
        return renderSignedIn(res, tx, pending, user, { newHome: true, error: 'Tell us what you call them.' });
      }
      throw err;
    }
  });

  router.post('/account/join', async (req, res) => {
    const tx = field(req, 'tx');
    const pending = await pendingFor(res, tx);
    if (!pending) return;
    const user = await currentUser(req);
    if (!user) return back(res, tx);
    try {
      const membership = await acceptInvitation(circle, user, pending.invite ?? '');
      back(res, tx, membership.householdId);
    } catch (err) {
      if (err instanceof CircleError) return html(res, refusedPage('That invitation has expired. Ask for a new one.'), 400);
      throw err;
    }
  });

  router.post('/account/approve', async (req, res) => {
    const tx = field(req, 'tx');
    const pending = await pendingFor(res, tx);
    if (!pending) return;
    const user = await currentUser(req);
    if (!user) return back(res, tx);
    const householdId = field(req, 'householdId');
    // INV-8: the household a token is for is one the signed-in person
    // belongs to. Whether they may read it yet is the resident's to say, and
    // is checked on every read (circle.ts checkAccess).
    const membership = householdId ? await store.getMembership(householdId, user.userId) : undefined;
    if (!membership || membership.status === 'removed') {
      return html(res, refusedPage('You are not part of that family circle.'), 403);
    }
    res.redirect(302, await oauth.approve(tx, pending, user.userId, householdId));
  });

  return router;
}
