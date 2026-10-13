/**
 * A picture's row: `HH#<household>` / `PHOTO#<photoId>` (packages/contracts
 * mantel.ts) — who sent it, when, and, once she has pressed either button
 * on its card, that it was seen. It is all this server ever reads of a
 * picture: never what is on her mantelpiece, never the card or what was
 * pressed on it.
 *
 * Written here once, when a picture is sent, under a condition: the row is
 * the claim on the picture's id, so one id is one picture however often
 * its sending is tried. `seenAt` is the edge's to write, at her press.
 */
import { DeleteItemCommand, GetItemCommand, PutItemCommand, QueryCommand, type AttributeValue, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PHOTO_SK_PREFIX, isPhotoId } from '@wick/contracts';

const TABLE = process.env.TABLE_NAME ?? 'wick';

type Item = Record<string, AttributeValue>;

/** How long a picture's row is kept: about thirteen months — long enough to say it was seen, not for ever. */
export const PHOTO_TTL_MS = 396 * 24 * 60 * 60_000;

export interface PhotoRow {
  readonly photoId: string;
  /** The member who sent it. */
  readonly sentBy: string;
  /** Their name as her circle has it, at the time. */
  readonly sentByName: string;
  readonly sentAt: number;
  /** Whether she has pressed either button on its card. When is not read: nobody is told. */
  readonly seen: boolean;
}

const key = (householdId: string, photoId: string): Item => ({ pk: { S: `HH#${householdId}` }, sk: { S: `${PHOTO_SK_PREFIX}${photoId}` } });

function rowFromItem(item: Item | undefined): PhotoRow | undefined {
  const photoId = item?.photoId?.S ?? item?.sk?.S?.slice(PHOTO_SK_PREFIX.length);
  const sentBy = item?.sentBy?.S;
  const sentAt = Number(item?.sentAt?.N);
  if (!item || !isPhotoId(photoId) || !sentBy || !Number.isFinite(sentAt)) return undefined;
  return { photoId, sentBy, sentByName: item.sentByName?.S ?? '', sentAt, seen: item.seenAt !== undefined };
}

const refused = (err: unknown): boolean => (err as { name?: string }).name === 'ConditionalCheckFailedException';

/** Claims an id for a picture. False when there is already a picture of that id: nothing is written over. */
export async function claimPhoto(ddb: DynamoDBClient, householdId: string, row: Omit<PhotoRow, 'seen'>): Promise<boolean> {
  try {
    await ddb.send(new PutItemCommand({
      TableName: TABLE,
      Item: {
        ...key(householdId, row.photoId),
        photoId: { S: row.photoId },
        sentBy: { S: row.sentBy },
        sentByName: { S: row.sentByName },
        sentAt: { N: String(row.sentAt) },
        ttl: { N: String(Math.floor((row.sentAt + PHOTO_TTL_MS) / 1000)) },
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
    return true;
  } catch (err) {
    if (!refused(err)) throw err;
    return false;
  }
}

/** A picture's row as it is this moment: a second try is decided on what the first left. */
export async function getPhoto(ddb: DynamoDBClient, householdId: string, photoId: string): Promise<PhotoRow | undefined> {
  return rowFromItem((await ddb.send(new GetItemCommand({ TableName: TABLE, Key: key(householdId, photoId), ConsistentRead: true }))).Item);
}

/**
 * Gives a claim up: only the claim that sending made, and never the row of
 * a picture she has seen. Whether anything was there to give up is not
 * told — an undoing has nothing to do about it either way.
 */
export async function releasePhoto(ddb: DynamoDBClient, householdId: string, row: Pick<PhotoRow, 'photoId' | 'sentBy' | 'sentAt'>): Promise<void> {
  try {
    await ddb.send(new DeleteItemCommand({
      TableName: TABLE,
      Key: key(householdId, row.photoId),
      ConditionExpression: 'sentBy = :by AND sentAt = :at AND attribute_not_exists(seenAt)',
      ExpressionAttributeValues: { ':by': { S: row.sentBy }, ':at': { N: String(row.sentAt) } },
    }));
  } catch (err) {
    if (!refused(err)) throw err;
  }
}

/** Every picture sent to the household that still has a row. Read consistently: the day's count is decided on it. */
export async function listPhotos(ddb: DynamoDBClient, householdId: string): Promise<PhotoRow[]> {
  const rows: PhotoRow[] = [];
  let startKey: Item | undefined;
  do {
    const page = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': { S: `HH#${householdId}` }, ':prefix': { S: PHOTO_SK_PREFIX } },
      ConsistentRead: true,
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
    }));
    for (const item of page.Items ?? []) {
      const row = rowFromItem(item);
      if (row) rows.push(row);
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return rows;
}
