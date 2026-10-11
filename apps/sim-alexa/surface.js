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
  { label: 'Family circle', utterance: 'Who is in the family circle?' },
];

const tool = (name, args = {}) => ({ kind: 'tool', tool: name, args });

const sentenceCase = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);

/** "Tell Mum <message>", "send a note saying: <message>". */
const NOTE_WITH_MESSAGE = [
  /\b(?:saying|that says)\b[:,]?\s*(.+)$/i,
  /^(?:please\s+)?tell\s+(?:mum|mom|her|margaret)\s+(?:that\s+)?(.+)$/i,
];

const DAY_MS = 86_400_000;
const mondayIndex = (date) => (date.getUTCDay() + 6) % 7;

/** The Monday (UTC) that week 1 of an ISO year starts on: the week holding 4 January. */
function firstMonday(year) {
  const jan4 = Date.UTC(year, 0, 4);
  return jan4 - mondayIndex(new Date(jan4)) * DAY_MS;
}

/** "2026-W41" for a moment — ISO 8601 in UTC, the weeks the server counts in. */
export function isoWeekOf(atMs) {
  const date = new Date(atMs);
  // A week belongs to the year its Thursday is in.
  const thursday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - mondayIndex(date) + 3);
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - firstMonday(year)) / (7 * DAY_MS)) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** "28 September" for "2026-W40": the Monday the week began on. */
function weekOf(isoWeek) {
  const m = /^(\d{4})-W(\d{2})$/.exec(isoWeek ?? '');
  if (!m) return '';
  const monday = firstMonday(Number(m[1])) + (Number(m[2]) - 1) * 7 * DAY_MS;
  return new Date(monday).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
}

/**
 * @param {string} text
 * @param {number} now  when it was said, for "last week"
 */
export function routeUtterance(text, now = Date.now()) {
  const said = (text ?? '').trim();
  if (!said) return { kind: 'help' };
  const t = said.toLowerCase();

  // The circle is the app's own business, not a question for a tool. "Connect
  // a television" is; "put a note on her television" is not.
  if (/\bcircle\b|\binvit(e|ation)\b|\bconnect\b.*\b(television|tv)\b/.test(t)) return { kind: 'circle' };

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
  // "This week" is whichever week there is to read (the server picks the
  // latest); "last week" is asked for by name, so it is that week or nothing.
  if (/\bweek\b/.test(t)) return tool('get_week_narrative', /\blast week\b/.test(t) ? { isoWeek: isoWeekOf(now - 7 * DAY_MS) } : {});
  return { kind: 'help' };
}

export const HELP_TEXT =
  'I can tell you how the week has been, what happened today, whether Maria came, ' +
  'put a note on the television, tell you if there is a reply, show what you are able to see, ' +
  'or open the family circle.';

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
  // The server's own refusals (services/mcp-server): the resident has not
  // answered yet, or has said no. Neither is an error.
  const tone = isError
    ? 'error'
    : /hasn’t allowed this yet/.test(raw)
      ? 'waiting'
      : /keeping to themselves|chose not to share/i.test(raw)
        ? 'private'
        : toolName === 'get_week_narrative'
          ? 'waiting'
          : 'answer';
  return { say: raw, card: null, tone };
}

const byTime = (a, b) => a.at - b.at;

/**
 * Why the week being read is not this one (`thisWeek`, set by the server
 * when it answers with an earlier week). Said first: last week must never
 * be heard as this week.
 */
const NOT_THIS_WEEK = {
  not_written: 'This week’s story isn’t written yet: Wick writes it on Sunday evening.',
  awaiting_resident: 'This week’s story is on the television, where the person it’s about reads it first.',
};

