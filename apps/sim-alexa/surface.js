/**
 * What the simulated Alexa+ surface understands, says and shows — with no DOM
 * and no network, so it is tested (./__tests__/surface.test.ts).
 *
 * What a real assistant does around an MCP add-on, in three parts:
 *
 *   presentResult   one tool's raw result -> a spoken sentence and a card
 *   presentTurn     several tools, one answer: the assistant's sentence,
 *                   each tool's card, and what was done to get there
 *   routeUtterance  what the customer said -> which Wick tool, by rule
 *
 * Which tools to call is a model's decision (the Wick server's assistant,
 * services/mcp-server/src/assistant); main.js makes the calls and this file
 * presents them. routeUtterance is the handful of rules the page answered
 * by before there was a model, and still does where there is none: a
 * deterministic fallback that says what it can do rather than guess a tool.
 *
 * The presentation follows Amazon's add-on design guide: the answer is
 * intelligible spoken alone (voice-only is the baseline), and a card carries
 * one title, glanceable rows and nothing the sentence did not earn.
 */

/**
 * The replies a note can be sent with, as the server keeps them
 * (services/mcp-server/src/tools/send_note_to_tv.ts REPLY_CHOICES) — here
 * so the note can be shown with its replies before it is sent. A test
 * holds the two lists equal. An assistant passes keys; it cannot write one.
 */
export const REPLY_CHOICES = {
  yes_please: 'Yes, please do.',
  yes_fine: "Yes, that's fine.",
  love_to: "I'd love that.",
  another_day: 'Another day would be better.',
  a_bit_later: 'A bit later would be better.',
  no_thank_you: 'No, thank you.',
  thank_you: 'Thank you!',
  call_soon: "I'll call you soon.",
  please_call: 'Please call me.',
  im_fine: "I'm fine, thank you.",
  you_too: 'Thinking of you too.',
  lovely: "That's lovely to hear.",
};

/**
 * What can be answered when the resident asks someone to look at the door.
 * The server's own list (packages/contracts door.ts), copied because this
 * page has no build step, and held equal to it by a test. Only these are
 * ever drawn as buttons: an answer this page does not know is not offered.
 */
export const DOOR_ANSWERS = {
  known: "It's all right, I know who that is.",
  dont_open: "Please don't open the door. I'll ring you now.",
  not_sure: "I can't tell who that is. I'll ring you now.",
};

