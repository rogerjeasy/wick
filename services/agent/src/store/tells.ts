/**
 * The TELL# rows behind "Shall I tell Sarah?" (agents/tell): one per
 * difference, filed when the resident is asked and answered by their press.
 *
 * `send` is a DynamoDBClient's send, injected so the exact requests are
 * tested without AWS. Every write is conditional, because each is a promise:
 * a difference is asked about once, and the first answer is the answer.
 */
import { DeleteItemCommand, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { TELL_SK_PREFIX, type TellAnswer } from '@wick/contracts';
import { tellRowItem, type TellRow } from '../agents/tell/ask.js';

export type TellSend = (command: { readonly input: object }) => Promise<object>;

export interface TellStore {
  claimOnce(row: TellRow): Promise<boolean>;
  release(householdId: string, differenceId: string): Promise<void>;
  recordAnswer(householdId: string, differenceId: string, answer: TellAnswer, at: number): Promise<boolean>;
}

const refused = (err: unknown): boolean => (err as { name?: string }).name === 'ConditionalCheckFailedException';

export function tellStore(send: TellSend, table: string): TellStore {
  const key = (householdId: string, differenceId: string) => ({ pk: { S: `HH#${householdId}` }, sk: { S: `${TELL_SK_PREFIX}${differenceId}` } });

  return {
    async claimOnce(row) {
      try {
        await send(new PutItemCommand({ TableName: table, Item: tellRowItem(row), ConditionExpression: 'attribute_not_exists(pk)' }));
        return true;
      } catch (err) {
        if (refused(err)) return false;
        throw err;
      }
    },

    async release(householdId, differenceId) {
      try {
        await send(new DeleteItemCommand({ TableName: table, Key: key(householdId, differenceId), ConditionExpression: 'attribute_not_exists(answer)' }));
      } catch (err) {
        if (!refused(err)) throw err;
      }
    },

    async recordAnswer(householdId, differenceId, answer, at) {
      try {
        await send(new UpdateItemCommand({
          TableName: table,
          Key: key(householdId, differenceId),
          UpdateExpression: 'SET answer = :answer, answeredAt = :at',
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(answer)',
          ExpressionAttributeValues: { ':answer': { S: answer }, ':at': { N: String(at) } },
        }));
        return true;
      } catch (err) {
        if (refused(err)) return false;
        throw err;
      }
    },
  };
}
