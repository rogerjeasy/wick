/**
 * The checks that need the network: what a deploy of the add-on would meet
 * when it reached Wick's published files and its MCP server.
 *
 * Each is what Amazon's add-on docs say is required (the MCP Toolkit
 * quickstart, and the "Alexa+ MCP Client and App Lifecycle" page, both read
 * 2026-10-11). They are run from here because `alexa-ai deploy`, which would
 * run them, is open to select partners only (FRICTION.md FL-001).
 *
 * `fetch` and the clock are passed in, so every check is tested with no
 * network (scripts/__tests__/addon-preflight.test.ts).
 */
import { manifestImages, manifestLegalUrls } from './manifest-rules.js';
import { pngSize, sizeLabel } from './image-size.js';

export type Outcome = 'pass' | 'fail' | 'skip';

export interface CheckResult {
  readonly name: string;
  readonly outcome: Outcome;
  /** What was measured, in words a person reads in a terminal. */
  readonly detail: string;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Amazon's stated limit for one round trip to an add-on's server. */
export const LATENCY_LIMIT_MS = 500;
const LATENCY_SAMPLES = 5;

const IMAGE_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
/** The newest spec, which the quickstart and the hackathon rules name. */
export const SPEC_VERSION = '2025-11-25';
/** What the client lifecycle page shows the Alexa+ client sending. */
export const ALEXA_CLIENT_VERSION = '2025-03-26';

const pass = (name: string, detail: string): CheckResult => ({ name, outcome: 'pass', detail });
const fail = (name: string, detail: string): CheckResult => ({ name, outcome: 'fail', detail });
const skip = (name: string, detail: string): CheckResult => ({ name, outcome: 'skip', detail });
const why = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Every image answers, is an allowed type, and is the size the manifest says. */
export async function checkImages(manifest: unknown, fetch: Fetch): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const image of manifestImages(manifest)) {
    const name = `image ${image.uri}`;
    try {
      const res = await fetch(image.uri);
      const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
      if (res.status !== 200) {
        results.push(fail(name, `answered ${res.status}`));
      } else if (!IMAGE_CONTENT_TYPES.includes(type)) {
        results.push(fail(name, `is served as "${type}"; PNG, JPG or WEBP is required`));
      } else if (type !== 'image/png') {
        results.push(skip(name, `is ${type}; only a PNG's size is read here, so ${image.size} is unconfirmed`));
      } else {
        const size = pngSize(new Uint8Array(await res.arrayBuffer()));
        if (!size) results.push(fail(name, 'is served as a PNG but does not read as one'));
        else if (sizeLabel(size) !== image.size) results.push(fail(name, `is ${sizeLabel(size)}; the manifest says ${image.size}`));
        else results.push(pass(name, image.size));
      }
    } catch (err) {
      results.push(fail(name, `could not be fetched: ${why(err)}`));
    }
  }
  return results;
}

/** The privacy policy and the terms are live pages. */
export async function checkLegalPages(manifest: unknown, fetch: Fetch): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const page of manifestLegalUrls(manifest)) {
    const name = `page ${page.uri}`;
    try {
      const res = await fetch(page.uri);
      results.push(res.status === 200 ? pass(name, '200') : fail(name, `answered ${res.status}`));
    } catch (err) {
      results.push(fail(name, `could not be fetched: ${why(err)}`));
    }
  }
  return results;
}

/** One JSON-RPC message over Streamable HTTP. The reply may be JSON or one SSE event. */
export async function rpc(endpoint: string, token: string | undefined, message: object, fetch: Fetch): Promise<{ status: number; headers: Headers; body?: Record<string, unknown> }> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(message),
  });
  const raw = await res.text();
  if (!raw.trim()) return { status: res.status, headers: res.headers };
  const type = res.headers.get('content-type') ?? '';
  try {
    if (type.includes('text/event-stream')) {
      const data = raw.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
      const last = data.at(-1);
      return { status: res.status, headers: res.headers, ...(last ? { body: JSON.parse(last) as Record<string, unknown> } : {}) };
    }
    return { status: res.status, headers: res.headers, body: JSON.parse(raw) as Record<string, unknown> };
  } catch {
    return { status: res.status, headers: res.headers };
  }
}

/** With no token the server says 401 and nothing else: Alexa+ asks for no `WWW-Authenticate`. */
export async function checkUnauthenticated(endpoint: string, fetch: Fetch): Promise<CheckResult> {
  const name = 'no token is refused';
  try {
    const res = await rpc(endpoint, undefined, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, fetch);
    if (res.status !== 401) return fail(name, `answered ${res.status}; 401 is required`);
    if (res.headers.get('www-authenticate')) return fail(name, '401, but with a WWW-Authenticate header, which Alexa+ asks servers not to send');
    return pass(name, '401, no WWW-Authenticate');
  } catch (err) {
    return fail(name, `the server could not be reached: ${why(err)}`);
  }
}

