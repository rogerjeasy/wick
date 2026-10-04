import { describe, expect, it } from 'vitest';
import {
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { createDynamoAccountStore, HouseholdExistsError, type DdbSend } from '../store.js';
import type { Membership } from '../types.js';

const NOW = 1_790_000_000_000;

type Command = GetItemCommand | PutItemCommand | UpdateItemCommand | DeleteItemCommand | QueryCommand;
type Reply = { Item?: Record<string, AttributeValue>; Items?: Record<string, AttributeValue>[]; Attributes?: Record<string, AttributeValue> };

/** Records every command and answers each from a queue, in order. */
function recorder(replies: (Reply | Error)[] = []) {
  const sent: Command[] = [];
  const send = (async (command: Command) => {
    sent.push(command);
    const reply = replies.shift() ?? {};
    if (reply instanceof Error) throw reply;
    return reply;
  }) as unknown as DdbSend;
  return { sent, store: createDynamoAccountStore(send, 'wick', () => NOW) };
}

function conditionFailed(): Error {
  return Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });
}

const SARAH: Membership = {
  householdId: 'hh_1',
  userId: 'u_sarah',
  name: 'Sarah',
  role: 'organiser',
  status: 'pending',
  requestedAt: NOW,
};

describe('memberships', () => {
  it('stores a membership under its household, and under the person so their households can be listed', async () => {
    const { sent, store } = recorder();

    await store.putMembership(SARAH);

    const item = (sent[0] as PutItemCommand).input.Item!;
    expect(item.pk).toEqual({ S: 'HH#hh_1' });
    expect(item.sk).toEqual({ S: 'MEM#u_sarah' });
    expect(item.gsi1pk).toEqual({ S: 'USER#u_sarah' });
    expect(item.gsi1sk).toEqual({ S: 'HH#hh_1' });
    // Top-level, not inside a JSON blob: the television's Lambda changes it under a condition.
    expect(item.status).toEqual({ S: 'pending' });
  });

  it('lists a person’s households through the index, not by scanning', async () => {
    const { sent, store } = recorder([
      {
        Items: [
          {
            pk: { S: 'HH#hh_1' }, sk: { S: 'MEM#u_sarah' }, name: { S: 'Sarah' }, role: { S: 'organiser' },
            status: { S: 'allowed' }, requestedAt: { N: String(NOW) }, decidedAt: { N: String(NOW + 5) },
          },
        ],
      },
    ]);

    const memberships = await store.listMemberships('u_sarah');

    const query = (sent[0] as QueryCommand).input;
    expect(query.IndexName).toBe('gsi1');
    expect(query.ExpressionAttributeValues![':pk']).toEqual({ S: 'USER#u_sarah' });
    expect(memberships).toEqual([{ ...SARAH, status: 'allowed', decidedAt: NOW + 5 }]);
  });

  it('changes a status only on a membership that exists', async () => {
    const { sent, store } = recorder();

    await store.setMemberStatus('hh_1', 'u_sarah', 'removed', NOW + 9);

    const update = (sent[0] as UpdateItemCommand).input;
    expect(update.Key).toEqual({ pk: { S: 'HH#hh_1' }, sk: { S: 'MEM#u_sarah' } });
    expect(update.ConditionExpression).toBe('attribute_exists(pk)');
    expect(update.ExpressionAttributeValues![':status']).toEqual({ S: 'removed' });
  });
});

describe('people', () => {
  it('finds a person by their email, whatever its case, through the index', async () => {
    const { sent, store } = recorder([{ Items: [{ pk: { S: 'USER#u_sarah' }, sk: { S: 'PROFILE' }, email: { S: 'sarah@example.com' }, name: { S: 'Sarah' }, createdAt: { N: '7' } }] }]);

    const user = await store.findUserByEmail('Sarah@Example.com');

    const query = (sent[0] as QueryCommand).input;
    expect(query.IndexName).toBe('gsi1');
    expect(query.ExpressionAttributeValues![':pk']).toEqual({ S: 'EMAIL#sarah@example.com' });
    expect(user).toEqual({ userId: 'u_sarah', email: 'sarah@example.com', name: 'Sarah', createdAt: 7 });
  });

  it('is undefined for an email nobody signed up with', async () => {
    const { store } = recorder([{ Items: [] }]);

    expect(await store.findUserByEmail('nobody@example.com')).toBeUndefined();
  });
});

