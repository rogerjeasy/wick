/**
 * What the home screen is told, whole: her light, who looked in, her
 * language, her mantelpiece (light.mjs homeState) and her day (today.mjs
 * herDay), from the household's own rows and its roster, read where the
 * house is (household-zone.mjs).
 *
 * Read in two places, and the same way in both:
 *
 *   device-event.mjs   a television asks for its home, or a press there changed it
 *   visit-pass.mjs     a visitor said something from their visit pass, and her day says it
 *
 * `send` is a DynamoDBClient's send, handed in so each caller keeps its own
 * client and its tests their own table.
 */
import { QueryCommand } from '@aws-sdk/client-dynamodb';
import { homeRange, homeState } from './light.mjs';
import { herDay, rosterRange } from './today.mjs';
import { timeZoneOfRows } from './household-zone.mjs';

/** Every page of one Query. `consistent` for the moment after a write: what is told must be what was just written. */
async function allPages(send, input, consistent) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await send(new QueryCommand({ ...input, ...(consistent ? { ConsistentRead: true } : {}), ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}) }));
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

/** The household's own row, its light, its circle and the rest of light.mjs homeRange. */
export function loadHomeRows({ send, table, householdId, consistent = false }) {
  return allPages(send, homeRange({ table, householdId }), consistent);
}

/** The household's roster (today.mjs rosterRange): who the door expects, and so who her day says is coming. */
export function loadRosterRows({ send, table, householdId, consistent = false }) {
  return allPages(send, rosterRange({ table, householdId }), consistent);
}

/**
 * Her day, from the home's rows and its roster. A roster that cannot be
 * read leaves her day without its lines, never the home screen without its
 * date.
 */
export async function readHerDay({ send, table, householdId, items, now, timeZone, consistent = false }) {
  let rosterRows = [];
  try {
    rosterRows = await loadRosterRows({ send, table, householdId, consistent });
  } catch (err) {
    console.error('her_day_roster_failed', { householdId, err: err?.name });
  }
  return herDay({ homeRows: items, rosterRows, now, timeZone });
}

/** The home, whole, as it stands at `now`. Throws when the household's own rows cannot be read. */
export async function readHome({ send, table, householdId, now, consistent = false }) {
  const items = await loadHomeRows({ send, table, householdId, consistent });
  // Where the house is: what "today" means for the light in the window and for her day.
  const timeZone = timeZoneOfRows(items);
  return { ...homeState({ items, now, timeZone }), today: await readHerDay({ send, table, householdId, items, now, timeZone, consistent }) };
}
