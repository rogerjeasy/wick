/**
 * Names in other scripts (foreign.ts): a household whose resident, carer or
 * daughter is written in Cyrillic, Greek, Han, Arabic or Hebrew must be able
 * to use Wick — and the gate must stay shut for everything else that is in
 * another script, because it cannot read it.
 */
import { describe, expect, it } from 'vitest';
import { clearForFamily, clearNameForFamily } from '../guardian.js';
import { isForeignNameWord } from '../foreign.js';

const cleared = (text: string, people?: readonly string[]) => clearForFamily(text, undefined, people ? { people } : {}).cleared;

const NAMES = ['Мария', 'Μαρία', '玛丽亚', 'ماريا', 'מרים', 'मारिया', '마리아', 'マリア', 'Анна-Мария', "О'Нил"];

describe('a name in another script', () => {
  it('is a name the household may keep', () => {
    for (const name of NAMES) expect(clearNameForFamily(name), name).toBe(true);
  });

  it('is a name with a Latin surname after it, too', () => {
    expect(clearNameForFamily('Мария Smith')).toBe(true);
    expect(clearNameForFamily('Анна Cash')).toBe(true); // "Cash" after a first name, as "Anna Cash"
    expect(clearNameForFamily('玛丽亚 Lopez')).toBe(true);
  });

  it('is cleared as a whole string, and as a sentence around it, when she is one of the household’s own people', () => {
    for (const name of NAMES) {
      expect(cleared(name, [name]), name).toBe(true);
      expect(cleared(`${name} visited.`, [name]), name).toBe(true);
      expect(cleared(`Someone came at 09:10: ${name}.`, [name]), name).toBe(true);
      expect(cleared(`${name}’s light is on.`, [name]), name).toBe(true);
    }
  });

  it('is cleared in a sentence with another of her words in it, wherever the name stands', () => {
    expect(cleared('Мария visited once, which is about usual. Анна asked.', ['Мария', 'Анна'])).toBe(true);
  });

  it('is found whatever its case, as the gate reads everything', () => {
    expect(cleared('МАРИЯ visited.', ['Мария'])).toBe(true);
  });

  it('sets aside only her words, and still reads the rest of the sentence', () => {
    expect(cleared('Мария brought her pension.', ['Мария'])).toBe(false);
    expect(cleared('Мария saw the doctor.', ['Мария'])).toBe(false);
    expect(cleared('Мария came after the divorce.', ['Мария'])).toBe(false);
    expect(cleared('Мария, 14 Elm Road, SW1A 1AA.', ['Мария'])).toBe(false);
  });
});

describe('what stays closed', () => {
  it('a sentence in another script, when the household has no such person', () => {
    expect(cleared('李医生来了')).toBe(false);
    expect(cleared('Мария visited.')).toBe(false);
    expect(cleared('Мария visited.', ['Анна'])).toBe(false);
    expect(cleared('Мария visited.', [])).toBe(false);
  });

  it('a word that is not one of her names, even with her name beside it', () => {
    expect(cleared('Мария врач', ['Мария'])).toBe(false);
    expect(cleared('Мария пришла', ['Мария'])).toBe(false);
    expect(cleared('Мария 医生', ['Мария'])).toBe(false);
  });

  it('a look-alike letter: Cyrillic in a Latin word is the trick, not a name', () => {
    expect(cleared('The dоctor came.')).toBe(false);
    expect(cleared('The dоctor came.', ['оctor'])).toBe(false);
    expect(clearNameForFamily('dоctor')).toBe(false);
    expect(clearNameForFamily('Мariа')).toBe(false); // Latin M, i, a among Cyrillic letters
    expect(isForeignNameWord('dоctor')).toBe(false);
  });

  it('a name hidden by an invisible character, or an emoji', () => {
    expect(clearNameForFamily('Мар​ия')).toBe(false);
    expect(clearNameForFamily('Мария 💊')).toBe(false);
    expect(cleared('Мар​ия visited.', ['Мар​ия'])).toBe(false);
  });

  it('a name that says doctor, nurse, hospital, medicine, bank, pension or debt in its own language', () => {
    const roles = ['врач', 'Доктор', 'медсестра', 'больница', 'аптека', 'банк', 'пенсия', 'γιατρός', 'νοσοκόμα', 'τράπεζα', '医生', '醫院', '护士', '银行', '退休金', 'طبيب', 'مستشفى', 'בנק', 'רופא', 'डॉक्टर', '의사', '병원', '医者', '薬'];
    for (const word of roles) {
      expect(clearNameForFamily(word), word).toBe(false);
      expect(clearNameForFamily(`Иван ${word}`), word).toBe(false);
      expect(cleared(`${word} visited.`, [word]), word).toBe(false);
      expect(cleared(`Someone visited: ${word}.`, [word]), word).toBe(false);
    }
  });

  it('a person whose name says doctor is not set aside, however it is spelt: nothing in her words is', () => {
    expect(cleared('李医生 visited.', ['李医生'])).toBe(false);
    expect(cleared('Доктор Иванов visited.', ['Доктор Иванов'])).toBe(false);
  });

  it('a Latin name is never set aside inside a sentence, as before', () => {
    expect(cleared('Anna Cash came at 09:10.', ['Anna Cash'])).toBe(false);
    expect(cleared('Anna Cash brought her pension.', ['Anna Cash'])).toBe(false);
  });

  it('a person who is not a vetted name sets nothing aside', () => {
    expect(cleared('Мария visited.', ['Мария врач'])).toBe(false);
  });

  it('half a word is not a name: her name inside a longer run of letters is not set aside', () => {
    expect(cleared('Мариям visited.', ['Мария'])).toBe(false);
    expect(cleared('Анна visited.', ['Ан'])).toBe(false);
  });

  it('a string made only of punctuation is not a name', () => {
    expect(isForeignNameWord("-'.")).toBe(false);
    expect(isForeignNameWord('')).toBe(false);
  });
});
