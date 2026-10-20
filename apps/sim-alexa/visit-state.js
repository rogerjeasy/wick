/**
 * The visitor's page (visit.html): what it says and does, with no DOM and no
 * network, so it is tested (./__tests__/visit.test.ts); visit.js only draws
 * it and makes the two requests.
 *
 * A family member arranged a visit and forwarded this link to the visitor —
 * a doctor she has never met, say. The page lets that visitor say one of
 * three things from their own phone: on my way, running late, at the door.
 * Pressed around the ring, the last one lets her television say who is at
 * the door (packages/contracts visitPass.ts).
 *
 * The page knows nothing about the house and says nothing about it: no
 * name, no address, nobody's. It has the token from the address's `#` (which
 * no server's log ever sees) and sends it in a request's body to the edge
 * API, and nowhere else. A link that has ended and a link that was never
 * made are told apart by nobody: both are "This link has ended."
 */

/** What a visitor can say: three, and only these (contracts visitPass.ts VISITOR_SAYS; the test holds them to it). */
export const VISITOR_SAYS = ['on_way', 'late', 'at_door'];
/** "Running late" adds this much each time (contracts VISIT_PASS_LIMITS.lateStepMinutes). */
export const LATE_STEP_MINUTES = 15;
/** Where this page lives on the family app's site (contracts VISIT_PAGE_PATH). */
export const VISIT_PAGE_PATH = '/visit.html';

/** 128 random bits as 32 lower-case hex characters, as the Wick server makes them (contracts isVisitPassToken). */
const TOKEN = /^[0-9a-f]{32}$/;

/**
 * The token in the page's address, after the `#`, or undefined. Only ever
 * the fragment: a browser never sends it to any server, so neither the
 * family app's site nor its logs ever hold it.
 *
 * @param {string} hash  location.hash
 */
export function tokenFromHash(hash) {
  const token = String(hash ?? '').replace(/^#/, '');
  return TOKEN.test(token) ? token : undefined;
}

/**
 * The edge API's address, as the deploy wrote it into the page
 * (infra/sim-alexa.tf), or undefined when it is not one: then the page says
 * it cannot reach the house, rather than asking somewhere it should not.
 *
 * @param {string | undefined} raw  the meta tag's content
 */
export function edgeFrom(raw) {
  try {
    const url = new URL(String(raw ?? ''));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    return url.href.replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

/**
 * The request for how the pass stands (`says` left out) or to say one of
 * the three. The token is in the body: never in the address, which an API's
 * access log keeps. No cookie and no Referer go with it.
 *
 * @param {string} edge  edgeFrom's answer
 * @param {string} token
 * @param {string} [says]
 */
export function visitRequest(edge, token, says) {
  if (says !== undefined && !VISITOR_SAYS.includes(says)) throw new Error(`Not something a visitor can say: ${says}`);
  const base = edge.replace(/\/+$/, '');
  return {
    url: `${base}/visit/${says === undefined ? 'status' : 'say'}`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(says === undefined ? { token } : { token, says }),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    },
  };
}

/** The visitor's last word, as the edge answered it, or undefined when it cannot be read. Answers are read, not trusted. */
function wordOf(body) {
  if (!VISITOR_SAYS.includes(body?.says) || typeof body.at !== 'number' || !Number.isFinite(body.at)) return undefined;
  if (body.says !== 'late') return { says: body.says, at: body.at };
  if (typeof body.lateMinutes !== 'number' || !(body.lateMinutes > 0)) return undefined;
  return { says: 'late', at: body.at, lateMinutes: body.lateMinutes };
}

/**
 * An answer from the edge, as one of: a state of the pass, the pass refusing
 * more presses (`busy`), or `unreachable`. Any other refusal is the same as
 * a link that has ended — the edge answers `over` for every link it will
 * not take, and this page adds no way to tell them apart.
 */
function readAnswer(status, body) {
  if (status === 429 && body?.busy === true) return { busy: true };
  if (status === 429 || status >= 500 || status === 0) return { unreachable: true };
  if (status >= 400) return { state: 'over' };
  if (body?.state === 'open' || body?.state === 'not_yet') return { state: body.state, word: wordOf(body) };
  return { state: 'over' };
}

/**
 * The page's first state: checking the link, or — with no token in the
 * address, or one that is not a token — the link has ended, without asking
 * anybody.
 *
 * @param {string | undefined} token
 */
export function firstModel(token) {
  return token ? { phase: 'loading' } : { phase: 'over' };
}

/**
 * The page's state after an event:
 *   { type: 'answer', status, body }  the edge answered (a look, or a press)
 *   { type: 'failed' }                no answer at all: the network
 *   { type: 'press', says }           a button was pressed
 *   { type: 'retry' }                 "Try again" or "Check again"
 *
 * A model is `{ phase, word?, told?, pending?, problem? }`: `phase` is
 * loading, not_yet, open, over or unreachable; `word` the visitor's last word
 * as the house has it; `told` that a press from this page was taken;
 * `pending` the press waiting for its answer; `problem` why the last press
 * did not go through (unsent or busy) while the pass is still open.
 */
export function nextModel(model, event) {
  if (event.type === 'retry') return { phase: 'loading' };
  if (event.type === 'press') {
    if (model.phase !== 'open' || model.pending !== undefined || !VISITOR_SAYS.includes(event.says)) return model;
    return { ...model, pending: event.says, problem: undefined };
  }
  const pressed = model.pending !== undefined;
  const answer = event.type === 'failed' ? { unreachable: true } : readAnswer(event.status, event.body);
  if (pressed && (answer.unreachable || answer.busy)) {
    return { phase: 'open', word: model.word, told: model.told, problem: answer.busy ? 'busy' : 'unsent' };
  }
  if (answer.unreachable) return { phase: 'unreachable' };
  if (answer.busy) return { phase: 'open', word: model.word, problem: 'busy' };
  if (answer.state !== 'open') return { phase: answer.state };
  return { phase: 'open', word: answer.word ?? model.word, told: pressed && answer.word !== undefined ? true : model.told };
}

/** "9:41 am", on the visitor's own phone's clock: they are at the same door. */
const localTime = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true });

