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
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { createAuthRouter, requireAuth } from './auth.js';
import { registerGetResidentSharedView } from './tools/get_resident_shared_view.js';
import { registerGetWeekNarrative } from './tools/get_week_narrative.js';
import { registerGetToday } from './tools/get_today.js';
import { registerDidVisitorCome } from './tools/did_visitor_come.js';
import { registerSendNoteToTv } from './tools/send_note_to_tv.js';

export const TABLE = process.env.TABLE_NAME ?? 'wick';

export function createApp(issuerUrl: URL): express.Express {
  const ddb = new DynamoDBClient({});
  const mcpServer = new McpServer({ name: 'wick', version: '0.1.0' });

  registerGetResidentSharedView(mcpServer, ddb);
  registerGetWeekNarrative(mcpServer, ddb);
  registerGetToday(mcpServer, ddb);
  registerDidVisitorCome(mcpServer, ddb);
  registerSendNoteToTv(mcpServer);

  const app = express();
  app.use(express.json());
  app.use(createAuthRouter(issuerUrl));

  // Session-keyed transports. StreamableHTTPServerTransport in stateful mode
  // (`sessionIdGenerator` set) only flips its internal `_initialized` flag on the
  // SAME transport instance that handled `initialize` — every other request routes
  // through `validateSession()`, which 400s "Server not initialized" against a fresh
  // instance. So the transport for a session must be created once, on `initialize`,
  // and REUSED for every subsequent request carrying that session's `Mcp-Session-Id`
  // header — never reconstructed per request. Pattern verified against the SDK's own
  // shipped reference server, installed SDK 1.30.0:
  // node_modules/@modelcontextprotocol/sdk/dist/esm/examples/server/simpleStreamableHttp.js
  // (mcpPostHandler, ~lines 566-625: the `transports` map, `onsessioninitialized`
  // storing the transport keyed by its generated session id, and `transport.onclose`
  // deleting that entry). `onsessioninitialized`/`onclose` signatures confirmed against
  // node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.d.ts.
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  // apps/sim-alexa (and any real browser client) runs on a different origin than
  // this server and sends custom `authorization`/`mcp-session-id` headers on every
  // /mcp request, which triggers a browser CORS preflight (`OPTIONS /mcp`). Only
  // this route needs it — mcpAuthRouter's own routes already call cors()
  // internally, so this is scoped here rather than applied app-wide. The session
  // id is read back from the response by client JS (main.js's sendMcpMessage()),
  // so it must be explicitly exposed — browsers hide non-exposed response headers
  // from JS under CORS by default (verified against @types/cors's CorsOptions,
  // installed @types/cors 2.8.19: `exposedHeaders?: string | string[]`).
  const mcpCors = cors({ exposedHeaders: ['Mcp-Session-Id'] });

  app.options('/mcp', mcpCors);
  app.post('/mcp', mcpCors, requireAuth(), async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];

    if (typeof sessionId === 'string' && transports[sessionId]) {
      // Existing session: reuse its already-`connect()`ed transport. Do not
      // reconstruct or reconnect — that would recreate the exact bug being fixed.
      await transports[sessionId].handleRequest(req, res, req.body);
      return;
    }

    if (sessionId === undefined && isInitializeRequest(req.body)) {
      // Genuine new session: construct exactly one transport for its lifetime.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid !== undefined) delete transports[sid];
      };
      // StreamableHTTPServerTransport's onclose/onerror/onmessage accessors are typed
      // `X | undefined` even though Transport declares them as optional `X` — under this
      // repo's `exactOptionalPropertyTypes`, those aren't the same type. The class does
      // structurally implement Transport (verified against the SDK's own `implements
      // Transport` on this class, installed SDK 1.30.0); the cast just routes around the
      // accessor-vs-optional-property mismatch.
      await mcpServer.connect(transport as unknown as Transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
      id: null,
    });
  });

  return app;
}
