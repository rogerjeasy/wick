/**
 * The Guardian's lexicon: the words and shapes that mark a sentence as
 * being about health, money, relationships or where someone is.
 *
 * Hand-written and reviewed, never learned. A model may not decide what
 * counts as protected: the thing being guarded against is a model (the door's
 * vision model, the Narrator, the family app's assistant) saying it.
 *
 * Every pattern runs over text `normalise` (guardian.ts) has already made
 * lower case, plain ASCII letters, with typographic quotes and dashes
 * straightened. So `\b` means a word's edge, and "Dr", "dr." and "DR" are
 * one word.
 *
 * What this catches is what it lists. "How was Tuesday at St Mary's?" names
 * no word here and passes. Add to a list when a real sentence slips through,
 * with a test that it is caught — and a test for the ordinary sentence the
 * new word must not catch.
 *
 * Deliberately left out, because the product shares them by design or
 * because they are far more often something else:
 *   - "carer", "care": who comes to help is PRESENCE, and the family
 *     arranges it (did_visitor_come, get_visits).
 *   - "bill", "will", "penny", "grace": first names, and a modal verb.
 *   - "tablet", "scan", "account", "date", "heart", "blind", "cold",
 *     "temperature", "paid": a door camera sees a courier's tablet and a
 *     parcel being scanned far more often than either is medical.
 *   - mum, dad, son, daughter, friend: the family itself.
 */
import type { FactClass } from '@wick/contracts';

/** The classes the lexicon can find. All four are in NEVER_TO_FAMILY. VERBATIM has no lexicon: see guardian.ts. */
export type ListedClass = Extract<FactClass, 'HEALTH' | 'FINANCIAL' | 'RELATIONSHIP' | 'LOCATION'>;

export interface Marker {
  readonly class: ListedClass;
  /** Over normalised text. */
  readonly pattern: RegExp;
  /** Phrases this entry must catch, as a person would write them. The tests are drawn from these. */
  readonly examples: readonly string[];
}

const words = (alternatives: readonly string[]): string => alternatives.join('|');

