/**
 * Whether the resident allows a member right now: their MEM# row, read
 * again at every step of an errand (INV-9), the way the Wick server's
 * `gated` asks at every tool call. An errand stands on its author's word,
 * like the roster entry it put on the door, and only for as long as she
 * still allows them.
 */
import { GetItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';

export type AllowedSend = (command: { readonly input: object }) => Promise<{ Item?: Record<string, AttributeValue> | undefined }>;

export function memberAllowed(send: AllowedSend, table: string): (householdId: string, userId: string) => Promise<boolean> {
  return async (householdId, userId) => {
    const res = await send(new GetItemCommand({
      TableName: table,
      Key: { pk: { S: `HH#${householdId}` }, sk: { S: `MEM#${userId}` } },
      // `status` is a word DynamoDB keeps for itself.
      ProjectionExpression: '#s',
      ExpressionAttributeNames: { '#s': 'status' },
      // Her press may have come a moment ago.
      ConsistentRead: true,
    }));
    return res.Item?.status?.S === 'allowed';
  };
}
