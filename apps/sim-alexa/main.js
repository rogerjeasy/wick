/**
 * Talks to the real MCP server (services/mcp-server) over Streamable HTTP —
 * the whole point of this file existing is that it does NOT read DynamoDB or
 * anything else directly. See ./index.html's on-page notice and this
 * directory's README for why this exists.
 */
import {
  DECLINED_RESULT,
  FILMS,
  HELP_TEXT,
  LANGUAGE_UNAVAILABLE,
  applicationServerKey,
  confirmWrite,
  describeCall,
  doorQuestionToAnnounce,
  follow,
  inviteLink,
  languageNews,
  languageOffer,
  madeWithKey,
  needsConfirmation,
  presentCircle,
  presentConnect,
  presentPairLink,
  presentConnected,
  presentDoorbell,
  presentInvitation,
  presentLanguage,
  presentListing,
  presentNotifications,
  presentResult,
  presentTurn,
  presentWelcome,
  looksForReach,
  reachToAnnounce,
  routeUtterance,
  serverFor,
  suggestionsFor,
  timeFormatter,
  toldToAnnounce,
  lightToShow,
  watchStatus,
  watchToAnnounce,
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
/** Whether this page has said hello to the server (`initialize`). The server keeps no session, so this is all there is to remember. */
let mcpInitialized = false;
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
  mcpInitialized = false;
  toolInfo = null;
  conversation.length = 0;
  if (doorWatch !== null) clearInterval(doorWatch);
  doorWatch = null;
  announcedDoorQuestions.clear();
  reachSeen.clear();
  if (watchLook !== null) clearInterval(watchLook);
  watchLook = null;
  watchSeen.clear();
  closeSeat();
  stopLookingAtLanguage();
  $('light').hidden = true;
  // A link that ended by itself cannot tell the server; the browser still stops listening.
  void forgetThisBrowser({ tellServer: false });
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
 * A single JSON-RPC round trip over POST /mcp. The Wick server keeps no
 * MCP session (see services/mcp-server/src/server.ts): each request is
 * answered on the strength of its own token, so a redeploy in the middle of
 * a conversation costs nothing. `ensureMcpSession()` below still says
 * `initialize` once per page, as the protocol asks of a client, and a
 * session id is still carried if a server ever hands one back.
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

  // A server that does keep sessions has forgotten this one. Open a new
  // one and ask again, once.
  if ((res.status === 400 || res.status === 404) && mcpSessionId && message.method !== 'initialize') {
    mcpSessionId = null;
    mcpInitialized = false;
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
  if (mcpInitialized) return;
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
  mcpInitialized = true;
}

/**
 * What the server says about each of its tools (tools/list): its title, and
 * whether it only reads. Asked once per session. Until it is known — and if
 * it cannot be — it is empty, and every call is confirmed (surface.js
 * needsConfirmation fails closed).
 */
let toolInfo = null;

async function knownTools() {
  if (toolInfo) return toolInfo;
  try {
    await ensureMcpSession();
    const listed = await sendMcpMessage({ jsonrpc: '2.0', id: ++mcpRequestId, method: 'tools/list', params: {} });
    toolInfo = new Map((listed.tools ?? []).map((t) => [t.name, { title: t.title, annotations: t.annotations }]));
    return toolInfo;
  } catch {
    return new Map();
  }
}

async function callToolOnly(name, args) {
  await ensureMcpSession();
  return sendMcpMessage({ jsonrpc: '2.0', id: ++mcpRequestId, method: 'tools/call', params: { name, arguments: args } });
}

async function callTool(name, args) {
  const result = await callToolOnly(name, args);
  // However the light was asked after, the corner of the page keeps up with the answer.
  if (name === 'get_light') showLightInCorner(result.isError === true ? null : lightToShow(result.content?.[0]?.text ?? ''));
  // However a film watched together came to be on the page, it is not then announced as news (watchToAnnounce).
  if ((name === 'get_watch_together' || name === 'join_watch_together') && result.isError !== true) {
    const news = watchToAnnounce(result.content?.[0]?.text ?? '', watchSeen);
    if (news) watchSeen.set(news.sessionId, news.key);
  }
  // Nor is a request to ring that was asked after by name (reachToAnnounce).
  if (name === 'get_reach_request' && result.isError !== true) {
    const news = reachToAnnounce(result.content?.[0]?.text ?? '', reachSeen);
    if (news) reachSeen.set(news.requestId, news.state);
  }
  return result;
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

/**
 * A question from the front door: the picture the resident is looking at,
 * the sentence under it, and each answer as a button carrying the very
 * words that will be shown on the television. Pressing one is the answer —
 * there is nothing further to confirm, because nothing is sent that the
 * button did not say.
 */
function renderDoorCard(card) {
  const node = el('article', 'card door');
  const head = el('div', 'card-head');
  head.appendChild(el('h2', 'card-title', card.title));
  head.appendChild(el('span', 'card-meta', card.meta));
  node.appendChild(head);

  if (card.pictureUrl) {
    const picture = el('img', 'door-picture');
    picture.src = card.pictureUrl;
    picture.alt = card.description ?? 'The picture from the doorbell';
    // Ring's address for the picture is signed: it is not passed on to anyone.
    picture.referrerPolicy = 'no-referrer';
    node.appendChild(picture);
  } else {
    node.appendChild(el('p', 'empty', 'The picture has not arrived yet.'));
  }
  if (card.description) node.appendChild(el('p', 'door-description', card.description));

  const answers = el('div', 'door-answers');
  for (const answer of card.answers) {
    const button = el('button', 'btn', answer.text);
    button.type = 'button';
    button.addEventListener('click', () => void answerFromCard('answer_door_request', card.requestId, answer.key, answers));
    answers.appendChild(button);
  }
  node.appendChild(answers);
  node.appendChild(cardFoot(card.footnote));
  return node;
}

/**
 * A request to ring, or a hello, from the television: the server's one
 * sentence, and each answer as a button carrying the very words that will be
 * shown there. As on the door card, pressing one is the answer. Under a
 * request to ring, one quiet line: answering is not ringing.
 */
function renderReachCard(card) {
  const node = el('article', 'card reach');
  node.dataset.requestId = card.requestId;
  const head = el('div', 'card-head');
  head.appendChild(el('h2', 'card-title', card.title));
  head.appendChild(el('span', 'card-meta', card.meta));
  node.appendChild(head);

  // Laid out as the door's answers are: each its own full-width button.
  const answers = el('div', 'door-answers');
  for (const answer of card.answers) {
    const button = el('button', 'btn', answer.text);
    button.type = 'button';
    button.addEventListener('click', () => void answerFromCard('answer_reach_request', card.requestId, answer.key, answers));
    answers.appendChild(button);
  }
  node.appendChild(answers);
  if (card.note) node.appendChild(el('p', 'reach-note', card.note));
  node.appendChild(cardFoot(card.footnote));
  return node;
}

/**
 * The visits of the regular visitors, and which of them the resident
 * confirmed (surface.js presentVisits): one row for each, every row drawn
 * alike — a visit that is not confirmed is given no colour and no mark —
 * then how many came earlier, and one quiet line about what the times are.
 * There is nothing to press: only the resident confirms a visit.
 */
function renderVisitsCard(card) {
  const node = el('article', 'card visits');
  const head = el('div', 'card-head');
  head.appendChild(el('h2', 'card-title', card.title));
  node.appendChild(head);
  node.appendChild(renderRows(card));
  if (card.more) node.appendChild(el('p', 'visits-note', card.more));
  node.appendChild(el('p', 'visits-note', card.note));
  node.appendChild(cardFoot(card.footnote));
  return node;
}

/** The press on an answer's button, for the door and for a request to ring alike: the tool is called with the card's request and the button's key. */
async function answerFromCard(tool, requestId, answer, buttons) {
  const all = [...buttons.querySelectorAll('button')];
  for (const button of all) button.disabled = true;
  try {
    const result = await callTool(tool, { requestId, answer });
    // Whatever came back has just been said here: the next look does not say it again (reachToAnnounce).
    if (tool === 'answer_reach_request' && result.isError !== true) reachSeen.set(requestId, 'answered');
    assistantSays(presentResult(tool, result.content?.[0]?.text ?? '', {}, formatTime, result.isError === true));
    // Having just been asked is when "be told next time, even with Wick closed" means something.
    void api('/api/me').then((latest) => { me = latest; offerNotificationsOnce(); }).catch(() => {});
  } catch (err) {
    // Nothing was shown: the answers can be pressed again.
    for (const button of all) button.disabled = false;
    assistantSays({ say: err.message, tone: 'error' });
  }
}

function renderCard(card) {
  if (card.kind === 'door') return renderDoorCard(card);
  if (card.kind === 'reach') return renderReachCard(card);
  if (card.kind === 'visits') return renderVisitsCard(card);
  if (card.kind === 'watch') return renderWatchCard(card);
  if (card.kind === 'invitation') return renderInvitationCard(card);
  if (card.kind === 'light') return renderLightCard(card);
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
/** How long a confirmation is on screen before its "yes" can be pressed. */
const CONFIRM_ARMS_AFTER_MS = 700;
/** One question at a time: a second, asked while a confirmation waits, would be answered around it. */
let answering = false;

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
function confirmInTurn(turn, call, title) {
  const asked = confirmWrite(call.name, call.args, title);
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

    // A card that appears while someone is typing must not be answered by
    // the key already on its way down. So the focus goes to "Not now" — a
    // stray Enter or Space declines — and "yes" cannot be pressed at all
    // until the card has been on screen long enough to be read as a card.
    yes.disabled = true;
    setTimeout(() => {
      yes.disabled = false;
    }, CONFIRM_ARMS_AFTER_MS);

    turn.appendChild(card);
    scrollToEnd();
    no.focus();
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
  const info = (await knownTools()).get(call.name);
  if (needsConfirmation(call.name, info?.annotations) && !(await confirmInTurn(turn, call, info?.title))) {
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

/**
 * Says something nobody asked for — a question from the door, a request to
 * ring — and brings it to the top of the conversation. There is no question
 * above it to scroll to (scrollToEnd), and left to that rule it lands out of
 * sight: above the room kept under the last turn, or below an earlier answer.
 */
function announce(presented) {
  const turn = assistantSays(presented);
  log.scrollTop = turn.offsetTop - 12;
  return turn;
}

// ---------------------------------------------------------------------------
// The door. When the resident presses "Ask … to look" on the television,
// the person asked should not have to think of asking. While this page is
// open it looks, over the same MCP tool anyone could call, and says so once.
// ---------------------------------------------------------------------------

const DOOR_WATCH_MS = 5000;
/** Each question announced in this page, and the turn it was announced in. */
const announcedDoorQuestions = new Map();
let doorWatch = null;

async function lookForDoorQuestion() {
  // Not behind another tab, and not across an answer being given. Whether
  // the resident allows this person is the server's to say, on every look
  // (INV-9): what this page knew at sign-in may be minutes old either way.
  if (document.hidden || !me || answering) return;
  try {
    const result = await callTool('get_door_request', {});
    if (result.isError === true) return;
    const text = result.content?.[0]?.text ?? '';
    const presented = presentResult('get_door_request', text, {}, formatTime);
    const fresh = doorQuestionToAnnounce(text, new Set(announcedDoorQuestions.keys()));
    if (fresh) {
      announcedDoorQuestions.set(fresh, { turn: announce(presented), shown: text });
      return;
    }
    // The picture and the sentence reach the door card a few seconds after
    // the card itself: a question already on the page is redrawn, not said again.
    const known = presented.card?.kind === 'door' ? announcedDoorQuestions.get(presented.card.requestId) : undefined;
    if (known && known.shown !== text && !known.turn.querySelector('.door-answers button:disabled')) {
      known.shown = text;
      known.turn.querySelector('.card.door')?.replaceWith(renderCard(presented.card));
    }
  } catch {
    // A look that failed is tried again; nothing is said about it.
  }
}

// A request to ring, or a hello (the resident held the button on the remote).
// Looked for as the door is, by the same timer, and said once. How each
// request stood at the last look is kept by id (surface.js reachToAnnounce).
const reachSeen = new Map();

/** The answers on every card for a request are put out of use once it is answered: there is nothing left to press. */
function settleReachCards(requestId) {
  for (const card of document.querySelectorAll('.card.reach')) {
    if (card.dataset.requestId !== requestId) continue;
    for (const button of card.querySelectorAll('.door-answers button')) button.disabled = true;
  }
}

async function lookForReach() {
  // As for the door: not behind another tab, not across an answer being given, and the server says on every look whether this person may ask (INV-9).
  if (document.hidden || !me || answering) return;
  try {
    // An older Wick has no such tool: it is not asked at all, rather than refused on every look (surface.js looksForReach).
    if (!looksForReach((await knownTools()).keys())) return;
    const result = await callToolOnly('get_reach_request', {});
    if (result.isError === true) return;
    const text = result.content?.[0]?.text ?? '';
    const news = reachToAnnounce(text, reachSeen);
    if (!news) return;
    reachSeen.set(news.requestId, news.state);
    if (news.state === 'answered') settleReachCards(news.requestId);
    if (news.announce) announce(presentResult('get_reach_request', text, {}, formatTime));
  } catch {
    // A look that failed is tried again; nothing is said about it.
  }
}

// What the resident asked Wick to tell ("Shall I tell Sarah?" on the
// television). Looked for when the page is opened or comes back into view —
// which is what pressing the notification does — and said once per browser.
const TOLD_SHOWN_KEY = 'wick_told_shown';

async function lookForWhatWasTold() {
  if (document.hidden || !me || answering) return;
  try {
    const result = await callTool('get_whats_different', {});
    if (result.isError === true) return;
    const text = result.content?.[0]?.text ?? '';
    const shown = JSON.parse(localStorage.getItem(TOLD_SHOWN_KEY) ?? '[]');
    const fresh = toldToAnnounce(text, Array.isArray(shown) ? shown : []);
    if (fresh.length === 0) return;
    localStorage.setItem(TOLD_SHOWN_KEY, JSON.stringify([...(Array.isArray(shown) ? shown : []), ...fresh].slice(-50)));
    assistantSays(presentResult('get_whats_different', text, {}, formatTime));
  } catch {
    // Read again the next time the page is looked at; nothing is said about it.
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  void lookForWhatWasTold();
  // Coming back to the page is what pressing the notification does: she may be waiting on the answer.
  void lookForReach();
  // And she may have answered about the language while this page was behind another.
  void languageCard?.look();
});

// A nudge that arrives while this page is open (sw.js): look at once.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.wick !== 'nudge') return;
    if (event.data.kind === 'told') void lookForWhatWasTold();
    if (event.data.kind === 'door_look') void lookForDoorQuestion();
    if (event.data.kind === 'reach_ring' || event.data.kind === 'reach_hello') void lookForReach();
  });
}

/**
 * One timer for both things the television can ask of this person. The door
 * is looked at on every turn of it: someone is standing there. A request to
 * ring gives each person three minutes, so every other turn is enough — and
 * a nudge, or coming back to the page, looks at once.
 */
const REACH_EVERY_LOOKS = 2;

function watchTheDoor() {
  if (doorWatch !== null) clearInterval(doorWatch);
  let looks = 0;
  doorWatch = setInterval(() => {
    void lookForDoorQuestion();
    looks += 1;
    if (looks % REACH_EVERY_LOOKS === 0) void lookForReach();
  }, DOOR_WATCH_MS);
  void lookForDoorQuestion();
  void lookForReach();
}

// ---------------------------------------------------------------------------
// Watching a film together. The seat is a player with no controls of its
// own, kept where the television's player is: the remote is the resident's,
// and this page only keeps up. What it should do is decided in surface.js
// (follow, watchStatus); this draws it and keeps asking where the film is,
// over the same MCP tool anyone could call.
// ---------------------------------------------------------------------------

const SEAT_LOOK_MS = 2000;
const WATCH_LOOK_MS = 20_000;
/**
 * hls.js, which plays the film (openSeat says why it comes before the
 * browser's own HLS). One pinned file, checked against this hash before it
 * runs, and fetched only when a seat is taken.
 */
const HLS_SRC = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.light.min.js';
const HLS_INTEGRITY = 'sha384-aUXIo1rkYXsnqzYlykJMPPxPku80rMufp2z0gLNU59eAyfNRhP87hllql3hwVjUZ';
let hlsLoading = null;

function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  hlsLoading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = HLS_SRC;
    script.integrity = HLS_INTEGRITY;
    script.crossOrigin = 'anonymous';
    script.onload = () => resolve(window.Hls);
    script.onerror = () => {
      hlsLoading = null;
      reject(new Error('The film player could not be loaded.'));
    };
    document.head.appendChild(script);
  });
  return hlsLoading;
}

