import { describe, expect, it } from 'vitest';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { householdRows, scanHouseholdsWithTelevision, type PagedSend } from '../loaders.js';

type Item = Record<string, AttributeValue>;

/** A table that answers in pages of `pageSize`, and records every request. */
function pagedTable(items: Item[], pageSize = 2) {
  const asked: Record<string, unknown>[] = [];
  const send: PagedSend = async (cmd) => {
    const input = cmd.input as unknown as Record<string, unknown>;
    asked.push(input);
    const start = (input.ExclusiveStartKey as { n?: { N: string } } | undefined)?.n?.N;
    const from = start === undefined ? 0 : Number(start);
    const page = items.slice(from, from + pageSize);
    const more = from + pageSize < items.length;
    return { Items: page, ...(more ? { LastEvaluatedKey: { n: { N: String(from + pageSize) } } } : {}) };
  };
  return { asked, send };
}

const row = (pk: string, sk: string): Item => ({ pk: { S: pk }, sk: { S: sk } });

describe('scanHouseholdsWithTelevision — the homes a week is written for, every page of them', () => {
  it('reads past the first page, and lists each home with a television once', async () => {
    const t = pagedTable([row('HH#a', 'DEV#tv1'), row('HH#a', 'DEV#tv2'), row('HH#b', 'DEV#tv'), row('HH#c', 'DEV#tv'), row('USER#x', 'DEV#odd')]);

    expect(await scanHouseholdsWithTelevision(t.send, 'wick')).toEqual(['a', 'b', 'c']);
    expect(t.asked).toHaveLength(3);
    expect(t.asked[0]).toMatchObject({ TableName: 'wick', FilterExpression: 'begins_with(pk, :hh) AND begins_with(sk, :dev)', ProjectionExpression: 'pk, sk' });
  });
});

describe('householdRows — one household’s rows, as the brief reads them', () => {
  it('loads the week’s events by their sort-key range, every page', async () => {
    const t = pagedTable([row('HH#h', 'EVT#1'), row('HH#h', 'EVT#2'), row('HH#h', 'EVT#3')]);

    const items = await householdRows(t.send, 'wick', 'h').loadEvents({ startMs: 1000, endMs: 2000 });

    expect(items).toHaveLength(3);
    expect(t.asked[0]).toMatchObject({
      KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
      ExpressionAttributeValues: { ':pk': { S: 'HH#h' }, ':from': { S: 'EVT#000000000001000' }, ':to': { S: 'EVT#000000000001999#￿' } },
    });
  });

  it('finds the household’s first event from the oldest EVT# key', async () => {
    const t = pagedTable([row('HH#h', 'EVT#000000000005000#a')]);
    expect(await householdRows(t.send, 'wick', 'h').firstEventAt()).toBe(5000);
    expect(t.asked[0]).toMatchObject({ Limit: 1, ExpressionAttributeValues: { ':pk': { S: 'HH#h' }, ':prefix': { S: 'EVT#' } } });
    expect(await householdRows(pagedTable([]).send, 'wick', 'h').firstEventAt()).toBeUndefined();
  });

  it('loads the errands and the television’s film counters by their prefixes, every page', async () => {
    const t = pagedTable([row('HH#h', 'ERRAND#1'), row('HH#h', 'ERRAND#2'), row('HH#h', 'ERRAND#3')]);
    const rows = householdRows(t.send, 'wick', 'h');

    expect(await rows.loadErrands()).toHaveLength(3);
    expect(t.asked[0]).toMatchObject({ KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)', ExpressionAttributeValues: { ':prefix': { S: 'ERRAND#' } } });

    await rows.loadTvActivity();
    expect(t.asked.at(-1)).toMatchObject({ ExpressionAttributeValues: { ':prefix': { S: 'RHYTHM#tv_activity#' } } });
  });
});
