import { describe, expect, it } from 'vitest';
import { QueryCommand, UpdateItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { heardStore } from '../heard.js';

type Item = Record<string, AttributeValue>;
const HOUR = 3_600_000;
const MIDNIGHT = Date.UTC(2026, 9, 9);

/** A table of HEARD# rows that honours ADD on a number set, as DynamoDB does. */
function table() {
  const rows = new Map<string, Item>();
  const send = async (command: QueryCommand | UpdateItemCommand) => {
    if (command instanceof UpdateItemCommand) {
      const key = `${command.input.Key!.pk!.S}|${command.input.Key!.sk!.S}`;
      const row = rows.get(key) ?? { pk: command.input.Key!.pk!, sk: command.input.Key!.sk! };
      const added = command.input.ExpressionAttributeValues![':hour']!.NS!;
      row.hours = { NS: [...new Set([...(row.hours?.NS ?? []), ...added])] };
      row.ttl = command.input.ExpressionAttributeValues![':ttl']!;
      if (command.input.ExpressionAttributeValues![':simulated']) row.simulated = { BOOL: true };
      rows.set(key, row);
      return {};
    }
    const v = command.input.ExpressionAttributeValues!;
    const items = [...rows.values()].filter((r) => r.pk!.S === v[':pk']!.S && r.sk!.S! >= v[':from']!.S! && r.sk!.S! <= v[':to']!.S!);
    return { Items: items };
  };
  return { rows, store: heardStore(send, 'wick') };
}

describe('heardStore — which hours the doorbell was heard', () => {
  it('keeps one row a UTC day, one number an hour however many events came in it, and reads them back as hour starts', async () => {
    const { rows, store } = table();
    await store.record('hh-1', MIDNIGHT + 9 * HOUR + 60_000);
    await store.record('hh-1', MIDNIGHT + 9 * HOUR + 120_000);
    await store.record('hh-1', MIDNIGHT + 13 * HOUR);
    await store.record('hh-1', MIDNIGHT + 26 * HOUR, { simulated: true });

    expect(rows.size).toBe(2);
    expect(rows.get('HH#hh-1|HEARD#2026-10-09')!.hours!.NS!.sort()).toEqual(['13', '9']);
    expect(rows.get('HH#hh-1|HEARD#2026-10-10')!.simulated).toEqual({ BOOL: true });
    expect(await store.hours('hh-1', MIDNIGHT, MIDNIGHT + 30 * HOUR)).toEqual([MIDNIGHT + 9 * HOUR, MIDNIGHT + 13 * HOUR, MIDNIGHT + 26 * HOUR]);
    expect(await store.hours('hh-1', MIDNIGHT + 10 * HOUR, MIDNIGHT + 20 * HOUR)).toEqual([MIDNIGHT + 13 * HOUR]);
  });

  it('keeps nothing but the hour: no event, no kind, no device', async () => {
    const { rows, store } = table();
    await store.record('hh-1', MIDNIGHT + 9 * HOUR);
    expect(Object.keys(rows.get('HH#hh-1|HEARD#2026-10-09')!).sort()).toEqual(['hours', 'pk', 'sk', 'ttl']);
  });
});