/** The one seat open in this page: its card, its player, and the timer that keeps asking. */
let seat = null;
/** How each session stood at the last look, so only news is said unasked. */
const watchSeen = new Map();
let watchLook = null;

function closeSeat() {
  if (!seat) return;
  clearInterval(seat.timer);
  seat.hls?.destroy();
  seat.video.pause();
  seat.video.removeAttribute('src');
  seat.video.load();
  seat.screen.hidden = true;
  seat = null;
}

/** Puts the film in the seat's player, once, and starts asking where the television is. */
function openSeat(ui, stream) {
  if (seat === ui && ui.url === stream.url) return;
  // One film at a time: a seat taken again further down the page is the seat.
  if (seat && seat !== ui) {
    const moved = seat;
    closeSeat();
    moved.status.textContent = 'This is now further down the page.';
    moved.actions.replaceChildren();
  }
  seat = ui;
  ui.url = stream.url;
  ui.screen.hidden = false;
  // The browser's own HLS, where it has one — the way Safari plays it, and
  // what is left if hls.js cannot be fetched or cannot reach the film.
  const playNatively = () => {
    if (seat !== ui) return;
    if (!ui.video.canPlayType('application/vnd.apple.mpegurl')) {
      ui.problem = 'This browser cannot play the film.';
      ui.status.textContent = ui.problem;
      return;
    }
    ui.video.src = stream.url;
  };
  // hls.js first wherever it runs: it goes straight to the part of the film
  // it is sent to, where Chromium's own HLS reads its way there segment by
  // segment — a skip on the television took most of a minute to follow.
  loadHls()
    .then((Hls) => {
      if (seat !== ui) return;
      if (!Hls?.isSupported()) return playNatively();
      const hls = new Hls();
      ui.hls = hls;
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal || ui.hls !== hls) return;
        hls.destroy();
        ui.hls = null;
        playNatively();
      });
      hls.loadSource(stream.url);
      hls.attachMedia(ui.video);
    })
    .catch(playNatively);
  ui.timer = setInterval(() => void lookAtSeat(ui), SEAT_LOOK_MS);
}

