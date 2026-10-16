/**
 * A small Wick MCP server, in this process, over real Streamable HTTP: the
 * agent's McpClient talks MCP to it exactly as it talks to the deployed
 * server. It answers only a request carrying the expected bearer token, and
 * records every Authorization header it was sent and every tool call. Test
 * only: lives under __tests__ and never ships.
 */
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';

export interface WickMcp {
  readonly url: string;
  /** Every Authorization header received, in order. */
  readonly authorizations: string[];
  /** Every tool call that ran, in order. */
  readonly calls: { readonly name: string; readonly args: Record<string, unknown> }[];
  close(): Promise<void>;
}

const READS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

export async function startWickMcp(token: string): Promise<WickMcp> {
  const authorizations: string[] = [];
  const calls: { name: string; args: Record<string, unknown> }[] = [];

  const serverFor = (): McpServer => {
    const mcp = new McpServer({ name: 'wick-test', version: '0.0.0' });
    const ran = (name: string, args: Record<string, unknown>) => calls.push({ name, args });

    mcp.registerTool('get_today', {
      title: 'A day’s events',
      description: 'What happened at the house on a day.',
      inputSchema: { day: z.string().optional() },
      annotations: READS,
    }, async (args) => {
      ran('get_today', args);
      return text({ dayInWords: 'today', doorbell: 6, films: 2 });
    });

    mcp.registerTool('send_note_to_tv', {
      title: 'Send a note to the television',
      description: 'Puts a note on the television.',
      inputSchema: { message: z.string() },
      annotations: WRITES,
    }, async (args) => {
      ran('send_note_to_tv', args);
      return text({ sent: true, cardId: 'card_1' });
    });

    mcp.registerTool('arrange_visit', {
      title: 'Arrange a visit',
      description: 'Tells the door whom to expect, and when.',
      inputSchema: { who: z.string(), day: z.string(), time: z.string() },
      annotations: WRITES,
    }, async (args) => {
      ran('arrange_visit', args);
      return text({ errandId: 'err_1', who: args.who, at: Date.UTC(2026, 9, 22, 9), status: 'planned' });
    });

    // No annotations at all: unknown is not read-only.
    mcp.registerTool('expect_visit', {
      description: 'Tells the door when the member will come.',
      inputSchema: { day: z.string() },
    }, async (args) => {
      ran('expect_visit', args);
      return text({ expected: true });
    });

    return mcp;
  };

  const http = createServer(async (req, res) => {
    authorizations.push(String(req.headers.authorization ?? ''));
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_token' }));
      return;
    }
    // Stateless, as the deployed server is: a server and a transport for each request.
    const mcp = serverFor();
    const transport = new StreamableHTTPServerTransport({} as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    // The same cast the deployed server makes (services/mcp-server/src/server.ts): the SDK's types and exactOptionalPropertyTypes disagree.
    await mcp.connect(transport as unknown as Transport);
    await transport.handleRequest(req, res, req.method === 'POST' ? await bodyOf(req) : undefined);
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    authorizations,
    calls,
    close: () => new Promise<void>((resolve) => {
      http.closeAllConnections();
      http.close(() => resolve());
    }),
  };
}
