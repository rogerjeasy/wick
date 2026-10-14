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
import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { PutItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { CardPatch, DemoDoorEvent } from '@wick/contracts';
import { createAuth } from './auth.js';
import { createApiRouter, type ClaimTelevision, type RingLinks } from './accounts/apiRouter.js';
import { createAccountDataRouter } from './accounts/accountDataRouter.js';
import { createFamilyTelevisionRouter } from './accounts/familyTelevisionRouter.js';
import { checkAccess, type CircleDeps } from './accounts/circle.js';
import { seedDemoHome } from './accounts/demoHome.js';
import { createAssistantRouter, type AssistantDeps } from './assistant/router.js';
import type { ToolSpec } from './assistant/brain.js';
import type { IdentityProvider } from './accounts/identity.js';
import { grantOf } from './accounts/oauthProvider.js';
import type { AccountStore } from './accounts/store.js';
import { randomId } from './accounts/tokens.js';
import type { ToolContext } from './tools/context.js';
import { guardTools } from './guardian.js';
import type { SendCard } from './tools/send_note_to_tv.js';
import { registerGetResidentSharedView } from './tools/get_resident_shared_view.js';
import { registerGetWeekNarrative } from './tools/get_week_narrative.js';
import { registerGetToday } from './tools/get_today.js';
import { registerDidVisitorCome } from './tools/did_visitor_come.js';
import { registerSendNoteToTv } from './tools/send_note_to_tv.js';
import { registerGetReplies } from './tools/get_replies.js';
import { registerListRegularVisitors } from './tools/list_regular_visitors.js';
import { registerGetWhatsDifferent } from './tools/get_whats_different.js';
import { registerAddRegularVisitor } from './tools/add_regular_visitor.js';
import { registerExpectVisit } from './tools/expect_visit.js';
import { createPushStore } from './accounts/push.js';
import { createPhotoRoutes } from './photos/routes.js';
import type { Moderation } from './photos/moderation.js';
import type { PhotoObjects } from './photos/objects.js';
import { createHearRoute } from './hear/routes.js';
import type { Hear } from './hear/transcribe.js';
import { registerGetDoorRequest } from './tools/get_door_request.js';
import { registerGetLight } from './tools/get_light.js';
import { recordLook, type SendHome } from './tools/lookIn.js';
import { registerAnswerDoorRequest } from './tools/answer_door_request.js';
import { registerInviteToWatch } from './tools/invite_to_watch.js';
import { registerGetWatchTogether } from './tools/get_watch_together.js';
import { registerJoinWatchTogether } from './tools/join_watch_together.js';
import { registerAnswerWatchTogether } from './tools/answer_watch_together.js';
import { registerWithdrawWatchInvitation } from './tools/withdraw_watch_invitation.js';
import { registerGetReachRequest } from './tools/get_reach_request.js';
import { registerAnswerReachRequest } from './tools/answer_reach_request.js';
import { registerGetVisits } from './tools/get_visits.js';
import { registerGetPictures } from './tools/get_pictures.js';

/**
 * A fresh `McpServer` for exactly one session's lifetime.
 *
 * The SDK's `Protocol.connect()` throws "Already connected to a transport"
 * if called twice on the same instance (verified against
 * node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js) — so a
 * single, module-scoped `McpServer` reused across sessions breaks the moment
 * a second real session opens (a page reload, a second tab, MCP Inspector
 * alongside sim-alexa, a reconnect after token expiry). Every new session
 * gets its own instance instead, following the SDK's own shipped reference
 * pattern: node_modules/@modelcontextprotocol/sdk/dist/esm/examples/server/
 * simpleStreamableHttp.js's `getServer()`, called once per `initialize`.
 */
const TABLE = process.env.TABLE_NAME ?? 'wick';
/** The same default as the Narrator's and get_week_narrative.ts's. */
const HOUSEHOLD_TZ = process.env.WICK_HOUSEHOLD_TZ ?? 'Europe/London';

export function createMcpServer(
  ddb: DynamoDBClient,
  ctx: ToolContext,
  sendCard: SendCard,
  sendPatch: (patch: CardPatch, householdId: string) => Promise<void>,
  withdrawCard: (householdId: string, cardId: string) => Promise<void>,
): McpServer {
  // INV-4: every tool's answer is read by the Guardian before it leaves (guardian.ts).
  const mcpServer = guardTools(new McpServer({ name: 'wick', version: '0.2.0' }));
  registerGetResidentSharedView(mcpServer, ddb, ctx);
  registerGetWeekNarrative(mcpServer, ddb, ctx);
  registerGetToday(mcpServer, ddb, ctx);
  registerDidVisitorCome(mcpServer, ddb, ctx);
  registerSendNoteToTv(mcpServer, ctx, sendCard);
  registerGetReplies(mcpServer, ddb, ctx);
  registerListRegularVisitors(mcpServer, ddb, ctx);
  registerGetWhatsDifferent(mcpServer, ddb, ctx);
  registerAddRegularVisitor(mcpServer, ddb, ctx);
  registerExpectVisit(mcpServer, ddb, ctx);
  registerGetDoorRequest(mcpServer, ddb, ctx);
  registerAnswerDoorRequest(mcpServer, ddb, ctx, sendPatch);
  registerInviteToWatch(mcpServer, ddb, ctx, sendCard);
  registerGetWatchTogether(mcpServer, ddb, ctx);
  registerJoinWatchTogether(mcpServer, ddb, ctx, sendCard);
  registerAnswerWatchTogether(mcpServer, ddb, ctx, sendCard);
  registerWithdrawWatchInvitation(mcpServer, ddb, ctx, withdrawCard, sendCard);
  registerGetLight(mcpServer, ddb, ctx);
  registerGetReachRequest(mcpServer, ddb, ctx);
  registerAnswerReachRequest(mcpServer, ddb, ctx, sendCard);
  registerGetVisits(mcpServer, ddb, ctx);
  registerGetPictures(mcpServer, ddb, ctx);
  return mcpServer;
}

/**
 * Everything the server reaches outside itself, injected so the whole
 * sign-in and circle flow is tested end to end without AWS (index.ts wires
 * the real ones).
 */
/**
 * This server's tools as a client is told of them: asked of a server of its
 * own, over MCP's tools/list, so the stand-in assistant (assistant/) is
 * shown exactly the names, descriptions and schemas Alexa+ would be — not
 * a second list kept by hand. No tool is ever called through this.
 */
async function listToolSpecs(ddb: DynamoDBClient): Promise<ToolSpec[]> {
  const nobody: ToolContext = { householdId: '', userId: '', access: async () => { throw new Error('tools/list only'); } };
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'wick-assistant', version: '0.1.0' });
  const nowhere = async (): Promise<void> => { throw new Error('tools/list only'); };
  await Promise.all([createMcpServer(ddb, nobody, nowhere, nowhere, nowhere).connect(serverSide), client.connect(clientSide)]);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema }));
  } finally {
    await client.close();
  }
}