/**
 * Sound needs a press in some browsers. The picture starts without it, and
 * the sound is then one press away — never a film that silently does not start.
 */
function startPlaying(ui) {
  ui.video.play().catch(() => {
    if (seat !== ui || ui.video.muted) return;
    ui.video.muted = true;
    ui.video.play().then(() => {
      if (ui.sound) return;
      ui.sound = el('button', 'btn', 'Turn the sound on');
      ui.sound.type = 'button';
      ui.sound.addEventListener('click', () => {
        ui.video.muted = false;
        ui.sound.remove();
        ui.sound = null;
      });
      ui.actions.appendChild(ui.sound);
    }).catch(() => {});
  });
}

/** A jump while playing aims this far ahead: about what it takes to start again, so it lands level and not behind. */
const SEEK_LEAD_MS = 1000;
/** After a jump the player is left to get there for this long before it is sent anywhere else. */
const SEEK_SETTLE_MS = 8000;

function keepUp(ui, card) {
  const { video } = ui;
  const asked = follow(card.playback, 0, { positionMs: video.currentTime * 1000, paused: video.paused }, card.stream.durationMs);
  // Not before it knows the film's length, and not while it is still finding
  // the last place it was sent: a new place every look would be no place at all.
  const settling = video.seeking || (video.readyState < 3 && Date.now() - (ui.soughtAt ?? 0) < SEEK_SETTLE_MS);
  if (asked.seekToMs !== null && !settling && video.readyState >= 1) {
    ui.soughtAt = Date.now();
    video.currentTime = (asked.seekToMs + (asked.play ? SEEK_LEAD_MS : 0)) / 1000;
  }
  if (asked.play && video.paused) startPlaying(ui);
  else if (!asked.play && !video.paused) video.pause();
}

async function sitDown(ui, button) {
  button.disabled = true;
  try {
    const result = await callTool('join_watch_together', { sessionId: ui.sessionId });
    const presented = presentResult('join_watch_together', result.content?.[0]?.text ?? '', {}, formatTime, result.isError === true);
    if (presented.card?.kind === 'watch') return drawSeat(ui, presented.card);
    // Not time yet, or the answer changed: said as the server said it.
    ui.status.textContent = presented.say;
  } catch (err) {
    ui.status.textContent = err.message;
  }
  button.disabled = false;
}

async function answerAfterWatching(ui, answer, buttons) {
  const all = [...buttons.querySelectorAll('button')];
  for (const button of all) button.disabled = true;
  try {
    const result = await callTool('answer_watch_together', { sessionId: ui.sessionId, answer: answer.key });
    const text = result.content?.[0]?.text ?? '';
    if (result.isError === true || !text.startsWith('{')) throw new Error(text || 'That could not be shown.');
    ui.yourAnswer = answer.text;
    drawQuestion(ui, { question: ui.questionText, answers: [], yourAnswer: answer.text, theirAnswer: ui.theirAnswer });
  } catch (err) {
    // Nothing was shown: the answers can be pressed again.
    for (const button of all) button.disabled = false;
    ui.status.textContent = err.message;
  }
}

/** The one question at the end: asked once the film has got there, answered with a button that carries the very words. */
function drawQuestion(ui, card) {
  if (!card.question) return;
  ui.questionText = card.question;
  ui.theirAnswer = card.theirAnswer ?? ui.theirAnswer ?? null;
  const yours = card.yourAnswer ?? ui.yourAnswer ?? null;
  const shown = `${yours ?? ''}|${ui.theirAnswer ?? ''}|${card.answers.length}`;
  if (ui.questionShown === shown) return;
  ui.questionShown = shown;

  const parts = [el('p', 'watch-asks', card.question)];
  if (yours) parts.push(el('p', 'reply', `You said: “${yours}”`));
  else if (card.answers.length) {
    const buttons = el('div', 'door-answers');
    for (const answer of card.answers) {
      const button = el('button', 'btn', answer.text);
      button.type = 'button';
      button.addEventListener('click', () => void answerAfterWatching(ui, answer, buttons));
      buttons.appendChild(button);
    }
    parts.push(buttons);
  }
  if (ui.theirAnswer) parts.push(el('p', 'reply', `On the television: “${ui.theirAnswer}”`));
  ui.question.replaceChildren(...parts);
  ui.question.hidden = false;
}

/** Brings a seat's card up to date with what the server last said. Called for the first drawing and after every look. */
function drawSeat(ui, card) {
  if (!ui.problem) ui.status.textContent = watchStatus(card);

  const canSit = card.state === 'accepted' && card.canSitDown;
  if (canSit && !ui.sit) {
    ui.sit = el('button', 'btn final', 'Sit down');
    ui.sit.type = 'button';
    ui.sit.addEventListener('click', () => void sitDown(ui, ui.sit));
    ui.actions.appendChild(ui.sit);
  } else if (!canSit && ui.sit) {
    ui.sit.remove();
    ui.sit = null;
  }

  // Until the film is started it can still be called off; her television then says so (undoButton).
  if (card.canCallOff && !ui.callOff) {
    ui.callOff = undoButton(
      { sessionId: ui.sessionId, accepted: true },
      (presented) => {
        if (seat === ui) closeSeat();
        ui.status.textContent = presented.say;
        ui.actions.replaceChildren();
        ui.sit = null;
        ui.callOff = null;
      },
      (message) => { ui.status.textContent = message; },
    );
    ui.actions.appendChild(ui.callOff);
  } else if (!card.canCallOff && ui.callOff) {
    ui.callOff.remove();
    ui.callOff = null;
  }

  if (card.stream) {
    ui.attribution.textContent = card.stream.attribution;
    openSeat(ui, card.stream);
    if (seat === ui) keepUp(ui, card);
  } else if (seat === ui) {
    closeSeat();
  }
  drawQuestion(ui, card);
}

