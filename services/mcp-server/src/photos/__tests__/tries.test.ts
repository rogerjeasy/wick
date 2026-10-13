import { describe, expect, it } from 'vitest';
import { UpdateItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PHOTO_SK_PREFIX } from '@wick/contracts';
import { createMemoryTable } from '../../__tests__/memoryTable.js';
import { MAX_PHOTO_TRIES_A_DAY, PHOTO_TRY_SK_PREFIX, PHOTO_TRY_TTL_MS, countTry } from '../tries.js';

const NOW = 1_790_000_000_000;

function recorder(replies: (Error | object)[] = []) {
  const sent: UpdateItemCommand[] = [];
  const ddb = {
    send: async (command: UpdateItemCommand) => {
      sent.push(command);
      const reply = replies.shift() ?? {};
      if (reply instanceof Error) throw reply;
      return reply;
    },
  } as unknown as DynamoDBClient;
  return { sent, ddb };
}

describe('countTry — one more try at sending a picture, counted before anything looks at it', () => {
  it('is one update: the member’s count for the household’s day, added to only while it is under the cap', async () => {
    const { sent, ddb } = recorder();

    expect(await countTry(ddb, { householdId: 'hh_1', userId: 'u_sarah' }, '2026-09-21', NOW)).toBe(true);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(UpdateItemCommand);
    expect(sent[0]!.input).toEqual({
      TableName: 'wick',
      Key: { pk: { S: 'HH#hh_1' }, sk: { S: 'TRY#PHOTO#u_sarah#2026-09-21' } },
      // The adding and the cap are one request: there is no moment between looking and counting.
      UpdateExpression: 'ADD #tries :one SET #ttl = if_not_exists(#ttl, :ttl)',
      ConditionExpression: '(attribute_not_exists(#tries) OR #tries < :cap)',
      ExpressionAttributeNames: { '#tries': 'tries', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':one': { N: '1' }, ':cap': { N: '20' }, ':ttl': { N: String(Math.floor((NOW + PHOTO_TRY_TTL_MS) / 1000)) } },
    });
    expect(MAX_PHOTO_TRIES_A_DAY).toBe(20);
    expect(PHOTO_TRY_TTL_MS).toBe(2 * 24 * 60 * 60_000);
  });

  it('says no once the cap is reached, and lets any other failure be a failure', async () => {
    const { ddb } = recorder([
      Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' }),
      Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' }),
    ]);

    expect(await countTry(ddb, { householdId: 'hh_1', userId: 'u_sarah' }, '2026-09-21', NOW)).toBe(false);
    await expect(countTry(ddb, { householdId: 'hh_1', userId: 'u_sarah' }, '2026-09-21', NOW)).rejects.toMatchObject({ name: 'ProvisionedThroughputExceededException' });
  });

  it('is kept apart from the pictures’ own rows: nothing that lists pictures by their prefix can read it', () => {
    expect(PHOTO_TRY_SK_PREFIX).toBe('TRY#PHOTO#');
    expect(PHOTO_TRY_SK_PREFIX.startsWith(PHOTO_SK_PREFIX)).toBe(false);
    // And outside what the television's home screen reads in its one query, `LIGHT`..`META`.
    expect(PHOTO_TRY_SK_PREFIX > 'META').toBe(true);
  });

  it('against the table’s own condition: exactly twenty are counted, however many are tried at once', async () => {
    const table = createMemoryTable();
    const who = { householdId: 'hh_1', userId: 'u_sarah' };

    const counted = await Promise.all(Array.from({ length: 50 }, () => countTry(table.ddb, who, '2026-09-21', NOW)));

    expect(counted.filter(Boolean)).toHaveLength(20);
    expect(table.rows('HH#hh_1')).toEqual([
      { pk: { S: 'HH#hh_1' }, sk: { S: 'TRY#PHOTO#u_sarah#2026-09-21' }, tries: { N: '20' }, ttl: { N: String(Math.floor((NOW + PHOTO_TRY_TTL_MS) / 1000)) } },
    ]);
    // Another member, and another day, each have their own.
    expect(await countTry(table.ddb, { householdId: 'hh_1', userId: 'u_tom' }, '2026-09-21', NOW)).toBe(true);
    expect(await countTry(table.ddb, who, '2026-09-22', NOW)).toBe(true);
    expect(await countTry(table.ddb, { householdId: 'hh_2', userId: 'u_sarah' }, '2026-09-21', NOW)).toBe(true);
  });
});
