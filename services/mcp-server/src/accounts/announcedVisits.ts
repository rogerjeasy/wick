/**
 * How a visit somebody announced (tools/expect_visit.ts) is filed on the
 * household's roster: under the member who announced it, one row a day.
 *
 *   HH#<household> / PER#member-<userId>#<YYYY-MM-DD>
 *
 * Kept here because two things must agree on it: the tool that writes the
 * row, and the store that takes a person's rows away again when they are
 * removed from the circle (store.ts forgetAnnouncedVisits). A row that
 * outlived its author would have the door go on telling the resident that
 * a caller "looks like" someone they no longer let in.
 */
export const memberPersonId = (userId: string): string => `member-${userId}`;

/** Every announced visit of one person: the prefix their rows share. */
export const announcedVisitPrefix = (userId: string): string => `PER#${memberPersonId(userId)}#`;

export const announcedVisitSk = (userId: string, date: string): string => `${announcedVisitPrefix(userId)}${date}`;