/** The chips under the conversation. Each must route to a tool (tested). */
export const SUGGESTIONS = [
  { label: 'How’s Mum been this week?', utterance: "How's Mum been this week?" },
  { label: 'What happened today?', utterance: 'What happened today?' },
  { label: 'Did Maria come today?', utterance: 'Did Maria come today?' },
  { label: 'Is anything different?', utterance: 'Is anything different?' },
  { label: 'Send a note to her television', utterance: "Put a note on Mum's television" },
  { label: 'Has Mum replied?', utterance: 'Has Mum replied?' },
  { label: 'Did Mum ask me to look?', utterance: 'Has Mum asked me to look at the door?' },
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

  // The doorbell is the app's own business too: connecting Ring is something the organiser does here.
  if (/\b(connect|disconnect|link|unlink)\b.*\b(doorbell|ring)\b|\bdoorbell\b.*\bconnected\b/.test(t)) return { kind: 'doorbell' };

  // "Ask Sarah to look": the resident's question about who is at the door.
  // Narrow on purpose — "did anyone come to the door today" is the day's list.
  if (/\bask(?:ed|ing)? (?:me|us) to look\b|\bwho(?:'|’)?s at\b.*\bdoor\b|\bwho is at\b.*\bdoor\b|\bsomeone at\b.*\bdoor\b/.test(t)) return tool('get_door_request');

  // Notifications are the app's own business with this browser.
  if (/\bnotif(?:y|ication|ications)\b/.test(t)) return { kind: 'notifications' };

  // Replies first: "has Mum replied to my note" mentions a note, and is not one.
  if (/\brepl(y|ied|ies)\b|\banswered\b|written back/.test(t)) return tool('get_replies');

  for (const pattern of NOTE_WITH_MESSAGE) {
    const m = pattern.exec(said);
    if (m && m[1].trim()) return { kind: 'compose', message: sentenceCase(m[1].trim()) };
  }
  if (/\bnote\b|\bmessage\b/.test(t)) return { kind: 'compose' };

  if (/\b(can|may) i see\b|\bshare[sd]?\b|\bprivate\b/.test(t)) return tool('get_resident_shared_view');
  // Before "today" and "Maria": "is anything different today" is this question, not the day's list.
  if (/\bdifferent\b|\bunusual\b|\bal(?:l ?)?right\b|\bshould i know\b/.test(t)) return tool('get_whats_different');
  if (/\bmaria\b|\bcarer\b/.test(t)) return tool('did_visitor_come', { personId: 'maria' });
  if (/\btoday\b/.test(t)) return tool('get_today');
  // "This week" is whichever week there is to read (the server picks the
  // latest); "last week" is asked for by name, so it is that week or nothing.
  if (/\bweek\b/.test(t)) return tool('get_week_narrative', /\blast week\b/.test(t) ? { isoWeek: isoWeekOf(now - 7 * DAY_MS) } : {});
  return { kind: 'help' };
}

/**
 * Wick's listing as an add-on, read from the package Amazon's toolkit would
 * be given (addon-package/addon.json, published beside this page). It is
 * what a customer sees before they enable an add-on: the name, what it is
 * for, things to say, and that an account is linked.
 *
 * Null for a package this page should not stand behind — no name, or no
 * HTTPS server to link against. The page then shows its plain link card.
 * The package's full rules are checked where it is built
 * (scripts/addon/manifest-rules.ts); this is only what the page itself needs.
 *
 * @param {unknown} manifest
 * @param {string} locale
 */
export function presentListing(manifest, locale = 'en-US') {
  const store = manifest?.storeListing?.locales?.[locale];
  const name = store?.name?.value?.trim?.();
  if (!name) return null;

  const endpoint = (manifest.integrations ?? []).find((i) => i?.type === 'MCP')?.config?.endpoints?.default?.uri;
  let server;
  try {
    server = new URL(endpoint);
  } catch {
    return null;
  }
  if (server.protocol !== 'https:') return null;

  // This page is dark, so the dark-theme icons are the ones made for it.
  const icons = store.mediaAssets?.icons ?? {};
  const set = icons.dark?.length ? icons.dark : (icons.light ?? []);
  const width = (icon) => Number.parseInt(icon?.size ?? '0', 10);
  const largest = [...set].sort((a, b) => width(b) - width(a))[0];

  const about = String(store.fullDescription ?? '')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.split('\n').map((line) => line.trim()).filter(Boolean))
    .filter((lines) => lines.length > 0)
    .map((lines) => {
      const items = lines.filter((line) => line.startsWith('•')).map((line) => line.slice(1).trim());
      if (items.length === 0) return { text: lines.join(' ') };
      return { lead: lines.filter((line) => !line.startsWith('•')).join(' '), items };
    });

  return {
    name,
    summary: store.shortDescription ?? '',
    about,
    phrases: (store.examplePhrases ?? []).filter((phrase) => typeof phrase === 'string' && phrase.trim()),
    iconUrl: largest?.uri,
    privacyUrl: store.privacyAndCompliance?.privacyPolicyUrl,
    termsUrl: store.privacyAndCompliance?.termsOfUseUrl,
    serverUrl: server.origin,
  };
}

/**
 * The server to link against: the one the package names, wherever this page
 * is deployed. On a laptop the server is the developer's own, so the field
 * on the page is left as it is.
 *
 * @param {{ serverUrl: string } | null} listing
 * @param {string} hostname  this page's own
 */
export function serverFor(listing, hostname) {
  if (!listing?.serverUrl) return null;
  return hostname === 'localhost' || hostname === '127.0.0.1' ? null : listing.serverUrl;
}

/**
 * The chips under the conversation: the phrases the listing promises first,
 * then the app's own, leaving out any that ask what a phrase already asks.
 *
 * @param {{ phrases: string[] } | null} listing
 */
export function suggestionsFor(listing) {
  const phrases = listing?.phrases ?? [];
  if (phrases.length === 0) return SUGGESTIONS;
  const asks = (utterance) => {
    const route = routeUtterance(utterance);
    return route.kind === 'tool' ? route.tool : route.kind;
  };
  const promised = new Set(phrases.map(asks));
  return [
    ...phrases.map((phrase) => ({ label: `${sentenceCase(phrase).replace(/'/g, '’')}?`, utterance: phrase })),
    ...SUGGESTIONS.filter((suggestion) => !promised.has(asks(suggestion.utterance))),
  ];
}

export const HELP_TEXT =
  'I can tell you how the week has been, what happened today, whether Maria came, whether anything is different, ' +
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

/**
 * A moment, as it was at the house. Someone asking from another country is
 * asking what time the carer came to their mother's door, not what time it
 * was where they are — and the assistant's sentence is in the household's
 * time already, so a card in the reader's would contradict it.
 *
 * @param {string | undefined} timeZone  the household's IANA zone (GET /api/me); the reader's own if absent
 */
export function timeFormatter(timeZone) {
  const format = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    ...(timeZone ? { timeZone } : {}),
  });
  return (atMs) => {
    const parts = format.formatToParts(new Date(atMs));
    const part = (type) => parts.find((p) => p.type === type)?.value ?? '';
    return `${part('weekday')} ${part('day')} ${part('month')}, ${part('hour')}:${part('minute')}`;
  };
}

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
  // The Rhythm baseline, as numbers: this week beside the one before, and a
  // usual one where there is enough history to know what usual is.
  const facts = (week.deltas ?? []).map((d) => ({
    label: sentenceCase(d.label ?? d.metric),
    value: [
      `${d.thisWeek} this week`,
      ...(d.lastWeek !== undefined ? [`${d.lastWeek} the week before`] : []),
      ...(d.verdict !== undefined ? [`usually about ${Math.round(d.baseline)}`] : []),
    ].join(' · '),
  }));
  return {
    say: earlier ? `${earlier} Here is the week of ${named}. ${week.text}` : week.text,
    tone: 'answer',
    card: {
      kind: 'list',
      title: isThisWeek || !named ? 'This week' : `Week of ${named}`,
      meta: week.isoWeek ?? '',
      ...(facts.length ? { facts } : {}),
      items,
      empty: isThisWeek ? 'Nothing at the door this week.' : 'Nothing at the door that week.',
      footnote: week.simulated
        ? 'Simulated: this is a demo home, and nobody lived this week.'
        : 'The person this is about read it first, on their own television.',
    },
  };
}

