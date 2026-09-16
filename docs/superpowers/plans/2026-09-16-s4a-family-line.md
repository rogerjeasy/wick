# S4a Family Line Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the spec-compliant MCP server (S4a) — Streamable HTTP transport, OAuth 2.1 + PKCE auth, and the five published tools — verified against real deployed infra and exercised from MCP Inspector, plus a simulated Alexa+ web surface as the hackathon-sanctioned alternative to the partner-gated Alexa+ add-on (FRICTION.md FL-001).

**Architecture:** `services/mcp-server` is a single Express app: the official `@modelcontextprotocol/sdk`'s `mcpAuthRouter` supplies the whole OAuth 2.1 authorization-server surface (PRM, AS metadata, dynamic client registration, PKCE-validated token exchange) against an in-memory, single-household `OAuthServerProvider`; `requireBearerAuth` gates the MCP endpoint; `McpServer` + `StreamableHTTPServerTransport` serve the five tools, each a direct DynamoDB read against the `wick` table (same table S1 uses) — no model call ever runs inside a tool handler (§9.3). `apps/sim-alexa` is a static HTML/JS client that does the real OAuth dance against the real server and calls tools over Streamable HTTP — no shortcuts, no direct database reads (matching its own README).

**Tech Stack:** TypeScript, Express 5, `@modelcontextprotocol/sdk` (official MCP TS SDK — already resolved in this repo's lockfile as a transitive peer of `@strands-agents/sdk`, version 1.30.0), Zod 4 (already resolved), `@aws-sdk/client-dynamodb`, vitest, `@modelcontextprotocol/inspector` (dev-only, for manual verification) — no new heavy dependency is introduced that isn't already present in `node_modules`.

**Spec:** `docs/WICK-TECHNICAL.md` §7.3 ("MCP server (S4a) and the Alexa+ add-on (S4b)"), §5.4 ("Narrator — and why it must be precomputed"), §9.3 ("MCP latency"), §8.1 ("DynamoDB — single table `wick`"), Appendix D ("Alexa+ add-on cheat sheet"). Also `AGENTS.md` INV-2 (egress), INV-4 (no verbatim), INV-7 (resident sees first).

## Global Constraints

- MCP spec **2025-11-25**, **Streamable HTTP** transport only — not legacy SSE. (§7.3, Appendix D)
- Round-trip latency **under 500ms** — architectural constraint. Every tool handler is a single DynamoDB `GetItem`/bounded `Query`, never a model call. (§9.3)
- Auth is mandatory: return `401` **with no `WWW-Authenticate` header** on an unauthenticated request; host Protected Resource Metadata; advertise `code_challenge_methods_supported: ["S256"]`; OAuth 2.1 authorization-code + PKCE; `resource` parameter set to the server's canonical URI; Bearer token on authenticated calls. (§7.3, Appendix D — this is Alexa+'s own verified requirement, and it diverges from this SDK's default of including a `WWW-Authenticate` header when `resourceMetadataUrl` is configured — see Task 1.)
- Tools are discovered by **introspection at deploy time** — no live consequence for this plan (nothing is deployed to a stable public host yet; noted for whoever ships this to AWS later).
- INV-2: `services/agent/src/egress.ts` is the only module permitted to import a transport client. `send_note_to_tv` (Task 6) calls `sendToDevice()` from `@wick/agent` — it never touches DynamoDB or a transport client directly.
- INV-7: `get_week_narrative` (Task 3) must not return a narrative whose `residentSeenAt` is unset.
- `check:no-mocks` forbids Vega **runtime** code from importing anything matching `/mock/i`. This plan's seed script (Task 7) is a standalone dev script under `scripts/`, not runtime code, and writes real rows to a real DynamoDB table — this is the same category as `scripts/door-card-demo.ts`, not a mock.
- **Scope decision (this plan):** the OAuth provider's client/token store is **in-memory**, single-process, single-household — matching this repo's established pattern of simplifying identity for the hackathon pass (see S1's pairing: "household identity is simplified for this pass... a household is provisioned out of band"). This means the MCP server runs as one long-lived local process (verified via `cloudflared tunnel` + MCP Inspector, per §7.3's own documented local-dev path), **not** deployed to Lambda in this plan — a stateless-Lambda deployment would need the token/client store moved to DynamoDB first, which is out of scope here and left as a named follow-up.
- **Scope decision (this plan):** `send_note_to_tv`'s `suggestedReplies` are three static, generic strings, not model-drafted. Model-drafted replies "in the resident's own register" are **M3 (One-Button Reply)**, sequenced later in `docs/WICK-TECHNICAL.md` §15 Step 8 — out of scope here, and drafting one synchronously inside a tool handler would violate the no-model-call constraint above regardless.
- **Scope decision (this plan):** `get_today` and `did_visitor_come` read the `EVT#<ts>#<ulid>` timeline entity that `services/edge-device/lambda/route.mjs` already writes for `card_shown`/`card_action` (real, in production today), extended with `door`/`presence` event kinds that nothing yet writes for real — Task 7's seed script writes those for MCP Inspector testing. This is forward-compatible: the moment a real Door/Day agent writes real `door`/`presence` `EVT#` rows, both tools reflect them with zero code changes, because the read path doesn't know or care whether a row was seeded or agent-written.

---

### Task 1: OAuth 2.1 authorization + resource server

**Files:**
- Modify: `services/mcp-server/src/auth.ts`
- Modify: `services/mcp-server/package.json`
- Test: `services/mcp-server/src/__tests__/auth.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `createAuthRouter(issuerUrl: URL): express.Router` (mounts PRM + AS metadata + register/authorize/token/revoke, plus a same-origin `/authorize/approve` consent-confirmation route), `requireAuth(): express.RequestHandler` (the `requireBearerAuth` middleware, pre-wired to this module's token verifier, **without** `resourceMetadataUrl` — so 401 responses carry no `WWW-Authenticate` header, per the Global Constraints). Task 2 imports both and mounts them on the Express app.

- [ ] **Step 1: Add dependencies**

In `services/mcp-server/package.json`, add to `"dependencies"`:

```json
"@modelcontextprotocol/sdk": "^1.30.0",
"express": "^5.2.1",
"zod": "^4.6.5",
```

Add a `"devDependencies"` block:

```json
"devDependencies": {
  "@types/express": "^5.0.0"
}
```

Run: `npm install`

- [ ] **Step 2: Write the failing test**

Create `services/mcp-server/src/__tests__/auth.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import express from 'express';
import { createAuthRouter, requireAuth, __resetAuthStateForTest } from '../auth.js';

const ISSUER = new URL('http://127.0.0.1:4000');

function testApp() {
  __resetAuthStateForTest();
  const app = express();
  app.use(express.json());
  app.use(createAuthRouter(ISSUER));
  app.get('/protected', requireAuth(), (req, res) => {
    res.json({ ok: true, clientId: req.auth?.clientId });
  });
  return app;
}

async function registerClient(app: express.Express) {
  const res = await fetch(`http://127.0.0.1:${await listen(app)}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: ['http://127.0.0.1:9999/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  return res.json();
}

function listen(app: express.Express): Promise<number> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

describe('auth', () => {
  it('serves protected resource metadata', async () => {
    const app = testApp();
    const port = await listen(app);
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBeDefined();
  });

  it('serves authorization server metadata advertising S256 PKCE', async () => {
    const app = testApp();
    const port = await listen(app);
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code_challenge_methods_supported).toEqual(['S256']);
  });

  it('returns 401 with no WWW-Authenticate header when unauthenticated', async () => {
    const app = testApp();
    const port = await listen(app);
    const res = await fetch(`http://127.0.0.1:${port}/protected`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  it('completes the full authorization-code + PKCE flow and authenticates with the resulting token', async () => {
    const app = testApp();
    const port = await listen(app);
    const base = `http://127.0.0.1:${port}`;

    const regRes = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['http://127.0.0.1:9999/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(regRes.status).toBe(201);
    const client = await regRes.json();

    const verifier = 'a'.repeat(64);
    const challenge = Buffer.from(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
    )
      .toString('base64url');

    const authorizeUrl = new URL(`${base}/authorize`);
    authorizeUrl.searchParams.set('client_id', client.client_id);
    authorizeUrl.searchParams.set('redirect_uri', client.redirect_uris[0]);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('state', 'xyz');

    const authorizeRes = await fetch(authorizeUrl, { redirect: 'manual' });
    expect(authorizeRes.status).toBe(200);
    const html = await authorizeRes.text();
    const approveHref = html.match(/href="([^"]+)"/)?.[1];
    expect(approveHref).toBeDefined();

    const approveRes = await fetch(approveHref!, { redirect: 'manual' });
    expect(approveRes.status).toBe(302);
    const location = new URL(approveRes.headers.get('location')!);
    const code = location.searchParams.get('code');
    expect(location.searchParams.get('state')).toBe('xyz');
    expect(code).toBeTruthy();

    const tokenRes = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: client.redirect_uris[0],
        client_id: client.client_id,
        code_verifier: verifier,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = await tokenRes.json();
    expect(tokens.access_token).toBeTruthy();

    const protectedRes = await fetch(`${base}/protected`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(protectedRes.status).toBe(200);
    const body = await protectedRes.json();
    expect(body.clientId).toBe(client.client_id);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run services/mcp-server/src/__tests__/auth.test.ts`
Expected: FAIL — `createAuthRouter`, `requireAuth`, `__resetAuthStateForTest` don't exist yet (`auth.ts` is still `export {}`).

- [ ] **Step 4: Implement `auth.ts`**

Replace `services/mcp-server/src/auth.ts` entirely:

```ts
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
import {
  mcpAuthRouter,
  type AuthorizationParams,
  type OAuthRegisteredClientsStore,
  type OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
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
      resource: params.resource,
      scopes: params.scopes ?? [],
      state: params.state,
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
    resource,
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

/** Resource-server-side gate. No `resourceMetadataUrl` -> no WWW-Authenticate header on 401 (§7.3). */
export function requireAuth(): express.RequestHandler {
  return requireBearerAuth({ verifier: provider });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run services/mcp-server/src/__tests__/auth.test.ts`
Expected: PASS (5 tests). If the SDK's actual export paths differ from `@modelcontextprotocol/sdk/server/auth/router.js` / `.../middleware/bearerAuth.js` / `.../types.js` / `@modelcontextprotocol/sdk/shared/auth.js` once resolved by `npm install`, fix the import paths to match what actually resolves — check `node_modules/@modelcontextprotocol/sdk/package.json`'s `"exports"` map first; the paths above were confirmed against the version already present in this repo's lockfile (1.30.0) before writing this task.

- [ ] **Step 6: Typecheck**

Run: `npx tsc -b services/mcp-server --pretty`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add services/mcp-server/src/auth.ts services/mcp-server/src/__tests__/auth.test.ts services/mcp-server/package.json package-lock.json
git commit -m "feat(mcp-server): OAuth 2.1 + PKCE auth via official SDK router"
```

---

### Task 2: MCP transport bootstrap + `get_resident_shared_view`

**Files:**
- Modify: `services/mcp-server/src/server.ts`
- Modify: `services/mcp-server/src/index.ts`
- Modify: `services/mcp-server/src/tools/get_resident_shared_view.ts`
- Modify: `services/mcp-server/package.json`
- Test: `services/mcp-server/src/__tests__/server.test.ts`

**Interfaces:**
- Consumes: `createAuthRouter`, `requireAuth`, `HOUSEHOLD_ID` (Task 1, `../auth.js`).
- Produces: `createApp(issuerUrl: URL): express.Express` (exported from `server.ts` — Tasks 3-6 each add one `mcpServer.registerTool(...)` call inside this function; the seed script and `apps/sim-alexa` consume the running server only over HTTP, not this function directly). `registerGetResidentSharedView(mcpServer: McpServer, ddb: DynamoDBClient): void` (Task 2's own tool registration, in `tools/get_resident_shared_view.ts` — the pattern every later tool task follows).

- [ ] **Step 1: Add the DynamoDB SDK dependency**

In `services/mcp-server/package.json`, add to `"dependencies"`:

```json
"@aws-sdk/client-dynamodb": "^3.1132.0",
```

Run: `npm install`

- [ ] **Step 2: Write the failing test**

Create `services/mcp-server/src/__tests__/server.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { createApp } from '../server.js';
import { __resetAuthStateForTest } from '../auth.js';

vi.mock('@aws-sdk/client-dynamodb', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-dynamodb')>('@aws-sdk/client-dynamodb');
  return { ...actual, DynamoDBClient: vi.fn() };
});

function listen(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe('createApp', () => {
  beforeEach(() => {
    __resetAuthStateForTest();
  });

  it('exposes the MCP endpoint and requires auth', async () => {
    const app = createApp(new URL('http://127.0.0.1:4001'));
    const { port, close } = await listen(app);
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    await close();
  });
});
```

The DynamoDB client is mocked here only because this test never reaches a tool handler — it exercises transport/auth wiring, not `get_resident_shared_view`'s DynamoDB call (that's covered by Step 2's later assertion in the tool's own test, Task 2 Step 5).

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run services/mcp-server/src/__tests__/server.test.ts`
Expected: FAIL — `createApp` doesn't exist yet (`server.ts` is still `export {}`).

- [ ] **Step 4: Implement `server.ts`**

Replace `services/mcp-server/src/server.ts` entirely:

```ts
/**
 * The MCP server (S4a). This is the real artefact.
 *
 * The Alexa+ MCP Toolkit is partner-gated (FRICTION.md FL-001), so this server is
 * exercised through MCP Inspector and the simulated surface in apps/sim-alexa
 * rather than a real Echo. Build to the published spec anyway: it is good
 * engineering independently, and if access opens, nothing here changes.
 *
 * HARD REQUIREMENTS (verified, Alexa+ MCP Toolkit quickstart, 2026-09-14):
 *   - MCP spec 2025-11-25, Streamable HTTP. Not legacy SSE.
 *   - Public HTTPS. cloudflared is the documented local-dev tunnel.
 *   - ROUND TRIP UNDER 500ms. Architectural constraint, not a target.
 *   - Tools are discovered by introspection AT DEPLOY TIME.
 *     Redeploy after ANY tool change. This will bite you at least once; write
 *     it into FRICTION.md when it does.
 *
 * Therefore: every tool handler is a single DynamoDB GetItem/Query over
 * precomputed state. NO MODEL CALL EVER RUNS INSIDE A TOOL HANDLER. If you want
 * one, you have mis-sited the work — precompute it upstream (§5.4).
 */
import { randomUUID } from 'node:crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { createAuthRouter, requireAuth } from './auth.js';
import { registerGetResidentSharedView } from './tools/get_resident_shared_view.js';

export const TABLE = process.env.TABLE_NAME ?? 'wick';

export function createApp(issuerUrl: URL): express.Express {
  const ddb = new DynamoDBClient({});
  const mcpServer = new McpServer({ name: 'wick', version: '0.1.0' });

  registerGetResidentSharedView(mcpServer, ddb);

  const app = express();
  app.use(express.json());
  app.use(createAuthRouter(issuerUrl));

  app.post('/mcp', requireAuth(), async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    res.on('close', () => void transport.close());
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return app;
}
```

- [ ] **Step 5: Implement `get_resident_shared_view`**

First, check `services/policy/src/index.ts` exports `DEFAULT_POLICY` and `HouseholdPolicy` (it does — confirmed in Task 1's research; `services/policy/src/policy.ts` exports `DEFAULT_POLICY`). Replace `services/mcp-server/src/tools/get_resident_shared_view.ts` entirely:

```ts
/**
 * MCP tool: get_resident_shared_view
 *
 * Returns exactly what the resident has agreed is shared — the machine-readable
 * counterpart of the "What Sarah Sees" screen on the television. A family member
 * can always ask what they are and are not able to see.
 *
 * Single GetItem over the household's policy record. No model call.
 */
import { z } from 'zod';
import { GetItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { HouseholdPolicy } from '@wick/policy';
import { DEFAULT_POLICY } from '@wick/policy';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HOUSEHOLD_ID } from '../auth.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';

export async function loadHouseholdPolicy(ddb: DynamoDBClient, householdId: string): Promise<HouseholdPolicy> {
  const res = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: 'META' } },
  }));
  const raw = res.Item?.policy?.S;
  return raw ? (JSON.parse(raw) as HouseholdPolicy) : DEFAULT_POLICY;
}

export function registerGetResidentSharedView(mcpServer: McpServer, ddb: DynamoDBClient): void {
  mcpServer.registerTool(
    'get_resident_shared_view',
    {
      title: 'What the resident shares with family',
      description: "Returns exactly what the resident has agreed is shared with family — the machine-readable counterpart of the television's \"What Sarah Sees\" screen.",
      inputSchema: {},
    },
    async () => {
      const policy = await loadHouseholdPolicy(ddb, HOUSEHOLD_ID);
      const shared = (Object.keys(policy.table) as (keyof typeof policy.table)[])
        .filter((factClass) => {
          const rule = policy.table[factClass].FAMILY;
          return rule.allow || policy.familyPermitted.includes(factClass);
        })
        .filter((factClass) => !policy.residentExclusions.includes(factClass));
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ sharedWithFamily: shared, residentExclusions: policy.residentExclusions }),
          },
        ],
      };
    },
  );
}
```

- [ ] **Step 6: Write the tool's own unit test**

Create `services/mcp-server/src/tools/__tests__/get_resident_shared_view.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { loadHouseholdPolicy } from '../get_resident_shared_view.js';
import { DEFAULT_POLICY } from '@wick/policy';

