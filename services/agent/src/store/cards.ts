/**
 * The CARD# reads and the CHIME# once-only claim the door-action graph needs.
 *
 * `send` is a DynamoDBClient's send, injected so the exact requests are
 * tested without AWS. The read is consistent: a press can arrive a second
 * after the card was written, and an eventually consistent miss there would
 * tell the resident there was no card.
 */
import { GetItemCommand, PutItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import type { QueuedCard } from '@wick/contracts';
import type { LiveTarget } from '../live/gate.js';

export type DdbSend = (command: { readonly input: object }) => Promise<{ Item?: Record<string, AttributeValue> | undefined }>;

const DAY_S = 24 * 60 * 60;

export interface CardStore {
  loadCard(householdId: string, cardId: string): Promise<QueuedCard | undefined>;
  claimOnce(householdId: string, cardId: string): Promise<boolean>;
  loadLiveTarget(householdId: string, cardId: string): Promise<LiveTarget | undefined>;
}

export function cardStore(send: DdbSend, table: string, now: () => number = Date.now): CardStore {
  const getCardItem = async (householdId: string, cardId: string) =>
    (await send(new GetItemCommand({
      TableName: table,
      Key: { pk: { S: `HH#${householdId}` }, sk: { S: `CARD#${cardId}` } },
      ConsistentRead: true,
    }))).Item;

  return {
    async loadCard(householdId, cardId) {
      const raw = (await getCardItem(householdId, cardId))?.data?.S;
      return raw ? (JSON.parse(raw) as QueuedCard) : undefined;
    },

    async loadLiveTarget(householdId, cardId) {
      const item = await getCardItem(householdId, cardId);
      const raw = item?.data?.S;
      if (!raw) return undefined;
      const ringDeviceId = item.ringDeviceId?.S;
      return { queued: JSON.parse(raw) as QueuedCard, ...(ringDeviceId ? { ringDeviceId } : {}) };
    },

    async claimOnce(householdId, cardId) {
      try {
        await send(new PutItemCommand({
          TableName: table,
          Item: {
            pk: { S: `HH#${householdId}` },
            sk: { S: `CHIME#${cardId}` },
            ttl: { N: String(Math.floor(now() / 1000) + DAY_S) },
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        }));
        return true;
      } catch (err) {
        if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
        throw err;
      }
    },
  };
}
