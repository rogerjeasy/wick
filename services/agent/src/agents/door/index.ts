/**
 * Door agent — two-phase emission. This is the key latency decision.
 *
 *   Phase 1  (<= 900ms from webhook)  line + actions, on screen immediately
 *   Phase 2a (when the image lands)   imageRef patches in
 *   Phase 2b (<= 2200ms, cancel 2500) description patches in
 *
 * A single-shot card that waits for vision blows the 3s budget whenever Bedrock
 * is slow. A late description is worse than none — the resident has already
 * decided. If Phase 2 times out the card simply stays as Phase 1, which is still
 * better than any competitor.
 *
 * The image moved out of Phase 1 for a measured reason: Ring's image retrieval
 * takes ~3.15s end to end (FL-005, SP-2). The design assumed a live snapshot;
 * there is no such call. So Phase 1 is text and buttons, and the picture is a
 * patch like everything else.
 *
 * See docs/WICK-TECHNICAL.md §5.1, §5.2, §9.1.
 */
import { createHash } from 'node:crypto';
import {
  DOOR_ACTIONS,
  MAX_CARD_ACTIONS,
  errandIdOf,
  type CardAction,
  type CardPatch,
  type DoorCard,
  type RosterEntry,
} from '@wick/contracts';
import { classify } from '@wick/policy';
import type { RingDevice, RingHistoryEvent, RingImage } from '@wick/ring';
import { matchVisitor } from './roster.js';

/** Plain English, always the same, never "motion detected". docs/WICK.md §4.2. */
export const DOOR_LINE = "Someone's at the front door.";

/**
 * Phase 1 says someone is there before anyone has seen the frame. When the
 * frame then shows nobody, the headline is corrected rather than left
 * contradicting the description beneath it (observed on the VVD: "Three
 * cars parked in a parking lot." under "Someone's at the front door.").
 * After a press the ring itself is certain even if nobody is in view.
 */
export const NOBODY_AFTER_MOTION_LINE = 'Movement at the front door.';
export const NOBODY_AFTER_RING_LINE = 'The doorbell rang.';


export const DESCRIPTION_MAX_WORDS = 14;

/**
 * Words that mark a claim about intent, mood or likelihood rather than an
 * observation. A vision model reaches for these constantly, and every one of
 * them turns a description into a judgement about a stranger at someone's door.
 */
const SPECULATION = [
  'seems', 'seem', 'appears', 'appear', 'probably', 'possibly', 'maybe',
  'might', 'may', 'could', 'likely', 'apparently', 'presumably', 'looks like',
  'trying', 'wants', 'waiting for', 'intends', 'suspicious', 'angry', 'happy',
  'nervous', 'friendly', 'aggressive',
];

export interface DoorCardInput {
  readonly event: RingHistoryEvent;
  readonly device: RingDevice;
  /** Spec §4.2: a playable Ring Chime exists in the household (from the cached device list). */
  readonly hallwayChime: boolean;
  readonly householdId: string;
  readonly correlationId: string;
  readonly now: number;
  /** The household's clock: a regular visitor's "09:00" is read on it (roster.ts matchVisitor). */
  readonly timeZone: string;
  /** M4. Omitted (not just empty) is the common case — most households haven't curated one yet. */
  readonly roster?: readonly RosterEntry[];
  /**
   * The names of the people the resident has allowed into the family circle
   * (INV-9) — the only people a door picture can be put in front of. Omitted
   * or empty: nobody to ask.
   */
  readonly family?: readonly string[];
  /**
   * A demo home's stand-in doorbell (agents/door/demoDoor.ts): the card says
   * so, and offers nothing that needs a real doorbell — no live view (there
   * is no camera) and no chime.
   */
  readonly standIn?: boolean;
  /**
   * Ring did not answer when the card was made (route.ts): she is still told
   * someone is at the door, and offered nothing that needs Ring to work —
   * no live view and no chime, which would fail when pressed (D6).
   */
  readonly ringUnanswered?: boolean;
}

/**
 * Under "This looks like the plumber", for a visitor the family arranged
 * (contracts errand.ts): who arranged it, by the name the resident allowed.
 * It says who said they were coming, not who is there.
 */
