/**
 * Her day, the edge's half (packages/contracts/src/today.ts).
 *
 * What her home screen opens on: the date where the house is, her name for
 * the greeting, and up to three lines about who is coming today and
 * tomorrow — worked out from the roster the door already matches against
 * (`PER#` rows, contracts door.ts RosterEntry) and nothing else:
 *
 *   a regular visitor     "Maria usually comes tomorrow at 9 am."
 *   a member's own visit  "Sarah is coming to see you today at 3 pm."
 *   an arranged visit     "The window cleaner is expected today at 10:18 am. Sarah arranged it."
 *
 * Each says only what the roster says: a regular visitor "usually" comes,
 * an arranged visit "is expected". Nothing here says anyone came — that is
 * the door's to see and hers to confirm (contracts visit.ts).
 *
 * An entry stands only while the member whose word it rests on is still
 * allowed by her — the door's own rule (services/agent door/roster.ts
 * stillWelcome; INV-9). Her own televisions are the only ones told
 * (light.ts HomeState), so nothing here passes the Guardian: it is about
 * her, on her screen.
 *
 * Every sentence is in English here; the phrasebook says it in her language
 * on the way out (language.mjs inHerLanguage, contracts phrasebook homeIn).
 * A visit whose "who" is the member's own words ("the window cleaner") has
 * no sentence in the phrasebook, and stays English, whole.
 *
 * This plain .mjs Lambda can't import TS; the names below are inlined from
 * packages/contracts (today.ts, door.ts, circle.ts, errand.ts), and
 * today.test.ts holds them to it.
 *
 * Pure: device-event.mjs owns the DynamoDB client.
 */
import { endOfLocalDay } from './light.mjs';

/** contracts today.ts MAX_COMING. */
export const MAX_COMING = 3;
/** The roster's rows (contracts door.ts; mcp-server add_regular_visitor.ts, expect_visit.ts; agent store/errands.ts). */
export const PERSON_SK_PREFIX = 'PER#';
/** contracts circle.ts memberPersonId: a member's own announced visit. */
const MEMBER_PERSON_PREFIX = 'member-';
/** contracts errand.ts errandPersonId: a visit a member arranged. */
const ERRAND_PERSON_PREFIX = 'errand:';
const MEMBER_SK_PREFIX = 'MEM#';
const META_SK = 'META';

/** contracts clock.ts DAY_CODES, Sunday first as Intl says them. */
const DAY_CODES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

const MINUTE_MS = 60_000;

/** Query input for the roster: every `PER#` row of the household, in one read. */
export function rosterRange({ table, householdId }) {
  return {
    TableName: table,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':pk': { S: `HH#${householdId}` }, ':prefix': { S: PERSON_SK_PREFIX } },
  };
}

/** The date, weekday and clock where the house is. */
function localParts(at, timeZone) {
  const found = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type) => found.find((p) => p.type === type)?.value ?? '';
  return {
    dayCode: part('weekday').toUpperCase(),
    day: Number(part('day')),
    month: Number(part('month')) - 1,
    hour: Number(part('hour')) % 24,
    minute: Number(part('minute')),
  };
}

/**
 * The first moment of the day `at` falls on, where the house is: the end of
 * the day before. A moment in that day is the local clock's minutes back,
 * and an hour more — whichever way the clocks moved that night.
 */
export function startOfLocalDay(at, timeZone) {
  const { hour, minute } = localParts(at, timeZone);
  return endOfLocalDay(at - (hour * 60 + minute + 61) * MINUTE_MS, timeZone);
}

/**
 * The moment a local clock time falls on, on the day that starts at
 * `dayStart`: added, then put right by however far the clocks moved that
 * day. Undefined for a time the day does not have (a spring-forward hour).
 */
export function localMoment(dayStart, hour, minute, timeZone) {
  const wanted = hour * 60 + minute;
  let at = dayStart + wanted * MINUTE_MS;
  const seen = localParts(at, timeZone);
  at += (wanted - (seen.hour * 60 + seen.minute)) * MINUTE_MS;
  const check = localParts(at, timeZone);
  return check.hour * 60 + check.minute === wanted ? at : undefined;
}

/** "9 am", "10:18 am", "12 pm" — as the phrasebook reads a time (contracts phrasebook engine.ts). */
export function clockWords(at, timeZone) {
  const { hour, minute } = localParts(at, timeZone);
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  const half = hour < 12 ? 'am' : 'pm';
  return minute === 0 ? `${twelve} ${half}` : `${twelve}:${String(minute).padStart(2, '0')} ${half}`;
}

const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] ?? '';

/** "the window cleaner" -> "The window cleaner": the first word of a sentence. */
const opening = (words) => (words.length === 0 ? words : words[0].toLocaleUpperCase('en-GB') + words.slice(1));

/** "TUE,FRI 09:00±30m" (contracts door.ts; agent door/roster.ts parsePattern). */
function parsePattern(pattern) {
  const [dayPart, timePart] = String(pattern ?? '').trim().split(/\s+/);
  const m = /^(\d{2}):(\d{2})±(\d+)m$/.exec(timePart ?? '');
  if (!dayPart || !m) return undefined;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return undefined;
  return { days: dayPart.split(','), hour, minute, windowMin: Number(m[3]) };
}

