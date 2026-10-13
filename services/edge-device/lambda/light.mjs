/**
 * The light in the window, the television's half
 * (packages/contracts/src/light.ts).
 *
 * The family sees one thing about today — a light, lit once her day has
 * begun. This is where the resident sees her own: whether it is on, who can
 * see it, who looked in, and the one button that puts it out for the day or
 * lights it again. Putting it out is the only thing her television can
 * change, and it can only make the household quieter.
 *
 * What her home screen is told, and the Light card's words, are both worked
 * out here from one range of the household's rows. No model, no clock but
 * the server's.
 *
 * This plain .mjs Lambda can't import TS; the names below are inlined from
 * packages/contracts/src/light.ts, and light.test.ts holds them to it.
 *
 * Pure: device-event.mjs owns the DynamoDB client.
 */
import { DEFAULT_LANGUAGE, languageOfMeta } from './language.mjs';
import { mantelOf } from './mantel.mjs';
import { readExclusions, visibleClasses } from './sharing.mjs';

export const LIGHT_SK = 'LIGHT';
export const LOOKIN_SK_PREFIX = 'LOOKIN#';
export const LIGHT_CARD_ID = 'light';
export const LIGHT_ACTIONS = { putOut: 'put_out', lightAgain: 'light_again', ok: 'ok' };

const MEMBER_SK_PREFIX = 'MEM#';
const META_SK = 'META';
/** The light is a fact about the shape of her day: kept private with the rest of it ("What Sarah sees"). */
const LIGHT_FACT_CLASS = 'RHYTHM';

const dayIn = (at, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

/** Whether two moments fall on the same calendar day where the house is. */
export function sameLocalDay(a, b, timeZone) {
  return dayIn(a, timeZone) === dayIn(b, timeZone);
}

/**
 * Query input for everything the home screen needs: the light, the looks,
 * the members and the household's own row sit next to each other under the
 * household's key (`LIGHT` … `META`), so it is one read.
 */
export function homeRange({ table, householdId }) {
  return {
    TableName: table,
    KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
    ExpressionAttributeValues: { ':pk': { S: `HH#${householdId}` }, ':from': { S: LIGHT_SK }, ':to': { S: META_SK } },
  };
}

/** The first moment of the next day where the house is (contracts endOfLocalDay): found by looking, since a day is not always twenty-four hours. */
export function endOfLocalDay(at, timeZone) {
  const today = dayIn(at, timeZone);
  let still = at;
  let past = at + 26 * 3_600_000;
  while (past - still > 1) {
    const middle = still + Math.floor((past - still) / 2);
    if (dayIn(middle, timeZone) === today) still = middle;
    else past = middle;
  }
  return past;
}

const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] || 'Someone';

function partOfDay(at, timeZone) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(at));
  return hour < 12 ? 'this morning' : hour < 18 ? 'this afternoon' : 'this evening';
}

/** "Sarah looked in this morning." — the one sentence, on her home screen and on the Light card (contracts lookedInWords). */
export function lookedInWords(name, at, timeZone) {
  return `${name} looked in ${partOfDay(at, timeZone)}.`;
}

/** What those rows say, sorted out. */
function read(items, now, timeZone) {
  const bySk = (prefix) => items.filter((item) => item.sk?.S?.startsWith(prefix));
  const meta = items.find((item) => item.sk?.S === META_SK);
  const light = items.find((item) => item.sk?.S === LIGHT_SK);

  // The people who can see anything: those she allows, but for a neighbour, who is
  // asked things and shown nothing (packages/contracts circle.ts).
  const allowed = bySk(MEMBER_SK_PREFIX).filter((item) => item.status?.S === 'allowed' && item.role?.S !== 'neighbour');
  const allowedIds = new Set(allowed.map((item) => item.sk.S.slice(MEMBER_SK_PREFIX.length)));
  const shared = visibleClasses(meta?.policy?.S).includes(LIGHT_FACT_CLASS) && !readExclusions(meta).includes(LIGHT_FACT_CLASS);

  const outAt = Number(light?.outAt?.N);
  const lookedIn = bySk(LOOKIN_SK_PREFIX)
    // Only somebody she still allows, and only today.
    .filter((item) => allowedIds.has(item.sk.S.slice(LOOKIN_SK_PREFIX.length)))
    .map((item) => ({ name: firstName(item.name?.S), at: Number(item.lookedAt?.N) }))
    .filter((look) => Number.isFinite(look.at) && sameLocalDay(look.at, now, timeZone))
    .sort((a, b) => b.at - a.at)
    // The sentence, and until when it holds: the television's own clock need not know what day it is here.
    .map((look) => ({ ...look, line: lookedInWords(look.name, look.at, timeZone), until: endOfLocalDay(look.at, timeZone) }))[0];

  return {
    watchers: allowed.map((item) => firstName(item.name?.S)),
    // Somebody can see a light at all: she has allowed someone, and shares the shape of her day.
    seen: allowed.length > 0 && shared,
    out: Number.isFinite(outAt) && sameLocalDay(outAt, now, timeZone),
    lookedIn,
    // The language her television speaks (language.mjs): the household's own row is among these.
    language: languageOfMeta(meta),
    // How many things are on her mantelpiece (mantel.mjs): their rows are among these too.
    mantel: mantelOf(items).length,
  };
}