describe('loadHouseholdPolicy', () => {
  it('returns DEFAULT_POLICY when the household has no stored policy', async () => {
    const ddb = { send: vi.fn().mockResolvedValue({ Item: undefined }) } as unknown as DynamoDBClient;
    const policy = await loadHouseholdPolicy(ddb, 'hh-1');
    expect(policy).toEqual(DEFAULT_POLICY);
  });

  it('parses a stored policy from the household META item', async () => {
    const stored = { ...DEFAULT_POLICY, residentExclusions: ['FINANCIAL' as const] };
    const ddb = {
      send: vi.fn().mockResolvedValue({ Item: { policy: { S: JSON.stringify(stored) } } }),
    } as unknown as DynamoDBClient;
    const policy = await loadHouseholdPolicy(ddb, 'hh-1');
    expect(policy.residentExclusions).toEqual(['FINANCIAL']);
  });
});
```

- [ ] **Step 7: Run both tests to verify they pass**

Run: `npx vitest run services/mcp-server`
Expected: PASS (server.test.ts: 1 test; get_resident_shared_view.test.ts: 2 tests).

- [ ] **Step 8: Typecheck**

Run: `npx tsc -b services/mcp-server --pretty`
Expected: no errors. If `@wick/policy`'s `DEFAULT_POLICY` export or `HouseholdPolicy`'s `table` keying differs from what's used above, fix this file to match what actually typechecks — `services/policy/src/index.ts` and `types.ts` are the source of truth (already read during this plan's research; re-read them if this step fails).

- [ ] **Step 9: Commit**

```bash
git add services/mcp-server/src/server.ts services/mcp-server/src/index.ts services/mcp-server/src/tools/get_resident_shared_view.ts services/mcp-server/src/__tests__/server.test.ts services/mcp-server/src/tools/__tests__/get_resident_shared_view.test.ts services/mcp-server/package.json package-lock.json
git commit -m "feat(mcp-server): Streamable HTTP transport + get_resident_shared_view"
```

---

### Task 3: `get_week_narrative`

**Files:**
- Modify: `services/mcp-server/src/tools/get_week_narrative.ts`
- Modify: `services/mcp-server/src/server.ts:` add one `registerGetWeekNarrative(mcpServer, ddb)` call
- Test: `services/mcp-server/src/tools/__tests__/get_week_narrative.test.ts`

**Interfaces:**
- Consumes: `WeekNarrative` (`@wick/contracts`, already defined — `packages/contracts/src/narrative.ts`), `HOUSEHOLD_ID` (`../auth.js`).
- Produces: `registerGetWeekNarrative(mcpServer: McpServer, ddb: DynamoDBClient): void`, imported by `server.ts`.

- [ ] **Step 1: Write the failing test**

Create `services/mcp-server/src/tools/__tests__/get_week_narrative.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { WeekNarrative } from '@wick/contracts';
import { loadWeekNarrative } from '../get_week_narrative.js';

