/**
 * The household's one live view, as a single DynamoDB item: HH#<id> / LIVE#active.
 *
 * The bridge runs in its own Lambda (FL-017: the AgentCore microVM has no
 * outbound UDP), so the rules the runtime used to keep in memory live here:
 *
 *   claim         start a session, or join the one already streaming
 *   requestStop   the resident pressed Back — only for the session named
 *   isStopRequested   the bridge polls it; also true once it is no longer the active one
 *   release       the bridge finished; only clears its own claim
 */
import { DeleteItemCommand, GetItemCommand, PutItemCommand, UpdateItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';

export type LiveDdbSend = (command: { readonly input: object }) => Promise<{ Item?: Record<string, AttributeValue> | undefined }>;

export interface LiveClaim {
  readonly joined: boolean;
  readonly sessionId: string;
  readonly endsAt: number;
}

/** Kept an hour past its end for the record, then DynamoDB's TTL removes it. */
const LINGER_S = 3600;

const isConditionFailure = (err: unknown) => (err as { name?: string }).name === 'ConditionalCheckFailedException';

export function liveSessions(send: LiveDdbSend, table: string) {
  const key = (householdId: string) => ({ pk: { S: `HH#${householdId}` }, sk: { S: 'LIVE#active' } });
  const read = async (householdId: string) =>
    (await send(new GetItemCommand({ TableName: table, Key: key(householdId), ConsistentRead: true }))).Item;

  return {
    async claim(householdId: string, sessionId: string, now: number, endsAt: number): Promise<LiveClaim> {
      try {
        await send(new PutItemCommand({
          TableName: table,
          Item: {
            ...key(householdId),
            sessionId: { S: sessionId },
            endsAt: { N: String(endsAt) },
            ttl: { N: String(Math.floor(endsAt / 1000) + LINGER_S) },
          },
          ConditionExpression: 'attribute_not_exists(pk) OR endsAt < :now',
          ExpressionAttributeValues: { ':now': { N: String(now) } },
        }));
        return { joined: false, sessionId, endsAt };
      } catch (err) {
        if (!isConditionFailure(err)) throw err;
      }
      const running = await read(householdId);
      const runningId = running?.sessionId?.S;
      if (!runningId) throw new Error('live_claim_race');
      return { joined: true, sessionId: runningId, endsAt: Number(running.endsAt?.N ?? endsAt) };
    },

    async requestStop(householdId: string, sessionId: string): Promise<boolean> {
      try {
        await send(new UpdateItemCommand({
          TableName: table,
          Key: key(householdId),
          UpdateExpression: 'SET stopRequested = :t',
          ConditionExpression: 'sessionId = :id',
          ExpressionAttributeValues: { ':t': { BOOL: true }, ':id': { S: sessionId } },
        }));
        return true;
      } catch (err) {
        if (isConditionFailure(err)) return false;
        throw err;
      }
    },

    async isStopRequested(householdId: string, sessionId: string): Promise<boolean> {
      const item = await read(householdId);
      return item?.sessionId?.S !== sessionId || item.stopRequested?.BOOL === true;
    },

    async release(householdId: string, sessionId: string): Promise<void> {
      try {
        await send(new DeleteItemCommand({
          TableName: table,
          Key: key(householdId),
          ConditionExpression: 'sessionId = :id',
          ExpressionAttributeValues: { ':id': { S: sessionId } },
        }));
      } catch (err) {
        if (!isConditionFailure(err)) throw err;
      }
    },
  };
}

export type LiveSessions = ReturnType<typeof liveSessions>;
