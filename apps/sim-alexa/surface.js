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

/**
 * What can be answered when the resident holds the button on the remote and
 * asks to be rung, or says hello. The server's own list (packages/contracts
 * reach.ts), copied for the reason above and held equal to it by a test.
 */
export const REACH_ANSWERS = {
  now: 'I’m ringing you now.',
  soon: 'I’ll ring you within the hour.',
  hello: 'Hello to you too.',
};

/**
 * The films that can be watched together, by id, and what can be answered
 * when one is over. The server's own lists (packages/contracts
 * programmes.ts and watch.ts), copied for the reason above and held equal
 * by a test.
 */
export const FILMS = {
  'big-buck-bunny': 'Big Buck Bunny',
  sintel: 'Sintel',
  'tears-of-steel': 'Tears of Steel',
};

export const WATCH_ANSWERS = {
  loved_it: 'I loved it.',
  all_right: 'It was all right.',
  not_for_me: 'Not really for me.',
};

/** The chips under the conversation. Each must route to a tool (tested). */
export const SUGGESTIONS = [
  { label: 'How’s Mum been this week?', utterance: "How's Mum been this week?" },
  { label: 'What happened today?', utterance: 'What happened today?' },
  { label: 'Did Maria come today?', utterance: 'Did Maria come today?' },
  { label: 'Were this week’s visits confirmed?', utterance: "Were this week's visits confirmed?" },
  { label: 'Is anything different?', utterance: 'Is anything different?' },
  { label: 'Is the light on?', utterance: "Is the light on at Mum's?" },
  { label: 'Send a note to her television', utterance: "Put a note on Mum's television" },
  { label: 'Has Mum replied?', utterance: 'Has Mum replied?' },
  { label: 'Did Mum ask me to look?', utterance: 'Has Mum asked me to look at the door?' },
  { label: 'Did Mum ask for me?', utterance: 'Did Mum ask for me?' },
  { label: 'Watch a film with Mum', utterance: 'Ask Mum to watch a film with me' },
  { label: 'What can I see?', utterance: 'What can I see about Mum?' },
  { label: 'Family circle', utterance: 'Who is in the family circle?' },
  { label: 'Television language', utterance: "What language is Mum's television in?" },
  { label: 'Send a picture', utterance: 'Send Mum a picture' },
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

  // Said about a film, or about watching with someone: "invite Mum to watch
  // Sintel" asks her to a film, not into the family circle.
  const aboutAFilm = /\b(film|movie)\b/.test(t) || /\bwatch(ing)?\b.*\b(together|with)\b/.test(t);

  // A television said to be one's own — "connect my television", "this is my
  // TV" — goes straight to connecting it as mine. Before the circle, which
  // has "connect a television"; and "my" must be the television's, so
  // "connect my mum's television" stays hers. A note that says so is a note.
  if (
    /\b(?:connect|pair|add|set up)\b.*\bmy (?:own )?(?:television|tv|telly)\b|\bthis is my (?:own )?(?:television|tv|telly)\b/.test(t) &&
    !NOTE_WITH_MESSAGE.some((pattern) => pattern.test(said))
  ) return { kind: 'connect', as: 'family' };

  // The circle is the app's own business, not a question for a tool. "Connect
  // a television" is; "put a note on her television" is not.
  if (/\bcircle\b|\bconnect\b.*\b(television|tv)\b/.test(t) || (!aboutAFilm && /\binvit(e|ation)\b/.test(t))) return { kind: 'circle' };

  // The doorbell is the app's own business too: connecting Ring is something the organiser does here.
  if (/\b(connect|disconnect|link|unlink)\b.*\b(doorbell|ring)\b|\bdoorbell\b.*\bconnected\b/.test(t)) return { kind: 'doorbell' };

  // A demo home's stand-in doorbell: ringing it, or making somebody arrive. Whether this home has one is the card's to say.
  // "Did someone come to the door" is the day's list, not this.
  if (/\bstand-?in doorbell\b|^ring (?:the )?door ?bell\b|\bmake (?:someone|somebody) (?:come|arrive)\b/.test(t)) return { kind: 'standin' };

  // The language her television speaks is the app's own business as well: the
  // organiser asks for another here, and she answers on the television. Said
  // by the word, or by naming a language together with the television. A note
  // that mentions either is still a note, and a Spanish film is still a film.
  if (
    (/\blanguage\b/.test(t) || (/\b(spanish|español|espanol|english)\b/.test(t) && /\b(television|tv|telly|wick)\b/.test(t))) &&
    !aboutAFilm &&
    !/\bnote\b|\bmessage\b/.test(t) &&
    !NOTE_WITH_MESSAGE.some((pattern) => pattern.test(said))
  ) return { kind: 'language' };

  // A picture for her television. A note that mentions a picture is still a
  // note, the picture from the door is the door's, and a film is a film.
  if (
    /\b(pictures?|photos?|photographs?)\b/.test(t) &&
    !aboutAFilm &&
    !/\bdoor\b|\bnote\b|\bmessage\b/.test(t) &&
    !NOTE_WITH_MESSAGE.some((pattern) => pattern.test(said))
  ) {
    // Asking after one already sent — has she seen it, did it arrive, what did
    // she think — is a question, and the answer is the server's: get_pictures,
    // which the assistant is told to call for it and which says only whether
    // a picture has been seen. A question, said of something that has
    // happened to a picture; "can I send her a picture?" is neither.
    const isAQuestion = /^(?:has|have|had|did|does|do|is|are|was|were|what|when|which|any)\b/.test(t) || /\?\s*$/.test(t);
    const ofOneSent =
      /\b(?:seen|saw|see|looked|look at|got|get|gotten|received?|arrived?|reach(?:ed)?|kept|keep|keeping|like[ds]?|think|thought|sent|waiting|happened)\b/.test(t) ||
      /^(?:did|has|have|had)\b.*\bsend\b/.test(t);
    if (isAQuestion && ofOneSent) return tool('get_pictures');
    // Wanting to send one is the app's own business: a picture is a file, and no tool can be handed one.
    return { kind: 'picture' };
  }

  // "Ask Sarah to look": the resident's question about who is at the door.
  // Narrow on purpose — "did anyone come to the door today" is the day's list.
  if (/\bask(?:ed|ing)? (?:me|us) to look\b|\bwho(?:'|’)?s at\b.*\bdoor\b|\bwho is at\b.*\bdoor\b|\bsomeone at\b.*\bdoor\b/.test(t)) return tool('get_door_request');

  // "Hold for Sarah": the resident held the button on the remote and asked to
  // be rung, or said hello. After the door, so "ask me to look" stays the
  // door's; and after "tell Mum …", because a note that says hello is a note.
  if (
    (/\bask(?:s|ed|ing)? (?:for|after) (?:me|us)\b|\b(?:wants?|wanted|like|ask(?:s|ed|ing)?) (?:me|us) to (?:ring|call|phone|telephone)\b|\bbeen in touch\b|^(?:did|has|have)\b.*\bsa(?:y|id) hello\b/.test(t)) &&
    !NOTE_WITH_MESSAGE.some((pattern) => pattern.test(said))
  ) return tool('get_reach_request');

  // Notifications are the app's own business with this browser.
  if (/\bnotif(?:y|ication|ications)\b/.test(t)) return { kind: 'notifications' };

  // Watching a film together. Asking for one is the invitation; asking about one is the tool.
  // After "tell Mum …": a note that mentions a film is still a note.
  if (aboutAFilm && !NOTE_WITH_MESSAGE.some((pattern) => pattern.test(said))) {
    // Taking one back is asked of what stands: the invitation is shown, with the button that withdraws it.
    const takesBack = /\b(cancel|withdraw|call off)\b|\b(take|taking)\b.*\bback\b/.test(t);
    const asksFor = !takesBack && /\b(ask|invite|like to|want to|can we|could we|shall we|let(?:'|’)?s)\b/.test(t) && !/\b(did|has|have|say|said|time)\b/.test(t);
    return asksFor ? { kind: 'invite' } : tool('get_watch_together');
  }

  // The light in the window. After "tell Mum …": a note that mentions a light is still a note.
  if (/\blight\b/.test(t) && !NOTE_WITH_MESSAGE.some((pattern) => pattern.test(said))) return tool('get_light');

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
  // The visit, witnessed: the visits of a stretch of days, and whether each was confirmed. One day's yes or
  // no — "did Maria come today", "has the carer been" — stays where it was, on the line below.
  if (
    /\bvisit record\b|\bvisits?\b.*\bconfirm|\bconfirm\w*\b.*\bvisits?\b|\bhow long\b.*\b(maria|carer|visit|here|stay)/.test(t) ||
    (/\bmaria\b|\bcarer\b/.test(t) && /\b(this|last|past) (week|fortnight|month)\b/.test(t))
  ) {
    // Seven days unless a longer stretch was named: "last week" is this week and the one before.
    return tool('get_visits', /\bmonth\b/.test(t) ? { days: 31 } : /\blast week\b|\bfortnight\b/.test(t) ? { days: 14 } : {});
  }
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
export function suggestionsFor(listing, me = null) {
  // A demo home has a stand-in doorbell, and its chip comes last: the questions come first.
  const own = me?.household?.simulated === true ? [...SUGGESTIONS, STAND_IN_CHIP] : SUGGESTIONS;
  const phrases = listing?.phrases ?? [];
  if (phrases.length === 0) return own;
  const asks = (utterance) => {
    const route = routeUtterance(utterance);
    return route.kind === 'tool' ? route.tool : route.kind;
  };
  const promised = new Set(phrases.map(asks));
  return [
    ...phrases.map((phrase) => ({ label: `${sentenceCase(phrase).replace(/'/g, '’')}?`, utterance: phrase })),
    ...own.filter((suggestion) => !promised.has(asks(suggestion.utterance))),
  ];
}

// ---------------------------------------------------------------------------
// A demo home's stand-in doorbell (packages/contracts demoDoor.ts): somebody
// made to arrive at the door, so that the door card can be seen on her
// television. The server decides who may ring and how often
// (POST /api/demo/doorbell); this is what the card says.

/** The chip, shown in a demo home only (suggestionsFor). */
const STAND_IN_CHIP = { label: 'Ring the stand-in doorbell', utterance: 'Ring the stand-in doorbell' };

/** The stand-in visitors, as the server takes them (contracts demoDoor.ts; held to it by a test). */
export const STAND_IN_VISITORS = [
  { key: 'carer', label: 'Maria, the carer' },
  { key: 'parcel', label: 'A parcel delivery' },
  { key: 'stranger', label: 'Somebody she does not know' },
  { key: 'nobody', label: 'Nobody there, only movement' },
];

/**
 * Who the card is for: anybody the resident has allowed in a demo home, and
 * not a neighbour. In any other home there is no stand-in: its door is its own.
 *
 * @param me  GET /api/me
 */
export function standInDoorOffer(me) {
  const resident = me.household.residentName;
  const { role, status } = me.membership;
  if (me.household.simulated !== true) {
    return { offered: false, say: `The stand-in doorbell is only in a demo home. ${resident}’s own doorbell rings by itself.`, tone: 'answer' };
  }
  if (role === 'neighbour') return { offered: false, say: 'A neighbour cannot ring the stand-in doorbell.', tone: 'answer' };
  if (status === 'allowed') return { offered: true };
  if (status === 'declined') return { offered: false, say: `${resident} chose not to share this with you.`, tone: 'private' };
  if (status === 'removed') return { offered: false, say: 'You are no longer part of this family circle.', tone: 'private' };
  return {
    offered: false,
    say: `${resident} hasn’t allowed this yet. A card is waiting on the television, and it only takes one press.`,
    tone: 'waiting',
  };
}

/**
 * Every word the card says for itself. What the server says — that it rang,
 * or why it did not — is said as the server said it.
 *
 * @param me  GET /api/me
 */
export function presentStandInDoorbell(me) {
  const resident = me.household.residentName;
  return {
    say: `Who should be at ${resident}’s door?`,
    title: `Someone at ${resident}’s door (stand-in doorbell)`,
    footnote:
      'This demo home has no Ring doorbell, so Wick stands one in. The pictures are made up; what happens next is Wick’s own door path: ' +
      'the card on her television, the sentence about the picture, and asking you to look.',
    visitors: STAND_IN_VISITORS,
    ringing: 'Ringing the doorbell…',
    rung: `${resident}’s television will show who is at the door. Answer it there.`,
  };
}

export const HELP_TEXT =
  'I can tell you how the week has been, what happened today, whether Maria came, whether her visits were confirmed, whether anything is different, ' +
  'put a note on the television, tell you if there is a reply, show what you are able to see, ' +
  'send a picture to the television, open the family circle, or show which language the television speaks.';

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
 * What the resident asked Wick to tell (get_whats_different). The server
 * writes every sentence and the summary; this only lays them out.
 *
 * Nothing told shows no card, and is never said as "nothing is different":
 * the resident is asked first on their own television, and what they have
 * not answered, or chose to keep, looks exactly like nothing here.
 */
function presentDifferent(answer, formatTime) {
  const differences = answer.differences ?? [];
  const say = typeof answer.summary === 'string' ? answer.summary : 'Nothing has been passed on to you.';
  if (differences.length === 0) return { say, card: null, tone: 'answer' };
  return {
    say,
    tone: 'answer',
    card: {
      kind: 'list',
      title: differences.length === 1 ? 'One thing to tell you' : `${things(differences.length)} to tell you`,
      meta: '',
      items: differences.map((d) => ({ primary: d.sentence, secondary: `${formatTime(d.at)} · told ${formatTime(d.toldAt)}` })),
      footnote: answer.weeksObserved ? `Against the last ${answer.weeksObserved} weeks in this house, and nothing else.` : '',
    },
  };
}

/**
 * The light in the window (get_light): one thing about today. The server
 * writes the sentence, and it is said as it stands — a window that is not
 * lit is never given a reason here that the server did not give.
 */
function presentLight(answer) {
  const lit = answer.lit === true;
  return {
    say: typeof answer.summary === 'string' ? answer.summary : lit ? 'The light is on.' : 'The light is not on.',
    tone: 'answer',
    card: {
      kind: 'light',
      lit,
      title: lit ? 'The light is on' : 'The light is not on',
      // Looking is not hidden from the person looked at, and the person looking is told so.
      note: typeof answer.seen === 'string' ? answer.seen : '',
      footnote: 'One thing about today, and nothing else: no time, and nothing about what is on.',
    },
  };
}

/**
 * What the corner of the page shows of the light, from a get_light answer:
 * lit or not — or null when there is no light to see (not allowed yet, or
 * kept private), in which case the corner shows nothing at all.
 *
 * @param {string} raw  the tool result's text
 * @returns {{lit: boolean} | null}
 */
export function lightToShow(raw) {
  const answer = parseJson(raw);
  return answer && typeof answer.lit === 'boolean' ? { lit: answer.lit } : null;
}

/**
 * What a look at get_whats_different, made unasked when the app is opened,
 * found to say: the things the resident asked to be told that this browser
 * has not shown before. Returns their ids.
 *
 * @param {string} raw  the tool result's text
 * @param {string[]} shown  the ids this browser has already shown
 */
export function toldToAnnounce(raw, shown) {
  const answer = parseJson(raw);
  if (!answer || !Array.isArray(answer.differences)) return [];
  return answer.differences.map((d) => d?.id).filter((id) => typeof id === 'string' && !shown.includes(id));
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
    return nothing(`Notifications are on in this browser. It will tell you when ${residentName} asks you to look at the door or to ring.`);
  }
  return {
    offer: true,
    say: `This browser can tell you when ${residentName} asks you to look at the door or to ring, even when Wick is closed.`,
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

/**
 * A request to ring, or a hello, from the television (get_reach_request):
 * the resident held the button on the remote. While it waits it is a card
 * with the server's one sentence and the answers that can be given — as
 * buttons, each showing the very words that will appear on the television.
 * It carries no reason, and none is ever added here.
 */
function presentReachRequest(request, formatTime) {
  if (request.state === 'answered') {
    const who = request.answer.yours === true ? 'You' : request.answer.by;
    return { say: `${who} answered ${formatTime(request.answer.at)}: “${request.answer.text}”`, card: null, tone: 'answer' };
  }
  const ring = request.kind !== 'hello';
  const offered = Array.isArray(request.answers) ? request.answers : [];
  return {
    say: ring ? 'You have been asked to ring.' : 'You have been sent a hello.',
    tone: 'answer',
    card: {
      kind: 'reach',
      title: request.summary,
      meta: `${ring ? 'Asked' : 'Sent'} ${formatTime(request.askedAt)}`,
      requestId: request.requestId,
      // The words on each button are the server's, and only for a key this page knows.
      answers: offered.filter((a) => Object.hasOwn(REACH_ANSWERS, a?.key) && REACH_ANSWERS[a.key] === a.text).map((a) => ({ key: a.key, text: a.text })),
      // Answering is not ringing: said under the buttons, where it is read before one is pressed.
      note: ring ? 'This does not make the call. Ring her yourself.' : null,
      footnote: 'Your answer goes on the television at once, under your name.',
    },
  };
}

/** Whether a get_reach_request result is one of the two shapes this page draws. Anything else is said to be unreadable, never guessed at. */
const isReachRequest = (parsed) =>
  typeof parsed.requestId === 'string' &&
  ((parsed.state === 'waiting' && typeof parsed.summary === 'string') ||
    (parsed.state === 'answered' && typeof parsed.answer?.by === 'string' && typeof parsed.answer.text === 'string'));

/**
 * Whether the app looks, unasked, for a request to ring. An older Wick
 * server has no such tool: asking it would be refused on every turn of the
 * timer, for as long as the page is open — so it is not asked at all. When
 * the server could not say what it has, the look is made; one that fails is
 * passed over in silence (main.js lookForReach).
 *
 * @param {Iterable<string>} toolNames  the server's tools (tools/list); none when it could not be asked
 */
export function looksForReach(toolNames) {
  const names = [...toolNames];
  return names.length === 0 || names.includes('get_reach_request');
}

/**
 * Whether a look at get_reach_request, made unasked while the app is open,
 * found something worth saying. A request still waiting is said once. So is
 * somebody else's answer to a request that is on this page — its buttons are
 * no longer the thing to press. An answer already given when the page
 * opened is not news, and this person's own answer is not said back to them.
 *
 * @param {string} raw  the tool result's text
 * @param {Map<string, string>} seen  how each request stood at the last look
 * @returns {{requestId: string, state: string, announce: boolean} | null}  null when the answer is not a request
 */
export function reachToAnnounce(raw, seen) {
  const request = parseJson(raw);
  if (!request || !isReachRequest(request)) return null;
  const before = seen.get(request.requestId);
  const announce = request.state === 'waiting' ? before === undefined : before === 'waiting' && request.answer.yours !== true;
  return { requestId: request.requestId, state: request.state, announce };
}

// ---------------------------------------------------------------------------
// Watching a film together (get_watch_together, join_watch_together): the
// invitation, the seat, and — while the film is on — a player that follows
// the television's. The person here never controls it: the remote is the
// resident's, and this page only keeps up.
// ---------------------------------------------------------------------------

/** A film is played only from an https address, or from this machine (the dev server's stand-in). The address is put in a <video>. */
const streamUrl = (value) =>
  typeof value === 'string' && /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/)[^\s"'<>]+$/.test(value) ? value : null;

const WATCH_PLAYBACK_STATES = ['PLAYING', 'PAUSED', 'STOPPED', 'WAITING'];

function readPlayback(playback) {
  if (!playback || !WATCH_PLAYBACK_STATES.includes(playback.state)) return null;
  if (!Number.isFinite(playback.positionMs) || !Number.isFinite(playback.ageMs)) return null;
  return { state: playback.state, positionMs: playback.positionMs, ageMs: playback.ageMs };
}

function readStream(stream) {
  const url = streamUrl(stream?.url);
  if (!url) return null;
  return { url, durationMs: Number.isFinite(stream.durationMs) ? stream.durationMs : 0, attribution: typeof stream.attribution === 'string' ? stream.attribution : '' };
}

/** One line under the picture: what the television is doing, in words. */
export function watchStatus(view) {
  const playing = view.playback?.state;
  switch (view.state) {
    case 'accepted': return 'Sit down when you are ready.';
    case 'ready': return 'Waiting for the film to be started on the television.';
    case 'passed': return 'When it came to it, the answer was: not now.';
    case 'stopped': return 'The film was stopped on the television.';
    case 'watching':
    case 'watched':
      if (playing === 'PLAYING') return view.state === 'watched' ? 'The credits are playing.' : 'Playing, as on the television.';
      if (playing === 'PAUSED') return 'Paused on the television.';
      if (playing === 'WAITING') return 'Waiting for the television.';
      if (playing === 'STOPPED') return 'The film was stopped on the television.';
      return view.state === 'watched' ? 'This has finished.' : 'The film is starting on the television.';
    default: return 'This has finished.';
  }
}

/** Further than this from where the television is, and this screen jumps to it. */
export const FOLLOW_DRIFT_MS = 2500;
/** A paused picture is held to within this of the television's. */
const FOLLOW_STILL_MS = 500;

/**
 * Where this screen should be, given where the television is.
 *
 * @param {{state: string, positionMs: number, ageMs: number} | null} playback  from the server: where the film was, and how long before its answer
 * @param {number} sinceMs  how long ago that answer arrived here
 * @param {{positionMs: number, paused: boolean}} player  this screen's own player
 * @param {number} [durationMs]
 * @returns {{play: boolean, seekToMs: number | null}}  whether to be playing, and where to jump to (null: stay)
 */
export function follow(playback, sinceMs, player, durationMs = 0) {
  if (!playback || playback.state === 'STOPPED') return { play: false, seekToMs: null };
  const playing = playback.state === 'PLAYING';
  const moved = playing ? playback.ageMs + sinceMs : 0;
  const target = durationMs > 0 ? Math.min(playback.positionMs + moved, durationMs) : playback.positionMs + moved;
  const off = Math.abs(player.positionMs - target);
  return { play: playing, seekToMs: off > (playing ? FOLLOW_DRIFT_MS : FOLLOW_STILL_MS) ? target : null };
}

function presentWatch(view) {
  const film = typeof view.film === 'string' ? view.film : 'the film';
  const when = typeof view.when === 'string' ? view.when : '';
  const stream = readStream(view.stream);
  const playback = readPlayback(view.playback);
  const offered = Array.isArray(view.answers) ? view.answers : null;
  const quiet = (say) => ({ say, card: null, tone: 'answer' });

  // Still waiting: nothing to do but wait — or take it back (withdraw_watch_invitation).
  if (view.state === 'invited') {
    return {
      say: `The invitation to watch ${film} on ${when} is on the television. It has not been answered yet.`,
      tone: 'answer',
      card: {
        kind: 'invitation',
        title: film,
        meta: when,
        sessionId: view.sessionId,
        footnote: 'It stays on the television until it is answered. If your plans change, you can take it back.',
      },
    };
  }
  if (view.state === 'withdrawn') return quiet(`You took back the invitation to watch ${film} on ${when}. You can ask again whenever you like.`);
  if (view.state === 'cancelled') return quiet(`You called off ${film} on ${when}, and the television says so. You can ask again whenever you like.`);
  if (view.state === 'declined') return quiet(`The answer to ${film} on ${when} was: not this time.`);
  if (view.state === 'passed') return quiet('When it came to it, the answer was: not now.');
  if (view.state === 'over') return quiet(`The time for ${film} has passed.`);
  // She started it and left it. Her television follows nobody after that, so there is no seat to offer.
  if (view.state === 'stopped') return quiet(`${film} was stopped on the television before the end. You can ask again whenever you like.`);
  // Yes, and not time yet: nothing to do but wait — or say that it cannot be made after all (withdraw_watch_invitation).
  if (view.state === 'accepted' && view.canSitDown !== true) {
    return {
      say: `The answer was yes. ${film} is on ${when}; you can sit down from half an hour before.`,
      tone: 'answer',
      card: {
        kind: 'invitation',
        title: film,
        meta: when,
        sessionId: view.sessionId,
        accepted: true,
        footnote: 'If you cannot make it, say so here: the television will say so too.',
      },
    };
  }
  if (view.state === 'watched' && !stream && !offered) {
    // Who has answered, in the server's own sentence, which names who has not as well: an answer of one's own
    // is then never read as theirs. A sentence made here is only for a Wick that does not send one.
    if (typeof view.answersInWords === 'string') return quiet(`You watched ${film} together. ${view.answersInWords}`);
    const yours = typeof view.yourAnswer === 'string' ? ` You said: “${view.yourAnswer}”` : '';
    const theirs = typeof view.theirAnswer === 'string' ? ` The answer on the television was: “${view.theirAnswer}”` : '';
    return quiet(`You watched ${film} together.${yours}${theirs}`);
  }

  const say =
    view.state === 'accepted' ? `It is time for ${film}. Sit down when you are ready.`
    : view.state === 'ready' ? 'You are sitting down. The television says you are ready, and the film starts when it is started there.'
    : view.state === 'watched' ? `${film} has reached its end. ${typeof view.question === 'string' ? view.question : ''}`.trim()
    : `${film} is on. Your screen follows the television.`;
  return {
    say,
    tone: 'answer',
    card: {
      kind: 'watch',
      title: film,
      meta: when,
      sessionId: view.sessionId,
      state: view.state,
      canSitDown: view.canSitDown === true,
      // Until the film has been started it can still be called off; after that there is only stopping watching.
      canCallOff: view.state === 'accepted' || view.state === 'ready',
      stream,
      playback,
      question: typeof view.question === 'string' ? view.question : null,
      // The words on each button are the server's, and only for a key this page knows.
      answers: (offered ?? []).filter((a) => Object.hasOwn(WATCH_ANSWERS, a?.key) && WATCH_ANSWERS[a.key] === a.text).map((a) => ({ key: a.key, text: a.text })),
      yourAnswer: typeof view.yourAnswer === 'string' ? view.yourAnswer : null,
      theirAnswer: typeof view.theirAnswer === 'string' ? view.theirAnswer : null,
      footnote: 'Your screen follows the television. You cannot pause or skip: the remote is theirs. No camera, no microphone.',
    },
  };
}

/**
 * Whether a look at get_watch_together, made unasked while the app is open,
 * found something worth saying. It is said when there is something to do
 * now — it is time to sit down, the film is on, there is a question to
 * answer — and when an invitation is answered while this page is open. An
 * answer that was already there when the page opened is not news.
 *
 * @param {string} raw  the tool result's text
 * @param {Map<string, string>} seen  how each session stood at the last look
 * @returns {{sessionId: string, key: string, announce: boolean} | null}  null when the answer is not a session
 */
export function watchToAnnounce(raw, seen) {
  const view = parseJson(raw);
  if (!view || typeof view.sessionId !== 'string' || typeof view.state !== 'string') return null;
  const key = view.state === 'accepted' && view.canSitDown === true ? 'time' : view.state;
  const before = seen.get(view.sessionId);
  const toDo = key === 'time' || key === 'ready' || key === 'watching' || (key === 'watched' && Array.isArray(view.answers));
  const answered = before === 'invited' && (key === 'accepted' || key === 'declined');
  return { sessionId: view.sessionId, key, announce: before !== key && (toDo || answered) };
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

/** How many visits a card lists before it says how many came earlier. */
const VISIT_LINES = 7;

/** "13 Oct" from the server's "2026-10-13" — the day as it was at the house, which the server worked out. */
function dayAndMonth(date) {
  const at = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** Whether a get_visits result is the shape this page draws. Anything else is said to be unreadable, never guessed at. */
const isVisits = (parsed) =>
  typeof parsed.summary === 'string' &&
  Array.isArray(parsed.visits) &&
  parsed.visits.every((v) => typeof v?.name === 'string' && typeof v.day === 'string' && typeof v.date === 'string' && typeof v.arrived === 'string' && typeof v.confirmed === 'boolean');

/**
 * The visits of the regular visitors, and which of them the resident
 * confirmed (get_visits). The server writes the sentence, and it is said as
 * it stands. Each visit is one line, and says one of two things: confirmed,
 * or not confirmed. There is no third, no reason, and nothing that marks a
 * line out — a visit that is not confirmed is not a fault, and this page
 * does not know why it is not (the server does not say, on purpose).
 */
function presentVisits(answer) {
  const visits = answer.visits;
  if (visits.length === 0) return { say: answer.summary, card: null, tone: 'answer' };

  const resident = typeof answer.residentName === 'string' && answer.residentName ? answer.residentName : null;
  const days = Number.isInteger(answer.days) ? answer.days : null;
  const severalPeople = new Set(visits.map((v) => v.name)).size > 1;
  const earlier = visits.length - VISIT_LINES;
  return {
    say: answer.summary,
    tone: 'answer',
    card: {
      kind: 'visits',
      title: days === null ? 'Visits' : days === 1 ? 'Visits in the last day' : `Visits in the last ${days} days`,
      meta: '',
      // Newest first, as the server gives them.
      items: visits.slice(0, VISIT_LINES).map((v) => ({
        primary: [
          ...(severalPeople ? [v.name] : []),
          `${v.day} ${dayAndMonth(v.date)}`.trim(),
          typeof v.left === 'string' ? `${v.arrived} to ${v.left}` : `came at ${v.arrived}`,
        ].join(' · '),
        secondary: v.confirmed ? (resident ? `confirmed by ${resident}` : 'confirmed') : 'not confirmed',
      })),
      more: earlier > 0 ? `and ${earlier} earlier` : null,
      note: resident
        ? `The times are what the doorbell noted. Only ${resident} can confirm a visit, on her television.`
        : 'The times are what the doorbell noted. Only the person at home can confirm a visit, on their own television.',
      // A demo home's visits were written, not made (the server's demoHome.ts): said as it is of its weeks. Worded
      // to stay true when a visit from a real ring at its door is listed beside them — the server marks the answer, not each line.
      footnote: answer.simulated === true ? 'Simulated: this is a demo home, and nobody made the visits in its history.' : '',
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
  if (toolName === 'get_visits' && isVisits(parsed)) return presentVisits(parsed);
  if (toolName === 'get_whats_different' && Array.isArray(parsed.differences)) return presentDifferent(parsed, formatTime);
  if (toolName === 'get_light' && typeof parsed.lit === 'boolean') return presentLight(parsed);
  if (toolName === 'expect_visit' && parsed.expected === true) return presentExpectedVisit(parsed, formatTime);
  if (toolName === 'add_regular_visitor' && parsed.added === true) return presentRegularVisitor(parsed);
  if (toolName === 'send_note_to_tv' && parsed.sent === true) return presentNoteSent(context, parsed);
  if (toolName === 'get_replies' && Array.isArray(parsed.notes)) return presentReplies(parsed, formatTime);
  if (toolName === 'get_pictures' && typeof parsed.summary === 'string' && Array.isArray(parsed.pictures)) return presentPictures(parsed, formatTime);
  if (toolName === 'get_resident_shared_view' && Array.isArray(parsed.sharedWithFamily)) return presentSharedView(parsed);
  if (toolName === 'get_door_request' && typeof parsed.requestId === 'string' && typeof parsed.state === 'string') return presentDoorRequest(parsed, formatTime);
  if (toolName === 'answer_door_request' && parsed.shown === true) {
    return { say: `It is on the television now: “${parsed.by} says: ${parsed.text}”`, card: null, tone: 'answer' };
  }
  if (toolName === 'get_reach_request' && isReachRequest(parsed)) return presentReachRequest(parsed, formatTime);
  if (toolName === 'answer_reach_request' && parsed.shown === true) {
    return { say: `It is on the television now: “${parsed.by} says: ${parsed.text}”`, card: null, tone: 'answer' };
  }
  if (toolName === 'invite_to_watch' && parsed.invited === true) {
    return {
      say: 'Asked. The invitation will appear on the television at the next natural break, and is answered there with one button.',
      tone: 'answer',
      card: {
        kind: 'confirmation',
        title: 'Invitation sent to the television',
        fields: [['Film', parsed.film ?? ''], ['When', parsed.when ?? ''], ['From', parsed.fromName ?? '']],
        footnote: 'Ask “Did Mum say yes to the film?” at any time.',
      },
    };
  }
  if ((toolName === 'get_watch_together' || toolName === 'join_watch_together') && typeof parsed.sessionId === 'string' && typeof parsed.state === 'string') {
    return presentWatch(parsed);
  }
  if (toolName === 'withdraw_watch_invitation' && parsed.withdrawn === true && parsed.told === true) {
    return { say: `Called off. The television now says that you cannot make ${parsed.film ?? 'the film'} on ${parsed.when ?? ''}.`, card: null, tone: 'answer' };
  }
  if (toolName === 'withdraw_watch_invitation' && parsed.withdrawn === true) {
    return { say: `Taken back. The invitation to watch ${parsed.film ?? 'the film'} on ${parsed.when ?? ''} is no longer on the television.`, card: null, tone: 'answer' };
  }
  if (toolName === 'answer_watch_together' && parsed.shown === true) {
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
    case 'get_whats_different': return 'Looked for anything to tell you';
    case 'get_light': return 'Looked at the light';
    case 'did_visitor_come': return `Checked ${dayAsked(args)}’s visits`;
    case 'get_visits': return 'Looked at the visits';
    case 'get_replies': return 'Looked for a reply';
    case 'get_pictures': return 'Looked at your pictures';
    case 'get_resident_shared_view': return 'Checked what is shared';
    case 'send_note_to_tv': return 'Put a note on the television';
    case 'expect_visit': return 'Told the door';
    case 'add_regular_visitor': return 'Added a regular visitor';
    case 'get_door_request': return 'Looked at the question from the door';
    case 'answer_door_request': return 'Answered on the television';
    case 'get_reach_request': return 'Looked for a request to ring';
    case 'answer_reach_request': return 'Answered on the television';
    case 'invite_to_watch': return 'Asked to watch a film together';
    case 'get_watch_together': return 'Looked at the film';
    case 'join_watch_together': return 'Sat down to watch';
    case 'answer_watch_together': return 'Answered on the television';
    case 'withdraw_watch_invitation': return 'Took the invitation back';
    default: return 'Asked Wick';
  }
}

const DECLINED_TRACE = {
  send_note_to_tv: 'Did not send the note',
  expect_visit: 'Did not tell the door',
  answer_door_request: 'Did not answer',
  answer_reach_request: 'Did not answer',
  invite_to_watch: 'Did not ask',
  join_watch_together: 'Did not sit down',
  answer_watch_together: 'Did not answer',
  withdraw_watch_invitation: 'Did not take it back',
};

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
  if (toolName === 'answer_reach_request') {
    const key = String(args.answer ?? '');
    return {
      title: 'Show this on the television?',
      // As for the door: the sentence for a key this page knows, otherwise the key as it was passed.
      fields: [['Your answer', Object.hasOwn(REACH_ANSWERS, key) ? REACH_ANSWERS[key] : key], ...otherFields(args, ['answer'])],
      confirmLabel: 'Show it',
      footnote: 'It appears on the television under your name. It does not make the call.',
    };
  }
  if (toolName === 'invite_to_watch') {
    const id = String(args.programme ?? '');
    return {
      title: 'Ask to watch this together?',
      // The film by its name, for an id this page knows; otherwise the id as it would be sent.
      fields: [['Film', Object.hasOwn(FILMS, id) ? FILMS[id] : id], ['When', visitWhen(args.date, args.time)], ...otherFields(args, ['programme', 'date', 'time'])],
      confirmLabel: 'Ask',
      footnote: 'The invitation appears on the television at the next natural break, and is answered there with one button.',
    };
  }
  if (toolName === 'join_watch_together') {
    return {
      title: 'Sit down to watch now?',
      fields: otherFields(args, []),
      confirmLabel: 'Sit down',
      footnote: 'The television will say you are ready. The film starts when it is started there.',
    };
  }
  if (toolName === 'answer_watch_together') {
    const key = String(args.answer ?? '');
    return {
      title: 'Show this on the television?',
      fields: [['Your answer', Object.hasOwn(WATCH_ANSWERS, key) ? WATCH_ANSWERS[key] : key], ...otherFields(args, ['answer'])],
      confirmLabel: 'Show it',
      footnote: 'It appears on the television under your name.',
    };
  }
  if (toolName === 'withdraw_watch_invitation') {
    return {
      title: 'Take the invitation back?',
      fields: otherFields(args, ['sessionId']),
      confirmLabel: 'Take it back',
      footnote: 'An invitation not yet answered simply leaves the television. If the answer was yes, the television will say that you cannot make it.',
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
        ? `waiting for ${resident}`
        : `${resident} said no`;
  // A part worth saying is said first: the organiser's, and a neighbour's — who is there for the door and for ringing only.
  const part = member.role === 'organiser' ? 'Organiser' : member.role === 'neighbour' ? 'Neighbour' : null;
  return part ? `${part} · ${said}` : sentenceCase(said);
}

function televisionLine(televisions) {
  if (televisions.length === 0) return 'No television is connected yet.';
  const total = televisions.length;
  const on = televisions.filter((tv) => tv.connected).length;
  const n = `${count(total)} ${total === 1 ? 'television' : 'televisions'} connected`;
  if (total === 1) return on === 1 ? `${n}, and on now.` : `${n}. It is off, or showing something else.`;
  // Several: how many are on, never "on now" for all of them when some are off.
  if (on === 0) return `${n}. They are off, or showing something else.`;
  if (on === total) return `${n}, ${total === 2 ? 'both' : 'all'} on now.`;
  return `${n}. ${count(on)} ${on === 1 ? 'is' : 'are'} on now.`;
}

/** "4 October" — the day a television was connected. Said in UTC: a day either side is not worth a time zone. */
const dayConnected = (at) => new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });

/**
 * Each television of the home, in the order they were connected. They have
 * no names, so they are numbered; when each was connected, and whether it
 * is on, are what tell an old one from the one in the sitting room.
 */
function televisionRows(televisions, organiser) {
  return [...televisions]
    .sort((a, b) => (a.pairedAt ?? 0) - (b.pairedAt ?? 0) || String(a.deviceId).localeCompare(String(b.deviceId)))
    .map((tv, i) => {
      const state = tv.connected ? 'on now' : 'off, or showing something else';
      return {
        deviceId: tv.deviceId,
        primary: `Television ${i + 1}`,
        secondary: Number.isFinite(tv.pairedAt) ? `Connected ${dayConnected(tv.pairedAt)} · ${state}` : sentenceCase(state),
        removable: organiser,
      };
    });
}

/**
 * The televisions members connected as their own, as the server lists them
 * (oldest first). Each is named by whose it is. Its owner can disconnect
 * it, and so can the organiser.
 */
function familyTelevisionRows(familyTelevisions, organiser) {
  return familyTelevisions.map((tv) => ({
    deviceId: tv.deviceId,
    primary: `${tv.memberName}’s television`,
    secondary: Number.isFinite(tv.pairedAt) ? `Connected ${dayConnected(tv.pairedAt)}` : '',
    removable: organiser || tv.yours === true,
  }));
}

/**
 * Who is offered which television to connect:
 *
 *   'choice'    an organiser the resident has allowed — the resident's, or their own
 *   'resident'  an organiser still waiting — the resident's, which is how anyone comes to be asked
 *   'family'    a family member the resident has allowed — their own, and no other
 *   null        a neighbour, and anyone still waiting, turned down or removed
 *
 * The server decides again when the code is sent (POST /api/televisions).
 *
 * @param me  GET /api/me
 */
export function televisionOffer(me) {
  const { role, status } = me.membership;
  if (role === 'organiser') return status === 'allowed' ? 'choice' : status === 'pending' ? 'resident' : null;
  return role === 'family' && status === 'allowed' ? 'family' : null;
}

/**
 * A pairing code that arrived in a link — the address on a television's
 * pairing screen, opened on a telephone.
 *
 * Such a link can be sent by anybody. If its code went straight into the
 * form, one press on "Connect" would connect whichever television the code
 * belongs to: somebody else's, showing them this person's view of the home,
 * or — for an organiser — standing in for the resident's own. So the code
 * from a link is never used by itself. It is shown, the person is asked
 * whether it is the code on the television in front of them, and only their
 * "Yes" carries it on to the connect card.
 *
 * Anything that is not six digits is not a code: it is dropped, and never
 * drawn.
 */
export function presentPairLink(code, residentName) {
  const digits = typeof code === 'string' ? code.replace(/\s+/g, '') : '';
  if (!/^\d{6}$/.test(digits)) return { offered: false };
  const shown = `${digits.slice(0, 3)} ${digits.slice(3)}`;
  return {
    offered: true,
    code: digits,
    shown,
    title: 'A code from a link',
    question: `Is ${shown} the code showing on the television in front of you?`,
    warning:
      `Only go on if you can see this code on that television yourself. A link from somebody else can carry the code of their television, and connecting it would show them what you see of ${residentName}’s home.`,
    confirm: 'Yes, it is on my television',
    refuse: 'No',
    refused: 'Nothing was connected.',
  };
}

/**
 * The card that connects a television, and whose it is going to be — asked
 * in plain words before the code is sent. `as` is what is chosen to begin
 * with: nothing for an organiser, who has to say; "Mine" when that is what
 * they said; and the only thing on offer for everyone else.
 *
 * @param me      GET /api/me
 * @param {'family' | undefined} wanted  'family' when the person said the television is their own
 */
export function presentConnect(me, wanted) {
  const resident = me.household.residentName;
  const offer = televisionOffer(me);
  if (!offer) {
    const { role, status } = me.membership;
    // A neighbour's is not "not yet": being allowed does not change it. The resident's no is said as the welcome says it.
    if (role === 'neighbour') return { offered: false, say: 'A neighbour cannot connect a television.', tone: 'answer' };
    if (status === 'declined') return { offered: false, say: `${resident} chose not to share this with you.`, tone: 'private' };
    if (status === 'removed') return { offered: false, say: 'You are no longer part of this family circle.', tone: 'private' };
    return { offered: false, say: `You can connect a television of your own once ${resident} has allowed you.`, tone: 'waiting' };
  }
  return {
    offered: true,
    // Said first to an organiser who asked for their own before the resident has allowed them.
    say: offer === 'resident' && wanted === 'family'
      ? `Connect ${resident}’s television first. You can connect one of your own once ${resident} has allowed you.`
      : null,
    title: offer === 'family' ? 'Connect my own television' : 'Connect a television',
    whose: offer === 'choice'
      ? { question: 'Whose television is it?', options: [{ as: 'resident', label: `${resident}’s` }, { as: 'family', label: 'Mine' }] }
      : null,
    as: offer === 'choice' ? (wanted === 'family' ? 'family' : null) : offer,
    lead: {
      resident: 'Open Wick on the television. It shows a six-digit code.',
      family: 'Open Wick on your television. It shows a six-digit code.',
    },
    footnote: {
      resident: `${resident} is then asked, on it, whether to allow you.`,
      family: `Your television will show you ${resident}’s light and anything she asks of you. It is never used to reach her.`,
    },
  };
}

/**
 * What is said once a television is connected (POST /api/televisions). The
 * kind said is the kind the server connected, never the kind that was asked
 * for: an older Wick knows no kinds and connects the resident's television —
 * and that one is not called yours.
 *
 * @param {'resident' | 'family'} asked
 * @param {{kind?: string}} answer  the server's
 * @param {string} resident
 */
export function presentConnected(asked, answer, resident) {
  if (answer?.kind === 'family') {
    return { say: `This television is now yours. It will show you ${resident}’s home.`, tone: 'answer', kind: 'family' };
  }
  if (asked === 'family') {
    return { say: `This Wick cannot connect a television of your own yet. It was connected as ${resident}’s.`, tone: 'waiting', kind: 'resident' };
  }
  // The resident's own: the welcome says what comes next, as it always has.
  return { say: null, tone: 'answer', kind: 'resident' };
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
      televisions: televisionRows(circle.televisions, organiser),
      // A list of its own: a member's television is never one of the resident's, and is not counted above.
      familyTelevisionsTitle: 'Family televisions',
      familyTelevisions: familyTelevisionRows(circle.familyTelevisions ?? [], organiser),
      organiser,
      connect: televisionOffer(me),
      footnote: `${resident} allows each person on the television, one press each.`,
    },
  };
}

/**
 * What is said and shown with an invitation link (POST /api/circle/invitations).
 * A neighbour's is shown as a family one is, with one line saying what a
 * neighbour is for. The kind shown is the kind the server made, never the
 * kind that was asked for: an older Wick knows no neighbours and would make
 * a family invitation — and that link is not handed out as a neighbour's.
 *
 * @param {'neighbour' | undefined} asked  the role asked for; none for family
 * @param {{role?: string}} invitation  the server's answer
 * @param {string} resident
 */
export function presentInvitation(asked, invitation, resident) {
  const neighbour = invitation?.role === 'neighbour';
  if (asked === 'neighbour' && !neighbour) return { offered: false, say: 'This Wick cannot invite a neighbour yet.' };
  return {
    offered: true,
    say: 'Here is a link to send them. It works for seven days.',
    title: neighbour ? 'An invitation for a neighbour' : 'An invitation',
    note: neighbour ? 'A neighbour can be asked to look at who is at the door, and to ring. They see nothing else.' : null,
    footnote: `They sign in, and ${resident} is asked on the television whether to allow them.`,
  };
}

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

// ---------------------------------------------------------------------------
// The television speaks her language. These present GET /api/language (the
// app's own business with the Wick server), not a tool result: which
// language the resident's television speaks, and — for the organiser — the
// way to ask her for another. Asking changes nothing. She answers on her
// own television, and until she says yes it speaks what it spoke.
//
// Her no is an answer too. It stands for a week, and while it does the
// organiser is shown the server's sentence — which day she said no, and from
// which day the language can be asked for again — where the button for that
// language would be. Nobody else is told what she said no to.
//
// And a question the organiser takes back is not asked again for a day:
// asking and taking back is not a way to put it to her over and over. The
// button says so before it is pressed a second time, and afterwards the
// server's sentence stands where that language's button would be.
//
// The languages and their names are the server's (its `choices`); none is
// kept here, so a language this page has not heard of is still offered.
// ---------------------------------------------------------------------------

/** Said against a Wick server from before this: the page is published by itself, and may be the newer of the two. */
export const LANGUAGE_UNAVAILABLE = 'This Wick cannot change the language of the television yet.';

const languageName = (view, language) => (view.choices ?? []).find((choice) => choice.language === language)?.name ?? 'another language';

/**
 * Who the card is for: the organiser — allowed, or still waiting — and the
 * family the resident allows. Never a neighbour, who is asked two things
 * and shown nothing. Everyone else is told what the server would tell them
 * (INV-9), without the server being asked.
 *
 * @param me  GET /api/me
 */
export function languageOffer(me) {
  const resident = me.household.residentName;
  const { role, status } = me.membership;
  // Said first: being allowed does not change it for a neighbour.
  if (role === 'neighbour') return { offered: false, say: 'The language of the television is not shown to a neighbour.', tone: 'answer' };
  if (status === 'allowed' || (role === 'organiser' && status === 'pending')) return { offered: true };
  if (status === 'declined') return { offered: false, say: `${resident} chose not to share this with you.`, tone: 'private' };
  if (status === 'removed') return { offered: false, say: 'You are no longer part of this family circle.', tone: 'private' };
  return {
    offered: false,
    say: `${resident} hasn’t allowed this yet. A card is waiting on the television, and it only takes one press.`,
    tone: 'waiting',
  };
}

/**
 * The card: the language now, each choice by its name in English and in
 * itself ("Spanish — español"), and what can be done from here. Only the
 * organiser can ask, and only one question is open at a time: while it is,
 * the one thing to do is take it back. A language she has said no to within
 * the week, or whose question was taken back within the day, has the
 * server's sentence about it in place of its button.
 *
 * @param view  GET /api/language — `{ language, asked?, choices, declined?, takenBack? }`
 * @param me    GET /api/me
 */
export function presentLanguage(view, me) {
  const resident = me.household.residentName;
  const organiser = me.membership.role === 'organiser';
  const choices = view.choices ?? [];
  const asked = view.asked ?? null;
  const speaks = languageName(view, view.language);
  const who = organiser ? 'I have' : `${asked?.by || 'The organiser'} has`;
  // Her no, while it stands — the organiser's to be told, in the server's own sentence (it knows the days at the house).
  const declined = organiser && view.declined
    ? {
        language: view.declined.language,
        say: view.declined.say || `${resident} said no to ${languageName(view, view.declined.language)}. It can be asked for again in a week.`,
      }
    : null;
  // And a question the organiser took back, while the day runs: theirs to be told, and nobody else's.
  const takenBack = organiser && view.takenBack
    ? { language: view.takenBack.language, say: view.takenBack.say || `You took that question back. You can ask ${resident} again in a day.` }
    : null;
  // Her no first: it is the longer wait, and hers.
  const waits = [declined, takenBack].filter(Boolean).map((wait) => wait.say);
  const waitsFor = (language) => declined?.language === language || takenBack?.language === language;

  return {
    say: asked
      ? `${resident}’s television speaks ${speaks}. ${who} asked her on it for ${languageName(view, asked.language)}, and nothing changes until she says yes.`
      : [`${resident}’s television speaks ${speaks}.`, ...waits].join(' '),
    tone: asked ? 'waiting' : 'answer',
    card: {
      title: `Which language does ${resident}’s television speak?`,
      rows: choices.map((choice) => {
        // "español" beside "Spanish"; English is only said once.
        const own = choice.own && choice.own !== choice.name ? choice.own : null;
        const current = choice.language === view.language;
        return {
          language: choice.language,
          primary: own ? `${choice.name} — ${own}` : choice.name,
          name: choice.name,
          own,
          secondary: current
            ? 'On her television now'
            : asked?.language === choice.language
              ? 'Asked · waiting for her answer'
              : declined?.language === choice.language
                ? 'She said no'
                : takenBack?.language === choice.language
                  ? 'You took the question back'
                  : '',
          current,
        };
      }),
      // The line that changes while the card is open: said again when she answers (languageNews).
      status: asked ? `${who} asked ${resident} on her television. Nothing changes until she says yes.` : '',
      note: organiser ? null : 'Only the person who set this home up can ask for another language.',
      // Said where that language's button would be.
      declined,
      takenBack,
      waits,
      asks: organiser && !asked
        ? choices
            .filter((choice) => choice.language !== view.language && !waitsFor(choice.language))
            .map((choice) => ({ language: choice.language, label: `Ask ${resident} for ${choice.name}` }))
        : [],
      // Two presses: the second says what taking it back costs, before it is done.
      takeBack: organiser && asked
        ? { label: 'Take the question back', confirm: 'Take it back — sure? It cannot be asked again for a day.' }
        : null,
      // A question is open: the card keeps looking for her answer.
      waiting: asked !== null,
      // What changes, and what does not, in one sentence.
      footnote: `Only what ${resident}’s television shows her changes; what the family reads stays as it is.`,
    },
  };
}

/**
 * What the card says when it looks again and something has changed since it
 * was drawn. Null while nothing has.
 *
 * Only what is known is said. Her television speaking another language is
 * her yes — nothing else can change it. A question that is gone, with her
 * no to that language kept since it was asked, is her no: a taking back
 * never leaves one. A question that is gone with nothing kept was taken
 * back from somewhere else — or is being read by somebody who is not told
 * what she said no to — so it is said only that the television is staying
 * as it is. Anything else is drawn again with nothing claimed.
 *
 * @param before  GET /api/language, as the card was drawn
 * @param after   GET /api/language, now
 * @param {string} resident
 */
export function languageNews(before, after, resident) {
  const question = (view) => (view.asked ? `${view.asked.language}@${view.asked.at}` : '');
  if (after.language === before.language && question(after) === question(before)) return null;
  const speaks = languageName(after, after.language);
  if (after.language !== before.language) return { say: `${resident} said yes. Her television now speaks ${speaks}.` };
  if (!after.asked) {
    const saidNo = before.asked && after.declined?.language === before.asked.language && after.declined.at >= before.asked.at;
    return { say: saidNo ? `${resident} said no. Her television is staying in ${speaks}.` : `${resident}’s television is staying in ${speaks}.` };
  }
  return { say: '' };
}

// ---------------------------------------------------------------------------
// The mantelpiece: a picture for her television. The app's own business
// with the Wick server (POST and GET /api/photos), not a tool — a picture
// is a file, and a model cannot hand one over.
//
// What leaves this page is never the file that was chosen. It is drawn
// again here, no larger than a television shows, and saved as a new JPEG:
// that is what makes it small enough to send, and it is also what leaves
// behind everything the camera wrote into the file — where it was taken,
// and when.
//
// And what comes back is one thing: that she has seen it. Whether she kept
// it is hers; this page is not told, and has nothing to show of it.
// ---------------------------------------------------------------------------

/**
 * The largest picture the server takes, and the longest side a television
 * has any use for. The server's own numbers (packages/contracts mantel.ts),
 * copied because this page has no build step, and held equal by a test.
 */
export const MAX_PHOTO_BYTES = 1_500_000;
export const PHOTO_MAX_EDGE_PX = 1920;

/** The qualities a picture is tried at, best first, before it is made smaller instead. */
const PHOTO_QUALITIES = [0.86, 0.78, 0.7, 0.6, 0.5];
/** How much smaller each further try is, and the longest side below which it is no longer worth sending. */
const PHOTO_SHRINK = 0.8;
const PHOTO_MIN_EDGE_PX = 640;

/**
 * Who the card is for: the family she has allowed, the organiser among
 * them. Never a neighbour, who sends nothing; and nobody she has not
 * allowed — an organiser still waiting included. They are told what the
 * server would tell them (INV-9), without it being asked.
 *
 * @param me  GET /api/me
 */
export function photoOffer(me) {
  const resident = me.household.residentName;
  const { role, status } = me.membership;
  if (role === 'neighbour') return { offered: false, say: 'A neighbour cannot send a picture.', tone: 'answer' };
  if (status === 'allowed') return { offered: true };
  if (status === 'declined') return { offered: false, say: `${resident} chose not to share this with you.`, tone: 'private' };
  if (status === 'removed') return { offered: false, say: 'You are no longer part of this family circle.', tone: 'private' };
  return {
    offered: false,
    say: `${resident} hasn’t allowed this yet. A card is waiting on the television, and it only takes one press.`,
    tone: 'waiting',
  };
}

/**
 * Every word the card says for itself. What the server says — that it is on
 * its way, or why it was not sent — is said as the server said it.
 *
 * @param me  GET /api/me
 */
export function presentPhotoComposer(me) {
  const resident = me.household.residentName;
  return {
    say: `Choose a picture for ${resident}’s television.`,
    title: `Send a picture to ${resident}’s television`,
    choose: 'Choose a picture',
    preview: 'The picture as it will be sent',
    privacy: 'Wick sends only the picture itself — not where or when it was taken.',
    footnote: 'It arrives at a quiet moment. She can keep it or simply thank you. You are told only that she has seen it.',
    confirm: 'Send it to her television',
    cancel: 'Not now',
    preparing: 'Getting the picture ready…',
    ready: 'This is the picture as it will be sent.',
    sending: `Sending it to ${resident}’s television…`,
    unreadable: 'This browser cannot open that file as a picture. Choose another.',
    tooLarge: 'That picture could not be made small enough to send. Choose another.',
    unreachable: 'The picture could not be sent just now. Check the connection, and press send again: it will only be sent once.',
    // Said against a Wick server from before this: the page is published by itself, and may be the newer of the two.
    unavailable: 'This Wick cannot send pictures yet.',
    sentTitle: 'Pictures you have sent',
  };
}

/**
 * The size a picture is drawn at: its longest side no more than a
 * television shows, its shape kept, and never larger than it was. Null for
 * a size that is not one.
 */
export function photoFit(width, height, maxEdge = PHOTO_MAX_EDGE_PX) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Draws a picture again until it is small enough to send: at each size, the
 * qualities from best to least; then a smaller size, and the qualities
 * again. Null when nothing fits before the picture would be too small to be
 * worth a television — or when what comes back is not a JPEG at all.
 *
 * `encode(width, height, quality)` is the canvas (main.js): it draws the
 * picture at that size and hands back the JPEG, or nothing.
 *
 * @param {(width: number, height: number, quality: number) => Promise<{size: number, type: string} | null>} encode
 * @param {{width: number, height: number}} picture  the picture's own size
 * @param {{maxBytes?: number, maxEdge?: number}} [limits]
 */
export async function encodeWithin(encode, picture, { maxBytes = MAX_PHOTO_BYTES, maxEdge = PHOTO_MAX_EDGE_PX } = {}) {
  let size = photoFit(picture.width, picture.height, maxEdge);
  while (size) {
    for (const quality of PHOTO_QUALITIES) {
      const blob = await encode(size.width, size.height, quality);
      // A browser that cannot make a JPEG hands back something else, or nothing: that is not sent.
      if (!blob || blob.type !== 'image/jpeg') return null;
      if (blob.size <= maxBytes) return { blob, width: size.width, height: size.height, quality };
    }
    const edge = Math.floor(Math.max(size.width, size.height) * PHOTO_SHRINK);
    if (edge < PHOTO_MIN_EDGE_PX) return null;
    size = photoFit(size.width, size.height, edge);
  }
  return null;
}

/**
 * The id the app makes for one picture (the `Idempotency-Key` header), so
 * that pressing send twice, or sending again after a lost connection, sends
 * it once. Sixteen random bytes, written as the server expects an id.
 *
 * @param {Uint8Array} random  from crypto.getRandomValues
 */
export function newPhotoKey(random) {
  return Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Refusals after which sending the same picture again would be answered the same way: another picture, or another day. */
const PHOTO_REFUSALS_THAT_STAND = new Set([
  'not_sendable', 'too_many_today', 'too_many_tries', 'too_large', 'not_a_jpeg', 'not_allowed_yet', 'not_for_a_neighbour', 'no_television', 'photos_unavailable',
]);

/**
 * Where the conversation should be scrolled to so that a stretch of it is
 * in sight, moving it as little as that takes: not at all when it is in
 * sight already; its end up to the foot when it runs below; its start down
 * to the head when it is above — or when it is taller than the view, since
 * what is read first comes first. A picture just sent is shown this way:
 * the sentence that says so, and the list that says how it stands.
 *
 * @param {{scrollTop: number, viewHeight: number}} view  where the conversation is now, and how much of it shows
 * @param {{top: number, bottom: number}} stretch         within the conversation's own length
 * @param {number} air                                    left clear above or below it
 */
export function scrollTopToShow(view, stretch, air = 12) {
  const { scrollTop, viewHeight } = view;
  const { top, bottom } = stretch;
  if (![scrollTop, viewHeight, top, bottom].every(Number.isFinite) || viewHeight <= 0) return scrollTop;
  if (top >= scrollTop && bottom <= scrollTop + viewHeight) return scrollTop;
  const tooTall = bottom - top > viewHeight;
  if (top < scrollTop || tooTall) return Math.max(0, top - air);
  // Its end at the foot, with air under it where there is room for air — never so far that its start is lost.
  return Math.max(0, Math.min(top, bottom + air - viewHeight));
}

/**
 * What pressing send again can do, after the server's answer `code` (none
 * when there was no answer at all). Where a first try may have got
 * somewhere, the same key is kept: it is what makes a second try safe.
 * Where the server would not have this key, a new one is made.
 */
export function photoRetry(code) {
  if (PHOTO_REFUSALS_THAT_STAND.has(code)) return { again: false, newKey: false };
  return { again: true, newKey: code === 'key_in_use' || code === 'bad_key' };
}

const isSentPicture = (photo) =>
  photo !== null && typeof photo === 'object' && typeof photo.photoId === 'string' && Number.isFinite(photo.sentAt) && typeof photo.seen === 'boolean' && typeof photo.say === 'string';

/**
 * The pictures the person sent, as the server lists them (GET /api/photos):
 * when each was sent, and the server's own sentence for how it stands.
 * Nothing else is shown, whatever else an answer carried.
 *
 * @param {{photos?: unknown[]} | null} answer
 * @param {(atMs: number) => string} formatTime
 */
export function presentSentPictures(answer, formatTime = defaultFormatTime) {
  const photos = (Array.isArray(answer?.photos) ? answer.photos : []).filter(isSentPicture);
  return {
    rows: photos.map((photo) => ({ photoId: photo.photoId, primary: `Sent ${formatTime(photo.sentAt)}`, secondary: photo.say, seen: photo.seen })),
    // One is still waiting on her television: the card keeps looking.
    waiting: photos.some((photo) => !photo.seen),
  };
}

/**
 * What the card says when it looks again and the list has changed. Null
 * while it has not. A picture that was waiting and has been seen is said in
 * the server's own sentence — the one thing there is to say. Any other
 * change is drawn, and nothing is said.
 *
 * @param before  GET /api/photos, as the list was drawn
 * @param after   GET /api/photos, now
 */
export function photoNews(before, after) {
  const was = (Array.isArray(before?.photos) ? before.photos : []).filter(isSentPicture);
  const now = (Array.isArray(after?.photos) ? after.photos : []).filter(isSentPicture);
  const key = (photos) => photos.map((photo) => `${photo.photoId}:${photo.seen}`).join(',');
  if (key(was) === key(now)) return null;
  const waiting = new Set(was.filter((photo) => !photo.seen).map((photo) => photo.photoId));
  const seen = now.find((photo) => photo.seen && waiting.has(photo.photoId));
  return { say: seen ? seen.say : '' };
}

/** get_pictures, when an assistant asks on the person's behalf: the server's summary, and each picture by when it was sent. */
function presentPictures(answer, formatTime) {
  return {
    say: answer.summary,
    tone: 'answer',
    card: {
      kind: 'list',
      title: 'Pictures you have sent',
      meta: '',
      items: answer.pictures
        .filter((picture) => picture && Number.isFinite(picture.sentAt) && typeof picture.say === 'string')
        .map((picture) => ({ primary: `Sent ${formatTime(picture.sentAt)}`, secondary: picture.say })),
    },
  };
}

// ---------------------------------------------------------------------------
// Waiting for the Wick server. A request that never answers must not leave
// the app waiting for ever — the field off, a button disabled, "thinking"
// on the screen: each is given up after a time that suits what was asked,
// and fails in words a person can act on.
// ---------------------------------------------------------------------------

/**
 * How long each kind of request is waited for:
 *
 *   - `api`: the app's own business with the server (who am I, the circle,
 *     connecting a television, signing in). A table read or two: fifteen
 *     seconds is already a long time to look at nothing.
 *   - `tool`: one MCP tool call. Most are as quick, but some have a
 *     television or a doorbell to reach before they can answer.
 *   - `assistant`: one step of the conversation. The server gives the model
 *     twenty seconds for it (services/mcp-server/src/assistant/bedrock.ts
 *     STEP_TIMEOUT_MS) and then answers that there is nobody to ask; the page
 *     outwaits that, so it never gives up on an answer that is about to come.
 *   - `upload`: a picture on its way to her television (POST /api/photos).
 *     It carries up to MAX_PHOTO_BYTES, and on a slow connection that alone
 *     takes longer than the fifteen seconds a table read is given: a minute.
 *     Looking at the pictures already sent (GET) is the app's ordinary
 *     business, and waits as long as that does.
 *   - `hear`: a spoken question on its way to be heard (POST /api/hear).
 *     Up to ten seconds of audio, and the server gives Amazon Transcribe
 *     fifteen seconds for it (services/mcp-server/src/hear/transcribe.ts
 *     HEAR_TIMEOUT_MS); the page outwaits that, as it does the assistant.
 */
export const REQUEST_LIMITS_MS = { api: 15_000, tool: 20_000, assistant: 30_000, upload: 60_000, hear: 30_000 };

/** Said when a request was given up. The app's own sentence: the server said nothing. */
export const NO_ANSWER_TEXT = 'Wick did not answer in time. Try again in a moment.';

/**
 * The limit for a request, from where on the server it is going — and, for
 * a picture, from whether it is being sent or only looked for.
 *
 * @param {string} path
 * @param {string} [method]  as `fetch` takes it; GET when none is given
 */
export function requestLimitFor(path, method = 'GET') {
  if (path.startsWith('/assistant/')) return REQUEST_LIMITS_MS.assistant;
  if (path === '/mcp') return REQUEST_LIMITS_MS.tool;
  if (path === '/api/photos' && String(method).toUpperCase() === 'POST') return REQUEST_LIMITS_MS.upload;
  if (path === '/api/hear' && String(method).toUpperCase() === 'POST') return REQUEST_LIMITS_MS.hear;
  return REQUEST_LIMITS_MS.api;
}

/** Statuses whose answer has no body, and may be given none. */
const NO_BODY = [101, 204, 205, 304];

/**
 * `fetch`, given up after `ms`. The limit covers the whole answer — an
 * answer that begins and never finishes is no answer — so what comes back
 * has its words already read: the same status and headers, to be used as
 * any response is. A request given up fails with NO_ANSWER_TEXT (and
 * `timedOut`); any other failure is left exactly as it was.
 *
 * @param {number} ms
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {{fetch?: typeof fetch, setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout}} [deps]  the page's own, unless a test stands in for them
 * @returns {Promise<Response>}
 */
export async function fetchWithin(ms, url, init = {}, deps = {}) {
  const ask = deps.fetch ?? ((input, options) => fetch(input, options));
  const givenUp = new AbortController();
  const limit = (deps.setTimeout ?? setTimeout)(() => givenUp.abort(), ms);
  try {
    const res = await ask(url, { ...init, signal: givenUp.signal });
    const words = NO_BODY.includes(res.status) ? null : await res.text();
    return new Response(words, { status: res.status, statusText: res.statusText, headers: res.headers });
  } catch (err) {
    if (givenUp.signal.aborted) throw Object.assign(new Error(NO_ANSWER_TEXT), { timedOut: true });
    throw err;
  } finally {
    (deps.clearTimeout ?? clearTimeout)(limit);
  }
}

export function inviteLink(here, code) {
  const url = new URL(here);
  url.search = '';
  url.hash = '';
  url.searchParams.set('invite', code);
  return url.toString();
}
