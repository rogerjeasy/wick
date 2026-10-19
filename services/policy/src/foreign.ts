/**
 * Names in other scripts.
 *
 * The Guardian's lexicon is English, and it reads text folded to the letters
 * a–z. A letter outside them is a letter it cannot read, and it fails
 * closed (guardian.ts): that is what stops "dоctor" with a Cyrillic о, or a
 * sentence in a language it has no words for. It is also what made a
 * household whose resident, carer or daughter is written in Cyrillic, Greek,
 * Han, Arabic or Hebrew unusable: every sentence with her name in it was
 * withheld, so every answer was "Something went wrong".
 *
 * A name is not a sentence, and the household's own people are known. So
 * one thing is let through, and only one: a WORD that is wholly letters of
 * one other script, and says nothing a short list of that script's words for
 * doctors, hospitals, medicine, banks and debts would catch, may stand as a
 * name — in a person's name (clearNameForFamily), and, where the household's
 * own people are given, in a sentence (guardian.ts maskNames). Anything else
 * in another script is as unreadable as it was; and a word with letters of
 * two scripts is the look-alike trick, and stays unreadable too.
 *
 * What this cannot do, and does not claim to: read those scripts. The list
 * below is a best effort at the commonest words, written by hand and
 * reviewed like the English one, not a lexicon of Russian or Chinese. The
 * names it admits are ones the household's own members typed, for people
 * in their own circle; what it keeps out is the resident's protected facts
 * leaving by way of a name.
 */

/** One writing system, or the group Japanese writes with. */
interface Script {
  readonly name: string;
  /** Tests one character that is a letter or a mark. */
  readonly letter: RegExp;
  /** How a role word is looked for: the start of the word, or anywhere in it (scripts that do not separate or inflect by ending). */
  readonly find: 'start' | 'anywhere';
  readonly health: readonly string[];
  readonly money: readonly string[];
}

