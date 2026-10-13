/**
 * What the pieces of a family member's own television share
 * (accounts/familyTelevision.ts and the files beside it, one per kind of
 * card): who is asking, once that has been settled, and how a button is made.
 */
import type { CardAction } from '@wick/contracts';
import type { Household, Membership } from './types.js';

/**
 * A television that has been let in: whose it is, by its token, its own row
 * and the circle — and by nothing else (familyTelevision.ts `authenticate`).
 * Nothing in a request can put a household or a person here (INV-8).
 */
export interface TvCaller {
  readonly householdId: string;
  readonly userId: string;
  /** This television, for what is kept on its own row and nowhere else. */
  readonly deviceId: string;
  readonly membership: Membership;
  readonly household: Household;
  /** The week last read to its end on this television (familyTvWeek.ts), from its own row. */
  readonly weekRead?: string;
}

/** A button: the first is the one the remote starts on. */
export const action = (id: string, label: string, index: number): CardAction => ({ id, label, kind: index === 0 ? 'primary' : 'secondary' });
