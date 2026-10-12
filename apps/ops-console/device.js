/**
 * Virtual device — pairs against the real deployed pairing API, opens the
 * real WebSocket transport, and renders whatever cards arrive. Replaces
 * docs/SIMULATOR-TESTING-GUIDE.md §3's curl + wscat sequence with clicks.
 *
 * Placeholders below are replaced at deploy time (infra/ops-console.tf),
 * the same trick sim-alexa's index.html and this app's status.js use.
 *
 * All DOM content is built with createElement/textContent, never
 * innerHTML — card content originates from the real backend, not a user,
 * but there's no reason to reintroduce the risk class for convenience.
 */
const PAIRING_API_URL = 'PAIRING_API_URL_PLACEHOLDER';
const WEBSOCKET_URL = 'WEBSOCKET_URL_PLACEHOLDER';

/** As long as the code itself lives (services/edge-device/lambda/pairing-code.mjs). */
const PAIRING_WAIT_MS = 15 * 60 * 1000;

const pairBtn = document.getElementById('pair-btn');
const disconnectBtn = document.getElementById('disconnect-btn');
const connBadge = document.getElementById('conn-badge');
const connDetail = document.getElementById('conn-detail');
const tvScreen = document.getElementById('tv-screen');
const logEl = document.getElementById('log');
const telemetryButtons = ['fg-btn', 'bg-btn', 'play-btn', 'pause-btn'].map((id) => document.getElementById(id));

let ws = null;
let currentQueuedCard = null;
const MAX_LOG_LINES = 200;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(direction, payload) {
  const line = el('div', 'line', `${direction} ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`);
  logEl.appendChild(line);
  while (logEl.children.length > MAX_LOG_LINES) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}

function setConnBadge(state) {
  connBadge.className = `badge ${state === 'connected' ? 'ok' : state === 'connecting' ? 'warn' : 'fail'}`;
  connBadge.textContent = state;
}

function setTelemetryEnabled(enabled) {
  for (const btn of telemetryButtons) btn.disabled = !enabled;
}

/* --- Pairing -------------------------------------------------------- */

