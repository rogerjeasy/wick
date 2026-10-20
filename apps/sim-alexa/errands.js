/**
 * Visit errands in the family app — "The plumber is coming Thursday at ten,
 * let Mum know." What the three errand tools' answers say and show
 * (services/mcp-server tools/arrange_visit.ts, get_errands.ts,
 * cancel_errand.ts), the question asked before one is arranged or called
 * off, and what is news when a nudge says a visit has an answer.
 *
 * No DOM and no network, so it is tested (./__tests__/errands.test.ts);
 * surface.js hands it the errand tools, and main.js draws the card.
 *
 * An errand's card shows its steps: the note sent (when one went in the
 * same turn), the door told, her reminder, and how it ended — somebody rang,
 * or nobody came. The words are the server's: the door knows that somebody
 * rang and when, never who it was.
 *
 * While a visit is still to come, the member can send its visitor a link
 * (make_visit_pass; packages/contracts visitPass.ts): the visitor's page,
 * visit.html, where they say they are on the way, running late or at the
 * door. What they said last is shown under the steps, in the server's words.
 */

/** The chip. It puts an example in the field to be changed, rather than sending it: the visit is the member's to describe. */
export const ERRAND_SUGGESTION = { label: 'Arrange a visit', utterance: 'The plumber is coming on Thursday at ten. Let Mum know.', prefill: true };

/** Said when there is no model to ask: an arrangement is the assistant's to make, from the member's own words. */
export const ARRANGE_NEEDS_ASSISTANT =
  'Arranging a visit needs Wick’s assistant, which is not answering just now. You can put a note on her television instead, or ask again in a moment.';

/**
 * The rules the page answers by when there is no model (surface.js
 * routeUtterance): the visits one arranged are a tool; arranging one is not
 * guessed at.
 *
 * @param {string} t  what was said, in lower case
 */
export function routeErrand(t) {
  if (/\b(?:visits?|errands?)\b.*\barranged\b|\barranged\b.*\bvisits?\b/.test(t)) return { kind: 'tool', tool: 'get_errands', args: {} };
  if (/\barrange (?:a )?visit\b|\b(?:is|are) coming\b.*\blet (?:mum|mom|her|margaret) know\b/.test(t)) return { kind: 'arrange' };
  return undefined;
}

/** The reminder choices, as the server takes them (contracts errand.ts REMINDER_CHOICES), in words. */
const REMINDER_WORDS = {
  morning_of: 'On the morning, at eight',
  hour_before: 'An hour before',
  none: 'No reminder',
};

const ERRAND_TOOLS = ['arrange_visit', 'get_errands', 'cancel_errand', 'make_visit_pass'];
const OPEN = ['planned', 'reminded', 'waiting'];
const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** What a step did, in a few words (surface.js describeCall). */
export function describeErrandCall(toolName) {
  if (toolName === 'arrange_visit') return 'Arranged the visit';
  if (toolName === 'get_errands') return 'Looked at the visits you arranged';
  if (toolName === 'cancel_errand') return 'Called off the visit';
  if (toolName === 'make_visit_pass') return 'Made a link for the visitor';
  return undefined;
}

/** What is said of a write the member declined (surface.js DECLINED_TRACE). */
export const ERRAND_DECLINED_TRACE = {
  arrange_visit: 'Did not arrange it',
  cancel_errand: 'Did not call it off',
  make_visit_pass: 'Did not make a link',
};

/**
 * The errands this page has shown, by id: so that "Call off this visit?"
 * names the visit, not its id. Only what the server already sent here.
 */
const shown = new Map();

const isView = (v) =>
  v !== null && typeof v === 'object' && typeof v.errandId === 'string' && typeof v.who === 'string' && typeof v.when === 'string' &&
  typeof v.status === 'string' && typeof v.said === 'string';

