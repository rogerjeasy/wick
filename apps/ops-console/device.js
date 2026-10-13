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
 * from the Wick server (see "A family member's own television" below): what
 * is waiting for them, her week to read, a wave, and the seat beside a film.
 *
 * As the resident's television it speaks her language (packages/contracts
 * language.ts), as the television app does: the language comes from the
 * `home` message and from nowhere else, this page's own few words are said
 * in it (TV_WORDS below), and everything on a card is the server's and comes
 * already in it. A family member's own television stays English.
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
    // A new connection learns the home's language afresh, with the cards it is sent.
    languageKnown = false;
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
    // A card of a kind this page does not know is dropped: not drawn, not said to have been shown, and never in
    // the place of the card that is on screen. Its buttons would be live with nothing to say what they do.
    if (!isKnownCard(msg.card)) {
      log('!', `a card of a kind this television does not know was not shown (${String(msg.card?.card?.type)})`);
      return;
    }
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
      // The light in the window, who looked in, and the language she chose: for the home screen, not a card
      // (tv-vega home/light.ts, headless/QueueStore.ts setHome).
      const before = tvLanguage();
      home = control.whole === true ? { ...control.home } : { ...home, ...control.home };
      // Only the whole of a home, or a part that names a language, says what the language is.
      const saysLanguage = control.whole === true || control.home?.language !== undefined;
      const differs = tvLanguage() !== before;
      const changed = saysLanguage && languageKnown && differs;
      if (saysLanguage) languageKnown = true;
      if (!currentQueuedCard) renderEmpty();
      // This page's own words on the card that is on screen follow the language at once.
      else if (differs) renderCard(currentQueuedCard);
      // The cards the server holds for this television are asked for again, once, so they come in the language she
      // has now — the request made on connecting (tv-vega transport/startCardChannel.ts). Learning the language of
      // a home just connected to is not a change: its cards are on their way in that language already.
      if (changed) send({ t: 'reconcile' });
    }
  }
}

function stripUndefined(patch) {
  return Object.fromEntries(
    Object.entries(patch).filter(([key, v]) => key !== 'cardId' && v !== undefined),
  );
}

/* --- The television's own words --------------------------------------- */

/** packages/contracts language.ts LANGUAGES. */
const TV_LANGUAGES = ['en', 'es'];

/**
 * The few words on the resident's screen that are this page's own, in each
 * language a household can choose — what apps/tv-vega/src/words/words.ts is
 * to the television app, and where the two say the same thing they say it
 * in the same words (__tests__/device.test.ts holds them to it). English is
 * what this page said before there was a table. Spanish is written by hand:
 * plain, to usted, and with no sentence that would have to agree with a
 * name's gender. A value is named in braces.
 *
 * Everything else on a card is the server's, and comes in her language. The
 * pairing screen, the page around the television and a family member's own
 * television are not in this table: they stay English.
 */
const TV_WORDS = {
  en: {
    empty: 'No card currently shown.',
    lightOn: 'Light on',
    lightOut: 'Light out',
    door: 'Someone is at the door',
    doorPicture: 'Door camera still',
    message: 'Message from {name}',
    messageUnheard: 'Tap to hear the message',
    week: 'Your week — {week}',
    circle: 'Your family circle',
    sharing: 'What your family sees',
    tell: 'Something is different today',
    watch: 'Watching together',
    light: 'Your light in the window',
    reach: 'You held OK',
    visit: 'A visit',
    filmBack: 'Back',
    filmWith: '{name} is watching with you.',
  },
  es: {
    empty: 'No hay ninguna tarjeta en pantalla.',
    lightOn: 'Luz encendida',
    lightOut: 'Luz apagada',
    door: 'Hay alguien en la puerta',
    doorPicture: 'Imagen fija de la cámara de la puerta',
    message: 'Mensaje de {name}',
    messageUnheard: 'Toque para oír el mensaje',
    week: 'Su semana — {week}',
    circle: 'Su círculo familiar',
    sharing: 'Lo que ve su familia',
    tell: 'Hoy hay algo distinto',
    watch: 'Una película en compañía',
    light: 'Su luz en la ventana',
    reach: 'Mantuvo presionado OK',
    visit: 'Una visita',
    filmBack: 'Atrás',
    filmWith: '{name} ve la película con usted.',
  },
};

/**
 * Over the question that asks which language: each language by its own name
 * (packages/contracts language.ts LANGUAGE_NAMES), so it reads the same
 * whichever of them she reads.
 */
const TV_LANGUAGE_KICKER = 'English · español';

/** Whether the language has been told on this connection yet: until it has, being told is learning it, not a change. */
let languageKnown = false;

/** The language her television speaks: what the home says, and English when it names none — or one this page has no words in. */
function tvLanguage() {
  return TV_LANGUAGES.includes(home.language) ? home.language : 'en';
}

/** One of this page's own sentences, in her language, with what it names put in. */
function tvSay(key, values = {}) {
  const sentence = TV_WORDS[tvLanguage()][key] ?? TV_WORDS.en[key];
  return sentence.replace(/\{(\w+)\}/g, (place, name) => (Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : place));
}

/** The kinds of card this page can draw (packages/contracts card.ts `Card`; tv-vega cards/knownCards.ts). */
const TV_CARD_TYPES = ['DOOR', 'MESSAGE', 'WEEK', 'SHARING', 'CIRCLE', 'TELL', 'WATCH', 'LIGHT', 'REACH', 'VISIT', 'LANGUAGE'];

/** Whether this is a card, of a kind this page has a drawing for. Anything else is dropped, never drawn. */
function isKnownCard(queued) {
  return typeof queued?.card?.id === 'string' && TV_CARD_TYPES.includes(queued.card.type);
}

/* --- Rendering -------------------------------------------------------- */

/** What the home screen is told beside its cards: her light, who looked in, and her language (packages/contracts light.ts). */
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

/** "Light on" or "Light out", in her language — out only for the day she put it out, which the server says the end of (home/light.ts lightLabel). */
function lightLabel(now = Date.now()) {
  if (home.light === 'out' && !(typeof home.lightOutUntil === 'number' && now >= home.lightOutUntil)) return tvSay('lightOut');
  return tvSay('lightOn');
}