/** The roster's entries, read from their rows; a row that is not one is left out. */
function readRoster(rows) {
  return (rows ?? [])
    .filter((row) => row?.sk?.S?.startsWith(PERSON_SK_PREFIX) && typeof row.data?.S === 'string')
    .flatMap((row) => {
      try {
        const entry = JSON.parse(row.data.S);
        return entry && typeof entry.personId === 'string' && typeof entry.name === 'string' ? [entry] : [];
      } catch {
        return [];
      }
    });
}

/**
 * Only what still stands on the word of someone she allows — the door's
 * own rule (agent door/roster.ts stillWelcome). An entry nobody vouched for
 * (the household's operator) stands.
 */
function stillWelcome(roster, homeRows) {
  const allowed = new Set(
    (homeRows ?? [])
      .filter((row) => row?.sk?.S?.startsWith(MEMBER_SK_PREFIX) && row.status?.S === 'allowed')
      .map((row) => row.sk.S.slice(MEMBER_SK_PREFIX.length)),
  );
  return roster.filter((person) => {
    const userId = person.personId.startsWith(MEMBER_PERSON_PREFIX) ? person.personId.slice(MEMBER_PERSON_PREFIX.length) : person.addedBy;
    return userId === undefined || allowed.has(userId);
  });
}

/** The sentence for one visit, on the day it is said of. */
function lineFor(person, when, time) {
  if (person.personId.startsWith(ERRAND_PERSON_PREFIX)) {
    const arranged = firstName(person.arrangedByName);
    const expected = `${opening(String(person.name).trim())} is expected ${when} at ${time}.`;
    return arranged ? `${expected} ${arranged} arranged it.` : expected;
  }
  const name = firstName(person.name);
  if (!name) return undefined;
  if (person.personId.startsWith(MEMBER_PERSON_PREFIX)) return `${name} is coming to see you ${when} at ${time}.`;
  return `${name} usually comes ${when} at ${time}.`;
}

/**
 * What her home screen is told of her day (contracts today.ts HerDay).
 *
 * @param {object} input
 * @param {object[]} input.homeRows  the rows the home screen is read from (light.mjs homeRange): her name and her circle
 * @param {object[]} input.rosterRows  the household's `PER#` rows (rosterRange)
 * @param {number} input.now
 * @param {string} input.timeZone  where the house is (household-zone.mjs)
 */
export function herDay({ homeRows, rosterRows, now, timeZone }) {
  const dayStart = startOfLocalDay(now, timeZone);
  const dayEnd = endOfLocalDay(now, timeZone);
  const tomorrowEnd = endOfLocalDay(dayEnd, timeZone);
  const today = localParts(now, timeZone);
  const tomorrow = localParts(dayEnd, timeZone);

  const meta = (homeRows ?? []).find((row) => row?.sk?.S === META_SK);
  const name = firstName(meta?.residentName?.S);

  const found = [];
  for (const person of stillWelcome(readRoster(rosterRows), homeRows)) {
    // One visit somebody said would happen, at its moment.
    if (person.expectedOnce && Number.isFinite(person.expectedOnce.at)) {
      const at = person.expectedOnce.at;
      const over = at + (Number(person.expectedOnce.windowMin) || 0) * MINUTE_MS;
      if (over <= now || at >= tomorrowEnd) continue;
      const isToday = at < dayEnd;
      const line = lineFor(person, isToday ? 'today' : 'tomorrow', clockWords(at, timeZone));
      // "Tomorrow" stops being true at midnight, whatever time the visit is.
      if (line) found.push({ personId: person.personId, at, line, until: isToday ? over : dayEnd });
      continue;
    }
    // A regular visitor: today, if their time is still to come or under way, otherwise tomorrow.
    const pattern = parsePattern(person.expectedPattern);
    if (!pattern) continue;
    const candidates = [
      { code: today.dayCode, start: dayStart, when: 'today' },
      { code: tomorrow.dayCode, start: dayEnd, when: 'tomorrow' },
    ];
    for (const day of candidates) {
      if (!pattern.days.includes(day.code)) continue;
      const at = localMoment(day.start, pattern.hour, pattern.minute, timeZone);
      if (at === undefined) continue;
      const over = at + pattern.windowMin * MINUTE_MS;
      if (over <= now) continue;
      const line = lineFor(person, day.when, clockWords(at, timeZone));
      if (line) found.push({ personId: person.personId, at, line, until: day.when === 'today' ? over : dayEnd });
      break;
    }
  }

  const coming = found
    .sort((a, b) => a.at - b.at)
    .map(({ line, until }) => ({ line, until }))
    .slice(0, MAX_COMING);

  return {
    // 0 is Monday, as the phrasebook and the television count a week.
    weekday: (DAY_CODES.indexOf(today.dayCode) + 6) % 7,
    day: today.day,
    month: today.month,
    ...(name ? { name } : {}),
    dayStart,
    dayEnd,
    // This server's clock, so a television whose clock is wrong can put the day onto its own (contracts onThisClock).
    told: now,
    coming,
  };
}
