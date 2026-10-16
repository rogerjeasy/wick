/**
 * brief-worker — one home's week per SQS message (infra/brief.tf: batch 1,
 * at most two at once, partial batch failures reported). It asks the agent
 * plane's `brief.weekly` in that home's own session (runtime/invoke.ts),
 * and when the agents cannot write the week, the Narrator writes it here,
 * for that home alone (fanout.ts workMessage): every home with a
 * television has its week.
 *
 * Thin wiring; what it decides is tested in fanout.ts.
 */
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { narrateEveryHousehold } from '../narrator/everyHousehold.js';
import { narratorDeps } from '../narrator/lambda.js';
import { agentCoreTarget, invokeRuntime, type RuntimeTarget } from '../../runtime/invoke.js';
import { BRIEF_WEEKLY_KIND } from '../../runtime/briefHandler.js';
import { workBatch, workMessage, type SqsBatch } from './fanout.js';

/**
 * How long one home's brief may take: the graph's own ceiling is 150
 * seconds (graphs/weeklyBrief.ts) and a cold session adds a few. It sits
 * well inside the worker's 300-second timeout, which leaves the Narrator
 * room to write the week if the agents could not.
 */
export const BRIEF_RUNTIME_TIMEOUT_MS = 170_000;

let target: RuntimeTarget | undefined;
const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME ?? '';

/** The week's row as it stands, read consistently: none, stored and unread, or read (INV-7's residentSeenAt). */
async function storedWeek(householdId: string, isoWeek: string): Promise<'none' | 'unread' | 'read'> {
  const { Item } = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: `NARR#${isoWeek}` } },
    ConsistentRead: true,
  }));
  const data = Item?.data?.S;
  if (!data) return 'none';
  try {
    return typeof (JSON.parse(data) as { residentSeenAt?: unknown }).residentSeenAt === 'number' ? 'read' : 'unread';
  } catch {
    // A row that cannot be read is still a row: never written over.
    return 'unread';
  }
}

export const handler = (event: SqsBatch) =>
  workBatch(event, (message) =>
    workMessage(message, {
      invokeBrief: (householdId, isoWeek, origin) =>
        invokeRuntime((target ??= agentCoreTarget(undefined, undefined, BRIEF_RUNTIME_TIMEOUT_MS)), BRIEF_WEEKLY_KIND, householdId, { isoWeek, origin }),
      narrate: async (householdId, isoWeek) => {
        const run = await narrateEveryHousehold(isoWeek, { ...narratorDeps(), listHouseholds: async () => [householdId] });
        return run.written.includes(householdId);
      },
      storedWeek,
    }),
  );
