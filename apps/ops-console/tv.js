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
 *   her day — "Good morning, Margaret.", the date, and who is coming
 *   (home/herDay.ts) — or, from a server that says no day, "What would you
 *   like to watch?"; her light in the window, the three films, who looked
 *   in, a card that has waited its two showings, her mantelpiece — and
 *   "Easier to see".
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
 * - Play over a card is always the card's: it reads it aloud, and the next
 *   Play stops the reading (packages/contracts speech.ts). It never moves the
 *   film under a card — one key, one meaning (watch/remoteKeys.ts
 *   playIsTheCards). OK or the card's own buttons carry on with the film.
 * - "Easier to see": larger text (every size times 1.25) and higher
 *   contrast (black and white, a thicker ring), kept on this device only.
 * - A legend of the keys, the first time and on the pairing screen,
 *   dismissed by hand — never on a timer.
 * - What the redesign gave the Vega app (docs/design/DESIGN.md §6), from the
 *   same pure modules (watch/transport.ts, watch/hold.ts, home/order.ts,
 *   tour/tour.ts): the film's bar — its title, the time gone and how long
 *   is left — on a pause, a skip, ↑ or ↓, gone after four seconds of play;
 *   the line that fills while OK is held, from 0.4 s; her films in her
 *   order, a film left part-way first with "Carry on" and how long is
 *   left; and "How Wick works", a tour of examples with nothing sent.
 *
 * Around the screen, for whoever is trying it and not part of her
 * television: a line that says it is a stand-in (DESIGN.md §1, principle
 * 5), and a remote that a mouse or a finger can press — the D-pad, OK
 * (held, too), Back, Play/Pause and the two skip keys — each press handled
 * exactly as the key it stands for. Phones and tablets have no keyboard.
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
/** How often each film was started at each part of the day (home/order.ts): counted here, sent nowhere. */
const TALLY_KEY = 'wick_tv_watch_tally';
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

