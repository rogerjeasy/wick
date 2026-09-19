/**
 * INV-4 LIVES HERE.
 *
 * This runs on the household bridge, not in the cloud. It classifies Bee output
 * into FactClass and DROPS verbatim utterance content at the household boundary.
 * Cloud code must never be in a position to leak what it never received.
 *
 * Enforcing it here makes it one function. Enforcing it in the cloud would make
 * it an ongoing act of discipline.
 *
 * Why `raw.text` is safe to carry into `Fact.content`: `/v1/facts` and
 * `/v1/todos` are Bee's OWN derived summaries, not transcript. The thing INV-4
 * forbids is `/v1/conversations`' `utterances` field — this module has no
 * function that accepts a `BeeConversationRaw`, by construction, not by
 * discipline. Do not add one.
 *
 * Classification is deterministic keyword matching, not a model call — the
 * bridge is a small always-on household process (§7.2), and a rules-first
 * classifier here mirrors why the Guardian itself runs its deterministic half
 * first (§6.3). An unmatched fact defaults to RELATIONSHIP, the same
 * conservative choice the Guardian's own default policy table makes for
 * anything it cannot place: RELATIONSHIP is already `deny` to FAMILY, so a
 * fact this classifier cannot confidently place fails closed rather than
 * leaking by default.
 */
import type { Commitment, Fact, FactClass } from '@wick/contracts';
import type { BeeFactRaw, BeeTodoRaw } from './types.js';

const KEYWORDS: readonly { readonly class: FactClass; readonly words: readonly string[] }[] = [
  {
    class: 'HEALTH',
    words: [
      'knee', 'hip', 'back pain', 'ache', 'aching', 'sore', 'pain', 'surgery',
      'doctor', 'gp', 'hospital', 'nurse', 'medication', 'tablet', 'pills',
      'prescription', 'appointment', 'clinic', 'dizzy', 'fell', 'fall',
      'blood pressure', 'diabetes', 'heart',
    ],
  },
  {
    class: 'FINANCIAL',
    words: [
      'bank', 'money', 'bill', 'bills', 'pension', 'payment', 'invoice',
      'overdraft', 'savings', 'debt', 'scam', 'fraud', 'card declined',
    ],
  },
  {
    class: 'RELATIONSHIP',
    words: [
      'daughter', 'son', 'grandchild', 'grandson', 'granddaughter', 'husband',
      'wife', 'friend', 'neighbour', 'neighbor', 'family', 'argument',
      'upset', 'worried about',
    ],
  },
  {
    class: 'LOCATION',
    words: ['went to', 'travelling to', 'travelled to', 'address', 'moving to'],
  },
];

/** Exported so the Day agent's tests and this module's tests share one definition. */
export function classifyBeeText(text: string): FactClass {
  const lower = text.toLowerCase();
  for (const { class: cls, words } of KEYWORDS) {
    if (words.some((w) => lower.includes(w))) return cls;
  }
  return 'RELATIONSHIP'; // conservative default — see header.
}

const DEFAULT_CONFIDENCE = 0.75;

function toEpochMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

export function normaliseFact(raw: BeeFactRaw, householdId: string): Fact {
  return {
    id: `fact-${raw.id}`,
    householdId,
    class: classifyBeeText(raw.text),
    content: raw.text,
    sourceIds: [raw.conversationId ?? raw.id],
    observedAt: toEpochMs(raw.createdAt),
    confidence: raw.confidence ?? DEFAULT_CONFIDENCE,
  };
}

export function normaliseFacts(raws: readonly BeeFactRaw[], householdId: string): readonly Fact[] {
  return raws.map((raw) => normaliseFact(raw, householdId));
}

/** Every Bee todo is a COMMITMENT — that is the class the type exists for. */
export function normaliseTodo(raw: BeeTodoRaw, householdId: string): Commitment {
  return {
    id: `commitment-${raw.id}`,
    householdId,
    class: 'COMMITMENT',
    content: raw.text,
    sourceIds: [raw.conversationId ?? raw.id],
    observedAt: toEpochMs(raw.createdAt),
    confidence: DEFAULT_CONFIDENCE,
    ...(raw.dueAt !== undefined ? { dueAt: toEpochMs(raw.dueAt) } : {}),
  };
}

export function normaliseTodos(raws: readonly BeeTodoRaw[], householdId: string): readonly Commitment[] {
  return raws.map((raw) => normaliseTodo(raw, householdId));
}
