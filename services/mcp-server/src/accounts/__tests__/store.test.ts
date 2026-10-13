import { describe, expect, it } from 'vitest';
import { DeleteItemCommand, GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand, type AttributeValue, type TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
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

  it('files a guest under no email at all: they have none, and must not be findable by an empty one', async () => {
    const { sent, store } = recorder();

    await store.putUser({ userId: 'guest_abc', email: '', name: 'Guest', createdAt: NOW });

    const update = (sent[0] as UpdateItemCommand).input;
    expect(update.Key).toEqual({ pk: { S: 'USER#guest_abc' }, sk: { S: 'PROFILE' } });
    expect(JSON.stringify(update)).not.toContain('EMAIL#');
    expect(update.UpdateExpression).not.toContain('gsi1pk');
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

  it('keeps the mark on a simulated household, and puts none on a real one', async () => {
    const { sent, store } = recorder([
      {},
      { Item: { pk: { S: 'HH#hh_demo' }, sk: { S: 'META' }, name: { S: 'Demo home' }, residentName: { S: 'Margaret' }, createdBy: { S: 'guest_1' }, createdAt: { N: '1' }, simulated: { BOOL: true } } },
      {},
    ]);

    await store.createHousehold({ householdId: 'hh_demo', name: 'Demo home', residentName: 'Margaret', createdBy: 'guest_1', createdAt: NOW, simulated: true });
    expect((sent[0] as UpdateItemCommand).input.ExpressionAttributeValues).toMatchObject({ ':simulated': { BOOL: true } });
    expect((await store.getHousehold('hh_demo'))?.simulated).toBe(true);

    await store.createHousehold({ householdId: 'hh_1', name: 'Mum’s house', residentName: 'Margaret', createdBy: 'u_sarah', createdAt: NOW });
    expect((sent[2] as UpdateItemCommand).input.UpdateExpression).not.toContain('simulated');
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

describe('announced visits', () => {
  it('forgets every visit a person announced to a household, and nobody else’s', async () => {
    const { sent, store } = recorder([
      { Items: [{ pk: { S: 'HH#hh_1' }, sk: { S: 'PER#member-u_tom#2026-10-17' } }, { pk: { S: 'HH#hh_1' }, sk: { S: 'PER#member-u_tom#2026-10-24' } }] },
    ]);

    await store.forgetAnnouncedVisits('hh_1', 'u_tom');

    expect((sent[0] as QueryCommand).input.ExpressionAttributeValues).toEqual({ ':pk': { S: 'HH#hh_1' }, ':prefix': { S: 'PER#member-u_tom#' } });
    expect(sent.slice(1).map((c) => (c as DeleteItemCommand).input.Key)).toEqual([
      { pk: { S: 'HH#hh_1' }, sk: { S: 'PER#member-u_tom#2026-10-17' } },
      { pk: { S: 'HH#hh_1' }, sk: { S: 'PER#member-u_tom#2026-10-24' } },
    ]);
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

describe('removeTelevision — disconnecting one from a home', () => {
  it('takes away the pairing and the claim on the television’s id together, so it can be connected again', async () => {
    const { sent, store } = recorder();

    expect(await store.removeTelevision('hh_1', 'tv-2')).toBe(true);

    expect(sent).toHaveLength(1);
    const [pairing, claim] = (sent[0] as unknown as TransactWriteItemsCommand).input.TransactItems!;
    // Without this row the television is refused everywhere it is served (edge-device device-standing.mjs).
    expect(pairing!.Delete).toMatchObject({ Key: { pk: { S: 'HH#hh_1' }, sk: { S: 'DEV#tv-2' } }, ConditionExpression: 'attribute_exists(pk)' });
    // Only this home's claim: a television since connected somewhere else keeps the one it has.
    expect(claim!.Delete).toMatchObject({
      Key: { pk: { S: 'DEV#tv-2' }, sk: { S: 'META' } },
      ConditionExpression: 'attribute_not_exists(pk) OR householdId = :hh',
      ExpressionAttributeValues: { ':hh': { S: 'hh_1' } },
    });
  });

  it('says so when the television is not this home’s, and removes nothing', async () => {
    const { store } = recorder([Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException' })]);

    expect(await store.removeTelevision('hh_1', 'tv-9')).toBe(false);
  });
});

describe('family televisions — a member’s own', () => {
  it('lists the household’s family televisions from their own rows, with whose each is, and leaves out one revoked', async () => {
    const { sent, store } = recorder([
      {
        Items: [
          { sk: { S: 'FTV#tv-sarah' }, deviceId: { S: 'tv-sarah' }, userId: { S: 'u_sarah' }, pairedAt: { N: '7' }, denylisted: { BOOL: false } },
          { sk: { S: 'FTV#tv-tom' }, userId: { S: 'u_tom' } },
          { sk: { S: 'FTV#tv-gone' }, deviceId: { S: 'tv-gone' }, userId: { S: 'u_tom' }, denylisted: { BOOL: true } },
          // A row that does not say whose it is belongs to nobody, and is not listed.
          { sk: { S: 'FTV#tv-nobody' }, deviceId: { S: 'tv-nobody' } },
        ],
      },
    ]);

    expect(await store.listFamilyTelevisions('hh_1')).toEqual([
      { deviceId: 'tv-sarah', userId: 'u_sarah', pairedAt: 7 },
      { deviceId: 'tv-tom', userId: 'u_tom' },
    ]);
    // Never the DEV# rows: those are the resident's televisions.
    expect((sent[0] as QueryCommand).input).toMatchObject({
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': { S: 'HH#hh_1' }, ':prefix': { S: 'FTV#' } },
    });
  });

  it('takes away the television’s row and the claim on its id together, as for the resident’s', async () => {
    const { sent, store } = recorder();

    expect(await store.removeFamilyTelevision('hh_1', 'tv-tom')).toBe(true);

    expect(sent).toHaveLength(1);
    const [row, claim] = (sent[0] as unknown as TransactWriteItemsCommand).input.TransactItems!;
    expect(row!.Delete).toMatchObject({ Key: { pk: { S: 'HH#hh_1' }, sk: { S: 'FTV#tv-tom' } }, ConditionExpression: 'attribute_exists(pk)' });
    expect(row!.Delete!.ExpressionAttributeValues).toBeUndefined();
    expect(claim!.Delete).toMatchObject({
      Key: { pk: { S: 'DEV#tv-tom' }, sk: { S: 'META' } },
      ConditionExpression: 'attribute_not_exists(pk) OR householdId = :hh',
      ExpressionAttributeValues: { ':hh': { S: 'hh_1' } },
    });
  });

  it('removes it only if it is that member’s, when asked on a member’s behalf', async () => {
    const { sent, store } = recorder();

    await store.removeFamilyTelevision('hh_1', 'tv-tom', 'u_tom');

    const [row] = (sent[0] as unknown as TransactWriteItemsCommand).input.TransactItems!;
    expect(row!.Delete).toMatchObject({
      Key: { pk: { S: 'HH#hh_1' }, sk: { S: 'FTV#tv-tom' } },
      ConditionExpression: 'attribute_exists(pk) AND userId = :user',
      ExpressionAttributeValues: { ':user': { S: 'u_tom' } },
    });
  });

  it('says so when there is no such family television, or it is somebody else’s, and removes nothing', async () => {
    const { store } = recorder([Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException' })]);

    expect(await store.removeFamilyTelevision('hh_1', 'tv-9', 'u_tom')).toBe(false);
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

describe('the language of the television — read from the household, and only the question written', () => {
  const META = { pk: { S: 'HH#hh_1' }, sk: { S: 'META' }, name: { S: 'Mum’s house' }, residentName: { S: 'Margaret' }, createdBy: { S: 'u_sarah' }, createdAt: { N: '1' } };
  const ASKED = { language: 'es', by: 'Sarah', at: NOW } as const;
  /** The part of every asking's condition that keeps her no standing for a week. */
  const STANDING_NO =
    ' AND (attribute_not_exists(#declined) OR #declined <> :asked OR #declinedAt <= :stale)' +
    // And the part that keeps a question taken back from being asked again for a day.
    ' AND (attribute_not_exists(#takenBack) OR #takenBack <> :asked OR #takenBackAt <= :takenBackStale)';
  const DAY = 24 * 60 * 60_000;

  it('reads no language as English: the attribute is absent until she chooses another', async () => {
    const { store } = recorder([{ Item: META }]);

    const household = await store.getHousehold('hh_1');

    expect(household).not.toHaveProperty('language');
    expect(household).not.toHaveProperty('languageAsked');
  });

  it('reads the language she chose, and a question still open beside it', async () => {
    const { store } = recorder([
      { Item: { ...META, language: { S: 'es' }, languageAsked: { S: 'en' }, languageAskedBy: { S: 'Sarah' }, languageAskedAt: { N: String(NOW) } } },
    ]);

    expect(await store.getHousehold('hh_1')).toMatchObject({ language: 'es', languageAsked: { language: 'en', by: 'Sarah', at: NOW } });
  });

  it('reads English written out, and a language Wick does not have, as English — and a question for such a language as none', async () => {
    const { store } = recorder([
      { Item: { ...META, language: { S: 'en' } } },
      { Item: { ...META, language: { S: 'tlh' }, languageAsked: { S: 'tlh' }, languageAskedBy: { S: 'Sarah' }, languageAskedAt: { N: '5' } } },
    ]);

    for (let i = 0; i < 2; i += 1) {
      const household = await store.getHousehold('hh_1');
      expect(household).not.toHaveProperty('language');
      expect(household).not.toHaveProperty('languageAsked');
    }
  });

  it('reads the language she last said no to, and when — and never one Wick does not have', async () => {
    const { store } = recorder([
      { Item: { ...META, languageDeclined: { S: 'es' }, languageDeclinedAt: { N: String(NOW - 5) } } },
      { Item: { ...META, languageDeclined: { S: 'tlh' }, languageDeclinedAt: { N: String(NOW - 5) } } },
      { Item: { ...META, languageDeclined: { S: 'es' } } },
    ]);

    expect((await store.getHousehold('hh_1'))?.languageDeclined).toEqual({ language: 'es', at: NOW - 5 });
    expect(await store.getHousehold('hh_1')).not.toHaveProperty('languageDeclined');
    // A no with no time cannot be counted from: it is not kept against anybody.
    expect(await store.getHousehold('hh_1')).not.toHaveProperty('languageDeclined');
  });

  it('never writes her no, nor takes it away: every update names only the question and the organiser’s own taking back', async () => {
    const { sent, store } = recorder();

    await store.askLanguage('hh_1', ASKED, undefined);
    await store.askLanguage('hh_1', { language: 'en', by: 'Sarah', at: NOW }, { language: 'es', open: true });
    await store.clearLanguageQuestion('hh_1', ASKED);
    await store.takeBackLanguageQuestion('hh_1', ASKED, NOW + 5);

    expect(sent).toHaveLength(4);
    for (const command of sent) {
      const { UpdateExpression } = (command as UpdateItemCommand).input;
      expect(UpdateExpression).not.toMatch(/#declined|#language/);
    }
  });

  it('reads the question the organiser last took back, and when', async () => {
    const { store } = recorder([
      { Item: { ...META, languageTakenBack: { S: 'es' }, languageTakenBackAt: { N: String(NOW - 5) } } },
      { Item: { ...META, languageTakenBack: { S: 'tlh' }, languageTakenBackAt: { N: String(NOW - 5) } } },
      { Item: { ...META, languageTakenBack: { S: 'es' } } },
    ]);

    expect((await store.getHousehold('hh_1'))?.languageTakenBack).toEqual({ language: 'es', at: NOW - 5 });
    expect(await store.getHousehold('hh_1')).not.toHaveProperty('languageTakenBack');
    expect(await store.getHousehold('hh_1')).not.toHaveProperty('languageTakenBack');
  });

  it('reads the household consistently when asked to: a question is decided on what her press left a moment ago', async () => {
    const { sent, store } = recorder([{ Item: META }, { Item: META }]);

    await store.getHousehold('hh_1');
    await store.getHousehold('hh_1', { consistent: true });

    expect((sent[0] as GetItemCommand).input.ConsistentRead).toBeUndefined();
    expect((sent[1] as GetItemCommand).input.ConsistentRead).toBe(true);
  });

  it('writes a question with one conditional update: the household exists, does not speak it already, and has no question open', async () => {
    const { sent, store } = recorder();

    expect(await store.askLanguage('hh_1', ASKED, undefined)).toBe(true);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(UpdateItemCommand);
    expect((sent[0] as UpdateItemCommand).input).toEqual({
      TableName: 'wick',
      Key: { pk: { S: 'HH#hh_1' }, sk: { S: 'META' } },
      UpdateExpression: 'SET #asked = :asked, #by = :by, #at = :at',
      ConditionExpression:
        'attribute_exists(createdBy) AND (attribute_not_exists(#language) OR #language <> :asked) AND attribute_not_exists(#asked)' +
        ' AND (attribute_not_exists(#declined) OR #declined <> :asked OR #declinedAt <= :stale)' +
        ' AND (attribute_not_exists(#takenBack) OR #takenBack <> :asked OR #takenBackAt <= :takenBackStale)',
      ExpressionAttributeNames: {
        '#language': 'language',
        '#declined': 'languageDeclined',
        '#declinedAt': 'languageDeclinedAt',
        '#takenBack': 'languageTakenBack',
        '#takenBackAt': 'languageTakenBackAt',
        '#asked': 'languageAsked',
        '#by': 'languageAskedBy',
        '#at': 'languageAskedAt',
      },
      ExpressionAttributeValues: {
        ':asked': { S: 'es' },
        ':by': { S: 'Sarah' },
        ':at': { N: String(NOW) },
        // Her no stands for a week: a no newer than this refuses the write.
        ':stale': { N: String(NOW - 7 * DAY) },
        // A taking back stands for a day: one newer than this refuses it too.
        ':takenBackStale': { N: String(NOW - DAY) },
      },
    });
  });

  it('asks for English only of a television that speaks something else: no language at all is English already', async () => {
    const { sent, store } = recorder();

    await store.askLanguage('hh_1', { language: 'en', by: 'Sarah', at: NOW }, undefined);

    expect((sent[0] as UpdateItemCommand).input.ConditionExpression).toBe(
      'attribute_exists(createdBy) AND attribute_exists(#language) AND #language <> :asked AND attribute_not_exists(#asked)' + STANDING_NO,
    );
  });

  it('replaces a question only while it is still the one that was read', async () => {
    const { sent, store } = recorder();

    await store.askLanguage('hh_1', { language: 'en', by: 'Sarah', at: NOW }, { language: 'es', open: false });

    const update = (sent[0] as UpdateItemCommand).input;
    expect(update.ConditionExpression).toBe('attribute_exists(createdBy) AND attribute_exists(#language) AND #language <> :asked AND #asked = :replacing' + STANDING_NO);
    expect(update.ExpressionAttributeValues).toMatchObject({ ':asked': { S: 'en' }, ':replacing': { S: 'es' } });
    // A question left over for the language she already speaks was not on her television to be taken back: nothing is recorded of it.
    expect(update.UpdateExpression).toBe('SET #asked = :asked, #by = :by, #at = :at');
  });

  it('records a question that was open, and is replaced, as taken back — in the same update', async () => {
    const { sent, store } = recorder();

    await store.askLanguage('hh_1', { language: 'en', by: 'Sarah', at: NOW }, { language: 'es', open: true });

    const update = (sent[0] as UpdateItemCommand).input;
    expect(update.UpdateExpression).toBe('SET #asked = :asked, #by = :by, #at = :at, #takenBack = :replacing, #takenBackAt = :at');
    expect(update.ConditionExpression).toContain('#asked = :replacing');
  });

  it('takes a question back and records that it was, in one conditional update: only the question that was read', async () => {
    const { sent, store } = recorder([{}, conditionFailed()]);

    expect(await store.takeBackLanguageQuestion('hh_1', ASKED, NOW + 60_000)).toBe(true);
    // Answered, or asked again since: nothing is cleared, and nothing recorded.
    expect(await store.takeBackLanguageQuestion('hh_1', ASKED, NOW + 60_000)).toBe(false);

    expect(sent).toHaveLength(2);
    expect((sent[0] as UpdateItemCommand).input).toEqual({
      TableName: 'wick',
      Key: { pk: { S: 'HH#hh_1' }, sk: { S: 'META' } },
      UpdateExpression: 'SET #takenBack = :asked, #takenBackAt = :takenBackAt REMOVE #asked, #by, #at',
      ConditionExpression: '#asked = :asked AND #at = :at',
      ExpressionAttributeNames: { '#takenBack': 'languageTakenBack', '#takenBackAt': 'languageTakenBackAt', '#asked': 'languageAsked', '#by': 'languageAskedBy', '#at': 'languageAskedAt' },
      ExpressionAttributeValues: { ':asked': { S: 'es' }, ':at': { N: String(NOW) }, ':takenBackAt': { N: String(NOW + 60_000) } },
    });
  });

  it('says so when the household is no longer as it was read, and writes nothing more', async () => {
    const { sent, store } = recorder([conditionFailed()]);

    expect(await store.askLanguage('hh_1', ASKED, undefined)).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it('undoes exactly the question that was asked when its card could not be sent — recording nothing: she was never asked', async () => {
    const { sent, store } = recorder([{}, conditionFailed()]);

    expect(await store.clearLanguageQuestion('hh_1', ASKED)).toBe(true);
    // Answered, or asked again since: there is nothing of this question left to take back.
    expect(await store.clearLanguageQuestion('hh_1', ASKED)).toBe(false);

    expect((sent[0] as UpdateItemCommand).input).toEqual({
      TableName: 'wick',
      Key: { pk: { S: 'HH#hh_1' }, sk: { S: 'META' } },
      UpdateExpression: 'REMOVE #asked, #by, #at',
      ConditionExpression: '#asked = :asked AND #at = :at',
      ExpressionAttributeNames: { '#asked': 'languageAsked', '#by': 'languageAskedBy', '#at': 'languageAskedAt' },
      ExpressionAttributeValues: { ':asked': { S: 'es' }, ':at': { N: String(NOW) } },
    });
  });
});
