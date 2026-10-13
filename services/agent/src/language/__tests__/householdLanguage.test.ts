import { describe, expect, it, vi } from 'vitest';
import { GetItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { HOUSEHOLD_LANGUAGE_ATTRS, type HouseholdLanguage } from '@wick/contracts';
import { loadHouseholdLanguage } from '../../store/household.js';
import { LANGUAGE_CACHE_MS, languageCache } from '../householdLanguage.js';

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

describe('languageCache — the language is read once a minute, not once a card', () => {
  const setup = (answers: Record<string, HouseholdLanguage> = { 'hh-es': 'es' }) => {
    let now = 1_000_000;
    const read = vi.fn(async (householdId: string, _options?: { consistent?: boolean }) => answers[householdId] ?? 'en');
    const cache = languageCache({ read, now: () => now, log: () => {} });
    return { cache, read, answers, pass: (ms: number) => { now += ms; } };
  };

  it('reads a household once and remembers it for sixty seconds', async () => {
    const { cache, read, pass } = setup();
    expect(LANGUAGE_CACHE_MS).toBe(60_000);

    expect(await cache.of('hh-es')).toBe('es');
    pass(59_999);
    expect(await cache.of('hh-es')).toBe('es');
    expect(read).toHaveBeenCalledTimes(1);

    pass(1);
    expect(await cache.of('hh-es')).toBe('es');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('remembers English too: an English household costs one read a minute and nothing else', async () => {
    const { cache, read } = setup();

    for (let i = 0; i < 5; i += 1) expect(await cache.of('hh-en')).toBe('en');

    expect(read).toHaveBeenCalledTimes(1);
  });

  it('keeps each household’s own', async () => {
    const { cache } = setup();

    expect(await cache.of('hh-es')).toBe('es');
    expect(await cache.of('hh-en')).toBe('en');
    expect(await cache.of('hh-es')).toBe('es');
  });

  it('makes one read of two sends that come at the same moment', async () => {
    const { cache, read } = setup();

    expect(await Promise.all([cache.of('hh-es'), cache.of('hh-es')])).toEqual(['es', 'es']);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('reads again at once when asked for what is so now, and remembers that', async () => {
    const { cache, read, answers } = setup();
    expect(await cache.of('hh-es')).toBe('es');

    answers['hh-es'] = 'en';
    expect(await cache.of('hh-es')).toBe('es');
    expect(await cache.of('hh-es', { fresh: true })).toBe('en');
    expect(read).toHaveBeenLastCalledWith('hh-es', { consistent: true });
    expect(await cache.of('hh-es')).toBe('en');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('never holds more than its cap: the household longest unread makes room', async () => {
    let now = 0;
    const read = vi.fn(async () => 'es' as HouseholdLanguage);
    const cache = languageCache({ read, now: () => now, max: 2, log: () => {} });

    await cache.of('a');
    await cache.of('b');
    await cache.of('c');
    expect(read).toHaveBeenCalledTimes(3);

    await cache.of('b');
    await cache.of('c');
    expect(read).toHaveBeenCalledTimes(3);
    await cache.of('a');
    expect(read).toHaveBeenCalledTimes(4);
    now += 1;
  });

  it('is English when the read fails — a card is never held up for its language — and asks again next time', async () => {
    const lines: Record<string, unknown>[] = [];
    let fail = true;
    const read = vi.fn(async () => {
      if (fail) throw Object.assign(new Error('no'), { name: 'AccessDeniedException' });
      return 'es' as HouseholdLanguage;
    });
    const cache = languageCache({ read, now: () => 0, log: (line) => lines.push(line) });

    expect(await cache.of('hh-es')).toBe('en');
    expect(lines).toEqual([{ level: 'error', msg: 'household_language_unread', reason: 'AccessDeniedException' }]);

    fail = false;
    expect(await cache.of('hh-es')).toBe('es');
  });
});
