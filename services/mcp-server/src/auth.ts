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
 * This server is both its own Authorization Server and Resource Server. The
 * OAuth wire protocol (PRM, AS metadata, dynamic client registration,
 * PKCE-validated code exchange) is the official SDK's `mcpAuthRouter`; what
 * it means to authorize and to hold a token is accounts/oauthProvider.ts,
 * and the pages a person signs in on are accounts/accountRouter.ts.
 *
 * INV-8: there is no household in this file or in the environment. A
 * request's household is the one its token was approved for.
 */
import express from 'express';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { createAccountRouter } from './accounts/accountRouter.js';
import type { CircleDeps } from './accounts/circle.js';
import type { IdentityProvider } from './accounts/identity.js';
import { createWickOAuth } from './accounts/oauthProvider.js';

export interface Auth {
  /** OAuth endpoints and metadata, plus the /account sign-in pages. */
  readonly router: express.Router;
  /** Resource-server gate for /mcp and /api. */
  requireAuth(): express.RequestHandler;
}

/**
 * `issuerUrl` doubles as the resource server URL — this server is both.
 */
export function createAuth(issuerUrl: URL, circle: CircleDeps, identity: IdentityProvider): Auth {
  const oauth = createWickOAuth(circle.store, circle.now);

  const router = express.Router();
  router.use(
    mcpAuthRouter({
      provider: oauth.provider,
      issuerUrl,
      scopesSupported: ['wick:family'],
      resourceName: 'Wick',
    }),
  );
  router.use(createAccountRouter({ circle, identity, oauth, issuerUrl }));

  /**
   * §7.3 requires 401 with NO WWW-Authenticate header when unauthenticated.
   * Omitting `resourceMetadataUrl` only drops the header's
   * `resource_metadata` attribute in the installed SDK (1.30.0) —
   * `requireBearerAuth` still unconditionally sets the header on every
   * 401/403 (verified in node_modules/@modelcontextprotocol/sdk
   * .../middleware/bearerAuth.js). So the header is stripped here at the
   * response layer instead.
   */
  const requireAuth = (): express.RequestHandler => {
    const bearerAuth = requireBearerAuth({ verifier: oauth.provider });
    return (req, res, next) => {
      const setHeader = res.setHeader.bind(res);
      res.setHeader = ((name: string, value: number | string | readonly string[]) => {
        if (name.toLowerCase() === 'www-authenticate') return res;
        return setHeader(name, value);
      }) as typeof res.setHeader;
      void bearerAuth(req, res, next);
    };
  };

  return { router, requireAuth };
}