export const arrangedThisVisit = (name: string): string => `${name.trim().split(/\s+/)[0] || name} arranged this visit.`;

/** The longest first name that still fits a button in 32pt type beside two others. */
const MAX_NAME_ON_BUTTON = 12;

/**
 * Who the resident would be asking, in the words a button and a notice can
 * carry: one person's first name, or "the family" when several could answer
 * or the name would not fit. Undefined when there is nobody to ask.
 */
export function familyToAsk(family: readonly string[] | undefined): string | undefined {
  if (!family || family.length === 0) return undefined;
  const first = family.length === 1 ? family[0]!.trim().split(/\s+/)[0] : undefined;
  return first && first.length <= MAX_NAME_ON_BUTTON ? first : 'the family';
}

/**
 * The three buttons — minus any the household cannot actually do.
 *
 * The middle one is for a second opinion. When nobody is expected and the
 * resident has allowed someone into the family circle, it asks that person
 * to look at the picture (askFamily.ts): the resident has no telephone in
 * their hand, a stranger is on the step, and the person they would ring is
 * one press away. For a visitor the household expects there is nothing to
 * ask.
 *
 * Otherwise it rings the hallway chime: Ring's API can play audio only on a
 * Chime, an indoor speaker, so it tells the rest of the house, not the visitor
 * (spec D1). It is only offered when a playable chime exists; a button that
 * fails when pressed is worse than one that was never there (D6).
 *
 * Never both. Three, never four (Principle 6), and when a stranger is at the
 * door someone who can look matters more than a sound in the hall.
 */
function actionsFor(hallwayChime: boolean, ask: string | undefined, standIn = false, ringUnanswered = false): readonly CardAction[] {
  // A stand-in doorbell has no camera to watch and no chime to ring, and a
  // Ring that is not answering cannot open either: a button that cannot work
  // is worse than none (D6).
  const noRing = standIn || ringUnanswered;
  const actions: CardAction[] = noRing ? [] : [{ id: DOOR_ACTIONS.watchLive, label: 'Watch live', kind: 'primary' }];

  if (ask) {
    actions.push({ id: DOOR_ACTIONS.askFamily, label: `Ask ${ask} to look`, kind: 'secondary' });
  } else if (hallwayChime && !noRing) {
    actions.push({ id: DOOR_ACTIONS.hallwayChime, label: 'Ring the hallway chime', kind: 'secondary' });
  }

  // There is always a way out, and it is always last.
  actions.push({ id: DOOR_ACTIONS.dismiss, label: 'Not now', kind: 'dismiss' });

  return actions.slice(0, MAX_CARD_ACTIONS);
}

/**
 * A short, stable card id.
 *
 * Ring event ids are ~100 characters of opaque base32. Carrying one verbatim
 * would put it in the card id, the patch, every log line and the device
 * payload, four times over. Hashing keeps it derived-from-the-event — so a
 * redelivered webhook still rebuilds the same card (INV-6) — without the bulk.
 */
function cardIdFor(eventId: string): string {
  return `door-${createHash('sha256').update(eventId).digest('base64url').slice(0, 12)}`;
}

/**
 * Phase 1. Everything here is local — no Ring call, no model call — so it is
 * bounded by nothing but the webhook itself.
 *
 * The id is derived from the Ring event id so that a redelivered webhook
 * rebuilds the same card rather than stacking a second one on the television
 * (INV-6: idempotent and correlated).
 */
export function buildPhaseOneCard(input: DoorCardInput): DoorCard {
  const { event, hallwayChime, householdId, correlationId, now, timeZone, roster, family, standIn = false, ringUnanswered = false } = input;
  const match = roster ? matchVisitor(roster, event.start, timeZone) : undefined;
  // A visitor an errand expects: the entry carries the name of the member who arranged it.
  const arrangedBy = match && errandIdOf(match.personId) ? roster?.find((person) => person.personId === match.personId)?.arrangedByName : undefined;

  return {
    type: 'DOOR',
    id: cardIdFor(event.id),
    householdId,
    correlationId,
    createdAt: now,
    line: DOOR_LINE,
    actions: actionsFor(hallwayChime, match ? undefined : familyToAsk(family), standIn, ringUnanswered),
    // A demo home's stand-in doorbell is said in a label of its own on her television, never in her sentence.
    ...(standIn ? { standIn: true as const } : {}),
    ...(match ? { match } : {}),
    ...(arrangedBy ? { notice: arrangedThisVisit(arrangedBy) } : {}),
  };
}