/** What the visitor said, and when, in their own terms. */
function lastSaid(word, formatTime) {
  const at = formatTime(word.at);
  if (word.says === 'late') return `You said at ${at} that you would be about ${word.lateMinutes} minutes late.`;
  if (word.says === 'at_door') return `You said you were at the door at ${at}.`;
  return `You said you were on the way at ${at}.`;
}

const BUTTONS = [
  { says: 'on_way', label: 'On my way', hint: 'You have set off' },
  { says: 'late', label: 'Running late', hint: `About ${LATE_STEP_MINUTES} minutes` },
  { says: 'at_door', label: 'I’m at the door', hint: 'Press it as you ring the bell' },
];

const PROBLEMS = {
  unsent: 'That was not sent. Check that your phone is online, then press it again.',
  busy: 'This link cannot be pressed any more. The house has what you said last.',
};

const SHUT = {
  loading: { heading: 'Your visit', lead: 'Opening your link…', retry: null },
  not_yet: {
    heading: 'This link is not open yet.',
    lead: 'It opens on the day of the visit, three hours before it is due. Please come back to it then.',
    retry: { label: 'Check again' },
  },
  over: {
    heading: 'This link has ended.',
    lead: 'The visit may be over, or a newer link may have been sent. If you are still expected, ask the person who sent it for a new one.',
    retry: null,
  },
  unreachable: { heading: 'This page could not reach the house.', lead: 'Check that your phone is online, then try again.', retry: { label: 'Try again' } },
};

/**
 * What the page shows for a state: a heading, a line under it, the buttons
 * (each with its words, whether it is the main one, whether it was the last
 * said, and whether it can be pressed now), what came of the last press,
 * and a button to look again where one helps.
 *
 * @param {object} model  nextModel's
 * @param {(atMs: number) => string} [formatTime]
 */
export function presentVisit(model, formatTime = localTime) {
  if (model.phase !== 'open') {
    const shut = SHUT[model.phase] ?? SHUT.over;
    return { heading: shut.heading, lead: shut.lead, busy: model.phase === 'loading', buttons: [], result: null, retry: shut.retry };
  }
  const word = model.word;
  const buttons = BUTTONS.map((b) => ({
    says: b.says,
    label: b.label,
    hint: b.says === 'late' && word?.says === 'late' ? `Press again to add ${LATE_STEP_MINUTES} minutes` : b.hint,
    primary: b.says === 'at_door',
    last: word?.says === b.says,
    working: model.pending === b.says,
    disabled: model.pending !== undefined,
  }));
  const last = word ? lastSaid(word, formatTime) : undefined;
  let result = null;
  if (model.problem) result = { problem: PROBLEMS[model.problem], ...(last ? { last } : {}), tone: 'problem' };
  else if (model.told && last) result = { thanks: 'Thank you. The house has been told.', last, tone: 'done' };
  else if (last) result = { last, tone: 'done' };
  return {
    heading: 'Your visit',
    lead: 'Let the house know how you are getting on. Each press is passed on at once.',
    busy: model.pending !== undefined,
    buttons,
    result,
    retry: null,
  };
}