/** The server says how to sign in, and that it takes PKCE with S256. */
export async function checkAuthMetadata(endpoint: string, fetch: Fetch): Promise<CheckResult> {
  const name = 'sign-in metadata';
  const url = new URL('/.well-known/oauth-authorization-server', endpoint).toString();
  try {
    const res = await fetch(url);
    if (res.status !== 200) return fail(name, `${url} answered ${res.status}`);
    const meta = (await res.json()) as Record<string, unknown>;
    const methods = Array.isArray(meta.code_challenge_methods_supported) ? meta.code_challenge_methods_supported : [];
    if (!methods.includes('S256')) return fail(name, 'does not list S256 in code_challenge_methods_supported');
    for (const key of ['authorization_endpoint', 'token_endpoint']) {
      if (typeof meta[key] !== 'string') return fail(name, `has no ${key}`);
    }
    return pass(name, 'PKCE S256, authorization and token endpoints');
  } catch (err) {
    return fail(name, `could not be read: ${why(err)}`);
  }
}

interface ToolListing {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly annotations?: { readonly readOnlyHint?: boolean };
  readonly inputSchema?: { readonly required?: readonly string[] };
}

export const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

async function timed(call: () => Promise<unknown>, now: () => number): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < LATENCY_SAMPLES; i += 1) {
    const started = now();
    await call();
    samples.push(now() - started);
  }
  return Math.round(median(samples));
}

const latency = (name: string, ms: number): CheckResult =>
  ms <= LATENCY_LIMIT_MS
    ? pass(name, `median ${ms} ms over ${LATENCY_SAMPLES} calls, from this machine (limit ${LATENCY_LIMIT_MS} ms)`)
    : fail(name, `median ${ms} ms over ${LATENCY_SAMPLES} calls, from this machine; the limit is ${LATENCY_LIMIT_MS} ms`);

/**
 * The conversation an MCP client has with the server once it holds a token:
 * hello, the tool list, one question that only reads — and how long each took.
 */
export async function checkMcp(endpoint: string, token: string, fetch: Fetch, now: () => number = Date.now): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  let id = 100;
  const ask = (method: string, params: object) => rpc(endpoint, token, { jsonrpc: '2.0', id: (id += 1), method, params }, fetch);
  const answered = (body: Record<string, unknown> | undefined) => (body?.result as Record<string, unknown> | undefined);

  try {
    const hello = await ask('initialize', { protocolVersion: SPEC_VERSION, capabilities: {}, clientInfo: { name: 'wick-addon-check', version: '1.0.0' } });
    const result = answered(hello.body);
    if (hello.status === 401) return [fail('initialize', 'the token was refused (401)')];
    if (!result) return [fail('initialize', `answered ${hello.status} with no result`)];
    results.push(
      result.protocolVersion === SPEC_VERSION
        ? pass('initialize', `protocol ${SPEC_VERSION}`)
        : fail('initialize', `answered protocol ${String(result.protocolVersion)}; ${SPEC_VERSION} was asked for`),
    );

    // The same hello, shaped the way Amazon's docs show the Alexa+ client's.
    const asAlexa = await ask('initialize', {
      protocolVersion: ALEXA_CLIENT_VERSION,
      capabilities: { roots: { listChanged: true } },
      clientInfo: { name: 'wick-addon-check (as the documented Alexa+ client)', version: '1.0.0' },
    });
    const alexa = answered(asAlexa.body);
    const capabilities = (alexa?.capabilities ?? {}) as Record<string, unknown>;
    if (!alexa) {
      results.push(fail(`initialize at ${ALEXA_CLIENT_VERSION}`, `answered ${asAlexa.status} with no result`));
    } else if (!capabilities.tools) {
      results.push(fail(`initialize at ${ALEXA_CLIENT_VERSION}`, 'the server does not advertise tools'));
    } else {
      const resources = capabilities.resources ? 'resources advertised' : 'no resources advertised (the docs\' example lists them; Wick has none)';
      results.push(pass(`initialize at ${ALEXA_CLIENT_VERSION}`, `answered protocol ${String(alexa.protocolVersion)}; tools advertised; ${resources}`));
    }

    const listed = await ask('tools/list', {});
    const tools = ((answered(listed.body)?.tools ?? []) as ToolListing[]).filter((t) => typeof t?.name === 'string');
    if (tools.length === 0) return [...results, fail('tools/list', 'no tools listed')];
    const bare = tools.filter((t) => !t.title || !t.description || !t.annotations).map((t) => t.name);
    results.push(
      bare.length === 0
        ? pass('tools/list', `${tools.length} tools, each with a title, a description and annotations`)
        : fail('tools/list', `missing a title, description or annotations: ${bare.join(', ')}`),
    );
    results.push(latency('tools/list round trip', await timed(() => ask('tools/list', {}), now)));

    const readOnly = tools.find((t) => t.annotations?.readOnlyHint === true && (t.inputSchema?.required ?? []).length === 0);
    if (!readOnly) return [...results, skip('tools/call', 'no read-only tool that needs no arguments')];
    const called = answered((await ask('tools/call', { name: readOnly.name, arguments: {} })).body);
    if (!called) {
      results.push(fail(`tools/call ${readOnly.name}`, 'no result'));
    } else if (called.structuredContent) {
      results.push(pass(`tools/call ${readOnly.name}`, 'answered with structuredContent and text'));
    } else {
      const said = ((called.content as { text?: string }[] | undefined)?.[0]?.text ?? '').slice(0, 90);
      results.push(skip(`tools/call ${readOnly.name}`, `answered in words only, so structured content is unconfirmed: "${said}"`));
    }
    results.push(latency(`tools/call ${readOnly.name} round trip`, await timed(() => ask('tools/call', { name: readOnly.name, arguments: {} }), now)));
  } catch (err) {
    results.push(fail('MCP conversation', `stopped: ${why(err)}`));
  }
  return results;
}