async function lookAtSeat(ui) {
  if (seat !== ui) return;
  // The conversation was cleared, or the page signed out: nobody is in the seat.
  if (!ui.node.isConnected || !me) return closeSeat();
  try {
    const result = await callTool('get_watch_together', { sessionId: ui.sessionId });
    if (result.isError === true || seat !== ui) return;
    const presented = presentResult('get_watch_together', result.content?.[0]?.text ?? '', {}, formatTime);
    if (presented.card?.kind === 'watch') return drawSeat(ui, presented.card);
    // Nothing left to follow: the session is over, and the last word is the server's.
    closeSeat();
    ui.status.textContent = presented.say;
    ui.actions.replaceChildren();
  } catch {
    // A look that failed is tried again; the film plays on meanwhile.
  }
}

// ---------------------------------------------------------------------------
// The light in the window. One thing about today: lit, or not. What it says
// is decided in surface.js (presentLight, lightToShow); this draws it — in
// the card that answers the question, and in the corner of the page.
// ---------------------------------------------------------------------------

function renderLightCard(card) {
  const node = el('article', 'card light-card');
  const window_ = el('div', card.lit ? 'window lit' : 'window');
  window_.setAttribute('role', 'img');
  window_.setAttribute('aria-label', card.title);
  window_.innerHTML = FLAME;
  node.appendChild(window_);
  node.appendChild(el('h2', 'card-title', card.title));
  if (card.note) node.appendChild(el('p', 'light-note', card.note));
  node.appendChild(cardFoot(card.footnote));
  return node;
}

/** The corner of the page: lit, not lit, or — with nothing to show — nothing at all. */
function showLightInCorner(shown) {
  const corner = $('light');
  if (!shown || !me) {
    corner.hidden = true;
    return;
  }
  const resident = me.household.residentName;
  const words = shown.lit ? `${resident}’s light is on` : `${resident}’s light is not on`;
  corner.className = shown.lit ? 'light lit' : 'light';
  corner.innerHTML = FLAME;
  corner.appendChild(el('span', undefined, words));
  corner.setAttribute('aria-label', words);
  corner.hidden = false;
}

/** Looked at once when the app is opened, like looking in at a window on the way past. The resident is told of it (get_light). */
async function lookAtTheLight() {
  if (!me || me.membership.status !== 'allowed') return;
  try {
    await callTool('get_light', {});
  } catch {
    // The corner stays empty; asking again is one chip away.
  }
}

/**
 * A film watched together: the picture, one line saying what the
 * television is doing, and — when it is time — the button that takes the
 * seat. There is no pause and no skip, on purpose.
 */
function renderWatchCard(card) {
  const node = el('article', 'card watch');
  const head = el('div', 'card-head');
  head.appendChild(el('h2', 'card-title', card.title));
  head.appendChild(el('span', 'card-meta', card.meta));

  const screen = el('div', 'watch-screen');
  const video = document.createElement('video');
  video.playsInline = true;
  video.preload = 'auto';
  video.setAttribute('aria-label', `${card.title}, following the television`);
  screen.appendChild(video);
  screen.hidden = true;

  const status = el('p', 'watch-status');
  status.setAttribute('aria-live', 'polite');
  const actions = el('div', 'actions');
  const question = el('div', 'watch-question');
  question.hidden = true;
  const attribution = el('p', 'watch-attribution');

  node.append(head, screen, status, actions, question, attribution, cardFoot(card.footnote));
  drawSeat({ node, screen, video, status, actions, question, attribution, sessionId: card.sessionId }, card);
  return node;
}

/**
 * The button that undoes an invitation (withdraw_watch_invitation). One not
 * yet answered is taken back in one press: nothing is said to anybody. One
 * she has said yes to is called off, and her television says so — so that
 * takes two presses, the first only asking, like removing someone from the
 * circle.
 *
 * @param {{sessionId: string, accepted: boolean}} what
 * @param {(presented: {say: string, tone: string}, undone: boolean) => void} done  what the server said, and whether anything was undone
 * @param {(message: string) => void} failed
 */
function undoButton(what, done, failed) {
  const label = what.accepted ? 'I can’t make it' : 'Take it back';
  const button = el('button', what.accepted ? 'btn link' : 'btn', label);
  button.type = 'button';
  button.addEventListener('click', async () => {
    if (what.accepted && button.dataset.armed !== 'true') {
      button.dataset.armed = 'true';
      button.textContent = 'Call it off — sure?';
      return;
    }
    button.disabled = true;
    try {
      const result = await callTool('withdraw_watch_invitation', { sessionId: what.sessionId });
      const text = result.content?.[0]?.text ?? '';
      const presented = presentResult('withdraw_watch_invitation', text, {}, formatTime, result.isError === true);
      // Undone, or she got there a moment before: either way it is said as the server said it, and there is nothing left to press.
      if (presented.tone !== 'error') return done(presented, text.startsWith('{'));
      failed(presented.say);
    } catch (err) {
      failed(err.message);
    }
    button.disabled = false;
    button.dataset.armed = 'false';
    button.textContent = label;
  });
  return button;
}

/**
 * An invitation with nothing to do yet but wait — still unanswered, or
 * answered yes and not yet time — and the one thing that can be done about
 * it from here: undoing it.
 */
function renderInvitationCard(card) {
  const node = el('article', 'card watch');
  const head = el('div', 'card-head');
  head.appendChild(el('h2', 'card-title', card.title));
  head.appendChild(el('span', 'card-meta', card.meta));
  const status = el('p', 'watch-status', card.accepted ? 'The answer was yes.' : 'Waiting for an answer on the television.');
  status.setAttribute('aria-live', 'polite');
  const actions = el('div', 'actions');
  const foot = cardFoot(card.footnote);
  const undo = undoButton(
    { sessionId: card.sessionId, accepted: card.accepted === true },
    (presented, undone) => {
      status.textContent = presented.say;
      // Nothing is waiting any more: the note under the card must not go on saying that it is.
      // Only one really undone can be asked again; anything else stands as she answered it.
      foot.querySelector('.note').textContent = undone ? 'You can ask again whenever you like.' : '';
      undo.remove();
    },
    (message) => { status.textContent = message; },
  );
  actions.appendChild(undo);
  node.append(head, status, actions, foot);
  return node;
}

/** While the app is open it looks, as it does for the door, and says only what is news (surface.js watchToAnnounce). */
async function lookForTheFilm() {
  // Not behind another tab, not across an answer being given, and not while the seat is asking for itself.
  if (document.hidden || !me || answering || seat) return;
  try {
    const result = await callToolOnly('get_watch_together', {});
    if (result.isError === true) return;
    const text = result.content?.[0]?.text ?? '';
    const news = watchToAnnounce(text, watchSeen);
    if (!news) return;
    watchSeen.set(news.sessionId, news.key);
    if (news.announce) assistantSays(presentResult('get_watch_together', text, {}, formatTime));
  } catch {
    // A look that failed is tried again; nothing is said about it.
  }
}

function watchForTheFilm() {
  if (watchLook !== null) clearInterval(watchLook);
  watchLook = setInterval(() => void lookForTheFilm(), WATCH_LOOK_MS);
  void lookForTheFilm();
}

