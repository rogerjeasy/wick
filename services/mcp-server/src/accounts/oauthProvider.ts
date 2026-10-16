/**
 * The authorization server behind the MCP endpoint, with its state in
 * DynamoDB instead of the process's memory.
 *
 * The OAuth wire protocol — metadata, dynamic client registration, PKCE,
 * the token endpoint — is still the official SDK's `mcpAuthRouter`
 * (../auth.ts). This supplies what it means to authorize and to hold a
 * token, and two things changed from the first version:
 *
 *   - Nothing is issued without a person. `authorize()` only parks the
 *     request and sends the browser to the sign-in pages
 *     (accountRouter.ts); a code exists only after a signed-in member of a
 *     household pressed Approve.
 *   - Every token names the person and the household it is for (INV-8).
 *     Tools read the household from there and nowhere else.
 *
 * It also means a redeploy no longer signs everyone out, and the stack can
 * stay up through judging without anyone linking again.
 *
 * And every token is for this server, and only this one (RFC 8707,
 * resource indicators; MCP 2025-11-25, Authorization: token audience
 * binding). A client may name the resource it wants a token for; one that
 * is not this server is refused at /authorize and at /token
 * (`invalid_target`), and a token is bound to this server's resource when
 * the client named none. A token bound to anything else is refused at every
 * request — a token minted for another server is never good here.
 */
import type { Response } from 'express';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidGrantError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { checkResourceAllowed } from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AccountStore } from './store.js';
import { hashToken, randomId, randomToken } from './tokens.js';

const ACCESS_TOKEN_TTL_SEC = 60 * 60;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;
/** How long someone has to sign up, confirm their email and press Approve. */
const PENDING_TTL_MS = 30 * 60 * 1000;
const CLIENT_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/** An /authorize request waiting for a person to sign in and approve it. */
export interface PendingAuthorization {
  readonly clientId: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly state?: string;
  readonly resource?: string;
  /** An invitation code the app passed along (?invite=), so the pages can offer to join. */
  readonly invite?: string;
  /** The app's demo button (?demo=1). Honoured only where the deployment allows it (accounts/demo.ts). */
  readonly demo?: boolean;
}

/** Who a token is for. INV-8: this is the only source of a request's household. */
export interface Grant {
  readonly clientId: string;
  readonly userId: string;
  readonly householdId: string;
  readonly scopes: readonly string[];
  readonly resource?: string;
}

/** A stored access token: its grant, and when it stops working (seconds since the epoch, as AuthInfo wants). */
interface AccessRecord extends Grant {
  readonly expiresAt: number;
}

interface CodeRecord extends Grant {
  readonly codeChallenge: string;
  readonly redirectUri: string;
}

export interface WickOAuth {
  readonly provider: OAuthServerProvider;
  loadPending(tx: string): Promise<PendingAuthorization | undefined>;
  /** Approve: mint a one-time code for this person and household, and return where to send the browser. */
  approve(tx: string, pending: PendingAuthorization, userId: string, householdId: string): Promise<string>;
}

/** The person and household behind a verified token. */
export function grantOf(auth: AuthInfo | undefined): { userId: string; householdId: string } | undefined {
  const userId = auth?.extra?.userId;
  const householdId = auth?.extra?.householdId;
  return typeof userId === 'string' && typeof householdId === 'string' ? { userId, householdId } : undefined;
}

/**
 * `resource`: this server's canonical resource (auth.ts: the issuer URL, as
 * the protected resource metadata gives it). A resource is this server's
 * when it is on the same origin, at or under that path — the SDK's own rule
 * (`checkResourceAllowed`), so `https://host/` and `https://host/mcp` are
 * both this server and `https://elsewhere/mcp` is not.
 */
