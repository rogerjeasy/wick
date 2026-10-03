/**
 * What the simulated Alexa+ surface understands, says and shows — with no DOM
 * and no network, so it is tested (./__tests__/surface.test.ts).
 *
 * Two jobs, the two a real assistant does around an MCP add-on:
 *
 *   routeUtterance  what the customer said -> which Wick tool, if any
 *   presentResult   the tool's raw result  -> one spoken sentence, and at
 *                                             most one card
 *
 * The routing is a handful of rules, not a model: the rules allow a
 * simulated experience, and a deterministic one cannot invent an answer. When
 * nothing matches it says what it can do rather than guessing a tool.
 *
 * The presentation follows Amazon's add-on design guide: the answer is
 * intelligible spoken alone (voice-only is the baseline), and a card carries
 * one title, glanceable rows and nothing the sentence did not earn.
 */

/** The chips under the conversation. Each must route to a tool (tested). */
export const SUGGESTIONS = [
  { label: 'How’s Mum been this week?', utterance: "How's Mum been this week?" },
  { label: 'What happened today?', utterance: 'What happened today?' },
  { label: 'Did Maria come today?', utterance: 'Did Maria come today?' },
  { label: 'Send a note to her television', utterance: "Put a note on Mum's television" },
  { label: 'Has Mum replied?', utterance: 'Has Mum replied?' },
  { label: 'What can I see?', utterance: 'What can I see about Mum?' },
];

const tool = (name, args = {}) => ({ kind: 'tool', tool: name, args });

const sentenceCase = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);

/** "Tell Mum <message>", "send a note saying: <message>". */
const NOTE_WITH_MESSAGE = [
  /\b(?:saying|that says)\b[:,]?\s*(.+)$/i,
  /^(?:please\s+)?tell\s+(?:mum|mom|her|margaret)\s+(?:that\s+)?(.+)$/i,
];

export function routeUtterance(text) {
  const said = (text ?? '').trim();
  if (!said) return { kind: 'help' };
  const t = said.toLowerCase();

  // Replies first: "has Mum replied to my note" mentions a note, and is not one.
  if (/\brepl(y|ied|ies)\b|\banswered\b|written back/.test(t)) return tool('get_replies');

  for (const pattern of NOTE_WITH_MESSAGE) {
    const m = pattern.exec(said);
    if (m && m[1].trim()) return { kind: 'compose', message: sentenceCase(m[1].trim()) };
  }
  if (/\bnote\b|\bmessage\b/.test(t)) return { kind: 'compose' };

  if (/\b(can|may) i see\b|\bshare[sd]?\b|\bprivate\b/.test(t)) return tool('get_resident_shared_view');
  if (/\bmaria\b|\bcarer\b/.test(t)) return tool('did_visitor_come', { personId: 'maria' });
  if (/\btoday\b/.test(t)) return tool('get_today');
  if (/\bweek\b/.test(t)) return tool('get_week_narrative');
  return { kind: 'help' };
}

export const HELP_TEXT =
  'I can tell you how the week has been, what happened today, whether Maria came, ' +
  'put a note on the television, tell you if there is a reply, or show what you are able to see.';

const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
const count = (n) => NUMBER_WORDS[n] ?? String(n);
const things = (n) => `${count(n)} ${n === 1 ? 'thing' : 'things'}`;

/** FactClass -> the words the television's own "What Sarah sees" screen uses. */
const CLASS_LABELS = {
  DOOR_EVENT: 'When someone comes to the door',
  PRESENCE: 'Who visits, by name',
  COMMITMENT: 'Appointments and plans',
  RHYTHM: 'The shape of the week',
  HEALTH: 'Health',
  FINANCIAL: 'Money',
  RELATIONSHIP: 'Relationships',
  LOCATION: 'Where they go',
  VERBATIM: 'What was said, word for word',
};

