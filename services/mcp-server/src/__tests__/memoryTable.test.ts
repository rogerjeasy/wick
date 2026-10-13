import { describe, expect, it } from 'vitest';
import { DeleteItemCommand, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
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

/** The picture rows' requests (photos/rows.ts): a delete that only undoes its own sending, and a consistent read of a household's pictures. */
describe('memoryTable — a delete under a condition', () => {
  const key = { pk: { S: 'HH#hh-1' }, sk: { S: 'PHOTO#abc' } };
  const remove = (table: ReturnType<typeof createMemoryTable>, sentAt: string) =>
    table.ddb.send(new DeleteItemCommand({
      TableName: 'wick',
      Key: key,
      ConditionExpression: 'sentBy = :by AND sentAt = :at AND attribute_not_exists(seenAt)',
      ExpressionAttributeValues: { ':by': { S: 'u_sarah' }, ':at': { N: sentAt } },
    }));

  it('deletes the row only while the condition holds', async () => {
    const table = createMemoryTable();
    table.put({ ...key, sentBy: { S: 'u_sarah' }, sentAt: { N: '5' } });

    await expect(remove(table, '6')).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
    expect(table.rows('HH#hh-1')).toHaveLength(1);

    await remove(table, '5');
    expect(table.rows('HH#hh-1')).toEqual([]);
  });

  it('leaves a row she has since seen', async () => {
    const table = createMemoryTable();
    table.put({ ...key, sentBy: { S: 'u_sarah' }, sentAt: { N: '5' }, seenAt: { N: '9' } });

    await expect(remove(table, '5')).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
    expect(table.rows('HH#hh-1')).toHaveLength(1);
  });

  it('answers a consistent query like any other', async () => {
    const table = createMemoryTable();
    table.put({ ...key, sentBy: { S: 'u_sarah' }, sentAt: { N: '5' } });

    const res = await table.ddb.send(new QueryCommand({
      TableName: 'wick',
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': { S: 'HH#hh-1' }, ':prefix': { S: 'PHOTO#' } },
      ConsistentRead: true,
    }));

    expect(res.Items).toHaveLength(1);
  });
});

/** The count of a member's tries at sending a picture (photos/tries.ts): added to under a condition, with its expiry set once. */
describe('memoryTable — a number added to, under a condition', () => {
  const key = { pk: { S: 'HH#hh-1' }, sk: { S: 'TRY#PHOTO#u_sarah#2026-09-21' } };
  const tryOnce = (table: ReturnType<typeof createMemoryTable>, cap: number, ttl = '111') =>
    table.ddb.send(new UpdateItemCommand({
      TableName: 'wick',
      Key: key,
      UpdateExpression: 'ADD #tries :one SET #ttl = if_not_exists(#ttl, :ttl)',
      ConditionExpression: '(attribute_not_exists(#tries) OR #tries < :cap)',
      ExpressionAttributeNames: { '#tries': 'tries', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':one': { N: '1' }, ':cap': { N: String(cap) }, ':ttl': { N: ttl } },
    }));

  it('starts the number where there was none, adds to it after, and sets the expiry only the first time', async () => {
    const table = createMemoryTable();

    await tryOnce(table, 3, '111');
    await tryOnce(table, 3, '999');

    expect(table.rows('HH#hh-1')).toEqual([{ ...key, tries: { N: '2' }, ttl: { N: '111' } }]);
  });

  it('refuses to add past the condition, and leaves the number where it was', async () => {
    const table = createMemoryTable();
    for (let i = 0; i < 3; i += 1) await tryOnce(table, 3);

    await expect(tryOnce(table, 3)).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
    expect(table.rows('HH#hh-1')[0]!.tries).toEqual({ N: '3' });
  });
});
