/**
 * Who is coming, as a family member types it for a visit they arrange
 * (the Wick server's arrange_visit): "the plumber", "Dave", "Doctor Rossi".
 *
 * A doctor at the door is the visit a family most needs to arrange: a
 * different doctor each time she is ill, nobody she recognises, a door kept
 * shut. "Doctor" is a word about her health to the lexicon (lexicon.ts), so
 * until now the member was told to find another word for the one visitor
 * Wick most has to help her know. Here, and only here, a general
 * clinician's title is set aside as "someone" before the rest is read.
 *
 * Narrow on purpose. Set aside are the titles that say a clinician has come
 * and nothing about why: doctor, Dr, GP, nurse, district nurse, physio,
 * podiatrist, chiropodist, optician. A title that says what the visit is for
 * (psychiatrist, psychologist, therapist, counsellor, midwife, paramedic,
 * dentist) is still refused, and so is every other protected word beside a
 * title: "Dr Patel about her dialysis" says more than that a doctor came.
 *
 * Why this is not a fact let through: the member typed it, about a visit
 * they arranged, and it is read back to that member (their own words) and
 * shown on her own television, which is not gated — everything on it is
 * about her. Where anyone else reads it, the Wick server reads it again and
 * leaves the name out (get_door_request, get_today). The lexicon itself is
 * unchanged: the door camera's "A nurse is at the door." is still refused.
 *
 * Fails closed as clearForFamily does: text it cannot read is not cleared.
 */
import { clearForFamily, clearNameForFamily, normalise } from './guardian.js';
import { DEFAULT_POLICY } from './policy.js';
import type { HouseholdPolicy } from './types.js';

/**
 * The general titles, over normalised text (lower case, plain letters).
 * Spelt as lexicon.ts spells them, so each is exactly what it would have
 * caught: "Doctor Who" is a programme there and here.
 */
const GENERAL_CLINICIAN = new RegExp(`\\b(?:${[
  'district nurses?', 'doctor(?! who\\b)s?', 'drs?', 'gp', 'g\\.p', 'nurses?', 'physio(?:therapists?)?s?',
  'podiatrists?', 'chiropodists?', 'opticians?',
].join('|')})\\b`, 'g');

/**
 * Whether the words for an arranged visitor may be kept and read back: when
 * they clear as text or as a name today, or when, with a general clinician's
 * title set aside, the rest clears as text.
 */
export function clearVisitorForFamily(who: string, policy: HouseholdPolicy = DEFAULT_POLICY): boolean {
  if (clearForFamily(who, policy).cleared || clearNameForFamily(who, policy)) return true;
  const plain = normalise(who);
  if (plain === undefined) return false;
  return clearForFamily(plain.replace(GENERAL_CLINICIAN, 'someone'), policy).cleared;
}