/** Her films in her order: a count of what she started, morning, afternoon and evening, kept on this device. */
const watchTally = new TV.WatchTally({
  read: () => deviceStorage()?.getItem(TALLY_KEY) ?? null,
  write: (text) => deviceStorage()?.setItem(TALLY_KEY, text),
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
  // The screen, and the line that fills over it while OK is held, which is drawn over the screen and not in it.
  for (const node of [tvScreen, document.getElementById('stage').querySelector('.tv-hold')]) {
    node?.classList.toggle('larger-text', seeing.larger);
    node?.classList.toggle('higher-contrast', seeing.contrast);
  }
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
        if (!currentQueuedCard && !film && channelOpen()) renderEmpty();
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
/**
 * The card Play has already asked to have read, this showing of it. Kept for playIsTheCards' signature only: the rule
 * no longer looks at it — Play over a card is the card's every time, never the film's (watch/remoteKeys.ts).
 */
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
  if (family || !channelOpen()) return;
  const now = Date.now();
  keptCards = keptCards.filter((q) => typeof q.expiresAt !== 'number' || q.expiresAt > now);
  // A screen she asked for — her mantelpiece, "Easier to see", the tour — keeps a note waiting behind it. The door comes over it.
  const picked = TV.overMantel(breaks.pickCard(keptCards, now), mantelView !== null || easierOpen || tour.open);

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
  } else if (!shown && !film && !mantelView && !easierOpen && !tour.open) {
    // The home screen's words can change with nothing arriving: the day ends, a card has waited its two showings.
    if (homeSignature() !== homeDrawn) renderEmpty();
  }

  holdFilm();
  sayFilmNotice();
  drawBar(now);

  // Her day: asked for again when it is over, a little after a new card, and now and then (home/herDay.ts herDayAsker).
  if (dayAsker.look({ now, today: home.today, cardIds: keptCards.map((q) => q.id), onScreen: !document.hidden })) send({ t: 'home', at: now });

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
  // At the foot of the film: what it says over itself, and its bar under that (watch/transport.ts).
  const foot = el('div', 'film-foot');
  const notice = el('div', 'film-notice');
  const bar = el('div', 'film-bar');
  bar.hidden = true;
  bar.setAttribute('role', 'status');
  foot.append(notice, bar);
  started.layer.appendChild(foot);
  // Back is the remote's Back here, and who watches with her is said in the notice, as on Vega: the console's two
  // lines over the film are not this television's, and are never reached by the D-pad.
  started.back.hidden = true;
  if (started.withLine) started.withLine.hidden = true;
  watching = {
    film: started,
    video: started.video,
    programme,
    notice,
    bar,
    /** When she last asked where the film is — ↑, ↓, a skip — for the bar (transportShown). */
    askedAt: null,
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
  // The bar's time moves with the film, not only once a second.
  started.video.addEventListener('timeupdate', () => {
    if (watching === mine) drawBar(Date.now());
  });
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

/**
 * The film's bar (watch/transport.ts, DESIGN.md §6): its title, the time
 * gone, how long is left, and a line that fills as it goes. It comes on a
 * pause, a skip, ↑ or ↓, goes four seconds into play again, stays while
 * the film is paused, and never covers a card.
 */
function drawBar(now = Date.now()) {
  const mine = watching;
  if (!mine) return;
  const video = mine.video;
  const ready = mine.status === 'playing' || mine.status === 'paused';
  const shown = TV.transportShown({ paused: video.paused, cardVisible: currentQueuedCard !== null, ready, askedAt: mine.askedAt, now });
  mine.bar.hidden = !shown;
  if (!shown) return;
  const durationMs = mine.programme.durationMs || (Number.isFinite(video.duration) ? video.duration * 1000 : 0);
  const positionMs = (Number(video.currentTime) || 0) * 1000;
  const values = { title: mine.programme.title, elapsed: TV.clock(positionMs), total: TV.clock(durationMs), minutes: TV.minutesLeft(positionMs, durationMs) };
  const drawn = JSON.stringify([tvLanguage(), values, video.paused]);
  if (mine.bar.dataset.drawn !== drawn) {
    mine.bar.dataset.drawn = drawn;
    mine.bar.setAttribute('aria-label', say('watch.barLabel', values));
    const top = el('div', 'film-bar-top');
    const state = el('span', 'film-bar-state');
    const mark = icon(video.paused ? 'pause' : 'play');
    if (mark) state.appendChild(mark);
    top.append(state, el('span', 'film-bar-title', values.title), el('span', 'film-bar-time', say('watch.time', values)), el('span', 'film-bar-left', say('watch.left', values)));
    const track = el('div', 'film-bar-track');
    track.appendChild(el('div', 'film-bar-fill'));
    mine.bar.replaceChildren(top, track);
  }
  mine.bar.style.setProperty('--fill', String(TV.fraction(positionMs, durationMs)));
}

/** She asked where the film is (↑, ↓, a skip): the bar comes, and stays four seconds into play. */
function askWhereFilmIs() {
  if (!watching) return;
  watching.askedAt = Date.now();
  drawBar(watching.askedAt);
}

/* --- The home screen ----------------------------------------------------- */

/** What the home screen last drew, so a look that changes nothing draws nothing. */
let homeDrawn = '';

/** When to ask the server for her day again (home/herDay.ts). */
const dayAsker = TV.herDayAsker();

function homeSignature() {
  const now = Date.now();
  return JSON.stringify([
    tvLanguage(),
    TV.homeDay(home.today, now, tvLanguage()) ?? null,
    catalogue.map((p) => p.id),
    home.light ? lightLabel(now) : null,
    lookedInLine(now),
    waitingCard ? TV.waitingLine(waitingCard, tvLanguage()) : null,
    Number.isInteger(home.mantel) && home.mantel >= 1,
    orderedFilms(now).map((o) => [o.programme.id, o.resumeAtMs ?? null]),
  ]);
}

/** Her films in her order (home/order.ts): one she left part-way first, then what she watches at this time of day. */
function orderedFilms(now = Date.now()) {
  return TV.orderProgrammes(catalogue, { startAt: (id) => filmPositions.startAt(id), tally: watchTally.get(), hour: new Date(now).getHours() });
}

/** One of the Lucide icons (vendor/icons.generated.js), or nothing on a page without them. Never alone: always beside a word. */
function icon(name) {
  return typeof WickIcons === 'undefined' ? null : WickIcons.icon(name);
}

/** A pill on the home screen: an icon and its word. */
function pillWords(button, iconName, words) {
  const mark = icon(iconName);
  button.replaceChildren(...(mark ? [mark] : []), el('span', 'pill-words', words));
}

/** A thing on the home screen to press. `key` keeps the remote's place when the screen is drawn again. */
function homeButton(className, key, onPress) {
  const button = el('button', className);
  button.type = 'button';
  button.dataset.key = key;
  button.addEventListener('click', onPress);
  return button;
}

/** Her light in the window, as a pill: OK opens the card that says who can see it. */
function lightPill(now) {
  const light = homeButton('home-pill', 'light', () => askAbout(lightAsked, { t: 'light' }));
  pillWords(light, 'flame', lightLabel(now));
  light.setAttribute('aria-label', say('home.lightLabel', { light: lightLabel(now) }));
  return light;
}

/**
 * The home screen, as the Vega app shows it (HomeScreen.tsx): her day at the
 * top when the server says one — the greeting, the date, who is coming —
 * and otherwise the question, as it always was.
 */
function renderHome() {
  if (easierOpen) return renderEasier();
  if (tour.open) return renderTour();
  const now = Date.now();
  homeDrawn = homeSignature();
  const screen = el('div', 'tv-home');
  const day = TV.homeDay(home.today, now, tvLanguage());

  const top = el('div', 'home-top');
  let panel = null;
  if (day) {
    const greeting = el('div', 'home-question home-greeting', day.greeting);
    greeting.setAttribute('role', 'heading');
    const date = el('div', 'home-date', day.date);
    top.append(greeting, date);
    // Who is coming: read, never pressed.
    if (day.coming.length > 0) {
      panel = el('div', 'home-day');
      for (const line of day.coming) panel.appendChild(el('div', 'home-day-line', line));
    }
  } else {
    top.appendChild(el('div', 'home-question', say('home.question')));
    // The one button beside the question.
    if (home.light) top.appendChild(lightPill(now));
  }
  screen.appendChild(top);
  if (panel) screen.appendChild(panel);

  const row = el('div', 'home-row');
  for (const { programme, resumeAtMs } of orderedFilms(now)) {
    const tile = homeButton('home-tile', `programme:${programme.id}`, () => {
      // Counted for her order on this device, and sent nowhere (home/order.ts).
      watchTally.started(programme.id, new Date().getHours());
      // Nobody follows a film she chose here: only "Start the film", on a card that says who will see it, does that.
      startFilm({ programmeId: programme.id });
      renderEmpty();
    });
    const minutes = resumeAtMs === undefined ? 0 : TV.minutesLeft(resumeAtMs, programme.durationMs);
    // Its name and how long it runs — or that she can carry on, and how long is left — as the Vega tile tells a
    // screen reader, said even when the line under it gives way.
    tile.setAttribute('aria-label', resumeAtMs === undefined ? `${programme.title}. ${TV.programmeLine(programme, tvLanguage())}` : say('home.carryOnLabel', { title: programme.title, minutes }));
    const picture = el('div', 'home-picture');
    const poster = el('img', 'home-poster');
    poster.alt = '';
    poster.src = `posters/${programme.id}.jpg`;
    picture.appendChild(poster);
    if (resumeAtMs !== undefined) {
      // "Carry on", on the picture of the film she left part-way, with the Play mark beside the word.
      const chip = el('div', 'home-chip');
      const mark = icon('play');
      if (mark) chip.appendChild(mark);
      chip.appendChild(el('span', undefined, say('home.carryOn')));
      picture.appendChild(chip);
      // How far she got: a line along the foot of its picture (DESIGN.md §6).
      const track = el('div', 'home-progress');
      const fill = el('div', 'home-progress-fill');
      fill.style.setProperty('--fill', String(TV.fraction(resumeAtMs, programme.durationMs)));
      track.appendChild(fill);
      picture.appendChild(track);
    }
    tile.appendChild(picture);
    const caption = el('div', 'home-caption');
    caption.appendChild(el('div', 'home-title', programme.title));
    caption.appendChild(
      resumeAtMs === undefined
        ? el('div', 'home-line', TV.programmeLine(programme, tvLanguage()))
        : el('div', 'home-line home-carry-on', say('home.left', { minutes })),
    );
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
  // With her day at the top, her light joins the other pills: the greeting and the date have that row, as on Vega.
  if (day && home.light) quiet.appendChild(lightPill(now));
  if (Number.isInteger(home.mantel) && home.mantel >= 1) {
    const mantelPill = homeButton('home-pill', 'mantel', openMantel);
    pillWords(mantelPill, 'image', say('home.mantel'));
    mantelPill.setAttribute('aria-label', say('home.mantelLabel'));
    quiet.appendChild(mantelPill);
  }
  const easier = homeButton('home-pill', 'easier', openEasier);
  pillWords(easier, 'eye', easierSay('title'));
  easier.setAttribute('aria-label', easierSay('title'));
  quiet.appendChild(easier);
  // How Wick works: a tour of examples, with the remote alone, and nothing sent (tour/tour.ts).
  const tourPill = homeButton('home-pill', 'tour', openTour);
  pillWords(tourPill, 'circle-question-mark', say('home.tour'));
  tourPill.setAttribute('aria-label', say('home.tourLabel'));
  quiet.appendChild(tourPill);
  screen.appendChild(quiet);

  show(screen);
  fitPills(quiet);
  if (day) fitDay(screen, top, panel, day);
}

/**
 * The pills give way before the quiet line does (as on Vega, home/homeLayout.ts pillsWithWords): where the row has
 * no room for every pill's words and who looked in, the pills show their icons, and each its words when it has the
 * focus. Every pill keeps its name for a screen reader, and the line its words.
 */
function fitPills(row) {
  row.classList.remove('tight');
  if (typeof row.scrollWidth !== 'number') return;
  const line = row.querySelector('.home-said, .home-waiting-line');
  const cut = (node) => Boolean(node) && node.scrollWidth > node.clientWidth + 1;
  if (row.scrollWidth > row.clientWidth + 1 || cut(line)) row.classList.add('tight');
}

/** A film's picture shorter than this share of the screen is a sliver, not a picture (homeLayout.ts POSTER_MIN_DP of 540). */
const POSTER_MIN_SHARE = 60 / 540;

/**
 * Her day, made to fit as the Vega app's careLayout makes it (homeLayout.ts),
 * here by looking at what the page drew. Never a word cut, in this order:
 * where the greeting with her name and the date do not share the row, the
 * greeting goes without her name; where even that does not fit, the date
 * leads the panel under it. Then the films' words must be whole: lines about
 * who is coming go from the last until they are — the soonest never for a
 * later one, and the date never — once how long each film runs has given
 * way, as the Vega app never draws it. And a picture too short to be one is
 * not shown at all.
 */
function fitDay(screen, top, panel, day) {
  const greeting = top.querySelector('.home-greeting');
  const date = top.querySelector('.home-date');
  if (!greeting || !date || typeof top.scrollWidth !== 'number') return;
  const overflows = () => top.scrollWidth > top.clientWidth + 1 || greeting.scrollWidth > greeting.clientWidth + 1;
  if (overflows()) {
    greeting.textContent = day.greetingPlain;
    if (overflows()) {
      date.remove();
      greeting.textContent = day.greeting;
      if (overflows()) greeting.textContent = day.greetingPlain;
      const lead = el('div', 'home-day-line home-day-date', day.date);
      if (panel) panel.prepend(lead);
      else {
        panel = el('div', 'home-day');
        panel.appendChild(lead);
        top.after(panel);
      }
    }
  }
  const tiles = [...screen.querySelectorAll('.home-tile')];
  const filmsWhole = () => tiles.every((tile) => tile.scrollHeight <= tile.clientHeight + 1);
  // How long each film runs is said to a screen reader in its label, and the Vega app draws only the title: it goes first.
  if (panel && !filmsWhole()) for (const line of screen.querySelectorAll('.home-tile .home-line')) line.hidden = true;
  while (panel && !filmsWhole()) {
    const last = [...panel.querySelectorAll('.home-day-line')].filter((line) => !line.classList.contains('home-day-date')).pop();
    if (!last) break;
    last.remove();
  }
  if (panel && panel.children.length === 0) panel.remove();
  const sliver = screen.clientHeight * POSTER_MIN_SHARE;
  const posters = [...screen.querySelectorAll('.home-poster')];
  if (posters.some((poster) => poster.clientHeight < sliver)) for (const poster of posters) poster.hidden = true;
}

/** Her press on the light, or her hold: a question to the server, whose answering card is hers to see at once. */
function askAbout(asked, event) {
  if (!channelOpen()) return;
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

/* --- How Wick works ------------------------------------------------------ */

/*
 * The tour (tour/tour.ts): an example of each thing Wick does — the door, a
 * note at a calm point, holding OK, reading aloud — drawn as that thing is
 * drawn and marked "Example", then a last word. OK presses the step's first
 * button ("Show me the next"), Back closes it. Nothing in it is sent, asked
 * for or kept: its words are the Vega app's, and its one picture is the
 * stand-in doorbell's made picture of a parcel (parcel.jpg), from this
 * page's own origin. Play reads nothing here: a reading is made by the
 * server, and nothing in the tour goes to the server.
 */
let tour = TV.TOUR_CLOSED;

function openTour() {
  tour = TV.tourAfter(tour, 'open');
  renderTour();
}

function closeTour() {
  tour = TV.TOUR_CLOSED;
  homeDrawn = '';
  renderEmpty();
  look();
}

function tourPress(press) {
  tour = TV.tourAfter(tour, press);
  if (tour.open) renderTour();
  else closeTour();
}

/** Who an example names: nobody in particular — the page does not know her circle — so "your family". */
const tourName = () => say('tour.family');

/** A line of an example: its icon, and its words. */
function exampleLine(iconName, words, className = 'tour-example-line') {
  const line = el('div', className);
  const mark = icon(iconName);
  if (mark) line.appendChild(mark);
  line.appendChild(el('span', undefined, words));
  return line;
}

/** The example itself, drawn as the thing it is an example of: the step's headline is its first line. */
function tourExample(step) {
  const example = el('div', `tour-example tour-${step.kind}`);
  if (step.kind === 'door') {
    // The door's card: the picture from the door beside what it shows.
    const picture = el('img', 'tour-picture');
    picture.alt = '';
    picture.src = 'parcel.jpg';
    example.append(picture, exampleLine('bell', say(step.exampleKey)));
  } else if (step.kind === 'note') {
    example.appendChild(exampleLine('message-square', say(step.exampleKey)));
  } else if (step.kind === 'hold') {
    // The line that fills while OK is held, as it looks two thirds of the way.
    const line = el('div', 'hold-line');
    const track = el('div', 'hold-track');
    track.appendChild(el('div', 'hold-fill'));
    line.style.setProperty('--fill', '0.66');
    line.append(exampleLine('phone', say('hold.keepPlain'), 'hold-words'), track);
    example.appendChild(line);
  } else if (step.kind === 'read') {
    // The mark every card carries in its corner.
    example.appendChild(exampleLine('volume-2', say('read.chip'), 'tour-chip'));
  }
  return example;
}

function renderTour() {
  if (!tour.open) return;
  const index = tour.index;
  const step = TV.TOUR_STEPS[index];
  const card = el('div', 'tv-card urgency-deferred tv-tour');
  card.dataset.anim = `tour:${index}`;
  const top = el('div', 'tour-top');
  top.appendChild(el('div', 'kicker', say('tour.kicker', { step: index + 1, count: TV.TOUR_STEPS.length })));
  if (step.kind !== 'done') top.appendChild(el('div', 'tour-mark', say('tour.example')));
  card.appendChild(top);
  const headline = el('div', 'headline', say(step.headlineKey, { name: tourName() }));
  headline.setAttribute('role', 'heading');
  headline.setAttribute('aria-level', '2');
  card.appendChild(headline);
  if (step.kind !== 'done') card.appendChild(tourExample(step));
  card.appendChild(el('div', 'body-text', say(step.detailKey, { name: tourName() })));
  const actions = el('div', 'actions');
  for (const action of TV.tourActions(index)) {
    const button = homeButton(`pill ${action.kind === 'primary' ? 'primary' : ''}`, `tour-${action.id}`, () => tourPress(action.id));
    button.textContent = say(action.labelKey);
    actions.appendChild(button);
  }
  card.appendChild(actions);
  show(card);
  // Each step starts on its first button: OK is "Show me the next".
  focusDefault(`tour-${TV.tourActions(index)[0].id}`);
}

/* --- The remote ---------------------------------------------------------- */

/** What is on screen to be pressed, by name: the settle second, and where a press began, are counted by it. */
function screenKey() {
  if (family) return 'family';
  if (currentQueuedCard) return `card:${currentQueuedCard.card.id}`;
  if (easierOpen) return 'easier';
  if (tour.open) return 'tour';
  if (mantelView) return 'mantel';
  if (film) return 'film';
  if (!channelOpen()) return 'unpaired';
  return 'home';
}

const focusables = () => [...tvScreen.querySelectorAll('button:not([disabled]):not([hidden]), [data-focusable]')].filter((node) => !node.closest('[hidden]') && !node.closest('.tv-leaving'));

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
  canHold: () => !family && channelOpen() && currentQueuedCard === null && !easierOpen && !tour.open,
  onHold: () => askAbout(reachAsked, { t: 'reach' }),
  // The line that fills while it is held, from 0.4 s (holdProgress): a press becoming a hold can be seen, and let go.
  onBegin: (at) => beginHoldLine(at),
  onEnd: () => endHoldLine(),
});

/** OK: the film's, over a film with nothing on it; otherwise the press of whatever has the focus. */
function pressOk() {
  if (film && !currentQueuedCard) return toggleFilm();
  const at = document.activeElement;
  if (at && tvScreen.contains(at) && typeof at.click === 'function') at.click();
}

/** Play/Pause: over a card, always the card's — read it, or stop reading it; with no card, the film's (watch/remoteKeys.ts). */
function pressPlay() {
  const card = currentQueuedCard;
  const open = channelOpen();
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
  if (tour.open) return closeTour();
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
/** The two skip keys, where a keyboard has them. */
const SKIPS = { MediaRewind: 'rewind', MediaTrackPrevious: 'rewind', MediaFastForward: 'forward', MediaTrackNext: 'forward' };

/**
 * One press of the remote by name — up, down, left, right, back, play, rewind, forward — however it came: a key,
 * or a button of the remote beside the screen. Each means one thing on each screen (DESIGN.md §6).
 */
function pressRemote(name) {
  // Whatever she is doing, it is not holding OK.
  okHold.onEvent({ eventType: name, eventKeyAction: 0 });
  if (name === 'play') return pressPlay();
  if (name === 'back') return pressBack();
  const overFilm = Boolean(film) && !currentQueuedCard;
  if (name === 'rewind' || name === 'forward') {
    // The skip keys are the film's: thirty seconds, and the bar says where that is. Elsewhere they do nothing.
    if (overFilm) {
      seek(name === 'forward' ? 'forward' : 'back');
      askWhereFilmIs();
    }
    return;
  }
  if (overFilm) {
    // Over a film ← and → skip thirty seconds, and ↑ and ↓ ask where it is (watch/transport.ts asksWhereFilmIs).
    if (name === 'left' || name === 'right') {
      seek(name === 'right' ? 'forward' : 'back');
      askWhereFilmIs();
    } else if (TV.asksWhereFilmIs({ eventType: name, eventKeyAction: 0 }, { cardVisible: false })) {
      askWhereFilmIs();
    }
    return;
  }
  moveFocus(name);
}

/** OK going down: acted on as it comes up, because until then it may be a hold. */
function okPressed() {
  okDown = { screen: screenKey() };
  okHold.onEvent({ eventType: 'enter', eventKeyAction: 0 });
}

/** OK coming up: a press — unless it became a hold, or went down on another screen. */
function okReleased() {
  const began = okDown;
  okDown = null;
  const wasHold = okHold.held();
  okHold.onEvent({ eventType: 'enter', eventKeyAction: 1 });
  // A hold is not a press; nor is a key that went down on another screen.
  if (wasHold || !began || began.screen !== screenKey()) return;
  pressOk();
}

/** A press on the page's OK that never came up on it (the finger slid off, the browser took it): nothing at all. */
function okAbandoned() {
  okDown = null;
  okHold.cancel();
}

/** A key on a button of the remote beside the screen, which has the browser's focus: the button's, not the screen's. */
const onRemoteButton = (event) => Boolean(event.target?.closest?.('.remote')) && (event.key === 'Enter' || event.key === ' ');

function remoteDown(event) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === '?') {
    event.preventDefault();
    return toggleKeys();
  }
  // A family member's own television has its own keys (tv-core.js familyKey).
  if (family || onRemoteButton(event)) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    if (event.repeat) return;
    return okPressed();
  }
  if (isPlayKey(event.key)) {
    event.preventDefault();
    if (!event.repeat) pressRemote('play');
    return;
  }
  if (event.key === 'Backspace' || event.key === 'Escape') {
    event.preventDefault();
    if (!event.repeat) pressRemote('back');
    return;
  }
  const name = ARROWS[event.key] ?? SKIPS[event.key];
  if (!name) {
    // Another key: whatever she is doing, it is not holding OK.
    okHold.onEvent({ eventType: event.key, eventKeyAction: 0 });
    return;
  }
  event.preventDefault();
  pressRemote(name);
}