const NARRATIVE: WeekNarrative = {
  householdId: 'hh-1',
  isoWeek: '2026-W38',
  text: 'A quiet week. Margaret had her usual Tuesday visit from Maria.',
  deltas: [],
  timeline: [{ at: 1, kind: 'visit', summary: 'Maria visited, as usual.' }],
  generatedAt: 100,
  residentSeenAt: 200,
};

describe('loadWeekNarrative', () => {
  it('returns the narrative once the resident has seen it (INV-7)', async () => {
    const ddb = {
      send: vi.fn().mockResolvedValue({ Item: { data: { S: JSON.stringify(NARRATIVE) } } }),
    } as unknown as DynamoDBClient;
    const result = await loadWeekNarrative(ddb, 'hh-1', '2026-W38');
    expect(result).toEqual({ status: 'available', narrative: NARRATIVE });
  });

  it('withholds a narrative the resident has not yet seen (INV-7)', async () => {
    const unseen = { ...NARRATIVE, residentSeenAt: undefined };
    const ddb = {
      send: vi.fn().mockResolvedValue({ Item: { data: { S: JSON.stringify(unseen) } } }),
    } as unknown as DynamoDBClient;
    const result = await loadWeekNarrative(ddb, 'hh-1', '2026-W38');
    expect(result).toEqual({ status: 'not_yet_available' });
  });

  it('reports not_yet_available when no narrative exists for the week', async () => {
    const ddb = { send: vi.fn().mockResolvedValue({ Item: undefined }) } as unknown as DynamoDBClient;
    const result = await loadWeekNarrative(ddb, 'hh-1', '2026-W38');
    expect(result).toEqual({ status: 'not_yet_available' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run services/mcp-server/src/tools/__tests__/get_week_narrative.test.ts`
Expected: FAIL — `loadWeekNarrative` doesn't exist yet.

- [ ] **Step 3: Implement `get_week_narrative.ts`**

Replace `services/mcp-server/src/tools/get_week_narrative.ts` entirely:

```ts
/**
 * MCP tool: get_week_narrative — single GetItem over precomputed state. See §7.3.
 *
 * INV-7: the resident sees their week before the family can read it.
 * `residentSeenAt` gates readability here, not just on write — a narrative
 * that exists but hasn't been shown to the resident yet must read as
 * "not yet available", never as an empty or error response (§6.4: refusal
 * is a feature, never silence, never a lie).
 *
 * The current ISO week is used when the caller doesn't name one — the
 * overwhelmingly common case ("how's mum been this week").
 */
import { z } from 'zod';
import { GetItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { WeekNarrative } from '@wick/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HOUSEHOLD_ID } from '../auth.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';

export type WeekNarrativeResult =
  | { readonly status: 'available'; readonly narrative: WeekNarrative }
  | { readonly status: 'not_yet_available' };

export async function loadWeekNarrative(
  ddb: DynamoDBClient,
  householdId: string,
  isoWeek: string,
): Promise<WeekNarrativeResult> {
  const res = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: `NARR#${isoWeek}` } },
  }));
  const raw = res.Item?.data?.S;
  if (!raw) return { status: 'not_yet_available' };
  const narrative = JSON.parse(raw) as WeekNarrative;
  if (narrative.residentSeenAt === undefined) return { status: 'not_yet_available' };
  return { status: 'available', narrative };
}

/** ISO 8601 week, e.g. "2026-W38". */
function currentIsoWeek(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function registerGetWeekNarrative(mcpServer: McpServer, ddb: DynamoDBClient): void {
  mcpServer.registerTool(
    'get_week_narrative',
    {
      title: "This week's narrative",
      description: "Returns the precomputed weekly narrative — prose and timeline — for the household's week. Withholds a narrative the resident hasn't seen on their own television yet.",
      inputSchema: { isoWeek: z.string().optional().describe('ISO 8601 week, e.g. "2026-W38". Defaults to the current week.') },
    },
    async ({ isoWeek }) => {
      const week = isoWeek ?? currentIsoWeek();
      const result = await loadWeekNarrative(ddb, HOUSEHOLD_ID, week);
      if (result.status === 'not_yet_available') {
        return { content: [{ type: 'text' as const, text: "This week's narrative isn't ready yet." }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.narrative) }] };
    },
  );
}
```

- [ ] **Step 4: Wire it into `server.ts`**

In `services/mcp-server/src/server.ts`, add the import:

```ts
import { registerGetWeekNarrative } from './tools/get_week_narrative.js';
```

And inside `createApp`, after `registerGetResidentSharedView(mcpServer, ddb);`:

```ts
  registerGetWeekNarrative(mcpServer, ddb);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run services/mcp-server`
Expected: PASS (all prior tests plus 3 new ones).

- [ ] **Step 6: Typecheck**

Run: `npx tsc -b services/mcp-server --pretty`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add services/mcp-server/src/tools/get_week_narrative.ts services/mcp-server/src/tools/__tests__/get_week_narrative.test.ts services/mcp-server/src/server.ts
git commit -m "feat(mcp-server): get_week_narrative — INV-7-gated weekly narrative"
```

---

### Task 4: `get_today`

**Files:**
- Modify: `services/mcp-server/src/tools/get_today.ts`
- Modify: `services/mcp-server/src/server.ts`
- Test: `services/mcp-server/src/tools/__tests__/get_today.test.ts`

**Interfaces:**
- Consumes: `TimelineEntry` (`@wick/contracts`), `HOUSEHOLD_ID` (`../auth.js`).
- Produces: `registerGetToday(mcpServer: McpServer, ddb: DynamoDBClient): void`.
- **Reads the same `EVT#<ts>#<ulid>` entity `services/edge-device/lambda/route.mjs` already writes** (`type: 'card_shown'|'card_action'`, fields `cardId`, optional `action`) — extended with `type: 'door'|'presence'`, which nothing writes yet in production; Task 7's seed script writes those for testing. See this plan's Global Constraints for why this is the right entity to reuse rather than inventing a parallel one.

- [ ] **Step 1: Write the failing test**

Create `services/mcp-server/src/tools/__tests__/get_today.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { loadTodayEvents, summariseEvent } from '../get_today.js';

describe('summariseEvent', () => {
  it('summarises a card_shown event', () => {
    expect(summariseEvent({ type: 'card_shown', cardId: 'door-abc' })).toBe('A card was shown on the television.');
  });

  it('summarises a card_action event with its action', () => {
    expect(summariseEvent({ type: 'card_action', cardId: 'door-abc', action: 'watch_live' })).toBe(
      'The resident chose "watch_live" on a card.',
    );
  });

  it('summarises a door event', () => {
    expect(summariseEvent({ type: 'door' })).toBe('Someone was at the front door.');
  });

  it('summarises a presence event with a person name when known', () => {
    expect(summariseEvent({ type: 'presence', personName: 'Maria' })).toBe('Maria arrived.');
  });

  it('summarises a presence event with no known person', () => {
    expect(summariseEvent({ type: 'presence' })).toBe('Someone arrived.');
  });
});

describe('loadTodayEvents', () => {
  it('queries the EVT# range for the given day and returns summaries in order', async () => {
    const items = [
      { sk: { S: 'EVT#000001700000000#a' }, type: { S: 'door' }, at: { N: '1700000000000' } },
      { sk: { S: 'EVT#000001700000100#b' }, type: { S: 'card_shown' }, cardId: { S: 'door-1' }, at: { N: '1700000100000' } },
    ];
    const send = vi.fn().mockResolvedValue({ Items: items });
    const ddb = { send } as unknown as DynamoDBClient;

    const result = await loadTodayEvents(ddb, 'hh-1', new Date('2023-11-14T00:00:00.000Z'));

    expect(result).toEqual([
      { at: 1700000000000, summary: 'Someone was at the front door.' },
      { at: 1700000100000, summary: 'A card was shown on the television.' },
    ]);
    const call = send.mock.calls[0][0].input;
    expect(call.TableName).toBeDefined();
    expect(call.KeyConditionExpression).toContain('BETWEEN');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run services/mcp-server/src/tools/__tests__/get_today.test.ts`
Expected: FAIL — `loadTodayEvents`, `summariseEvent` don't exist yet.

- [ ] **Step 3: Implement `get_today.ts`**

Replace `services/mcp-server/src/tools/get_today.ts` entirely:

```ts
/**
 * MCP tool: get_today — bounded Query over the EVT# timeline. See §7.3.
 *
 * Reads the same EVT#<ts>#<ulid> entity route.mjs already writes for
 * card_shown/card_action (real, in production), extended with door/presence
 * kinds that only a seed script writes today. Deterministic formatting only —
 * no model call, matching §9.3's latency budget.
 */
import { z } from 'zod';
import { QueryCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HOUSEHOLD_ID } from '../auth.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';

export interface RawTimelineEvent {
  readonly type: 'card_shown' | 'card_action' | 'door' | 'presence';
  readonly cardId?: string;
  readonly action?: string;
  readonly personName?: string;
}

export function summariseEvent(event: RawTimelineEvent): string {
  switch (event.type) {
    case 'card_shown':
      return 'A card was shown on the television.';
    case 'card_action':
      return `The resident chose "${event.action}" on a card.`;
    case 'door':
      return 'Someone was at the front door.';
    case 'presence':
      return event.personName ? `${event.personName} arrived.` : 'Someone arrived.';
  }
}

export interface TodayEntry {
  readonly at: number;
  readonly summary: string;
}

/** Zero-padded to 15 digits, matching route.mjs's EVT# sort key exactly. */
function padTs(ms: number): string {
  return String(ms).padStart(15, '0');
}

export async function loadTodayEvents(ddb: DynamoDBClient, householdId: string, now: Date): Promise<readonly TodayEntry[]> {
  const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const endOfDay = startOfDay + 86_400_000;

  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
    ExpressionAttributeValues: {
      ':pk': { S: `HH#${householdId}` },
      ':from': { S: `EVT#${padTs(startOfDay)}` },
      ':to': { S: `EVT#${padTs(endOfDay)}#￿` },
    },
  }));

  return (res.Items ?? []).map((item) => {
    const event: RawTimelineEvent = {
      type: item.type?.S as RawTimelineEvent['type'],
      cardId: item.cardId?.S,
      action: item.action?.S,
      personName: item.personName?.S,
    };
    return { at: Number(item.at?.N ?? '0'), summary: summariseEvent(event) };
  });
}