/**
 * Is this a description we are willing to put on someone's television?
 *
 * Deliberately a validator and not only a prompt instruction. A prompt is a
 * request; this is the thing that actually holds when the model ignores it —
 * and a visitor's clothing or signage is untrusted text entering a vision
 * prompt, so it will be ignored eventually.
 */
/**
 * How a description may begin: as a description of what is in the frame —
 * "A man …", "An empty porch …", "Two people …", "Nobody …". An instruction
 * ("Open the door now."), a claim about a named person ("Margaret has
 * cancer.") or an answer to someone ("Yes, …") cannot start this way.
 */
const OPENERS: ReadonlySet<string> = new Set([
  // Articles, numbers and who is there.
  'a', 'an', 'the', 'one', 'two', 'three', 'four', 'five', 'six', 'several', 'some', 'many', 'few',
  'someone', 'somebody', 'nobody', 'no', 'nothing', 'people', 'empty', 'movement',
  // What a frame is mostly of, at a door, day or night.
  'bright', 'dark', 'dim', 'light', 'lights', 'headlights', 'shadow', 'shadows', 'sunlight', 'darkness',
  'rain', 'snow', 'fog', 'mist', 'smoke', 'leaves', 'trees', 'grass', 'flowers', 'plants',
  'cars', 'car', 'van', 'vans', 'bicycle', 'bicycles', 'parcel', 'parcels', 'package', 'packages', 'box', 'boxes',
  'blurred', 'blurry', 'large', 'small', 'tall', 'wet', 'animated',
  'white', 'black', 'grey', 'gray', 'red', 'blue', 'green', 'yellow', 'brown', 'orange',
]);

/**
 * The prompt's own examples (describe.ts). A model that cannot see — a black
 * frame, seen live on 2026-10-20 — gives one back word for word, and it
 * would be shown as if it were the door.
 */
const PROMPT_EXAMPLES: readonly string[] = ['a man in a delivery uniform, holding a parcel', 'an empty porch with a parcel on the step'];

/**
 * Names of carriers a uniform or a van may show: the one kind of capitalised
 * word a description may carry. Any other is taken as a name, which a
 * description never says ("Never name anyone", describe.ts).
 */
const CARRIERS: ReadonlySet<string> = new Set([
  'amazon', 'ups', 'dhl', 'fedex', 'usps', 'royal', 'mail', 'evri', 'hermes', 'dpd', 'yodel', 'parcelforce', 'ocado', 'tesco', 'sainsbury\'s',
]);

/** Words for who someone is to her, or what they are to her: a frame cannot show either. */
const WHO_THEY_ARE = [
  'son', 'daughter', 'husband', 'wife', 'grandson', 'granddaughter', 'grandchild', 'grandchildren', 'friend', 'friends',
  'neighbour', 'neighbours', 'neighbor', 'neighbors', 'relative', 'relatives', 'family', 'carer', 'caregiver', 'boyfriend', 'girlfriend',
];

/** Speaking to someone, or as someone: a description does neither. */
const ADDRESSED = ['you', 'your', 'yours', 'yourself', 'please', 'i', 'me', 'my', 'we', 'us', 'our'];

/** Words that carry text out of the picture into the sentence: what a sign, a T-shirt or a note held up says. */
const QUOTING = ['reads', 'reading', 'says', 'saying', 'said', 'written', 'writing', 'spelling', 'spelled', 'spelt'];

const wordOf = (word: string): string => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'’]+$/gu, '');

/**
 * Why a description is refused, or undefined when it may be shown. The
 * prompt asks for one observation of the frame (describe.ts); this is what
 * holds when the frame — a sign, a slogan, a note held to the lens — or the
 * model talks it out of that. A refused description is never shown: the
 * card keeps Phase 1's line, which is always true.
 */