/** The invitation, as a form: which film, which day, what time. What the page offers where there is no assistant to ask. */
function addInvitationToWatch() {
  const turn = el('div', 'turn-assistant');
  turn.appendChild(el('p', 'say', 'Which film, and when?'));

  const card = el('article', 'card');
  const head = el('div', 'card-head');
  head.appendChild(el('h2', 'card-title', 'Watch a film together'));
  card.appendChild(head);

  const form = el('form', 'form');
  const filmLabel = el('label', undefined, 'Film');
  const film = document.createElement('select');
  for (const [id, title] of Object.entries(FILMS)) {
    const option = el('option', undefined, title);
    option.value = id;
    film.appendChild(option);
  }
  filmLabel.appendChild(film);

  const dayLabel = el('label', undefined, 'Day');
  const day = document.createElement('input');
  day.type = 'date';
  day.required = true;
  dayLabel.appendChild(day);

  const timeLabel = el('label', undefined, 'Time, where the television is');
  const time = document.createElement('input');
  time.type = 'time';
  time.required = true;
  time.value = '15:00';
  timeLabel.appendChild(time);

  const actions = el('div', 'actions');
  const send = el('button', 'btn final', 'Ask');
  send.type = 'submit';
  const cancel = el('button', 'btn quiet', 'Not now');
  cancel.type = 'button';
  actions.append(send, cancel);

  form.append(filmLabel, dayLabel, timeLabel, actions);
  card.appendChild(form);
  card.appendChild(cardFoot('The invitation appears on the television at the next natural break. Your screen would follow theirs: they hold the remote.'));
  turn.appendChild(card);
  log.appendChild(turn);
  scrollToEnd();
  film.focus();

  cancel.addEventListener('click', () => turn.remove());
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const args = { programme: film.value, date: day.value, time: time.value };
    turn.remove();
    addCustomerTurn(`Ask to watch ${FILMS[args.programme]} together on ${args.date} at ${args.time}`);
    void askTool('invite_to_watch', args, { now: Date.now() });
  });
}

// ---------------------------------------------------------------------------
// Notifications (Web Push): being told when this page is closed. The browser
// is registered with the Wick server under the person signed in; what is
// then sent to it is a kind and nothing else, and sw.js supplies the words.
// ---------------------------------------------------------------------------

const PUSH_OFFERED_KEY = 'wick_push_offered';

async function readPushState() {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!supported) return { supported: false };
  let info;
  try {
    info = await api('/api/push');
  } catch {
    info = { available: false };
  }
  if (!info.available) return { supported, available: false };
  const registration = await navigator.serviceWorker.register('./sw.js');
  let existing = await registration.pushManager.getSubscription();
  // Made with a key this Wick no longer signs with: its nudges would be refused, so it is made again when asked for.
  if (existing && !madeWithKey(existing, info.publicKey)) {
    await existing.unsubscribe();
    existing = null;
  }
  return { supported, available: true, publicKey: info.publicKey, permission: Notification.permission, subscribed: Boolean(existing), registration, existing };
}

const registerBrowser = (subscription) => api('/api/push', { method: 'POST', body: JSON.stringify(subscription.toJSON()) });

/** This browser stops being told: asked of the push service here, and of the Wick server while the link still stands. */
async function forgetThisBrowser({ tellServer }) {
  try {
    if (!('serviceWorker' in navigator)) return;
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;
    if (tellServer) await api('/api/push', { method: 'DELETE', body: JSON.stringify({ endpoint: subscription.endpoint }) }).catch(() => {});
    await subscription.unsubscribe();
  } catch {
    // The push service forgets a browser that stops answering; nothing to say here.
  }
}

/**
 * Says where notifications stand, and offers to turn them on when they can be.
 * @param {{quietUnlessOffered?: boolean}} [options]  say nothing at all unless there is something to offer
 */
async function showNotifications({ quietUnlessOffered = false } = {}) {
  let state;
  try {
    state = await readPushState();
    // A browser already registered is registered again under whoever is
    // signed in now — it may last have been somebody else on this computer.
    if (state.existing && state.permission === 'granted') await registerBrowser(state.existing);
  } catch (err) {
    if (!quietUnlessOffered) assistantSays({ say: err.message, tone: 'error' });
    return;
  }
  const resident = me.household.residentName;
  const presented = presentNotifications(state, resident);
  if (quietUnlessOffered && !presented.offer) return;
  const turn = assistantSays({ say: presented.say, tone: 'answer' });
  if (!presented.card) return;

  const { card, body } = plainCard(presented.card.title, 'It can be turned off again in the browser’s site settings.');
  body.appendChild(el('p', undefined, presented.card.body));
  const actions = el('div', 'actions');
  const yes = el('button', 'btn final', presented.card.confirmLabel);
  yes.type = 'button';
  yes.addEventListener('click', async () => {
    yes.disabled = true;
    try {
      // The browser's own question. Asked from a press, as browsers require.
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        // The worker must be running before a browser will subscribe through it.
        await navigator.serviceWorker.ready;
        const subscription =
          state.existing ??
          (await state.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(state.publicKey) }));
        await registerBrowser(subscription);
        assistantSays(presentNotifications({ ...state, permission, subscribed: true }, resident));
      } else {
        assistantSays(presentNotifications({ ...state, permission }, resident));
      }
    } catch (err) {
      yes.disabled = false;
      assistantSays({ say: err.message, tone: 'error' });
    }
  });
  actions.appendChild(yes);
  body.appendChild(actions);
  turn.appendChild(card);
  scrollToEnd();
}

/** Offered once per browser, at a moment it means something — never asked again unprompted. */
function offerNotificationsOnce() {
  if (!me || me.membership.status !== 'allowed' || localStorage.getItem(PUSH_OFFERED_KEY)) return;
  localStorage.setItem(PUSH_OFFERED_KEY, '1');
  void showNotifications({ quietUnlessOffered: true });
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

/**
 * A code that came in a link: show it, and ask whether it is the one on the
 * television in front of the person, before it can go anywhere. What is said
 * is decided in surface.js (presentPairLink). Somebody who is offered no
 * television at all is told so at once, without being shown the code.
 */
function addPairLinkGate(code) {
  if (!me) return;
  const resident = me.household.residentName;
  if (!presentConnect(me).offered) return void addConnectTelevision();
  const gate = presentPairLink(code, resident);
  if (!gate.offered) return void addConnectTelevision();

  const turn = el('div', 'turn-assistant');
  const { card, body } = plainCard(gate.title, gate.warning);
  body.appendChild(el('p', undefined, gate.question));
  const actions = el('div', 'actions');
  const yes = el('button', 'btn final', gate.confirm);
  yes.type = 'button';
  const no = el('button', 'btn quiet', gate.refuse);
  no.type = 'button';
  actions.append(no, yes);
  body.appendChild(actions);
  turn.appendChild(card);
  log.appendChild(turn);
  scrollToEnd();
  // The way out has the focus: a press made without reading connects nothing.
  no.focus();

  no.addEventListener('click', () => {
    turn.remove();
    assistantSays({ say: gate.refused, tone: 'answer' });
    $('ask-input').focus();
  });
  yes.addEventListener('click', () => {
    turn.remove();
    addConnectTelevision({ prefill: gate.shown });
  });
}

/**
 * Ask whose television it is — the resident's, or the signed-in person's own
 * — and for the six digits on it. Who is offered which, and every sentence,
 * is decided in surface.js (presentConnect); the server decides again when
 * the code is sent.
 *
 * @param {{ prefill?: string, wanted?: 'family' }} [options]  the code from a television's pairing link; 'family' when the person said the television is theirs
 */
function addConnectTelevision({ prefill, wanted } = {}) {
  if (!me) return;
  const resident = me.household.residentName;
  const view = presentConnect(me, wanted);
  if (!view.offered) {
    assistantSays({ say: view.say, tone: view.tone });
    $('ask-input').focus();
    return;
  }
  if (view.say) assistantSays({ say: view.say, tone: 'waiting' });

  /** Whose it is to be: 'resident', 'family', or nothing while an organiser has not said. */
  let as = view.as;
  const turn = el('div', 'turn-assistant');
  const { card, body } = plainCard(view.title, as ? view.footnote[as] : '');
  const footnote = card.querySelector('.card-foot .note');
  const lead = el('p', 'empty', view.lead[as ?? 'resident']);
  // The code is asked for once it is known whose television it is.
  const rest = el('div', 'form');
  rest.hidden = !as;

  const choices = [];
  if (view.whose) {
    const group = el('div', 'form');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', view.whose.question);
    group.appendChild(el('p', undefined, view.whose.question));
    const options = el('div', 'actions');
    for (const option of view.whose.options) {
      const choice = el('button', 'btn quiet choice', option.label);
      choice.type = 'button';
      choice.setAttribute('aria-pressed', String(as === option.as));
      choice.addEventListener('click', () => {
        as = option.as;
        for (const other of choices) other.button.setAttribute('aria-pressed', String(other.as === as));
        lead.textContent = view.lead[as];
        footnote.textContent = view.footnote[as];
        rest.hidden = false;
        input.focus();
      });
      choices.push({ as: option.as, button: choice });
      options.appendChild(choice);
    }
    group.appendChild(options);
    body.appendChild(group);
  }

  rest.appendChild(lead);
  if (me.virtualTelevisionUrl) {
    // Nobody needs a Fire TV to see the resident's side: a television in a
    // browser tab pairs with the same code and shows the same cards.
    const hint = el('p', 'empty', 'No Fire TV to hand? ');
    const tv = el('a', undefined, 'Open a virtual television');
    tv.href = me.virtualTelevisionUrl;
    tv.target = '_blank';
    tv.rel = 'noopener';
    hint.append(tv, ', press “Pair & connect” there, and enter its code here.');
    rest.appendChild(hint);
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
  rest.appendChild(form);
  body.appendChild(rest);
  turn.appendChild(card);
  log.appendChild(turn);
  scrollToEnd();
  // With a choice still to make, the first of the two answers; otherwise the code.
  if (as) input.focus();
  else choices[0]?.button.focus();

  cancel.addEventListener('click', () => turn.remove());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!as) return;
    go.disabled = true;
    problem.textContent = '';
    try {
      // The resident's television is asked for exactly as it always was: a code, and nothing else.
      const answer = await api('/api/televisions', {
        method: 'POST',
        body: JSON.stringify(as === 'family' ? { code: input.value, as: 'family' } : { code: input.value }),
      });
      turn.remove();
      const connected = presentConnected(as, answer, resident);
      if (connected.say) assistantSays({ say: connected.say, tone: connected.tone });
      // The resident's television changes what comes next (she is asked, on it); a television of one's own does not.
      if (connected.kind === 'resident') await welcome();
      else $('ask-input').focus();
    } catch (err) {
      problem.textContent = err.message;
      go.disabled = false;
    }
  });
}