function renderEmpty() {
  if (film) return show(null);
  const wrapper = el('div', 'tv-empty');
  wrapper.appendChild(el('div', undefined, tvSay('empty')));
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
  // Never a card of a kind this page does not know: there is nothing to draw, so its buttons are not drawn either.
  if (!isKnownCard(queuedCard)) return;
  const card = queuedCard.card;
  const urgencyClass = queuedCard.urgency === 'DOOR' ? 'urgency-door' : 'urgency-deferred';
  const wrapper = el('div', `tv-card ${urgencyClass}`);

  if (card.type === 'DOOR') {
    wrapper.appendChild(el('div', 'kicker', tvSay('door')));
    wrapper.appendChild(el('div', 'headline', card.line));
    if (card.imageRef) {
      const img = el('img');
      img.src = card.imageRef;
      img.alt = tvSay('doorPicture');
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
    wrapper.appendChild(el('div', 'kicker', tvSay('message', { name: card.fromName })));
    wrapper.appendChild(el('div', 'headline', card.transcript ?? tvSay('messageUnheard')));
    if (card.suggestedReplies?.length) {
      const list = el('ul', 'day-items');
      for (const reply of card.suggestedReplies) list.appendChild(el('li', undefined, reply));
      wrapper.appendChild(list);
    }
  } else if (card.type === 'WEEK') {
    wrapper.appendChild(el('div', 'kicker', tvSay('week', { week: card.isoWeek })));
    wrapper.appendChild(el('div', 'body-text', card.text));
  } else if (card.type === 'SHARING' || card.type === 'CIRCLE') {
    // The server wrote every word of these (sharing.mjs, accounts/circle.ts).
    wrapper.appendChild(el('div', 'kicker', tvSay(card.type === 'CIRCLE' ? 'circle' : 'sharing')));
    wrapper.appendChild(el('div', 'headline', card.headline));
    wrapper.appendChild(el('div', 'body-text', card.detail));
  } else if (card.type === 'TELL') {
    // "Shall I tell Sarah?" — the sentence shown is the one the family would be told (services/agent rhythm/tell.ts).
    wrapper.appendChild(el('div', 'kicker', tvSay('tell')));
    wrapper.appendChild(el('div', 'headline', card.headline));
    wrapper.appendChild(el('div', 'body-text', card.detail));
  } else if (card.type === 'WATCH') {
    // Watch together: the server wrote every word (mcp-server tools, edge-device watch-together.mjs).
    wrapper.appendChild(el('div', 'kicker', tvSay('watch')));
    wrapper.appendChild(el('div', 'headline', card.headline));
    if (card.detail) wrapper.appendChild(el('div', 'body-text', card.detail));
  } else if (card.type === 'LIGHT') {
    // Her own light in the window: the server wrote every word (edge-device light.mjs).
    wrapper.appendChild(el('div', 'kicker', tvSay('light')));
    wrapper.appendChild(el('div', 'headline', card.headline));
    wrapper.appendChild(el('div', 'body-text', card.detail));
  } else if (card.type === 'REACH') {
    // Hold for Sarah: the offer her hold brings, then who was asked and what they answered.
    // The server wrote every word (edge-device reach.mjs, services/agent agents/reach).
    wrapper.appendChild(el('div', 'kicker', tvSay('reach')));
    wrapper.appendChild(el('div', 'headline', card.headline));
    if (card.detail) wrapper.appendChild(el('div', 'body-text', card.detail));
  } else if (card.type === 'VISIT') {
    // The visit, witnessed: what the door noted of a regular visitor's visit, and whether it is right.
    // The server wrote every word (services/agent agents/visit, packages/contracts visit.ts).
    wrapper.appendChild(el('div', 'kicker', tvSay('visit')));
    wrapper.appendChild(el('div', 'headline', card.headline));
    wrapper.appendChild(el('div', 'body-text', card.detail));
  } else if (card.type === 'LANGUAGE') {
    // The television speaks her language: the organiser has asked for another, and it is put to her in both at
    // once. The server wrote every word (packages/contracts language.ts languageQuestion) — the question and the
    // first button in the language asked for — so nothing here is from this page's own table but the two names.
    wrapper.appendChild(el('div', 'kicker', TV_LANGUAGE_KICKER));
    wrapper.appendChild(el('div', 'headline', card.headline));
    wrapper.appendChild(el('div', 'body-text', card.detail));
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
        // So does her yes or her no to another language: what a yes changes comes afterwards, on the home message.
        if (card.type === 'CIRCLE' || card.type === 'TELL' || card.type === 'WATCH' || card.type === 'LIGHT' || card.type === 'VISIT' || card.type === 'LANGUAGE' || finishesReach) {
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
  const back = el('button', 'pill tv-film-back', tvSay('filmBack'));
  back.type = 'button';
  back.addEventListener('click', stopFilm);
  layer.appendChild(back);
  // Someone follows only while the card says they can: after that the film is this television's alone.
  const followed = typeof card.followedUntil === 'number' && Date.now() < card.followedUntil;
  if (followed) layer.appendChild(el('div', 'tv-film-with', tvSay('filmWith', { name: card.withName })));
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
 * Wick server for its whole screen (GET /tv/home), tells it of a press
 * (POST /tv/press) and, in the seat beside her film, asks where the film is
 * (GET /tv/seat), each time with the television's own token. The server
 * writes every word and every button; this renders them.
 *
 * It looks when the view opens and then every few seconds while the tab can
 * be seen — never two requests at once — and nothing on the screen goes away
 * by itself: a card stays until it is answered, put away, or the server no
 * longer lists it.
 *
 * Three buttons the television answers itself, sending nothing (the
 * contract's FAMILY_TV_OWN_ACTIONS): "later" puts a card away on this
 * screen, "read" opens its pages, "seat" opens the seat. The keyboard is the
 * remote here: the arrows move between buttons (and turn a page), Enter is
 * OK, Escape or Backspace is Back.
 */
const FAMILY_KIND = 'family';
/** packages/contracts FAMILY_TV_LOOK_EVERY_MS. */
const FAMILY_LOOK_EVERY_MS = 8000;
/** packages/contracts FAMILY_TV_SEAT_EVERY_MS: a pause of hers is followed within a breath. */
const FAMILY_SEAT_EVERY_MS = 2000;
/** A card holds at most three answers (packages/contracts card.ts); a fourth is never drawn. */
const FAMILY_MAX_ACTIONS = 3;
/** packages/contracts FAMILY_TV_CARD_KINDS. A card of any other kind is not drawn. */
const FAMILY_CARD_KINDS = ['door_look', 'reach', 'watch', 'wave', 'week'];
/** packages/contracts FAMILY_TV_OWN_ACTIONS: buttons this television answers itself and never sends. */
const FAMILY_OWN = { read: 'ftv-read', later: 'ftv-later', seat: 'ftv-seat' };
/** packages/contracts FAMILY_TV_PRESSES: what it sends beside the answers to her questions. */
const FAMILY_PRESS = { sit: 'sit', wave: 'wave', read: 'read', seen: 'seen' };
/**
 * More pages than this, or a page longer than this, is not something to read
 * a screenful at a time — and it is not read at all, rather than shown in
 * part and then called read. A page is a card's worth of words
 * (MAX_CARD_DETAIL_CHARS is 240); twice that still fits the screen. Twelve
 * pages is the most the server writes of a week — its prose, then its days
 * — and the most the television's own app reads.
 */
const FAMILY_MAX_PAGES = 12;
const FAMILY_MAX_PAGE_CHARS = 480;
/** A page of more than a card's worth of words is set a size smaller, so the page and its buttons stay on one screen. */
const FAMILY_FULL_PAGE_CHARS = 240;
const FAMILY_SEAT_STATES = ['waiting', 'watching', 'asked', 'over'];
const FAMILY_PLAYBACK_STATES = ['PLAYING', 'PAUSED', 'STOPPED', 'WAITING'];

/** The family view while it is open: the token, what the server last said, and what was put away here. */
let family = null;

const isText = (value) => typeof value === 'string' && value.length > 0;
const textOrNull = (value) => (isText(value) ? value : null);

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

/**
 * What pressing a button does, from its id alone:
 *
 *   'later' | 'read' | 'seat'   the television's own — nothing is sent;
 *   'quiet'                     sent, and nothing is shown in answer;
 *   'sit'                       sent, and when it is done the seat opens;
 *   'say'                       sent, and the server's one sentence is shown.
 */
function familyPressKind(actionId) {
  if (actionId === FAMILY_OWN.later) return 'later';
  if (actionId === FAMILY_OWN.read) return 'read';
  if (actionId === FAMILY_OWN.seat) return 'seat';
  if (actionId === FAMILY_PRESS.read || actionId === FAMILY_PRESS.seen) return 'quiet';
  if (actionId === FAMILY_PRESS.sit) return 'sit';
  return 'say';
}

/** The buttons of a card, or the answers at the credits: only what is a button, and never a fourth. */
function readFamilyActions(actions) {
  return (Array.isArray(actions) ? actions : [])
    .filter((action) => action && isText(action.id) && isText(action.label))
    .map((action) => ({ id: action.id, label: action.label, primary: action.kind === 'primary' }));
}

/** Something to read, a screenful at a time — or nothing, when it is not exactly that. */
function readFamilyPages(pages) {
  if (!Array.isArray(pages) || pages.length === 0 || pages.length > FAMILY_MAX_PAGES) return null;
  const readable = pages.every((page) => isText(page) && page.trim().length > 0 && page.length <= FAMILY_MAX_PAGE_CHARS);
  return readable ? [...pages] : null;
}

/** One card, or null for anything the contract does not call one: it is then not drawn at all. */
function readFamilyCard(card) {
  if (!card || !isText(card.id) || !isText(card.headline) || !FAMILY_CARD_KINDS.includes(card.kind)) return null;
  const pages = readFamilyPages(card.pages);
  return {
    id: card.id,
    kind: card.kind,
    headline: card.headline,
    detail: textOrNull(card.detail),
    pictureUrl: httpsUrl(card.pictureUrl),
    pages,
    // A button that opens pages is only drawn when there are pages to open.
    actions: readFamilyActions(card.actions).filter((action) => pages || action.id !== FAMILY_OWN.read).slice(0, FAMILY_MAX_ACTIONS),
  };
}

/**
 * The wave: a button while one can be sent (`cardId`), and the sentence that
 * says how the last one stands (`line`). Null when it is neither, or is
 * pressed on something that is not a wave.
 */
function readFamilyWave(wave) {
  if (!wave || typeof wave !== 'object' || !isText(wave.label)) return null;
  if (wave.cardId !== undefined && !(isText(wave.cardId) && /^ftv-wave-[A-Za-z0-9_-]+$/.test(wave.cardId))) return null;
  if (wave.line !== undefined && !isText(wave.line)) return null;
  if (wave.cardId === undefined && wave.line === undefined) return null;
  return { label: wave.label, cardId: wave.cardId ?? null, line: wave.line ?? null };
}

/** Only what the contract says a home screen is; anything else is left unread, and a card that is not one is dropped. */
function readFamilyHome(body) {
  if (!body || !isText(body.residentName) || !isText(body.memberName) || !Array.isArray(body.cards)) return null;
  return {
    residentName: body.residentName,
    memberName: body.memberName,
    // Her light in the window is one sentence; whether it is lit is in the sentence.
    light: isText(body.light?.line) ? { line: body.light.line } : null,
    cards: body.cards.map(readFamilyCard).filter(Boolean),
    wave: readFamilyWave(body.wave),
    simulated: body.simulated === true,
  };
}

/** A film is played only from an https address, or from this machine (a stand-in server). The address is put in a <video>. */
const familyStreamUrl = (value) =>
  typeof value === 'string' && /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/)[^\s"'<>]+$/.test(value) ? value : null;

function readFamilyStream(stream) {
  const url = familyStreamUrl(stream?.url);
  if (!url) return null;
  return { url, durationMs: Number.isFinite(stream.durationMs) ? stream.durationMs : 0, attribution: typeof stream.attribution === 'string' ? stream.attribution : '' };
}

function readFamilyPlayback(playback) {
  if (!playback || !FAMILY_PLAYBACK_STATES.includes(playback.state)) return null;
  if (!Number.isFinite(playback.positionMs) || !Number.isFinite(playback.ageMs)) return null;
  return { state: playback.state, positionMs: playback.positionMs, ageMs: playback.ageMs };
}

/**
 * What GET /tv/seat answered: `{ seat: null }` when there is no seat (no
 * film, or it is over and gone), the seat when there is one — and null when
 * the answer cannot be read, which is not the same as the film being over.
 */
function readFamilySeat(body) {
  if (!body || typeof body !== 'object') return null;
  const seat = body.seat;
  if (seat === undefined || seat === null) return { seat: null };
  if (typeof seat !== 'object' || !isText(seat.cardId) || !isText(seat.line) || !FAMILY_SEAT_STATES.includes(seat.state)) return null;
  return {
    seat: {
      cardId: seat.cardId,
      state: seat.state,
      line: seat.line,
      stream: readFamilyStream(seat.stream),
      playback: readFamilyPlayback(seat.playback),
      question: textOrNull(seat.question),
      answers: readFamilyActions(seat.answers).slice(0, FAMILY_MAX_ACTIONS),
      yourAnswer: textOrNull(seat.yourAnswer),
      theirAnswer: textOrNull(seat.theirAnswer),
    },
  };
}

/** Said when a press did not arrive. The television's own sentence: there is no answer of the server's to show. */
const FAMILY_NOT_SENT = 'That could not be sent just now. Try again in a moment.';

/**
 * What the seat shows once an answer at the credits has been pressed (as the
 * television's own app does, apps/tv-vega family/seat.ts):
 *
 *   - taken (`done`): nothing extra. The answers go, the seat stays open,
 *     and its own line — the server's — says what was said, and then what
 *     she said;
 *   - not taken: the server's sentence, to be put away by hand, and the
 *     question is still there to answer;
 *   - not arrived: this television's own sentence, the same way.
 *
 * @param {{arrived: boolean, done?: boolean, say?: string | null}} outcome
 * @returns {{answered: boolean, said: string | null}}
 */
function familySeatAfterPress(outcome) {
  if (!outcome.arrived) return { answered: false, said: FAMILY_NOT_SENT };
  if (outcome.done) return { answered: true, said: null };
  return { answered: false, said: outcome.say ?? null };
}

/** Said over the seat when something on the home screen waits for an answer. It says nothing of what: Back shows it. */
const FAMILY_WAITING_LINE = 'Something is waiting for you. Press Back to see it.';

/**
 * Whether a card on the home screen waits for an answer while this
 * television is in the seat beside a film: it has a button that is not the
 * television's own — an answer to give — and it is not that film's own card
 * (`filmCardId`; null before the seat knows which film it is beside).
 * Something only to read, to put away or to sit down to again can wait
 * until the film is over without anybody being told.
 */
function familyCardWaits(card, filmCardId) {
  if (!card || card.id === filmCardId) return false;
  return card.actions.some((action) => !Object.values(FAMILY_OWN).includes(action.id));
}

/** Further than this from where her film is, and this television jumps to it. */
const FAMILY_FOLLOW_DRIFT_MS = 2500;
/** A paused picture is held to within this of hers. */
const FAMILY_FOLLOW_STILL_MS = 500;

/**
 * Where this television should be, given where hers is. The family app's own
 * rule (apps/sim-alexa surface.js `follow` — keep the two in step): it plays
 * when hers plays, is still when hers is, and jumps only when it is more
 * than a couple of seconds from where hers has got to.
 *
 * @param {{state: string, positionMs: number, ageMs: number} | null} playback  where her film was, and how long before the server's answer
 * @param {number} sinceMs  how long ago that answer arrived here
 * @param {{positionMs: number, paused: boolean}} player  this television's own player
 * @param {number} [durationMs]
 * @returns {{play: boolean, seekToMs: number | null}}  whether to be playing, and where to jump to (null: stay)
 */
function familyFollow(playback, sinceMs, player, durationMs = 0) {
  if (!playback || playback.state === 'STOPPED') return { play: false, seekToMs: null };
  const playing = playback.state === 'PLAYING';
  const moved = playing ? playback.ageMs + sinceMs : 0;
  const target = durationMs > 0 ? Math.min(playback.positionMs + moved, durationMs) : playback.positionMs + moved;
  const off = Math.abs(player.positionMs - target);
  return { play: playing, seekToMs: off > (playing ? FAMILY_FOLLOW_DRIFT_MS : FAMILY_FOLLOW_STILL_MS) ? target : null };
}

/**
 * The reader, one page at a time. Turning a page never leaves it; leaving it
 * ('close') counts as having read only from the last page.
 *
 * @param {'next' | 'back' | 'close'} move
 * @returns {{index: number} | {leave: true, read: boolean}}
 */
function turnFamilyPage(index, count, move) {
  if (move === 'close') return { leave: true, read: index >= count - 1 };
  if (move === 'next') return { index: Math.min(index + 1, count - 1) };
  return { index: Math.max(index - 1, 0) };
}

/** Where the reader is, in words. */
function familyPageLine(index, count) {
  return `Page ${index + 1} of ${count}`;
}

/** What a card says, so one put away comes back when the server changes it. */
const cardSignature = (card) => JSON.stringify([card.headline, card.detail, card.pictureUrl, card.pages, card.actions]);

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
    /** The look that is out, if one is: there is never a second. */
    looking: null,
    pressing: false,
    /** The last thing asked of the Wick server. The next waits for it: one request at a time, whatever is asking. */
    turn: Promise.resolve(),
    /** What was last logged and last drawn, so the same answer is neither logged nor redrawn every few seconds. */
    lastSeen: '',
    drawn: '',
    timer: null,
    /** Something being read: the card, its pages, and the page it is open at. */
    reader: null,
    /** The seat beside her film, while this television is in it (openFamilySeat). */
    seat: null,
  };
  setConnBadge('connected');
  connDetail.textContent = `paired as ${deviceId} — a family member’s own television`;
  disconnectBtn.disabled = false;
  // The telemetry buttons send device events. This television sends none: they stay off.
  setTelemetryEnabled(false);
  show(el('div', 'tv-empty', 'One moment.'));
  family.timer = setInterval(() => void lookAtFamilyHome(), FAMILY_LOOK_EVERY_MS);
  document.addEventListener('visibilitychange', lookWhenSeenAgain);
  document.addEventListener('keydown', familyKey);
  void lookAtFamilyHome();
}

/** Stops looking. What the screen then says is the caller's to decide. */
function stopFamilyView() {
  if (!family) return;
  closeFamilySeat(family);
  clearInterval(family.timer);
  document.removeEventListener('visibilitychange', lookWhenSeenAgain);
  document.removeEventListener('keydown', familyKey);
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
  if (document.hidden) return;
  if (family?.seat) void lookAtFamilySeat();
  else void lookAtFamilyHome();
}

/** What a request that was never sent fails with: nobody was waiting for its answer any more. Not worth a line in the log. */
const FAMILY_NOT_ASKED = new Error('not asked');

/**
 * One request to the Wick server as this television — never the device
 * channel — and never two at once: each waits its turn behind the last, be
 * it a look at the home screen, a look at the seat or a press. A request
 * whose turn comes after the television has stopped being a family
 * television, or (`still`) after what asked it has gone, is not sent.
 *
 * @returns {Promise<{status: number, ok: boolean, body: unknown}>}
 */
function familyAsk(mine, path, init = {}, still = () => true) {
  const ask = async () => {
    if (family !== mine || !still()) throw FAMILY_NOT_ASKED;
    const res = await fetch(`${WICK_SERVER_URL}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${mine.jwt}` },
    });
    return { status: res.status, ok: res.ok, body: await res.json().catch(() => null) };
  };
  const turn = mine.turn.then(ask);
  mine.turn = turn.catch(() => {});
  return turn;
}

/**
 * What a refusal means for the screen. 401: the television was disconnected,
 * and can be paired again. 403: the resident does not (or no longer) allow
 * this member — the server's own sentence, and nothing else; it goes on
 * looking, because that can change. True when the answer was one of those.
 */
function familyRefused(reply) {
  if (reply.status === 401) {
    stopFamilyView();
    setConnBadge('disconnected');
    connDetail.textContent = 'no longer connected';
    disconnectBtn.disabled = true;
    pairBtn.disabled = false;
    renderFamilyNoLongerConnected();
    return true;
  }
  if (reply.status === 403) {
    const mine = family;
    const sentence = isText(reply.body?.say) ? reply.body.say : 'There is nothing to show on this television just now.';
    if (mine.lastSeen !== `403 ${sentence}`) log('←', { status: 403, say: sentence });
    mine.lastSeen = `403 ${sentence}`;
    // Whatever was open — something being read, the seat — is closed with the home it came from.
    closeFamilySeat(mine);
    mine.reader = null;
    mine.home = null;
    mine.said = null;
    mine.notSent = null;
    mine.putAway.clear();
    renderFamilySentence(sentence);
    return true;
  }
  return false;
}

/**
 * Asks for the home screen. Not while the tab is hidden, and never while
 * another request is out (familyAsk). It goes on being asked for from the
 * seat beside a film: her question from the door lasts five minutes, and
 * must not wait for the credits.
 */
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
    const reply = await familyAsk(mine, '/tv/home');
    if (family !== mine) return;
    if (familyRefused(reply)) return;
    if (!reply.ok) throw new Error(`tv/home: HTTP ${reply.status}`);
    const home = readFamilyHome(reply.body);
    if (!home) throw new Error('tv/home: not a home screen');
    // Said in the log only when it changes: the same answer every few seconds is not news.
    const seen = JSON.stringify(home);
    if (seen !== mine.lastSeen) log('←', home);
    mine.lastSeen = seen;
    mine.home = home;
    // A card no longer listed is forgotten, so the same id can be shown again another day.
    for (const id of [...mine.putAway.keys()]) {
      if (!home.cards.some((card) => card.id === id)) mine.putAway.delete(id);
    }
    // In the seat no card is drawn over the film: the seat says only whether something waits (drawFamilySeat).
    if (mine.seat) drawFamilySeat();
    else renderFamily();
  } catch (err) {
    // What is on the screen stays; the next look may fare better.
    if (family === mine && err !== FAMILY_NOT_ASKED) log('!', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Tells the server of a press. Its answer, or null when the server refused
 * this television (the screen then already says so). Throws when the press
 * did not arrive.
 */
async function sendFamilyPress(mine, cardId, actionId) {
  const press = { cardId, action: actionId };
  log('→', press);
  const reply = await familyAsk(mine, '/tv/press', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(press),
  });
  if (family !== mine) return null;
  if (familyRefused(reply)) return null;
  if (!reply.ok) throw new Error(`tv/press: HTTP ${reply.status}`);
  log('←', reply.body);
  return { done: reply.body?.done === true, say: textOrNull(reply.body?.say) };
}

/**
 * A press that is sent. What comes of it is the kind's (familyPressKind):
 * the server's sentence in the card's place, the seat, or — for the quiet
 * ones — nothing at all: the card is simply not there the next time.
 */
async function pressFamily(cardId, actionId, card) {
  const mine = family;
  if (!mine || mine.pressing) return;
  const kind = familyPressKind(actionId);
  mine.pressing = true;
  mine.notSent = null;
  renderFamily();
  let answer = null;
  let arrived = true;
  try {
    answer = await sendFamilyPress(mine, cardId, actionId);
  } catch (err) {
    arrived = false;
    if (family === mine) log('!', err instanceof Error ? err.message : String(err));
  } finally {
    mine.pressing = false;
  }
  if (family !== mine) return;
  if (!arrived) {
    // The card stays where it is, with its buttons, and says only that the press did not arrive.
    mine.notSent = cardId;
    renderFamily();
    return;
  }
  if (!answer) return;
  if (kind === 'sit' && answer.done) return openFamilySeat(cardId);
  // Quiet: nothing is shown in answer. When it was done, the card is not drawn again while the server is asked
  // whether it has gone; when it was not, the card is whatever the home screen next says it is.
  if (kind === 'quiet') {
    if (card && answer.done) mine.putAway.set(card.id, cardSignature(card));
  } else if (answer.say) {
    mine.said = { say: answer.say };
  }
  renderFamily();
  void lookAtFamilyHome();
}

/** A press on one of a card's buttons: the television's own are answered here, and nothing is sent for them. */
function pressFamilyCard(card, action) {
  const mine = family;
  if (!mine || mine.pressing) return;
  const kind = familyPressKind(action.id);
  if (kind === 'later') {
    // Put away here, and only here, until the server changes it.
    mine.putAway.set(card.id, cardSignature(card));
    return renderFamily();
  }
  if (kind === 'read') return openFamilyReader(card);
  if (kind === 'seat') return openFamilySeat(card.id);
  void pressFamily(card.id, action.id, card);
}

/** The first card still to be seen: not one put away here, unless the server has since changed it. */
function familyCardToShow(home) {
  return home.cards.find((card) => family.putAway.get(card.id) !== cardSignature(card));
}

/** A button on the screen. `key` is what it is, so the remote's place is kept when the screen is drawn again. */
function familyButton(label, primary, onPress, key) {
  const pill = el('button', `pill ${primary ? 'primary' : ''}`, label);
  pill.type = 'button';
  pill.dataset.key = key;
  pill.disabled = family?.pressing === true;
  pill.addEventListener('click', onPress);
  return pill;
}

/* The remote. */

const familyButtons = () => [...tvScreen.querySelectorAll('button:not([disabled]):not([tabindex="-1"])')];

/** Whether the keyboard is the remote just now: focus on the television's screen, or nowhere in particular. */
function remoteHasTheScreen() {
  const at = document.activeElement;
  return !at || at === document.body || at.disabled === true || tvScreen.contains(at);
}

/** Puts something on the family screen and keeps the remote's place: the same button if it is still there, else the first. */
function showFamily(node) {
  const at = document.activeElement;
  const held = at && tvScreen.contains(at) ? at.dataset.key : undefined;
  const mayFocus = remoteHasTheScreen();
  show(node);
  if (!mayFocus) return;
  const buttons = familyButtons();
  const next = buttons.find((button) => held !== undefined && button.dataset.key === held) ?? buttons.find((button) => button.dataset.first === 'true') ?? buttons[0];
  if (next) next.focus({ preventScroll: true });
  else if (at && tvScreen.contains(at)) at.blur();
}

function moveFamilyFocus(step) {
  const buttons = familyButtons();
  if (buttons.length === 0) return;
  const at = buttons.indexOf(document.activeElement);
  const to = at === -1 ? (step > 0 ? 0 : buttons.length - 1) : Math.min(Math.max(at + step, 0), buttons.length - 1);
  buttons[to].focus({ preventScroll: true });
}

const FAMILY_STEP = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * The keyboard as the remote, while this is a family television and the
 * keyboard is not being used elsewhere on the page. Enter on a button is the
 * button's own press. In the seat, while the film is on, Back is the only
 * key that does anything: nobody reaches her remote from here.
 */
function familyKey(event) {
  const mine = family;
  if (!mine || event.altKey || event.ctrlKey || event.metaKey || !remoteHasTheScreen()) return;
  const back = event.key === 'Escape' || event.key === 'Backspace';
  const step = FAMILY_STEP[event.key];

  if (mine.seat) {
    if (back) {
      event.preventDefault();
      return leaveFamilySeat();
    }
    if (mine.seat.following) {
      // No pause, no skip, no seek: every other key is let fall.
      if (step !== undefined || event.key === 'Enter' || event.key === ' ') event.preventDefault();
      return;
    }
  } else if (mine.reader) {
    if (back) {
      event.preventDefault();
      return turnFamilyReader('close');
    }
    // Left and right turn the page; up and down move between the buttons.
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      return turnFamilyReader(event.key === 'ArrowRight' ? 'next' : 'back');
    }
  }
  if (step !== undefined) {
    event.preventDefault();
    moveFamilyFocus(step);
  }
}

