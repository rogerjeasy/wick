/**
 * What a household has chosen to share, and who it expects — read the same
 * way by everything that needs them: the family's tools on the Wick server,
 * and the agent plane's own work (rhythm/loadDifferent.ts).
 *
 * These lived in the Wick server's tools (get_resident_shared_view,
 * list_regular_visitors), which still export them under their old names.
 * They moved here when "Shall I tell Sarah?" needed the agent plane to ask
 * the same two questions, so that there is one answer to each.
 */
import { GetItemCommand, QueryCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DEFAULT_LANGUAGE,
  HOUSEHOLD_LANGUAGE_ATTRS,
  HOUSEHOLD_TIME_ZONE_ATTR,
  isHouseholdLanguage,
  timeZoneOfMeta,
  type FactClass,
  type HouseholdLanguage,
  type RosterEntry,
} from '@wick/contracts';
import { DEFAULT_POLICY, evaluate, type HouseholdPolicy } from '@wick/policy';
import { stillWelcome } from '../agents/door/roster.js';

/**
 * The household's policy, with the resident's own choices from their
 * television merged in. "What Sarah sees" (services/edge-device/lambda/
 * sharing.mjs) records those as a `residentExclusions` string set on this
 * same META item, so the policy document itself is never rewritten by a
 * device. Exclusions only ever narrow (services/policy).
 */
export async function loadHouseholdPolicy(ddb: DynamoDBClient, table: string, householdId: string): Promise<HouseholdPolicy> {
  const res = await ddb.send(new GetItemCommand({
    TableName: table,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: 'META' } },
  }));
  const raw = res.Item?.policy?.S;
  const policy = raw ? (JSON.parse(raw) as HouseholdPolicy) : DEFAULT_POLICY;
  const fromTv = (res.Item?.residentExclusions?.SS ?? []) as FactClass[];
  if (fromTv.length === 0) return policy;
  return { ...policy, residentExclusions: [...new Set([...policy.residentExclusions, ...fromTv])] };
}

/**
 * The language the household's television speaks (packages/contracts
 * language.ts): `language` on this same META item, absent for English.
 *
 * A GetItem of that one attribute, on purpose: it is asked before anything
 * is sent to her television (egress.ts), by every role that sends — and a
 * GetItem on the table is the one read all of them may make. `consistent`
 * is for the moment she has just answered the question on her television.
 */
export async function loadHouseholdLanguage(
  ddb: Pick<DynamoDBClient, 'send'>,
  table: string,
  householdId: string,
  options: { readonly consistent?: boolean } = {},
): Promise<HouseholdLanguage> {
  const res = await ddb.send(new GetItemCommand({
    TableName: table,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: 'META' } },
    // `language` is a word DynamoDB keeps for itself.
    ProjectionExpression: '#language',
    ExpressionAttributeNames: { '#language': HOUSEHOLD_LANGUAGE_ATTRS.language },
    ...(options.consistent ? { ConsistentRead: true } : {}),
  }));
  const language = res.Item?.[HOUSEHOLD_LANGUAGE_ATTRS.language]?.S;
  return isHouseholdLanguage(language) ? language : DEFAULT_LANGUAGE;
}

/** How long a household's zone is kept once read: it is given when the home is set up and does not move. */
export const TIME_ZONE_KEPT_MS = 10 * 60_000;
const zones = new Map<string, { readonly zone: string; readonly until: number }>();

/**
 * Where the house is (packages/contracts clock.ts): `timeZone` on this same
 * META item, or the default for a home set up before homes had one. One
 * GetItem of that one attribute, kept for a few minutes per process: a door
 * card, a week and a reminder each ask it, and it does not change under them.
 */
export async function loadHouseholdTimeZone(
  ddb: Pick<DynamoDBClient, 'send'>,
  table: string,
  householdId: string,
  now: number = Date.now(),
): Promise<string> {
  const kept = zones.get(householdId);
  if (kept && kept.until > now) return kept.zone;
  const res = await ddb.send(new GetItemCommand({
    TableName: table,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: 'META' } },
    ProjectionExpression: '#zone',
    ExpressionAttributeNames: { '#zone': HOUSEHOLD_TIME_ZONE_ATTR },
  }));
  const zone = timeZoneOfMeta(res.Item as Parameters<typeof timeZoneOfMeta>[0]);
  zones.set(householdId, { zone, until: now + TIME_ZONE_KEPT_MS });
  return zone;
}

/** For tests: what has been kept is forgotten. */
export function forgetTimeZones(): void {
  zones.clear();
}

/**
 * Whether a household is a guest's demo home: set up by somebody, and marked
 * `simulated` when it was (services/mcp-server accounts/store.ts
 * createHousehold). Only a demo home has a stand-in doorbell
 * (agents/door/demoDoor.ts); a household a person set up never does.
 */
export async function isDemoHome(ddb: Pick<DynamoDBClient, 'send'>, table: string, householdId: string): Promise<boolean> {
  const res = await ddb.send(new GetItemCommand({
    TableName: table,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: 'META' } },
    ProjectionExpression: 'createdBy, simulated',
    ConsistentRead: true,
  }));
  return Boolean(res.Item?.createdBy?.S) && res.Item?.simulated?.BOOL === true;
}

/**
 * Whether a whole class of fact is shown to the family: the Guardian's own
 * `evaluate` (services/policy), asked for the FAMILY audience. The table
 * allows it, or an explicit opt-in that is not in NEVER_TO_FAMILY; the
 * resident's exclusions narrow last. One function decides it, for the class
 * here and for the classes the content gate finds in a sentence
 * (`clearForFamily`), so no two surfaces can disagree.
 *
 * A summarised class (RHYTHM, COMMITMENT) counts as shown: what the family
 * is given of it is already the summary — the week's narrative, never the
 * rows it was counted from.
 */
export function isSharedWithFamily(factClass: FactClass, policy: HouseholdPolicy): boolean {
  return evaluate({ class: factClass, content: '', sourceIds: [] }, 'FAMILY', policy).allow;
}

/**
 * The roster, without anyone whose entry stands on the word of a person the
 * resident no longer allows (door/roster.ts stillWelcome): the circle is
 * read with it, every time.
 */
export async function loadRoster(ddb: DynamoDBClient, table: string, householdId: string): Promise<RosterEntry[]> {
  const rows = (prefix: string) => ddb.send(new QueryCommand({
    TableName: table,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':pk': { S: `HH#${householdId}` }, ':prefix': { S: prefix } },
  }));
  const [people, members] = await Promise.all([rows('PER#'), rows('MEM#')]);
  const roster = (people.Items ?? []).flatMap((item) => (item.data?.S ? [JSON.parse(item.data.S) as RosterEntry] : []));
  return stillWelcome(roster, members.Items ?? []);
}