function remoteUp(event) {
  if (onRemoteButton(event)) return;
  // The browser's own press of a focused button, on Space coming up: Space is Play here.
  if (isPlayKey(event.key)) event.preventDefault();
  if (family || event.key !== 'Enter') return;
  event.preventDefault();
  okReleased();
}

/* --- The line that fills while OK is held (watch/hold.ts holdProgress) ------- */

/*
 * Holding OK asks someone to ring her (Hold for Sarah). A hand that trembles
 * holds a key by accident, so from 0.4 s a line fills along the foot of the
 * screen and says what holding does; let go before two seconds and nothing
 * happens at all. At two seconds the card that asks comes — and nothing is
 * sent until she says yes on it. Drawn over the screen, by the frame, for as
 * long as the press lasts and no longer: it is the hold, not a timer.
 */
const stage = document.getElementById('stage');
const holdLine = el('div', 'hold-line tv-hold');
holdLine.hidden = true;
holdLine.setAttribute('role', 'status');
stage.appendChild(holdLine);
let holdFrom = null;
let holdFrame = null;

function beginHoldLine(at) {
  holdFrom = at;
  drawHoldLine();
}

function endHoldLine() {
  holdFrom = null;
  if (holdFrame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(holdFrame);
  holdFrame = null;
  drawHoldLine();
}

function drawHoldLine() {
  holdFrame = null;
  const progress = holdFrom === null ? null : TV.holdProgress(Date.now() - holdFrom);
  holdLine.hidden = progress === null;
  if (progress !== null) {
    const words = say('hold.keepPlain');
    if (holdLine.dataset.drawn !== words) {
      holdLine.dataset.drawn = words;
      const head = el('div', 'hold-words');
      const phone = icon('phone');
      if (phone) head.appendChild(phone);
      head.appendChild(el('span', undefined, words));
      const track = el('div', 'hold-track');
      track.appendChild(el('div', 'hold-fill'));
      holdLine.replaceChildren(head, track);
    }
    holdLine.style.setProperty('--fill', String(progress));
  }
  if (holdFrom !== null && typeof requestAnimationFrame === 'function') holdFrame = requestAnimationFrame(drawHoldLine);
}

/* --- The remote beside the screen -------------------------------------------- */

/*
 * For a mouse or a finger: the six things of her remote (DESIGN.md §6), each
 * a button that does exactly what its key does. OK can be held, as the key
 * can — pointer down is OK going down, pointer up is OK coming up. A button
 * here never takes the focus from her screen: the ring stays where the
 * remote has put it.
 */
const REMOTE_BUTTONS = [
  { name: 'up', icon: 'chevron-up', label: 'Up' },
  { name: 'left', icon: 'chevron-left', label: 'Left' },
  { name: 'ok', label: 'OK, or hold it two seconds to ask someone to ring her', words: 'OK' },
  { name: 'right', icon: 'chevron-right', label: 'Right' },
  { name: 'down', icon: 'chevron-down', label: 'Down' },
  { name: 'back', icon: 'undo-2', label: 'Back', words: 'Back' },
  { name: 'play', icon: 'play', also: 'pause', label: 'Play or pause; over a card, read it aloud', words: 'Play' },
  { name: 'rewind', icon: 'rotate-ccw', label: 'Skip back 30 seconds', words: '30 s' },
  { name: 'forward', icon: 'rotate-cw', label: 'Skip forward 30 seconds', words: '30 s' },
];

/** The focus belongs on her screen: put back where the remote had it, if a click took it elsewhere. */
function focusToScreen() {
  const at = document.activeElement;
  if (!at || at === document.body || !tvScreen.contains(at) || !at.isConnected) focusDefault(focusMemory[screenKey()]);
}

function remoteButton(spec) {
  const button = el('button', `remote-button remote-${spec.name}`);
  button.type = 'button';
  button.dataset.remote = spec.name;
  button.setAttribute('aria-label', spec.label);
  button.title = spec.label;
  for (const name of [spec.icon, spec.also]) {
    const mark = name ? icon(name) : null;
    if (mark) button.appendChild(mark);
  }
  if (spec.words) button.appendChild(el('span', 'remote-words', spec.words));
  // Pressed with a mouse or a finger, a button would take the browser's focus — and the remote's ring with it.
  button.addEventListener('pointerdown', (event) => {
    if (event.button > 0) return;
    event.preventDefault();
    button.classList.add('is-down');
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) button.addEventListener(type, () => button.classList.remove('is-down'));
  return button;
}

function buildRemote() {
  const holder = document.getElementById('tv-remote-buttons');
  const pad = el('div', 'remote-pad');
  pad.setAttribute('role', 'group');
  pad.setAttribute('aria-label', 'Arrows and OK');
  const rows = el('div', 'remote-rows');
  for (const spec of REMOTE_BUTTONS) {
    const button = remoteButton(spec);
    if (spec.name === 'ok') {
      // OK goes down with the pointer and comes up with it: held two seconds, it is Hold for Sarah.
      button.addEventListener('pointerdown', (event) => {
        if (event.button > 0 || family) return;
        button.setPointerCapture?.(event.pointerId);
        focusToScreen();
        okPressed();
      });
      button.addEventListener('pointerup', () => {
        if (okDown) okReleased();
      });
      button.addEventListener('pointercancel', okAbandoned);
      button.addEventListener('lostpointercapture', () => {
        if (okDown) okAbandoned();
      });
      // A long touch is a hold here, never the browser's menu.
      button.addEventListener('contextmenu', (event) => event.preventDefault());
      // Pressed from the keyboard while it has the browser's focus (no pointer): a short OK.
      button.addEventListener('click', (event) => {
        if (event.detail !== 0 || family) return;
        focusToScreen();
        okPressed();
        okReleased();
      });
    } else {
      button.addEventListener('click', () => {
        if (family) return;
        focusToScreen();
        pressRemote(spec.name);
      });
    }
    (['up', 'left', 'ok', 'right', 'down'].includes(spec.name) ? pad : rows).appendChild(button);
  }
  const keys = remoteButton({ name: 'keys', icon: 'keyboard', label: 'The keyboard keys', words: 'Keys' });
  keys.id = 'tv-keys-toggle';
  keys.setAttribute('aria-controls', 'tv-keys');
  keys.addEventListener('click', () => {
    toggleKeys();
    focusToScreen();
  });
  rows.appendChild(keys);
  holder.replaceChildren(pad, rows);
}

/* --- What this page is ----------------------------------------------------- */

/** The line over the screen that says it is a stand-in: in words, where it is seen (DESIGN.md §1, principle 5). */
const standInLine = document.getElementById('tv-standin');

function sayStandIn() {
  const name = typeof home?.today?.name === 'string' && home.today.name.trim() !== '' ? home.today.name.trim() : null;
  const words = `A stand-in for ${name ? `${name}’s` : 'her'} Fire TV, in your browser. The keyboard is the remote.`;
  if (standInLine.dataset.drawn === words) return;
  standInLine.dataset.drawn = words;
  const link = el('a', 'stand-in-keys', 'See the keys');
  link.href = '#tv-keys';
  link.addEventListener('click', () => {
    keysForced = true;
    showKeys();
  });
  const mark = icon('tv');
  standInLine.replaceChildren(...(mark ? [mark] : []), el('span', 'stand-in-words', words), link);
}

/* --- A card comes and goes (DESIGN.md §4) ---------------------------------- */

/*
 * A card rises 12 dp as it fades in, in 200 ms, and fades out in 150 ms, with
 * Motion (vendor/motion.generated.js). Only a card coming or going: the same
 * card drawn again in place — patched, or in another language — does not
 * move. And with reduced motion asked for, nothing moves at all.
 */
const MOTION_EASE = [0.2, 0, 0, 1];
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const canAnimate = () => typeof WickMotion !== 'undefined' && !reducedMotion();
/** What is on screen, for its coming and going: a card by its id, the tour by its step; nothing for the rest. */
const animKey = (node) => (node?.dataset?.cardId ? `card:${node.dataset.cardId}` : (node?.dataset?.anim ?? null));
let lastShownKey = null;

function cardEnters(node) {
  const key = animKey(node);
  const was = lastShownKey;
  lastShownKey = key;
  if (!key || key === was || !canAnimate()) return;
  const rise = (tvScreen.clientWidth / 960) * 12;
  WickMotion.animate(node, { opacity: [0, 1], transform: [`translateY(${rise}px)`, 'translateY(0px)'] }, { duration: 0.2, ease: MOTION_EASE });
}

/** The card going, drawn as it was and fading, under whatever comes next: a copy that nothing can press or reach. */
function cardLeaves(child, next) {
  const key = animKey(child);
  if (!key || key === animKey(next) || !canAnimate() || typeof child.cloneNode !== 'function') return;
  const ghost = child.cloneNode(true);
  ghost.classList.add('tv-leaving');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  for (const node of [ghost, ...ghost.querySelectorAll('*')]) for (const name of ['data-action', 'data-key', 'data-focusable', 'data-card-id', 'id', 'tabindex']) node.removeAttribute(name);
  tvScreen.insertBefore(ghost, film?.layer ? film.layer.nextSibling : tvScreen.firstChild);
  const gone = () => ghost.remove();
  Promise.resolve(WickMotion.animate(ghost, { opacity: [1, 0] }, { duration: 0.15, ease: MOTION_EASE }).finished).then(gone, gone);
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
  document.getElementById('tv-keys-toggle')?.setAttribute('aria-expanded', shown ? 'true' : 'false');
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
    while (!channel && !family) {
      if (await pairAndConnect()) break;
      showUnpaired('pairing.stillTrying');
      await sleep(5000);
    }
  } finally {
    pairingLoop = false;
  }
}

/**
 * The channel closed. Refused (it never opened): it is paired again. Lost: the channel goes on trying by itself, and
 * the minute's question (standing) finds out whether the home has let this television go.
 */
function channelClosed(opened) {
  clearInterval(tick);
  tick = null;
  if (!opened) void pairUntilPaired();
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
  filmStarted(started) {
    tvScreen.classList.add('has-film');
    filmStarted(started);
  },
  filmStopped(was) {
    tvScreen.classList.remove('has-film');
    filmStopped(was);
  },
  leaving: cardLeaves,
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
    sayStandIn();
    // Over a film, a card has the scrim behind it (DESIGN.md §2): the film is there, and quiet.
    tvScreen.classList.toggle('scrimmed', Boolean(film) && Boolean(node?.classList?.contains('tv-card')));
    cardEnters(node);
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
  if (!channelOpen()) return;
  send({ t: 'app_lifecycle', state: document.hidden ? 'bg' : 'fg', at: now });
  if (!document.hidden) settle.returned(now);
});

buildRemote();
applySeeing();
sayStandIn();
void loadCatalogue();
if (rememberedTelevision()) restoreTelevision();
else void pairUntilPaired();
showKeys();
