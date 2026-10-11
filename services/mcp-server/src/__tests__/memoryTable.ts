/**
 * Test-only: a table in memory that answers the few DynamoDB requests the
 * tools and the demo home make, so the whole server can be asked real
 * questions with no AWS (devServer.ts, and the end-to-end tests).
 *
 * It understands exactly what this server sends — PutItem, GetItem, and a
 * Query on `pk` with a `BETWEEN` or `begins_with` on `sk`, an optional
 * filter of `name = :value` terms joined by AND, `ScanIndexForward` and
 * `Limit` — and throws on anything else, so a new kind of request fails
 * loudly here rather than quietly returning nothing.
 */
import type { AttributeValue, DynamoDBClient } from '@aws-sdk/client-dynamodb';

type Item = Record<string, AttributeValue>;

interface Request {
  readonly constructor: { readonly name: string };
  readonly input: {
    readonly Item?: Item;
    readonly Key?: Item;
    readonly KeyConditionExpression?: string;
    readonly FilterExpression?: string;
    readonly ExpressionAttributeNames?: Record<string, string>;
    readonly ExpressionAttributeValues?: Record<string, AttributeValue>;
    readonly ScanIndexForward?: boolean;
    readonly Limit?: number;
  };
}

export interface MemoryTable {
  readonly ddb: DynamoDBClient;
  put(item: Item): void;
  /** Every row of one partition, in sort-key order. */
  rows(pk: string): Item[];
}

const text = (value: AttributeValue | undefined): string => value?.S ?? '';

export function createMemoryTable(): MemoryTable {
  const items = new Map<string, Item>();
  const keyOf = (item: Item): string => `${text(item.pk)}|${text(item.sk)}`;

  const rows = (pk: string): Item[] =>
    [...items.values()].filter((i) => text(i.pk) === pk).sort((a, b) => (text(a.sk) < text(b.sk) ? -1 : 1));

  const query = (input: Request['input']): { Items: Item[] } => {
    const values = input.ExpressionAttributeValues ?? {};
    const names = input.ExpressionAttributeNames ?? {};
    const condition = input.KeyConditionExpression ?? '';

    let matches: (sk: string) => boolean;
    if (/^pk = :pk AND sk BETWEEN :from AND :to$/.test(condition)) {
      matches = (sk) => sk >= text(values[':from']) && sk <= text(values[':to']);
    } else if (/^pk = :pk AND begins_with\(sk, :prefix\)$/.test(condition)) {
      matches = (sk) => sk.startsWith(text(values[':prefix']));
    } else {
      throw new Error(`memoryTable: unsupported key condition "${condition}"`);
    }

    const terms = (input.FilterExpression ?? '').split(' AND ').filter(Boolean).map((term) => {
      const m = /^(#?\w+) = (:\w+)$/.exec(term.trim());
      if (!m) throw new Error(`memoryTable: unsupported filter "${term}"`);
      return { attribute: names[m[1]!] ?? m[1]!, value: text(values[m[2]!]) };
    });

    let found = rows(text(values[':pk'])).filter((i) => matches(text(i.sk)));
    if (input.ScanIndexForward === false) found = found.reverse();
    // As DynamoDB does it: the limit is on rows read, before the filter.
    if (input.Limit !== undefined) found = found.slice(0, input.Limit);
    return { Items: found.filter((i) => terms.every((t) => text(i[t.attribute]) === t.value)) };
  };

  const send = async (command: Request): Promise<object> => {
    const { input } = command;
    switch (command.constructor.name) {
      case 'PutItemCommand':
        items.set(keyOf(input.Item!), input.Item!);
        return {};
      case 'GetItemCommand':
        return { Item: items.get(keyOf(input.Key!)) };
      case 'QueryCommand':
        return query(input);
      case 'TransactWriteItemsCommand': {
        // All or nothing, as DynamoDB does it. Only the conditions the server uses are understood.
        const writes = (input as unknown as { TransactItems: { Put?: { Item: Item }; Delete?: { Key: Item }; Update?: { Key: Item; ConditionExpression?: string; ExpressionAttributeValues?: Record<string, AttributeValue> } }[] }).TransactItems;
        for (const { Update } of writes) {
          if (!Update) continue;
          const held = items.get(keyOf(Update.Key))?.version?.N;
          const seen = Update.ExpressionAttributeValues?.[':seen']?.N;
          const ok = Update.ConditionExpression === 'attribute_not_exists(version)' ? held === undefined : held === seen;
          if (!ok) throw Object.assign(new Error('Transaction cancelled'), { name: 'TransactionCanceledException' });
        }
        for (const { Put, Delete, Update } of writes) {
          if (Put) items.set(keyOf(Put.Item), Put.Item);
          if (Delete) items.delete(keyOf(Delete.Key));
          if (Update) items.set(keyOf(Update.Key), { ...Update.Key, version: Update.ExpressionAttributeValues![':next']! });
        }
        return {};
      }
      default:
        throw new Error(`memoryTable: unsupported request ${command.constructor.name}`);
    }
  };

  return { ddb: { send } as unknown as DynamoDBClient, put: (item) => void items.set(keyOf(item), item), rows };
}