/** "Saturday 10 October" from the server's "Saturday 10 October 2026". */
const withoutYear = (dayInWords) => (dayInWords ?? '').replace(/ \d{4}$/, '');
const isToday = (date, now) => !date || date === new Date(now).toISOString().slice(0, 10);

function presentToday(today, formatTime, now) {
  const events = [...today.events].sort(byTime);
  const kept = today.keptPrivate ?? [];
  const thisDay = isToday(today.date, now);
  const day = withoutYear(today.dayInWords);
  const when = thisDay ? 'so far today' : `on ${day}`;
  const lead =
    events.length === 0
      ? `Nothing at the door ${when}.`
      : events.length === 1
        ? `One thing ${when}: ${lowerFirst(events[0].summary)}`
        : `${things(events.length)} ${when}. ${thisDay ? 'Most recently' : 'Last'}: ${lowerFirst(events[events.length - 1].summary)}`;
  const say = [lead, ...kept].join(' ');
  if (events.length === 0) return { say, card: null, tone: kept.length ? 'private' : 'answer' };
  return {
    say,
    tone: 'answer',
    card: {
      kind: 'list',
      title: thisDay ? 'Today' : day,
      meta: '',
      items: events.map((e) => ({ primary: e.summary, secondary: formatTime(e.at) })),
      ...(kept.length ? { footnote: kept.join(' ') } : {}),
    },
  };
}