/* The reader. */

/** Opens a card's pages. Nothing is sent: reading is this television's own business until the last page is left. */
function openFamilyReader(card) {
  if (!family || !card.pages) return;
  family.reader = { card, pages: card.pages, index: 0 };
  renderFamily();
}

function turnFamilyReader(move) {
  const mine = family;
  const reader = mine?.reader;
  if (!reader || mine.pressing) return;
  const turned = turnFamilyPage(reader.index, reader.pages.length, move);
  if (!turned.leave) {
    reader.index = turned.index;
    return renderFamily();
  }
  mine.reader = null;
  // Left from the last page: it has been read, and the server is told so — quietly. Left sooner: nothing is told, and the card stays.
  if (turned.read) return void pressFamily(reader.card.id, FAMILY_PRESS.read, reader.card);
  renderFamily();
}

/**
 * A page is written to fit the screen at the large size — but five lines
 * that each run on to a second do not. Measured, not guessed: a page that
 * would have to be scrolled is set a size smaller, where it fits whole. The
 * remote cannot scroll, so nothing of a page may be out of sight.
 */
function fitFamilyReaderPage() {
  const page = tvScreen.querySelector('.reader-page');
  if (page && page.scrollHeight > page.clientHeight + 1) page.classList.add('long');
}

function buildFamilyReader(reader) {
  const last = reader.index >= reader.pages.length - 1;
  const wrapper = el('div', 'tv-card tv-family tv-reader');
  wrapper.appendChild(el('div', 'reader-title', reader.card.headline));
  // The words as they were written, line breaks and all (a day is a line for its date and one for each thing in it):
  // set as text, never as markup, and the stylesheet keeps the lines (white-space: pre-line).
  const words = reader.pages[reader.index];
  wrapper.appendChild(el('div', `reader-page ${words.length > FAMILY_FULL_PAGE_CHARS ? 'long' : ''}`, words));
  const foot = el('div', 'reader-foot');
  foot.appendChild(el('div', 'reader-count', familyPageLine(reader.index, reader.pages.length)));
  const actions = el('div', 'actions');
  if (reader.index > 0) actions.appendChild(familyButton('Back', false, () => turnFamilyReader('back'), 'reader-back'));
  if (!last) {
    const next = familyButton('Next', true, () => turnFamilyReader('next'), 'reader-next');
    next.dataset.first = 'true';
    actions.appendChild(next);
  }
  const close = familyButton('Close', last, () => turnFamilyReader('close'), 'reader-close');
  if (last) close.dataset.first = 'true';
  actions.appendChild(close);
  foot.appendChild(actions);
  wrapper.appendChild(foot);
  return wrapper;
}

