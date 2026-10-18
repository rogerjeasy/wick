/**
 * Her television, in a browser — tv.html, for somebody with no Fire TV.
 *
 * Not a console: the screen is all there is, sixteen by nine on black, drawn
 * as the Vega app draws it (tv.css, from packages/vega-calm-ui's tokens).
 * The television itself — pairing, the card channel, every card and its
 * buttons, the mantelpiece, reading aloud, the film — is tv-core.js, which
 * the engineers' console (device.html) runs as well. What this file adds is
 * what makes it her television and not a page that shows cards:
 *
 * - The home screen the Vega app shows (apps/tv-vega/src/home/HomeScreen.tsx):
 *   "What would you like to watch?", her light in the window, the three
 *   films, who looked in, a card that has waited its two showings, her
 *   mantelpiece — and "Easier to see".
 * - Films that play here, from the films' own origin, and the natural break
 *   exactly as on Vega, because it is the Vega app's own code
 *   (tv-engine.generated.js, `npm run tv:build`): a note from the family
 *   waits while the film plays and comes on screen at a pause, at one of
 *   that film's measured calm points (tv-catalog.json), or at the credits.
 *   In the middle of the film it holds the film on the cut while it is
 *   shown, and the film goes on when it has gone (NaturalBreakEngine
 *   holdsProgramme). The door never waits (INV-5), and it holds the film
 *   too: the film goes on when she puts the card away, and stays paused if
 *   the card went by itself while she was at the door.
 * - The keyboard as the remote: arrows move, Enter is OK, Backspace or Esc
 *   is Back, Space or P is Play/Pause, and Enter held two seconds is Hold
 *   for Sarah. A card's buttons take no press in its first second on screen,
 *   and a press must begin on the screen it ends on (press/settle.ts,
 *   press/held.ts) — a mouse click obeys the same second.
 * - Play over a card reads it aloud (packages/contracts speech.ts); over a
 *   note holding the film the first Play reads and the next carries on with
 *   the film (watch/remoteKeys.ts playIsTheCards).
 * - "Easier to see": larger text (every size times 1.25) and higher
 *   contrast (black and white, a thicker ring), kept on this device only.
 * - A legend of the keys, the first time and on the pairing screen,
 *   dismissed by hand — never on a timer.
 *
 * It never decides what to show anybody: the server does. It decides only
 * when — and that is the engine's.
 */
const TV = WickTv;

/* --- Its own few words --------------------------------------------------- */

/*
 * The television's words are the Vega app's (TV.words, words/words.ts). Only
 * "Easier to see" is this page's own: the Vega app is given the same two
 * modes, with the same names and the same meaning, and until its words hold
 * them they are here, in each language a household can choose.
 */
const EASIER_WORDS = {
  en: {
    title: 'Easier to see',
    larger: 'Larger text',
    contrast: 'Higher contrast',
    back: 'Back',
    detail: 'Larger text: {larger}. Higher contrast: {contrast}. Kept on this television.',
    on: 'on',
    off: 'off',
  },
  es: {
    title: 'Más fácil de ver',
    larger: 'Texto más grande',
    contrast: 'Más contraste',
    back: 'Atrás',
    detail: 'Texto más grande: {larger}. Más contraste: {contrast}. Se guarda en este televisor.',
    on: 'activado',
    off: 'desactivado',
  },
};

/** One of the Vega app's sentences, in her language. */
function say(key, values) {
  return TV.words(tvLanguage())(key, values);
}

function easierSay(key, values = {}) {
  const table = EASIER_WORDS[tvLanguage()] ?? EASIER_WORDS.en;
  return (table[key] ?? EASIER_WORDS.en[key]).replace(/\{(\w+)\}/g, (place, name) => (name in values ? String(values[name]) : place));
}

/* --- Kept on this device ------------------------------------------------- */

/*
 * Three things this page keeps in the browser, and nothing about her: how
 * she likes the screen ("Easier to see"), that the legend of the keys has
 * been seen, and where each film was left. localStorage, because both belong to this device and not to a
 * tab; every reach for it is wrapped, because a browser may refuse it — and
 * then the page simply starts as it would the first time.
 */
const SEEING_KEY = 'wick_tv_easier_to_see';
const KEYS_SEEN_KEY = 'wick_tv_keys_seen';
/** Where each film was left (watch/resume.ts): a place in a film, nothing about her. */
const FILM_POSITIONS_KEY = 'wick_tv_film_positions';

function deviceStorage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const filmPositions = new TV.FilmPositions({
  read: () => deviceStorage()?.getItem(FILM_POSITIONS_KEY) ?? null,
  write: (text) => deviceStorage()?.setItem(FILM_POSITIONS_KEY, text),
});

