/**
 * Talks to the real MCP server (services/mcp-server) over Streamable HTTP —
 * the whole point of this file existing is that it does NOT read DynamoDB or
 * anything else directly. See ./index.html's on-page notice and this
 * directory's README for why this exists.
 */
let mcpServerUrl = document.getElementById('server-url').value;
let accessToken = null;
let mcpSessionId = null;

function setStatus(text) {
  document.getElementById('auth-status').textContent = text;
}

function enableToolButtons(enabled) {
  for (const id of ['ask-week', 'ask-today', 'ask-visitor', 'send-note', 'ask-replies']) {
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
  try {
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
  } catch (err) {
    // Silence is indistinguishable from "nothing happened", which is a lie —
    // the design principle this whole product is built on (see AGENTS.md).
    // A failed connect must say so, not leave the page looking unchanged.
    setStatus(`Connect failed: ${err.message}`);
  }
}

async function completeAuthIfRedirected() {
  try {
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
  } catch (err) {
    setStatus(`Sign-in failed: ${err.message}`);
    return false;
  }
}

let mcpRequestId = 0;

/** Splits a Streamable HTTP SSE response body into its `data:` JSON payloads. */
function parseSseEvents(text) {
  return text
    .split('\n\n')
    .map((rawEvent) =>
      rawEvent
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n'),
    )
    .filter((data) => data.length > 0)
    .map((data) => JSON.parse(data));
}

/**
 * A single JSON-RPC round trip over POST /mcp. Streamable HTTP is
 * session-based (see services/mcp-server/src/server.ts): the very first
 * request on a connection must be `initialize`, and every request after that
 * — including `initialize`'s own required `notifications/initialized`
 * follow-up — must carry the `Mcp-Session-Id` the server handed back on the
 * `initialize` response, or the server 400s "No valid session ID provided".
 * `ensureMcpSession()` below performs that handshake once per page session,
 * lazily, before the first real tool call.
 *
 * The installed SDK's StreamableHTTPServerTransport (this server does not set
 * `enableJsonResponse`) always answers POST /mcp with
 * `content-type: text/event-stream`, one `data:` line carrying the JSON-RPC
 * response — never a plain `application/json` body — so the response must be
 * parsed as SSE even for a single, non-streaming reply.
 */
async function sendMcpMessage(message) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${accessToken}`,
  };
  if (mcpSessionId) headers['mcp-session-id'] = mcpSessionId;

  const res = await fetch(`${mcpServerUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(message),
  });

  // The server keeps OAuth tokens in memory (infra/mcp.tf), so a redeploy
  // signs everyone out. Say so, and offer Connect again, rather than a 401.
  if (res.status === 401) {
    accessToken = null;
    mcpSessionId = null;
    enableToolButtons(false);
    setStatus('Signed out — the Wick server restarted. Press Connect to sign in again.');
    throw new Error('Please sign in again (press Connect).');
  }

  const sid = res.headers.get('mcp-session-id');
  if (sid) mcpSessionId = sid;

  // `notifications/initialized` is a notification (no `id`): the server
  // accepts it with 202 Accepted and no JSON-RPC body to parse.
  if (message.id === undefined) {
    if (!res.ok) throw new Error(`MCP notification failed: ${res.status}`);
    return undefined;
  }

  if (!res.ok) throw new Error(`MCP request failed: ${res.status}`);
  const text = await res.text();
  const contentType = res.headers.get('content-type') ?? '';
  const events = contentType.includes('text/event-stream') ? parseSseEvents(text) : [JSON.parse(text)];
  const body = events.find((event) => event.id === message.id);
  if (!body) throw new Error('No matching JSON-RPC response in server reply');
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

async function ensureMcpSession() {
  if (mcpSessionId) return;
  await sendMcpMessage({
    jsonrpc: '2.0',
    id: ++mcpRequestId,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'Wick sim-alexa', version: '0.1.0' },
    },
  });
  await sendMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

