/**
 * S6 — the DynamoDB write path (see records.ts's header for why this isn't
 * Timestream). A thin, injected wrapper so the door lambda's composition
 * root can supply the real DynamoDBClient while callers stay testable
 * without one. Failure handling is the caller's job (see lambda.ts's
 * routeRingEvent — a Rhythm write failing must never take down the Door
 * Card path that already reached the device).
 *
 * ADD, not PutItem: two events landing in the same bucket concurrently must
 * both count, not clobber each other. `lastSeenAt` is informational only —
 * SET, not ADD — so a stale read is only ever a courtesy, never load-bearing.
 */
import { UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import type { RhythmBucketKey } from './records.js';

export interface RhythmWriter {
  increment(key: RhythmBucketKey, at: number): Promise<void>;
}

interface SendableClient {
  send(command: UpdateItemCommand): Promise<unknown>;
}

/**
 * `simulated`: the counts of a demo home's stand-in doorbell (agents/door/
 * demoDoor.ts), marked like every other row of a demo home.
 */
export function createRhythmWriter(client: SendableClient, tableName: string, options: { readonly simulated?: boolean } = {}): RhythmWriter {
  const simulated = options.simulated === true;
  return {
    async increment(key, at) {
      await client.send(new UpdateItemCommand({
        TableName: tableName,
        Key: { pk: { S: key.pk }, sk: { S: key.sk } },
        UpdateExpression: `ADD #count :incr SET lastSeenAt = :now${simulated ? ', simulated = :simulated' : ''}`,
        ExpressionAttributeNames: { '#count': 'count' },
        ExpressionAttributeValues: {
          ':incr': { N: '1' },
          ':now': { N: String(at) },
          ...(simulated ? { ':simulated': { BOOL: true } } : {}),
        },
      }));
    },
  };
}
