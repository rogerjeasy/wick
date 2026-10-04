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
import express, { type Request, type Response } from 'express';
import { acceptInvitation, CircleError, createHousehold, describeInvitation, invitationNeedsAnswer, type CircleDeps } from './circle.js';
import { IdentityError, type Identity, type IdentityErrorCode, type IdentityProvider } from './identity.js';
import type { PendingAuthorization, WickOAuth } from './oauthProvider.js';
import {
  consentPage,
  expiredPage,
  forgotPage,
  householdPage,
  joinPage,
  refusedPage,
  resetPage,
  signInPage,
  signUpPage,
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
  const router = express.Router();
  router.use('/account', express.urlencoded({ extended: false }));

  const html = (res: Response, page: string, status = 200): void => {
    res.status(status).setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(page);
  };
  const back = (res: Response, tx: string): void => res.redirect(303, `/account?tx=${encodeURIComponent(tx)}`);

  const setSession = async (res: Response, who: Identity): Promise<void> => {
    const token = randomToken();
    await store.putRecord('SESSION', hashToken(token), who, now() + SESSION_TTL_MS);
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
    opts: { newHome?: boolean; error?: string } = {},
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
      selected: invitedTo,
      error: opts.error,
    }));
  };

  router.get('/account', async (req, res) => {
    const tx = typeof req.query.tx === 'string' ? req.query.tx : '';
    const pending = await pendingFor(res, tx);
    if (!pending) return;
    const view = req.query.view;
    const user = await currentUser(req);
    if (user) return renderSignedIn(res, tx, pending, user, { newHome: view === 'new-home' });
    if (view === 'sign-up') return html(res, signUpPage({ tx }));
    if (view === 'forgot') return html(res, forgotPage({ tx }));
    html(res, signInPage({ tx }));
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
      html(res, signInPage({ tx, email, error: messageFor(err) }));
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
      html(res, signInPage({ tx, email, notice: 'Your email is confirmed. Sign in to continue.' }));
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
      html(res, signInPage({ tx, email, notice: 'Your password is changed. Sign in with the new one.' }));
    } catch (err) {
      html(res, resetPage({ tx, email, error: messageFor(err) }));
    }
  });

  router.post('/account/sign-out', async (req, res) => {
    const tx = field(req, 'tx');
    const token = readCookie(req, SESSION_COOKIE);
    if (token) await store.deleteRecord('SESSION', hashToken(token));
    res.setHeader('set-cookie', `${SESSION_COOKIE}=; Path=/account; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
    back(res, tx);
  });

  router.post('/account/household', async (req, res) => {
    const tx = field(req, 'tx');
    const pending = await pendingFor(res, tx);
    if (!pending) return;
    const user = await currentUser(req);
    if (!user) return back(res, tx);
    try {
      await createHousehold(circle, user, { residentName: field(req, 'residentName') });
      back(res, tx);
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
      await acceptInvitation(circle, user, pending.invite ?? '');
      back(res, tx);
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