function recall(key) {
  try {
    return deviceStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function keep(key, value) {
  try {
    deviceStorage()?.setItem(key, value);
  } catch {
    // Not kept: it lasts as long as the page.
  }
}

/** Larger text and higher contrast, as this device last had them. Anything unreadable is neither. */
function readSeeing(raw) {
  try {
    const value = JSON.parse(raw ?? 'null');
    return { larger: value?.larger === true, contrast: value?.contrast === true };
  } catch {
    return { larger: false, contrast: false };
  }
}

let seeing = readSeeing(recall(SEEING_KEY));

/** The two modes, on the screen: every size times 1.25, and black and white with a thicker ring (tv.css). */
function applySeeing() {
  tvScreen.classList.toggle('larger-text', seeing.larger);
  tvScreen.classList.toggle('higher-contrast', seeing.contrast);
}

function setSeeing(next) {
  seeing = next;
  keep(SEEING_KEY, JSON.stringify(seeing));
  applySeeing();
}

/* --- What she can watch -------------------------------------------------- */

/** The films, as tv-catalog.json says them (generated from the Vega app's catalogue and calm points). Empty until it has come. */
let catalogue = [];

/** Only what is a film: an id that can go into an address, a title, and numbers that are numbers. */
function readCatalogue(body) {
  const list = Array.isArray(body?.programmes) ? body.programmes : [];
  return list
    .filter((p) => typeof p?.id === 'string' && /^[a-z0-9-]{1,64}$/.test(p.id) && typeof p.title === 'string' && typeof p.line === 'string')
    .filter((p) => Number.isFinite(p.durationMs) && Number.isFinite(p.creditsPositionMs))
    .map((p) => ({
      id: p.id,
      title: p.title,
      line: p.line,
      durationMs: p.durationMs,
      creditsPositionMs: p.creditsPositionMs,
      attribution: typeof p.attribution === 'string' ? p.attribution : '',
      calmPointsMs: Array.isArray(p.calmPointsMs) ? p.calmPointsMs.filter(Number.isFinite) : [],
    }))
    .slice(0, 3);
}

const programmeOf = (id) => catalogue.find((p) => p.id === id);

async function loadCatalogue() {
  for (;;) {
    try {
      const res = await fetch('tv-catalog.json', { cache: 'no-cache' });
      if (res.ok) {
        catalogue = readCatalogue(await res.json());
        homeDrawn = '';
        if (!currentQueuedCard && !film && ws) renderEmpty();
        return;
      }
    } catch {
      // Tried again in a moment.
    }
    await sleep(5000);
  }
}

/* --- The natural break ---------------------------------------------------- */

/** The Vega app's own controller: when a note may come on screen, and when it holds the film. */
const breaks = new TV.BreakController({ calmPointsOf: (id) => programmeOf(id)?.calmPointsMs });
/** A card's buttons take no press in its first second on screen; nor does the home, when it comes back. */
const settle = TV.pressSettle();
/** Her press on the light, and her hold on OK: the card that answers each is hers to see at once (home/asked.ts). */
const lightAsked = TV.asking();
const reachAsked = TV.asking();
/** A card she opened from the home screen's waiting line, or the answer to her light or her hold. */
let openedId = null;
/** The card Play has already asked to have read, this showing of it (watch/remoteKeys.ts playIsTheCards). */
let askedFor = null;
/** What each card's count of showings was when its showing under way began (QueueStore.beginShowing). */
const showingFrom = new Map();
/** The card that has had its two showings, for the home screen's waiting line. */
let waitingCard = null;
let lastBreakState = null;
let tick = null;
/** "Easier to see" is open. */
let easierOpen = false;
/** The film she last watched: where the focus goes back to on the home screen. */
let lastWatchedId;

/** As QueueStore.upsert: a card sent again keeps the larger of the two counts of its showings. */
function keepArrived(kept, queued) {
  const held = kept.find((q) => q.card.id === queued.card.id);
  const again = held !== undefined && held.queuedAt === queued.queuedAt;
  if (held && !again) showingFrom.delete(queued.card.id);
  const merged = again && held.shownCount > queued.shownCount ? { ...queued, shownCount: held.shownCount } : queued;
  return keepCard(kept, merged);
}

/** One of a card's two showings is over, unanswered (QueueStore.countShowing). */
function countShowing(cardId) {
  keptCards = keptCards.map((q) => {
    if (q.card.id !== cardId) return q;
    const from = showingFrom.get(cardId) ?? q.shownCount;
    showingFrom.delete(cardId);
    return { ...q, shownCount: Math.max(q.shownCount, from + 1) };
  });
}

/**
 * The look, as the Vega app makes it once a second (ResidentApp.tsx tick):
 * which card is on screen now, whether the film waits for it, and what the
 * home screen's quiet row says. Also made at once whenever something
 * changes — a card arrives, is answered, is taken back; the film is paused —
 * so the door is on the screen the moment it comes.
 */
function look() {
  if (family || !ws) return;
  const now = Date.now();
  keptCards = keptCards.filter((q) => typeof q.expiresAt !== 'number' || q.expiresAt > now);
  // A screen she asked for — her mantelpiece, or "Easier to see" — keeps a note waiting behind it. The door comes over it.
  const picked = TV.overMantel(breaks.pickCard(keptCards, now), mantelView !== null || easierOpen);

  const showing = breaks.noteShown(picked, keptCards, now);
  if (showing.began) {
    send({ t: 'card_shown', cardId: showing.began.id, at: now });
    showingFrom.set(showing.began.id, showing.began.shownCount);
  }
  if (showing.ended) countShowing(showing.ended.id);

  // Her light: the card that answers her press is hers to see at once; one she did not ask for is put away unseen.
  const light = keptCards.find((q) => q.card.type === 'LIGHT');
  if (light && lightAsked.waiting(now)) {
    openedId = light.id;
    lightAsked.done();
  }
  for (const id of TV.unaskedLightCards(keptCards, openedId)) keptCards = dropCard(keptCards, id);
  // Hold for Sarah: what her hold brings is hers to see at once, and an offer she is not looking at is put away.
  const reach = TV.newestReachCard(keptCards);
  if (reach && reachAsked.waiting(now)) openedId = reach.id;
  for (const id of TV.reachOffersToPutAway(keptCards, openedId)) keptCards = dropCard(keptCards, id);

  const opened = openedId ? keptCards.find((q) => q.id === openedId) : undefined;
  if (openedId && !opened) openedId = null;
  const shown = (picked?.urgency === 'DOOR' ? picked : (opened ?? picked)) ?? null;
  waitingCard = breaks.waiting(keptCards, now) ?? null;

  if (shown !== currentQueuedCard) {
    if (shown?.card.id !== currentQueuedCard?.card.id) askedFor = null;
    currentQueuedCard = shown;
    if (shown) renderCard(shown);
    else renderEmpty();
  } else if (!shown && !film && !mantelView && !easierOpen) {
    // The home screen's words can change with nothing arriving: the day ends, a card has waited its two showings.
    if (homeSignature() !== homeDrawn) renderEmpty();
  }

  holdFilm();
  sayFilmNotice();

  const state = breaks.breakState(now);
  if (state !== lastBreakState) {
    lastBreakState = state;
    send({ t: 'break_state', state, at: now });
  }
}

/* --- The film ------------------------------------------------------------ */

/** What this page knows of the film beside tv-core.js's `film`: its programme, its notice, and whether a card holds it. */
let watching = null;

function snapshotOf(video, programme) {
  return TV.deriveSnapshot(video, programme.id, programme.creditsPositionMs);
}

/** Where the film is, to the engine — and, when its state changes, to the server (watch/playbackRecorder.ts). */
function sample() {
  const mine = watching;
  if (!mine || film?.video !== mine.video) return;
  const snapshot = snapshotOf(mine.video, mine.programme);
  const now = Date.now();
  breaks.setPlayback(snapshot, now);
  mine.last = snapshot;
  if (mine.recorder.shouldRecord(snapshot)) send(TV.toPlaybackDeviceEvent(snapshot, now));
}

function filmStarted(started) {
  const programme = programmeOf(started.programmeId) ?? { id: started.programmeId, title: '', creditsPositionMs: undefined, attribution: '' };
  const notice = el('div', 'film-notice');
  started.layer.appendChild(notice);
  // Back is the remote's Back here, and who watches with her is said in the notice, as on Vega: the console's two
  // lines over the film are not this television's, and are never reached by the D-pad.
  started.back.hidden = true;
  if (started.withLine) started.withLine.hidden = true;
  watching = {
    film: started,
    video: started.video,
    programme,
    notice,
    status: 'opening',
    held: false,
    resumeAfterCard: false,
    recorder: new TV.PlaybackRecorder(),
    last: null,
  };
  const mine = watching;
  // Where she left it, if she did (watch/resume.ts): not 0:00 again. Once the browser knows the film.
  const from = filmPositions.startAt(programme.id);
  if (from > 0) {
    const seek = () => {
      if (watching === mine) started.video.currentTime = from / 1000;
    };
    if (started.video.readyState >= 1) seek();
    else started.video.addEventListener('loadedmetadata', seek, { once: true });
  }
  const changed = () => {
    if (watching !== mine) return;
    sample();
    look();
  };
  started.video.addEventListener('playing', () => {
    if (watching === mine) mine.status = 'playing';
    changed();
  });
  started.video.addEventListener('pause', () => {
    if (watching === mine && mine.status !== 'opening') mine.status = 'paused';
    changed();
  });
  for (const type of ['play', 'waiting', 'seeked']) started.video.addEventListener(type, changed);
  started.video.addEventListener('error', () => filmFailed(started));
  // The programme is over: back to the home screen, where a note waiting is already allowed.
  started.video.addEventListener('ended', () => {
    if (film === started) stopFilm();
  });
  sayFilmNotice();
}

function filmStopped(was) {
  const mine = watching;
  if (!mine || mine.film !== was) return;
  // Leaving is a stop, wherever the film had got to.
  if (mine.last && mine.last.state !== 'STOPPED') {
    const stopped = { ...mine.last, state: 'STOPPED' };
    if (mine.recorder.shouldRecord(stopped)) send(TV.toPlaybackDeviceEvent(stopped, Date.now()));
  }
  // Where it was left, for the next time she chooses it; a film watched to the credits starts again.
  if (mine.last) filmPositions.stopped(mine.programme.id, mine.last.positionMs, mine.programme.durationMs ?? 0, mine.programme.creditsPositionMs);
  lastWatchedId = mine.programme.id;
  watching = null;
  breaks.setPlayback(undefined, Date.now());
  homeDrawn = '';
}

function filmFailed(failed) {
  if (watching?.film !== failed) return;
  watching.status = 'failed';
  sayFilmNotice();
}

/** The browser would not start it without a press: it waits, paused, for Play. */
function filmBlocked(blocked) {
  if (watching?.film !== blocked) return;
  watching.status = 'paused';
  sayFilmNotice();
}

/**
 * How recently she must have answered a card for the film it held to go on by
 * itself when it goes (ResidentApp.tsx PUT_AWAY_WITHIN_MS).
 */
const PUT_AWAY_WITHIN_MS = 10_000;
/** When she last answered a card on screen (tvPage.pressed, putNoteAway). */
let answeredAt = 0;

/**
 * A note in the middle of the film, or the door: the film waits while the
 * card is shown, and goes on when it has gone. If she had paused it herself,
 * it stays paused afterwards — and so it does if the card went without her
 * press, as a door card does after its minutes while she is at the door
 * (WatchScreen.tsx `held`, `putAwayByHer`).
 */
function holdFilm() {
  const mine = watching;
  if (!mine) return;
  const holds = breaks.holdsProgramme(currentQueuedCard ?? undefined);
  if (holds && !mine.held) {
    mine.held = true;
    mine.resumeAfterCard = !mine.video.paused;
    mine.video.pause();
  } else if (!holds && mine.held) {
    mine.held = false;
    if (mine.resumeAfterCard) {
      mine.resumeAfterCard = false;
      if (Date.now() - answeredAt <= PUT_AWAY_WITHIN_MS) playOn(mine.video);
      else sayFilmNotice();
    }
  }
}

function playOn(video) {
  Promise.resolve(video.play()).catch(() => {
    if (watching?.video === video) filmBlocked(watching.film);
  });
}

/** OK, or Play, when they are the film's: it pauses, or plays on. */
function toggleFilm() {
  const video = watching?.video;
  if (!video) return;
  if (video.paused) playOn(video);
  else video.pause();
}

/** What the film says over itself, in her language: starting, paused, or that it will not play (WatchScreen.tsx notice). */
function sayFilmNotice() {
  const mine = watching;
  if (!mine) return;
  const title = mine.programme.title;
  const cardVisible = currentQueuedCard !== null;
  const lines = [];
  if (mine.status === 'failed') lines.push(say('watch.failed', { title }));
  else if (mine.status === 'opening') lines.push(say('watch.starting', { title }));
  else if (mine.status === 'paused' && !cardVisible) lines.push(say('watch.paused', { title }));
  // Nobody follows a film she has not been told they are following: said whenever the film says anything.
  if (lines.length > 0 && mine.status !== 'failed' && mine.film.withLine) lines.push(say('watch.companion', { name: mine.film.withName }));
  const attribution = mine.status === 'paused' && lines.length > 0 ? mine.programme.attribution : '';
  const drawn = JSON.stringify([lines, attribution]);
  if (mine.notice.dataset.drawn === drawn) return;
  mine.notice.dataset.drawn = drawn;
  mine.notice.replaceChildren(...lines.map((line) => el('div', 'film-line', line)), ...(attribution ? [el('div', 'film-attribution', attribution)] : []));
  mine.notice.hidden = lines.length === 0;
}

/* --- The home screen ----------------------------------------------------- */

/** What the home screen last drew, so a look that changes nothing draws nothing. */
let homeDrawn = '';

function homeSignature() {
  const now = Date.now();
  return JSON.stringify([
    tvLanguage(),
    catalogue.map((p) => p.id),
    home.light ? lightLabel(now) : null,
    lookedInLine(now),
    waitingCard ? TV.waitingLine(waitingCard, tvLanguage()) : null,
    Number.isInteger(home.mantel) && home.mantel >= 1,
  ]);
}

/** A thing on the home screen to press. `key` keeps the remote's place when the screen is drawn again. */
function homeButton(className, key, onPress) {
  const button = el('button', className);
  button.type = 'button';
  button.dataset.key = key;
  button.addEventListener('click', onPress);
  return button;
}

/** The home screen: what would you like to watch, as the Vega app shows it (HomeScreen.tsx). */
function renderHome() {
  if (easierOpen) return renderEasier();
  const now = Date.now();
  homeDrawn = homeSignature();
  const screen = el('div', 'tv-home');

  const top = el('div', 'home-top');
  top.appendChild(el('div', 'home-question', say('home.question')));
  if (home.light) {
    // The one button beside the question: OK opens the card that says who can see her light.
    const light = homeButton('home-pill', 'light', () => askAbout(lightAsked, { t: 'light' }));
    light.textContent = lightLabel(now);
    light.setAttribute('aria-label', say('home.lightLabel', { light: lightLabel(now) }));
    top.appendChild(light);
  }
  screen.appendChild(top);

  const row = el('div', 'home-row');
  for (const programme of catalogue) {
    const tile = homeButton('home-tile', `programme:${programme.id}`, () => {
      // Nobody follows a film she chose here: only "Start the film", on a card that says who will see it, does that.
      startFilm({ programmeId: programme.id });
      renderEmpty();
    });
    const poster = el('img', 'home-poster');
    poster.alt = '';
    poster.src = `posters/${programme.id}.jpg`;
    tile.appendChild(poster);
    const caption = el('div', 'home-caption');
    caption.appendChild(el('div', 'home-title', programme.title));
    caption.appendChild(el('div', 'home-line', TV.programmeLine(programme, tvLanguage())));
    tile.appendChild(caption);
    row.appendChild(tile);
  }
  screen.appendChild(row);

  // One quiet row under the films: a card that has waited its two showings, or who looked in; then her
  // mantelpiece, and "Easier to see". Never where the focus starts.
  const quiet = el('div', 'home-quiet');
  const waiting = waitingCard && waitingCard.id !== currentQueuedCard?.id ? waitingCard : null;
  const looked = lookedInLine(now);
  if (waiting) {
    const open = homeButton('home-waiting', 'waiting', () => {
      openedId = waiting.id;
      look();
    });
    open.appendChild(el('span', 'home-waiting-line', TV.waitingLine(waiting, tvLanguage())));
    open.appendChild(el('span', 'home-open', say('home.open')));
    quiet.appendChild(open);
  } else if (looked) {
    quiet.appendChild(el('div', 'home-said', looked));
  } else {
    quiet.appendChild(el('div', 'home-said'));
  }
  if (Number.isInteger(home.mantel) && home.mantel >= 1) {
    const mantelPill = homeButton('home-pill', 'mantel', openMantel);
    mantelPill.textContent = say('home.mantel');
    quiet.appendChild(mantelPill);
  }
  const easier = homeButton('home-pill', 'easier', openEasier);
  easier.textContent = easierSay('title');
  quiet.appendChild(easier);
  screen.appendChild(quiet);

  show(screen);
}

/** Her press on the light, or her hold: a question to the server, whose answering card is hers to see at once. */
function askAbout(asked, event) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const at = Date.now();
  asked.asked(at);
  send({ ...event, at });
  asked.sent(at, Date.now());
}

/* --- Easier to see ------------------------------------------------------- */

function openEasier() {
  easierOpen = true;
  renderEasier();
}

function closeEasier() {
  easierOpen = false;
  homeDrawn = '';
  renderEmpty();
  look();
}

/** Three items, never four: the two modes, and the way back. */
function renderEasier() {
  const card = el('div', 'tv-card urgency-deferred tv-easier');
  card.appendChild(el('div', 'headline', easierSay('title')));
  card.appendChild(el('div', 'body-text', easierSay('detail', { larger: easierSay(seeing.larger ? 'on' : 'off'), contrast: easierSay(seeing.contrast ? 'on' : 'off') })));
  const actions = el('div', 'actions');
  const toggle = (label, key, on, flip) => {
    const button = homeButton(`pill ${key === 'larger' ? 'primary' : ''}`, `easier-${key}`, flip);
    button.textContent = label;
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    return button;
  };
  actions.appendChild(toggle(easierSay('larger'), 'larger', seeing.larger, () => {
    setSeeing({ ...seeing, larger: !seeing.larger });
    renderEasier();
  }));
  actions.appendChild(toggle(easierSay('contrast'), 'contrast', seeing.contrast, () => {
    setSeeing({ ...seeing, contrast: !seeing.contrast });
    renderEasier();
  }));
  const back = homeButton('pill', 'easier-back', closeEasier);
  back.textContent = easierSay('back');
  actions.appendChild(back);
  card.appendChild(actions);
  show(card);
}

/* --- The remote ---------------------------------------------------------- */

/** What is on screen to be pressed, by name: the settle second, and where a press began, are counted by it. */
function screenKey() {
  if (family) return 'family';
  if (currentQueuedCard) return `card:${currentQueuedCard.card.id}`;
  if (easierOpen) return 'easier';
  if (mantelView) return 'mantel';
  if (film) return 'film';
  if (!ws) return 'unpaired';
  return 'home';
}

const focusables = () => [...tvScreen.querySelectorAll('button:not([disabled]):not([hidden]), [data-focusable]')].filter((node) => !node.closest('[hidden]'));

/**
 * Where an arrow goes from here: the nearest thing wholly beyond this one's
 * edge in that direction, the distance across counting double, so the D-pad
 * moves along a row before it jumps to another — and down from the first of
 * a card's buttons goes to the one under it, never along. Pure: given the
 * boxes, it says which.
 *
 * @param {{left: number, top: number, width: number, height: number}} from
 * @param {Array<{left: number, top: number, width: number, height: number}>} boxes
 * @param {'left' | 'right' | 'up' | 'down'} direction
 * @returns {number} the index of the box to move to, or -1 to stay
 */
function nextFocus(from, boxes, direction) {
  const SLACK = 1;
  const centre = (b) => ({ x: b.left + b.width / 2, y: b.top + b.height / 2 });
  const at = centre(from);
  let best = -1;
  let bestScore = Infinity;
  boxes.forEach((box, i) => {
    const beyond =
      direction === 'right' ? box.left >= from.left + from.width - SLACK
        : direction === 'left' ? box.left + box.width <= from.left + SLACK
          : direction === 'down' ? box.top >= from.top + from.height - SLACK
            : box.top + box.height <= from.top + SLACK;
    if (!beyond) return;
    const c = centre(box);
    const along = Math.abs(direction === 'left' || direction === 'right' ? c.x - at.x : c.y - at.y);
    const across = Math.abs(direction === 'left' || direction === 'right' ? c.y - at.y : c.x - at.x);
    const score = along + 2 * across;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

function boxOf(node) {
  const r = node.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

function moveFocus(direction) {
  const all = focusables();
  if (all.length === 0) return;
  const at = document.activeElement;
  if (!at || !all.includes(at)) return void focusDefault();
  const others = all.filter((node) => node !== at);
  const to = nextFocus(boxOf(at), others.map(boxOf), direction);
  if (to >= 0) others[to].focus({ preventScroll: true });
}

/**
 * Where she was on each screen, by what has the focus there: put back when
 * that screen is drawn again or comes back (home/focusMemory.ts) — not the
 * first film, and not wherever the focus was passed on its way.
 */
const focusMemory = {};
/** The focus being put somewhere by this page, not moved by her: not remembered as where she was. */
let placingFocus = false;
const focusKeyOf = (node) => node?.dataset?.key ?? node?.dataset?.action;

/** Where the focus starts on what has just been put on the screen: where she was, else a card's first button or the film she last watched. */
function focusDefault(heldKey) {
  const all = focusables();
  const held = heldKey ? all.find((node) => node.dataset.key === heldKey) : undefined;
  const start = held ?? all.find((node) => node.dataset.key === `programme:${lastWatchedId}`) ?? all.find((node) => node.classList.contains('home-tile')) ?? all[0];
  placingFocus = !held;
  try {
    start?.focus({ preventScroll: true });
  } finally {
    placingFocus = false;
  }
}

/** OK held down: since when, and on what screen. A press must begin on the screen it ends on (press/held.ts). */
let okDown = null;

/** OK held for two seconds: Hold for Sarah, when OK is free to be held — no card has it (watch/hold.ts). */
const okHold = TV.okHold({
  canHold: () => !family && Boolean(ws) && currentQueuedCard === null && !easierOpen,
  onHold: () => askAbout(reachAsked, { t: 'reach' }),
});

/** OK: the film's, over a film with nothing on it; otherwise the press of whatever has the focus. */
function pressOk() {
  if (film && !currentQueuedCard) return toggleFilm();
  const at = document.activeElement;
  if (at && tvScreen.contains(at) && typeof at.click === 'function') at.click();
}

/** Play/Pause: the card's to read, or the film's (watch/remoteKeys.ts). */
function pressPlay() {
  const card = currentQueuedCard;
  const open = Boolean(ws) && ws.readyState === WebSocket.OPEN;
  const holdsFilm = Boolean(film) && breaks.holdsProgramme(card ?? undefined);
  const playReads = TV.playIsTheCards({ card: card && open ? card.card.id : undefined, holdsFilm, askedFor });
  const goes = TV.playGoesTo('playpause', { cardVisible: card !== null, playReads, reading: reading !== null });
  if (goes.reader === 'toggle') {
    toggleRead();
    if (card) askedFor = card.card.id;
  } else if (goes.reader === 'stop') {
    stopRead();
  }
  if (goes.film && film) toggleFilm();
}

/** Back, in the order the Vega app asks: an opened card, then the screen under it. Back on her home screen goes nowhere. */
function pressBack() {
  const card = currentQueuedCard;
  if (card) {
    if (TV.backClosesOpened({ openedId, shownId: card.card.id, liveOpen: false })) {
      // On the card her hold brought, Back is an answer (home/reach.ts): pressed as its button is, by the same second.
      const answer = TV.backAnswersReach(card.card);
      if (answer) return void tvScreen.querySelector(`button[data-action="${answer}"]`)?.click();
      openedId = null;
      return look();
    }
    // A card that came to her: Back is its "Not now", pressed as its button is (settle and all), or
    // nothing. Never the film underneath, which it used to end (home/waiting.ts backOnShownCard).
    const notNow = TV.backOnShownCard(card.card);
    // On a note, which has no such button, "later": it goes to her home screen's quiet line, unanswered.
    if (notNow && TV.putsAway(card.card, notNow)) return putNoteAway(card, notNow);
    if (notNow) tvScreen.querySelector(`button[data-action="${notNow}"]`)?.click();
    return;
  }
  if (easierOpen) return closeEasier();
  if (mantelView) return closeMantel();
  if (film) return stopFilm();
}

/**
 * "Later" on a note, as the Vega app does it (ResidentApp.tsx handleAction): held to the card's one second like
 * any press, told to the server, and the note kept as one that has had its two showings (home/waiting.ts
 * putAway), so it waits on the home screen and is not brought to her again by itself.
 */
function putNoteAway(queued, action) {
  if (!settle.acts(Date.now())) return;
  answeredAt = Date.now();
  send({ t: 'card_action', cardId: queued.card.id, action, at: Date.now() });
  keptCards = keptCards.map((q) => (q.card.id === queued.card.id ? TV.putAway(q) : q));
  showingFrom.delete(queued.card.id);
  breaks.answered(queued.card.id);
  look();
}

function seek(direction) {
  const video = watching?.video;
  if (!video) return;
  video.currentTime = TV.seekTarget(video.currentTime * 1000, direction, watching.programme.durationMs ?? 0) / 1000;
}

const ARROWS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
const isPlayKey = (key) => key === ' ' || key === 'p' || key === 'P' || key === 'MediaPlayPause';

function remoteDown(event) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === '?') {
    event.preventDefault();
    return toggleKeys();
  }
  // A family member's own television has its own keys (tv-core.js familyKey).
  if (family) return;
  if (event.key === 'Enter') {
    // Acted on as the key comes up: until then it may be a hold.
    event.preventDefault();
    if (event.repeat) return;
    okDown = { screen: screenKey() };
    return okHold.onEvent({ eventType: 'enter', eventKeyAction: 0 });
  }
  // Another key: whatever she is doing, it is not holding OK.
  okHold.onEvent({ eventType: event.key, eventKeyAction: 0 });
  if (isPlayKey(event.key)) {
    event.preventDefault();
    if (!event.repeat) pressPlay();
    return;
  }
  if (event.key === 'Backspace' || event.key === 'Escape') {
    event.preventDefault();
    if (!event.repeat) pressBack();
    return;
  }
  const direction = ARROWS[event.key];
  if (!direction) return;
  event.preventDefault();
  if (film && !currentQueuedCard) {
    if (direction === 'left' || direction === 'right') seek(direction === 'right' ? 'forward' : 'back');
    return;
  }
  moveFocus(direction);
}

function remoteUp(event) {
  // The browser's own press of a focused button, on Space coming up: Space is Play here.
  if (isPlayKey(event.key)) event.preventDefault();
  if (family || event.key !== 'Enter') return;
  event.preventDefault();
  const began = okDown;
  okDown = null;
  const wasHold = okHold.held();
  okHold.onEvent({ eventType: 'enter', eventKeyAction: 1 });
  // A hold is not a press; nor is a key that went down on another screen.
  if (wasHold || !began || began.screen !== screenKey()) return;
  pressOk();
}

/*
 * The second a card's buttons take no press, for every press however it
 * comes — a key, or a click — caught on its way down to the button, before
 * the button hears of it. The mark that reads a card aloud is not a button.
 */
function settleClick(event) {
  if (event.target?.closest?.('.tv-read')) return;
  if (settle.acts(Date.now())) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

/* --- The legend of the keys ---------------------------------------------- */

const keysPanel = document.getElementById('tv-keys');
/** Put away by hand once: not shown again by itself, except on the pairing screen. */
let keysDismissed = recall(KEYS_SEEN_KEY) === '1';
/** Shown or put away by hand ("?", "Got it") on the screen in front now: that holds until the pairing screen comes or goes. */
let keysForced = null;
let keysOver = null;

/** Shown on the pairing screen, and the first time anything else is; put away only by hand, or by "?". */
function showKeys() {
  const pairing = Boolean(tvScreen.querySelector('.tv-pairing, .tv-getting-code'));
  if ((pairing ? 'pairing' : 'television') !== keysOver) {
    keysOver = pairing ? 'pairing' : 'television';
    keysForced = null;
  }
  const shown = keysForced ?? (pairing || !keysDismissed);
  keysPanel.hidden = !shown;
  document.getElementById('stage').classList.toggle('keys-shown', shown);
}

function dismissKeys() {
  keysDismissed = true;
  keysForced = false;
  keep(KEYS_SEEN_KEY, '1');
  showKeys();
  // "Got it" pressed with a mouse took the focus off her screen with it: the remote's ring goes back where it was.
  const at = document.activeElement;
  if (!at || at === document.body || !tvScreen.contains(at)) focusDefault(focusMemory[screenKey()]);
}

function toggleKeys() {
  if (keysPanel.hidden) {
    keysForced = true;
    showKeys();
  } else {
    dismissKeys();
  }
}

/* --- Pairing ------------------------------------------------------------- */

let pairingLoop = false;

/** The calm screen while there is no code to show: getting one, or the home cannot be reached just now. */
function showUnpaired(key) {
  const screen = el('div', 'tv-card urgency-deferred tv-getting-code');
  screen.appendChild(el('div', 'kicker', say('pairing.title')));
  screen.appendChild(el('div', 'headline', say(key)));
  show(screen);
}

/** A television that is not paired shows its code and waits — and when a code runs out, shows another. */
async function pairUntilPaired() {
  if (pairingLoop) return;
  pairingLoop = true;
  try {
    showUnpaired('pairing.gettingCode');
    while (!ws && !family) {
      if (await pairAndConnect()) break;
      showUnpaired('pairing.stillTrying');
      await sleep(5000);
    }
  } finally {
    pairingLoop = false;
  }
}

/** The channel closed. Refused: it is paired again. Lost: it tries again, while this tab is still that television. */
function channelClosed(opened) {
  clearInterval(tick);
  tick = null;
  ws = null;
  if (!opened) return void pairUntilPaired();
  setTimeout(() => {
    const television = rememberedTelevision();
    if (ws || family || !television || television.kind !== 'resident') return;
    connectWebSocket(television.jwt, television.deviceId, television.proof);
  }, 5000);
}

function channelOpened() {
  const now = Date.now();
  breaks.setForeground(!document.hidden, now);
  send({ t: 'app_lifecycle', state: 'fg', at: now });
  clearInterval(tick);
  tick = setInterval(() => {
    sample();
    look();
  }, 1000);
  homeDrawn = '';
  look();
}

/* --- Wiring -------------------------------------------------------------- */

useTvPage({
  filmControls: false,
  keep: keepArrived,
  showKept: look,
  home: renderHome,
  connected: channelOpened,
  closed: channelClosed,
  // Disconnected from the family app: the pairing screen again, with a new code, as on Vega.
  gone() {
    clearInterval(tick);
    tick = null;
    keptCards = [];
    currentQueuedCard = null;
    void pairUntilPaired();
  },
  filmStarted,
  filmStopped,
  filmFailed,
  filmBlocked,
  pressed(card, actionId, finished) {
    // She answered a card herself: a film it was holding may go on when it goes (holdFilm).
    answeredAt = Date.now();
    // Any answer on the card her hold brought ends the little while in which the newest one is brought forward.
    if (card.type === 'REACH') reachAsked.done();
    // Her answer ends the showing, so the same card sent back is shown afresh (BreakController.answered).
    if (finished) breaks.answered(card.id);
  },
  shown(node) {
    const now = Date.now();
    settle.appeared(screenKey(), now);
    const at = document.activeElement;
    // Her mantelpiece's picture is OK on the television: it can be reached with the D-pad.
    for (const picture of node?.querySelectorAll?.('.tv-mantel .tv-photo img') ?? []) {
      picture.dataset.focusable = 'true';
      picture.tabIndex = 0;
    }
    if (!at || at === document.body || !tvScreen.contains(at) || !at.isConnected) focusDefault(focusMemory[screenKey()]);
    showKeys();
  },
});

document.addEventListener('keydown', remoteDown);
document.addEventListener('keyup', remoteUp);
tvScreen.addEventListener('click', settleClick, true);
// A mouse is a pointer at the remote's focus: where it moves to, the ring goes. Only when it moves — a mouse left
// resting over the screen must not take the focus from the remote whenever the screen is drawn again under it.
tvScreen.addEventListener('mousemove', (event) => {
  const target = event.target?.closest?.('button, [data-focusable]');
  if (target && target !== document.activeElement && tvScreen.contains(target) && !target.disabled) target.focus({ preventScroll: true });
});
tvScreen.addEventListener('focusin', (event) => {
  const key = focusKeyOf(event.target);
  if (key !== undefined && !placingFocus) focusMemory[screenKey()] = key;
});
document.getElementById('tv-keys-close').addEventListener('click', dismissKeys);
document.addEventListener('visibilitychange', () => {
  const now = Date.now();
  // Behind another tab is behind another app: nothing is shown to nobody, and she is looking afresh when it is back.
  breaks.setForeground(!document.hidden, now);
  if (!ws) return;
  send({ t: 'app_lifecycle', state: document.hidden ? 'bg' : 'fg', at: now });
  if (!document.hidden) settle.returned(now);
});

applySeeing();
void loadCatalogue();
if (rememberedTelevision()) restoreTelevision();
else void pairUntilPaired();
showKeys();
