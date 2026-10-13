/**
 * The visit, witnessed — what the door saw (packages/contracts visit.ts).
 *
 * Called for every door-worthy sighting the Door agent handles, after its
 * own work. Two things can come of one:
 *
 *   - A regular visitor has arrived: the sighting matched the roster, and
 *     no visit of theirs is under way. A visit is opened at that moment.
 *   - A visitor has left: a visit is under way and the door has seen
 *     somebody long enough after the arrival — the visitor again, or
 *     anybody it does not know as another regular visitor arriving. The door cannot
 *     tell who is leaving, and does not try: the last sighting before she
 *     is asked is taken as the leaving, and whether that is right is the
 *     question she is then asked.
 *
 * Only a regular visitor has a record: not a stranger, and not one of the
 * family who said they were coming (their visit is theirs, not a carer's
 * to be attested). Deterministic, no model, and nothing inside the house.
 */
import { VISIT_WINDOW_MS, departureOf, isVisitPersonId, userIdOfMemberPerson, type Visit, type VisitorMatch } from '@wick/contracts';

export interface NoteDeps {
  /** The household's visits that began at or after a moment. */
  readonly recent: (householdId: string, since: number) => Promise<readonly Visit[]>;
  readonly open: (visit: Visit) => Promise<boolean>;
  readonly setLeft: (visit: Visit, leftAt: number) => Promise<boolean>;
}

export type NoteResult = 'arrived' | 'left' | 'nothing';

/** Whether this visitor's visit is the kind that has a record. */
function isRegularVisitor(match: VisitorMatch | undefined): match is VisitorMatch {
  return match !== undefined && isVisitPersonId(match.personId) && userIdOfMemberPerson(match.personId) === undefined;
}

export async function noteDoorSighting(
  sighting: { readonly householdId: string; readonly match: VisitorMatch | undefined; readonly at: number },
  deps: NoteDeps,
): Promise<NoteResult> {
  const { householdId, match, at } = sighting;
  // No visit is taken to last longer than this, so nothing older can be under way.
  const recent = await deps.recent(householdId, at - VISIT_WINDOW_MS);

  // A regular visitor with no visit under way is arriving — whoever else is
  // inside. Two visitors can overlap (the carer and the cleaner), and one
  // arriving is not the other leaving.
  const arriving = isRegularVisitor(match) && !recent.some((visit) => visit.personId === match.personId && visit.askedAt === undefined && visit.arrivedAt <= at);
  if (!arriving) {
    // Anybody else at the door, long enough after an arrival, is taken as
    // leaving: the visitor seen again, or somebody the door does not know.
    // With two visits under way it is taken as both — the door cannot tell
    // which, and she is asked about each.
    const leaving = recent.filter((visit) => departureOf(visit, at));
    for (const visit of leaving) await deps.setLeft(visit, at);
    return leaving.length > 0 ? 'left' : 'nothing';
  }

  return (await deps.open({ householdId, personId: match.personId, name: match.name, arrivedAt: at })) ? 'arrived' : 'nothing';
}
