/**
 * Auth is mandatory for Alexa+ add-ons (verified, docs/WICK-TECHNICAL.md §7.3):
 *   - return 401 with NO WWW-Authenticate header when unauthenticated
 *   - host Protected Resource Metadata at /.well-known/oauth-protected-resource
 *   - host Authorization Server Metadata at /.well-known/oauth-authorization-server
 *   - advertise code_challenge_methods_supported: ["S256"]
 *   - OAuth 2.1 authorization code + PKCE
 *   - `resource` parameter set to the MCP server's canonical URI
 *   - Bearer token in Authorization on authenticated requests
 *
 * This server is both its own Authorization Server and Resource Server — a
 * scope simplification matching S1's pairing design ("household identity is
 * simplified for this pass... a household is provisioned out of band"). The
 * whole OAuth wire protocol (PRM, AS metadata, dynamic client registration,
 * PKCE-validated code exchange) is the official SDK's `mcpAuthRouter`; this
 * file supplies only the `OAuthServerProvider` — what it means to authorize
 * and to hold a token — as an in-memory, single-household store.
 *
 * Consent is a real interactive step, not auto-approved: `authorize()` renders
 * a one-button confirmation page and a second same-origin route
 * (`/authorize/approve`) finalizes the redirect with the code. There is
 * exactly one household in this deployment, so "approve" always means the
 * same household — a household selector is a production concern, not a
 * hackathon one.
 */
import { randomBytes } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

/** The one household this deployment serves. A production build reads this per-request. */
export const HOUSEHOLD_ID = process.env.WICK_HOUSEHOLD_ID ?? 'dev-household';

const ACCESS_TOKEN_TTL_SEC = 3600;

interface PendingAuthorization {
  readonly clientId: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
  readonly resource?: URL;
  readonly scopes: string[];
  readonly state?: string;
}

let clients = new Map<string, OAuthClientInformationFull>();
let pendingByApprovalCode = new Map<string, PendingAuthorization>();
let issuedAuthCodes = new Map<string, PendingAuthorization>();
let issuedTokens = new Map<string, AuthInfo>();

/** Test-only reset — the module holds process-lifetime state by design (see file header). */
export function __resetAuthStateForTest(): void {
  clients = new Map();
  pendingByApprovalCode = new Map();
  issuedAuthCodes = new Map();
  issuedTokens = new Map();
}

const clientsStore: OAuthRegisteredClientsStore = {
  getClient(clientId) {
    return clients.get(clientId);
  },
  registerClient(client) {
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: randomBytes(16).toString('base64url'),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    clients.set(full.client_id, full);
    return full;
  },
};

function renderConsentPage(res: Response, approveUrl: URL): void {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html>
<html><body style="font-family:system-ui,sans-serif;max-width:420px;margin:96px auto;text-align:center;color:#1a1a1a">
<h2>Wick</h2>
<p>Allow this app to read and send notes for your family's Wick account?</p>
<a href="${approveUrl.toString()}" style="display:inline-block;padding:12px 28px;background:#111;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Approve</a>
</body></html>`);
}

const provider: OAuthServerProvider = {
  clientsStore,

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    const approvalCode = randomBytes(24).toString('base64url');
    pendingByApprovalCode.set(approvalCode, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      scopes: params.scopes ?? [],
      ...(params.resource !== undefined && { resource: params.resource }),
      ...(params.state !== undefined && { state: params.state }),
    });
    const origin = `${res.req.protocol}://${res.req.get('host')}`;
    const approveUrl = new URL('/authorize/approve', origin);
    approveUrl.searchParams.set('approval_code', approvalCode);
    renderConsentPage(res, approveUrl);
  },

  async challengeForAuthorizationCode(_client, authorizationCode: string) {
    const pending = issuedAuthCodes.get(authorizationCode);
    if (!pending) throw new Error('invalid_grant');
    return pending.codeChallenge;
  },

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    const pending = issuedAuthCodes.get(authorizationCode);
    if (!pending || pending.clientId !== client.client_id) throw new Error('invalid_grant');
    issuedAuthCodes.delete(authorizationCode);
    return issueTokens(client.client_id, pending.scopes, pending.resource);
  },

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    for (const [token, info] of issuedTokens) {
      if (info.extra?.refreshToken === refreshToken && info.clientId === client.client_id) {
        issuedTokens.delete(token);
        return issueTokens(client.client_id, scopes ?? info.scopes, info.resource);
      }
    }
    throw new Error('invalid_grant');
  },

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const info = issuedTokens.get(token);
    if (!info) throw new Error('invalid_token');
    if (info.expiresAt !== undefined && info.expiresAt * 1000 < Date.now()) {
      issuedTokens.delete(token);
      throw new Error('invalid_token');
    }
    return info;
  },
};

function issueTokens(clientId: string, scopes: string[], resource?: URL): OAuthTokens {
  const accessToken = randomBytes(32).toString('base64url');
  const refreshToken = randomBytes(32).toString('base64url');
  const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SEC;
  issuedTokens.set(accessToken, {
    token: accessToken,
    clientId,
    scopes,
    expiresAt,
    ...(resource !== undefined && { resource }),
    extra: { refreshToken },
  });
  return {
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: ACCESS_TOKEN_TTL_SEC,
    refresh_token: refreshToken,
    scope: scopes.join(' '),
  };
}

/**
 * Mounts the full OAuth surface (PRM, AS metadata, register/authorize/token/
 * revoke) plus this module's own `/authorize/approve` consent-confirmation
 * route. `issuerUrl` doubles as the resource server URL — this server is both.
 */
export function createAuthRouter(issuerUrl: URL): express.Router {
  const router = express.Router();
  router.use(
    mcpAuthRouter({
      provider,
      issuerUrl,
      scopesSupported: ['wick:family'],
      resourceName: 'Wick',
    }),
  );

  router.get('/authorize/approve', (req: Request, res: Response) => {
    const approvalCode = String(req.query.approval_code ?? '');
    const pending = pendingByApprovalCode.get(approvalCode);
    if (!pending) {
      res.status(400).send('unknown_or_expired_approval');
      return;
    }
    pendingByApprovalCode.delete(approvalCode);
    const authorizationCode = randomBytes(24).toString('base64url');
    issuedAuthCodes.set(authorizationCode, pending);

    const redirect = new URL(pending.redirectUri);
    redirect.searchParams.set('code', authorizationCode);
    if (pending.state !== undefined) redirect.searchParams.set('state', pending.state);
    res.redirect(302, redirect.toString());
  });

  return router;
}

/**
 * Resource-server-side gate. §7.3 requires 401 with NO WWW-Authenticate header
 * when unauthenticated. Omitting `resourceMetadataUrl` only drops the header's
 * `resource_metadata` attribute in the installed SDK (1.30.0) —
 * `requireBearerAuth` still unconditionally sets the header on every 401/403
 * (verified in node_modules/@modelcontextprotocol/sdk .../middleware/bearerAuth.js).
 * So the header is stripped here at the response layer instead.
 */
export function requireAuth(): express.RequestHandler {
  const bearerAuth = requireBearerAuth({ verifier: provider });
  return (req, res, next) => {
    const setHeader = res.setHeader.bind(res);
    res.setHeader = ((name: string, value: number | string | readonly string[]) => {
      if (name.toLowerCase() === 'www-authenticate') return res;
      return setHeader(name, value);
    }) as typeof res.setHeader;
    void bearerAuth(req, res, next);
  };
}
