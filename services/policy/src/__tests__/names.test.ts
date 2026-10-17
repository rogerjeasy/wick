import { describe, expect, it } from 'vitest';
import { clearForFamily, clearNameForFamily } from '../guardian.js';

const cleared = (text: string, people?: readonly string[]) => clearForFamily(text, undefined, people ? { people } : {}).cleared;

describe('a person whose surname is also a word — the Guardian does not take her name for a fact', () => {
  it("passes the household's own person as her name, and as her id", () => {
    expect(cleared('Anna Cash')).toBe(false);
    expect(cleared('Anna Cash', ['Anna Cash'])).toBe(true);
    expect(cleared('anna-cash', ['Anna Cash'])).toBe(true);
    expect(cleared('Mrs Banks', ['Mrs Banks'])).toBe(true);
  });

  it('sets nothing aside inside a sentence: only a string that is exactly the name', () => {
    expect(cleared('Anna Cash came at 09:10.', ['Anna Cash'])).toBe(false);
    expect(cleared('Anna Cash brought her pension.', ['Anna Cash'])).toBe(false);
    expect(cleared('Mrs Banks came at ten.')).toBe(false);
    expect(cleared('Ms Cancer is coming on Tuesday.')).toBe(false);
  });

  it('sets aside only a name that is itself a vetted name: a member called "Pension", "Universal Credit" or "Council Tax" sets nothing aside', () => {
    for (const name of ['Pension', 'Cancer', 'Universal Credit', 'Council Tax', 'Pension Smith', 'Dr Who', 'Mrs Cancer', 'Power Attorney']) {
      expect(cleared(name, [name]), name).toBe(false);
    }
  });
});

describe('clearNameForFamily — a name typed for a regular visitor', () => {
  it('takes a known surname that is also a word, after a first name or a title', () => {
    for (const name of ['Anna Cash', 'Tom Banks', 'Mrs Banks', 'Mr Cash', 'Jo Money', 'Maria', 'Maria Lopez']) {
      expect(clearNameForFamily(name), name).toBe(true);
    }
  });

  it('still refuses a name that says something protected', () => {
    for (const name of ['the nurse', 'Dr Patel', 'Nurse Joy', 'Benefits Officer', 'The Debt Collector', 'Her Solicitor', 'Universal Credit', 'Council Tax', 'Mrs Cancer', 'Anna Pension', 'Power Attorney']) {
      expect(clearNameForFamily(name), name).toBe(false);
    }
  });
});