export function registerGetToday(mcpServer: McpServer, ddb: DynamoDBClient): void {
  mcpServer.registerTool(
    'get_today',
    {
      title: "Today's events",
      description: "Returns a plain-language summary of today's household events: door activity, presence, and what showed on the television.",
      inputSchema: {},
    },
    async () => {
      const entries = await loadTodayEvents(ddb, HOUSEHOLD_ID, new Date());
      return { content: [{ type: 'text' as const, text: JSON.stringify(entries) }] };
    },
  );
}
```

- [ ] **Step 4: Wire it into `server.ts`**

In `services/mcp-server/src/server.ts`, add the import `import { registerGetToday } from './tools/get_today.js';` and, inside `createApp`, add `registerGetToday(mcpServer, ddb);`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run services/mcp-server`
Expected: PASS (all prior tests plus 6 new ones).

- [ ] **Step 6: Typecheck**

Run: `npx tsc -b services/mcp-server --pretty`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add services/mcp-server/src/tools/get_today.ts services/mcp-server/src/tools/__tests__/get_today.test.ts services/mcp-server/src/server.ts
git commit -m "feat(mcp-server): get_today — deterministic summary over the EVT# timeline"
```

---

### Task 5: `did_visitor_come`

**Files:**
- Modify: `services/mcp-server/src/tools/did_visitor_come.ts`
- Modify: `services/mcp-server/src/server.ts`
- Test: `services/mcp-server/src/tools/__tests__/did_visitor_come.test.ts`

**Interfaces:**
- Consumes: `RosterEntry` (`@wick/contracts`, `packages/contracts/src/door.ts`), `HOUSEHOLD_ID` (`../auth.js`), the same `EVT#` entity Task 4 reads (`type: 'presence'`, extended here with a `personId` field on presence rows).
- Produces: `registerDidVisitorCome(mcpServer: McpServer, ddb: DynamoDBClient): void`.

