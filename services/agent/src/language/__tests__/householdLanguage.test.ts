import { describe, expect, it, vi } from 'vitest';
import { GetItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { HOUSEHOLD_LANGUAGE_ATTRS, type HouseholdLanguage } from '@wick/contracts';
import { loadHouseholdLanguage } from '../../store/household.js';
import { languageReader } from '../householdLanguage.js';

describe('loadHouseholdLanguage — one small read of the household’s own row', () => {
  const answering = (item: Record<string, unknown> | undefined) => {
    const send = vi.fn(async (_command: unknown) => ({ Item: item }));
    return { ddb: { send } as unknown as DynamoDBClient, send };
  };

  it('reads the language, and only the language, from META — a GetItem, which every role that sends to her television may make', async () => {
    const { ddb, send } = answering({ language: { S: 'es' } });

    expect(await loadHouseholdLanguage(ddb, 'wick', 'hh-1')).toBe('es');

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]![0];
    expect(command).toBeInstanceOf(GetItemCommand);
    expect((command as GetItemCommand).input).toEqual({
      TableName: 'wick',
      Key: { pk: { S: 'HH#hh-1' }, sk: { S: 'META' } },
      // `language` is a word DynamoDB keeps for itself.
      ProjectionExpression: '#language',
      ExpressionAttributeNames: { '#language': HOUSEHOLD_LANGUAGE_ATTRS.language },
    });
  });

  it('is English when the row says nothing, says something that is not a language, or is not there', async () => {
    for (const item of [{}, { language: { S: 'fr' } }, { language: { N: '7' } }, undefined]) {
      expect(await loadHouseholdLanguage(answering(item).ddb, 'wick', 'hh-1')).toBe('en');
    }
  });

  it('can be asked for what is so this instant, for the moment she has just answered', async () => {
    const { ddb, send } = answering({ language: { S: 'es' } });

    await loadHouseholdLanguage(ddb, 'wick', 'hh-1', { consistent: true });

    expect((send.mock.calls[0]![0] as GetItemCommand).input.ConsistentRead).toBe(true);
  });
});

describe('languageReader — the language is read when a card is sent, never remembered from an earlier one', () => {
  const setup = (answers: Record<string, HouseholdLanguage> = { 'hh-es': 'es' }) => {
    const read = vi.fn(async (householdId: string, _options?: { consistent?: boolean }) => answers[householdId] ?? 'en');
    const reader = languageReader({ read, log: () => {} });
    return { reader, read, answers };
  };

  it('reads the household’s row every time it is asked: nothing is kept from one send to the next', async () => {
    const { reader, read } = setup();

    expect(await reader.of('hh-es')).toBe('es');
    expect(await reader.of('hh-es')).toBe('es');
    expect(await reader.of('hh-es')).toBe('es');

    expect(read).toHaveBeenCalledTimes(3);
  });

  it('asks for what is so this instant, every time: she may have answered a moment ago', async () => {
    const { reader, read } = setup();

    await reader.of('hh-es');
    await reader.of('hh-en');

    expect(read.mock.calls).toEqual([['hh-es', { consistent: true }], ['hh-en', { consistent: true }]]);
  });

  it('says Spanish to the very next send after her yes, and English to the very next after she goes back', async () => {
    const { reader, answers } = setup({});
    expect(await reader.of('hh-1')).toBe('en');

    answers['hh-1'] = 'es';
    expect(await reader.of('hh-1')).toBe('es');

    delete answers['hh-1'];
    expect(await reader.of('hh-1')).toBe('en');
  });

  it('makes one read of two sends that ask at the same moment — a card and its patch in the same tick — and none is kept once it has answered', async () => {
    const { reader, read } = setup();

    expect(await Promise.all([reader.of('hh-es'), reader.of('hh-es'), reader.of('hh-en')])).toEqual(['es', 'es', 'en']);
    expect(read).toHaveBeenCalledTimes(2);

    await reader.of('hh-es');
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('is English when the read fails — a card is never held up, or lost, for its language — and asks again next time', async () => {
    const lines: Record<string, unknown>[] = [];
    let fail = true;
    const read = vi.fn(async () => {
      if (fail) throw Object.assign(new Error('no'), { name: 'AccessDeniedException' });
      return 'es' as HouseholdLanguage;
    });
    const reader = languageReader({ read, log: (line) => lines.push(line) });

    expect(await reader.of('hh-es')).toBe('en');
    expect(lines).toEqual([{ level: 'error', msg: 'household_language_unread', reason: 'AccessDeniedException' }]);

    fail = false;
    expect(await reader.of('hh-es')).toBe('es');
  });

  it('has no clock and no memory to configure: there is nothing to go stale', () => {
    expect(Object.keys(languageReader({ read: async () => 'en' as HouseholdLanguage }))).toEqual(['of']);
  });
});