async function callTool(name, args) {
  await ensureMcpSession();
  return sendMcpMessage({ jsonrpc: '2.0', id: ++mcpRequestId, method: 'tools/call', params: { name, arguments: args } });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function formatTimelineAt(atMs) {
  return new Date(atMs).toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * M6 — get_week_narrative's response, rendered as a real panel instead of
 * raw JSON: the prose first, then the timeline it was built from.
 * WeekNarrative's own shape (packages/contracts/src/narrative.ts) —
 * {text, timeline: {at, kind, summary, personId?}[], residentSeenAt?, ...}.
 *
 * get_week_narrative.ts's tool handler returns a plain, non-JSON sentence
 * whenever there's nothing to show: no week written yet, or, by INV-7, a
 * week the resident hasn't seen on their own television yet (WeekCard,
 * services/agent/src/agents/narrator/weekCard.ts), which says so in so many
 * words. Neither is an error to special-case here: both fall through to
 * the plain-text branch below.
 */
function renderWeekPanel(rawText) {
  let narrative;
  try {
    narrative = JSON.parse(rawText);
  } catch {
    return `<p class="week-empty">${escapeHtml(rawText)}</p>`;
  }

  if (typeof narrative.text !== 'string' || !Array.isArray(narrative.timeline)) {
    return `<p class="week-empty">${escapeHtml(rawText)}</p>`;
  }

  const items = narrative.timeline
    .slice()
    .sort((a, b) => a.at - b.at)
    .map((e) => `<li><time>${escapeHtml(formatTimelineAt(e.at))}</time><span>${escapeHtml(e.summary)}</span></li>`)
    .join('');

  return `
    <div class="week-panel">
      <p class="week-prose">${escapeHtml(narrative.text)}</p>
      ${items ? `<ul class="week-timeline">${items}</ul>` : '<p class="week-empty">No events this week.</p>'}
      <p class="week-meta">${escapeHtml(narrative.isoWeek ?? '')} · seen by the resident on their own television first (INV-7)</p>
    </div>
  `;
}

/**
 * M3 — get_replies' response: each note Sarah sent, and the resident's
 * one-button answer under it, or "No reply yet." The tool returns a plain
 * sentence when no notes were sent, which falls through as text.
 */
function renderReplies(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return `<p class="week-empty">${escapeHtml(rawText)}</p>`;
  }
  if (!Array.isArray(parsed.notes)) return `<p class="week-empty">${escapeHtml(rawText)}</p>`;

  const items = parsed.notes
    .map((n) => {
      const answer = n.reply
        ? `<p class="reply-text">“${escapeHtml(n.reply.text)}”</p><p class="week-meta">Replied ${escapeHtml(formatTimelineAt(n.reply.at))}</p>`
        : '<p class="week-meta">No reply yet.</p>';
      return `<li><p class="week-meta">${escapeHtml(n.from)}, ${escapeHtml(formatTimelineAt(n.sentAt))}</p>${n.message ? `<p>${escapeHtml(n.message)}</p>` : ""}${answer}</li>`;
    })
    .join('');
  return `<div class="week-panel"><ul class="replies">${items}</ul></div>`;
}

document.getElementById('connect').addEventListener('click', () => void connect());

document.getElementById('ask-replies').addEventListener('click', async () => {
  try {
    const result = await callTool('get_replies', {});
    document.getElementById('replies-result').innerHTML = renderReplies(result.content[0].text);
  } catch (err) {
    document.getElementById('replies-result').textContent = `Error: ${err.message}`;
  }
});

document.getElementById('ask-week').addEventListener('click', async () => {
  try {
    const result = await callTool('get_week_narrative', {});
    document.getElementById('week-result').innerHTML = renderWeekPanel(result.content[0].text);
  } catch (err) {
    document.getElementById('week-result').textContent = `Error: ${err.message}`;
  }
});

document.getElementById('ask-today').addEventListener('click', async () => {
  try {
    const result = await callTool('get_today', {});
    document.getElementById('today-result').textContent = result.content[0].text;
  } catch (err) {
    document.getElementById('today-result').textContent = `Error: ${err.message}`;
  }
});

document.getElementById('ask-visitor').addEventListener('click', async () => {
  try {
    const result = await callTool('did_visitor_come', { personId: 'maria' });
    document.getElementById('visitor-result').textContent = result.content[0].text;
  } catch (err) {
    document.getElementById('visitor-result').textContent = `Error: ${err.message}`;
  }
});

document.getElementById('send-note').addEventListener('click', async () => {
  try {
    const fromName = document.getElementById('note-from').value;
    const message = document.getElementById('note-message').value;
    const result = await callTool('send_note_to_tv', { fromName, message });
    document.getElementById('note-result').textContent = result.content[0].text;
  } catch (err) {
    document.getElementById('note-result').textContent = `Error: ${err.message}`;
  }
});

completeAuthIfRedirected().then((authenticated) => {
  if (authenticated) {
    setStatus('Connected.');
    enableToolButtons(true);
  }
});
