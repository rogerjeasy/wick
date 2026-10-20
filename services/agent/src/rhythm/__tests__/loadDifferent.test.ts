import { describe, expect, it, vi } from 'vitest';
import type { AttributeValue, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { padTimestamp } from '@wick/contracts';
import { DEFAULT_POLICY } from '@wick/policy';
import { loadShareableDifferences } from '../loadDifferent.js';

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const HOUR = 3_600_000;
/** Friday 9 October 2026, two in the afternoon UTC. */
const FRIDAY = Date.UTC(2026, 9, 9);
const NOW = FRIDAY + 14 * HOUR;

type Item = Record<string, AttributeValue>;
const evt = (at: number, fields: Item): Item => ({ pk: { S: 'HH#hh-1' }, sk: { S: `EVT#${padTimestamp(at)}#x` }, ...fields });
const mariaVisit = (at: number): Item => evt(at, { type: { S: 'presence' }, personId: { S: 'maria' }, personName: { S: 'Maria' } });
const doorCall = (at: number): Item => evt(at, { type: { S: 'door' } });

/** Maria on every Tuesday and Friday for six weeks before this Friday, and this Tuesday — but not today. */
const sixWeeksOfMaria: Item[] = [
  ...[1, 2, 3, 4, 5, 6].flatMap((k) => [mariaVisit(FRIDAY - k * WEEK + 9 * HOUR), mariaVisit(FRIDAY - 3 * DAY - k * WEEK + 9 * HOUR)]),
  mariaVisit(FRIDAY - 3 * DAY + 9 * HOUR),
];
const maria: Item = { sk: { S: 'PER#maria' }, data: { S: JSON.stringify({ personId: 'maria', name: 'Maria', expectedPattern: 'TUE,FRI 09:00±30m' }) } };

/** The doorbell heard every hour of every day from `from` to `to` (packages/contracts heard.ts), but not the hours `silent` covers. */
function heardRows(from: number, to: number, silent?: { from: number; to: number }): Item[] {
  const rows: Item[] = [];
  for (let day = Math.floor(from / DAY) * DAY; day <= to; day += DAY) {
    const hours = Array.from({ length: 24 }, (_, h) => h)
      .filter((h) => day + h * HOUR < to)
      .filter((h) => !silent || day + h * HOUR + HOUR <= silent.from || day + h * HOUR >= silent.to);
    if (hours.length) rows.push({ pk: { S: 'HH#hh-1' }, sk: { S: `HEARD#${new Date(day).toISOString().slice(0, 10)}` }, hours: { NS: hours.map(String) } });
  }
  return rows;
}

/** A table that answers the reads the loader makes, and notes which they were. */
function table(events: Item[], { exclusions = [] as string[], firstAt = FRIDAY - 8 * WEEK, heard = heardRows(FRIDAY - 8 * WEEK, NOW) } = {}) {
  const reads: string[] = [];
  const send = vi.fn().mockImplementation((cmd: { constructor: { name: string }; input: { ExpressionAttributeValues?: Record<string, AttributeValue> } }) => {
    if (cmd.constructor.name === 'GetItemCommand') {
      reads.push('META');
      return Promise.resolve({ Item: { policy: { S: JSON.stringify(DEFAULT_POLICY) }, ...(exclusions.length ? { residentExclusions: { SS: exclusions } } : {}) } });
    }
    const prefix = cmd.input.ExpressionAttributeValues?.[':prefix']?.S;
    if (prefix === 'PER#' || prefix === 'MEM#') {
      reads.push(prefix);
      return Promise.resolve({ Items: prefix === 'PER#' ? [maria] : [] });
    }
    if (prefix === 'EVT#') {
      reads.push('first');
      return Promise.resolve({ Items: [evt(firstAt, { type: { S: 'door' } })] });
    }
    const from = cmd.input.ExpressionAttributeValues?.[':from']?.S ?? '';
    if (from.startsWith('HEARD#')) {
      reads.push('heard');
      return Promise.resolve({ Items: heard });
    }
    reads.push(`timeline from ${from}`);
    return Promise.resolve({ Items: events });
  });
  return { ddb: { send } as unknown as DynamoDBClient, reads };
}

const load = (ddb: DynamoDBClient) => loadShareableDifferences(ddb, 'wick', 'hh-1', NOW, 'Europe/London');

describe('loadShareableDifferences — what the resident could be asked about', () => {
  it('finds the visitor who did not come, measured against the household’s own six weeks', async () => {
    const found = (await load(table(sixWeeksOfMaria).ddb))!;

    expect(found.weeksObserved).toBe(6);
    expect(found.differences.map((d) => [d.kind, d.lasting])).toEqual([
      ['missed_visit', 'Maria is usually expected on Friday mornings. Nobody came to the door at that time on Friday.'],
    ]);
  });

  it('says nothing of a visitor’s window the doorbell was not heard around — and says the doorbell has gone quiet', async () => {
    // Nothing heard from Thursday 03:00 to now: the doorbell, its link or Ring was down through Maria's window.
    const outage = heardRows(FRIDAY - 8 * WEEK, NOW, { from: FRIDAY - 21 * HOUR, to: NOW });
    const found = (await load(table(sixWeeksOfMaria, { heard: outage }).ddb))!;

    expect(found.differences).toEqual([]);
    expect(found.doorUnheard).toEqual({ lastHeardAt: FRIDAY - 21 * HOUR });
  });

  it('finds nothing on a usual day, and nothing before three weeks', async () => {
    const usual = (await load(table([...sixWeeksOfMaria, mariaVisit(FRIDAY + 9 * HOUR)]).ddb))!;
    const young = (await load(table(sixWeeksOfMaria, { firstAt: FRIDAY - 10 * DAY }).ddb))!;

    expect(usual.differences).toEqual([]);
    expect(young).toEqual({ weeksObserved: 1, differences: [] });
  });

  it('leaves out visitors the resident keeps private — and does not even read who they are', async () => {
    const { ddb, reads } = table(sixWeeksOfMaria, { exclusions: ['PRESENCE'] });

    expect((await load(ddb))!.differences).toEqual([]);
    expect(reads).not.toContain('PER#');
    expect(reads).not.toContain('MEM#');
  });

  it('leaves out the door on its own: the visitor is still found, the night call is not', async () => {
    const inTheNight = doorCall(FRIDAY + 1 * HOUR + 10 * 60_000);
    const { ddb } = table([...sixWeeksOfMaria, inTheNight], { exclusions: ['DOOR_EVENT'] });

    expect((await load(ddb))!.differences.map((d) => d.kind)).toEqual(['missed_visit']);
  });

  it('is nothing at all when the resident keeps the shape of the week private: only that choice is read', async () => {
    const { ddb, reads } = table(sixWeeksOfMaria, { exclusions: ['RHYTHM'] });

    expect(await load(ddb)).toBeUndefined();
    expect(reads).toEqual(['META']);
  });

  it('reads six weeks and a day of the timeline, no more', async () => {
    const { ddb, reads } = table([]);

    await load(ddb);

    expect(reads.filter((r) => r.startsWith('timeline'))).toEqual([`timeline from EVT#${padTimestamp(NOW - 43 * DAY)}`]);
  });
});