- [ ] **Step 1: Write the failing test**

Create `services/mcp-server/src/tools/__tests__/did_visitor_come.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { checkVisitor } from '../did_visitor_come.js';

describe('checkVisitor', () => {
  it('reports a visit found within the roster schedule', async () => {
    const send = vi.fn().mockImplementation((cmd) => {
      if (cmd.constructor.name === 'GetItemCommand') {
        return Promise.resolve({
          Item: {
            data: { S: JSON.stringify({ personId: 'maria', name: 'Maria', expectedPattern: 'TUE,FRI 09:00±30m' }) },
          },
        });
      }
      return Promise.resolve({
        Items: [{ personId: { S: 'maria' }, at: { N: '1700000000000' } }],
      });
    });
    const ddb = { send } as unknown as DynamoDBClient;

    const result = await checkVisitor(ddb, 'hh-1', 'maria', new Date('2023-11-14T00:00:00.000Z'));

    expect(result).toEqual({ visited: true, at: 1700000000000, name: 'Maria', expectedToday: true });
  });

  it('reports no visit when nothing matches for the day', async () => {
    const send = vi.fn().mockImplementation((cmd) => {
      if (cmd.constructor.name === 'GetItemCommand') {
        return Promise.resolve({
          Item: { data: { S: JSON.stringify({ personId: 'maria', name: 'Maria', expectedPattern: 'TUE,FRI 09:00±30m' }) } },
        });
      }
      return Promise.resolve({ Items: [] });
    });
    const ddb = { send } as unknown as DynamoDBClient;

    const result = await checkVisitor(ddb, 'hh-1', 'maria', new Date('2023-11-14T00:00:00.000Z'));

    expect(result).toEqual({ visited: false, name: 'Maria', expectedToday: true });
  });

  it('reports unknown when the person is not on the roster', async () => {
    const send = vi.fn().mockResolvedValue({ Item: undefined });
    const ddb = { send } as unknown as DynamoDBClient;

    const result = await checkVisitor(ddb, 'hh-1', 'ghost', new Date('2023-11-14T00:00:00.000Z'));

    expect(result).toEqual({ visited: false, name: undefined, expectedToday: false });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run services/mcp-server/src/tools/__tests__/did_visitor_come.test.ts`
Expected: FAIL — `checkVisitor` doesn't exist yet.

- [ ] **Step 3: Implement `did_visitor_come.ts`**

Replace `services/mcp-server/src/tools/did_visitor_come.ts` entirely:

```ts
/**
 * MCP tool: did_visitor_come — single GetItem + bounded Query. See §7.3.
 *
 * Carer/visitor verification (M5). Schedule-based, not biometric (D3, §5.2):
 * the roster's `expectedPattern` is a day-of-week/time expectation
 * ("TUE,FRI 09:00±30m"), matched against whether a presence EVT# row for this
 * personId exists today — not face recognition.
 */
import { z } from 'zod';
import { GetItemCommand, QueryCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { RosterEntry } from '@wick/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HOUSEHOLD_ID } from '../auth.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';

export interface VisitorCheckResult {
  readonly visited: boolean;
  readonly at?: number;
  readonly name: string | undefined;
  readonly expectedToday: boolean;
}

const DAY_CODES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;

function expectedToday(pattern: string | undefined, now: Date): boolean {
  if (!pattern) return false;
  const todayCode = DAY_CODES[now.getUTCDay()];
  const days = pattern.split(' ')[0]?.split(',') ?? [];
  return days.includes(todayCode);
}

function padTs(ms: number): string {
  return String(ms).padStart(15, '0');
}

export async function checkVisitor(
  ddb: DynamoDBClient,
  householdId: string,
  personId: string,
  now: Date,
): Promise<VisitorCheckResult> {
  const rosterRes = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: `PER#${personId}` } },
  }));
  const raw = rosterRes.Item?.data?.S;
  if (!raw) return { visited: false, name: undefined, expectedToday: false };
  const roster = JSON.parse(raw) as RosterEntry;

  const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const endOfDay = startOfDay + 86_400_000;

  const evtRes = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
    FilterExpression: 'personId = :pid',
    ExpressionAttributeValues: {
      ':pk': { S: `HH#${householdId}` },
      ':from': { S: `EVT#${padTs(startOfDay)}` },
      ':to': { S: `EVT#${padTs(endOfDay)}#￿` },
      ':pid': { S: personId },
    },
  }));

  const visit = evtRes.Items?.[0];
  return {
    visited: Boolean(visit),
    ...(visit ? { at: Number(visit.at?.N ?? '0') } : {}),
    name: roster.name,
    expectedToday: expectedToday(roster.expectedPattern, now),
  };
}

