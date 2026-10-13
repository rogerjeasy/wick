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
/** Where the television's films are served from (infra/programmes.tf). */
const PROGRAMMES_ORIGIN = 'PROGRAMMES_ORIGIN_PLACEHOLDER';

/** As long as the code itself lives (services/edge-device/lambda/pairing-code.mjs). */
const PAIRING_WAIT_MS = 15 * 60 * 1000;

const pairBtn = document.getElementById('pair-btn');
const disconnectBtn = document.getElementById('disconnect-btn');
const connBadge = document.getElementById('conn-badge');
const connDetail = document.getElementById('conn-detail');
const tvScreen = document.getElementById('tv-screen');
const logEl = document.getElementById('log');
const telemetryButtons = ['fg-btn', 'bg-btn', 'play-btn', 'pause-btn', 'reach-btn'].map((id) => document.getElementById(id));

let ws = null;
let currentQueuedCard = null;
/** The film on screen (watching together): its layer, its player, and — while someone is following — the session it speaks for. */
let film = null;
const MAX_LOG_LINES = 200;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Puts one thing on the screen, over the film if one is playing — which is left where it is. */
function show(node) {
  for (const child of [...tvScreen.children]) {
    if (child !== film?.layer) child.remove();
  }
  if (node) tvScreen.appendChild(node);
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
    // Every card is drawn as it arrives: this page has no programme to wait
    // for a break in. So the card her hold brings is on screen at once, and
    // one that arrives with the id of the card already shown — who was asked,
    // written by the server onto the Reach card she pressed — takes its place.
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
    } else if (control.t === 'home') {
      // The light in the window, and who looked in: for the home screen, not a card (tv-vega home/light.ts).
      home = control.whole === true ? { ...control.home } : { ...home, ...control.home };
      if (!currentQueuedCard) renderEmpty();
    }
  }
}

function stripUndefined(patch) {
  return Object.fromEntries(
    Object.entries(patch).filter(([key, v]) => key !== 'cardId' && v !== undefined),
  );
}

/* --- Rendering -------------------------------------------------------- */

/** What the home screen is told beside its cards: her light, and who looked in (packages/contracts light.ts). */
let home = {};

/**
 * "Sarah looked in this morning." — the server's sentence, while the look is
 * still today's: until the moment the server gives, or by this browser's own
 * calendar when it gives none, as on the television (home/light.ts lookedInLine).
 */
function lookedInLine(now = Date.now()) {
  const look = home.lookedIn;
  if (!look) return null;
  const todays = typeof look.until === 'number' ? now < look.until : new Date(look.at).toDateString() === new Date(now).toDateString();
  return todays ? look.line : null;
}

/** "Light on" or "Light out" — out only for the day she put it out, which the server says the end of (home/light.ts lightLabel). */
function lightLabel(now = Date.now()) {
  if (home.light === 'out' && !(typeof home.lightOutUntil === 'number' && now >= home.lightOutUntil)) return 'Light out';
  return 'Light on';
}

function renderEmpty() {
  if (film) return show(null);
  const wrapper = el('div', 'tv-empty');
  wrapper.appendChild(el('div', undefined, 'No card currently shown.'));
  const looked = lookedInLine();
  if (looked) wrapper.appendChild(el('div', 'home-line', looked));
  if (home.light) {
    // The one button beside the films: OK opens the card that says who can see her light (HomeScreen.tsx).
    const light = el('button', 'pill', lightLabel());
    light.type = 'button';
    light.addEventListener('click', () => send({ t: 'light', at: Date.now() }));
    wrapper.appendChild(light);
  }
  show(wrapper);
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
  show(wrapper);
}

/** The Reach card's two buttons that ask (packages/contracts reach.ts REACH_ACTIONS): after either, the card stays. */
const REACH_KEEPS_CARD = ['ring_me', 'say_hello'];

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
    // What a press led to, as the television's own DoorCard shows it: whether
    // the chime rang, who was asked to look, and what they answered.
    if (card.notice) wrapper.appendChild(el('div', 'body-text notice', card.notice));
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
  } else if (card.type === 'WATCH') {
    // Watch together: the server wrote every word (mcp-server tools, edge-device watch-together.mjs).
    wrapper.appendChild(el('div', 'kicker', 'Watching together'));
    wrapper.appendChild(el('div', 'headline', card.headline));
    if (card.detail) wrapper.appendChild(el('div', 'body-text', card.detail));
  } else if (card.type === 'LIGHT') {
    // Her own light in the window: the server wrote every word (edge-device light.mjs).
    wrapper.appendChild(el('div', 'kicker', 'Your light in the window'));
    wrapper.appendChild(el('div', 'headline', card.headline));
    wrapper.appendChild(el('div', 'body-text', card.detail));
  } else if (card.type === 'REACH') {
    // Hold for Sarah: the offer her hold brings, then who was asked and what they answered.
    // The server wrote every word (edge-device reach.mjs, services/agent agents/reach).
    wrapper.appendChild(el('div', 'kicker', 'You held OK'));
    wrapper.appendChild(el('div', 'headline', card.headline));
    if (card.detail) wrapper.appendChild(el('div', 'body-text', card.detail));
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
        // "Start the film" opens it, and from here this television says where it is (cardActions.ts startsFilm).
        if (card.type === 'WATCH' && action.id === 'start' && card.programmeId) startFilm(card);
        // An answer to the family circle, to "Shall I tell …?", to anything about watching together, or about her light, finishes its card, as on the television (cardActions.ts).
        // On the card her hold brought, "Yes, ask …" and "Just say hello" leave it where it is: who was asked is
        // written onto that same card a moment later. Its other buttons finish it (cardActions.ts removesCard).
        const finishesReach = card.type === 'REACH' && !REACH_KEEPS_CARD.includes(action.id);
        if (card.type === 'CIRCLE' || card.type === 'TELL' || card.type === 'WATCH' || card.type === 'LIGHT' || finishesReach) {
          currentQueuedCard = null;
          renderEmpty();
        }
      });
      actions.appendChild(pill);
    }
    wrapper.appendChild(actions);
  }

  show(wrapper);
}

