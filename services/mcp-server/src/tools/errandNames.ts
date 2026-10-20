/**
 * An arranged visitor's name, where somebody other than the member who
 * arranged the visit may read it.
 *
 * An errand puts its visitor on the door's roster (`PER#errand:<id>`, agent
 * store/errands.ts) in the arranging member's own words, and those words may
 * be a general clinician's title ("Doctor Rossi", policy's
 * clearVisitorForFamily). To that member they are their own words, read back
 * whole by the errand tools (errands.ts `toItsAuthor`). To anyone else they
 * are a fact about her health. So wherever the roster or the door's presence
 * rows name an errand's visitor to the family — the visitors expected,
 * whether a visitor came, the day's events — the name passes the gate on
 * its own, with no help from the household's people, and one it cannot
 * clear is said as "a visitor Sarah arranged". The answer is never withheld
 * whole for it, and the title never leaks.
 *
 * And an errand's visitor is never one of the household's people
 * (people.ts): those are names the gate may clear as names, and a visitor
 * named for one visit is not the household's own.
 */
import { errandPersonId } from '@wick/contracts';
import { clearNameForFamily, clearForFamily } from '@wick/policy';

const ERRAND_PERSON_PREFIX = errandPersonId('');

/** Whether a roster person id is an errand's visitor (`errand:<id>`): any id with the prefix, so nothing slips by being malformed. */
export const isErrandPerson = (personId: unknown): boolean => typeof personId === 'string' && personId.startsWith(ERRAND_PERSON_PREFIX);

/** What an errand's visitor is called for a reader the gate cannot clear the name for. */
export const UNNAMED_VISITOR = 'a visitor';

/**
 * An errand's visitor, named for the family: the name itself when the gate
 * clears it as text or as a name — with no household people — or "a visitor
 * Sarah arranged" (or "a visitor") when it does not. Logged, never the words.
 */
export function errandVisitorForFamily(name: string, arrangedByName?: string): string {
  if (clearForFamily(name).cleared || clearNameForFamily(name)) return name;
  console.warn(JSON.stringify({ level: 'warn', msg: 'guardian_withheld', where: 'errand.visitor', at: '$' }));
  const first = arrangedByName?.trim().split(/\s+/)[0];
  return first && clearNameForFamily(first) ? `${UNNAMED_VISITOR} ${first} arranged` : UNNAMED_VISITOR;
}