export function registerDidVisitorCome(mcpServer: McpServer, ddb: DynamoDBClient): void {
  mcpServer.registerTool(
    'did_visitor_come',
    {
      title: 'Did a visitor come',
      description: 'Checks whether a specific person on the household roster visited today, and whether today was one of their expected days.',
      inputSchema: { personId: z.string().describe('The roster person id, e.g. "maria".') },
    },
    async ({ personId }) => {
      const result = await checkVisitor(ddb, HOUSEHOLD_ID, personId, new Date());
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );
}
```

- [ ] **Step 4: Wire it into `server.ts`**

In `services/mcp-server/src/server.ts`, add the import `import { registerDidVisitorCome } from './tools/did_visitor_come.js';` and, inside `createApp`, add `registerDidVisitorCome(mcpServer, ddb);`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run services/mcp-server`
Expected: PASS (all prior tests plus 3 new ones).

- [ ] **Step 6: Typecheck**

Run: `npx tsc -b services/mcp-server --pretty`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add services/mcp-server/src/tools/did_visitor_come.ts services/mcp-server/src/tools/__tests__/did_visitor_come.test.ts services/mcp-server/src/server.ts
git commit -m "feat(mcp-server): did_visitor_come — schedule-based visit verification (M5)"
```

---

### Task 6: `send_note_to_tv`

**Files:**
- Modify: `services/mcp-server/src/tools/send_note_to_tv.ts`
- Modify: `services/mcp-server/src/server.ts`
- Modify: `services/mcp-server/package.json` (add `@wick/agent`, `@wick/policy` dependencies)
- Modify: `services/mcp-server/tsconfig.json` (add project reference to `../agent`)
- Modify: `tsconfig.base.json` (add `@wick/agent` path mapping)
- Modify: `vitest.config.ts` (add `@wick/agent` alias)
- Test: `services/mcp-server/src/tools/__tests__/send_note_to_tv.test.ts`

**Interfaces:**
- Consumes: `sendToDevice` (`@wick/agent`, `services/agent/src/egress.ts` — already implemented, Task 8 of the S1 plan), `MessageCard`/`QueuedCard` (`@wick/contracts`), `DEFAULT_POLICY` (`@wick/policy`).
- Produces: `registerSendNoteToTv(mcpServer: McpServer, ddb: DynamoDBClient): void`. **INV-2**: this is the only tool file in this plan that reaches the device — it does so exclusively through `sendToDevice()`, never by importing a transport client or writing `CARD#` items itself.

- [ ] **Step 1: Wire `@wick/agent` into the build graph**

In `tsconfig.base.json`'s `compilerOptions.paths`, add:

```json
"@wick/agent": ["./services/agent/src/index.ts"],
```

In `services/mcp-server/tsconfig.json`'s `references` array, add:

```json
{ "path": "../agent" }
```

In `vitest.config.ts`'s `resolve.alias`, add:

```ts
'@wick/agent': fileURLToPath(new URL('./services/agent/src/index.ts', import.meta.url)),
```

In `services/mcp-server/package.json`, add to `"dependencies"`:

```json
"@wick/agent": "*",
"@wick/policy": "*",
```

Run: `npm install`

- [ ] **Step 2: Export `sendToDevice` from `services/agent`'s index**

Check `services/agent/src/index.ts` — it is currently `export {}`. Replace it entirely:

```ts
/**
 * Strands agent graph, deployed to Bedrock AgentCore Runtime.
 *
 *   EventBridge ─┬─▶ Door ─────┐
 *                │             │
 *   Bee SSE ─────┼─▶ Day ──────┼──▶ GUARDIAN ──▶ egress ─┬─▶ device (TV)
 *                │             │      (sync)             └─▶ MCP tool result
 *   cron ────────┴─▶ Narrator ─┘
 *
 * Do not let these collapse into one agent. The separation is the architecture,
 * and it is also the demo.
 */
export { sendToDevice } from './egress.js';
```

This is the only export needed by `services/mcp-server` — `sendToFamily` stays unexported at the package boundary until it's implemented (S5), so nothing outside `egress.ts` can accidentally call a `throw new Error('not implemented')` stub through a public import.

- [ ] **Step 3: Write the failing test**

Create `services/mcp-server/src/tools/__tests__/send_note_to_tv.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { buildMessageCard } from '../send_note_to_tv.js';

describe('buildMessageCard', () => {
  it('builds a MESSAGE card with three static suggested replies', () => {
    const card = buildMessageCard({
      householdId: 'hh-1',
      correlationId: 'corr-1',
      fromName: 'Alex',
      message: 'Just checking in — call me when you get a chance!',
      now: 1700000000000,
    });

    expect(card.card).toMatchObject({
      type: 'MESSAGE',
      householdId: 'hh-1',
      correlationId: 'corr-1',
      fromName: 'Alex',
      transcript: 'Just checking in — call me when you get a chance!',
    });
    expect(card.card.type === 'MESSAGE' && card.card.suggestedReplies).toHaveLength(3);
    expect(card.urgency).toBe('DEFERRED');
    expect(card.shownCount).toBe(0);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run services/mcp-server/src/tools/__tests__/send_note_to_tv.test.ts`
Expected: FAIL — `buildMessageCard` doesn't exist yet.

- [ ] **Step 5: Implement `send_note_to_tv.ts`**

Replace `services/mcp-server/src/tools/send_note_to_tv.ts` entirely:

```ts
/**
 * MCP tool: send_note_to_tv — enqueues a MessageCard (M3). See §7.3.
 *
 * INV-2: sendToDevice() (services/agent/src/egress.ts) is the only legal path
 * to the television. This file never touches DynamoDB or a transport client
 * directly — it builds a card and hands it to sendToDevice().
 *
 * suggestedReplies are three static, generic strings — model-drafted replies
 * "in the resident's own register" are M3's full build, sequenced later
 * (§15 Step 8), not part of S4a. Drafting one here would also be a model call
 * inside a tool handler, which §9.3 forbids outright.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { QueuedCard } from '@wick/contracts';
import { DEFAULT_POLICY } from '@wick/policy';
import { sendToDevice } from '@wick/agent';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HOUSEHOLD_ID } from '../auth.js';

const STATIC_SUGGESTED_REPLIES = ['Thanks for letting me know!', "I'll call you soon.", 'Not right now.'] as const;

export interface BuildMessageCardInput {
  readonly householdId: string;
  readonly correlationId: string;
  readonly fromName: string;
  readonly message: string;
  readonly now: number;
}

export function buildMessageCard(input: BuildMessageCardInput): QueuedCard {
  const cardId = `note-${randomUUID()}`;
  return {
    id: cardId,
    urgency: 'DEFERRED',
    card: {
      type: 'MESSAGE',
      id: cardId,
      householdId: input.householdId,
      correlationId: input.correlationId,
      createdAt: input.now,
      actions: [],
      fromName: input.fromName,
      transcript: input.message,
      suggestedReplies: [...STATIC_SUGGESTED_REPLIES],
    },
    queuedAt: input.now,
    shownCount: 0,
  };
}

export function registerSendNoteToTv(mcpServer: McpServer): void {
  mcpServer.registerTool(
    'send_note_to_tv',
    {
      title: 'Send a note to the television',
      description: 'Enqueues a message card on the household television, from a named family member, with three generic quick replies.',
      inputSchema: {
        fromName: z.string().min(1).describe('The sender\'s name, as it should appear on the card.'),
        message: z.string().min(1).max(500).describe('The note text.'),
      },
    },
    async ({ fromName, message }) => {
      const card = buildMessageCard({
        householdId: HOUSEHOLD_ID,
        correlationId: randomUUID(),
        fromName,
        message,
        now: Date.now(),
      });
      await sendToDevice(card, DEFAULT_POLICY);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ sent: true, cardId: card.id }) }] };
    },
  );
}
```

- [ ] **Step 6: Wire it into `server.ts`**

In `services/mcp-server/src/server.ts`, add the import `import { registerSendNoteToTv } from './tools/send_note_to_tv.js';` and, inside `createApp`, add `registerSendNoteToTv(mcpServer);` (it doesn't need `ddb` — it never reads DynamoDB directly).

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run services/mcp-server`
Expected: PASS (all prior tests plus 1 new one).

- [ ] **Step 8: Typecheck the whole repo**

Run: `npm run typecheck`
Expected: no errors — this step touches `tsconfig.base.json` and `services/agent`'s public export, both shared, so check the whole tree, not just `mcp-server`.

- [ ] **Step 9: Run the full suite to confirm nothing else broke**

Run: `npm run test`
Expected: all suites pass, including anything in `services/agent` that might import from `./index.js` (check for a pre-existing test first; none was found during this plan's research, but confirm).

- [ ] **Step 10: Commit**

```bash
git add services/mcp-server/src/tools/send_note_to_tv.ts services/mcp-server/src/tools/__tests__/send_note_to_tv.test.ts services/mcp-server/src/server.ts services/mcp-server/package.json services/mcp-server/tsconfig.json services/agent/src/index.ts tsconfig.base.json vitest.config.ts package-lock.json
git commit -m "feat(mcp-server): send_note_to_tv — INV-2-compliant device egress via sendToDevice()"
```

---

### Task 7: Seed script for stub data

**Files:**
- Create: `scripts/seed-mcp-stub-data.ts`
- Modify: `package.json` (add `demo:mcp-seed` script)

**Interfaces:**
- Consumes: `scripts/env.ts` (`loadEnv`, already used by `scripts/door-card-demo.ts`), `@aws-sdk/client-dynamodb`, `@wick/contracts`, `@wick/policy`.
- Produces: nothing consumed by later tasks — this is a standalone dev tool, run manually before an MCP Inspector session.

- [ ] **Step 1: Check `scripts/env.ts`'s `loadEnv` signature**

Read `scripts/env.ts` (already exists) to confirm how it resolves `TABLE_NAME` / AWS region / profile — reuse its exact pattern rather than re-deriving credential loading. If it doesn't already expose a table name or AWS profile helper, read how `scripts/door-card-demo.ts` obtains its AWS clients (`RingClient` construction) for the equivalent pattern and mirror it for a plain `DynamoDBClient`.

- [ ] **Step 2: Implement the seed script**

Create `scripts/seed-mcp-stub-data.ts`:

```ts
/**
 * Seeds stub household/narrative/roster/timeline data for MCP Inspector
 * testing — S4a's own exit criterion is "get_week_narrative over stub data"
 * (docs/WICK-TECHNICAL.md §15 Step 2), because the real Narrator/Day/Door
 * agents that would populate this for real don't exist yet (later phases).
 *
 * This is a standalone dev script, not runtime code — see this plan's
 * Global Constraints for why it doesn't trip check:no-mocks.
 *
 *   npm run demo:mcp-seed
 */
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { DEFAULT_POLICY } from '@wick/policy';
import type { WeekNarrative, RosterEntry } from '@wick/contracts';

const TABLE = process.env.TABLE_NAME ?? 'wick';
const HOUSEHOLD_ID = process.env.WICK_HOUSEHOLD_ID ?? 'dev-household';
const ddb = new DynamoDBClient({});

function padTs(ms: number): string {
  return String(ms).padStart(15, '0');
}

/** ISO 8601 week, matching services/mcp-server/src/tools/get_week_narrative.ts's own derivation. */
function currentIsoWeek(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

async function seedHouseholdPolicy(): Promise<void> {
  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: { S: `HH#${HOUSEHOLD_ID}` },
      sk: { S: 'META' },
      policy: { S: JSON.stringify(DEFAULT_POLICY) },
    },
  }));
  console.log('seeded household policy');
}

