/**
 * Test-only: a table in memory that answers the few DynamoDB requests the
 * tools and the demo home make, so the whole server can be asked real
 * questions with no AWS (devServer.ts, and the end-to-end tests).
 *
 * It understands exactly what this server sends — PutItem (with the one
 * condition the door answer uses) and UpdateItem (a `SET` of plain values or
 * `if_not_exists`, or a `REMOVE` of attributes, under a condition of `attribute_exists`,
 * `attribute_not_exists` and comparisons joined by AND, with OR inside
 * brackets), GetItem, DeleteItem, and a
 * Query on `pk` with a `BETWEEN` or `begins_with` on `sk`, an optional
 * filter of `name = :value` terms joined by AND, `ScanIndexForward` and
 * `Limit` — and throws on anything else, so a new kind of request fails
 * loudly here rather than quietly returning nothing.
 *
 * UpdateItem is here for watching together: the television's half of a
 * session is written by the edge's own conditional updates
 * (services/edge-device/lambda/watch-together.mjs), and a test or the dev
 * server that runs those very updates against this table is testing the
 * conditions themselves.
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

type Names = Record<string, string>;
type Values = Record<string, AttributeValue>;

/** Splits on a separator wherever it is not inside brackets. */
function splitOutside(expression: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < expression.length; i += 1) {
    if (expression[i] === '(') depth += 1;
    else if (expression[i] === ')') depth -= 1;
    else if (depth === 0 && expression.startsWith(separator, i)) {
      parts.push(expression.slice(from, i));
      from = i + separator.length;
    }
  }
  return [...parts, expression.slice(from)].map((part) => part.trim());
}

const compare = (held: AttributeValue | undefined, wanted: AttributeValue | undefined): number | undefined => {
  if (held?.N !== undefined && wanted?.N !== undefined) return Number(held.N) - Number(wanted.N);
  if (held?.S !== undefined && wanted?.S !== undefined) return held.S < wanted.S ? -1 : held.S > wanted.S ? 1 : 0;
  return undefined;
};