/**
 * Make an invitation and show the link to send. With `role: 'neighbour'` it
 * is for somebody who helps with the door and with ringing, and sees nothing
 * else; with none it is for family, as it always was. What is said and shown
 * is decided in surface.js (presentInvitation).
 */
async function addInvitation(role) {
  const resident = me?.household.residentName ?? 'The person at home';
  try {
    const invitation = await api('/api/circle/invitations', role ? { method: 'POST', body: JSON.stringify({ role }) } : { method: 'POST' });
    const presented = presentInvitation(role, invitation, resident);
    if (!presented.offered) return void assistantSays({ say: presented.say, tone: 'answer' });
    const turn = assistantSays({ say: presented.say, tone: 'answer' });
    const { card, body } = plainCard(presented.title, presented.footnote);
    const input = el('input', 'linkbox');
    input.readOnly = true;
    input.value = inviteLink(window.location.href, invitation.code);
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
    if (presented.note) body.appendChild(el('p', 'empty', presented.note));
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

  /** A list of televisions, each with — for whoever may — the way to disconnect it. */
  const televisionList = (televisions, route) => {
    const sets = el('ul', 'rows');
    for (const tv of televisions) {
      const li = el('li', 'row');
      li.appendChild(el('span', 'primary', tv.primary));
      li.appendChild(el('span', 'secondary', tv.secondary));
      if (tv.removable) {
        // Two presses: the first only asks.
        const disconnect = el('button', 'btn link', 'Disconnect');
        disconnect.type = 'button';
        disconnect.addEventListener('click', async () => {
          if (disconnect.dataset.armed !== 'true') {
            disconnect.dataset.armed = 'true';
            disconnect.textContent = 'Disconnect — sure?';
            return;
          }
          try {
            await api(`${route}/${encodeURIComponent(tv.deviceId)}`, { method: 'DELETE' });
            await showCircle();
          } catch (err) {
            assistantSays({ say: err.message, tone: 'error' });
          }
        });
        li.appendChild(disconnect);
      }
      sets.appendChild(li);
    }
    return sets;
  };

  // Each television, and — for the organiser — the way to disconnect one that was replaced or only ever a test.
  if (view.televisions.length > 0) body.appendChild(televisionList(view.televisions, '/api/televisions'));

  // The family's own televisions, in a list of their own: never the resident's, and not counted above.
  // Each can be disconnected by whoever it belongs to, and by the organiser.
  if (view.familyTelevisions.length > 0) {
    body.appendChild(el('p', 'empty', view.familyTelevisionsTitle));
    body.appendChild(televisionList(view.familyTelevisions, '/api/family-televisions'));
  }

  if (view.organiser) {
    const actions = el('div', 'actions');
    const invite = el('button', 'btn', 'Invite someone');
    invite.type = 'button';
    invite.addEventListener('click', () => void addInvitation());
    // Quieter: a neighbour is asked for the door and for ringing, and is not family.
    const inviteNeighbour = el('button', 'btn quiet', 'Invite a neighbour');
    inviteNeighbour.type = 'button';
    inviteNeighbour.addEventListener('click', () => void addInvitation('neighbour'));
    const connectTv = el('button', 'btn quiet', 'Connect a television');
    connectTv.type = 'button';
    connectTv.addEventListener('click', () => addConnectTelevision());
    const doorbell = el('button', 'btn quiet', 'Doorbell');
    doorbell.type = 'button';
    doorbell.addEventListener('click', () => void showDoorbell());
    // The language her television speaks: asked for here, answered by her there.
    const language = el('button', 'btn quiet', 'Television language');
    language.type = 'button';
    language.addEventListener('click', () => void showLanguage());
    actions.append(invite, inviteNeighbour, connectTv, doorbell, language);
    body.appendChild(actions);
  } else if (view.connect === 'family') {
    // A family member the resident has allowed: a television of their own, and no other.
    const actions = el('div', 'actions');
    const connectOwn = el('button', 'btn quiet', 'Connect my own television');
    connectOwn.type = 'button';
    connectOwn.addEventListener('click', () => addConnectTelevision());
    actions.appendChild(connectOwn);
    body.appendChild(actions);
  }
  return card;
}

// ---------------------------------------------------------------------------
// The home's doorbell: its own Ring link, connected by its organiser. What is
// said and shown is decided in surface.js (presentDoorbell); the server
// decides who may ask, and keeps the tokens (GET/POST/DELETE /api/ring).

/** Paste a token from Ring's Developer Playground. The token goes to the Wick server and is never shown again. */
function addPlaygroundToken() {
  const turn = assistantSays({ say: 'Paste a token from Ring’s Developer Playground.', tone: 'answer' });
  const { card, body } = plainCard(
    'Ring’s simulator',
    'The Playground is Ring’s simulated doorbell. Its token works for about half an hour, and Wick keeps it on its server, not in this browser.',
  );
  const form = el('form');
  form.autocomplete = 'off';
  const label = el('label', '', 'Playground token');
  const input = el('textarea');
  input.rows = 3;
  input.required = true;
  input.spellcheck = false;
  input.setAttribute('autocapitalize', 'off');
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
  scrollToEnd();
  input.focus();

  cancel.addEventListener('click', () => turn.remove());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    go.disabled = true;
    problem.textContent = '';
    try {
      const link = await api('/api/ring/playground', { method: 'POST', body: JSON.stringify({ token: input.value.trim() }) });
      turn.remove();
      showDoorbellLink(link);
    } catch (err) {
      problem.textContent = err.message;
      go.disabled = false;
    }
  });
}