const SCRIPTS: readonly Script[] = [
  {
    name: 'Cyrillic',
    letter: /[\p{Script=Cyrillic}\p{M}]/u,
    find: 'start',
    health: ['врач', 'доктор', 'медсестр', 'медбрат', 'фельдшер', 'больниц', 'госпитал', 'поликлиник', 'клиник', 'аптек', 'лекарств', 'таблетк', 'диагноз', 'болезн', 'терапевт', 'хирург', 'стоматолог', 'лікар', 'лікарн', 'ліки'],
    money: ['банк', 'пенси', 'долг', 'кредит', 'налог', 'ипотек', 'задолженност', 'зарплат', 'борг', 'податок'],
  },
  {
    name: 'Greek',
    letter: /[\p{Script=Greek}\p{M}]/u,
    find: 'start',
    health: ['γιατρ', 'νοσοκόμ', 'νοσοκομ', 'φαρμακ', 'φάρμακ', 'κλινικ', 'νοσηλ'],
    money: ['τράπεζ', 'τραπεζ', 'σύνταξ', 'συνταξ', 'χρέο', 'χρέη', 'χρεη', 'δάνει', 'δανει', 'φόρο'],
  },
  {
    name: 'Armenian',
    letter: /[\p{Script=Armenian}\p{M}]/u,
    find: 'start',
    health: ['բժիշկ', 'հիվանդանոց', 'դեղ'],
    money: ['բանկ', 'կենսաթոշակ', 'պարտք'],
  },
  {
    name: 'Georgian',
    letter: /[\p{Script=Georgian}\p{M}]/u,
    find: 'start',
    health: ['ექიმ', 'საავადმყოფო', 'მედდა'],
    money: ['ბანკ', 'პენსი', 'ვალ'],
  },
  {
    name: 'Hebrew',
    letter: /[\p{Script=Hebrew}\p{M}]/u,
    find: 'anywhere',
    health: ['רופא', 'אחות', 'חולים', 'תרופ', 'מרפאה', 'רפוא'],
    money: ['בנק', 'פנסי', 'חוב', 'משכנתא'],
  },
  {
    name: 'Arabic',
    letter: /[\p{Script=Arabic}\p{M}]/u,
    find: 'anywhere',
    health: ['طبيب', 'دكتور', 'ممرض', 'مستشفى', 'دواء', 'صيدلي', 'عيادة', 'طبي'],
    money: ['بنك', 'معاش', 'دين', 'قرض', 'ضريب'],
  },
  {
    name: 'Devanagari',
    letter: /[\p{Script=Devanagari}\p{M}]/u,
    find: 'anywhere',
    health: ['डॉक्टर', 'चिकित्सक', 'अस्पताल', 'दवा', 'नर्स', 'वैद्य'],
    money: ['बैंक', 'पेंशन', 'कर्ज', 'ऋण'],
  },
  {
    name: 'Bengali',
    letter: /[\p{Script=Bengali}\p{M}]/u,
    find: 'anywhere',
    health: ['ডাক্তার', 'হাসপাতাল', 'ওষুধ', 'নার্স'],
    money: ['ব্যাংক', 'পেনশন', 'ঋণ'],
  },
  {
    name: 'Tamil',
    letter: /[\p{Script=Tamil}\p{M}]/u,
    find: 'anywhere',
    health: ['மருத்துவ', 'செவிலிய'],
    money: ['வங்கி', 'ஓய்வூதிய', 'கடன்'],
  },
  {
    name: 'Thai',
    letter: /[\p{Script=Thai}\p{M}]/u,
    find: 'anywhere',
    health: ['หมอ', 'แพทย์', 'พยาบาล', 'โรงพยาบาล', 'ยา', 'ป่วย'],
    money: ['ธนาคาร', 'เงินบำนาญ', 'หนี้'],
  },
  {
    name: 'Hangul',
    letter: /[\p{Script=Hangul}\p{M}]/u,
    find: 'anywhere',
    health: ['의사', '병원', '간호', '약국', '처방', '질병', '환자'],
    money: ['은행', '연금', '대출', '세금', '빚'],
  },
  {
    name: 'CJK',
    // Han, and the two kana Japanese is written with, with the long-vowel mark and the iteration mark.
    letter: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}ー々\p{M}]/u,
    find: 'anywhere',
    health: ['医生', '醫生', '医师', '醫師', '医院', '醫院', '护士', '護士', '药', '藥', '病', '诊所', '診所', '医者', '看護', '医療', '醫療', '医', '薬', '癌', '診', '療'],
    money: ['银行', '銀行', '退休金', '养老金', '養老金', '债', '債', '贷款', '貸款', '税', '稅', '年金', '借金', 'ローン', '金'],
  },
];

/** What a word may hold besides its letters and marks: a hyphen, an apostrophe, a full stop, as names do. */
const NAME_PUNCTUATION = /['’\-.]/gu;

/** The script a word is wholly written in, or undefined: not one other script, or letters of two (the look-alike trick). */
function scriptOf(word: string): Script | undefined {
  const letters = word.normalize('NFKC').replace(NAME_PUNCTUATION, '');
  if (letters === '') return undefined;
  return SCRIPTS.find((script) => [...letters].every((char) => script.letter.test(char)));
}

function says(script: Script, word: string): boolean {
  const lower = word.normalize('NFKC').toLowerCase();
  const found = (stem: string): boolean => (script.find === 'start' ? lower.startsWith(stem) : lower.includes(stem));
  return script.health.some(found) || script.money.some(found);
}

/**
 * Whether a word may stand as a name: wholly one other script, and saying
 * nothing of a clinician, a hospital, medicine, a bank or a debt. A word of
 * the letters a–z is not this function's: it is read as it always was.
 */
export function isForeignNameWord(word: string): boolean {
  const script = scriptOf(word);
  return script !== undefined && !says(script, word);
}
