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
import { DEFAULT_LANGUAGE, HOUSEHOLD_LANGUAGE_ATTRS, NEVER_TO_FAMILY, isHouseholdLanguage, type FactClass, type HouseholdLanguage, type RosterEntry } from '@wick/contracts';
import { DEFAULT_POLICY, type HouseholdPolicy } from '@wick/policy';
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

/**
 * Mirrors services/policy/src/evaluate.ts's order exactly: table rule allows
 * it, OR it's an explicit opt-in that is not in NEVER_TO_FAMILY (the opt-in
 * can never widen past that hard cap); resident exclusions narrow last. The
 * single source of truth for "is this FactClass visible to FAMILY", so no
 * two surfaces can disagree.
 */
export function isSharedWithFamily(factClass: FactClass, policy: HouseholdPolicy): boolean {
  const rule = policy.table[factClass].FAMILY;
  const allowed =
    rule.allow || (policy.familyPermitted.includes(factClass) && !NEVER_TO_FAMILY.includes(factClass));
  return allowed && !policy.residentExclusions.includes(factClass);
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
