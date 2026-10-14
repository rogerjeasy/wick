/**
 * People, households and the circle between them.
 *
 * A person has one account. A household is the home of one resident, who
 * has no account at all (packages/contracts/src/circle.ts). A membership
 * joins the two, and carries the resident's answer.
 */
import type { CircleRole, HouseholdLanguage, MemberStatus } from '@wick/contracts';

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
  /**
   * A demo home: its history was written by Wick, not lived (demoHome.ts).
   * Every surface that names the home says so. Never set on a home a
   * person set up for someone.
   */
  readonly simulated?: boolean;
  /**
   * The language the resident's television speaks (packages/contracts
   * language.ts). Absent: English. Read here and never written from here —
   * only her own press on the television changes it.
   */
  readonly language?: HouseholdLanguage;
  /** A question still open on her television: the organiser asked for another language, and she has not answered. */
  readonly languageAsked?: AskedLanguage;
  /**
   * The language she last said no to, and when. Her no is an answer too: it
   * stands for a week (LANGUAGE_ASK_AGAIN_AFTER_MS). Written only by her
   * press, at the edge, like the language itself — read here, never written.
   */
  readonly languageDeclined?: { readonly language: HouseholdLanguage; readonly at: number };
  /**
   * The question the organiser last took back, and when. That question is
   * not asked again for a day (LANGUAGE_ASK_AFTER_TAKING_BACK_MS): asking
   * and taking back must not be a way to put it to her over and over. This
   * one is something the organiser did, so it is written from here.
   */
  readonly languageTakenBack?: { readonly language: HouseholdLanguage; readonly at: number };
}

/** A question about the television's language, as it is kept beside the household. */
export interface AskedLanguage {
  /** The language asked for. */
  readonly language: HouseholdLanguage;
  /** The first name of the organiser who asked, as the card says it. */
  readonly by: string;
  readonly at: number;
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

/**
 * A television of the resident's, as the store reads it. `deviceId` is for
 * this server's own use — removing the row it names — and never leaves it:
 * a television's id is what a refresh is asked for by (AGENTS.md INV-1), so
 * the family is shown `ref` instead (circle.ts describeCircle).
 */
export interface Television {
  readonly deviceId: string;
  /** Random, and nothing of the id (`televisionRef`, written at pairing): what the family app names a television by. */
  readonly ref: string;
  readonly pairedAt?: number;
  readonly connected: boolean;
}

/**
 * A television a member connected as their own (packages/contracts
 * familyTelevision.ts). Never one of the resident's: nothing meant for the
 * resident is sent to it, and it is not counted among the home's televisions.
 * Its `deviceId` never leaves this server either.
 */
export interface FamilyTelevision {
  readonly deviceId: string;
  readonly ref: string;
  /** The member whose television it is. */
  readonly userId: string;
  readonly pairedAt?: number;
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
