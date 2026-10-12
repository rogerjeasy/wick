/**
 * What Wick plays: the list itself is packages/contracts/src/programmes.ts,
 * where the reasons for it are. It lives there because the family member's
 * player plays from it too, when the resident has said yes to watching
 * together. This is the television's name for it.
 */
import { CALM_POINTS } from './calmPoints.js';

export { PROGRAMMES as CATALOG, PROGRAMMES_ORIGIN, programmeById, type Programme } from '@wick/contracts';

/**
 * A programme's calm points, as positions in milliseconds — the moments
 * inside it where a note may arrive without spoiling a scene (calmPoints.ts,
 * measured and chosen by scripts/calm-points). Undefined for a programme
 * Wick has not measured: for that one, a note waits for the credits as before.
 */
export function calmPointsOf(id: string): readonly number[] | undefined {
  return CALM_POINTS[id]?.map((point) => point.atMs);
}