async function seedRoster(): Promise<void> {
  const maria: RosterEntry = {
    personId: 'maria',
    name: 'Maria',
    expectedPattern: `${['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][new Date().getUTCDay()]} 09:00±30m`,
  };
  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: { S: `HH#${HOUSEHOLD_ID}` },
      sk: { S: `PER#${maria.personId}` },
      data: { S: JSON.stringify(maria) },
    },
  }));
  console.log('seeded roster entry: maria');
}

async function seedTodayTimeline(): Promise<void> {
  const now = Date.now();
  const doorAt = now - 3 * 3600_000;
  const presenceAt = now - 2 * 3600_000;

  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: { S: `HH#${HOUSEHOLD_ID}` },
      sk: { S: `EVT#${padTs(doorAt)}#seed-door` },
      type: { S: 'door' },
      at: { N: String(doorAt) },
    },
  }));

  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: { S: `HH#${HOUSEHOLD_ID}` },
      sk: { S: `EVT#${padTs(presenceAt)}#seed-presence` },
      type: { S: 'presence' },
      personId: { S: 'maria' },
      personName: { S: 'Maria' },
      at: { N: String(presenceAt) },
    },
  }));
  console.log('seeded today timeline: 1 door event, 1 presence event (maria)');
}

async function seedWeekNarrative(): Promise<void> {
  const isoWeek = currentIsoWeek();
  const narrative: WeekNarrative = {
    householdId: HOUSEHOLD_ID,
    isoWeek,
    text: 'A quiet week. Maria visited as usual, and there was one delivery at the door.',
    deltas: [],
    timeline: [
      { at: Date.now() - 86_400_000, kind: 'visit', summary: 'Maria visited, as usual.', personId: 'maria' },
      { at: Date.now() - 3 * 3600_000, kind: 'door', summary: 'A delivery arrived at the front door.' },
    ],
    generatedAt: Date.now() - 3600_000,
    residentSeenAt: Date.now() - 1800_000,
  };
  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: { S: `HH#${HOUSEHOLD_ID}` },
      sk: { S: `NARR#${isoWeek}` },
      data: { S: JSON.stringify(narrative) },
    },
  }));
  console.log(`seeded week narrative for ${isoWeek} (residentSeenAt set — visible to family)`);
}

async function main(): Promise<void> {
  await seedHouseholdPolicy();
  await seedRoster();
  await seedTodayTimeline();
  await seedWeekNarrative();
  console.log(`\ndone. Household: ${HOUSEHOLD_ID}. Table: ${TABLE}.`);
}

await main();
```

- [ ] **Step 3: Add the npm script**

In `package.json`'s `"scripts"`, add:

```json
"demo:mcp-seed": "vite-node -c vitest.config.ts scripts/seed-mcp-stub-data.ts",
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck:scripts`
Expected: no errors.

- [ ] **Step 5: Run it against the real deployed table and confirm the rows land**

```bash
AWS_PROFILE=wick-dev TABLE_NAME=wick WICK_HOUSEHOLD_ID=dev-household npm run demo:mcp-seed
```

Expected: four "seeded ..." lines, then "done." Confirm with:

```bash
AWS_PROFILE=wick-dev aws dynamodb get-item --table-name wick --key '{"pk":{"S":"HH#dev-household"},"sk":{"S":"META"}}'
```

Expected: an `Item` with a `policy` field.

- [ ] **Step 6: Commit**

```bash
git add scripts/seed-mcp-stub-data.ts package.json
git commit -m "chore(scripts): seed stub household/roster/timeline/narrative data for MCP Inspector"
```

---

### Task 8: Local run, MCP Inspector verification, and `apps/sim-alexa`

**Files:**
- Modify: `services/mcp-server/package.json` (add a `dev` script + `@modelcontextprotocol/inspector` devDependency)
- Create: `apps/sim-alexa/index.html`
- Create: `apps/sim-alexa/main.js`
- Create: `apps/sim-alexa/package.json`

**Interfaces:**
- Consumes: the running MCP server (Task 1-6) over Streamable HTTP — `apps/sim-alexa` talks to it over the network only, per its own README ("no shortcuts, no direct database reads").

- [ ] **Step 1: Add a local dev entrypoint**

Replace `services/mcp-server/src/index.ts` entirely:

```ts
/** Local dev entrypoint. `alexa-ai deploy` targets a real host later (§7.3); this is `cloudflared`'s local target until then. */
import { createApp } from './server.js';

const PORT = Number(process.env.PORT ?? 3300);
const ISSUER_URL = new URL(process.env.MCP_ISSUER_URL ?? `http://127.0.0.1:${PORT}`);

createApp(ISSUER_URL).listen(PORT, () => {
  console.log(`Wick MCP server listening on ${ISSUER_URL.toString()}`);
  console.log('MCP endpoint: POST /mcp');
  console.log('Tunnel for Alexa+/MCP Inspector: cloudflared tunnel --url http://127.0.0.1:' + PORT);
});
```

In `services/mcp-server/package.json`, add to `"scripts"`:

```json
"scripts": {
  "dev": "vite-node ../../vitest.config.ts src/index.ts"
}
```

Check this against the repo's actual `vite-node` invocation pattern (`scripts/door-card-demo.ts`'s `demo:door` script) before finalizing — mirror its exact flag order (`vite-node -c <config> <entry>`), run from the repo root, e.g. `"dev": "vite-node -c ../../vitest.config.ts src/index.ts"` if that's what the working pattern requires; the config path is relative to `services/mcp-server` here, unlike the root-level `demo:door` script, so confirm the resolved path is correct by running it (next step) rather than trusting the string alone.

- [ ] **Step 2: Run the server locally and confirm it boots**

```bash
cd services/mcp-server && AWS_PROFILE=wick-dev TABLE_NAME=wick WICK_HOUSEHOLD_ID=dev-household npm run dev
```

Expected: "Wick MCP server listening on http://127.0.0.1:3300" and no stack trace. Leave it running for the next steps.

- [ ] **Step 3: Add and run MCP Inspector against it**

```bash
npx @modelcontextprotocol/inspector
```

This opens a local web UI. Point it at `http://127.0.0.1:3300/mcp`, transport "Streamable HTTP". Inspector will attempt a tool call, get a 401, discover the PRM/AS metadata, and walk the OAuth authorization-code + PKCE flow — including opening the consent page from Task 1 Step 4's `renderConsentPage`, where clicking "Approve" completes it. Confirm:

