/**
 * Who looked in — the family's half of the light in the window
 * (packages/contracts/src/light.ts).
 *
 * When somebody the resident has allowed asks after them — how the day has
 * been, how the week went, whether the light is on — that is noted, and the
 * resident's own home screen says so: "Sarah looked in this morning."
 * Looking is not hidden from the person looked at. The family app says as
 * much to the person looking.
 *
 * One row per member, their latest look: `HH#<household>` /
 * `LOOKIN#<userId>`. A run of questions is one look, not one each: the row
 * is written at most once every little while, and the television is told
 * only when it is.
 */
import { UpdateItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { LOOKIN_SK_PREFIX, endOfLocalDay, lookedInWords, type HomeState } from '@wick/contracts';

const TABLE = process.env.TABLE_NAME ?? 'wick';

/** How often one person's asking is noted afresh. */
export const LOOK_EVERY_MS = 10 * 60_000;
/** A look is about today; the row is gone a couple of days later. */
const KEPT_FOR_S = 2 * 86_400;

/** egress.ts's sendHomeToDevices — the only path to the television (INV-2). */
export type SendHome = (householdId: string, home: HomeState) => Promise<void>;

const firstName = (name: string): string => name.trim().split(/\s+/)[0] || 'Someone';

export async function recordLook(
  ddb: DynamoDBClient,
  who: { readonly householdId: string; readonly userId: string; readonly name: string; readonly timeZone: string },
  now: number,
  sendHome: SendHome,
): Promise<void> {
  const name = firstName(who.name);
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: { pk: { S: `HH#${who.householdId}` }, sk: { S: `${LOOKIN_SK_PREFIX}${who.userId}` } },
      UpdateExpression: 'SET #name = :name, lookedAt = :at, #ttl = :ttl',
      ConditionExpression: '(attribute_not_exists(lookedAt) OR lookedAt <= :before)',
      ExpressionAttributeNames: { '#name': 'name', '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':name': { S: name },
        ':at': { N: String(now) },
        ':ttl': { N: String(Math.floor(now / 1000) + KEPT_FOR_S) },
        ':before': { N: String(now - LOOK_EVERY_MS) },
      },
    }));
  } catch (err) {
    // Noted a moment ago: the same look.
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return;
    throw err;
  }

  try {
    // With the end of today where the house is: the television shows the line until then, whatever its own clock says.
    await sendHome(who.householdId, { lookedIn: { name, at: now, line: lookedInWords(name, now, who.timeZone), until: endOfLocalDay(now, who.timeZone) } });
  } catch (err) {
    // A television that is off is told when it next connects (the edge's reconcile reads the same row).
    console.error(JSON.stringify({ level: 'error', msg: 'look_not_told', err: err instanceof Error ? err.name : 'unknown' }));
  }
}