export function createWickOAuth(store: AccountStore, now: () => number = Date.now, resource: URL = new URL('http://127.0.0.1:3300/')): WickOAuth {
  const ours = (requested: string | URL): boolean => {
    try {
      return checkResourceAllowed({ requestedResource: requested, configuredResource: resource });
    } catch {
      return false; // Not a URL at all.
    }
  };
  /** The resource a grant is bound to: what was asked for, checked; or this server, when nothing was. */
  const boundTo = (requested: string | URL | undefined): string => {
    if (requested === undefined) return resource.href;
    if (!ours(requested)) throw new InvalidTargetError('That resource is not this server.');
    return new URL(requested).href;
  };

  const clientsStore: OAuthRegisteredClientsStore = {
    async getClient(clientId) {
      return store.getRecord<OAuthClientInformationFull>('OAUTH#CLIENT', clientId);
    },
    async registerClient(client) {
      const full = client as OAuthClientInformationFull;
      await store.putRecord('OAUTH#CLIENT', full.client_id, full, now() + CLIENT_TTL_MS);
      return full;
    },
  };

  const issueTokens = async (grant: Grant): Promise<OAuthTokens> => {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const expiresAtMs = now() + ACCESS_TOKEN_TTL_SEC * 1000;
    const access: AccessRecord = { ...grant, expiresAt: Math.floor(expiresAtMs / 1000) };
    // Filed under the person as well, so their export can list the apps they linked and deleting their account ends every one.
    await Promise.all([
      store.putRecord('OAUTH#AT', hashToken(accessToken), access, expiresAtMs, grant.userId),
      store.putRecord('OAUTH#RT', hashToken(refreshToken), grant, now() + REFRESH_TOKEN_TTL_MS, grant.userId),
    ]);
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: ACCESS_TOKEN_TTL_SEC,
      refresh_token: refreshToken,
      scope: grant.scopes.join(' '),
    };
  };

  const provider: OAuthServerProvider = {
    clientsStore,

    async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
      // RFC 8707: a token is never begun for another server.
      const bound = boundTo(params.resource);
      const tx = randomId();
      const body = res.req.body as { invite?: unknown; demo?: unknown } | undefined;
      const invite = res.req.query.invite ?? body?.invite;
      const demo = (res.req.query.demo ?? body?.demo) === '1';
      const pending: PendingAuthorization = {
        clientId: client.client_id,
        codeChallenge: params.codeChallenge,
        redirectUri: params.redirectUri,
        scopes: params.scopes ?? [],
        ...(params.state === undefined ? {} : { state: params.state }),
        resource: bound,
        ...(typeof invite === 'string' && invite ? { invite } : {}),
        ...(demo ? { demo: true } : {}),
      };
      await store.putRecord('OAUTH#PENDING', tx, pending, now() + PENDING_TTL_MS);
      // Relative: the pages are on this origin, whatever scheme the proxy in
      // front reports. (The first version built an absolute http:// link.)
      res.redirect(302, `/account?tx=${encodeURIComponent(tx)}`);
    },

    async challengeForAuthorizationCode(_client, authorizationCode) {
      const record = await store.getRecord<CodeRecord>('OAUTH#CODE', hashToken(authorizationCode));
      if (!record) throw new InvalidGrantError('Unknown or expired authorization code');
      return record.codeChallenge;
    },

    async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri, requested) {
      // Taken, not read: a code is good for one exchange.
      const record = await store.takeRecord<CodeRecord>('OAUTH#CODE', hashToken(authorizationCode));
      if (!record || record.clientId !== client.client_id) throw new InvalidGrantError('Unknown or expired authorization code');
      if (redirectUri !== undefined && redirectUri !== record.redirectUri) throw new InvalidGrantError('redirect_uri does not match');
      const { codeChallenge: _challenge, redirectUri: _redirect, ...grant } = record;
      // A code approved before resources were bound carries none: it is this server's, as every grant here is.
      const bound = grant.resource ?? resource.href;
      if (requested !== undefined && boundTo(requested) !== bound) throw new InvalidTargetError('That resource is not the one this code was approved for.');
      return issueTokens({ ...grant, resource: bound });
    },

    async exchangeRefreshToken(client, refreshToken, scopes, requested) {
      // Checked before the token is taken: a refused request leaves it good.
      if (requested !== undefined) boundTo(requested);
      const grant = await store.takeRecord<Grant>('OAUTH#RT', hashToken(refreshToken));
      if (!grant || grant.clientId !== client.client_id) throw new InvalidGrantError('Unknown or revoked refresh token');
      if (grant.resource !== undefined && !ours(grant.resource)) throw new InvalidGrantError('That refresh token is not for this server.');
      const bound = grant.resource ?? resource.href;
      if (requested !== undefined && new URL(requested).href !== bound) throw new InvalidTargetError('That resource is not the one this token was approved for.');
      // A refresh can narrow the scopes it was granted, never widen them.
      const narrowed = scopes ? grant.scopes.filter((s) => scopes.includes(s)) : grant.scopes;
      return issueTokens({ ...grant, scopes: narrowed, resource: bound });
    },

    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const grant = await store.getRecord<AccessRecord>('OAUTH#AT', hashToken(token));
      if (!grant) throw new InvalidTokenError('Unknown or expired access token');
      // RFC 8707 audience: a token for another resource is not good here. One
      // issued before tokens were bound names none, and was issued by this
      // server for this server: it lives out its hour.
      if (grant.resource !== undefined && !ours(grant.resource)) throw new InvalidTokenError('Unknown or expired access token');
      return {
        token,
        clientId: grant.clientId,
        scopes: [...grant.scopes],
        // The SDK's bearer middleware refuses a token with no expiry.
        expiresAt: grant.expiresAt,
        ...(grant.resource === undefined ? {} : { resource: new URL(grant.resource) }),
        extra: { userId: grant.userId, householdId: grant.householdId },
      };
    },

    /**
     * RFC 7009. Signing out of the family app ends both of its tokens here,
     * instead of leaving them good for an hour and a month. The app is a
     * public client (no secret; the SDK's handler asks only for its id), so a
     * token is revoked only for the app it was issued to: anybody else's
     * request is answered the same 200 and changes nothing, as the RFC has it
     * for a token the server does not recognise.
     */
    async revokeToken(client, request) {
      const hash = hashToken(request.token);
      const [access, refresh] = await Promise.all([
        store.getRecord<AccessRecord>('OAUTH#AT', hash),
        store.getRecord<Grant>('OAUTH#RT', hash),
      ]);
      await Promise.all([
        access?.clientId === client.client_id ? store.deleteRecord('OAUTH#AT', hash) : undefined,
        refresh?.clientId === client.client_id ? store.deleteRecord('OAUTH#RT', hash) : undefined,
      ]);
    },
  };

  return {
    provider,

    loadPending(tx) {
      return store.getRecord<PendingAuthorization>('OAUTH#PENDING', tx);
    },

    async approve(tx, pending, userId, householdId) {
      const code = randomToken();
      const record: CodeRecord = {
        clientId: pending.clientId,
        userId,
        householdId,
        scopes: pending.scopes,
        codeChallenge: pending.codeChallenge,
        redirectUri: pending.redirectUri,
        ...(pending.resource === undefined ? {} : { resource: pending.resource }),
      };
      await store.putRecord('OAUTH#CODE', hashToken(code), record, now() + AUTHORIZATION_CODE_TTL_MS);
      await store.deleteRecord('OAUTH#PENDING', tx);

      const redirect = new URL(pending.redirectUri);
      redirect.searchParams.set('code', code);
      if (pending.state !== undefined) redirect.searchParams.set('state', pending.state);
      return redirect.toString();
    },
  };
}