function renderDoorbellCard(view) {
  const { card, body } = plainCard(view.title, view.footnote);
  if (view.rows.length > 0) {
    const rows = el('ul', 'rows');
    for (const row of view.rows) {
      const li = el('li', 'row');
      li.append(el('span', 'primary', row.primary), el('span', 'secondary', row.secondary));
      rows.appendChild(li);
    }
    body.appendChild(rows);
  }

  const actions = el('div', 'actions');
  if (view.actions.connectRing) {
    const ring = el('button', 'btn', 'Connect a Ring account');
    ring.type = 'button';
    ring.addEventListener('click', async () => {
      ring.disabled = true;
      try {
        // Ring's own sign-in, in its own tab; it comes back to a Wick page that says how it went.
        const { url } = await api('/api/ring/link', { method: 'POST' });
        window.open(url, '_blank', 'noopener');
        assistantSays({ say: 'Ring’s sign-in is open in another tab. When you have signed in there, it brings you back to Wick to finish.', tone: 'answer' });
      } catch (err) {
        assistantSays({ say: err.message, tone: 'error' });
      }
      ring.disabled = false;
    });
    actions.appendChild(ring);
  }
  if (view.actions.playground) {
    const simulator = el('button', 'btn quiet', 'Use Ring’s simulator');
    simulator.type = 'button';
    simulator.addEventListener('click', () => addPlaygroundToken());
    actions.appendChild(simulator);
  }
  if (view.actions.disconnect) {
    // Two presses: the first only asks.
    const disconnect = el('button', 'btn link', 'Disconnect');
    disconnect.type = 'button';
    disconnect.addEventListener('click', async () => {
      if (disconnect.dataset.armed !== 'true') {
        disconnect.dataset.armed = 'true';
        disconnect.textContent = 'Disconnect — sure?';
        return;
      }
      try {
        showDoorbellLink(await api('/api/ring', { method: 'DELETE' }));
      } catch (err) {
        assistantSays({ say: err.message, tone: 'error' });
      }
    });
    actions.appendChild(disconnect);
  }
  if (actions.childElementCount > 0) body.appendChild(actions);
  return card;
}

/** Say and show a link the server has just described. */
function showDoorbellLink(link) {
  const presented = presentDoorbell(link, me, formatTime);
  const turn = assistantSays({ say: presented.say, tone: presented.tone });
  turn.appendChild(renderDoorbellCard(presented.card));
  scrollToEnd();
}

async function showDoorbell() {
  const turn = addThinking();
  try {
    me = await api('/api/me');
    const presented = presentDoorbell(await api('/api/ring'), me, formatTime);
    fillAssistantTurn(turn, { say: presented.say, card: null, tone: presented.tone });
    turn.appendChild(renderDoorbellCard(presented.card));
    scrollToEnd();
  } catch (err) {
    // 403 carries the server's own sentence: only the organiser connects a doorbell.
    fillAssistantTurn(turn, { say: err.message, card: null, tone: err.status === 403 ? 'waiting' : 'error' });
  }
}

// ---------------------------------------------------------------------------
// The television speaks her language: which language the resident's
// television speaks, and — for the organiser — asking her for another. What
// is said and shown is decided in surface.js (presentLanguage, languageNews);
// the server decides who may read and who may ask (GET and POST
// /api/language, DELETE /api/language/question). Asking changes nothing: she
// answers on her own television, and the card looks again until she has.
// ---------------------------------------------------------------------------

/** As often as the door is looked at: her answer is one press, and may be hours away. */
const LANGUAGE_LOOK_MS = 5000;
/** The latest language card on the page — the only one that goes on looking: `{ turn, view, timer, busy, look }`. */
let languageCard = null;

function stopLookingAtLanguage() {
  if (languageCard && languageCard.timer !== null) clearInterval(languageCard.timer);
  if (languageCard) languageCard.timer = null;
}

/**
 * Puts the card under a turn and keeps it true. Its parts are made once and
 * filled again each time something changes — on a press here, or when a
 * look finds her answer — so the line that says what happened stays the
 * same live region, and is read out when it changes.
 */
