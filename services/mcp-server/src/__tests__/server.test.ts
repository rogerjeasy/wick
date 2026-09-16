import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
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
