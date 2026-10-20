/**
 * What the visitor of an arranged visit last said from their visit pass
 * (packages/contracts visitPass.ts), as the door reads it.
 *
 *   HH#<household> / PER#errand:<errandId>   visitorWord: the VisitorWord, as JSON
 *
 * The edge's visit-pass Lambda writes it beside the roster entry, as an
 * attribute of its own, so that a press never rewrites the entry the door
 * matches on (services/edge-device visit-pass.mjs). It is read here once a
 * ring has matched that errand, consistently: the roster itself is cached
 * for a minute (agents/door/rosterCache.ts), and "I'm at the door" may be
 * seconds old.
 *
 * Kept apart from store/errands.ts on purpose: that module is the errand's
 * own, and this is one attribute of one row, read by the door alone.
 *
 * `send` is a DynamoDBClient's send, injected so the request is tested
 * against the table in memory without AWS.
 */
import { GetItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { errandPersonId, readVisitorWord, type VisitorWord } from '@wick/contracts';

export type VisitorWordSend = (command: GetItemCommand) => Promise<{ Item?: Record<string, AttributeValue> | undefined }>;

export interface VisitorWordStore {
  /** The word on that errand's roster row, or undefined: no row, no word, or one that does not read as a word. */
  rosterWord(householdId: string, errandId: string): Promise<VisitorWord | undefined>;
}

export function visitorWordStore(send: VisitorWordSend, table: string): VisitorWordStore {
  return {
    async rosterWord(householdId, errandId) {
      const res = await send(new GetItemCommand({
        TableName: table,
        Key: { pk: { S: `HH#${householdId}` }, sk: { S: `PER#${errandPersonId(errandId)}` } },
        ProjectionExpression: 'visitorWord',
        ConsistentRead: true,
      }));
      const raw = res.Item?.visitorWord?.S;
      if (!raw) return undefined;
      try {
        return readVisitorWord(JSON.parse(raw));
      } catch {
        return undefined;
      }
    },
  };
}
