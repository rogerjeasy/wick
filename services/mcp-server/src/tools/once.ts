/**
 * A write a client may send twice is done once (INV-6).
 *
 * An assistant retries a tool call that timed out, and a person presses
 * Send again when nothing seemed to happen. For a note that would be two
 * notes on the resident's television. So a write tool first claims the
 * call: one conditional PutItem of a row keyed on who is asking, which
 * tool, and what was asked —
 *
 *   HH#<household> / ONCE#<tool>#<sha256(userId, key)>
 *
 * — where `key` is the client's own idempotency key when it sent one, and
 * otherwise the call's arguments. The first claim wins and does the write;
 * a second within the window finds the row and is given the first one's
 * answer, and nothing is written again. The row keeps only what that answer
 * needs (an id, never the words), expires with the window (`expiresAt`,
 * checked in the condition, because DynamoDB's own TTL deletes late), and
 * is let go if the write fails, so that a retry after a failure is tried.
 *
 * Nothing about a person is in the key: it is a hash, and the arguments
 * hashed are those of a call the same person already made.
 */
import { createHash } from 'node:crypto';
import { DeleteItemCommand, GetItemCommand, PutItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';

const TABLE = process.env.TABLE_NAME ?? 'wick';

export interface Claim {
  readonly householdId: string;
  readonly userId: string;
  readonly tool: string;
  /** What makes two calls the same call: the client's key, or the arguments. */
  readonly key: string;
  /** What the call was, when `key` is the client's: the same key for another call is refused, not answered. */
  readonly asked?: string | undefined;
  readonly windowMs: number;
  readonly now: number;
}

export type Claimed<R> =
  | { readonly first: true; release(): Promise<void>; keep(answer: R): Promise<void> }
  | { readonly first: false; readonly answer: R | undefined; readonly sameCall: boolean };

const digest = (...parts: readonly string[]): string => createHash('sha256').update(parts.join('\u0000')).digest('hex');

/** A stable text for a call's arguments: keys in order, so `{a, b}` and `{b, a}` are the same call. */
export function callKey(args: Record<string, unknown>): string {
  const ordered = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(ordered)
      : typeof value === 'object' && value !== null
        ? Object.fromEntries(Object.keys(value).sort().filter((k) => (value as Record<string, unknown>)[k] !== undefined).map((k) => [k, ordered((value as Record<string, unknown>)[k])]))
        : value;
  return JSON.stringify(ordered(args));
}

/**
 * Claims one call. `first: true` — do the write, then `keep` its answer (or
 * `release` the claim if it failed). `first: false` — the same call was
 * made within the window: here is its answer, if it has one yet.
 */
export async function claimOnce<R>(ddb: DynamoDBClient, claim: Claim): Promise<Claimed<R>> {
  const key = { pk: { S: `HH#${claim.householdId}` }, sk: { S: `ONCE#${claim.tool}#${digest(claim.userId, claim.key)}` } };
  const asked = claim.asked === undefined ? undefined : digest(claim.asked);
  const expiresAt = claim.now + claim.windowMs;
  try {
    await ddb.send(new PutItemCommand({
      TableName: TABLE,
      Item: {
        ...key,
        expiresAt: { N: String(expiresAt) },
        // DynamoDB's own clean-up, a day after it stops counting.
        ttl: { N: String(Math.ceil((expiresAt + 86_400_000) / 1000)) },
        ...(asked === undefined ? {} : { asked: { S: asked } }),
      },
      ConditionExpression: '(attribute_not_exists(pk) OR expiresAt < :now)',
      ExpressionAttributeValues: { ':now': { N: String(claim.now) } },
    }));
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    const held = await ddb.send(new GetItemCommand({ TableName: TABLE, Key: key, ConsistentRead: true }));
    const raw = held.Item?.answer?.S;
    return {
      first: false,
      answer: raw === undefined ? undefined : (JSON.parse(raw) as R),
      sameCall: held.Item?.asked?.S === asked,
    };
  }
  return {
    first: true,
    release: async () => {
      await ddb.send(new DeleteItemCommand({ TableName: TABLE, Key: key }));
    },
    keep: async (answer: R) => {
      await ddb.send(new PutItemCommand({
        TableName: TABLE,
        Item: {
          ...key,
          expiresAt: { N: String(expiresAt) },
          ttl: { N: String(Math.ceil((expiresAt + 86_400_000) / 1000)) },
          ...(asked === undefined ? {} : { asked: { S: asked } }),
          answer: { S: JSON.stringify(answer) },
        },
      }));
    },
  };
}
