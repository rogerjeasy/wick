import { describe, expect, it } from 'vitest';
import { UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { visitFromItem, visitItem, visitStore, type VisitSend } from '@wick/agent';
import type { Visit } from '@wick/contracts';
import { createMemoryTable } from './memoryTable.js';

/**
 * The table in memory stands in for DynamoDB under the dev server and the
 * end-to-end tests, so a request it does not understand is a path that has
 * never really run there. These are the visit store's own requests.
 */
describe('memoryTable — the visit store’s requests', () => {
  const ARRIVED = 1_791_880_000_000;
  const visit: Visit = { householdId: 'hh-1', personId: 'maria', name: 'Maria', arrivedAt: ARRIVED, leftAt: ARRIVED + 45 * 60_000 };
  const setup = () => {
    const table = createMemoryTable();
    const store = visitStore((command) => table.ddb.send(command as never) as ReturnType<VisitSend>, 'wick');
    const held = () => visitFromItem(table.rows('HH#hh-1')[0]);
    return { table, store, held };
  };

  it('takes an asking back: the card could not be sent, so she has not been asked', async () => {
    const { table, store, held } = setup();
    table.put(visitItem(visit));
    expect(await store.claimAsk(visit, ARRIVED + 60 * 60_000)).toBe(true);
    expect(held()?.askedAt).toBe(ARRIVED + 60 * 60_000);

    await store.releaseAsk(visit);

    expect(held()).toEqual(visit);
    // And so she can be asked again.
    expect(await store.claimAsk(visit, ARRIVED + 70 * 60_000)).toBe(true);
  });

  it('never takes back an asking she has answered', async () => {
    const { table, store, held } = setup();
    table.put(visitItem({ ...visit, askedAt: ARRIVED + 60 * 60_000, answer: 'confirmed', answeredAt: ARRIVED + 61 * 60_000 }));

    await store.releaseAsk(visit);

    expect(held()).toMatchObject({ askedAt: ARRIVED + 60 * 60_000, answer: 'confirmed' });
  });

  it('moves a leaving later only, and not once she has been asked', async () => {
    const { table, store, held } = setup();
    table.put(visitItem(visit));
    expect(await store.setLeft(visit, visit.leftAt! - 1)).toBe(false);
    expect(await store.setLeft(visit, visit.leftAt! + 5 * 60_000)).toBe(true);
    expect(held()?.leftAt).toBe(visit.leftAt! + 5 * 60_000);

    await store.claimAsk(visit, ARRIVED + 90 * 60_000);
    expect(await store.setLeft(visit, visit.leftAt! + 30 * 60_000)).toBe(false);
  });
});

/** The account store's taking back of a language question: what it records and what it clears, in one update. */
describe('memoryTable — an update that sets and removes at once', () => {
  it('does both, under its condition, as DynamoDB does', async () => {
    const table = createMemoryTable();
    const key = { pk: { S: 'HH#hh-1' }, sk: { S: 'META' } };
    table.put({ ...key, languageAsked: { S: 'es' }, languageAskedAt: { N: '5' }, name: { S: 'Mum’s house' } });
    const update = (asked: string) =>
      table.ddb.send(new UpdateItemCommand({
        TableName: 'wick',
        Key: key,
        UpdateExpression: 'SET #takenBack = :asked, #takenBackAt = :now REMOVE #asked, #at',
        ConditionExpression: '#asked = :asked',
        ExpressionAttributeNames: { '#takenBack': 'languageTakenBack', '#takenBackAt': 'languageTakenBackAt', '#asked': 'languageAsked', '#at': 'languageAskedAt' },
        ExpressionAttributeValues: { ':asked': { S: asked }, ':now': { N: '9' } },
      }));

    await expect(update('en')).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
    await update('es');

    expect(table.rows('HH#hh-1')).toEqual([{ ...key, name: { S: 'Mum’s house' }, languageTakenBack: { S: 'es' }, languageTakenBackAt: { N: '9' } }]);
  });
});
