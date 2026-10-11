import { describe, expect, it } from 'vitest';
import {
  ALEXA_CLIENT_VERSION,
  SPEC_VERSION,
  checkAuthMetadata,
  checkImages,
  checkLegalPages,
  checkMcp,
  checkUnauthenticated,
  type Fetch,
} from '../addon/preflight.js';
import { demoToken } from '../addon/demo-token.js';

const ENDPOINT = 'https://mcp.wick.test/mcp';

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

const manifest = (icon: { size: string; uri: string }) => ({
  storeListing: {
    locales: {
      'en-US': {
        privacyAndCompliance: { privacyPolicyUrl: 'https://wick.test/privacy.html', termsOfUseUrl: 'https://wick.test/terms.html' },
        mediaAssets: { icons: { light: [icon] } },
      },
    },
  },
});

/** A server that answers each URL with what the table says, and 404 otherwise. */
const serving = (table: Record<string, () => Response>): Fetch => async (url) => table[url]?.() ?? new Response('not found', { status: 404 });

describe('checkImages', () => {
  const icon = { size: '72x72', uri: 'https://wick.test/icons/light-72.png' };
  const served = (body: Uint8Array, type = 'image/png') => serving({ [icon.uri]: () => new Response(body, { headers: { 'content-type': type } }) });

  it('passes an image that is the size the manifest says', async () => {
    expect(await checkImages(manifest(icon), served(png(72, 72)))).toEqual([{ name: `image ${icon.uri}`, outcome: 'pass', detail: '72x72' }]);
  });

  it('fails an image of another size, and says which', async () => {
    const [result] = await checkImages(manifest(icon), served(png(96, 96)));

    expect(result).toMatchObject({ outcome: 'fail', detail: 'is 96x96; the manifest says 72x72' });
  });

  it('fails an image that is missing, or served as something that is not an image', async () => {
    const [missing] = await checkImages(manifest(icon), serving({}));
    const [html] = await checkImages(manifest(icon), served(png(72, 72), 'text/html'));

    expect(missing).toMatchObject({ outcome: 'fail', detail: 'answered 404' });
    expect(html?.outcome).toBe('fail');
  });

  it('does not vouch for the size of a JPEG it cannot read', async () => {
    const [result] = await checkImages(manifest(icon), served(new Uint8Array(40), 'image/jpeg'));

    expect(result?.outcome).toBe('skip');
  });

  it('fails, rather than throws, when the network does', async () => {
    const [result] = await checkImages(manifest(icon), async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });

    expect(result).toMatchObject({ outcome: 'fail', detail: 'could not be fetched: getaddrinfo ENOTFOUND' });
  });
});

describe('checkLegalPages', () => {
  it('passes a live page and fails a missing one', async () => {
    const results = await checkLegalPages(
      manifest({ size: '72x72', uri: 'https://wick.test/i.png' }),
      serving({ 'https://wick.test/privacy.html': () => new Response('<p>privacy</p>') }),
    );

    expect(results.map((r) => r.outcome)).toEqual(['pass', 'fail']);
  });
});

describe('checkUnauthenticated', () => {
  const answering = (status: number, headers: Record<string, string> = {}): Fetch => async () => new Response('', { status, headers });

  it('passes a bare 401', async () => {
    expect((await checkUnauthenticated(ENDPOINT, answering(401))).outcome).toBe('pass');
  });

  it('fails a 401 that carries WWW-Authenticate, which Alexa+ asks servers not to send', async () => {
    expect((await checkUnauthenticated(ENDPOINT, answering(401, { 'www-authenticate': 'Bearer' }))).outcome).toBe('fail');
  });

  it('fails a server that answers a stranger', async () => {
    expect(await checkUnauthenticated(ENDPOINT, answering(200))).toMatchObject({ outcome: 'fail', detail: 'answered 200; 401 is required' });
  });
});

