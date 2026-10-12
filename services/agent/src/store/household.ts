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
import { NEVER_TO_FAMILY, type FactClass, type RosterEntry } from '@wick/contracts';
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
