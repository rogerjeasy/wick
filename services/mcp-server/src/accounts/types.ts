/**
 * People, households and the circle between them.
 *
 * A person has one account. A household is the home of one resident, who
 * has no account at all (packages/contracts/src/circle.ts). A membership
 * joins the two, and carries the resident's answer.
 */
import type { CircleRole, MemberStatus } from '@wick/contracts';

export interface User {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly createdAt: number;
}

export interface Household {
  readonly householdId: string;
  /** What the family calls it: "Mum's house". */
  readonly name: string;
  /** The person who lives there, as the family names them: "Margaret". */
  readonly residentName: string;
  readonly createdBy: string;
  readonly createdAt: number;
}

export interface Membership {
  readonly householdId: string;
  readonly userId: string;
  /** As it appears on the resident's television. */
  readonly name: string;
  readonly role: CircleRole;
  readonly status: MemberStatus;
  readonly requestedAt: number;
  readonly decidedAt?: number;
  readonly invitedBy?: string;
}

export interface Television {
  readonly deviceId: string;
  readonly pairedAt?: number;
  readonly connected: boolean;
}

/**
 * Short-lived state, each kept as `<KIND>#<id>` / `META` with an expiry.
 * `OAUTH#AT` is read by the television-pairing Lambda as well
 * (packages/contracts/src/circle.ts ACCESS_TOKEN_KEY_PREFIX).
 */
export type RecordKind =
  | 'OAUTH#CLIENT'
  | 'OAUTH#PENDING'
  | 'OAUTH#CODE'
  | 'OAUTH#AT'
  | 'OAUTH#RT'
  | 'SESSION'
  | 'INV';