function addLanguageCard(turn, first) {
  const resident = me.household.residentName;
  const shownFirst = presentLanguage(first, me).card;
  const { card, body } = plainCard(shownFirst.title, shownFirst.footnote);
  card.classList.add('language');
  const rows = el('ul', 'rows');
  const line = el('p', 'watch-status');
  line.setAttribute('role', 'status');
  line.setAttribute('aria-live', 'polite');
  // Her no, and a question taken back, while each stands: said where the button for that language would be.
  const standing = el('p', 'empty');
  const actions = el('div', 'actions');
  const problem = el('p', 'problem');
  problem.setAttribute('role', 'alert');
  body.append(rows, line);
  if (shownFirst.note) body.appendChild(el('p', 'empty', shownFirst.note));
  body.append(standing, actions, problem);
  turn.appendChild(card);

  // A card opened earlier stops looking: one card on the page is kept true, and it is this one.
  stopLookingAtLanguage();
  const state = { turn, view: first, timer: null, busy: false, look: () => look() };
  languageCard = state;

  /** A press: off while it is asked, and the answer — or the refusal, in the server's own words — shown here. */
  const press = (button, request, confirm) => {
    button.type = 'button';
    button.addEventListener('click', async () => {
      // Two presses where one would cost something (taking the question back starts a day's wait): the first only asks.
      if (confirm && button.dataset.armed !== 'true') {
        button.dataset.armed = 'true';
        button.textContent = confirm;
        return;
      }
      state.busy = true;
      for (const other of actions.querySelectorAll('button')) other.disabled = true;
      problem.textContent = '';
      try {
        const answer = await request();
        show(answer, answer.say);
        if (answer.say) speak(answer.say);
        // The button pressed is gone: the focus goes to what can be done next, or back to the question field.
        (actions.querySelector('button') ?? $('ask-input')).focus();
      } catch (err) {
        // An older Wick server has no such route: said in words, not as a number.
        problem.textContent = err.status === 404 ? LANGUAGE_UNAVAILABLE : err.message;
        for (const other of actions.querySelectorAll('button')) other.disabled = false;
      }
      state.busy = false;
    });
    return button;
  };

  /** Fills the card for how the language stands now. `said` replaces the line the card would say for itself. */
  function show(view, said) {
    state.view = view;
    const shown = presentLanguage(view, me).card;
    rows.replaceChildren(...shown.rows.map((row) => {
      const li = el('li', 'row');
      if (row.current) li.setAttribute('aria-current', 'true');
      const primary = el('span', 'primary', row.own ? `${row.name} — ` : row.name);
      if (row.own) {
        // The language's own name is in that language, and is said as such by a screen reader.
        const own = el('span', undefined, row.own);
        own.lang = row.language;
        primary.appendChild(own);
      }
      li.append(primary, el('span', 'secondary', row.secondary));
      return li;
    }));
    line.textContent = said || shown.status;
    standing.textContent = shown.waits.join(' ');
    standing.hidden = shown.waits.length === 0;
    actions.replaceChildren(
      ...shown.asks.map((ask) =>
        press(el('button', 'btn', ask.label), () => api('/api/language', { method: 'POST', body: JSON.stringify({ language: ask.language }) }))),
      ...(shown.takeBack
        ? [press(el('button', 'btn quiet', shown.takeBack.label), () => api('/api/language/question', { method: 'DELETE' }), shown.takeBack.confirm)]
        : []),
    );
    // Looking goes on only while a question is open, and only for the latest card.
    if (shown.waiting && languageCard === state) {
      if (state.timer === null) state.timer = setInterval(() => void look(), LANGUAGE_LOOK_MS);
    } else if (state.timer !== null) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  /** Has she answered? Asked of the server, which says again on every look who may know (INV-9). */
  async function look() {
    // No longer the latest card, gone from the page, or signed out: this card has stopped being kept true.
    if (languageCard !== state || !turn.isConnected || !me) {
      if (state.timer !== null) clearInterval(state.timer);
      state.timer = null;
      return;
    }
    // Not behind another tab, not across a press here, and not once there is nothing left to wait for.
    if (document.hidden || state.busy || state.timer === null) return;
    try {
      const now = await api('/api/language');
      // A press crossed this look: its answer is the newer one.
      if (languageCard !== state || state.busy) return;
      const news = languageNews(state.view, now, resident);
      if (!news) return;
      show(now, news.say);
      if (news.say) speak(news.say);
    } catch (err) {
      // Refused: she has stopped allowing this person. The card says so and asks nothing more.
      if (err.status === 403) {
        clearInterval(state.timer);
        state.timer = null;
        line.textContent = err.message;
        actions.replaceChildren();
      }
      // Any other look that failed is tried again; nothing is said about it.
    }
  }

  show(first);
}

async function showLanguage() {
  const turn = addThinking();
  try {
    me = await api('/api/me');
    // A neighbour never sees it, and nobody she has not allowed does: for them the server is not even asked.
    const offer = languageOffer(me);
    if (!offer.offered) return void fillAssistantTurn(turn, { say: offer.say, card: null, tone: offer.tone });
    const view = await api('/api/language');
    const presented = presentLanguage(view, me);
    fillAssistantTurn(turn, { say: presented.say, card: null, tone: presented.tone });
    addLanguageCard(turn, view);
    scrollToEnd();
  } catch (err) {
    // 403 carries the server's own sentence: not allowed on the television yet. 404 is a Wick server from before this.
    const say = err.status === 404 ? LANGUAGE_UNAVAILABLE : err.message;
    fillAssistantTurn(turn, { say, card: null, tone: err.status === 403 || err.status === 404 ? 'waiting' : 'error' });
  }
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
  // A television's pairing link leads to the same card as asking for it — the choice for an organiser, their own
  // for a family member, one sentence for somebody offered neither — but never straight to it: the code in a
  // link is first shown and confirmed (addPairLinkGate), because anybody can send such a link.
  if (pair) addPairLinkGate(pair);
  else if (me.membership.role === 'organiser' && presented.next === 'connect') addConnectTelevision();
  else $('ask-input').focus();
  watchTheDoor();
  watchForTheFilm();
  void lookAtTheLight();
  void lookForWhatWasTold();
  offerNotificationsOnce();
}

/** The rules this page answered by before there was a model, and still does when there is none. */
function answerByRules(text) {
  const route = routeUtterance(text);
  if (route.kind === 'tool') return void askTool(route.tool, route.args, { now: Date.now() });
  if (route.kind === 'compose') return addComposer(route.message);
  if (route.kind === 'invite') return addInvitationToWatch();
  if (route.kind === 'circle') return void showCircle();
  if (route.kind === 'connect') return addConnectTelevision({ wanted: route.as });
  if (route.kind === 'doorbell') return void showDoorbell();
  if (route.kind === 'language') return void showLanguage();
  if (route.kind === 'notifications') return void showNotifications();
  assistantSays({ say: HELP_TEXT, tone: 'answer' });
}

/** The chips and the text field, off while a question is being answered. */
function setAsking(enabled) {
  for (const control of document.querySelectorAll('.chip, #ask-input, #ask-send')) control.disabled = !enabled;
}

async function handleUtterance(text) {
  if (answering) return;
  addCustomerTurn(text);
  // The circle is this app's own business with the server, not a question for a tool.
  if (routeUtterance(text).kind === 'circle') return void showCircle();
  // And so is a television of one's own: "connect my television" opens the card with "Mine" chosen.
  if (routeUtterance(text).kind === 'connect') return addConnectTelevision({ wanted: routeUtterance(text).as });
  if (routeUtterance(text).kind === 'doorbell') return void showDoorbell();
  // And so is the language her television speaks: the organiser asks here, and she answers there.
  if (routeUtterance(text).kind === 'language') return void showLanguage();
  // And so are this browser's notifications.
  if (routeUtterance(text).kind === 'notifications') return void showNotifications();
  if (noAssistant) return answerByRules(text);

  answering = true;
  setAsking(false);
  let answered = false;
  try {
    answered = await converse(text);
  } finally {
    answering = false;
    // Still signed in? Then the next question may be asked.
    if (me) {
      setAsking(true);
      $('ask-input').focus();
    }
  }
  if (!answered) answerByRules(text);
}

/**
 * The chips under the conversation. Drawn once from the app's own list, and
 * again when the add-on listing is read: its phrases then come first.
 */
function showSuggestions(listing) {
  // As enabled as the field beside them: redrawing must not open what sign-in has not.
  const enabled = !$('ask-input').disabled;
  $('chips').replaceChildren(...suggestionsFor(listing).map((suggestion) => {
    const chip = el('button', 'chip', suggestion.label);
    chip.type = 'button';
    chip.disabled = !enabled;
    chip.addEventListener('click', () => void handleUtterance(suggestion.utterance));
    return chip;
  }));
}
showSuggestions(null);

/**
 * Wick's listing as an add-on, from the package published beside this page
 * (addon-package/addon.json — the file `alexa-ai deploy` would be given).
 * Nothing if it cannot be read: the page then links an account as before.
 */
async function readListing() {
  try {
    const res = await fetch('./addon.json', { cache: 'no-cache' });
    return res.ok ? presentListing(await res.json()) : null;
  } catch {
    return null;
  }
}

/** The link card, as a customer would meet Wick before enabling it. */
function showListing(listing) {
  if (!$('listing-body')) return;
  $('link-say').textContent = `${listing.name}, as it would be listed for Alexa+. This listing is simulated.`;
  $('link-title').textContent = listing.name;
  $('link-detail').textContent = listing.summary;
  $('connect').textContent = 'Enable and link your account';
  if (listing.iconUrl) {
    // An icon that will not load is left out, not shown broken.
    $('listing-icon').addEventListener('error', () => { $('listing-icon').hidden = true; }, { once: true });
    $('listing-icon').src = listing.iconUrl;
    $('listing-icon').hidden = false;
  }
  $('listing-meta').hidden = false;
  $('listing-phrases').replaceChildren(...listing.phrases.map((phrase) => el('li', 'row', `“${phrase}”`)));
  $('listing-about').append(...listing.about.flatMap((part) => {
    if (!part.items) return [el('p', '', part.text)];
    const list = el('ul');
    list.append(...part.items.map((item) => el('li', '', item)));
    return [...(part.lead ? [el('p', '', part.lead)] : []), list];
  }));
  if (listing.privacyUrl) $('listing-privacy').href = listing.privacyUrl;
  if (listing.termsUrl) $('listing-terms').href = listing.termsUrl;
  $('listing-body').hidden = false;
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

$('sign-out').addEventListener('click', async () => {
  // While the link still stands, so the server forgets this browser too:
  // the next person to sign in here must not be told about this home.
  await forgetThisBrowser({ tellServer: true });
  signedOut('Not connected');
  window.location.replace(redirectUri());
});

/**
 * How the page was opened:
 *   ?code=    back from the Wick server's sign-in
 *   ?invite=  an invitation link somebody sent
 *   ?pair=    the link on a television's pairing screen
 */
/**
 * Back from Ring's sign-in. Ring sends the browser to Wick, and Wick sends it
 * here with a one-time value in the fragment (`#ring=…`). That value alone
 * connects nothing: the server finishes the link only for the organiser who
 * started it, which is whoever this page is signed in as. So a Ring sign-in
 * somebody else started, opened here, is refused and says so.
 */
async function finishRingSignIn(completion) {
  try {
    showDoorbellLink(await api('/api/ring/link/complete', { method: 'POST', body: JSON.stringify({ completion }) }));
  } catch (err) {
    assistantSays({ say: err.message, tone: err.status === 403 ? 'waiting' : 'error' });
  }
}

(async function start() {
  const params = new URLSearchParams(window.location.search);
  // Taken out of the address at once, whatever happens next: it is not
  // something to leave in the history or hand to a reload.
  const ringCompletion = new URLSearchParams(window.location.hash.slice(1)).get('ring');
  if (ringCompletion) window.history.replaceState({}, '', window.location.pathname + window.location.search);
  const invite = params.get('invite');
  const pair = params.get('pair');
  if (invite) sessionStorage.setItem('wick_invite', invite);
  if (pair) sessionStorage.setItem('wick_pair', pair);

  const code = params.get('code');
  if (code) await completeAuthIfRedirected(code);
  if (params.size > 0) window.history.replaceState({}, '', window.location.pathname);

  link = loadLink();
  // The server this page links against is the one the add-on package names;
  // a link made earlier, and a developer's own machine, keep theirs.
  const listing = await readListing();
  const listed = serverFor(listing, window.location.hostname);
  if (listed) $('server-url').value = listed;
  if (link) $('server-url').value = link.serverUrl;
  if (listing) {
    showListing(listing);
    showSuggestions(listing);
  }

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
    if (ringCompletion) await finishRingSignIn(ringCompletion);
  } catch (err) {
    if (link) assistantSays({ say: err.message, tone: 'error' });
  }
})();