/** The steps of one errand, each `done`, `next`, `skipped` or `stopped`. */
function stepsOf(view) {
  const failed = view.status === 'failed';
  const open = OPEN.includes(view.status);
  const reminder =
    view.remindAt === undefined
      ? { label: 'No reminder', state: 'skipped' }
      : { label: 'Reminded', state: view.reminded === true ? 'done' : open ? 'next' : 'skipped' };
  const outcome = {
    rang: { label: 'Someone rang', state: 'done' },
    no_show: { label: 'Nobody came', state: 'done' },
    cancelled: { label: 'Called off', state: 'done' },
    failed: { label: 'Did not go through', state: 'stopped' },
  }[view.status] ?? { label: 'Rang or nobody came', state: 'next' };
  return [{ label: 'Door told', state: failed ? 'stopped' : 'done' }, reminder, outcome];
}

/**
 * The button that sends the visitor a link, and the line under it. A second
 * link replaces the first (the server deletes the old pass), so once there
 * is one the member is told that before pressing.
 *
 * @param {{ who: string, hasPass?: boolean }} view
 */
export function passOffer(view) {
  return view.hasPass === true
    ? { label: 'Send the link again', note: 'A new link replaces the one you sent before, which then stops working.' }
    : { label: `Send a link to ${view.who}`, note: 'From their phone they can say they are on the way, running late or at the door, and her television says so.' };
}

const VISITOR_SAYS = ['on_way', 'late', 'at_door'];

function entryOf(view) {
  shown.set(view.errandId, { who: view.who, when: view.when });
  const open = OPEN.includes(view.status);
  const visitorSaid = typeof view.visitorSaid === 'string' && view.visitorSaid ? view.visitorSaid : undefined;
  return {
    errandId: view.errandId,
    who: view.who,
    when: view.when,
    said: view.said,
    steps: stepsOf(view),
    cancellable: open,
    ...(open ? { pass: passOffer(view) } : {}),
    ...(visitorSaid ? { visitorSaid, visitorSays: VISITOR_SAYS.includes(view.visitor?.says) ? view.visitor.says : undefined } : {}),
  };
}

function card(views, fromArrange = false) {
  return {
    kind: 'errand',
    title: views.length === 1 ? 'A visit you arranged' : 'Visits you arranged',
    meta: views.length === 1 ? views[0].when : '',
    errands: views.map(entryOf),
    ...(fromArrange ? { fromArrange: true } : {}),
    footnote: 'The door can say that somebody rang around then, not who it was.',
  };
}

function arrangedSay(view) {
  const remind = view.remindAt !== undefined ? 'Her television will remind her at a calm moment' : '';
  const told = view.tellMe === true;
  const after = remind && told ? ` ${remind}, and you will be told how it went.` : remind ? ` ${remind}.` : told ? ' You will be told how it went.' : '';
  return `Arranged. The door will expect ${view.who} on ${view.when}.${after}`;
}

/**
 * One errand tool's answer, presented — or undefined when it is not one
 * this module knows, so surface.js goes on to its own.
 *
 * @param {string} toolName
 * @param {object} parsed  the tool's structured answer
 */
export function presentErrand(toolName, parsed) {
  if (!ERRAND_TOOLS.includes(toolName) || parsed === null || typeof parsed !== 'object') return undefined;
  if (toolName === 'arrange_visit' && parsed.arranged === true && isView(parsed.errand)) {
    return { say: arrangedSay(parsed.errand), tone: 'answer', card: card([parsed.errand], true) };
  }
  if (toolName === 'get_errands' && Array.isArray(parsed.errands) && parsed.errands.length > 0 && parsed.errands.every(isView)) {
    const { errands } = parsed;
    const say = errands.length === 1 ? errands[0].said : `You have arranged ${NUMBER_WORDS[errands.length] ?? errands.length} visits. ${errands[0].said}`;
    return { say, tone: 'answer', card: card(errands) };
  }
  if (toolName === 'cancel_errand' && parsed.cancelled === true && isView(parsed.errand)) {
    return { say: `Called off. The door is no longer expecting ${parsed.errand.who}, and nothing more will be sent.`, tone: 'answer', card: card([parsed.errand]) };
  }
  if (toolName === 'make_visit_pass' && isPass(parsed)) return { say: parsed.said, tone: 'answer', card: passCard(parsed) };
  return undefined;
}