/* The home screen. */

/** The whole family screen, from what the server last said. Drawn again only when something on it has changed. */
function renderFamily() {
  const mine = family;
  const home = mine?.home;
  // The seat draws itself (drawFamilySeat): the film in it must not be taken off the screen and put back.
  if (!home || mine.seat) return;
  if (mine.notSent && mine.said) mine.notSent = null;
  const reader = mine.reader;
  const drawn = JSON.stringify([home, mine.said, [...mine.putAway], mine.pressing, mine.notSent, reader ? [reader.card.id, reader.index] : null]);
  if (drawn === mine.drawn) return;
  mine.drawn = drawn;
  if (reader) {
    showFamily(buildFamilyReader(reader));
    return fitFamilyReaderPage();
  }

  const said = mine.said;
  const card = said ? null : familyCardToShow(home);
  // With something waiting, the home's own lines step back and the card has the room.
  const wrapper = el('div', `tv-card tv-family ${said || card ? 'has-card' : ''}`);
  const head = el('div', 'family-head');
  head.appendChild(el('div', 'headline', `${home.residentName}’s home`));
  head.appendChild(el('div', 'body-text', `This is ${home.memberName}’s television.`));
  // Her light in the window, in the server's one sentence — absent when she keeps her day to herself.
  if (home.light) head.appendChild(el('div', 'body-text family-light', home.light.line));
  // A demo home's history was written, not lived: said wherever the home is named.
  if (home.simulated) head.appendChild(el('div', 'family-demo', 'This is a demo home. Its history is simulated.'));
  wrapper.appendChild(head);

  if (said) {
    // The answer to a press, in place of the card, until it is put away by hand.
    const panel = el('div', 'family-card');
    panel.appendChild(el('div', 'headline', said.say));
    const actions = el('div', 'actions');
    actions.appendChild(familyButton('All right', true, () => {
      family.said = null;
      renderFamily();
    }, 'all-right'));
    panel.appendChild(actions);
    wrapper.appendChild(panel);
  } else if (card) {
    const shown = el('div', 'family-card');
    if (card.pictureUrl) {
      // Beside the words, so the answers stay on the screen with it.
      const img = el('img', 'family-picture');
      img.alt = 'The picture from the door';
      img.onerror = () => {
        img.remove();
        shown.classList.remove('with-picture');
      };
      img.src = card.pictureUrl;
      shown.classList.add('with-picture');
      shown.appendChild(img);
    }
    const panel = el('div', 'family-words');
    shown.appendChild(panel);
    panel.appendChild(el('div', 'headline', card.headline));
    if (card.detail) panel.appendChild(el('div', 'body-text', card.detail));
    const actions = el('div', 'actions');
    for (const action of card.actions) {
      actions.appendChild(familyButton(action.label, action.primary, () => pressFamilyCard(card, action), `card-${action.id}`));
    }
    if (card.actions.length === 0) {
      // A card that only says how something stands: put away here, and only here, until the server changes it.
      actions.appendChild(familyButton('All right', true, () => {
        family.putAway.set(card.id, cardSignature(card));
        renderFamily();
      }, 'all-right'));
    }
    panel.appendChild(actions);
    if (mine.notSent === card.id) panel.appendChild(el('div', 'body-text', FAMILY_NOT_SENT));
    wrapper.appendChild(shown);
  } else {
    wrapper.appendChild(el('div', 'body-text family-quiet', 'Nothing is waiting for you.'));
  }

  // A wave: one quiet button for whoever is in the room, after anything a card asks — or, while the last wave is
  // still on her television, the sentence that says so in the button's place. A sentence is not something to press.
  const wave = home.wave;
  if (wave) {
    const row = el('div', 'actions family-wave');
    if (wave.cardId) row.appendChild(familyButton(wave.label, false, () => void pressFamily(wave.cardId, FAMILY_PRESS.wave, null), 'wave'));
    if (wave.line) row.appendChild(el('div', 'body-text family-wave-line', wave.line));
    if (wave.cardId && mine.notSent === wave.cardId) row.appendChild(el('div', 'body-text family-wave-line', FAMILY_NOT_SENT));
    wrapper.appendChild(row);
  }

  showFamily(wrapper);
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

/* The seat beside her film. */

/*
 * For the member who invited her and has sat down (GET /tv/seat). This
 * television follows and never leads: it plays the film where hers is, is
 * still when hers is, and has no pause, no seek and no skip of its own —
 * the one thing the remote does here is Back, which leaves the seat. Her
 * film goes on, and the card with the seat is still on the home screen.
 *
 * The film is played as the resident's is in this page (loadHls above), in
 * a player with no controls. The home screen goes on being asked for from
 * the seat, and no card of it is drawn over the film: when one waits for an
 * answer — her question from the door, her asking to be rung — the seat
 * says so in one line, and Back shows it.
 */

/** A jump while playing aims this far ahead: about what it takes to start again, so it lands level and not behind. */
const FAMILY_SEEK_LEAD_MS = 1000;
/** After a jump the player is left to get there for this long before it is sent anywhere else. */
const FAMILY_SEEK_SETTLE_MS = 8000;

/** @param {string} cardId  the film's own card, whose button opened the seat */
function openFamilySeat(cardId) {
  const mine = family;
  if (!mine || mine.seat) return;
  mine.reader = null;
  mine.said = null;
  mine.notSent = null;

  const wrapper = el('div', 'tv-card tv-family tv-seat');
  const layer = el('div', 'tv-film seat-film');
  layer.hidden = true;
  const video = document.createElement('video');
  // No controls: nothing on this television pauses or moves the film.
  video.controls = false;
  video.playsInline = true;
  video.tabIndex = -1;
  layer.appendChild(video);
  const words = el('div', 'seat-words');
  wrapper.append(layer, words);

  mine.seat = {
    wrapper,
    layer,
    video,
    words,
    /** The film's own card on the home screen: never what "something is waiting" is about. */
    cardId,
    /** The server's last word on the seat, and the last line it gave — kept for when there is no seat any more. */
    data: null,
    lastLine: null,
    /** Whether her film is being followed on screen just now: then Back is the only key. */
    following: false,
    /** No seat any more: nothing further is asked. (A film that has ended still has one, and its line can change.) */
    over: false,
    /** The question at the credits has been answered from here: its answers are not offered again. */
    answered: false,
    /**
     * A sentence about a press that was not taken, or did not arrive: shown in the seat until it is put away by
     * hand — or until the seat is in another state than the one it was said in, which it must not outlive.
     */
    said: null,
    /** The stream in the player, if one is: its address, its hls.js, and when it was last sent somewhere. */
    film: null,
    /** The browser would not start the sound without a press: the picture plays, and the sound is one press away. */
    silent: false,
    looking: null,
    pressing: false,
    lastSeen: '',
    drawn: '',
    timer: setInterval(() => void lookAtFamilySeat(), FAMILY_SEAT_EVERY_MS),
  };
  showFamily(wrapper);
  drawFamilySeat();
  void lookAtFamilySeat();
}

function closeFamilyFilm(seat) {
  if (!seat.film) return;
  seat.film.hls?.destroy();
  seat.film = null;
  seat.video.pause();
  seat.video.removeAttribute('src');
  seat.video.load();
}

/** Takes this television out of the seat: no more asking, no film. Her film is not touched. */
function closeFamilySeat(mine) {
  const seat = mine.seat;
  if (!seat) return;
  clearInterval(seat.timer);
  closeFamilyFilm(seat);
  mine.seat = null;
}

/** Back, or the button that says the same: the home screen again, asked for afresh. */
function leaveFamilySeat() {
  const mine = family;
  if (!mine?.seat) return;
  closeFamilySeat(mine);
  mine.drawn = '';
  renderFamily();
  void lookAtFamilyHome();
}

/** Asks where her film is. Not while the tab is hidden, not once it is over, and never while another request is out. */
function lookAtFamilySeat() {
  const mine = family;
  const seat = mine?.seat;
  if (!seat || seat.looking || seat.pressing || seat.over || document.hidden) return Promise.resolve();
  seat.looking = seatLookOnce(mine, seat).finally(() => {
    seat.looking = null;
  });
  return seat.looking;
}

async function seatLookOnce(mine, seat) {
  try {
    const reply = await familyAsk(mine, '/tv/seat', {}, () => mine.seat === seat);
    if (family !== mine || mine.seat !== seat) return;
    if (familyRefused(reply)) return;
    if (!reply.ok) throw new Error(`tv/seat: HTTP ${reply.status}`);
    const read = readFamilySeat(reply.body);
    if (!read) throw new Error('tv/seat: not a seat');
    const data = read.seat;
    // Where the film has got to changes with every answer; the log says only when something else does.
    const seen = JSON.stringify(data ? [data.state, data.line, data.playback?.state, data.question, data.yourAnswer, data.theirAnswer] : null);
    if (seen !== seat.lastSeen) log('←', data ? { seat: data } : { seat: null });
    seat.lastSeen = seen;
    // A sentence about a press describes the seat as it was then: it goes when the seat is no longer that.
    if ((seat.data?.state ?? null) !== (data?.state ?? null)) seat.said = null;
    seat.data = data;
    if (data) seat.lastLine = data.line;
    if (!data) {
      // No seat any more, so nothing further is asked. The last line stays until it is put away.
      // While there is one it goes on being asked for, the film over or not: what was said at the
      // credits is in its line, and her answer is drawn when it arrives.
      seat.over = true;
      clearInterval(seat.timer);
    }
    followFamilySeat(seat);
    drawFamilySeat();
  } catch (err) {
    // What is on the screen stays; the next look may fare better.
    if (family === mine && mine.seat === seat) log('!', err instanceof Error ? err.message : String(err));
  }
}

/** Puts the film in the player, once per address. */
function openFamilyFilm(seat, stream) {
  if (seat.film?.url === stream.url) return;
  closeFamilyFilm(seat);
  const film = { url: stream.url, hls: null, soughtAt: 0 };
  seat.film = film;
  const { video } = seat;
  // The browser's own HLS, where it has one, and what is left if hls.js cannot be fetched or cannot reach the film.
  const playNatively = () => {
    if (seat.film === film) video.src = stream.url;
  };
  loadHls()
    .then((Hls) => {
      if (seat.film !== film) return;
      if (!Hls?.isSupported()) return playNatively();
      const hls = new Hls();
      film.hls = hls;
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal || film.hls !== hls) return;
        hls.destroy();
        film.hls = null;
        playNatively();
      });
      hls.loadSource(stream.url);
      hls.attachMedia(video);
    })
    .catch(playNatively);
}