/** Whether a ConditionExpression holds for the row as it is held (undefined: there is no such row). */
function conditionHolds(expression: string | undefined, held: Item | undefined, names: Names, values: Values): boolean {
  if (expression === undefined) return true;
  const term = (raw: string): boolean => {
    if (raw.startsWith('(') && raw.endsWith(')')) return splitOutside(raw.slice(1, -1), ' OR ').some(term);
    const exists = /^attribute_(not_)?exists\((#?\w+)\)$/.exec(raw);
    if (exists) return (held?.[names[exists[2]!] ?? exists[2]!] !== undefined) === (exists[1] === undefined);
    const compared = /^(#?\w+) (=|<>|<=|>=|<|>) (:\w+)$/.exec(raw);
    if (!compared) throw new Error(`memoryTable: unsupported condition "${raw}"`);
    const order = compare(held?.[names[compared[1]!] ?? compared[1]!], values[compared[3]!]);
    if (order === undefined) return compared[2] === '<>';
    return { '=': order === 0, '<>': order !== 0, '<=': order <= 0, '>=': order >= 0, '<': order < 0, '>': order > 0 }[compared[2]!]!;
  };
  return splitOutside(expression, ' AND ').every(term);
}

/** The row an UpdateExpression of `SET a = :v, b = if_not_exists(b, :w)` leaves — or of `REMOVE a, b`. */
function applySet(expression: string, held: Item, names: Names, values: Values): Item {
  if (expression.startsWith('REMOVE ')) {
    // Taking an attribute off again (the visit store's releaseAsk): names only, nothing to evaluate.
    const next = { ...held };
    for (const raw of expression.slice(7).split(',')) {
      const attribute = raw.trim();
      if (!/^#?\w+$/.test(attribute)) throw new Error(`memoryTable: unsupported update "${expression}"`);
      delete next[names[attribute] ?? attribute];
    }
    return next;
  }
  if (!expression.startsWith('SET ')) throw new Error(`memoryTable: unsupported update "${expression}"`);
  const next = { ...held };
  for (const assignment of splitOutside(expression.slice(4), ',')) {
    const m = /^(#?\w+) = (?:(:\w+)|if_not_exists\((#?\w+), (:\w+)\))$/.exec(assignment);
    if (!m) throw new Error(`memoryTable: unsupported update "${assignment}"`);
    const name = names[m[1]!] ?? m[1]!;
    if (m[2]) next[name] = values[m[2]]!;
    else if (held[names[m[3]!] ?? m[3]!] === undefined) next[name] = values[m[4]!]!;
  }
  return next;
}

const conditionFailed = (): Error => Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });

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
      case 'PutItemCommand': {
        const held = items.get(keyOf(input.Item!));
        const condition = (input as { ConditionExpression?: string }).ConditionExpression;
        if (!conditionHolds(condition, held, input.ExpressionAttributeNames ?? {}, input.ExpressionAttributeValues ?? {})) throw conditionFailed();
        items.set(keyOf(input.Item!), input.Item!);
        return {};
      }
      case 'UpdateItemCommand': {
        const update = input as Request['input'] & { UpdateExpression: string; ConditionExpression?: string; ReturnValues?: string };
        const names = update.ExpressionAttributeNames ?? {};
        const values = update.ExpressionAttributeValues ?? {};
        const held = items.get(keyOf(update.Key!));
        if (!conditionHolds(update.ConditionExpression, held, names, values)) throw conditionFailed();
        const next = applySet(update.UpdateExpression, held ?? update.Key!, names, values);
        items.set(keyOf(next), next);
        return update.ReturnValues === 'ALL_NEW' ? { Attributes: next } : {};
      }
      case 'GetItemCommand':
        return { Item: items.get(keyOf(input.Key!)) };
      case 'DeleteItemCommand':
        items.delete(keyOf(input.Key!));
        return {};
      case 'QueryCommand':
        return query(input);
      case 'TransactWriteItemsCommand': {
        // All or nothing, as DynamoDB does it. Only the conditions the server uses are understood.
        type Guarded = { Key?: Item; Item?: Item; ConditionExpression?: string; ExpressionAttributeValues?: Record<string, AttributeValue> };
        const writes = (input as unknown as { TransactItems: { Put?: Guarded; Delete?: Guarded; Update?: Guarded; ConditionCheck?: Guarded }[] }).TransactItems;
        const holds = (op: Guarded): boolean => {
          const held = items.get(keyOf(op.Key ?? op.Item!));
          const values = op.ExpressionAttributeValues ?? {};
          switch (op.ConditionExpression) {
            case undefined: return true;
            case 'attribute_not_exists(pk)': return held === undefined;
            case 'attribute_not_exists(version)': return held?.version === undefined;
            case 'version = :seen': return held?.version?.N === values[':seen']?.N;
            case '#d = :seen': return held?.data?.S === values[':seen']?.S;
            case 'attribute_not_exists(pk) OR #s <> :allowed': return held === undefined || held.status?.S !== values[':allowed']?.S;
            // Anything else is read as an UpdateItem's condition is; what that cannot read still throws.
            default: return conditionHolds(op.ConditionExpression, held, {}, values);
          }
        };
        if (!writes.every((w) => holds((w.Put ?? w.Delete ?? w.Update ?? w.ConditionCheck)!))) {
          throw Object.assign(new Error('Transaction cancelled'), { name: 'TransactionCanceledException' });
        }
        for (const { Put, Delete, Update } of writes) {
          if (Put) items.set(keyOf(Put.Item!), Put.Item!);
          if (Delete) items.delete(keyOf(Delete.Key!));
          if (Update) items.set(keyOf(Update.Key!), { ...Update.Key!, version: Update.ExpressionAttributeValues![':next']! });
        }
        return {};
      }
      default:
        throw new Error(`memoryTable: unsupported request ${command.constructor.name}`);
    }
  };

  return { ddb: { send } as unknown as DynamoDBClient, put: (item) => void items.set(keyOf(item), item), rows };
}