function presentWeek(week, formatTime, now) {
  const items = [...week.timeline].sort(byTime).map((e) => ({ primary: e.summary, secondary: formatTime(e.at) }));
  const earlier = NOT_THIS_WEEK[week.thisWeek];
  const named = weekOf(week.isoWeek);
  const isThisWeek = !earlier && week.isoWeek === isoWeekOf(now);
  return {
    say: earlier ? `${earlier} Here is the week of ${named}. ${week.text}` : week.text,
    tone: 'answer',
    card: {
      kind: 'list',
      title: isThisWeek || !named ? 'This week' : `Week of ${named}`,
      meta: week.isoWeek ?? '',
      items,
      empty: isThisWeek ? 'Nothing at the door this week.' : 'Nothing at the door that week.',
      footnote: week.simulated
        ? 'Simulated: this is a demo home, and nobody lived this week.'
        : 'The person this is about read it first, on their own television.',
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

function presentNoteSent(context, sent) {
  return {
    say: 'Sent. It will appear on the television at the next natural break, never in the middle of a programme.',
    tone: 'answer',
    card: {
      kind: 'confirmation',
      title: 'Note sent to the television',
      fields: [
        // The server signs the note with the name the resident allowed.
        ['From', sent.fromName ?? ''],
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
 * @param {{message?: string, now?: number}} context  what the customer asked for, and when
 * @param {(atMs: number) => string} formatTime
 * @param {boolean} isError   the MCP result's own isError flag
 */
export function presentResult(toolName, raw, context = {}, formatTime = defaultFormatTime, isError = false) {
  const parsed = isError ? undefined : parseJson(raw);
  if (!parsed) return plain(toolName, raw, isError);

  if (toolName === 'get_week_narrative' && typeof parsed.text === 'string' && Array.isArray(parsed.timeline)) {
    return presentWeek(parsed, formatTime, context.now ?? Date.now());
  }
  if (toolName === 'get_today' && Array.isArray(parsed.events)) return presentToday(parsed, formatTime);
  if (toolName === 'did_visitor_come' && typeof parsed.visited === 'boolean') return presentVisitor(parsed, formatTime);
  if (toolName === 'send_note_to_tv' && parsed.sent === true) return presentNoteSent(context, parsed);
  if (toolName === 'get_replies' && Array.isArray(parsed.notes)) return presentReplies(parsed, formatTime);
  if (toolName === 'get_resident_shared_view' && Array.isArray(parsed.sharedWithFamily)) return presentSharedView(parsed);

  // A shape this surface does not know: say so, never render a guess.
  return { say: 'I got an answer I could not read.', card: null, tone: 'error' };
}

// ---------------------------------------------------------------------------
// The family circle. These present /api/me and /api/circle (the app's own
// business with the Wick server), not a tool result.
// ---------------------------------------------------------------------------

const people = (n) => `${count(n)} ${n === 1 ? 'person is' : 'people are'}`;

/**
 * The first thing said after linking. INV-9: someone the resident has not
 * allowed yet is told where the answer is waiting, and what to do next.
 *
 * @param me           GET /api/me
 * @param televisions  how many televisions are connected, when the app may know
 */
export function presentWelcome(me, televisions) {
  const resident = me.household.residentName;
  const { role, status } = me.membership;
  if (status === 'allowed') {
    // A demo home's weeks were written, not lived (the server's demoHome.ts). Said before anything is asked.
    const simulated = me.household.simulated ? ' Its history is simulated, so there is a week to ask about.' : '';
    return { say: `Wick is linked to ${me.household.name}.${simulated} What would you like to know?`, tone: 'answer', next: null };
  }
  if (status === 'declined') return { say: `${resident} chose not to share this with you.`, tone: 'private', next: null };
  if (status === 'removed') return { say: 'You are no longer part of this family circle.', tone: 'private', next: null };

  if (role === 'organiser' && !televisions) {
    return {
      say: `Welcome, ${me.user.name}. Connect ${resident}’s television next. ${resident} will then be asked, on it, whether to allow you.`,
      tone: 'waiting',
      next: 'connect',
    };
  }
  if (role === 'organiser') {
    return {
      say: `The television is connected. ${resident} is being asked whether to allow you. It appears at the end of a programme, and takes one press.`,
      tone: 'waiting',
      next: null,
    };
  }
  return {
    say: `You have asked to join ${me.household.name}. ${resident} will be asked on the television whether to allow you. Until then there is nothing I can show you.`,
    tone: 'waiting',
    next: null,
  };
}

function memberLine(member, resident) {
  const said =
    member.status === 'allowed'
      ? `allowed by ${resident}`
      : member.status === 'pending'
        ? `Waiting for ${resident}`
        : `${resident} said no`;
  if (member.role === 'organiser') return member.status === 'allowed' ? `Organiser · ${said}` : `Organiser · ${lowerFirst(said)}`;
  return sentenceCase(said);
}

function televisionLine(televisions) {
  if (televisions.length === 0) return 'No television is connected yet.';
  const n = `${count(televisions.length)} ${televisions.length === 1 ? 'television' : 'televisions'} connected`;
  return televisions.some((tv) => tv.connected) ? `${n}, and on now.` : `${n}. It is off, or showing something else.`;
}

/**
 * @param circle  GET /api/circle
 * @param me      GET /api/me
 */
export function presentCircle(circle, me) {
  const resident = circle.household.residentName;
  const organiser = me.membership.role === 'organiser';
  const waiting = circle.members.filter((m) => m.status === 'pending').length;
  const waitingSentence =
    waiting === 0 ? '' : ` ${count(waiting)} ${waiting === 1 ? 'is' : 'are'} waiting for ${resident} to allow them.`;
  return {
    say: `${people(circle.members.length)} in ${resident}’s family circle.${waitingSentence}`,
    tone: 'answer',
    card: {
      kind: 'circle',
      title: `${resident}’s family circle`,
      members: circle.members.map((m) => ({
        userId: m.userId,
        primary: m.you ? `${m.name} (you)` : m.name,
        secondary: memberLine(m, resident),
        removable: organiser && !m.you,
      })),
      television: televisionLine(circle.televisions),
      organiser,
      footnote: `${resident} allows each person on the television, one press each.`,
    },
  };
}

/** The link an organiser sends: this same app, with the invitation in the address. */
export function inviteLink(here, code) {
  const url = new URL(here);
  url.search = '';
  url.hash = '';
  url.searchParams.set('invite', code);
  return url.toString();
}