async function pairAndConnect() {
  pairBtn.disabled = true;
  setConnBadge('connecting');
  connDetail.textContent = 'requesting a pairing code…';

  try {
    const deviceId = `ops-console-${Date.now()}`;

    const startRes = await fetch(`${PAIRING_API_URL}/pair/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId }),
    });
    if (!startRes.ok) throw new Error(`pair/start: HTTP ${startRes.status}`);
    const { code, url } = await startRes.json();

    // Exactly what a real television does: show the code and wait. This page
    // used to claim its own code for a household it named itself — which is
    // the hole accounts closed. Only a household's organiser, signed in to
    // the family app, can connect a television now (pair-claim.mjs).
    renderPairingCode(code, url);
    connDetail.textContent = `showing code ${code} — enter it in the family app (“Connect a television”)`;

    let token;
    const deadline = Date.now() + PAIRING_WAIT_MS;
    while (!token && Date.now() < deadline) {
      const statusRes = await fetch(`${PAIRING_API_URL}/pair/status?code=${encodeURIComponent(code)}`);
      if (statusRes.status === 404) throw new Error('the pairing code expired');
      const data = await statusRes.json();
      if (data.status === 'bound') token = data.token;
      else await sleep(2000);
    }
    if (!token) throw new Error('nobody entered the code in time');

    connectWebSocket(token.jwt, deviceId);
  } catch (err) {
    setConnBadge('disconnected');
    connDetail.textContent = err instanceof Error ? err.message : String(err);
    pairBtn.disabled = false;
  }
}

/* --- WebSocket -------------------------------------------------------- */

function connectWebSocket(jwt, deviceId) {
  ws = new WebSocket(`${WEBSOCKET_URL}?token=${encodeURIComponent(jwt)}`);

  ws.onopen = () => {
    setConnBadge('connected');
    connDetail.textContent = `paired as ${deviceId}`;
    disconnectBtn.disabled = false;
    setTelemetryEnabled(true);
    send({ t: 'reconcile' });
  };

  ws.onmessage = (event) => {
    log('←', event.data);
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handleWireMessage(msg);
  };

  ws.onclose = () => {
    setConnBadge('disconnected');
    connDetail.textContent = 'connection closed';
    disconnectBtn.disabled = true;
    pairBtn.disabled = false;
    setTelemetryEnabled(false);
  };

  ws.onerror = () => {
    connDetail.textContent = 'connection error — see browser console';
  };
}

function send(deviceEvent) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(deviceEvent));
  log('→', deviceEvent);
}

function disconnect() {
  if (ws) ws.close();
}

/* --- Incoming messages -------------------------------------------------- */

function handleWireMessage(msg) {
  if (msg.kind === 'card') {
    currentQueuedCard = msg.card;
    renderCard(currentQueuedCard);
    send({ t: 'card_shown', cardId: currentQueuedCard.card.id, at: Date.now() });
    return;
  }

  if (msg.kind === 'control') {
    const control = msg.control;
    if (control.t === 'patch' && currentQueuedCard?.card.id === control.patch.cardId) {
      currentQueuedCard = {
        ...currentQueuedCard,
        card: { ...currentQueuedCard.card, ...stripUndefined(control.patch) },
      };
      renderCard(currentQueuedCard);
    } else if (control.t === 'revoke' && currentQueuedCard?.card.id === control.cardId) {
      currentQueuedCard = null;
      renderEmpty();
    }
  }
}

function stripUndefined(patch) {
  return Object.fromEntries(
    Object.entries(patch).filter(([key, v]) => key !== 'cardId' && v !== undefined),
  );
}

/* --- Rendering -------------------------------------------------------- */

function renderEmpty() {
  clear(tvScreen);
  tvScreen.appendChild(el('div', 'tv-empty', 'No card currently shown.'));
}

/** The unpaired screen: the code, and where to enter it (PairingScreen.tsx). */
function renderPairingCode(code, url) {
  const wrapper = el('div', 'tv-card urgency-deferred');
  wrapper.appendChild(el('div', 'kicker', 'Set up Wick'));
  wrapper.appendChild(el('div', 'headline', `${code.slice(0, 3)} ${code.slice(3)}`));
  wrapper.appendChild(el('div', 'body-text', 'In the Wick family app, choose “Connect a television” and enter this code.'));
  if (url) {
    const link = el('a', 'body-text', url);
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    wrapper.appendChild(link);
  }
  clear(tvScreen);
  tvScreen.appendChild(wrapper);
}

function renderCard(queuedCard) {
  const card = queuedCard.card;
  const urgencyClass = queuedCard.urgency === 'DOOR' ? 'urgency-door' : 'urgency-deferred';
  const wrapper = el('div', `tv-card ${urgencyClass}`);

  if (card.type === 'DOOR') {
    wrapper.appendChild(el('div', 'kicker', 'Someone is at the door'));
    wrapper.appendChild(el('div', 'headline', card.line));
    if (card.imageRef) {
      const img = el('img');
      img.src = card.imageRef;
      img.alt = 'Door camera still';
      img.style.maxHeight = '40%';
      img.style.borderRadius = 'var(--radius-md)';
      img.style.marginBottom = '0.75em';
      img.onerror = () => img.remove();
      wrapper.insertBefore(img, wrapper.firstChild);
    }
    if (card.description) wrapper.appendChild(el('div', 'body-text', card.description));
  } else if (card.type === 'MESSAGE') {
    wrapper.appendChild(el('div', 'kicker', `Message from ${card.fromName}`));
    wrapper.appendChild(el('div', 'headline', card.transcript ?? 'Tap to hear the message'));
    if (card.suggestedReplies?.length) {
      const list = el('ul', 'day-items');
      for (const reply of card.suggestedReplies) list.appendChild(el('li', undefined, reply));
      wrapper.appendChild(list);
    }
  } else if (card.type === 'WEEK') {
    wrapper.appendChild(el('div', 'kicker', `Your week — ${card.isoWeek}`));
    wrapper.appendChild(el('div', 'body-text', card.text));
  } else if (card.type === 'SHARING' || card.type === 'CIRCLE') {
    // The server wrote every word of these (sharing.mjs, accounts/circle.ts).
    wrapper.appendChild(el('div', 'kicker', card.type === 'CIRCLE' ? 'Your family circle' : 'What your family sees'));
    wrapper.appendChild(el('div', 'headline', card.headline));
    wrapper.appendChild(el('div', 'body-text', card.detail));
  } else if (card.type === 'TELL') {
    // "Shall I tell Sarah?" — the sentence shown is the one the family would be told (services/agent rhythm/tell.ts).
    wrapper.appendChild(el('div', 'kicker', 'Something is different today'));
    wrapper.appendChild(el('div', 'headline', card.headline));
    wrapper.appendChild(el('div', 'body-text', card.detail));
  } else {
    wrapper.appendChild(el('div', 'body-text', `Unrecognized card type: ${card.type}`));
  }

  if (card.actions?.length) {
    const actions = el('div', 'actions');
    for (const action of card.actions) {
      const pill = el('button', `pill ${action.kind === 'primary' ? 'primary' : ''}`, action.label);
      pill.type = 'button';
      pill.addEventListener('click', () => {
        send({ t: 'card_action', cardId: card.id, action: action.id, at: Date.now() });
        // An answer to the family circle, or to "Shall I tell …?", finishes its card, as on the television (cardActions.ts).
        if (card.type === 'CIRCLE' || card.type === 'TELL') {
          currentQueuedCard = null;
          renderEmpty();
        }
      });
      actions.appendChild(pill);
    }
    wrapper.appendChild(actions);
  }

  clear(tvScreen);
  tvScreen.appendChild(wrapper);
}

/* --- Telemetry ------------------------------------------------------- */

document.getElementById('fg-btn').addEventListener('click', () => send({ t: 'app_lifecycle', state: 'fg', at: Date.now() }));
document.getElementById('bg-btn').addEventListener('click', () => send({ t: 'app_lifecycle', state: 'bg', at: Date.now() }));
document.getElementById('play-btn').addEventListener('click', () => send({
  t: 'playback', state: 'PLAYING', positionMs: 0, durationMs: 1_500_000, contentId: 'ops-console-demo', at: Date.now(),
}));
document.getElementById('pause-btn').addEventListener('click', () => send({
  t: 'playback', state: 'PAUSED', positionMs: 60_000, durationMs: 1_500_000, contentId: 'ops-console-demo', at: Date.now(),
}));

pairBtn.addEventListener('click', pairAndConnect);
disconnectBtn.addEventListener('click', disconnect);
