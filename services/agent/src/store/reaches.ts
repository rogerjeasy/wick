/**
 * The REACH# rows behind "Hold for Sarah" (packages/contracts reach.ts): one
 * per request, filed at her press, moved on by the three-minute timer, and
 * answered by one of the people asked.
 *
 * `send` is a DynamoDBClient's send, injected so the exact requests are
 * tested without AWS. Every write is conditional, because each is a
 * promise: a press asks once, a timer that was overtaken asks nobody, and
 * the first answer is the answer.
 */
import { PutItemCommand, GetItemCommand, QueryCommand, UpdateItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { REACH_SK_PREFIX, isReachAnswer, type CircleRole, type ReachPerson, type ReachRequest } from '@wick/contracts';

type Item = Record<string, AttributeValue>;

export type ReachSend = (command: { readonly input: object }) => Promise<{ Item?: Item | undefined; Items?: Item[] | undefined }>;

/** Long enough to ask "did Mum ask for me yesterday?"; then it is gone. */
const REACH_KEPT_FOR_SEC = 2 * 24 * 60 * 60;

const ROLES: readonly string[] = ['organiser', 'family', 'neighbour'] satisfies readonly CircleRole[];

/** The REACH# row. Pure, so its shape is tested without AWS. */
export function reachItem(request: ReachRequest): Item {
  return {
    pk: { S: `HH#${request.householdId}` },
    sk: { S: `${REACH_SK_PREFIX}${request.reachId}` },
    reachId: { S: request.reachId },
    kind: { S: request.kind },
    askedAt: { N: String(request.askedAt) },
    order: { S: JSON.stringify(request.order) },
    asked: { N: String(request.asked) },
    ...(request.answer
      ? {
          answerKey: { S: request.answer.key },
          answeredAt: { N: String(request.answer.at) },
          answeredBy: { S: request.answer.by },
          answeredByName: { S: request.answer.byName },
        }
      : {}),
    ...(request.doneAt === undefined ? {} : { doneAt: { N: String(request.doneAt) } }),
    ttl: { N: String(Math.floor(request.askedAt / 1000) + REACH_KEPT_FOR_SEC) },
  };
}

function orderFrom(raw: string | undefined): ReachPerson[] | undefined {
  try {
    const parsed: unknown = JSON.parse(raw ?? '');
    if (!Array.isArray(parsed)) return undefined;
    const people: ReachPerson[] = [];
    for (const entry of parsed as Record<string, unknown>[]) {
      if (typeof entry?.userId !== 'string' || typeof entry.name !== 'string' || !ROLES.includes(entry.role as string)) return undefined;
      people.push({ userId: entry.userId, name: entry.name, role: entry.role as CircleRole });
    }
    return people;
  } catch {
    return undefined;
  }
}

/** A request from its row, or undefined for a row that is not one. */
export function reachFromItem(item: Item | undefined): ReachRequest | undefined {
  const householdId = item?.pk?.S?.replace(/^HH#/, '');
  const reachId = item?.reachId?.S;
  const kind = item?.kind?.S;
  const askedAt = Number(item?.askedAt?.N);
  const asked = Number(item?.asked?.N);
  const order = orderFrom(item?.order?.S);
  if (!item || !householdId || !reachId || (kind !== 'ring' && kind !== 'hello') || !Number.isFinite(askedAt) || !Number.isInteger(asked) || !order) return undefined;

  const key = item.answerKey?.S;
  const answeredAt = Number(item.answeredAt?.N);
  const doneAt = Number(item.doneAt?.N);
  return {
    householdId,
    reachId,
    kind,
    askedAt,
    order,
    asked,
    ...(isReachAnswer(key) && Number.isFinite(answeredAt)
      ? { answer: { key, by: item.answeredBy?.S ?? '', byName: item.answeredByName?.S ?? 'Someone', at: answeredAt } }
      : {}),
    ...(Number.isFinite(doneAt) ? { doneAt } : {}),
  };
}

export interface ReachStore {
  /** Conditional write of REACH#<reachId>; false when that press was already carried out. */
  claimOnce(request: ReachRequest): Promise<boolean>;
  load(householdId: string, reachId: string): Promise<ReachRequest | undefined>;
  /** The newest request of the household, or undefined when there has never been one. */
  latest(householdId: string): Promise<ReachRequest | undefined>;
  /** One more person asked — `order` as it now stands. False when somebody has answered, or another timer got there first. */
  advance(householdId: string, reachId: string, from: number, order: readonly ReachPerson[]): Promise<boolean>;
  /** Everyone has been asked in vain. False when somebody answered first. */
  finish(householdId: string, reachId: string, at: number): Promise<boolean>;
  /** The first answer is the answer. False when there already is one, or no such request. */
  answer(householdId: string, reachId: string, answer: NonNullable<ReachRequest['answer']>): Promise<boolean>;
  /** The people the resident allows right now, with when each came to her circle — read at the moment, never cached. */
  listCircle(householdId: string): Promise<readonly (ReachPerson & { readonly since: number })[]>;
}

const refused = (err: unknown): boolean => (err as { name?: string }).name === 'ConditionalCheckFailedException';

export function reachStore(send: ReachSend, table: string): ReachStore {
  const key = (householdId: string, reachId: string) => ({ pk: { S: `HH#${householdId}` }, sk: { S: `${REACH_SK_PREFIX}${reachId}` } });

  /** A conditional write as a yes or no: refused is an answer, anything else is a fault. */
  const whether = async (command: { readonly input: object }): Promise<boolean> => {
    try {
      await send(command);
      return true;
    } catch (err) {
      if (refused(err)) return false;
      throw err;
    }
  };

  return {
    claimOnce: (request) => whether(new PutItemCommand({ TableName: table, Item: reachItem(request), ConditionExpression: 'attribute_not_exists(pk)' })),

    async load(householdId, reachId) {
      // Consistent: whether to ask the next person is decided on it.
      const res = await send(new GetItemCommand({ TableName: table, Key: key(householdId, reachId), ConsistentRead: true }));
      return reachFromItem(res.Item);
    },

    async latest(householdId) {
      const res = await send(new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': { S: `HH#${householdId}` }, ':prefix': { S: REACH_SK_PREFIX } },
        // Ids are moments, so the last key is the latest.
        ScanIndexForward: false,
        Limit: 1,
        ConsistentRead: true,
      }));
      return reachFromItem(res.Items?.[0]);
    },

    advance: (householdId, reachId, from, order) =>
      whether(new UpdateItemCommand({
        TableName: table,
        Key: key(householdId, reachId),
        UpdateExpression: 'SET asked = :next, #order = :order',
        ConditionExpression: 'asked = :from AND attribute_not_exists(answeredAt) AND attribute_not_exists(doneAt)',
        ExpressionAttributeNames: { '#order': 'order' },
        ExpressionAttributeValues: { ':from': { N: String(from) }, ':next': { N: String(from + 1) }, ':order': { S: JSON.stringify(order) } },
      })),

    finish: (householdId, reachId, at) =>
      whether(new UpdateItemCommand({
        TableName: table,
        Key: key(householdId, reachId),
        UpdateExpression: 'SET doneAt = :at',
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(answeredAt) AND attribute_not_exists(doneAt)',
        ExpressionAttributeValues: { ':at': { N: String(at) } },
      })),

    answer: (householdId, reachId, answer) =>
      whether(new UpdateItemCommand({
        TableName: table,
        Key: key(householdId, reachId),
        UpdateExpression: 'SET answerKey = :key, answeredAt = :at, answeredBy = :by, answeredByName = :name',
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(answeredAt)',
        ExpressionAttributeValues: { ':key': { S: answer.key }, ':at': { N: String(answer.at) }, ':by': { S: answer.by }, ':name': { S: answer.byName } },
      })),

    async listCircle(householdId) {
      const res = await send(new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': { S: `HH#${householdId}` }, ':prefix': { S: 'MEM#' } },
        // She may have removed someone a moment ago, and that person must not be asked.
        ConsistentRead: true,
      }));
      const circle: (ReachPerson & { since: number })[] = [];
      for (const row of res.Items ?? []) {
        const userId = row.sk?.S?.replace(/^MEM#/, '');
        const name = row.name?.S;
        const role = row.role?.S;
        if (!userId || !name || row.status?.S !== 'allowed') continue;
        circle.push({ userId, name, role: ROLES.includes(role ?? '') ? (role as CircleRole) : 'family', since: Number(row.requestedAt?.N ?? 0) });
      }
      return circle;
    },
  };
}
