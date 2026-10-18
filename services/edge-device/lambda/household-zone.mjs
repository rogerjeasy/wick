/**
 * Where the house is: the household's own IANA time zone, `timeZone` on its
 * `HH#<household>` / `META` row (packages/contracts clock.ts, copied here as
 * language.mjs copies the language). What "today" means for her light, and
 * when "this morning" ends, is read on it.
 *
 * A home set up before homes had a zone has none, and is read in the
 * default: Wick's first homes were all in England.
 *
 * Pure: device-event.mjs owns the DynamoDB client.
 */

export const HOUSEHOLD_TIME_ZONE_ATTR = 'timeZone';
export const DEFAULT_HOUSEHOLD_TIME_ZONE = 'Europe/London';

const META_SK = 'META';
const MAX_TIME_ZONE_LENGTH = 64;

/** Whether `value` names a time zone this runtime knows. */
export function isTimeZone(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TIME_ZONE_LENGTH) return false;
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The household's zone, from its own row: the default unless the row names one. */
export function timeZoneOfMeta(item) {
  const zone = item?.[HOUSEHOLD_TIME_ZONE_ATTR]?.S;
  return isTimeZone(zone) ? zone : DEFAULT_HOUSEHOLD_TIME_ZONE;
}

/** The same, from the rows the home screen is read from (light.mjs homeRange), which end at that row. */
export function timeZoneOfRows(items) {
  return timeZoneOfMeta((items ?? []).find((item) => item.sk?.S === META_SK));
}
