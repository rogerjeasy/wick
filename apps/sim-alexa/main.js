/**
 * Talks to the real MCP server (services/mcp-server) over Streamable HTTP —
 * the whole point of this file existing is that it does NOT read DynamoDB or
 * anything else directly. See ./index.html's on-page notice and this
 * directory's README for why this exists.
 */
import {
  DECLINED_RESULT,
  HELP_TEXT,
  SUGGESTIONS,
  confirmWrite,
  describeCall,
  inviteLink,
  needsConfirmation,
  presentCircle,
  presentResult,
  presentTurn,
  presentWelcome,
  routeUtterance,
  timeFormatter,
} from './surface.js';

const $ = (id) => document.getElementById(id);

/**
 * The link to a Wick account: where the server is, and the tokens it issued.
 * Kept in localStorage so a reload, or coming back tomorrow, does not ask
 * for a password again. The server keeps its side in DynamoDB now, so a
 * redeploy no longer breaks the link either.
 */
const LINK_KEY = 'wick_link';
let link = null;
let mcpSessionId = null;
/** GET /api/me for the linked account, once known. */
let me = null;

function loadLink() {
  try {
    const stored = JSON.parse(localStorage.getItem(LINK_KEY) ?? 'null');
    return stored && stored.accessToken && stored.serverUrl ? stored : null;
  } catch {
    return null;
  }
}

function saveLink(next) {
  link = next;
  if (next) localStorage.setItem(LINK_KEY, JSON.stringify(next));
  else localStorage.removeItem(LINK_KEY);
}

function setStatus(text, state = 'idle') {
  const el = $('auth-status');
  el.textContent = text;
  el.dataset.state = state;
}

/** Everything that asks the server: the chips, the text field and its button. */
function enableToolButtons(enabled) {
  for (const el of document.querySelectorAll('.chip, #ask-input, #ask-send')) el.disabled = !enabled;
  $('link-card').hidden = enabled;
  $('sign-out').hidden = !enabled;
}

async function discoverAuthServer(serverUrl) {
  const res = await fetch(`${serverUrl}/.well-known/oauth-authorization-server`);
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

const redirectUri = () => window.location.origin + window.location.pathname;

async function registerClient(metadata) {
  const res = await fetch(metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [redirectUri()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      client_name: 'the Wick family app',
    }),
  });
  if (!res.ok) throw new Error('dynamic client registration failed');
  return res.json();
}

/**
 * Sends the browser to the Wick server to sign in (or create an account),
 * choose the home, and approve this app. An invitation code in this page's
 * address rides along, so the server can offer to join that home.
 *
 * With `demo`, the server makes an anonymous guest account and a demo home
 * instead, and comes straight back: no email, no password, no page to fill
 * in (services/mcp-server/src/accounts/demo.ts).
 */
async function connect({ demo = false } = {}) {
  try {
    const serverUrl = $('server-url').value.replace(/\/$/, '');
    setStatus('Opening Wick sign-in…');
    const metadata = await discoverAuthServer(serverUrl);
    const client = await registerClient(metadata);
    const { verifier, challenge } = await pkcePair();
    sessionStorage.setItem('wick_pending_link', JSON.stringify({
      verifier,
      clientId: client.client_id,
      tokenEndpoint: metadata.token_endpoint,
      serverUrl,
    }));

    const authorizeUrl = new URL(metadata.authorization_endpoint);
    authorizeUrl.searchParams.set('client_id', client.client_id);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri());
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    const invite = sessionStorage.getItem('wick_invite');
    if (invite) authorizeUrl.searchParams.set('invite', invite);
    if (demo) authorizeUrl.searchParams.set('demo', '1');
    window.location.href = authorizeUrl.toString();
  } catch (err) {
    // Silence is indistinguishable from "nothing happened", which is a lie —
    // the design principle this whole product is built on (see AGENTS.md).
    // A failed connect must say so, not leave the page looking unchanged.
    setStatus(`Could not open sign-in: ${err.message}`);
  }
}