function presentVisitor(v, formatTime, now) {
  if (!v.name) return { say: "I don't have anyone by that name among the regular visitors.", card: null, tone: 'answer' };
  if (!isToday(v.date, now)) {
    const day = withoutYear(v.dayInWords);
    const say = v.visited
      ? `Yes. ${v.name} came on ${day}, at ${formatTime(v.at)}.`
      : `No. ${v.name} did not come on ${day}${v.expectedToday ? ', though it is one of their usual days.' : ', and it is not one of their usual days.'}`;
    return { say, card: null, tone: 'answer' };
  }
  const say = v.visited
    ? `Yes. ${v.name} came at ${formatTime(v.at)}.${v.expectedToday ? ' Today is one of their usual days.' : ''}`
    : v.expectedToday
      ? `Not yet. ${v.name} usually comes today.`
      : `No. ${v.name} hasn't come today, and today isn't one of their usual days.`;
  return { say, card: null, tone: 'answer' };
}

/**
 * Something's Different. The server writes every sentence and the summary;
 * this only lays them out. A usual day is said and shows no card: there is
 * nothing behind "nothing is different" to look at.
 */
function presentDifferent(answer, formatTime) {
  const differences = answer.differences ?? [];
  const say = typeof answer.summary === 'string' ? answer.summary : 'Nothing is different from the usual today.';
  if (differences.length === 0) return { say, card: null, tone: 'answer' };
  return {
    say,
    tone: 'answer',
    card: {
      kind: 'list',
      title: differences.length === 1 ? 'One thing is different' : `${things(differences.length)} are different`,
      meta: '',
      items: differences.map((d) => ({ primary: d.sentence, secondary: formatTime(d.at) })),
      footnote: `Against the last ${answer.weeksObserved} weeks in this house, and nothing else.`,
    },
  };
}

/**
 * Being told when Wick is closed (Web Push). What the page says about it,
 * from what the browser and the server allow.
 *
 * @param {{supported?: boolean, available?: boolean, permission?: string, subscribed?: boolean}} state
 * @param {string} residentName
 */
export function presentNotifications(state, residentName) {
  const nothing = (say) => ({ offer: false, say, card: null });
  if (!state.supported) return nothing('This browser cannot show notifications from Wick.');
  if (!state.available) return nothing('This Wick cannot send notifications yet.');
  // A browser asks once. After "Block", only its own settings can change it.
  if (state.permission === 'denied') return nothing('This browser has blocked notifications for Wick. They can be allowed again in the browser’s site settings.');
  if (state.permission === 'granted' && state.subscribed) {
    return nothing(`Notifications are on in this browser. It will tell you when ${residentName} asks you to look at the door.`);
  }
  return {
    offer: true,
    say: `This browser can tell you when ${residentName} asks you to look at the door, even when Wick is closed.`,
    card: {
      title: 'Be told at once',
      body: 'The notification says only that there is something to look at. The picture and everything else stay in Wick.',
      confirmLabel: 'Turn on notifications',
    },
  };
}