/** A link the server made: on the family app's own site, over https, to the visitor's page (contracts VISIT_PAGE_PATH). */
const isPass = (p) => {
  if (typeof p.who !== 'string' || typeof p.said !== 'string' || typeof p.link !== 'string') return false;
  try {
    const url = new URL(p.link);
    return (url.protocol === 'https:' || url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.pathname.endsWith('/visit.html') && url.hash.length > 1;
  } catch {
    return false;
  }
};

/** The card for a link made: what is shared, and what it can and cannot do. */
function passCard(pass) {
  return {
    kind: 'visit-pass',
    title: `A link for ${pass.who}`,
    meta: '',
    link: pass.link,
    who: pass.who,
    said: pass.said,
    footnote: 'Whoever has this link can say they are on the way, running late or at the door, and nothing more. It works from three hours before the visit until it is over.',
  };
}

/**
 * What goes with the link into the visitor's WhatsApp, text or email. The
 * page's own words, never the server's sentence to the member: a message
 * the member forwards may be read by anyone, so it names nobody — not her,
 * not the member, not the visitor — and no place.
 */
export const VISITOR_SHARE_TEXT = 'This is the link for your visit. Press On my way, Running late or I’m at the door, so the house knows. It works only around the time of the visit.';

/**
 * Sends the link: the phone's share sheet where there is one (WhatsApp,
 * Messages, email — the member chooses), else the clipboard, else neither
 * and the page shows the link to be copied by hand. Closing the sheet is an
 * answer, not a failure: nothing is copied behind the member's back.
 *
 * A browser may refuse the sheet when the press that asked for it was
 * spent waiting for the server; the link is then copied, and the card keeps
 * a button for the sheet, pressed afresh.
 *
 * @param {{ link: string }} pass
 * @param {Navigator | object} nav  the browser's navigator
 * @returns {Promise<'shared' | 'cancelled' | 'copied' | 'shown'>}
 */
export async function sendVisitLink(pass, nav) {
  const data = { title: 'Your visit', text: VISITOR_SHARE_TEXT, url: pass.link };
  if (typeof nav?.share === 'function' && (typeof nav.canShare !== 'function' || nav.canShare(data))) {
    try {
      await nav.share(data);
      return 'shared';
    } catch (err) {
      if (err?.name === 'AbortError') return 'cancelled';
    }
  }
  try {
    if (typeof nav?.clipboard?.writeText !== 'function') return 'shown';
    await nav.clipboard.writeText(pass.link);
    return 'copied';
  } catch {
    return 'shown';
  }
}

/** What became of the link, said under it. `ready`: made by the assistant, and not yet sent anywhere. */
export function visitLinkWords(how, who) {
  if (how === 'shared') return `Shared. ${who} can open it on their phone.`;
  if (how === 'copied') return `Copied. Paste it into a message to ${who}.`;
  if (how === 'cancelled') return 'Not sent yet. Share or copy it when you are ready.';
  if (how === 'shown') return `Select the link and copy it into a message to ${who}.`;
  return `Send it to ${who} by message or email.`;
}

/**
 * The cards of one turn, with the note sent beside an arranged visit put
 * first among its steps: the assistant is asked to "let Mum know" with
 * send_note_to_tv as well, and that is the first thing she sees of it.
 *
 * @param {object[]} cards  the turn's cards
 * @param {string[]} toolNames  the tools that answered in that turn
 */
export function withNoteSent(cards, toolNames) {
  if (!toolNames.includes('send_note_to_tv')) return cards;
  return cards.map((c) =>
    c?.kind === 'errand' && c.fromArrange === true
      ? { ...c, errands: c.errands.map((e) => ({ ...e, steps: [{ label: 'Note sent', state: 'done' }, ...e.steps] })) }
      : c);
}

/** "18:57" as the rest of the app says a time, "6:57 pm" (surface.js twelveHour); anything else as it is. */
function onTwelveHours(hhmm) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm ?? ''));
  if (!m) return hhmm ?? '';
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? 'am' : 'pm'}`;
}

/** "Thursday 15 October, 10:00 am" from the date and time asked for: said in full, so a wrong day is seen before it is sent. */
function whenAsked(date, time) {
  const at = new Date(`${date}T${time}:00Z`);
  if (Number.isNaN(at.getTime())) return `${date ?? ''} ${time ?? ''}`.trim();
  return `${at.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })}, ${onTwelveHours(time)}`;
}

/** Every argument not already shown, by its own name: nothing is sent that was not on the card. */
const otherFields = (args, already) =>
  Object.entries(args ?? {})
    .filter(([name]) => !already.includes(name))
    .map(([name, value]) => [name, typeof value === 'string' ? value : JSON.stringify(value)]);

/**
 * The question put before an errand is arranged or called off
 * (surface.js confirmWrite), or undefined for any other tool.
 *
 * @param {string} toolName
 * @param {object} args  what would be sent
 */
export function confirmErrand(toolName, args = {}) {
  if (toolName === 'arrange_visit') {
    const reminder = String(args.reminder ?? 'morning_of');
    return {
      title: 'Arrange this visit?',
      fields: [
        ['Who is coming', String(args.who ?? '')],
        ['When', whenAsked(args.date, args.time)],
        ['Remind her', Object.hasOwn(REMINDER_WORDS, reminder) ? REMINDER_WORDS[reminder] : reminder],
        ['Tell you how it went', args.tellMe === false ? 'No' : 'Yes'],
        ...otherFields(args, ['who', 'date', 'time', 'reminder', 'tellMe']),
      ],
      confirmLabel: 'Arrange it',
      footnote: 'The door is told whom to expect, she is reminded at a calm moment, and the doorbell is watched for around then. Nothing is done until you say so.',
    };
  }
  if (toolName === 'make_visit_pass') {
    const id = String(args.errandId ?? '');
    const known = shown.get(id);
    return {
      title: 'Make a link for this visit?',
      fields: [['Visit', known ? `${known.who}, ${known.when}` : id], ...otherFields(args, ['errandId'])],
      confirmLabel: 'Make the link',
      footnote: 'You send it to the visitor. From their phone they can say they are on the way, running late or at the door, and nothing more. A new link replaces any sent before.',
    };
  }
  if (toolName === 'cancel_errand') {
    const id = String(args.errandId ?? '');
    const known = shown.get(id);
    return {
      title: 'Call off this visit?',
      fields: [['Visit', known ? `${known.who}, ${known.when}` : id], ...otherFields(args, ['errandId'])],
      confirmLabel: 'Call it off',
      footnote: 'The door stops expecting them, and no reminder or notification follows.',
    };
  }
  return undefined;
}

/**
 * What there is to say about a visit now: that it rang or passed (`key` is
 * the status), or what its visitor said last (`key` is the word and when).
 * Undefined when there is nothing.
 */
function newsKeyOf(view) {
  if (view.status === 'rang' || view.status === 'no_show') return { key: view.status, say: view.said, ended: true };
  if (OPEN.includes(view.status) && typeof view.visitorSaid === 'string' && view.visitorSaid && VISITOR_SAYS.includes(view.visitor?.says)) {
    return { key: `${view.visitor.says}@${view.visitor.at}`, say: view.visitorSaid, ended: false };
  }
  return undefined;
}

/**
 * What a nudge about an errand was about: the newest visit that has rung or
 * passed, or whose visitor has said something, and was not yet seen that
 * way here. Null when there is none. `key` is what to remember as seen;
 * `say` the server's sentence for it; `ended` whether the visit is over.
 *
 * @param {string} raw  get_errands' answer, as text
 * @param {Map<string, string>} seen  errand id -> the key last shown
 */
export function errandNews(raw, seen) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed?.errands)) return null;
  for (const view of parsed.errands) {
    if (!isView(view)) continue;
    const news = newsKeyOf(view);
    if (news && seen.get(view.errandId) !== news.key) return { errandId: view.errandId, status: view.status, view, ...news };
  }
  return null;
}

/**
 * The visits still to come, from get_errands' answer, in the order the
 * server lists them — for the panel about her home. Null when the answer
 * cannot be read (not allowed yet, or no answer): the panel then says
 * nothing about visits at all, rather than "none".
 *
 * @param {string} raw  get_errands' answer, as text
 * @returns {{ who: string, when: string }[] | null}
 */
export function errandsToCome(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed?.errands)) return null;
  return parsed.errands.filter((v) => isView(v) && OPEN.includes(v.status)).map((v) => ({ who: v.who, when: v.when }));
}
