/**
 * The HEARD# rows (packages/contracts heard.ts): which hours the doorbell was
 * heard from. One UpdateItem per Ring event — the hour is added to a number
 * set, so a busy hour costs the same row — and one Query per stretch read.
 */
import { QueryCommand, UpdateItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { HEARD_KEPT_DAYS, HEARD_SK_PREFIX, heardHourOf, heardHoursOf, heardSk } from '@wick/contracts';

type Item = Record<string, AttributeValue>;
export type HeardSend = (command: QueryCommand | UpdateItemCommand) => Promise<{ Items?: Item[] | undefined; LastEvaluatedKey?: Item | undefined }>;

const utcDay = (at: number): string => new Date(at).toISOString().slice(0, 10);

export interface HeardStore {
  /** The doorbell was heard at `at`. `simulated`: a demo home's stand-in, marked as every row of a demo home is. */
  record(householdId: string, at: number, options?: { readonly simulated?: boolean }): Promise<void>;
  /** Every hour heard from `from` to `to`, as hour starts, oldest first. */
  hours(householdId: string, from: number, to: number): Promise<number[]>;
}

/** The hours on a page of HEARD# rows. */
export function hoursOfRows(items: readonly Item[]): number[] {
  return items.flatMap((item) => heardHoursOf(item.sk?.S, item.hours?.NS)).sort((a, b) => a - b);
}

export function heardStore(send: HeardSend, table: string): HeardStore {
  return {
    async record(householdId, at, options = {}) {
      await send(new UpdateItemCommand({
        TableName: table,
        Key: { pk: { S: `HH#${householdId}` }, sk: { S: heardSk(at) } },
        UpdateExpression: `ADD #hours :hour SET #ttl = :ttl${options.simulated ? ', simulated = :simulated' : ''}`,
        ExpressionAttributeNames: { '#hours': 'hours', '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':hour': { NS: [String(heardHourOf(at))] },
          ':ttl': { N: String(Math.floor(at / 1000) + HEARD_KEPT_DAYS * 86_400) },
          ...(options.simulated ? { ':simulated': { BOOL: true } } : {}),
        },
      }));
    },

    async hours(householdId, from, to) {
      const items: Item[] = [];
      let startKey: Item | undefined;
      do {
        const page = await send(new QueryCommand({
          TableName: table,
          KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
          ExpressionAttributeValues: {
            ':pk': { S: `HH#${householdId}` },
            ':from': { S: `${HEARD_SK_PREFIX}${utcDay(from)}` },
            ':to': { S: `${HEARD_SK_PREFIX}${utcDay(to)}` },
          },
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }));
        items.push(...(page.Items ?? []));
        startKey = page.LastEvaluatedKey;
      } while (startKey);
      return hoursOfRows(items).filter((h) => h + 3_600_000 > from && h <= to);
    },
  };
}