/**
 * Sound needs a press in some browsers. The picture starts without it, and
 * the sound is then one press away — never a film that silently does not start.
 */
function startFamilyFilm(seat) {
  const { video } = seat;
  video.play().catch(() => {
    if (family?.seat !== seat || video.muted) return;
    video.muted = true;
    video.play().then(() => {
      seat.silent = true;
      drawFamilySeat();
    }).catch(() => {});
  });
}

/** Brings this television's player to where hers is (familyFollow), or stops it when there is nothing to follow. */
function followFamilySeat(seat) {
  const data = seat.data;
  const following = Boolean(data && data.state === 'watching' && data.stream && data.playback);
  seat.following = following;
  if (!following) {
    // At the question, and once it is over, the film is stopped. Otherwise — she has not started it, or where
    // hers is cannot be told just now — the player is held still where it is.
    if (!data || data.state === 'asked' || data.state === 'over') closeFamilyFilm(seat);
    else if (!seat.video.paused) seat.video.pause();
    return;
  }
  openFamilyFilm(seat, data.stream);
  const { video, film } = seat;
  const asked = familyFollow(data.playback, 0, { positionMs: video.currentTime * 1000, paused: video.paused }, data.stream.durationMs);
  // Not before it knows the film's length, and not while it is still finding the last place it was sent:
  // a new place every look would be no place at all.
  const settling = video.seeking || (video.readyState < 3 && Date.now() - film.soughtAt < FAMILY_SEEK_SETTLE_MS);
  if (asked.seekToMs !== null && !settling && video.readyState >= 1) {
    film.soughtAt = Date.now();
    video.currentTime = (asked.seekToMs + (asked.play ? FAMILY_SEEK_LEAD_MS : 0)) / 1000;
  }
  if (asked.play && video.paused) startFamilyFilm(seat);
  else if (!asked.play && !video.paused) video.pause();
}

