import { describe, it, expect } from 'vitest';
import { classifyBeeText, normaliseFact, normaliseFacts, normaliseTodo } from '../normalise.js';
import type { BeeFactRaw, BeeTodoRaw } from '../types.js';

describe('classifyBeeText', () => {
  it('classifies a wellbeing mention as HEALTH', () => {
    expect(classifyBeeText("her knee's been bad again")).toBe('HEALTH');
  });

  it('classifies a money mention as FINANCIAL', () => {
    expect(classifyBeeText('the bank called about an overdraft')).toBe('FINANCIAL');
  });

  it('classifies a family mention as RELATIONSHIP', () => {
    expect(classifyBeeText('her daughter is visiting Sunday')).toBe('RELATIONSHIP');
  });

  it('falls back to RELATIONSHIP — the fail-closed default — for anything unmatched', () => {
    expect(classifyBeeText('the weather has been lovely')).toBe('RELATIONSHIP');
  });
});

describe('normaliseFact', () => {
  const raw: BeeFactRaw = {
    id: 'f1',
    text: 'mentioned her knee again this morning',
    confidence: 0.9,
    createdAt: '2026-09-15T09:00:00.000Z',
    conversationId: 'conv-1',
  };

  it('carries Bee\'s own derived text as Fact.content — never a transcript', () => {
    const fact = normaliseFact(raw, 'hh-1');
    expect(fact.content).toBe(raw.text);
    expect(fact.class).toBe('HEALTH');
    expect(fact.confidence).toBe(0.9);
    expect(fact.householdId).toBe('hh-1');
    expect(fact.sourceIds).toEqual(['conv-1']);
    expect(fact.observedAt).toBe(Date.parse(raw.createdAt));
  });

  it('defaults confidence when Bee does not supply one', () => {
    const { confidence: _omit, ...rest } = raw;
    const fact = normaliseFact(rest as BeeFactRaw, 'hh-1');
    expect(fact.confidence).toBeGreaterThan(0);
    expect(fact.confidence).toBeLessThanOrEqual(1);
  });

  it('falls back to the fact id as its own source when Bee gives no conversationId', () => {
    const { conversationId: _omit, ...rest } = raw;
    const fact = normaliseFact(rest as BeeFactRaw, 'hh-1');
    expect(fact.sourceIds).toEqual(['f1']);
  });

  it('normaliseFacts maps a whole list', () => {
    expect(normaliseFacts([raw, { ...raw, id: 'f2' }], 'hh-1')).toHaveLength(2);
  });
});

describe('normaliseTodo', () => {
  const raw: BeeTodoRaw = {
    id: 't1',
    text: 'call the surgery about Thursday',
    createdAt: '2026-09-15T11:30:00.000Z',
    dueAt: '2026-09-17T09:00:00.000Z',
    conversationId: 'conv-2',
  };

  it('is always classed COMMITMENT — the class the type exists for', () => {
    const commitment = normaliseTodo(raw, 'hh-1');
    expect(commitment.class).toBe('COMMITMENT');
    expect(commitment.content).toBe(raw.text);
    expect(commitment.dueAt).toBe(Date.parse(raw.dueAt as string));
  });

  it('omits dueAt entirely when Bee gives none, rather than a fabricated 0', () => {
    const { dueAt: _omit, ...rest } = raw;
    const commitment = normaliseTodo(rest as BeeTodoRaw, 'hh-1');
    expect(commitment.dueAt).toBeUndefined();
  });
});