/* --- Watching together ------------------------------------------------ */

/*
 * The film, in this page, for someone with no Fire TV: the player's own
 * controls stand in for the remote. From "Start the film" this page says
 * where the film is exactly as the television does
 * (apps/tv-vega/src/watch/togetherReporter.ts, which is the tested one —
 * keep the two in step): at each change, at a skip, and every few seconds
 * while it plays; only for the film that card named, and not at all once
 * the session's time is up.
 */
const HLS_SRC = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.light.min.js';
const HLS_INTEGRITY = 'sha384-aUXIo1rkYXsnqzYlykJMPPxPku80rMufp2z0gLNU59eAyfNRhP87hllql3hwVjUZ';
const WATCH_HEARTBEAT_MS = 5000;
const SKIP_MS = 2000;
function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = HLS_SRC;
    script.integrity = HLS_INTEGRITY;
    script.crossOrigin = 'anonymous';
    script.onload = () => resolve(window.Hls);
    script.onerror = () => reject(new Error('hls.js could not be loaded'));
    document.head.appendChild(script);
  });
}

function filmState(video) {
  if (video.ended) return 'STOPPED';
  if (video.paused) return 'PAUSED';
  return video.readyState < 3 ? 'BUFFERING' : 'PLAYING';
}

function reportFilm(stopped = false) {
  const together = film?.together;
  const now = Date.now();
  if (!together || now >= together.until) return;
  const last = film.last;
  if (stopped && (!last || last.state === 'STOPPED')) return;
  const state = stopped ? 'STOPPED' : filmState(film.video);
  const positionMs = stopped ? last.positionMs : Math.round(film.video.currentTime * 1000);
  const expected = last ? last.positionMs + (last.state === 'PLAYING' ? now - last.at : 0) : 0;
  const worthSaying =
    !last || state !== last.state || Math.abs(positionMs - expected) > SKIP_MS || (state === 'PLAYING' && now - last.at >= WATCH_HEARTBEAT_MS);
  if (!worthSaying) return;
  film.last = { state, positionMs, at: now };
  send({ t: 'watch_position', sessionId: together.sessionId, state, positionMs, contentId: together.programmeId, at: now });
}

function stopFilm() {
  if (!film) return;
  reportFilm(true);
  clearInterval(film.timer);
  film.hls?.destroy();
  film.layer.remove();
  film = null;
  if (!currentQueuedCard) renderEmpty();
}

function startFilm(card) {
  stopFilm();
  // The id goes into an address: only what a programme id can be.
  if (!/^[a-z0-9-]{1,64}$/.test(card.programmeId)) return;
  const url = `${PROGRAMMES_ORIGIN}/${card.programmeId}/index.m3u8`;

  const layer = el('div', 'tv-film');
  const video = document.createElement('video');
  video.controls = true;
  video.playsInline = true;
  layer.appendChild(video);
  const back = el('button', 'pill tv-film-back', 'Back');
  back.type = 'button';
  back.addEventListener('click', stopFilm);
  layer.appendChild(back);
  // Someone follows only while the card says they can: after that the film is this television's alone.
  const followed = typeof card.followedUntil === 'number' && Date.now() < card.followedUntil;
  if (followed) layer.appendChild(el('div', 'tv-film-with', `${card.withName} is watching with you.`));
  tvScreen.insertBefore(layer, tvScreen.firstChild);

  film = {
    layer,
    video,
    hls: null,
    last: null,
    together: followed ? { sessionId: card.sessionId, programmeId: card.programmeId, until: card.followedUntil } : null,
    timer: setInterval(() => reportFilm(), 1000),
  };
  for (const type of ['play', 'pause', 'playing', 'waiting', 'seeked', 'ended']) video.addEventListener(type, () => reportFilm());

  const mine = film;
  const playNatively = () => {
    if (film === mine) video.src = url;
  };
  loadHls()
    .then((Hls) => {
      if (film !== mine) return;
      if (!Hls?.isSupported()) return playNatively();
      mine.hls = new Hls();
      mine.hls.loadSource(url);
      mine.hls.attachMedia(video);
    })
    .catch(playNatively)
    .finally(() => {
      if (film === mine) video.play().catch(() => log('!', 'press play on the film to start it'));
    });
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

// The remote. Holding OK for two seconds, anywhere in Wick, is "Hold for Sarah": the television says only that
// it was held, and is answered with the card that offers to ask someone to ring (tv-vega watch/hold.ts).
document.getElementById('reach-btn').addEventListener('click', () => send({ t: 'reach', at: Date.now() }));

pairBtn.addEventListener('click', pairAndConnect);
disconnectBtn.addEventListener('click', disconnect);