describe('checkAuthMetadata', () => {
  const metadataUrl = 'https://mcp.wick.test/.well-known/oauth-authorization-server';
  const meta = (body: object) => serving({ [metadataUrl]: () => Response.json(body) });
  const complete = { code_challenge_methods_supported: ['S256'], authorization_endpoint: 'https://mcp.wick.test/authorize', token_endpoint: 'https://mcp.wick.test/token' };

  it('passes metadata that offers PKCE S256 and both endpoints', async () => {
    expect((await checkAuthMetadata(ENDPOINT, meta(complete))).outcome).toBe('pass');
  });

  it('fails metadata without S256', async () => {
    expect((await checkAuthMetadata(ENDPOINT, meta({ ...complete, code_challenge_methods_supported: ['plain'] }))).outcome).toBe('fail');
  });

  it('fails metadata with no token endpoint, and a server with no metadata', async () => {
    expect((await checkAuthMetadata(ENDPOINT, meta({ ...complete, token_endpoint: undefined }))).detail).toBe('has no token_endpoint');
    expect((await checkAuthMetadata(ENDPOINT, serving({}))).outcome).toBe('fail');
  });
});

describe('checkMcp', () => {
  const TOOLS = [
    { name: 'send_note_to_tv', title: 'Send a note', description: 'Puts a note on the television.', annotations: { readOnlyHint: false }, inputSchema: { required: ['message'] } },
    { name: 'get_today', title: 'Today', description: 'What happened today.', annotations: { readOnlyHint: true }, inputSchema: {} },
  ];

  /** An MCP server over SSE, like the real one: each method answers with what the table gives. */
  function mcpServer(overrides: Partial<Record<string, (params: Record<string, unknown>) => unknown>> = {}) {
    const seen: { method: string; params: Record<string, unknown>; authorization: string | null }[] = [];
    const handlers: Record<string, (params: Record<string, unknown>) => unknown> = {
      initialize: (params) => ({ protocolVersion: params.protocolVersion, serverInfo: { name: 'wick', version: '0.2.0' }, capabilities: { tools: {} } }),
      'tools/list': () => ({ tools: TOOLS }),
      'tools/call': () => ({ structuredContent: { events: [] }, content: [{ type: 'text', text: '{"events":[]}' }] }),
      ...overrides,
    };
    const fetch: Fetch = async (_url, init) => {
      const message = JSON.parse(String(init?.body)) as { id: number; method: string; params: Record<string, unknown> };
      const authorization = new Headers(init?.headers).get('authorization');
      seen.push({ method: message.method, params: message.params, authorization });
      const result = handlers[message.method]?.(message.params);
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    };
    return { fetch, seen };
  }

  /** A clock that moves `step` ms each time it is read: every call takes that long. */
  const clock = (step: number) => {
    let at = 0;
    return () => (at += step);
  };

  it('passes a server that answers hello, lists described tools and answers a question quickly', async () => {
    const server = mcpServer();

    const results = await checkMcp(ENDPOINT, 'token-1', server.fetch, clock(120));

    expect(results.map((r) => [r.name, r.outcome])).toEqual([
      ['initialize', 'pass'],
      [`initialize at ${ALEXA_CLIENT_VERSION}`, 'pass'],
      ['tools/list', 'pass'],
      ['tools/list round trip', 'pass'],
      ['tools/call get_today', 'pass'],
      ['tools/call get_today round trip', 'pass'],
    ]);
    expect(server.seen.every((call) => call.authorization === 'Bearer token-1')).toBe(true);
  });

  it('says hello twice: at the spec the rules name, and the way the docs show the Alexa+ client doing it', async () => {
    const server = mcpServer();

    await checkMcp(ENDPOINT, 'token-1', server.fetch, clock(1));

    const hellos = server.seen.filter((call) => call.method === 'initialize').map((call) => call.params);
    expect(hellos.map((p) => p.protocolVersion)).toEqual([SPEC_VERSION, ALEXA_CLIENT_VERSION]);
    expect(hellos[1]?.capabilities).toEqual({ roots: { listChanged: true } });
  });

  it('calls a tool that only reads and needs no arguments — never one that writes', async () => {
    const server = mcpServer();

    await checkMcp(ENDPOINT, 'token-1', server.fetch, clock(1));

    const called = server.seen.filter((call) => call.method === 'tools/call').map((call) => call.params.name);
    expect(new Set(called)).toEqual(new Set(['get_today']));
  });

  it('fails a round trip over 500 ms', async () => {
    const results = await checkMcp(ENDPOINT, 'token-1', mcpServer().fetch, clock(640));

    expect(results.find((r) => r.name === 'tools/list round trip')).toMatchObject({ outcome: 'fail' });
    expect(results.find((r) => r.name === 'tools/list round trip')?.detail).toContain('median 640 ms');
  });

  it('fails a tool with no title, and names it', async () => {
    const server = mcpServer({ 'tools/list': () => ({ tools: [{ ...TOOLS[1], title: undefined }] }) });

    const listed = (await checkMcp(ENDPOINT, 'token-1', server.fetch, clock(1))).find((r) => r.name === 'tools/list');

    expect(listed).toMatchObject({ outcome: 'fail', detail: 'missing a title, description or annotations: get_today' });
  });

  it('does not vouch for structured content when the answer is only words — a guest nobody has allowed yet', async () => {
    const server = mcpServer({ 'tools/call': () => ({ content: [{ type: 'text', text: "Margaret hasn't allowed this yet." }] }) });

    const called = (await checkMcp(ENDPOINT, 'token-1', server.fetch, clock(1))).find((r) => r.name === 'tools/call get_today');

    expect(called?.outcome).toBe('skip');
    expect(called?.detail).toContain("Margaret hasn't allowed this yet.");
  });

  it('fails a server that answers a newer hello with an older protocol', async () => {
    const server = mcpServer({ initialize: () => ({ protocolVersion: '2024-11-05', capabilities: { tools: {} } }) });

    const [hello] = await checkMcp(ENDPOINT, 'token-1', server.fetch, clock(1));

    expect(hello).toMatchObject({ name: 'initialize', outcome: 'fail' });
  });

  it('stops at once when the token is refused', async () => {
    const refused: Fetch = async () => new Response('', { status: 401 });

    expect(await checkMcp(ENDPOINT, 'stale', refused, clock(1))).toEqual([{ name: 'initialize', outcome: 'fail', detail: 'the token was refused (401)' }]);
  });
});

