/**
 * Virtual device — pairs against the real deployed pairing API, opens the
 * real WebSocket transport, and renders whatever cards arrive. Replaces
 * docs/SIMULATOR-TESTING-GUIDE.md §3's curl + wscat sequence with clicks.
 *
 * Placeholders below are replaced at deploy time (infra/ops-console.tf),
 * the same trick sim-alexa's index.html and this app's status.js use.
 *
 * Connected as a family member's own ("Mine" in the family app), it is not
 * the resident's television at all: the token it collects says
 * `kind: 'family'`, it opens no device channel and sends no device event,
 * and it shows that one member's home screen instead — asked for over HTTPS
 * from the Wick server (see "A family member's own television" below).
 *
 * All DOM content is built with createElement/textContent, never
 * innerHTML — card content originates from the real backend, not a user,
 * but there's no reason to reintroduce the risk class for convenience.
 */
const PAIRING_API_URL = 'PAIRING_API_URL_PLACEHOLDER';
const WEBSOCKET_URL = 'WEBSOCKET_URL_PLACEHOLDER';
/** Where the television's films are served from (infra/programmes.tf). */
const PROGRAMMES_ORIGIN = 'PROGRAMMES_ORIGIN_PLACEHOLDER';
/** The Wick server (infra/mcp.tf): where a family member's own television asks for its home screen. */
const WICK_SERVER_URL = 'WICK_SERVER_URL_PLACEHOLDER';

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

    // Connected as a family member's own: never the device channel, which is the resident's.
    if (token.kind === FAMILY_KIND) enterFamilyView(token.jwt, deviceId);
    else connectWebSocket(token.jwt, deviceId);
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
  if (family) leaveFamilyView('connection closed');
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
  } else if (card.type === 'VISIT') {
    // The visit, witnessed: what the door noted of a regular visitor's visit, and whether it is right.
    // The server wrote every word (services/agent agents/visit, packages/contracts visit.ts).
    wrapper.appendChild(el('div', 'kicker', 'A visit'));
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
        // "Start the film" opens it, and from here this television says where it is (cardActions.ts startsFilm).
        if (card.type === 'WATCH' && action.id === 'start' && card.programmeId) startFilm(card);
        // An answer to the family circle, to "Shall I tell …?", to anything about watching together, or about her light, finishes its card, as on the television (cardActions.ts).
        // On the card her hold brought, "Yes, ask …" and "Just say hello" leave it where it is: who was asked is
        // written onto that same card a moment later. Its other buttons finish it (cardActions.ts removesCard).
        const finishesReach = card.type === 'REACH' && !REACH_KEEPS_CARD.includes(action.id);
        // Her yes or her no to a visit is the whole of her answer: either finishes the card, as on the television.
        if (card.type === 'CIRCLE' || card.type === 'TELL' || card.type === 'WATCH' || card.type === 'LIGHT' || card.type === 'VISIT' || finishesReach) {
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

/* --- A family member's own television ---------------------------------- */

/*
 * "Sarah's television" (packages/contracts familyTelevision.ts). The member
 * connected it as theirs, so it is shown what that one member may read and
 * can give the answers that member may give — and it is never used to reach
 * the resident. Nothing here goes over the device channel: the page asks the
 * Wick server for its whole screen (GET /tv/home) and tells it of a press
 * (POST /tv/press), each time with the television's own token. The server
 * writes every word and every button; this renders them.
 *
 * It looks when the view opens and then every few seconds while the tab can
 * be seen — never two requests at once — and nothing on the screen goes away
 * by itself: a card stays until it is answered, put away, or the server no
 * longer lists it.
 */
const FAMILY_KIND = 'family';
/** packages/contracts FAMILY_TV_LOOK_EVERY_MS. */
const FAMILY_LOOK_EVERY_MS = 8000;
/** A card holds at most three answers (packages/contracts card.ts); a fourth is never drawn. */
const FAMILY_MAX_ACTIONS = 3;

/** The family view while it is open: the token, what the server last said, and what was put away here. */
let family = null;

const isText = (value) => typeof value === 'string' && value.length > 0;

/** Only what the contract says a home screen is; anything else is left unread. */
function readFamilyHome(body) {
  if (!body || !isText(body.residentName) || !isText(body.memberName) || !Array.isArray(body.cards)) return null;
  return body;
}

/** A picture is shown only from an https address — and only ever as a picture. */
function httpsUrl(value) {
  if (!isText(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** What a card says, so one put away comes back when the server changes it. */
const cardSignature = (card) => JSON.stringify([card.headline, card.detail, card.pictureUrl, card.actions]);

function enterFamilyView(jwt, deviceId) {
  family = {
    jwt,
    deviceId,
    /** The server's last home screen, the sentence that answered a press, and the cards put away here (id → what each said). */
    home: null,
    said: null,
    putAway: new Map(),
    /** The card whose press did not arrive, if any. */
    notSent: null,
    /** The look that is out, if one is: there is never a second, and a press waits for it. */
    looking: null,
    pressing: false,
    /** What was last logged and last drawn, so the same answer is neither logged nor redrawn every few seconds. */
    lastSeen: '',
    drawn: '',
    timer: null,
  };
  setConnBadge('connected');
  connDetail.textContent = `paired as ${deviceId} — a family member’s own television`;
  disconnectBtn.disabled = false;
  // The telemetry buttons send device events. This television sends none: they stay off.
  setTelemetryEnabled(false);
  show(el('div', 'tv-empty', 'One moment.'));
  family.timer = setInterval(() => void lookAtFamilyHome(), FAMILY_LOOK_EVERY_MS);
  document.addEventListener('visibilitychange', lookWhenSeenAgain);
  void lookAtFamilyHome();
}

/** Stops looking. What the screen then says is the caller's to decide. */
function stopFamilyView() {
  if (!family) return;
  clearInterval(family.timer);
  document.removeEventListener('visibilitychange', lookWhenSeenAgain);
  family = null;
}

function leaveFamilyView(detail) {
  stopFamilyView();
  setConnBadge('disconnected');
  connDetail.textContent = detail;
  disconnectBtn.disabled = true;
  pairBtn.disabled = false;
  show(el('div', 'tv-empty', 'Not connected. Press “Pair & connect” to pair again.'));
}

function lookWhenSeenAgain() {
  if (!document.hidden) void lookAtFamilyHome();
}

/** One request to the Wick server as this television. Never the device channel. */
function familyFetch(path, init = {}) {
  return fetch(`${WICK_SERVER_URL}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${family.jwt}` },
  });
}

/**
 * What a refusal means for the screen. 401: the television was disconnected,
 * and can be paired again. 403: the resident does not (or no longer) allow
 * this member — the server's own sentence, and nothing else; it goes on
 * looking, because that can change. True when the answer was one of those.
 */
async function familyRefused(res) {
  if (res.status === 401) {
    stopFamilyView();
    setConnBadge('disconnected');
    connDetail.textContent = 'no longer connected';
    disconnectBtn.disabled = true;
    pairBtn.disabled = false;
    renderFamilyNoLongerConnected();
    return true;
  }
  if (res.status === 403) {
    const mine = family;
    const body = await res.json().catch(() => null);
    if (family !== mine) return true;
    const sentence = isText(body?.say) ? body.say : 'There is nothing to show on this television just now.';
    if (mine.lastSeen !== `403 ${sentence}`) log('←', { status: 403, say: sentence });
    mine.lastSeen = `403 ${sentence}`;
    mine.home = null;
    mine.said = null;
    mine.notSent = null;
    mine.putAway.clear();
    renderFamilySentence(sentence);
    return true;
  }
  return false;
}

/** Asks for the home screen. Not while the tab is hidden, and never while another request is out. */
function lookAtFamilyHome() {
  const mine = family;
  if (!mine || mine.looking || mine.pressing || document.hidden) return Promise.resolve();
  mine.looking = lookOnce(mine).finally(() => {
    mine.looking = null;
  });
  return mine.looking;
}

async function lookOnce(mine) {
  try {
    const res = await familyFetch('/tv/home');
    if (family !== mine) return;
    if (await familyRefused(res)) return;
    if (!res.ok) throw new Error(`tv/home: HTTP ${res.status}`);
    const home = readFamilyHome(await res.json());
    if (family !== mine) return;
    if (!home) throw new Error('tv/home: not a home screen');
    // Said in the log only when it changes: the same answer every few seconds is not news.
    const seen = JSON.stringify(home);
    if (seen !== mine.lastSeen) log('←', home);
    mine.lastSeen = seen;
    mine.home = home;
    // A card no longer listed is forgotten, so the same id can be shown again another day.
    for (const id of [...mine.putAway.keys()]) {
      if (!home.cards.some((card) => card?.id === id)) mine.putAway.delete(id);
    }
    renderFamily();
  } catch (err) {
    // What is on the screen stays; the next look may fare better.
    if (family === mine) log('!', err instanceof Error ? err.message : String(err));
  }
}

/** The member's press on a card: told to the server, whose one sentence takes the card's place. */
async function pressFamilyCard(card, action) {
  const mine = family;
  if (!mine || mine.pressing) return;
  mine.pressing = true;
  mine.notSent = null;
  renderFamily();
  let again = false;
  try {
    // One request at a time: a look already out is let finish first.
    if (mine.looking) await mine.looking;
    if (family !== mine) return;
    const press = { cardId: card.id, action: action.id };
    log('→', press);
    const res = await familyFetch('/tv/press', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(press),
    });
    if (family !== mine) return;
    if (await familyRefused(res)) return;
    const body = await res.json().catch(() => null);
    if (family !== mine) return;
    if (!res.ok || !isText(body?.say)) throw new Error(`tv/press: HTTP ${res.status}`);
    log('←', body);
    mine.said = { say: body.say };
    again = true;
  } catch (err) {
    if (family !== mine) return;
    log('!', err instanceof Error ? err.message : String(err));
    // The card stays where it is, with its buttons, and says only that the press did not arrive.
    mine.notSent = card.id;
  } finally {
    mine.pressing = false;
  }
  if (family !== mine) return;
  renderFamily();
  if (again) void lookAtFamilyHome();
}

/** The first card still to be seen: not one put away here, unless the server has since changed it. */
function familyCardToShow(home) {
  return home.cards.find((card) => card && isText(card.id) && isText(card.headline) && family.putAway.get(card.id) !== cardSignature(card));
}

function familyButton(label, primary, onPress) {
  const pill = el('button', `pill ${primary ? 'primary' : ''}`, label);
  pill.type = 'button';
  pill.disabled = family?.pressing === true;
  pill.addEventListener('click', onPress);
  return pill;
}

/** The whole family screen, from what the server last said. Drawn again only when something on it has changed. */
function renderFamily() {
  const home = family?.home;
  if (!home) return;
  if (family.notSent && family.said) family.notSent = null;
  const drawn = JSON.stringify([home, family.said, [...family.putAway], family.pressing, family.notSent]);
  if (drawn === family.drawn) return;
  family.drawn = drawn;
  const said = family.said;
  const card = said ? null : familyCardToShow(home);
  // With something waiting, the home's own lines step back and the card has the room.
  const wrapper = el('div', `tv-card tv-family ${said || card ? 'has-card' : ''}`);
  const head = el('div', 'family-head');
  head.appendChild(el('div', 'headline', `${home.residentName}’s home`));
  head.appendChild(el('div', 'body-text', `This is ${home.memberName}’s television.`));
  // Her light in the window, in the server's one sentence — absent when she keeps her day to herself.
  if (isText(home.light?.line)) head.appendChild(el('div', 'body-text family-light', home.light.line));
  // A demo home's history was written, not lived: said wherever the home is named.
  if (home.simulated === true) head.appendChild(el('div', 'family-demo', 'This is a demo home. Its history is simulated.'));
  wrapper.appendChild(head);

  if (said) {
    // The answer to a press, in place of the card, until it is put away by hand.
    const panel = el('div', 'family-card');
    panel.appendChild(el('div', 'headline', said.say));
    const actions = el('div', 'actions');
    actions.appendChild(familyButton('All right', true, () => {
      family.said = null;
      renderFamily();
    }));
    panel.appendChild(actions);
    wrapper.appendChild(panel);
  } else if (card) {
    const shown = el('div', 'family-card');
    const picture = httpsUrl(card.pictureUrl);
    if (picture) {
      // Beside the words, so the answers stay on the screen with it.
      const img = el('img', 'family-picture');
      img.alt = 'The picture from the door';
      img.onerror = () => {
        img.remove();
        shown.classList.remove('with-picture');
      };
      img.src = picture;
      shown.classList.add('with-picture');
      shown.appendChild(img);
    }
    const panel = el('div', 'family-words');
    shown.appendChild(panel);
    panel.appendChild(el('div', 'headline', card.headline));
    if (isText(card.detail)) panel.appendChild(el('div', 'body-text', card.detail));
    const actions = el('div', 'actions');
    const offered = (Array.isArray(card.actions) ? card.actions : []).filter((action) => action && isText(action.id) && isText(action.label)).slice(0, FAMILY_MAX_ACTIONS);
    for (const action of offered) {
      actions.appendChild(familyButton(action.label, action.kind === 'primary', () => void pressFamilyCard(card, action)));
    }
    if (offered.length === 0) {
      // A card that only says how something stands: put away here, and only here, until the server changes it.
      actions.appendChild(familyButton('All right', true, () => {
        family.putAway.set(card.id, cardSignature(card));
        renderFamily();
      }));
    }
    panel.appendChild(actions);
    if (family.notSent === card.id) panel.appendChild(el('div', 'body-text', 'That could not be sent just now. Try again in a moment.'));
    wrapper.appendChild(shown);
  } else {
    wrapper.appendChild(el('div', 'body-text family-quiet', 'Nothing is waiting for you.'));
  }

  show(wrapper);
}

/** One sentence and nothing else: the resident does not, or no longer, allow this member. */
function renderFamilySentence(sentence) {
  if (family) family.drawn = '';
  const wrapper = el('div', 'tv-card tv-family');
  wrapper.appendChild(el('div', 'headline', sentence));
  show(wrapper);
}

function renderFamilyNoLongerConnected() {
  const wrapper = el('div', 'tv-card tv-family');
  wrapper.appendChild(el('div', 'headline', 'This television is no longer connected.'));
  const actions = el('div', 'actions');
  const again = el('button', 'pill primary', 'Pair again');
  again.type = 'button';
  again.addEventListener('click', pairAndConnect);
  actions.appendChild(again);
  wrapper.appendChild(actions);
  show(wrapper);
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
