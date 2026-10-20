import { describe, expect, it } from 'vitest';
import { GetItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { visitorWordStore } from '../visitorWord.js';

type Item = Record<string, AttributeValue>;
const ERRAND = 'err_AAAAAAAAAAAAAAAAAAAA';

/** The roster rows, read as GetItem reads them. */
function table(rows: Record<string, Item>) {
  const asked: GetItemCommand['input'][] = [];
  const send = async (command: GetItemCommand) => {
    asked.push(command.input);
    return { Item: rows[`${command.input.Key!.pk!.S}|${command.input.Key!.sk!.S}`] };
  };
  return { asked, store: visitorWordStore(send, 'wick') };
}

describe('visitorWordStore — what the visitor last said, as the door reads it', () => {
  it('reads the roster row of that one errand, consistently, and only its word', async () => {
    const word = { says: 'at_door', at: 1_791_000_000_000 };
    const { asked, store } = table({ [`HH#hh-1|PER#errand:${ERRAND}`]: { visitorWord: { S: JSON.stringify(word) } } });

    expect(await store.rosterWord('hh-1', ERRAND)).toEqual(word);
    expect(asked).toEqual([{
      TableName: 'wick',
      Key: { pk: { S: 'HH#hh-1' }, sk: { S: `PER#errand:${ERRAND}` } },
      ProjectionExpression: 'visitorWord',
      ConsistentRead: true,
    }]);
  });

  it('is nothing for a row with no word, no row, another home’s row, or a word it cannot read', async () => {
    const { store } = table({
      [`HH#hh-1|PER#errand:${ERRAND}`]: {},
      [`HH#hh-2|PER#errand:${ERRAND}`]: { visitorWord: { S: '{"says":"at_door"' } },
      [`HH#hh-3|PER#errand:${ERRAND}`]: { visitorWord: { S: JSON.stringify({ says: 'come_in', at: 1 }) } },
    });

    expect(await store.rosterWord('hh-1', ERRAND)).toBeUndefined();
    expect(await store.rosterWord('hh-2', ERRAND)).toBeUndefined();
    expect(await store.rosterWord('hh-3', ERRAND)).toBeUndefined();
    expect(await store.rosterWord('hh-4', ERRAND)).toBeUndefined();
  });
});
