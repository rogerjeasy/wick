/**
 * How many times a member has tried to send a picture today — counted
 * before anything looks at one.
 *
 * A picture that is refused leaves no row behind it (photos/send.ts), so
 * the six a day a member can send do not bound how often they can try: and
 * each try is a request to Rekognition, which costs money, made on behalf
 * of whoever is signed in — a guest among them. So the try itself is
 * counted: one row per member per household day,
 *
 *   `HH#<household>` / `TRY#PHOTO#<userId>#<YYYY-MM-DD>`   `tries`, `ttl`
 *
 * and the counting is one request. The number is added to and held under
 * its cap by the same update, under a condition — there is no moment
 * between looking at the count and raising it, so however many tries cross,
 * at most MAX_PHOTO_TRIES_A_DAY are ever counted, and only a counted try
 * goes on to be looked at.
 *
 * The row is kept apart from the pictures' own (`PHOTO#`): nothing that
 * lists pictures reads it, and it says nothing of any picture. It is
 * written and never read back — the condition is the only thing that asks
 * what it holds — and the table lets go of it two days on.
 */
import { UpdateItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';

const TABLE = process.env.TABLE_NAME ?? 'wick';

/** How many times a member may try in a day. Well above the six they can send: a well-behaved member never meets it. */
export const MAX_PHOTO_TRIES_A_DAY = 20;
export const PHOTO_TRY_SK_PREFIX = 'TRY#PHOTO#';
/** How long a day's count is kept: past the end of the day it counts, wherever the house is, and not much longer. */
export const PHOTO_TRY_TTL_MS = 2 * 24 * 60 * 60_000;

/**
 * Counts one try for a member on a day (`YYYY-MM-DD`, where the house is).
 * False — and nothing counted — when the day's tries are used up. Any other
 * failure is thrown: a try that could not be counted is not a try that may
 * go ahead.
 */
export async function countTry(ddb: DynamoDBClient, who: { readonly householdId: string; readonly userId: string }, day: string, now: number): Promise<boolean> {
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: { pk: { S: `HH#${who.householdId}` }, sk: { S: `${PHOTO_TRY_SK_PREFIX}${who.userId}#${day}` } },
      UpdateExpression: 'ADD #tries :one SET #ttl = if_not_exists(#ttl, :ttl)',
      ConditionExpression: '(attribute_not_exists(#tries) OR #tries < :cap)',
      ExpressionAttributeNames: { '#tries': 'tries', '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':one': { N: '1' },
        ':cap': { N: String(MAX_PHOTO_TRIES_A_DAY) },
        ':ttl': { N: String(Math.floor((now + PHOTO_TRY_TTL_MS) / 1000)) },
      },
    }));
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}
