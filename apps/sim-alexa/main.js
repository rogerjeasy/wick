/**
 * Talks to the real MCP server (services/mcp-server) over Streamable HTTP —
 * the whole point of this file existing is that it does NOT read DynamoDB or
 * anything else directly. See ./index.html's on-page notice and this
 * directory's README for why this exists.
 */
import { HELP_TEXT, SUGGESTIONS, presentResult, routeUtterance } from './surface.js';

let mcpServerUrl = document.getElementById('server-url').value;
let accessToken = null;
let mcpSessionId = null;

const $ = (id) => document.getElementById(id);

function setStatus(text, state = 'idle') {
  const el = $('auth-status');
  el.textContent = text;
  el.dataset.state = state;
}

/** Everything that asks the server: the chips, the text field and its button. */
function enableToolButtons(enabled) {
  for (const el of document.querySelectorAll('.chip, #ask-input, #ask-send')) el.disabled = !enabled;
  if (!enabled) $('link-card').hidden = false;
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
    setStatus('Signed out — the Wick server restarted. Link Wick again.');
    throw new Error('Wick needs linking again. The server restarted.');
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


// ---------------------------------------------------------------------------
// The conversation. What is said and shown is decided in surface.js; this
// only puts it on the page.
// ---------------------------------------------------------------------------

const log = $('log');
const FLAME =
  '<svg class="flame" viewBox="0 0 16 22" aria-hidden="true"><path d="M8 0c3 5 7 8 7 13a7 7 0 0 1-14 0C1 8 5 5 8 0z" fill="#e8b75d"/></svg>';
const TONE_LABEL = { private: 'Kept private', waiting: 'Not yet', error: 'Something went wrong' };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let lastCustomerTurn = null;

/**
 * Keep the question and the start of its answer in view: the sentence is
 * the answer, and a long card must not push it off the top.
 */
function scrollToEnd() {
  if (lastCustomerTurn) log.scrollTop = lastCustomerTurn.offsetTop - 12;
  else log.scrollTop = log.scrollHeight;
}

function addCustomerTurn(text) {
  lastCustomerTurn = el('div', 'turn-customer', text);
  log.appendChild(lastCustomerTurn);
  scrollToEnd();
}

function addThinking() {
  const turn = el('div', 'turn-assistant');
  const dots = el('span', 'thinking');
  dots.setAttribute('aria-label', 'Thinking');
  dots.append(el('i'), el('i'), el('i'));
  turn.appendChild(dots);
  log.appendChild(turn);
  scrollToEnd();
  return turn;
}

let speakAnswers = false;

/** Voice is the baseline (the design guide's voice-only mode): the sentence stands alone. */
function speak(text) {
  if (!speakAnswers || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

function cardFoot(note) {
  const foot = el('div', 'card-foot');
  foot.appendChild(el('span', 'note', note ?? ''));
  const by = el('span', 'by');
  by.innerHTML = `${FLAME} Wick`;
  foot.appendChild(by);
  return foot;
}

/** Four rows inline, then "See more" — the guide's list pattern. */
const INLINE_ROWS = 4;

function renderRows(card) {
  const rows = el('ul', 'rows');
  for (const item of card.items) {
    const li = el('li', card.kind === 'replies' ? 'row stacked' : 'row');
    if (card.kind === 'replies') {
      li.appendChild(el('span', 'secondary', item.secondary));
      li.appendChild(el('span', 'primary', item.primary));
      li.appendChild(el('span', item.reply ? 'reply' : 'reply none', item.reply ? `“${item.reply}”` : item.replyMeta));
      if (item.reply) li.appendChild(el('span', 'secondary', item.replyMeta));
    } else {
      li.appendChild(el('span', 'primary', item.primary));
      li.appendChild(el('span', 'secondary', item.secondary));
    }
    rows.appendChild(li);
  }
  return rows;
}

function renderCard(card) {
  const node = el('article', 'card');
  const head = el('div', 'card-head');
  head.appendChild(el('h2', 'card-title', card.title));
  if (card.meta) head.appendChild(el('span', 'card-meta', card.meta));
  node.appendChild(head);

  if (card.kind === 'confirmation') {
    const fields = el('dl', 'fields');
    for (const [name, value] of card.fields) {
      fields.appendChild(el('dt', undefined, name));
      fields.appendChild(el('dd', undefined, value));
    }
    node.appendChild(fields);
  } else if (card.items.length === 0) {
    node.appendChild(el('p', 'empty', card.empty ?? 'Nothing to show.'));
  } else {
    const rows = renderRows(card);
    node.appendChild(rows);
    if (card.items.length > INLINE_ROWS) {
      rows.dataset.collapsed = 'true';
      const more = el('button', 'btn link', `See all ${card.items.length}`);
      more.type = 'button';
      more.addEventListener('click', () => {
        const collapsed = rows.dataset.collapsed === 'true';
        rows.dataset.collapsed = String(!collapsed);
        more.textContent = collapsed ? 'Show fewer' : `See all ${card.items.length}`;
      });
      node.appendChild(more);
    }
  }

  node.appendChild(cardFoot(card.footnote));
  return node;
}

function fillAssistantTurn(turn, presented) {
  turn.replaceChildren();
  if (TONE_LABEL[presented.tone]) turn.appendChild(el('span', 'tone', TONE_LABEL[presented.tone]));
  const say = el('p', 'say', presented.say);
  say.dataset.tone = presented.tone;
  turn.appendChild(say);
  if (presented.card) turn.appendChild(renderCard(presented.card));
  speak(presented.say);
  scrollToEnd();
}

async function askTool(tool, args, context = {}) {
  const turn = addThinking();
  try {
    const result = await callTool(tool, args);
    const text = result.content?.[0]?.text ?? '';
    fillAssistantTurn(turn, presentResult(tool, text, context, undefined, result.isError === true));
  } catch (err) {
    fillAssistantTurn(turn, { say: err.message, card: null, tone: 'error' });
  }
}

/** The note form, as a card in the conversation: one field that matters, one final action. */
function addComposer(prefill) {
  const turn = el('div', 'turn-assistant');
  turn.appendChild(el('p', 'say', 'What would you like it to say?'));

  const card = el('article', 'card');
  const head = el('div', 'card-head');
  head.appendChild(el('h2', 'card-title', 'A note for the television'));
  card.appendChild(head);

  const form = el('form', 'form');
  const fromLabel = el('label', undefined, 'From');
  const from = el('input');
  from.value = 'Sarah';
  from.required = true;
  fromLabel.appendChild(from);

  const messageLabel = el('label', undefined, 'Message');
  const message = el('textarea');
  message.maxLength = 240;
  message.required = true;
  message.value = prefill ?? '';
  messageLabel.appendChild(message);

  const actions = el('div', 'actions');
  const send = el('button', 'btn final', 'Send to the television');
  send.type = 'submit';
  const cancel = el('button', 'btn quiet', 'Not now');
  cancel.type = 'button';
  const counter = el('span', 'counter');
  const count = () => {
    counter.textContent = `${message.value.length} / 240`;
  };
  message.addEventListener('input', count);
  count();
  actions.append(send, cancel, counter);

  form.append(fromLabel, messageLabel, actions);
  card.appendChild(form);
  card.appendChild(cardFoot('It is read on a television, in large type: keep it short.'));
  turn.appendChild(card);
  log.appendChild(turn);
  scrollToEnd();
  message.focus();

  cancel.addEventListener('click', () => turn.remove());
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const context = { fromName: from.value.trim(), message: message.value.trim() };
    if (!context.fromName || !context.message) return;
    turn.remove();
    addCustomerTurn(`Send: “${context.message}”`);
    void askTool('send_note_to_tv', context, context);
  });
}

function handleUtterance(text) {
  addCustomerTurn(text);
  const route = routeUtterance(text);
  if (route.kind === 'tool') return void askTool(route.tool, route.args);
  if (route.kind === 'compose') return addComposer(route.message);
  const turn = el('div', 'turn-assistant');
  log.appendChild(turn);
  fillAssistantTurn(turn, { say: HELP_TEXT, card: null, tone: 'answer' });
}

for (const suggestion of SUGGESTIONS) {
  const chip = el('button', 'chip', suggestion.label);
  chip.type = 'button';
  chip.disabled = true;
  chip.addEventListener('click', () => handleUtterance(suggestion.utterance));
  $('chips').appendChild(chip);
}

$('ask').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('ask-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  handleUtterance(text);
});

$('speak-toggle').addEventListener('click', (event) => {
  speakAnswers = !speakAnswers;
  event.currentTarget.setAttribute('aria-pressed', String(speakAnswers));
  if (!speakAnswers && 'speechSynthesis' in window) window.speechSynthesis.cancel();
});

$('connect').addEventListener('click', () => void connect());

completeAuthIfRedirected().then((authenticated) => {
  if (!authenticated) return;
  setStatus('Linked', 'connected');
  enableToolButtons(true);
  $('link-card').hidden = true;
  const turn = el('div', 'turn-assistant');
  log.appendChild(turn);
  fillAssistantTurn(turn, { say: 'Wick is linked. What would you like to know?', card: null, tone: 'answer' });
  $('ask-input').focus();
});
