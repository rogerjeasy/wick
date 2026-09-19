import { describe, it, expect } from 'vitest';
import type { Fact } from '@wick/contracts';
import { buildFactItem, factRangeKeys, factSortKey, parseFactItem } from '../facts.js';

const fact: Fact = {
  id: 'fact-1',
  householdId: 'hh-1',
  class: 'HEALTH',
  content: 'mentioned her knee again',
  sourceIds: ['conv-1'],
  observedAt: Date.UTC(2026, 8, 15, 9, 0),
  confidence: 0.8,
};

describe('factSortKey', () => {
  it('is class-scoped and time-ordered', () => {
    expect(factSortKey(fact)).toBe(`FACT#HEALTH#${String(fact.observedAt).padStart(15, '0')}#fact-1`);
  });
});

describe('buildFactItem / parseFactItem', () => {
  it('round-trips a Fact through the DynamoDB item shape', () => {
    const item = buildFactItem('hh-1', fact);
    expect(item.pk?.S).toBe('HH#hh-1');
    expect(parseFactItem(item)).toEqual(fact);
  });

  it('returns undefined for an item with no data attribute', () => {
    expect(parseFactItem({ pk: { S: 'HH#hh-1' }, sk: { S: 'FACT#HEALTH#x' } })).toBeUndefined();
  });

  it('returns undefined for malformed JSON rather than throwing', () => {
    expect(parseFactItem({ data: { S: '{not json' } })).toBeUndefined();
  });
});

describe('factRangeKeys', () => {
  it('bounds a Query to one class and an exclusive-end time window', () => {
    const { from, to } = factRangeKeys('HEALTH', { startMs: 1000, endMs: 2000 });
    expect(from).toBe(`FACT#HEALTH#${String(1000).padStart(15, '0')}`);
    expect(to).toBe(`FACT#HEALTH#${String(1999).padStart(15, '0')}#￿`);
  });
});
