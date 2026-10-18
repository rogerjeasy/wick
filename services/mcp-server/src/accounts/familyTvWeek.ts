/**
 * Sarah's television, the week (packages/contracts familyTelevision.ts,
 * card kind `week`): her week, once she has read it herself, offered to be
 * read a screenful at a time.
 *
 * Which week, and whether there is one for the family at all, is
 * get_week_narrative's own answer when no week is named
 * (`loadLatestFamilyWeek`): INV-7 and what she keeps private are decided
 * there and nowhere else. A week still waiting on her television, one not
 * written, and one she keeps to herself are all the same thing here — no
 * card, and nothing that hints at one. A television is not a place for
 * refusals.
 *
 * That a week has been read is kept on the television's own row
 * (`FTV#<deviceId>`.weekRead): it is something about this screen, not about
 * her, and another of the member's televisions still offers the week.
 */
import { UpdateItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { FAMILY_TV_OWN_ACTIONS, FAMILY_TV_SK_PREFIX, MAX_CARD_DETAIL_CHARS, familyTvCardId, type FamilyTvCard, type TimelineEntry, type WeekNarrative } from '@wick/contracts';
import { isoWeekRange } from '@wick/agent';
import type { HouseholdPolicy } from '@wick/policy';
import { familyCopyOfLatest, type LatestWeekResult } from '../tools/get_week_narrative.js';
import { isSharedWithFamily } from '../tools/get_resident_shared_view.js';
import type { TvCaller } from './familyTvTypes.js';
import { zoneOf } from './types.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';
/** Where the house is: which day a moment fell on, and what the clock said. The same default as the Narrator's. */

/**
 * The most a page carries: a card's worth (contracts card.ts
 * MAX_CARD_DETAIL_CHARS — what vega-calm-ui shows without cutting). It is
 * also the longest week the Narrator writes (MAX_NARRATIVE_CHARS), so a
 * week as written today is one page; a longer one is turned, never cut.
 */
export const WEEK_PAGE_CHARS = MAX_CARD_DETAIL_CHARS;

/** The most lines a page carries: a card's body (vega-calm-ui `maxDetailLines`) — the day, and four things that happened on it. */
const WEEK_PAGE_LINES = 5;
/** The most pages a television takes for one card (apps/tv-vega family/familyClient.ts MAX_PAGES): a card with more is not shown at all. */
export const WEEK_MAX_PAGES = 12;

/** An ISO week as a card id carries it, and nothing else. */
export const WEEK_ID = /^\d{4}-W\d{2}$/;

/** A full stop that ends a title, not a sentence. */
const TITLE = /(?:^| )(?:Mr|Mrs|Ms|Dr|St|Prof)\.$/;

/** The sentences of a text already on one line. */
function sentencesOf(line: string): string[] {
  const sentences: string[] = [];
  const ends = /[.!?…]+["”’')\]]*(?= )/g;
  let from = 0;
  for (let end = ends.exec(line); end; end = ends.exec(line)) {
    const to = end.index + end[0].length;
    const sentence = line.slice(from, to);
    if (TITLE.test(sentence)) continue;
    sentences.push(sentence);
    from = to + 1;
  }
  if (from < line.length) sentences.push(line.slice(from));
  return sentences;
}

/**
 * A text as pages of at most `max` characters, broken where a sentence
 * ends. A sentence too long for a page goes on between its words. Never
 * inside a word — one longer than a page has a page to itself — and never
 * an empty page: nothing to read is no pages at all.
 */
export function pagesOf(text: string, max: number = WEEK_PAGE_CHARS): string[] {
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) return [];

  const pages: string[] = [];
  let page = '';
  const add = (piece: string): void => {
    if (!page) page = piece;
    else if (page.length + 1 + piece.length <= max) page = `${page} ${piece}`;
    else {
      pages.push(page);
      page = piece;
    }
  };
  for (const sentence of sentencesOf(line)) {
    if (sentence.length <= max) add(sentence);
    else sentence.split(' ').forEach(add);
  }
  if (page) pages.push(page);
  return pages;
}

/** "The week from Monday 5 October to Sunday 11 October." — which week, by its days, and never "this week". */
export function weekInWords(isoWeek: string): string {
  const { startMs, endMs } = isoWeekRange(isoWeek);
  const day = (at: number): string =>
    new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(at)).replace(',', '');
  return `The week from ${day(startMs)} to ${day(endMs - 86_400_000)}.`;
}

/** One day of a week's timeline, where the house is. */
interface Day {
  readonly heading: string;
  readonly lines: readonly string[];
}