describe('demoToken', () => {
  const SERVER = 'https://mcp.wick.test';

  function demoServer(accountAnswer: () => Response) {
    const asked: string[] = [];
    const fetch: Fetch = async (url, init) => {
      asked.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      const { pathname, searchParams } = new URL(url);
      if (pathname === '/.well-known/oauth-authorization-server') {
        return Response.json({ registration_endpoint: `${SERVER}/register`, authorization_endpoint: `${SERVER}/authorize`, token_endpoint: `${SERVER}/token` });
      }
      if (pathname === '/register') return Response.json({ client_id: 'client-1' }, { status: 201 });
      if (pathname === '/authorize') {
        expect(searchParams.get('demo')).toBe('1');
        expect(searchParams.get('code_challenge_method')).toBe('S256');
        return new Response(null, { status: 302, headers: { location: '/account?tx=tx-1' } });
      }
      if (pathname === '/account') return accountAnswer();
      if (pathname === '/token') {
        const form = new URLSearchParams(String(init?.body));
        expect(form.get('code')).toBe('code-1');
        expect(form.get('code_verifier')).toMatch(/^[\w-]{43}$/);
        return Response.json({ access_token: 'guest-token' });
      }
      return new Response('', { status: 404 });
    };
    return { fetch, asked };
  }

  it('follows the demo sign-in to a guest token', async () => {
    const server = demoServer(() => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9/addon-check?code=code-1' } }));

    expect(await demoToken(SERVER, server.fetch)).toBe('guest-token');
    expect(server.asked).toEqual(['GET /.well-known/oauth-authorization-server', 'POST /register', 'GET /authorize', 'GET /account', 'POST /token']);
  });

  it('says so when the hour\'s guests have all been made', async () => {
    const server = demoServer(() => new Response('busy', { status: 429 }));

    await expect(demoToken(SERVER, server.fetch)).rejects.toThrow('guests for this hour');
  });

  it('says so when the server offers no demo', async () => {
    const server = demoServer(() => new Response('<form>sign in</form>', { status: 200 }));

    await expect(demoToken(SERVER, server.fetch)).rejects.toThrow('no demo account was offered');
  });
});
