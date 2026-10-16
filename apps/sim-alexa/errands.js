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

const ERRAND_TOOLS = ['arrange_visit', 'get_errands', 'cancel_errand'];
const OPEN = ['planned', 'reminded', 'waiting'];
const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** What a step did, in a few words (surface.js describeCall). */
export function describeErrandCall(toolName) {
  if (toolName === 'arrange_visit') return 'Arranged the visit';
  if (toolName === 'get_errands') return 'Looked at the visits you arranged';
  if (toolName === 'cancel_errand') return 'Called off the visit';
  return undefined;
}

/** What is said of a write the member declined (surface.js DECLINED_TRACE). */
export const ERRAND_DECLINED_TRACE = {
  arrange_visit: 'Did not arrange it',
  cancel_errand: 'Did not call it off',
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

function entryOf(view) {
  shown.set(view.errandId, { who: view.who, when: view.when });
  return { errandId: view.errandId, who: view.who, when: view.when, said: view.said, steps: stepsOf(view), cancellable: OPEN.includes(view.status) };
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
  return undefined;
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

/** "Thursday 15 October, 10:00" from the date and time asked for: said in full, so a wrong day is seen before it is sent. */
function whenAsked(date, time) {
  const at = new Date(`${date}T${time}:00Z`);
  if (Number.isNaN(at.getTime())) return `${date ?? ''} ${time ?? ''}`.trim();
  return `${at.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })}, ${time}`;
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
 * What a nudge about an errand was about: the newest visit that has rung or
 * passed and was not yet seen that way here. Null when there is none.
 *
 * @param {string} raw  get_errands' answer, as text
 * @param {Map<string, string>} seen  errand id -> the status last shown
 */
export function errandNews(raw, seen) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed?.errands)) return null;
  const view = parsed.errands.find((v) => isView(v) && (v.status === 'rang' || v.status === 'no_show') && seen.get(v.errandId) !== v.status);
  return view ? { errandId: view.errandId, status: view.status, view } : null;
}