export const LEXICON: readonly Marker[] = [
  {
    class: 'HEALTH',
    // A clinician by title or role. "Doctor Who" is a programme.
    pattern: new RegExp(`\\b(${words([
      'doctor(?! who\\b)s?', 'drs?', 'gp', 'g\\.p', 'physicians?', 'surgeons?', 'nurses?', 'nursing', 'midwi(?:fe|ves)',
      'paramedics?', 'physio(?:therapists?)?s?', 'therapists?', 'psychiatrists?', 'psychologists?', 'counsell?ors?',
      'dentists?', 'dental', 'opticians?', 'pharmacists?', 'chemists?', 'podiatrists?', 'chiropodists?', 'medics?',
      'health visitors?',
    ])})\\b`),
    examples: ['Dr Patel', 'the doctor', 'Doctor Khan', 'GP', 'a nurse', 'the district nurse', 'paramedics', 'her physio', 'the dentist', 'the chemist'],
  },
  {
    class: 'HEALTH',
    // Where care is given. "Ward" is a surname and "ward off" a verb, so it is not here.
    pattern: new RegExp(`\\b(${words([
      'hospitals?', 'clinics?', 'surgery', 'surgeries', 'a ?& ?e', 'a and e', 'emergency room', 'hospices?', 'pharmac(?:y|ies)',
      'ambulances?', 'nhs',
    ])})\\b`),
    examples: ['the hospital', 'the clinic', 'the surgery', 'A&E', 'an ambulance', 'the pharmacy', 'NHS'],
  },
  {
    class: 'HEALTH',
    // Treatment, and what is used for it.
    pattern: new RegExp(`\\b(${words([
      'medications?', 'medicines?', 'medical', 'meds', 'pills?', 'prescriptions?', 'prescribed', 'doses?', 'dosage',
      'insulin', 'inhalers?', 'injections?', 'jabs?', 'vaccin\\w*', 'antibiotics?', 'painkillers?', 'paracetamol',
      'ibuprofen', 'aspirin', 'morphine', 'statins?', 'warfarin', 'chemo\\w*', 'radiotherapy', 'dialysis',
      'blood tests?', 'blood pressure', 'mri', 'x-?rays?', 'ultrasound', 'biops(?:y|ies)', 'operations?',
      'treatments?', 'therapy', 'rehab\\w*', 'wheelchairs?', 'zimmer', 'walking frames?', 'crutch(?:es)?',
      'hearing aids?', 'dentures?', 'catheters?', 'bandages?', 'plaster casts?', 'health\\w*', 'first aid',
    ])})\\b`),
    examples: ['medication', 'a medication box', 'her pills', 'a prescription', 'insulin', 'the flu jab', 'blood pressure', 'an X-ray', 'an operation', 'a wheelchair', 'her health'],
  },
  {
    class: 'HEALTH',
    // Being unwell, and dying. "I'll" is not "ill": an apostrophe before it is a contraction.
    pattern: new RegExp(`(?<!')\\b(${words([
      'ill', 'illness(?:es)?', 'unwell', 'sick(?:ness)?', 'poorly', 'pain(?:s|ful)?', 'aches?', 'aching', 'hurts?',
      'hurting', 'injur(?:y|ies|ed)', 'fractur\\w*', 'broken (?:hip|arm|leg|wrist|ankle|bone)s?', 'sprain\\w*',
      'had a fall', 'a nasty fall', 'took a fall', 'fell over', 'heart (?:attack|condition|problems?|failure)', 'cardiac',
      'strokes?(?! of (?:luck|genius|inspiration|brilliance|good fortune|midnight)\\b)', 'cancer\\w*', 'tumou?rs?', 'dementia', 'alzheimer\\w*', 'parkinson\\w*', 'diabet\\w*',
      'arthritis', 'asthma', 'copd', 'pneumonia', 'infections?', 'infected', 'flu', 'covid\\w*', 'fever',
      'bleed\\w*', 'dizz\\w*', 'faint(?:ed|ing)', 'memory loss', 'incontinen\\w*', 'depress(?:ed|ion)', 'anxiety',
      'diagnos\\w*', 'symptoms?', 'recover(?:y|ing)', 'cough\\w*', 'deaf', 'died', 'death', 'dying', 'passed away',
      'palliative', 'end of life',
    ])})\\b`),
    examples: ['she is ill', 'unwell', 'in pain', 'her back aches', 'she had a fall', 'a stroke', 'dementia', 'diabetes', 'an infection', 'passed away', 'she died'],
  },
  {
    class: 'HEALTH',
    // The parts of the body a family asks after. "Hip-hop" is music.
    pattern: /\b(hips?(?![- ]?hop\b)|knees?)\b/,
    examples: ['her hip', 'Is your hip still bad?', 'his knee'],
  },
  {
    class: 'FINANCIAL',
    // Money, and where it comes from. "Bank Holiday" is a day off.
    pattern: new RegExp(`\\b(${words([
      'money', 'cash', 'pensions?', 'pensioners?', 'benefits', 'universal credit', 'allowances?', 'dwp', 'hmrc',
      'tax(?:es)?', 'banks?(?! holidays?\\b)', 'banking', 'bankers?', 'sort codes?', 'pin (?:number|code)s?',
      'card details', 'credit cards?', 'debit cards?', 'bills', '(?:gas|electric|electricity|energy|phone|water|council) bills?',
      'the bill', 'debts?', 'owe[sd]?', 'owing', 'loans?', 'mortgages?', 'rent', 'savings', 'inherit\\w*',
      'power of attorney', 'attorney', 'solicitors?', 'insurance', 'invoices?', 'payments?', 'salary', 'wages',
      'income', 'overdra\\w*', 'scam\\w*', 'fraud\\w*', 'lottery', 'gambl\\w*', 'betting', 'cheques?', 'atm',
      'cash machine', 'investments?', 'finances?', 'financial', '(?:her|his) will', 'pounds', 'quid', 'dollars',
      'euros', 'pence',
    ])})\\b`),
    examples: ['the pension', 'Did the pension come?', 'her bank', 'benefits', 'money', 'the gas bill', 'a debt', 'the rent', 'her savings', 'a PIN number', 'fifty pounds'],
  },
  {
    class: 'FINANCIAL',
    // An amount: "£40", "$ 12.50", "€5".
    pattern: /[£$€] ?\d/,
    examples: ['£40', '$12.50', '€ 5'],
  },
  {
    class: 'RELATIONSHIP',
    pattern: new RegExp(`\\b(${words([
      'boyfriends?', 'girlfriends?', 'partners?', 'husbands?', 'wi(?:fe|ves)', 'spouses?', 'divorc\\w*', 'separated',
      'separation', 'married', 'marriage', 'weddings?', 'affairs?', 'dating', 'romance', 'romantic', 'lovers?',
      'sweethearts?', 'fiancee?s?', 'relationships?', 'falling out', 'fell out', 'fallen out', 'quarrel\\w*',
      'estranged', 'not speaking', 'widow\\w*', 'bereave\\w*', 'funerals?', 'ex-?husband', 'ex-?wife', 'in love',
    ])})\\b`),
    examples: ['her boyfriend', 'his wife', 'the divorce', 'an affair', 'they fell out', 'a widow', 'the funeral', 'her partner'],
  },
  {
    class: 'LOCATION',
    // A house number and a street: "14 Elm Road", "3a Mill Lane". One or two words of name, so "2 men walking down the road" is not one.
    pattern: /\b\d+[a-z]?,? [a-z][a-z'-]*(?: [a-z][a-z'-]*)? (?:street|st|road|rd|avenue|ave|lane|ln|close|drive|way|crescent|court|ct|place|gardens|grove|terrace|square|row|mews|hill|park|boulevard|blvd)\b/,
    examples: ['14 Elm Road', '3a Mill Lane', '221b Baker Street'],
  },
  {
    class: 'LOCATION',
    // A British postcode: "SW1A 1AA", "M1 1AE".
    pattern: /\b[a-z]{1,2}\d[a-z\d]? ?\d[a-z]{2}\b/,
    examples: ['SW1A 1AA', 'M1 1AE', 'EH8 9YL'],
  },
  {
    class: 'LOCATION',
    // A place on a map, a flat's number, and the words for where someone is.
    pattern: new RegExp(`(-?\\d{1,3}\\.\\d{3,}, ?-?\\d{1,3}\\.\\d{3,})|\\b(${words([
      '(?:flat|apartment|apt|unit) \\d+\\w?', 'post ?codes?', 'zip codes?', 'home address', 'address is', 'lives at',
      'gps', 'coordinates', 'whereabouts', 'location',
    ])})\\b`),
    examples: ['51.5072, -0.1276', 'Flat 3', 'her postcode', 'the home address', 'GPS', 'her whereabouts'],
  },
];