/** An answer at the credits: told to the server, whose one sentence is then shown. */
async function pressFamilySeat(action) {
  const mine = family;
  const seat = mine?.seat;
  if (!seat || seat.pressing || !seat.data) return;
  seat.pressing = true;
  seat.said = null;
  drawFamilySeat();
  let answer = null;
  let arrived = true;
  try {
    answer = await sendFamilyPress(mine, seat.data.cardId, action.id);
  } catch (err) {
    arrived = false;
    if (family === mine) log('!', err instanceof Error ? err.message : String(err));
  } finally {
    seat.pressing = false;
  }
  if (family !== mine || mine.seat !== seat) return;
  // Refused outright (401, 403): the screen already says so, and this seat is closed.
  if (arrived && !answer) return;
  const next = familySeatAfterPress({ arrived, done: answer?.done, say: answer?.say });
  seat.answered = seat.answered || next.answered;
  seat.said = next.said;
  drawFamilySeat();
  if (arrived) void lookAtFamilySeat();
}

/** The words over, or in place of, the film. Drawn again only when something in them has changed; the player is never redrawn. */
function drawFamilySeat() {
  const seat = family?.seat;
  if (!seat) return;
  const data = seat.data;
  const state = !data ? (seat.over ? 'over' : 'opening') : data.state;
  const following = seat.following;
  const stillFrame = following && data.playback.state !== 'PLAYING';
  // What Back would show, if it waits for an answer and is not this film's own card.
  const home = family.home;
  const waiting = Boolean(home) && familyCardWaits(familyCardToShow(home), data?.cardId ?? seat.cardId);
  const drawn = JSON.stringify([state, data?.line, seat.lastLine, following, stillFrame, waiting, data?.question, data?.answers, data?.yourAnswer, data?.stream?.attribution, seat.said, seat.answered, seat.pressing, seat.silent]);
  if (drawn === seat.drawn) return;
  seat.drawn = drawn;

  seat.layer.hidden = !following;
  seat.wrapper.classList.toggle('is-following', following);
  const at = document.activeElement;
  const held = at && seat.words.contains(at) ? at.dataset.key : undefined;
  const mayFocus = remoteHasTheScreen();
  const parts = [];
  const button = (label, primary, onPress, key) => {
    const pill = el('button', `pill ${primary ? 'primary' : ''}`, label);
    pill.type = 'button';
    pill.dataset.key = key;
    pill.disabled = seat.pressing;
    pill.addEventListener('click', onPress);
    return pill;
  };
  const attribution = data?.stream?.attribution;

  if (following) {
    // Over the film: the line, and Back — reached by its own key, or the mouse. Nothing here is focused, so OK does nothing.
    const back = button('Back', false, leaveFamilySeat, 'seat-back');
    back.classList.add('seat-back');
    back.tabIndex = -1;
    parts.push(back, el('div', 'seat-caption', data.line));
    const foot = el('div', 'seat-foot');
    // One calm line, and no card over the film: what waits is on the home screen, a press of Back away.
    if (waiting) foot.appendChild(el('div', 'seat-waiting', FAMILY_WAITING_LINE));
    // As the resident's own player does: who made the film, while the picture is still.
    if (stillFrame && attribution) foot.appendChild(el('div', 'seat-attribution', attribution));
    if (foot.childElementCount > 0) parts.push(foot);
    if (seat.silent) {
      const sound = button('Turn the sound on', false, () => {
        seat.video.muted = false;
        seat.silent = false;
        drawFamilySeat();
      }, 'seat-sound');
      sound.classList.add('seat-sound');
      sound.tabIndex = -1;
      parts.push(sound);
    }
  } else {
    const asked = state === 'asked';
    const line = data?.line ?? seat.lastLine ?? (state === 'opening' ? 'One moment.' : 'The film is over.');
    if (asked && data.question && !seat.said) {
      // The server's line at the credits is the question itself: it is said once.
      if (line !== data.question) parts.push(el('div', 'body-text', line));
      parts.push(el('div', 'headline', data.question));
    } else {
      parts.push(el('div', 'headline', seat.said ?? line));
    }
    const actions = el('div', 'actions');
    const answering = asked && !seat.said && !seat.answered && !data.yourAnswer && data.answers.length > 0;
    if (answering) {
      for (const answer of data.answers) actions.appendChild(button(answer.label, answer.primary, () => void pressFamilySeat(answer), `seat-${answer.id}`));
    } else if (seat.said) {
      // The answer to a press, until it is put away by hand — and then the seat as it stands, in the server's own line.
      actions.appendChild(button('All right', true, () => {
        seat.said = null;
        drawFamilySeat();
      }, 'seat-said'));
    } else if (asked || state === 'over') {
      // Nothing left to follow or to answer: one button, back to the home screen.
      actions.appendChild(button('All right', true, leaveFamilySeat, 'seat-leave'));
    } else {
      // Sat down, and she has not started the film: it can be waited for, or left.
      actions.appendChild(button('Back', false, leaveFamilySeat, 'seat-back'));
    }
    parts.push(actions);
    if (waiting) parts.push(el('div', 'body-text seat-waiting', FAMILY_WAITING_LINE));
    if (attribution && state !== 'waiting') parts.push(el('div', 'seat-attribution', attribution));
  }
  seat.words.replaceChildren(...parts);

  if (!mayFocus) return;
  const buttons = [...seat.words.querySelectorAll('button:not([disabled]):not([tabindex="-1"])')];
  const next = buttons.find((b) => held !== undefined && b.dataset.key === held) ?? buttons[0];
  if (next) next.focus({ preventScroll: true });
  else if (document.activeElement && tvScreen.contains(document.activeElement)) document.activeElement.blur();
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
