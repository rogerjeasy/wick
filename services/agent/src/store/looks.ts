/**
 * The two things "Ask Sarah to look" needs from the table: the once-only
 * LOOK# row for a door card, and the family circle as it stands at the
 * press (agents/door/askFamily.ts).
 *
 * `send` is a DynamoDBClient's send, injected so the exact requests are
 * tested without AWS. The circle is read consistently: the resident may
 * have removed someone a moment ago, and that person must not be asked.
 */
import { PutItemCommand, QueryCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { allowedFamily, lookRequestItem, type FamilyMember, type LookRequest } from '../agents/door/askFamily.js';

export type LookSend = (command: { readonly input: object }) => Promise<{ Items?: Record<string, AttributeValue>[] | undefined }>;

export interface LookStore {
  claimOnce(request: LookRequest): Promise<boolean>;
  listFamily(householdId: string): Promise<readonly FamilyMember[]>;
}

export function lookStore(send: LookSend, table: string): LookStore {
  return {
    async claimOnce(request) {
      try {
        await send(new PutItemCommand({
          TableName: table,
          Item: lookRequestItem(request),
          ConditionExpression: 'attribute_not_exists(pk)',
        }));
        return true;
      } catch (err) {
        if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
        throw err;
      }
    },

    async listFamily(householdId) {
      const res = await send(new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': { S: `HH#${householdId}` }, ':prefix': { S: 'MEM#' } },
        ConsistentRead: true,
      }));
      return allowedFamily(res.Items ?? []);
    },
  };
}
