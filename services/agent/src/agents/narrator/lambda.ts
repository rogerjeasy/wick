/**
 * Weekly schedule entrypoint — computes and writes the current ISO week's
 * narrative for every household with a television. Thin composition,
 * matches services/agent/src/agents/door/lambda.ts's own convention: the
 * logic worth testing lives in narrateEveryHousehold (everyHousehold.ts)
 * and computeWeekNarrative (index.ts), this only wires real AWS/Bedrock
 * clients to them and is left untested the same way door/lambda.ts's
 * handler is.
 *
 * Writes the week that's ending, not a rolling window — matches
 * docs/WICK-TECHNICAL.md §5.1's "runs weekly, offline. Cost is
 * irrelevant." A mid-week "how's Mum been" question reads last week's
 * completed narrative until the current week's own Sunday run.
 *
 * Since the Sunday brief, the weekly rule no longer starts this function:
 * it starts brief-dispatch, one home per message, and the agents write each
 * week (graphs/weeklyBrief.ts). This is what a home falls back to when they
 * cannot — `narratorDeps`, for that one home, inside the brief's worker
 * (brief/workerLambda.ts) — and the function stays deployed so an operator
 * can still write every home's week by hand, in one run.
 */
import { randomUUID } from 'node:crypto';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { currentIsoWeek, type WeekNarrative } from '@wick/contracts';
import { DEFAULT_POLICY } from '@wick/policy';
import { narrateEveryHousehold, type EveryHouseholdDeps } from './everyHousehold.js';
import { familyNameForWeekCard } from './weekCard.js';
import { lookStore, type LookSend } from '../../store/looks.js';
import { familyOnly } from '../door/askFamily.js';
import { writeNarrative } from './prose.js';
import { sendToDevice } from '../../egress.js';
import { householdRows, scanHouseholdsWithTelevision, type PagedSend } from '../brief/loaders.js';

const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME ?? '';
/** Who each household has allowed: the week card's second button names them (weekCard.ts). */
const looks = lookStore((cmd) => ddb.send(cmd as never) as ReturnType<LookSend>, TABLE);
/** Paged reads (brief/loaders.ts): seven weeks of a household's life, and the whole table's televisions. */
const paged: PagedSend = (cmd) => ddb.send(cmd as never) as ReturnType<PagedSend>;

async function saveNarrative(narrative: WeekNarrative): Promise<void> {
  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: { S: `HH#${narrative.householdId}` },
      sk: { S: `NARR#${narrative.isoWeek}` },
      data: { S: JSON.stringify(narrative) },
    },
  }));
}

/**
 * Everything the Narrator needs but the list of households: the real table,
 * model and egress. The weekly brief's worker uses it too — for one home,
 * when the agents could not write its week (brief/workerLambda.ts).
 */
export function narratorDeps(): Omit<EveryHouseholdDeps, 'listHouseholds'> {
  return {
    loadEvents: (householdId, range) => householdRows(paged, TABLE, householdId).loadEvents(range),
    firstEventAt: (householdId) => householdRows(paged, TABLE, householdId).firstEventAt(),
    writeNarrative: (facts, retryReason) => writeNarrative(facts, retryReason),
    saveNarrative,
    sendWeekCard: (card) => sendToDevice(card, DEFAULT_POLICY),
    now: Date.now,
    newCorrelationId: randomUUID,
    timeZone: process.env.WICK_HOUSEHOLD_TZ ?? 'Europe/London',
    familyNameOf: async (householdId) => familyNameForWeekCard(familyOnly(await looks.listFamily(householdId)).map((member) => member.name)),
  };
}

export const handler = async (): Promise<void> => {
  const isoWeek = currentIsoWeek(new Date());

  const run = await narrateEveryHousehold(isoWeek, { ...narratorDeps(), listHouseholds: () => scanHouseholdsWithTelevision(paged, TABLE) });

  // A failed household is logged by name above and not rethrown: a thrown
  // handler makes EventBridge run the whole week again for every home.
  console.log(JSON.stringify({ level: run.failed.length ? 'warn' : 'info', msg: 'narrator_run', isoWeek, written: run.written.length, failed: run.failed.length }));
};
