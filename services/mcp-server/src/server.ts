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
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
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
    // StreamableHTTPServerTransport's onclose/onerror/onmessage accessors are typed
    // `X | undefined` even though Transport declares them as optional `X` — under this
    // repo's `exactOptionalPropertyTypes`, those aren't the same type. The class does
    // structurally implement Transport (verified against the SDK's own `implements
    // Transport` on this class, installed SDK 1.30.0); the cast just routes around the
    // accessor-vs-optional-property mismatch.
    await mcpServer.connect(transport as unknown as Transport);
    await transport.handleRequest(req, res, req.body);
  });

  return app;
}