1. `tools/list` returns all five tools: `get_resident_shared_view`, `get_week_narrative`, `get_today`, `did_visitor_come`, `send_note_to_tv`.
2. Calling `get_week_narrative` (after Task 7's seed script has run) returns the seeded narrative text.
3. Calling `get_today` returns the two seeded events, summarised.
4. Calling `did_visitor_come` with `personId: "maria"` returns `visited: true`.
5. Calling `send_note_to_tv` with a `fromName`/`message` returns `{sent: true, cardId: ...}` — confirm the card actually landed by checking DynamoDB: `aws dynamodb query --table-name wick --key-condition-expression "pk = :pk" --expression-attribute-values '{":pk":{"S":"HH#dev-household"}}' --profile wick-dev` and look for a `CARD#note-...` row.

Record the actual pass/fail of each check in this task's commit message or in a short note — this is the plan's real verification step, not a formality.

- [ ] **Step 4: Build `apps/sim-alexa`**

Create `apps/sim-alexa/package.json`:

```json
{
  "name": "@wick/sim-alexa",
  "private": true,
  "version": "0.1.0",
  "scripts": {
    "dev": "python3 -m http.server 5500"
  }
}
```

No build step and no framework, per the hackathon's own permitted-alternative wording quoted in the existing README ("no specific framework, SDK, or MCP-shaped surface required") — a static page served locally is sufficient to demonstrate the real MCP server over Streamable HTTP.

Create `apps/sim-alexa/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Wick — simulated Alexa+ surface</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 560px; margin: 48px auto; color: #1a1a1a; }
  .notice { background: #fff3cd; border: 1px solid #ffe69c; padding: 12px 16px; border-radius: 8px; font-size: 14px; margin-bottom: 24px; }
  input, textarea { width: 100%; padding: 8px; margin: 4px 0 12px; box-sizing: border-box; }
  button { padding: 10px 20px; background: #111; color: #fff; border: none; border-radius: 8px; cursor: pointer; }
  pre { background: #f4f4f4; padding: 12px; border-radius: 8px; white-space: pre-wrap; }
  section { margin-bottom: 32px; }
</style>
</head>
<body>
  <div class="notice">
    This is <strong>not</strong> a real Alexa+ integration. The Alexa+ MCP Toolkit is
    partner-gated with no published application path (FRICTION.md FL-001) — this is the
    hackathon-sanctioned simulated alternative. It speaks to the real MCP server over
    Streamable HTTP, spec 2025-11-25, with no shortcuts.
  </div>

  <h1>Wick</h1>
  <p id="auth-status">Not connected.</p>
  <label>MCP server URL <input id="server-url" value="http://127.0.0.1:3300" /></label>
  <button id="connect">Connect</button>

  <section>
    <h2>How's the week been?</h2>
    <button id="ask-week" disabled>Ask</button>
    <pre id="week-result"></pre>
  </section>

  <section>
    <h2>What happened today?</h2>
    <button id="ask-today" disabled>Ask</button>
    <pre id="today-result"></pre>
  </section>

  <section>
    <h2>Did Maria come today?</h2>
    <button id="ask-visitor" disabled>Ask</button>
    <pre id="visitor-result"></pre>
  </section>

  <section>
    <h2>Send a note to the television</h2>
    <label>From <input id="note-from" value="Alex" /></label>
    <label>Message <textarea id="note-message" rows="3">Just checking in — call me when you get a chance!</textarea></label>
    <button id="send-note" disabled>Send</button>
    <pre id="note-result"></pre>
  </section>

  <script type="module" src="./main.js"></script>
</body>
</html>
```

Create `apps/sim-alexa/main.js`:

```js
/**
 * Talks to the real MCP server (services/mcp-server) over Streamable HTTP —
 * the whole point of this file existing is that it does NOT read DynamoDB or
 * anything else directly. See ./index.html's on-page notice and this
 * directory's README for why this exists.
 */
let mcpServerUrl = document.getElementById('server-url').value;
let accessToken = null;

function setStatus(text) {
  document.getElementById('auth-status').textContent = text;
}

function enableToolButtons(enabled) {
  for (const id of ['ask-week', 'ask-today', 'ask-visitor', 'send-note']) {
    document.getElementById(id).disabled = !enabled;
  }
}

async function discoverAuthServer() {
  const res = await fetch(`${mcpServerUrl}/.well-known/oauth-authorization-server`);
  if (!res.ok) throw new Error('authorization server metadata not found');
  return res.json();
}

function base64UrlEncode(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pkcePair() {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64UrlEncode(verifierBytes);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64UrlEncode(new Uint8Array(digest));
  return { verifier, challenge };
}

async function registerClient(metadata) {
  const res = await fetch(metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [window.location.origin + window.location.pathname],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      client_name: 'Wick sim-alexa',
    }),
  });
  if (!res.ok) throw new Error('dynamic client registration failed');
  return res.json();
}

async function connect() {
  mcpServerUrl = document.getElementById('server-url').value.replace(/\/$/, '');
  setStatus('Discovering authorization server…');
  const metadata = await discoverAuthServer();
  const client = await registerClient(metadata);
  const { verifier, challenge } = await pkcePair();
  sessionStorage.setItem('wick_pkce_verifier', verifier);
  sessionStorage.setItem('wick_client_id', client.client_id);
  sessionStorage.setItem('wick_token_endpoint', metadata.token_endpoint);
  sessionStorage.setItem('wick_mcp_server_url', mcpServerUrl);

  const authorizeUrl = new URL(metadata.authorization_endpoint);
  authorizeUrl.searchParams.set('client_id', client.client_id);
  authorizeUrl.searchParams.set('redirect_uri', window.location.origin + window.location.pathname);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  window.location.href = authorizeUrl.toString();
}

async function completeAuthIfRedirected() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (!code) return false;

  mcpServerUrl = sessionStorage.getItem('wick_mcp_server_url');
  const tokenRes = await fetch(sessionStorage.getItem('wick_token_endpoint'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: window.location.origin + window.location.pathname,
      client_id: sessionStorage.getItem('wick_client_id'),
      code_verifier: sessionStorage.getItem('wick_pkce_verifier'),
    }),
  });
  if (!tokenRes.ok) throw new Error('token exchange failed');
  const tokens = await tokenRes.json();
  accessToken = tokens.access_token;
  window.history.replaceState({}, '', window.location.pathname);
  return true;
}

let mcpRequestId = 0;

async function callTool(name, args) {
  const res = await fetch(`${mcpServerUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++mcpRequestId, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

document.getElementById('connect').addEventListener('click', () => void connect());

document.getElementById('ask-week').addEventListener('click', async () => {
  const result = await callTool('get_week_narrative', {});
  document.getElementById('week-result').textContent = result.content[0].text;
});

document.getElementById('ask-today').addEventListener('click', async () => {
  const result = await callTool('get_today', {});
  document.getElementById('today-result').textContent = result.content[0].text;
});

document.getElementById('ask-visitor').addEventListener('click', async () => {
  const result = await callTool('did_visitor_come', { personId: 'maria' });
  document.getElementById('visitor-result').textContent = result.content[0].text;
});

document.getElementById('send-note').addEventListener('click', async () => {
  const fromName = document.getElementById('note-from').value;
  const message = document.getElementById('note-message').value;
  const result = await callTool('send_note_to_tv', { fromName, message });
  document.getElementById('note-result').textContent = result.content[0].text;
});

completeAuthIfRedirected().then((authenticated) => {
  if (authenticated) {
    setStatus('Connected.');
    enableToolButtons(true);
  }
});
```

- [ ] **Step 5: Run `apps/sim-alexa` against the real server and confirm the full flow**

With `services/mcp-server`'s dev server still running (Step 2):

```bash
cd apps/sim-alexa && npm run dev
```

Open `http://127.0.0.1:5500`, click "Connect", approve on the consent page, and confirm all four tool buttons return real seeded data (the same checks as Task 8 Step 3, now exercised through the simulated surface instead of MCP Inspector).

- [ ] **Step 6: Run the full repo verification**

Run: `npm run verify`
Expected: typecheck, typecheck:scripts, lint, check:no-mocks, and the full vitest suite all pass.

- [ ] **Step 7: Commit**

```bash
git add services/mcp-server/src/index.ts services/mcp-server/package.json apps/sim-alexa/index.html apps/sim-alexa/main.js apps/sim-alexa/package.json
git commit -m "feat(mcp-server,sim-alexa): local dev entrypoint + simulated Alexa+ web surface"
```

---

## After this plan

- Run `npm run verify` once more at the repo root to confirm the whole tree is green.
- S4a is code-complete and locally verified (MCP Inspector + `apps/sim-alexa`) against real deployed DynamoDB data. What's still open: **deployment** — this server runs as a local process today, not on AWS; a production deployment needs (a) a public HTTPS host that supports long-lived Streamable HTTP connections (Fargate/App Runner, not a bare Lambda), and (b) the in-memory OAuth client/token store moved to DynamoDB so it survives process restarts and works across multiple instances. Both are explicitly out of scope for this plan (see Global Constraints) and are natural follow-up work, not a redesign.
- S4b (real Alexa+ registration) stays blocked on partner access (FL-001). `addon-package/addon.json` was already complete and valid before this plan started — nothing here changes it.
- MCP Apps extension (M6, rendering the week timeline in the conversation view) is explicitly sequenced *after* the five tools work (§7.3) — this plan stops short of it on purpose.
- Per `docs/WICK-TECHNICAL.md` §15, the next step in the overall sequence is **S5 Guardian** (policy engine already exists in `services/policy`; `sendToFamily()` in `services/agent/src/egress.ts` is still the open stub).