/**
 * What her home screen is told beside its cards (contracts HomeState). She
 * is at the television, so her day has begun: the light is on unless she
 * put it out today. No `light` at all when nobody could see one.
 *
 * And the language her television speaks, when it is not English: this is
 * the one thing every television of the home is told whole, at every
 * connection and after every press that changes it — so it is how each of
 * them learns the language, and hears that she has changed it. Everything
 * here is still said in English; it is put into her language on its way
 * out (language.mjs inHerLanguage; services/agent egress.ts for the home's
 * other televisions).
 */
export function homeState({ items, now, timeZone }) {
  const { seen, out, lookedIn, language, mantel } = read(items, now, timeZone);
  return {
    // Out, and until when: it lights again by itself, and a television left on overnight has to know.
    ...(seen ? (out ? { light: 'out', lightOutUntil: endOfLocalDay(now, timeZone) } : { light: 'on' }) : {}),
    ...(lookedIn ? { lookedIn } : {}),
    ...(language !== DEFAULT_LANGUAGE ? { language } : {}),
    // A count and nothing else — so the home screen knows to offer her mantelpiece. What is on it is
    // asked for by the television, and never told on the way (mantel.mjs).
    ...(mantel > 0 ? { mantel } : {}),
  };
}

/**
 * The home screen has changed by a press on one television — the light put
 * out or lit again, or what is shared changed. The home's other televisions
 * have to hear of it, and the edge may only answer the one that spoke
 * (INV-2): so the agent plane is told, and sends it on (services/agent
 * egress.ts sendHomeToDevices). Resident-bound, like the state itself.
 */
export function buildHomeChangedEntry({ busName, householdId, deviceId, home, at }) {
  return {
    EventBusName: busName,
    Source: 'wick.device',
    DetailType: 'home.changed',
    Detail: JSON.stringify({ householdId, deviceId, home, at }),
  };
}


/**
 * The Light card, as a QueuedCard — or undefined when there is no light to
 * show. Not stored: it is an answer to her press on the home screen, and
 * exists for as long as she is looking at it.
 */
export function buildLightCard({ householdId, items, now, timeZone }) {
  const { watchers, seen, out, lookedIn } = read(items, now, timeZone);
  if (!seen) return undefined;

  const who = watchers.length === 1 ? watchers[0] : 'Your family';
  const looked = lookedIn ? ` ${lookedIn.line}` : '';
  const words = out
    ? {
        headline: 'Your light is out for today.',
        detail: `${who} cannot tell whether you put it out or it has not been lit yet. It lights again tomorrow.${looked}`,
        actions: [
          { id: LIGHT_ACTIONS.ok, label: 'Leave it out', kind: 'primary' },
          { id: LIGHT_ACTIONS.lightAgain, label: 'Light it again', kind: 'secondary' },
        ],
      }
    : {
        headline: 'Your light is on.',
        detail: `${who} can see that your day has begun, and nothing more: not when, and not what you watch.${looked}`,
        // Leaving it is first: a press made without reading changes nothing.
        actions: [
          { id: LIGHT_ACTIONS.ok, label: 'Leave it on', kind: 'primary' },
          { id: LIGHT_ACTIONS.putOut, label: 'Put it out for today', kind: 'secondary' },
        ],
      };

  return {
    id: LIGHT_CARD_ID,
    urgency: 'DEFERRED',
    queuedAt: now,
    shownCount: 0,
    card: { type: 'LIGHT', id: LIGHT_CARD_ID, householdId, correlationId: LIGHT_CARD_ID, createdAt: now, ...words },
  };
}

/** Which of the Light card's presses changes the light — or undefined for "leave it", and for any other card. */
export function lightPress(cardId, action) {
  if (cardId !== LIGHT_CARD_ID) return undefined;
  return action === LIGHT_ACTIONS.putOut || action === LIGHT_ACTIONS.lightAgain ? action : undefined;
}

/** UpdateItem input for that press. Out is a time, so it lapses by itself at the end of the day. */
export function lightUpdate({ table, householdId, press, at }) {
  const Key = { pk: { S: `HH#${householdId}` }, sk: { S: LIGHT_SK } };
  if (press === LIGHT_ACTIONS.putOut) {
    return { TableName: table, Key, UpdateExpression: 'SET outAt = :at', ExpressionAttributeValues: { ':at': { N: String(at) } } };
  }
  return { TableName: table, Key, UpdateExpression: 'REMOVE outAt' };
}