export function descriptionRefusal(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return 'empty';

  const words = trimmed.split(/\s+/);
  if (words.length > DESCRIPTION_MAX_WORDS) return 'too_long';

  // One sentence, ending in a full stop or nothing: a second sentence, a question or an exclamation is not a description.
  if (/[.!?]\s+\S/.test(trimmed) || /[!?]/.test(trimmed)) return 'not_one_sentence';

  const lower = trimmed.toLowerCase();
  if (SPECULATION.some((w) => new RegExp(`\\b${w}\\b`).test(lower))) return 'speculation';

  const plain = words.map(wordOf);
  if (!OPENERS.has(plain[0]!.toLowerCase())) return 'not_a_description';
  const asked = trimmed.toLowerCase().replace(/[.\s]+$/, '');
  if (PROMPT_EXAMPLES.includes(asked)) return 'example_echo';

  // A name: a capitalised word anywhere after the first, unless it is a carrier's.
  if (plain.slice(1).some((w) => /^\p{Lu}/u.test(w) && !CARRIERS.has(w.toLowerCase()))) return 'names_someone';

  const lowered = plain.map((w) => w.toLowerCase());
  if (lowered.some((w) => ADDRESSED.includes(w))) return 'addresses_someone';
  if (lowered.some((w) => WHO_THEY_ARE.includes(w.replace(/['’]s$/, '')))) return 'says_who_they_are';
  if (lowered.some((w) => QUOTING.includes(w)) || /["“”«»]/.test(trimmed)) return 'quotes_text';
  // A house number, a time, a number plate: none is a description, and some are an address.
  if (/\d/.test(trimmed)) return 'has_digits';

  // Nothing the family is never told — health, money, relationships, where someone is (INV-4).
  const reading = classify(trimmed);
  if (!reading.readable) return 'unreadable';
  if (reading.classes.length > 0) return `protected:${reading.classes.join(',')}`;

  return undefined;
}

export function validateDescription(text: string): boolean {
  return descriptionRefusal(text) === undefined;
}

/**
 * A description the model gave and the validator let through. There is no
 * confidence number: none was ever measured. A model that is not sure says
 * UNCLEAR (describe.ts), and that is the abstention; the validator is the
 * other half.
 */
export interface DescriptionCandidate {
  readonly description: string;
  /** From the model's PERSON line. Absent when it didn't say — never guessed. */
  readonly personVisible?: boolean;
}

export interface DescribeReply {
  readonly personVisible: boolean | undefined;
  readonly sentence: string;
}

/**
 * The model answers in two lines — `PERSON: yes|no`, then the sentence
 * (describe.ts's SYSTEM prompt). A reply without the PERSON line is still
 * usable as a sentence; presence just stays unknown.
 */
export function parseDescribeReply(text: string): DescribeReply {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const header = /^person:\s*(yes|no)$/i.exec(lines[0] ?? '');
  if (!header) return { personVisible: undefined, sentence: lines.join(' ') };
  return { personVisible: header[1]!.toLowerCase() === 'yes', sentence: lines.slice(1).join(' ') };
}

/**
 * Phase 2b. Returns null — not an empty patch — when there is nothing worth
 * saying, so a caller cannot accidentally send silence as content.
 */
export function buildDescriptionPatch(
  cardId: string,
  candidate: DescriptionCandidate,
  eventType?: string,
): CardPatch | null {
  if (!validateDescription(candidate.description)) return null;

  const description = candidate.description.trim();
  // Only a definite "nobody" corrects the headline. Unknown leaves Phase 1's
  // line standing — a correction is a claim too.
  if (candidate.personVisible !== false) return { cardId, description };
  const pressed = eventType === 'button_press';
  // The same words for a stand-in doorbell: its card carries its own label (DoorCard.standIn).
  const line = pressed ? NOBODY_AFTER_RING_LINE : NOBODY_AFTER_MOTION_LINE;
  return { cardId, description, line };
}

/** Phase 2a. The picture, once Ring has finally handed it over. */
export function buildImagePatch(cardId: string, image: RingImage): CardPatch {
  return { cardId, imageRef: image.url };
}
