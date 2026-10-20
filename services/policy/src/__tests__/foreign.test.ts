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

/** The Unicode script name of a role word's first letter, for telling its own marks from another script's. */
function scriptNameOf(word: string): string {
  const names = ['Cyrillic', 'Greek', 'Armenian', 'Georgian', 'Hebrew', 'Arabic', 'Devanagari', 'Bengali', 'Tamil', 'Thai', 'Hangul', 'Han', 'Katakana'];
  const first = [...word][0] ?? '';
  return names.find((name) => new RegExp(`^\\p{Script=${name}}$`, 'u').test(first)) ?? 'Latin';
}

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

  it('a role word is not a name for having a mark or a hyphen inside it, or a name word beside it', () => {
    const dressed = ['до\u0301ктор', 'док-тор', "док'тор", 'до.ктор', 'бан\u0301к', 'γιά\u0301τρος', 'Иван-доктор', 'Мария-врач', 'Анна.банк'];
    for (const word of dressed) {
      expect(isForeignNameWord(word), word).toBe(false);
      expect(clearNameForFamily(word), word).toBe(false);
      expect(cleared(`${word} visited.`, [word]), word).toBe(false);
    }
  });

  it('a role word is not a name for any mark of its own script, or any generic combining mark, put inside it', () => {
    // Every mark Unicode has, so a range nobody listed cannot be the way through.
    const generic = /^\p{M}$/u;
    const cases: Array<[string, RegExp]> = [
      ['доктор', /^[\p{Script=Inherited}\p{Script=Cyrillic}]$/u],
      ['γιατρός', /^[\p{Script=Inherited}\p{Script=Greek}]$/u],
      ['רופא', /^[\p{Script=Inherited}\p{Script=Hebrew}]$/u],
      ['طبيب', /^[\p{Script=Inherited}\p{Script=Arabic}]$/u],
      ['բժիշկ', /^[\p{Script=Inherited}\p{Script=Armenian}]$/u],
      ['ექიმ', /^[\p{Script=Inherited}\p{Script=Georgian}]$/u],
      ['의사', /^[\p{Script=Inherited}\p{Script=Hangul}]$/u],
      ['医生', /^[\p{Script=Inherited}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u],
    ];
    for (const [word, family] of cases) {
      const stray: string[] = [];
      for (let code = 0x300; code < 0x20000; code += 1) {
        const mark = String.fromCodePoint(code);
        if (!generic.test(mark) || !family.test(mark)) continue;
        const cut = [...word].length > 2 ? 2 : 1;
        const dressed = [...word].slice(0, cut).join('') + mark + [...word].slice(cut).join('');
        if (isForeignNameWord(dressed)) stray.push(`U+${code.toString(16).toUpperCase()}`);
      }
      expect(stray, word).toEqual([]);
    }
    for (const mark of ['\uFE00', '\u1DC4', '\u20DD']) {
      expect(isForeignNameWord(`до${mark}ктор`), mark).toBe(false);
    }
  });

  it('a role word is not a name for any mark of any script put inside it: a mark of another script is not the word\'s own', () => {
    const roles = ['доктор', 'γιατρός', 'բժիշկ', 'ექიმ', 'רופא', 'طبيب', 'डॉक्टर', 'ডাক্তার', 'மருத்துவ', 'หมอ', '의사', '医生', 'ローン'];
    const stray: string[] = [];
    for (let code = 0x300; code < 0x20000; code += 1) {
      const mark = String.fromCodePoint(code);
      if (!/^\p{M}$/u.test(mark)) continue;
      for (const word of roles) {
        const letters = [...word];
        const dressed = letters.slice(0, 1).join('') + mark + letters.slice(1).join('');
        // A word's own script's marks are letters of it (an Indic vowel sign), so only a mark of some other script, or a generic one, must close it.
        const own = new RegExp(`^\\p{Script=${scriptNameOf(word)}}$`, 'u').test(mark);
        if (!own && isForeignNameWord(dressed)) stray.push(`${word} U+${code.toString(16).toUpperCase()}`);
      }
    }
    expect(stray).toEqual([]);
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