/**
 * The timeline as days, in order, each with what happened on it in the
 * order it did. Every entry of the family's copy is here and none is
 * worded again — what the family app lists for the same week
 * (apps/sim-alexa surface.js presentWeek): an entry's own sentence, and
 * its time where the house is.
 */
function daysOf(timeline: readonly TimelineEntry[], timeZone: string): Day[] {
  const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dayWords = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long', day: 'numeric', month: 'long' });
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

  const days = new Map<string, { heading: string; lines: string[] }>();
  for (const entry of [...timeline].sort((a, b) => a.at - b.at)) {
    const when = new Date(entry.at);
    const key = dayKey.format(when);
    const day = days.get(key) ?? { heading: dayWords.format(when).replace(',', ''), lines: [] };
    day.lines.push(`${clock.format(when)} — ${entry.summary}`);
    days.set(key, day);
  }
  return [...days.values()];
}

/** One day as pages: its name first, and again ("…, continued") on each page it runs on to. */
function pagesOfDay(day: Day): string[] {
  const pages: string[] = [];
  let page = [day.heading];
  for (const line of day.lines) {
    const fits = page.length < WEEK_PAGE_LINES && [...page, line].join('\n').length <= WEEK_PAGE_CHARS;
    // A page always takes one thing, however long: nothing is cut and nothing left out.
    if (!fits && page.length > 1) {
      pages.push(page.join('\n'));
      page = [`${day.heading}, continued`];
    }
    page.push(line);
  }
  pages.push(page.join('\n'));
  return pages;
}

/**
 * Everything there is to read of a week: its paragraph, then a page for
 * each day something happened. Never more pages than a television takes —
 * when the days would run over, whole days are kept from the start of the
 * week and the rest are left out, with nothing said that is not so.
 */
export function weekPages(week: Pick<WeekNarrative, 'text' | 'timeline'>, timeZone: string): string[] {
  const pages = pagesOf(week.text).slice(0, WEEK_MAX_PAGES);
  for (const day of daysOf(week.timeline ?? [], timeZone)) {
    const more = pagesOfDay(day);
    if (pages.length + more.length > WEEK_MAX_PAGES) break;
    pages.push(...more);
  }
  return pages;
}

/**
 * The week this household's family may read now, or undefined when there is
 * none for them — whatever the reason. `latest` is asked for only when she
 * shares the shape of her week: otherwise her weeks are not looked at.
 * What she shares is applied here, to whatever `latest` hands over, so it
 * holds as it stands now even when the lookup was made a moment ago.
 */
export async function readableWeek(policy: HouseholdPolicy, latest: () => Promise<LatestWeekResult>, timeZone: string): Promise<WeekNarrative | undefined> {
  if (!isSharedWithFamily('RHYTHM', policy)) return undefined;
  const family = familyCopyOfLatest(await latest(), policy, timeZone);
  return family.status === 'available' ? family.narrative : undefined;
}

/** The card that offers a week — unless this television has read it, or a later one, to its end. */
export function weekCard(who: TvCaller, week: WeekNarrative | undefined): FamilyTvCard | undefined {
  if (!week || !WEEK_ID.test(week.isoWeek)) return undefined;
  if (who.weekRead !== undefined && week.isoWeek <= who.weekRead) return undefined;
  const pages = weekPages(week, zoneOf(who.household));
  if (pages.length === 0) return undefined;
  return {
    id: familyTvCardId('week', week.isoWeek),
    kind: 'week',
    headline: `${who.household.residentName}’s week is here to read.`,
    // A demo home's weeks were written, not lived, and are never shown without saying so (AGENTS.md).
    detail: `${weekInWords(week.isoWeek)}${week.simulated ? ' It is a simulated week: this is a demo home.' : ''}`,
    pages,
    actions: [
      { id: FAMILY_TV_OWN_ACTIONS.read, label: 'Read it', kind: 'primary' },
      { id: FAMILY_TV_OWN_ACTIONS.later, label: 'Not now', kind: 'dismiss' },
    ],
  };
}

/**
 * Notes on this television's own row that a week was read to its end.
 * False when the television is no longer this member's to note it on: the
 * write never makes a row, so one disconnected a moment ago stays so.
 */
export async function markWeekRead(ddb: DynamoDBClient, who: TvCaller, isoWeek: string): Promise<boolean> {
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: { pk: { S: `HH#${who.householdId}` }, sk: { S: `${FAMILY_TV_SK_PREFIX}${who.deviceId}` } },
      UpdateExpression: 'SET weekRead = :week',
      ConditionExpression: 'attribute_exists(pk) AND userId = :member',
      ExpressionAttributeValues: { ':week': { S: isoWeek }, ':member': { S: who.userId } },
    }));
    return true;
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    return false;
  }
}