/** Back from the Wick server with a code: exchange it for tokens. */
async function completeAuthIfRedirected(code) {
  try {
    const pending = JSON.parse(sessionStorage.getItem('wick_pending_link') ?? 'null');
    if (!pending) throw new Error('this browser did not start the sign-in');
    const tokenRes = await fetch(pending.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(),
        client_id: pending.clientId,
        code_verifier: pending.verifier,
      }),
    });
    if (!tokenRes.ok) throw new Error('token exchange failed');
    const tokens = await tokenRes.json();
    saveLink({
      serverUrl: pending.serverUrl,
      clientId: pending.clientId,
      tokenEndpoint: pending.tokenEndpoint,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
    });
    sessionStorage.removeItem('wick_pending_link');
    sessionStorage.removeItem('wick_invite');
    return true;
  } catch (err) {
    setStatus(`Sign-in failed: ${err.message}`);
    return false;
  }
}

/** One refresh at a time, however many requests found the token expired. */
let refreshing = null;

async function refreshTokens() {
  if (!link?.refreshToken) return false;
  refreshing ??= (async () => {
    try {
      const res = await fetch(link.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: link.refreshToken, client_id: link.clientId }),
      });
      if (!res.ok) return false;
      const tokens = await res.json();
      saveLink({ ...link, accessToken: tokens.access_token, refreshToken: tokens.refresh_token });
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

function signedOut(reason) {
  saveLink(null);
  me = null;
  mcpSessionId = null;
  conversation.length = 0;
  enableToolButtons(false);
  setStatus(reason);
  // The link card is back on screen, so its demo button must be decided
  // again: a link that had expired used to leave it hidden.
  void offerDemoIfAllowed();
}

/**
 * A request to the Wick server as the linked person. An expired access
 * token is refreshed once and the request repeated; if that fails too, the
 * link is gone and the page says so.
 */
async function authorizedFetch(path, init = {}) {
  if (!link) throw new Error('Link Wick first.');
  const send = () =>
    fetch(`${link.serverUrl}${path}`, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${link.accessToken}` } });
  let res = await send();
  if (res.status === 401 && (await refreshTokens())) res = await send();
  if (res.status === 401) {
    signedOut('Signed out. Link Wick again.');
    throw new Error('Wick needs linking again.');
  }
  return res;
}

/** /api: JSON in, JSON out. A refusal's own words become the error's message. */
async function api(path, init = {}) {
  const res = await authorizedFetch(path, {
    ...init,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
  });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message ?? `Request failed: ${res.status}`), { status: res.status, code: body.error });
  return body;
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
  };
  if (mcpSessionId) headers['mcp-session-id'] = mcpSessionId;

  const res = await authorizedFetch('/mcp', { method: 'POST', headers, body: JSON.stringify(message) });

  const sid = res.headers.get('mcp-session-id');
  if (sid) mcpSessionId = sid;

  // `notifications/initialized` is a notification (no `id`): the server
  // accepts it with 202 Accepted and no JSON-RPC body to parse.
  if (message.id === undefined) {
    if (!res.ok) throw new Error(`MCP notification failed: ${res.status}`);
    return undefined;
  }

  // The server restarted and forgot this MCP session (they are held in
  // memory; the sign-in is not). Open a new one and ask again, once.
  if ((res.status === 400 || res.status === 404) && mcpSessionId && message.method !== 'initialize') {
    mcpSessionId = null;
    await ensureMcpSession();
    return sendMcpMessage(message);
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
      clientInfo: { name: 'Wick family app', version: '0.2.0' },
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

  if (card.facts?.length) {
    const facts = el('dl', 'facts');
    for (const fact of card.facts) {
      facts.appendChild(el('dt', undefined, fact.label));
      facts.appendChild(el('dd', undefined, fact.value));
    }
    node.appendChild(facts);
  }

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
    fillAssistantTurn(turn, presentResult(tool, text, context, formatTime, result.isError === true));
  } catch (err) {
    fillAssistantTurn(turn, { say: err.message, card: null, tone: 'error' });
  }
}

// ---------------------------------------------------------------------------
// The model-driven conversation. The Wick server's assistant decides which
// tools to call and what to say (services/mcp-server/src/assistant); this
// page makes each call itself, over MCP, with the customer's own token, and
// shows what came back. Where the server has no model, or it is busy, the
// page answers by the rules it always had (answerByRules) — it never goes
// silent, and never makes an answer up.
// ---------------------------------------------------------------------------

/** Times as they were at the house (GET /api/me names its zone); the reader's own zone until that is known. */
let formatTime = timeFormatter(undefined);

/** What has been asked, called and answered, as the assistant is shown it. Forgotten on sign-out. */
const conversation = [];
/** How much of it is sent: the server keeps less. */
const MAX_REMEMBERED_TURNS = 40;
/** A question the assistant cannot finish in this many steps is finished without it. */
const MAX_STEPS = 6;
/** Set once the server says it has no assistant, so each question is not asked of it twice. */
let noAssistant = false;

function rememberTurns(...turns) {
  conversation.push(...turns);
  while (conversation.length > MAX_REMEMBERED_TURNS || (conversation.length && conversation[0].role !== 'user')) conversation.shift();
}

/** One step of the assistant: `{ done, say }`, `{ done: false, calls }`, or null when there is no assistant to ask. */
async function assistantStep() {
  const res = await authorizedFetch('/assistant/next', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ turns: conversation }),
  });
  if (res.status === 503) noAssistant = true;
  return res.ok ? res.json() : null;
}

function showProgress(turn, text) {
  let progress = turn.querySelector('.progress');
  if (!progress) {
    progress = el('span', 'progress');
    turn.appendChild(progress);
  }
  progress.textContent = text;
  scrollToEnd();
}

/**
 * Shows the customer what is about to be put on a television or a roster,
 * and waits for their answer. Nothing is written until they say yes: the
 * assistant proposes, and only the person whose name goes on it disposes.
 */
function confirmInTurn(turn, call) {
  const asked = confirmWrite(call.name, call.args);
  return new Promise((resolve) => {
    const card = el('article', 'card');
    const head = el('div', 'card-head');
    head.appendChild(el('h2', 'card-title', asked.title));
    card.appendChild(head);
    const fields = el('dl', 'fields');
    for (const [name, value] of asked.fields) {
      fields.appendChild(el('dt', undefined, name));
      fields.appendChild(el('dd', undefined, value));
    }
    card.appendChild(fields);

    const actions = el('div', 'actions');
    const yes = el('button', 'btn final', asked.confirmLabel);
    const no = el('button', 'btn quiet', 'Not now');
    yes.type = 'button';
    no.type = 'button';
    const answer = (ok) => {
      card.remove();
      resolve(ok);
    };
    yes.addEventListener('click', () => answer(true));
    no.addEventListener('click', () => answer(false));
    actions.append(yes, no);
    card.appendChild(actions);
    card.appendChild(cardFoot(asked.footnote));

    turn.appendChild(card);
    scrollToEnd();
    yes.focus();
  });
}

/** Puts a whole turn on the page: the sentence, each tool's card, and what was done to get there. */
function fillTurn(turn, presented) {
  turn.replaceChildren();
  if (TONE_LABEL[presented.tone]) turn.appendChild(el('span', 'tone', TONE_LABEL[presented.tone]));
  const say = el('p', 'say', presented.say);
  say.dataset.tone = presented.tone;
  turn.appendChild(say);
  for (const card of presented.cards) turn.appendChild(renderCard(card));
  if (presented.trace) turn.appendChild(el('p', 'trace', presented.trace));
  speak(presented.say);
  scrollToEnd();
}

/** Makes one call the assistant asked for, or does not, if the customer says no. */
async function runCall(turn, call) {
  if (needsConfirmation(call.name) && !(await confirmInTurn(turn, call))) {
    return { result: { id: call.id, name: call.name, text: DECLINED_RESULT }, presented: null };
  }
  showProgress(turn, `${describeCall(call.name, call.args)}…`);
  try {
    const result = await callTool(call.name, call.args);
    const text = result.content?.[0]?.text ?? '';
    const isError = result.isError === true;
    return {
      result: { id: call.id, name: call.name, text, ...(isError ? { isError: true } : {}) },
      presented: presentResult(call.name, text, { message: call.args?.message, now: Date.now() }, formatTime, isError),
    };
  } catch (err) {
    return {
      result: { id: call.id, name: call.name, text: err.message, isError: true },
      presented: { say: err.message, card: null, tone: 'error' },
    };
  }
}

/**
 * One question, answered by the assistant: it asks for tools, this page
 * calls them and reports back, until it has a sentence to say. Returns
 * false if the assistant could not be asked at all, so the caller can
 * answer by the rules instead.
 */
async function converse(text) {
  const turn = addThinking();
  const before = conversation.length;
  rememberTurns({ role: 'user', text });
  const steps = [];

  const finish = (say) => {
    const presented = presentTurn(say, steps);
    rememberTurns({ role: 'assistant', text: presented.say });
    fillTurn(turn, presented);
    return true;
  };

  for (let i = 0; i < MAX_STEPS; i += 1) {
    let step;
    try {
      step = await assistantStep();
    } catch {
      step = null;
    }
    if (!step) {
      // Nothing was done yet: hand the question to the rules, as if it had never been asked here.
      if (steps.length === 0) {
        conversation.length = Math.min(before, conversation.length);
        turn.remove();
        return false;
      }
      // Tools have already answered: say what they said.
      return finish(undefined);
    }
    if (step.done) return finish(step.say);

    const results = [];
    for (const call of step.calls) {
      const ran = await runCall(turn, call);
      results.push(ran.result);
      steps.push({ name: call.name, args: call.args, presented: ran.presented });
    }
    rememberTurns({ role: 'assistant', calls: step.calls }, { role: 'tool', results });
  }
  return finish(undefined);
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

  form.append(messageLabel, actions);
  card.appendChild(form);
  // Signed by the server with the name the person at home allowed — not a field here.
  card.appendChild(cardFoot(`From ${me?.user.name ?? 'you'}. It is read on a television, in large type: keep it short.`));
  turn.appendChild(card);
  log.appendChild(turn);
  scrollToEnd();
  message.focus();

  cancel.addEventListener('click', () => turn.remove());
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const context = { message: message.value.trim() };
    if (!context.message) return;
    turn.remove();
    addCustomerTurn(`Send: “${context.message}”`);
    void askTool('send_note_to_tv', context, context);
  });
}

// ---------------------------------------------------------------------------
// The family circle: who is in it, inviting someone, connecting a television.
// What is said and listed is decided in surface.js; the buttons are here.
// ---------------------------------------------------------------------------

function assistantSays(presented) {
  const turn = el('div', 'turn-assistant');
  log.appendChild(turn);
  fillAssistantTurn(turn, { card: null, ...presented });
  return turn;
}

/** A card the app itself draws under a sentence: title, body, footnote. */
function plainCard(title, footnote) {
  const card = el('article', 'card');
  const head = el('div', 'card-head');
  head.appendChild(el('h2', 'card-title', title));
  card.appendChild(head);
  const body = el('div', 'form');
  card.appendChild(body);
  card.appendChild(cardFoot(footnote));
  return { card, body };
}

/** Ask for the six digits on the television. */
function addConnectTelevision(prefill) {
  const resident = me?.household.residentName ?? 'their';
  const turn = el('div', 'turn-assistant');
  const { card, body } = plainCard('Connect a television', `${resident} is then asked, on it, whether to allow you.`);
  body.appendChild(el('p', 'empty', 'Open Wick on the television. It shows a six-digit code.'));
  if (me?.virtualTelevisionUrl) {
    // Nobody needs a Fire TV to see the resident's side: a television in a
    // browser tab pairs with the same code and shows the same cards.
    const hint = el('p', 'empty', 'No Fire TV to hand? ');
    const tv = el('a', undefined, 'Open a virtual television');
    tv.href = me.virtualTelevisionUrl;
    tv.target = '_blank';
    tv.rel = 'noopener';
    hint.append(tv, ', press “Pair & connect” there, and enter its code here.');
    body.appendChild(hint);
  }

  const form = el('form', 'form');
  const label = el('label', undefined, 'Code on the television');
  const input = el('input', 'code');
  input.inputMode = 'numeric';
  input.autocomplete = 'off';
  input.maxLength = 7;
  input.placeholder = '123 456';
  input.required = true;
  input.value = prefill ?? '';
  label.appendChild(input);
  const actions = el('div', 'actions');
  const go = el('button', 'btn final', 'Connect');
  go.type = 'submit';
  const cancel = el('button', 'btn quiet', 'Not now');
  cancel.type = 'button';
  actions.append(go, cancel);
  const problem = el('p', 'problem');
  problem.setAttribute('role', 'alert');
  form.append(label, actions, problem);
  body.appendChild(form);
  turn.appendChild(card);
  log.appendChild(turn);
  scrollToEnd();
  input.focus();

  cancel.addEventListener('click', () => turn.remove());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    go.disabled = true;
    problem.textContent = '';
    try {
      await api('/api/televisions', { method: 'POST', body: JSON.stringify({ code: input.value }) });
      turn.remove();
      await welcome();
    } catch (err) {
      problem.textContent = err.message;
      go.disabled = false;
    }
  });
}

/** Make an invitation and show the link to send. */
async function addInvitation() {
  const resident = me?.household.residentName ?? 'The person at home';
  try {
    const { code } = await api('/api/circle/invitations', { method: 'POST' });
    const turn = assistantSays({ say: 'Here is a link to send them. It works for seven days.', tone: 'answer' });
    const { card, body } = plainCard('An invitation', `They sign in, and ${resident} is asked on the television whether to allow them.`);
    const input = el('input', 'linkbox');
    input.readOnly = true;
    input.value = inviteLink(window.location.href, code);
    input.setAttribute('aria-label', 'Invitation link');
    const actions = el('div', 'actions');
    const copy = el('button', 'btn final', 'Copy link');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(input.value);
        copy.textContent = 'Copied';
      } catch {
        input.select();
      }
    });
    actions.appendChild(copy);
    body.append(input, actions);
    turn.appendChild(card);
    scrollToEnd();
  } catch (err) {
    assistantSays({ say: err.message, tone: 'error' });
  }
}

function renderCircleCard(view) {
  const { card, body } = plainCard(view.title, view.footnote);
  const rows = el('ul', 'rows');
  for (const member of view.members) {
    const li = el('li', 'row');
    li.appendChild(el('span', 'primary', member.primary));
    const right = el('span', 'secondary', member.secondary);
    li.appendChild(right);
    if (member.removable) {
      // Two presses: the first only asks.
      const remove = el('button', 'btn link', 'Remove');
      remove.type = 'button';
      remove.addEventListener('click', async () => {
        if (remove.dataset.armed !== 'true') {
          remove.dataset.armed = 'true';
          remove.textContent = 'Remove — sure?';
          return;
        }
        try {
          await api(`/api/circle/members/${encodeURIComponent(member.userId)}`, { method: 'DELETE' });
          await showCircle();
        } catch (err) {
          assistantSays({ say: err.message, tone: 'error' });
        }
      });
      li.appendChild(remove);
    }
    rows.appendChild(li);
  }
  body.appendChild(rows);
  body.appendChild(el('p', 'empty', view.television));

  if (view.organiser) {
    const actions = el('div', 'actions');
    const invite = el('button', 'btn', 'Invite someone');
    invite.type = 'button';
    invite.addEventListener('click', () => void addInvitation());
    const connectTv = el('button', 'btn quiet', 'Connect a television');
    connectTv.type = 'button';
    connectTv.addEventListener('click', () => addConnectTelevision());
    actions.append(invite, connectTv);
    body.appendChild(actions);
  }
  return card;
}

async function showCircle() {
  const turn = addThinking();
  try {
    me = await api('/api/me');
    const circle = await api('/api/circle');
    const presented = presentCircle(circle, me);
    fillAssistantTurn(turn, { say: presented.say, card: null, tone: presented.tone });
    turn.appendChild(renderCircleCard(presented.card));
    scrollToEnd();
  } catch (err) {
    // 403 carries the server's own sentence: not allowed on the television yet.
    fillAssistantTurn(turn, { say: err.message, card: null, tone: err.status === 403 ? 'waiting' : 'error' });
  }
}

/**
 * Who is linked, and what they can do next. Said after linking, after a
 * reload, and after a television is connected.
 */
async function welcome() {
  me = await api('/api/me');
  formatTime = timeFormatter(me.household.timeZone);
  // A demo home says what it is wherever it is named: its history was written, not lived.
  setStatus(`${me.user.name} · ${me.household.name}${me.household.simulated ? ' · simulated history' : ''}`, 'connected');
  // Only the organiser, or someone already allowed, may know about the
  // televisions (INV-9) — so nobody else's app even asks.
  let televisions;
  if (me.membership.role === 'organiser' || me.membership.status === 'allowed') {
    try {
      televisions = (await api('/api/circle')).televisions.length;
    } catch {
      televisions = undefined;
    }
  }
  const presented = presentWelcome(me, televisions);
  assistantSays(presented);

  const pair = sessionStorage.getItem('wick_pair');
  sessionStorage.removeItem('wick_pair');
  if (me.membership.role === 'organiser' && (pair || presented.next === 'connect')) addConnectTelevision(pair ?? undefined);
  else $('ask-input').focus();
}

/** The rules this page answered by before there was a model, and still does when there is none. */
function answerByRules(text) {
  const route = routeUtterance(text);
  if (route.kind === 'tool') return void askTool(route.tool, route.args, { now: Date.now() });
  if (route.kind === 'compose') return addComposer(route.message);
  if (route.kind === 'circle') return void showCircle();
  assistantSays({ say: HELP_TEXT, tone: 'answer' });
}

async function handleUtterance(text) {
  addCustomerTurn(text);
  // The circle is this app's own business with the server, not a question for a tool.
  if (routeUtterance(text).kind === 'circle') return void showCircle();
  if (!noAssistant && (await converse(text))) return;
  answerByRules(text);
}

for (const suggestion of SUGGESTIONS) {
  const chip = el('button', 'chip', suggestion.label);
  chip.type = 'button';
  chip.disabled = true;
  chip.addEventListener('click', () => void handleUtterance(suggestion.utterance));
  $('chips').appendChild(chip);
}

$('ask').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('ask-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  void handleUtterance(text);
});

$('speak-toggle').addEventListener('click', (event) => {
  speakAnswers = !speakAnswers;
  event.currentTarget.setAttribute('aria-pressed', String(speakAnswers));
  if (!speakAnswers && 'speechSynthesis' in window) window.speechSynthesis.cancel();
});

$('connect').addEventListener('click', () => void connect());
// Optional chaining, here and below: this script and its page are uploaded
// separately, and a deploy that stopped half way once left the new script
// running against the old page. A missing button must not stop the rest.
$('demo')?.addEventListener('click', () => void connect({ demo: true }));

/** Offer the demo button only where the server will honour it. */
async function offerDemoIfAllowed() {
  try {
    const serverUrl = $('server-url').value.replace(/\/$/, '');
    const options = await (await fetch(`${serverUrl}/account/options`)).json();
    const allowed = options.demo === true;
    if ($('demo')) $('demo').hidden = !allowed;
    if ($('demo-hint')) $('demo-hint').hidden = !allowed;
  } catch {
    // No answer means no demo. The sign-in button still says why if the server is unreachable.
  }
}

$('sign-out').addEventListener('click', () => {
  signedOut('Not connected');
  window.location.replace(redirectUri());
});

/**
 * How the page was opened:
 *   ?code=    back from the Wick server's sign-in
 *   ?invite=  an invitation link somebody sent
 *   ?pair=    the link on a television's pairing screen
 */
(async function start() {
  const params = new URLSearchParams(window.location.search);
  const invite = params.get('invite');
  const pair = params.get('pair');
  if (invite) sessionStorage.setItem('wick_invite', invite);
  if (pair) sessionStorage.setItem('wick_pair', pair);

  const code = params.get('code');
  if (code) await completeAuthIfRedirected(code);
  if (params.size > 0) window.history.replaceState({}, '', window.location.pathname);

  link = loadLink();
  if (link) $('server-url').value = link.serverUrl;

  // An invitation is for a home this browser may not be linked to yet, so it
  // goes through sign-in again even when a link exists. The server remembers
  // the browser, so that is one press, not a password.
  if (sessionStorage.getItem('wick_invite')) {
    $('link-say').textContent = 'You have been invited to a family circle.';
    $('link-title').textContent = 'Join with your Wick account';
    $('link-detail').textContent = 'Sign in, or create an account with your email and a password. The person at home is then asked whether to allow you.';
    $('connect').textContent = 'Continue';
    return;
  }
  if (!link) {
    if (pair) $('link-say').textContent = 'To connect that television, sign in to Wick first.';
    void offerDemoIfAllowed();
    return;
  }

  enableToolButtons(true);
  try {
    await welcome();
  } catch (err) {
    if (link) assistantSays({ say: err.message, tone: 'error' });
  }
})();