export interface AppDeps {
  readonly store: AccountStore;
  readonly identity: IdentityProvider;
  /**
   * services/agent/src/egress.ts's sendToDevice — the only path to the
   * television (INV-2). `sentBy` is who wrote a note, kept on its row and
   * never sent to the television (egress.ts ServerOnly).
   */
  readonly sendCard: SendCard;
  /** egress.ts's sendPatchToDevice — how an answer reaches a door card already on the television (INV-2). */
  readonly sendPatch: (patch: CardPatch, householdId: string) => Promise<void>;
  /** egress.ts's takeBackFromDevices — how a card its sender withdrew leaves the television (INV-2). */
  readonly withdrawCard: (householdId: string, cardId: string) => Promise<void>;
  /**
   * egress.ts's sendHomeToDevices — how the resident's home screen is told
   * who looked in (INV-2). Absent, the look is still kept, and the
   * television reads it when it next connects.
   */
  readonly sendHome?: SendHome;
  /** The household's own rows, read by the tools. */
  readonly ddb: DynamoDBClient;
  /** The pairing API's POST /pair/claim, called as the signed-in person. */
  readonly claimTelevision?: ClaimTelevision;
  /** The home's own Ring link (accounts/apiRouter.ts `/api/ring`). Absent, those routes say Ring cannot be reached. */
  readonly ringLinks?: RingLinks;
  /** Let a visitor become an anonymous guest in one click (accounts/demo.ts). Off unless set. */
  readonly demoAccounts?: boolean;
  /** How many guests the demo may make in an hour (accounts/demo.ts DEMO_ACCOUNTS_PER_HOUR unless set). */
  readonly demoAccountsPerHour?: number;
  /** The model behind the family app's conversation (assistant/brain.ts). Without one the app answers by its rules. */
  readonly assistant?: AssistantDeps;
  /** A television in a browser tab, for someone with no Fire TV to hand (apps/ops-console/device.html). */
  readonly virtualTelevisionUrl?: string;
  /**
   * The mantelpiece (photos/send.ts): the bucket a picture is put in, and
   * the one look taken at it first. Absent — or with either half missing —
   * a picture is refused in words: nothing is ever sent unchecked.
   */
  readonly photos?: { readonly objects: PhotoObjects; readonly moderate: Moderation } | undefined;
  /**
   * A demo home's stand-in doorbell (accounts/demoDoorbell.ts): hands one
   * ring to the Door agent. Absent, a member of a demo home is told this
   * Wick has none.
   */
  readonly ringDemoDoor?: ((event: DemoDoorEvent) => Promise<void>) | undefined;
  /**
   * Ask by voice (hear/transcribe.ts): one spoken question turned into words
   * by Amazon Transcribe. Absent, `/api/hear` says this Wick cannot hear yet.
   */
  readonly hear?: Hear | undefined;
  readonly now?: () => number;
  readonly newId?: () => string;
}