describe('households', () => {
  it('creates a household without replacing the META item, so a policy already there survives', async () => {
    const { sent, store } = recorder();

    await store.createHousehold({ householdId: 'hh_1', name: 'Mum’s house', residentName: 'Margaret', createdBy: 'u_sarah', createdAt: NOW });

    expect(sent[0]).toBeInstanceOf(UpdateItemCommand);
    const update = (sent[0] as UpdateItemCommand).input;
    expect(update.Key).toEqual({ pk: { S: 'HH#hh_1' }, sk: { S: 'META' } });
    expect(update.ConditionExpression).toBe('attribute_not_exists(createdBy)');
  });

  it('refuses to take over a household somebody already created', async () => {
    const { store } = recorder([conditionFailed()]);

    await expect(
      store.createHousehold({ householdId: 'hh_1', name: 'x', residentName: 'y', createdBy: 'u_tom', createdAt: NOW }),
    ).rejects.toBeInstanceOf(HouseholdExistsError);
  });

  it('treats a META item nobody has claimed as no household at all', async () => {
    const { store } = recorder([{ Item: { pk: { S: 'HH#margaret' }, sk: { S: 'META' }, policy: { S: '{}' } } }]);

    expect(await store.getHousehold('margaret')).toBeUndefined();
  });
});

describe('televisions', () => {
  it('lists the household’s paired televisions and says which are connected now', async () => {
    const { store } = recorder([
      {
        Items: [
          { sk: { S: 'DEV#tv-1' }, deviceId: { S: 'tv-1' }, pairedAt: { N: '5' }, connectionId: { S: 'c1' } },
          { sk: { S: 'DEV#tv-2' }, deviceId: { S: 'tv-2' }, pairedAt: { N: '6' } },
          { sk: { S: 'DEV#tv-3' }, deviceId: { S: 'tv-3' }, denylisted: { BOOL: true } },
        ],
      },
    ]);

    expect(await store.listTelevisions('hh_1')).toEqual([
      { deviceId: 'tv-1', pairedAt: 5, connected: true },
      { deviceId: 'tv-2', pairedAt: 6, connected: false },
    ]);
  });
});

describe('keyed records — sessions, invitations and OAuth state', () => {
  it('stores a record with DynamoDB’s expiry in seconds and its own in milliseconds', async () => {
    const { sent, store } = recorder();

    await store.putRecord('OAUTH#AT', 'abc', { userId: 'u_sarah' }, NOW + 60_000);

    const item = (sent[0] as PutItemCommand).input.Item!;
    expect(item.pk).toEqual({ S: 'OAUTH#AT#abc' });
    expect(item.sk).toEqual({ S: 'META' });
    expect(item.expiresAt).toEqual({ N: String(NOW + 60_000) });
    expect(item.ttl).toEqual({ N: String(Math.floor((NOW + 60_000) / 1000)) });
    expect(JSON.parse(item.data!.S!)).toEqual({ userId: 'u_sarah' });
  });

  it('does not return a record past its expiry, even though DynamoDB has not deleted it yet', async () => {
    const { store } = recorder([
      { Item: { data: { S: '{"userId":"u_sarah"}' }, expiresAt: { N: String(NOW - 1) } } },
    ]);

    expect(await store.getRecord('SESSION', 'abc')).toBeUndefined();
  });

  it('reads consistently: a code is exchanged a moment after it is written', async () => {
    const { sent, store } = recorder([{ Item: { data: { S: '{"a":1}' } } }]);

    expect(await store.getRecord('OAUTH#CODE', 'abc')).toEqual({ a: 1 });
    expect((sent[0] as GetItemCommand).input.ConsistentRead).toBe(true);
  });

  it('takes a record with one atomic delete, so two callers can never both hold it', async () => {
    const { sent, store } = recorder([{ Attributes: { data: { S: '{"a":1}' }, expiresAt: { N: String(NOW + 1) } } }, {}]);

    expect(await store.takeRecord('OAUTH#CODE', 'abc')).toEqual({ a: 1 });
    expect(await store.takeRecord('OAUTH#CODE', 'abc')).toBeUndefined();
    expect(sent[0]).toBeInstanceOf(DeleteItemCommand);
    expect((sent[0] as DeleteItemCommand).input.ReturnValues).toBe('ALL_OLD');
  });
});