/** The server's public signing key (base64url) as the bytes `pushManager.subscribe` takes. */
export function applicationServerKey(base64url) {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/**
 * Whether a subscription this browser already holds was made with the
 * server's present key. One made with another key — the keys were replaced,
 * or this browser last talked to a different Wick — is refused by the push
 * service when Wick sends to it, so it is thrown away and made again.
 *
 * @param {{options?: {applicationServerKey?: ArrayBuffer | null}}} subscription
 * @param {string} publicKey  the server's key, base64url
 */
export function madeWithKey(subscription, publicKey) {
  const held = subscription?.options?.applicationServerKey;
  if (!held) return false;
  const mine = new Uint8Array(held);
  const theirs = applicationServerKey(publicKey);
  return mine.length === theirs.length && mine.every((byte, i) => byte === theirs[i]);
}

/** Only a picture over https is ever drawn: the address comes from a tool result, and is put in an <img>. */
const httpsUrl = (value) => (typeof value === 'string' && /^https:\/\/[^\s"'<>]+$/.test(value) ? value : null);

/**
 * A question from the front door (get_door_request). While it waits it is a
 * card with the picture the resident is looking at, the one sentence under
 * it, and the answers that can be given — as buttons, each showing the very
 * words that will appear on the television.
 */
function presentDoorRequest(request, formatTime) {
  if (request.state === 'answered' && request.answer) {
    return { say: `${request.answer.by} answered ${formatTime(request.answer.at)}: “${request.answer.text}”`, card: null, tone: 'answer' };
  }
  if (request.state !== 'waiting') {
    return { say: `You were asked to look at the door ${formatTime(request.askedAt)}. The door card has since gone from the television.`, card: null, tone: 'answer' };
  }
  const description = typeof request.description === 'string' && request.description ? request.description : null;
  const pictureUrl = httpsUrl(request.pictureUrl);
  const offered = Array.isArray(request.answers) ? request.answers : [];
  return {
    say: `You have been asked to look at the door. ${description ?? (pictureUrl ? 'The picture is below.' : 'The picture has not arrived yet.')}`,
    tone: 'answer',
    card: {
      kind: 'door',
      title: typeof request.line === 'string' ? request.line : 'Someone’s at the front door.',
      meta: `Asked ${formatTime(request.askedAt)}`,
      requestId: request.requestId,
      pictureUrl,
      description,
      // The words on each button are the server's, and only for a key this page knows.
      answers: offered.filter((a) => Object.hasOwn(DOOR_ANSWERS, a?.key) && DOOR_ANSWERS[a.key] === a.text).map((a) => ({ key: a.key, text: a.text })),
      footnote: 'Your answer goes on the television at once, under your name.',
    },
  };
}

/**
 * Whether a look at get_door_request, made unasked while the app is open,
 * found something to say: a question still waiting that has not been
 * announced yet. Returns its id, or null.
 *
 * @param {string} raw  the tool result's text
 * @param {Set<string>} announced  the ids already announced in this page
 */
export function doorQuestionToAnnounce(raw, announced) {
  const request = parseJson(raw);
  if (!request || request.state !== 'waiting' || typeof request.requestId !== 'string') return null;
  return announced.has(request.requestId) ? null : request.requestId;
}

function presentVisitors(list, formatTime) {
  const visitors = list.visitors ?? [];
  const expected = list.expected ?? [];
  if (visitors.length === 0 && expected.length === 0) return { say: 'Nobody is down as a regular visitor yet.', card: null, tone: 'answer' };

  const [first] = visitors;
  const say = !first
    ? `${expected[0].name} is expected ${formatTime(expected[0].at)}.`
    : first.usualDays
      ? `${first.name} usually comes on ${first.usualDays}.`
      : `${first.name} is a regular visitor.`;
  return {
    say,
    tone: 'answer',
    card: {
      kind: 'list',
      title: 'Who visits',
      meta: '',
      items: [
        ...visitors.map((v) => ({
          primary: v.name,
          secondary: [v.usualDays, v.lastVisitAt !== undefined ? `last came ${formatTime(v.lastVisitAt)}` : null].filter(Boolean).join(' · ') || 'Regular visitor',
        })),
        ...expected.map((v) => ({ primary: v.name, secondary: `Expected ${formatTime(v.at)}` })),
      ],
      footnote: 'By the day and the time, never by a face.',
    },
  };
}

function presentExpectedVisit(visit, formatTime) {
  const also = visit.alsoExpectedThatDay ?? [];
  return {
    say: `The door will expect you around ${formatTime(visit.at)}.`,
    tone: 'answer',
    card: {
      kind: 'confirmation',
      title: 'The door expects you',
      fields: [
        ['Who', visit.name ?? ''],
        ['When', formatTime(visit.at)],
        ['Also due that day', also.length ? also.join(', ') : 'Nobody else'],
      ],
      footnote: 'If the doorbell goes within an hour of then, the television says it looks like you.',
    },
  };
}

function presentRegularVisitor(added) {
  const days = added.usualDays ? ` on ${added.usualDays}` : '';
  return {
    say: added.changed ? `Changed. ${added.name} is now expected${days}.` : `Added. The door will expect ${added.name}${days}.`,
    tone: 'answer',
    card: {
      kind: 'confirmation',
      title: added.changed ? 'A regular visitor, changed' : 'A regular visitor, added',
      fields: [
        ['Who', added.name ?? ''],
        ['Usually', added.usualDays || 'No days given'],
      ],
      footnote: 'By the day and the time, never by a face.',
    },
  };
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
        ['Message', context.message ?? sent.message ?? ''],
        // The server's word on what was offered: it may have set aside what was drafted.
        ...(Array.isArray(sent.replies) && sent.replies.length ? [['Can be answered with', sent.replies.join(' · ')]] : []),
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
  const now = context.now ?? Date.now();
  if (toolName === 'get_today' && Array.isArray(parsed.events)) return presentToday(parsed, formatTime, now);
  if (toolName === 'did_visitor_come' && typeof parsed.visited === 'boolean') return presentVisitor(parsed, formatTime, now);
  if (toolName === 'list_regular_visitors' && Array.isArray(parsed.visitors)) return presentVisitors(parsed, formatTime);
  if (toolName === 'get_whats_different' && Array.isArray(parsed.differences)) return presentDifferent(parsed, formatTime);
  if (toolName === 'expect_visit' && parsed.expected === true) return presentExpectedVisit(parsed, formatTime);
  if (toolName === 'add_regular_visitor' && parsed.added === true) return presentRegularVisitor(parsed);
  if (toolName === 'send_note_to_tv' && parsed.sent === true) return presentNoteSent(context, parsed);
  if (toolName === 'get_replies' && Array.isArray(parsed.notes)) return presentReplies(parsed, formatTime);
  if (toolName === 'get_resident_shared_view' && Array.isArray(parsed.sharedWithFamily)) return presentSharedView(parsed);
  if (toolName === 'get_door_request' && typeof parsed.requestId === 'string' && typeof parsed.state === 'string') return presentDoorRequest(parsed, formatTime);
  if (toolName === 'answer_door_request' && parsed.shown === true) {
    return { say: `It is on the television now: “${parsed.by} says: ${parsed.text}”`, card: null, tone: 'answer' };
  }

  // A shape this surface does not know: say so, never render a guess.
  return { say: 'I got an answer I could not read.', card: null, tone: 'error' };
}

// ---------------------------------------------------------------------------
// A turn of the model-driven conversation. The Wick server's assistant
// (services/mcp-server/src/assistant) chooses which tools to call and what
// to say; this app makes the calls over MCP and shows what came back. What
// follows is how one such turn — several tools, one answer — is presented.
// ---------------------------------------------------------------------------

/**
 * Whether a call is shown to the customer before it is made. Everything is,
 * unless the server itself marks the tool read-only (MCP's `readOnlyHint`,
 * from tools/list). The rule fails closed on purpose: this page keeps no
 * list of its own, so a write added to the server next month, a tool with
 * no annotations, and a server that could not be asked are all confirmed.
 *
 * @param {string} _toolName
 * @param {{readOnlyHint?: boolean} | undefined} annotations  the tool's own, from the server
 */
export const needsConfirmation = (_toolName, annotations) => annotations?.readOnlyHint !== true;

/** What the assistant is told when the customer says no. Not an error: it is their answer. */
export const DECLINED_RESULT = 'The customer chose not to do this. Nothing was sent or changed.';

const DAY_WORDS = { today: 'today', yesterday: 'yesterday' };
const dayAsked = (args) => {
  const day = String(args?.day ?? '').toLowerCase();
  if (DAY_WORDS[day]) return DAY_WORDS[day];
  if (day) return sentenceCase(day);
  if (!args?.date) return 'today';
  const at = new Date(`${args.date}T00:00:00Z`);
  return Number.isNaN(at.getTime()) ? String(args.date) : at.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
};

/** What a step did, in a few words — never a tool's name, which means nothing to the person asking. */
export function describeCall(toolName, args = {}) {
  switch (toolName) {
    case 'get_week_narrative': return 'Read the week';
    case 'get_today': return `Looked at ${dayAsked(args)}`;
    case 'list_regular_visitors': return 'Checked who visits';
    case 'get_whats_different': return 'Looked for anything different';
    case 'did_visitor_come': return `Checked ${dayAsked(args)}’s visits`;
    case 'get_replies': return 'Looked for a reply';
    case 'get_resident_shared_view': return 'Checked what is shared';
    case 'send_note_to_tv': return 'Put a note on the television';
    case 'expect_visit': return 'Told the door';
    case 'add_regular_visitor': return 'Added a regular visitor';
    case 'get_door_request': return 'Looked at the question from the door';
    case 'answer_door_request': return 'Answered on the television';
    default: return 'Asked Wick';
  }
}

const DECLINED_TRACE = { send_note_to_tv: 'Did not send the note', expect_visit: 'Did not tell the door', answer_door_request: 'Did not answer' };

/** "Saturday 17 October, 15:00" from the date and time a visit was asked for — said in full, so a wrong day is seen before it is sent. */
function visitWhen(date, time) {
  const at = new Date(`${date}T${time}:00Z`);
  if (Number.isNaN(at.getTime())) return `${date ?? ''} ${time ?? ''}`.trim();
  return `${at.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })}, ${time}`;
}

/** Every argument not already shown, by its own name: nothing is sent that was not on the card. */
const otherFields = (args, shown) =>
  Object.entries(args ?? {})
    .filter(([name]) => !shown.includes(name))
    .map(([name, value]) => [name, typeof value === 'string' ? value : JSON.stringify(value)]);

/**
 * The question put to the customer before a write is made: what it is, and
 * every value that would be sent. A write this page does not know is shown
 * under the server's own name for it, with its arguments as they are —
 * never dressed up as one it does know.
 *
 * @param {string} toolName
 * @param {object} args
 * @param {string} [title]  the tool's title from tools/list
 */
/** The sentences for two keys from the list, or null when that is not what was passed. */
function chosenReplies(keys) {
  if (!Array.isArray(keys)) return null;
  const texts = [...new Set(keys)].filter((k) => typeof k === 'string' && Object.hasOwn(REPLY_CHOICES, k)).map((k) => REPLY_CHOICES[k]);
  return texts.length >= 2 ? texts.slice(0, 2) : null;
}

export function confirmWrite(toolName, args = {}, title) {
  if (toolName === 'expect_visit') {
    return {
      title: 'Tell the door you are coming?',
      fields: [['When', visitWhen(args.date, args.time)], ...otherFields(args, ['date', 'time'])],
      confirmLabel: 'Tell the door',
      footnote: 'If the doorbell goes within an hour of then, the television says it looks like you.',
    };
  }
  if (toolName === 'add_regular_visitor') {
    return {
      title: 'Add a regular visitor?',
      fields: [
        ['Who', String(args.name ?? '')],
        ['Days', Array.isArray(args.days) ? args.days.map((d) => sentenceCase(String(d))).join(', ') : ''],
        ['Around', String(args.time ?? '')],
        ...otherFields(args, ['name', 'days', 'time']),
      ],
      confirmLabel: 'Add',
      footnote: 'When the doorbell goes around then on one of those days, the television says who it looks like. It goes by the day and the time, never by a face.',
    };
  }
  if (toolName === 'send_note_to_tv') {
    return {
      title: 'Send this note to the television?',
      fields: [
        ['Message', String(args.message ?? '')],
        // What the resident will be offered to answer with: seen before it is
        // sent. Two keys from the list, or the server uses its standing three.
        ...(chosenReplies(args.replies) ? [['Replies offered', [...chosenReplies(args.replies), 'Not right now.'].join(' · ')]] : []),
        ...otherFields(args, ['message', 'replies']),
      ],
      confirmLabel: 'Send',
      footnote: 'It appears at the next natural break, never in the middle of a programme.',
    };
  }
  if (toolName === 'answer_door_request') {
    const key = String(args.answer ?? '');
    return {
      title: 'Show this on the television?',
      // The sentence itself, for a key this page knows; otherwise the key as
      // it was passed — the server will refuse it, and it is not dressed up.
      fields: [['Your answer', Object.hasOwn(DOOR_ANSWERS, key) ? DOOR_ANSWERS[key] : key], ...otherFields(args, ['answer'])],
      confirmLabel: 'Show it',
      footnote: 'It appears on the door card at once, under your name.',
    };
  }
  return {
    title: `${title || toolName}?`,
    fields: otherFields(args, []),
    confirmLabel: 'Go ahead',
    footnote: 'This changes something. Nothing is done until you say so.',
  };
}

/**
 * One answer from several tools.
 *
 * @param {string | undefined} say  the assistant's sentence, or undefined when it had none fit to use
 * @param {{name: string, args: object, presented: object | null}[]} steps  each call, and how its result is presented (null: the customer declined it)
 */
export function presentTurn(say, steps) {
  const done = steps.filter((s) => s.presented);
  // With no sentence from the assistant, the tools' own are said instead: never silence, never a guess.
  const said = say ?? done.map((s) => s.presented.say).join(' ');
  // A turn in which nothing was answered — every tool refused or failed — keeps that tone.
  const refused = done.length > 0 && done.every((s) => s.presented.tone !== 'answer');
  return {
    say: said,
    tone: refused ? done[done.length - 1].presented.tone : 'answer',
    cards: done.map((s) => s.presented.card).filter(Boolean),
    trace: steps.map((s) => (s.presented ? describeCall(s.name, s.args) : (DECLINED_TRACE[s.name] ?? 'Did not do that'))).join(' · '),
  };
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
/**
 * The home's doorbell, for its organiser: whether Ring is connected, how,
 * and what can be done about it. `link` is GET /api/ring's answer.
 *
 * Two ways a home is connected, and they are never passed off as each other:
 * through a Ring account, which keeps itself going, or to Ring's Developer
 * Playground — Ring's simulator — with a pasted token that stops after about
 * half an hour. The second is said to be the simulator wherever it is named.
 *
 * @param {object} link
 * @param {{ household: { residentName: string } }} me
 * @param {(atMs: number) => string} formatTime
 */
export function presentDoorbell(link, me, formatTime = defaultFormatTime) {
  const resident = me.household.residentName;
  const title = `${resident}’s doorbell`;
  const offers = { ring: true, playground: link.playgroundAllowed === true };

  if (!link.linked) {
    return {
      say: `No doorbell is connected to ${resident}’s home yet.`,
      tone: 'answer',
      card: {
        title,
        rows: [],
        footnote: offers.playground
          ? 'Connect a Ring account, or try it with Ring’s simulator, the Developer Playground.'
          : 'Connect the Ring account the doorbell belongs to.',
        actions: { connectRing: offers.ring, playground: offers.playground, disconnect: false },
      },
    };
  }

  const cameras = link.cameras ?? [];
  const rows = cameras.map((name) => ({ primary: name, secondary: link.simulated ? 'Simulated camera' : 'Ring' }));
  const elsewhere = link.heldElsewhere > 0
    ? ` ${count(link.heldElsewhere)} of its devices ${link.heldElsewhere === 1 ? 'belongs' : 'belong'} to another home and ${link.heldElsewhere === 1 ? 'was' : 'were'} left alone.`
    : '';
  const none = cameras.length === 0 ? ' Ring listed no camera for it.' : '';

  if (link.simulated) {
    const ended = link.expired === true;
    const until = link.expiresAt === undefined ? '' : ended ? ` Its token stopped working ${formatTime(link.expiresAt)}.` : ` Its token works until ${formatTime(link.expiresAt)}.`;
    return {
      say: ended
        ? `${resident}’s home was connected to Ring’s simulator, and that link has ended.`
        : `${resident}’s home is connected to Ring’s simulator, not to a real doorbell.`,
      tone: ended ? 'waiting' : 'answer',
      card: {
        title,
        rows,
        footnote: `Ring’s Developer Playground is a simulated doorbell.${until}${none}${elsewhere} Paste a new token to carry on.`,
        actions: { connectRing: offers.ring, playground: offers.playground, disconnect: true },
      },
    };
  }

  return {
    say: `${resident}’s doorbell is connected through Ring.`,
    tone: 'answer',
    card: {
      title,
      rows,
      footnote: `Wick keeps this link going by itself.${none}${elsewhere}`,
      actions: { connectRing: false, playground: false, disconnect: true },
    },
  };
}

export function inviteLink(here, code) {
  const url = new URL(here);
  url.search = '';
  url.hash = '';
  url.searchParams.set('invite', code);
  return url.toString();
}
