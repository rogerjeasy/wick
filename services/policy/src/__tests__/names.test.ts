import { describe, expect, it } from 'vitest';
import { clearForFamily, clearNameForFamily } from '../guardian.js';

const cleared = (text: string, people?: readonly string[]) => clearForFamily(text, undefined, people ? { people } : {}).cleared;

describe('a person whose name is also a word — the Guardian does not take a surname for a fact', () => {
  it('passes a title and a surname: Mrs Banks is a person, not her bank', () => {
    expect(cleared('Mrs Banks came at ten.')).toBe(true);
    expect(cleared('Mr. Cash rang the bell.')).toBe(true);
    expect(cleared('Ms Money is coming on Tuesday.')).toBe(true);
  });

  it('still refuses the money itself, and a title in lower case is not a title', () => {
    expect(cleared('Her bank rang about the pension.')).toBe(false);
    expect(cleared('She took out cash.')).toBe(false);
    expect(cleared('mrs banks')).toBe(false);
  });

  it("sets aside the household's own people by name, and their ids", () => {
    expect(cleared('Anna Cash came at 09:10.')).toBe(false);
    expect(cleared('Anna Cash came at 09:10.', ['Anna Cash'])).toBe(true);
    expect(cleared('anna-cash', ['Anna Cash'])).toBe(true);
    // Only the person, never the words around them.
    expect(cleared('Anna Cash brought her pension.', ['Anna Cash'])).toBe(false);
  });

  it('never sets aside a protected phrase that happens to be capitalised', () => {
    expect(cleared('Universal Credit came through.')).toBe(false);
    expect(cleared('The Council Tax is due.')).toBe(false);
  });
});

describe('clearNameForFamily — a name typed for a regular visitor', () => {
  it('takes the words after a first name as a surname', () => {
    expect(clearNameForFamily('Anna Cash')).toBe(true);
    expect(clearNameForFamily('Tom Banks')).toBe(true);
    expect(clearNameForFamily('Mrs Banks')).toBe(true);
    expect(clearNameForFamily('Maria')).toBe(true);
  });

  it('still refuses a name that says something protected', () => {
    expect(clearNameForFamily('the nurse')).toBe(false);
    expect(clearNameForFamily('Dr Patel')).toBe(false);
    expect(clearNameForFamily('Benefits Officer')).toBe(false);
    expect(clearNameForFamily('The Debt Collector')).toBe(false);
    expect(clearNameForFamily('Her Solicitor')).toBe(false);
  });
});
