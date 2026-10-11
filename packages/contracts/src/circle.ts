/**
 * The family circle — who may reach a household, and the resident's say in it.
 *
 * INV-9: a person can read a household only after the resident has allowed
 * them on the television. A membership starts `pending`; the only thing that
 * moves it to `allowed` is the resident's press on the Circle card
 * (services/edge-device/lambda/circle.mjs, which inlines the constants below
 * because a plain .mjs Lambda cannot import TS — keep them in step).
 *
 * The resident has no account. The paired television is their identity, and
 * the remote is their consent.
 */

/** The organiser set the household up and manages the circle; family joins by invitation. */
export type CircleRole = 'organiser' | 'family';

export type MemberStatus = 'pending' | 'allowed' | 'declined' | 'removed';

/** The Circle card's actions. One press decides; nothing else on the card does anything. */
export const CIRCLE_ACTIONS = {
  allow: 'allow',
  decline: 'decline',
} as const;

const CIRCLE_CARD_PREFIX = 'circle-';

/** Deterministic, like the Week card's id: route.mjs recovers the person from the card id alone. */
export function circleCardId(userId: string): string {
  return `${CIRCLE_CARD_PREFIX}${userId}`;
}

/** The person a Circle card is about, or undefined for any other card. */
export function userIdFromCircleCardId(cardId: string): string | undefined {
  return cardId.startsWith(CIRCLE_CARD_PREFIX) && cardId.length > CIRCLE_CARD_PREFIX.length
    ? cardId.slice(CIRCLE_CARD_PREFIX.length)
    : undefined;
}

/**
 * Where an access token's grant is stored: `OAUTH#AT#<sha256 hex of the
 * token>` / `META`. The token itself is never stored. A wire contract with
 * services/edge-device/lambda/wick-auth.mjs, which verifies a family
 * member's bearer token when they connect a television.
 */
export const ACCESS_TOKEN_KEY_PREFIX = 'OAUTH#AT#';

/**
 * A family member, as a person on the household's roster: how a visit they
 * announced is filed (the family's expect_visit tool), and how the Door
 * agent tells such an entry from a regular visitor's.
 */
const MEMBER_PERSON_PREFIX = 'member-';

export function memberPersonId(userId: string): string {
  return `${MEMBER_PERSON_PREFIX}${userId}`;
}

/** The member behind a roster person id, or undefined for a regular visitor. */
export function userIdOfMemberPerson(personId: string): string | undefined {
  return personId.startsWith(MEMBER_PERSON_PREFIX) ? personId.slice(MEMBER_PERSON_PREFIX.length) : undefined;
}
