/**
 * The browsers that asked to be told (Web Push), kept so the agent plane
 * can nudge them when the resident presses "Ask … to look" and the family
 * app is not open (services/agent egress.ts nudgeFamily).
 *
 * A browser hands over three things: the address of its push service, and
 * a public key and a secret that only it can decrypt for. They are kept
 * under the person the access token is for — never under a household, and
 * never under a name from the request (INV-8). Whether that person may be
 * nudged about a home is decided where the nudge is sent, from the circle
 * as it stands then (INV-9); a row here is permission to reach a browser,
 * not to know anything.
 *
 * The public half of Wick's own signing key (VAPID) is a row,
 * `CONFIG#push` / `VAPID`, written with the secret by
 * infra/bootstrap/generate-push-keys.sh. It is not a secret, and reading it
 * from the table means the server needs no new permission and no new
 * setting to offer this.
 */
import { createHash } from 'node:crypto';
import { DeleteItemCommand, GetItemCommand, PutItemCommand, QueryCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PUSH_SK_PREFIX, isPushServiceUrl } from '@wick/contracts';

export interface BrowserSubscription {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

export interface PushStore {
  /** Wick's public signing key, or undefined where the deployment has none: then nothing is offered. */
  publicKey(): Promise<string | undefined>;
  save(userId: string, subscription: BrowserSubscription, now: number): Promise<void>;
  remove(userId: string, endpoint: string): Promise<void>;
  /** The browsers kept for this person, oldest first: what their export says about them (accounts/myData.ts). */
  list(userId: string): Promise<{ readonly endpoint: string; readonly savedAt: number }[]>;
  /** Every browser kept for this person: their account is being deleted. */
  removeAll(userId: string): Promise<void>;
}

/** A laptop, a telephone, a tablet and two to spare. One press at the door nudges at most this many per person. */
export const MAX_BROWSERS_PER_PERSON = 5;

const MAX_ENDPOINT_CHARS = 2048;
/** A browser's P-256 public key is 65 bytes and its secret 16: 87 and 22 characters of base64url, with room for padding. */
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const isKey = (value: unknown, max: number): value is string => typeof value === 'string' && value.length >= 16 && value.length <= max && BASE64URL.test(value);

/** What `PushSubscription.toJSON()` gives, checked; undefined for anything else. */
export function parseSubscription(body: unknown): BrowserSubscription | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { endpoint, keys } = body as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof endpoint !== 'string' || endpoint.length > MAX_ENDPOINT_CHARS || !isPushServiceUrl(endpoint)) return undefined;
  if (typeof keys !== 'object' || keys === null || !isKey(keys.p256dh, 128) || !isKey(keys.auth, 44)) return undefined;
  return { endpoint, p256dh: keys.p256dh, auth: keys.auth };
}

/** One row per browser. The address is long and is itself the capability, so the key is a digest of it. */
export function pushSubscriptionSk(endpoint: string): string {
  return `${PUSH_SK_PREFIX}${createHash('sha256').update(endpoint).digest('base64url').slice(0, 22)}`;
}

export function createPushStore(ddb: DynamoDBClient, table: string): PushStore {
  const userPk = (userId: string) => ({ S: `USER#${userId}` });
  /** A person's browsers, as rows. At most MAX_BROWSERS_PER_PERSON and a moment's extra: one page holds them. */
  const held = async (userId: string) =>
    (await ddb.send(new QueryCommand({
      TableName: table,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': userPk(userId), ':prefix': { S: PUSH_SK_PREFIX } },
    }))).Items ?? [];

  return {
    async publicKey() {
      const res = await ddb.send(new GetItemCommand({ TableName: table, Key: { pk: { S: 'CONFIG#push' }, sk: { S: 'VAPID' } } }));
      return res.Item?.publicKey?.S || undefined;
    },

    async save(userId, subscription, now) {
      await ddb.send(new PutItemCommand({
        TableName: table,
        Item: {
          pk: userPk(userId),
          sk: { S: pushSubscriptionSk(subscription.endpoint) },
          endpoint: { S: subscription.endpoint },
          p256dh: { S: subscription.p256dh },
          auth: { S: subscription.auth },
          savedAt: { N: String(now) },
        },
      }));

      const held = await ddb.send(new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': userPk(userId), ':prefix': { S: PUSH_SK_PREFIX } },
      }));
      const oldestFirst = (held.Items ?? []).sort((a, b) => Number(a.savedAt?.N ?? 0) - Number(b.savedAt?.N ?? 0));
      for (const row of oldestFirst.slice(0, Math.max(0, oldestFirst.length - MAX_BROWSERS_PER_PERSON))) {
        if (row.sk?.S) await ddb.send(new DeleteItemCommand({ TableName: table, Key: { pk: userPk(userId), sk: { S: row.sk.S } } }));
      }
    },

    async remove(userId, endpoint) {
      await ddb.send(new DeleteItemCommand({ TableName: table, Key: { pk: userPk(userId), sk: { S: pushSubscriptionSk(endpoint) } } }));
    },

    async list(userId) {
      return (await held(userId))
        .flatMap((row) => (row.endpoint?.S ? [{ endpoint: row.endpoint.S, savedAt: Number(row.savedAt?.N ?? 0) }] : []))
        .sort((a, b) => a.savedAt - b.savedAt);
    },

    async removeAll(userId) {
      for (const row of await held(userId)) {
        if (row.sk?.S) await ddb.send(new DeleteItemCommand({ TableName: table, Key: { pk: userPk(userId), sk: { S: row.sk.S } } }));
      }
    },
  };
}