/**
 * What every answer of this server says about itself. The sign-in and
 * Approve pages are never shown inside another site's frame — a framed
 * Approve button is a press somebody else arranged — and nothing here is
 * read as another type than it says. No address leaves in a Referer: an
 * invitation's code and an authorization code both travel in one. Over
 * HTTPS, a browser is told to come back no other way for a year.
 */
export function securityHeaders(issuerUrl: URL): express.RequestHandler {
  const https = issuerUrl.protocol === 'https:';
  return (_req, res, next) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('content-security-policy', "frame-ancestors 'none'");
    res.setHeader('referrer-policy', 'no-referrer');
    if (https) res.setHeader('strict-transport-security', 'max-age=31536000');
    next();
  };
}

export function createApp(issuerUrl: URL, deps: AppDeps): express.Express {
  const { ddb } = deps;
  const circle: CircleDeps = {
    store: deps.store,
    sendCard: deps.sendCard,
    now: deps.now ?? Date.now,
    newId: deps.newId ?? randomId,
  };
  const { router: authRouter, requireAuth } = createAuth(issuerUrl, circle, deps.identity, {
    demoAccounts: deps.demoAccounts,
    demoAccountsPerHour: deps.demoAccountsPerHour,
    // A guest's home starts with six weeks to ask about, marked simulated (accounts/demoHome.ts).
    seedDemoHome: (householdId) =>
      seedDemoHome((item) => ddb.send(new PutItemCommand({ TableName: TABLE, Item: item })), householdId, circle.now(), HOUSEHOLD_TZ),
  });

  const app = express();
  // Deployed, the server sits behind exactly one proxy (App Runner's), and
  // every request arrives from that proxy's address. Without this, the
  // SDK's rate limits count the proxy — so its 20 app registrations an hour
  // would be 20 for everyone in the world put together. One hop is trusted,
  // no more: the address used is the one App Runner itself appended, which a
  // caller cannot forge. Locally (http) there is no proxy, and none is trusted.
  if (issuerUrl.protocol === 'https:') app.set('trust proxy', 1);
  app.use(securityHeaders(issuerUrl));
  app.use(express.json());
  app.use(authRouter);
  const push = createPushStore(ddb, process.env.TABLE_NAME ?? 'wick');
  // A person's own data: the file of it, and their account's deletion (accounts/myData.ts). Before the
  // rest of /api, so the one sign-in check is this router's.
  app.use(createAccountDataRouter({
    store: deps.store,
    ddb,
    identity: deps.identity,
    now: circle.now,
    push,
    ringLinks: deps.ringLinks,
    photos: deps.photos?.objects,
  }, requireAuth));
  app.use(createApiRouter(circle, requireAuth, {
    claimTelevision: deps.claimTelevision,
    ringLinks: deps.ringLinks,
    virtualTelevisionUrl: deps.virtualTelevisionUrl,
    timeZone: HOUSEHOLD_TZ,
    push,
    // The language of her television (accounts/language.ts): a question the organiser can take back again.
    withdrawCard: deps.withdrawCard,
    // The mantelpiece: a picture reaches her television through the same sender as a note (INV-2).
    photos: createPhotoRoutes({
      ddb,
      store: deps.store,
      objects: deps.photos?.objects,
      moderate: deps.photos?.moderate,
      sendCard: deps.sendCard,
      withdrawCard: deps.withdrawCard,
      now: circle.now,
      newId: circle.newId,
      timeZone: HOUSEHOLD_TZ,
    }),
    // Somebody at a demo home's door, for the Door agent's own path (accounts/demoDoorbell.ts).
    demoDoorbell: { ddb, store: deps.store, ring: deps.ringDemoDoor, now: circle.now, newId: circle.newId },
    // Ask by voice: the words are asked afterwards like typed ones, through the same gated paths.
    hear: createHearRoute({ hear: deps.hear, store: deps.store, now: circle.now }),
  }));

  // The tool list is the same for everyone and for the life of the process: asked for once, on first need.
  let toolSpecs: Promise<ToolSpec[]> | undefined;
  app.use(createAssistantRouter({
    assistant: deps.assistant,
    requireAuth,
    store: deps.store,
    toolSpecs: () => (toolSpecs ??= listToolSpecs(ddb)),
    now: circle.now,
    timeZone: HOUSEHOLD_TZ,
  }));

  // A family member's own television (accounts/familyTelevision.ts): what
  // that one member may already read and answer through the tools below,
  // asked for with the television's own device token. It reaches the
  // resident's television only through the same senders the tools are given
  // (INV-2), and learns whose it is from its token and its row (INV-8).
  app.use(createFamilyTelevisionRouter({
    ddb,
    store: deps.store,
    sendCard: deps.sendCard,
    sendPatch: deps.sendPatch,
    withdrawCard: deps.withdrawCard,
    sendHome: deps.sendHome,
    now: circle.now,
  }));

  // No sessions. Every request is answered by a server built for the person
  // and household its own token names (INV-8), and thrown away when the
  // answer has gone.
  //
  // Sessions used to be held here, in a map in this process's memory: a
  // redeploy forgot every one of them, and a second instance would have had
  // a different set — a client that had initialized against one would be
  // told "Server not initialized" by the other. Nothing an MCP session
  // carries is needed for that cost: the tools keep no state between calls,
  // and who is asking is settled by the token, per request. So there is no
  // session to lose, and nothing that pins a client to one instance.
  //
  // The SDK's stateless mode (`sessionIdGenerator: undefined`): one transport
  // and one McpServer per request, each closed when the response is — its
  // own reference, installed SDK 1.30.0:
  // node_modules/@modelcontextprotocol/sdk/dist/esm/examples/server/simpleStatelessStreamableHttp.js.
  // A transport in this mode does not ask for `initialize` first and ignores
  // any `Mcp-Session-Id` a client still sends from before.
  //
  // apps/sim-alexa (and any real browser client) runs on a different origin
  // than this server and sends a custom `authorization` header on every /mcp
  // request, which triggers a browser CORS preflight (`OPTIONS /mcp`). Only
  // this route needs it — mcpAuthRouter's own routes already call cors()
  // internally, so this is scoped here rather than applied app-wide.
  const mcpCors = cors();

  app.options('/mcp', mcpCors);
  app.post('/mcp', mcpCors, requireAuth(), async (req, res) => {
    try {
      // INV-8: who this request is for comes from its verified token.
      const grant = grantOf(req.auth);
      if (!grant) {
        res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Link Wick again.' }, id: null });
        return;
      }

      const mcpServer = createMcpServer(ddb, {
        householdId: grant.householdId,
        userId: grant.userId,
        access: () => checkAccess(deps.store, grant.householdId, grant.userId),
        // The light in the window: asking after the resident is something the resident is told.
        lookedIn: (allowed) =>
          recordLook(ddb, { householdId: grant.householdId, userId: grant.userId, name: allowed.membership.name }, (deps.now ?? Date.now)(), deps.sendHome ?? (async () => {})),
      }, deps.sendCard, deps.sendPatch, deps.withdrawCard);
      // No `sessionIdGenerator` given: that is what makes it stateless.
      const transport = new StreamableHTTPServerTransport({});
      res.on('close', () => {
        void transport.close();
        void mcpServer.close();
      });
      // StreamableHTTPServerTransport's onclose/onerror/onmessage accessors are typed
      // `X | undefined` even though Transport declares them as optional `X` — under this
      // repo's `exactOptionalPropertyTypes`, those aren't the same type. The class does
      // structurally implement Transport (verified against the SDK's own `implements
      // Transport` on this class, installed SDK 1.30.0); the cast just routes around the
      // accessor-vs-optional-property mismatch.
      await mcpServer.connect(transport as unknown as Transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      // An uncaught error here must never propagate to Express's default
      // handler, which would leak a raw stack trace as a bare 500. Match the
      // SDK's own shipped error shape (ErrorCode.InternalError, verified in
      // node_modules/@modelcontextprotocol/sdk/dist/esm/types.js).
      console.error('[wick/mcp-server] Error handling POST /mcp:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          id: null,
          error: { code: ErrorCode.InternalError, message: 'Internal server error' },
        });
      }
    }
  });

  // With no session there is no stream to open and nothing to end (MCP
  // Streamable HTTP: a server that offers neither answers 405).
  const noSessions: express.RequestHandler = (_req, res) => {
    res.status(405).set('Allow', 'POST').json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. This server keeps no sessions: send each request as a POST.' },
      id: null,
    });
  };
  app.get('/mcp', mcpCors, noSessions);
  app.delete('/mcp', mcpCors, noSessions);

  return app;
}