function defaultFormatTime(atMs) {
  return new Date(atMs).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function parseJson(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** A plain sentence from the server: said as it stands, never re-worded. */
function plain(toolName, raw, isError) {
  const tone = isError
    ? 'error'
    : /keeping to themselves/i.test(raw)
      ? 'private'
      : toolName === 'get_week_narrative'
        ? 'waiting'
        : 'answer';
  return { say: raw, card: null, tone };
}

const byTime = (a, b) => a.at - b.at;

function presentWeek(week, formatTime) {
  const items = [...week.timeline].sort(byTime).map((e) => ({ primary: e.summary, secondary: formatTime(e.at) }));
  return {
    say: week.text,
    tone: 'answer',
    card: {
      kind: 'list',
      title: 'This week',
      meta: week.isoWeek ?? '',
      items,
      empty: 'Nothing at the door this week.',
      footnote: 'The person this is about read it first, on their own television.',
    },
  };
}

function presentToday(today, formatTime) {
  const events = [...today.events].sort(byTime);
  const kept = today.keptPrivate ?? [];
  const lead =
    events.length === 0
      ? 'Nothing at the door so far today.'
      : events.length === 1
        ? `One thing so far today: ${lowerFirst(events[0].summary)}`
        : `${things(events.length)} so far today. Most recently: ${lowerFirst(events[events.length - 1].summary)}`;
  const say = [lead, ...kept].join(' ');
  if (events.length === 0) return { say, card: null, tone: kept.length ? 'private' : 'answer' };
  return {
    say,
    tone: 'answer',
    card: {
      kind: 'list',
      title: 'Today',
      meta: '',
      items: events.map((e) => ({ primary: e.summary, secondary: formatTime(e.at) })),
      ...(kept.length ? { footnote: kept.join(' ') } : {}),
    },
  };
}

function presentVisitor(v, formatTime) {
  if (!v.name) return { say: "I don't have anyone by that name among the regular visitors.", card: null, tone: 'answer' };
  const say = v.visited
    ? `Yes. ${v.name} came at ${formatTime(v.at)}.${v.expectedToday ? ' Today is one of their usual days.' : ''}`
    : v.expectedToday
      ? `Not yet. ${v.name} usually comes today.`
      : `No. ${v.name} hasn't come today, and today isn't one of their usual days.`;
  return { say, card: null, tone: 'answer' };
}

function presentNoteSent(context) {
  return {
    say: 'Sent. It will appear on the television at the next natural break, never in the middle of a programme.',
    tone: 'answer',
    card: {
      kind: 'confirmation',
      title: 'Note sent to the television',
      fields: [
        ['From', context.fromName ?? ''],
        ['Message', context.message ?? ''],
      ],
      footnote: 'It waits for the end of an episode or a pause. One button answers it.',
    },
  };
}

function presentReplies(parsed, formatTime) {
  const [newest] = parsed.notes;
  const say = !newest
    ? 'No notes have been sent to the television this week.'
    : newest.reply
      ? `Yes. To “${newest.message ?? 'your note'}” the reply was: “${newest.reply.text}”`
      : 'Not yet. Your note is on the television, waiting.';
  return {
    say,
    tone: 'answer',
    card: {
      kind: 'replies',
      title: 'Notes and replies',
      meta: '',
      items: parsed.notes.map((n) => ({
        primary: n.message ?? '',
        secondary: `${n.from} · ${formatTime(n.sentAt)}`,
        reply: n.reply ? n.reply.text : null,
        replyMeta: n.reply ? `Replied ${formatTime(n.reply.at)}` : 'No reply yet',
      })),
    },
  };
}

function presentSharedView(view) {
  const shared = view.sharedWithFamily ?? [];
  const kept = view.residentExclusions ?? [];
  const label = (c) => CLASS_LABELS[c] ?? c;
  const keptSentence = kept.length === 0 ? '' : ` ${count(kept.length)} ${kept.length === 1 ? 'is' : 'are'} kept private.`;
  return {
    say: `You can see ${count(shared.length).toLowerCase()} ${shared.length === 1 ? 'kind of thing' : 'kinds of thing'}.${keptSentence}`,
    tone: 'answer',
    card: {
      kind: 'list',
      title: 'What you can see',
      meta: '',
      items: [
        ...shared.map((c) => ({ primary: label(c), secondary: 'Shared with you' })),
        ...kept.map((c) => ({ primary: label(c), secondary: 'Kept private' })),
      ],
      footnote: 'They choose this on their own television, and can change it at any time.',
    },
  };
}

/**
 * @param {string} toolName
 * @param {string} raw        the tool result's text content, as the server sent it
 * @param {{fromName?: string, message?: string}} context  what the customer asked for
 * @param {(atMs: number) => string} formatTime
 * @param {boolean} isError   the MCP result's own isError flag
 */
export function presentResult(toolName, raw, context = {}, formatTime = defaultFormatTime, isError = false) {
  const parsed = isError ? undefined : parseJson(raw);
  if (!parsed) return plain(toolName, raw, isError);

  if (toolName === 'get_week_narrative' && typeof parsed.text === 'string' && Array.isArray(parsed.timeline)) {
    return presentWeek(parsed, formatTime);
  }
  if (toolName === 'get_today' && Array.isArray(parsed.events)) return presentToday(parsed, formatTime);
  if (toolName === 'did_visitor_come' && typeof parsed.visited === 'boolean') return presentVisitor(parsed, formatTime);
  if (toolName === 'send_note_to_tv' && parsed.sent === true) return presentNoteSent(context);
  if (toolName === 'get_replies' && Array.isArray(parsed.notes)) return presentReplies(parsed, formatTime);
  if (toolName === 'get_resident_shared_view' && Array.isArray(parsed.sharedWithFamily)) return presentSharedView(parsed);

  // A shape this surface does not know: say so, never render a guess.
  return { say: 'I got an answer I could not read.', card: null, tone: 'error' };
}
