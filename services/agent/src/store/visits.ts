/**
 * The VISIT# rows behind "The visit, witnessed" (packages/contracts
 * visit.ts): one per visit of a regular visitor, opened when the door sees
 * them arrive, given a leaving when the door next sees somebody, put to
 * the resident, and answered by her press.
 *
 * `send` is a DynamoDBClient's send, injected so the exact requests are
 * tested without AWS. Every write is conditional, because each is a
 * promise: a visit is opened once, its leaving only ever moves later and
 * never after she has been asked, she is asked once, and her first answer
 * is the answer.
 */
import { PutItemCommand, QueryCommand, UpdateItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { VISIT_SK_PREFIX, padTimestamp, parseVisitId, visitSk, type Visit, type VisitAnswer } from '@wick/contracts';

type Item = Record<string, AttributeValue>;

export type VisitSend = (command: { readonly input: object }) => Promise<{ Items?: Item[] | undefined; Attributes?: Item | undefined }>;

/** Thirteen months: it is a record, and a year of visits is what a record is for. */
const VISIT_KEPT_FOR_SEC = 400 * 24 * 60 * 60;

const num = (value: number): AttributeValue => ({ N: String(value) });
const time = (attribute: AttributeValue | undefined): number | undefined => {
  const value = Number(attribute?.N);
  return attribute?.N !== undefined && Number.isFinite(value) ? value : undefined;
};

/** The VISIT# row. Pure, so its shape is tested without AWS. */
export function visitItem(visit: Visit): Item {
  return {
    pk: { S: `HH#${visit.householdId}` },
    sk: { S: visitSk(visit) },
    personId: { S: visit.personId },
    name: { S: visit.name },
    arrivedAt: num(visit.arrivedAt),
    ...(visit.leftAt === undefined ? {} : { leftAt: num(visit.leftAt) }),
    ...(visit.askedAt === undefined ? {} : { askedAt: num(visit.askedAt) }),
    ...(visit.answer === undefined ? {} : { answer: { S: visit.answer } }),
    ...(visit.answeredAt === undefined ? {} : { answeredAt: num(visit.answeredAt) }),
    ...(visit.simulated ? { simulated: { BOOL: true } } : {}),
    ttl: num(Math.floor(visit.arrivedAt / 1000) + VISIT_KEPT_FOR_SEC),
  };
}

/** A visit from its row, or undefined for a row that is not one. */
export function visitFromItem(item: Item | undefined): Visit | undefined {
  const householdId = item?.pk?.S?.replace(/^HH#/, '');
  const personId = item?.personId?.S;
  const name = item?.name?.S;
  const arrivedAt = time(item?.arrivedAt);
  if (!item || !householdId || !personId || !name || arrivedAt === undefined) return undefined;
  const leftAt = time(item.leftAt);
  const askedAt = time(item.askedAt);
  const answeredAt = time(item.answeredAt);
  const answer = item.answer?.S;
  return {
    householdId,
    personId,
    name,
    arrivedAt,
    ...(leftAt === undefined ? {} : { leftAt }),
    ...(askedAt === undefined ? {} : { askedAt }),
    ...(answer === 'confirmed' || answer === 'disputed' ? { answer } : {}),
    ...(answeredAt === undefined ? {} : { answeredAt }),
    ...(item.simulated?.BOOL ? { simulated: true } : {}),
  };
}

export interface VisitStore {
  /** Conditional write of the row; false when that visit is already open. */
  open(visit: Visit): Promise<boolean>;
  /** The household's visits that began at or after `since`, in the order they happened. */
  recent(householdId: string, since: number): Promise<Visit[]>;
  /** A later leaving. False when it is not later, or she has been asked. */
  setLeft(visit: Visit, leftAt: number): Promise<boolean>;
  /** She is about to be asked. False when she already was. */
  claimAsk(visit: Visit, at: number): Promise<boolean>;
  /** The card could not be sent: she has not been asked after all. Never undoes an answer. */
  releaseAsk(visit: Visit): Promise<void>;
  /** Her answer, once — and the visit as it then stands. Undefined when there is no open question to answer. */
  answer(householdId: string, id: string, answer: VisitAnswer, at: number): Promise<Visit | undefined>;
}

const refused = (err: unknown): boolean => (err as { name?: string }).name === 'ConditionalCheckFailedException';

export function visitStore(send: VisitSend, table: string): VisitStore {
  const keyOf = (visit: Pick<Visit, 'householdId' | 'arrivedAt' | 'personId'>) => ({ pk: { S: `HH#${visit.householdId}` }, sk: { S: visitSk(visit) } });

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
    open: (visit) => whether(new PutItemCommand({ TableName: table, Item: visitItem(visit), ConditionExpression: 'attribute_not_exists(pk)' })),

    async recent(householdId, since) {
      const res = await send(new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':pk': { S: `HH#${householdId}` },
          ':from': { S: `${VISIT_SK_PREFIX}${padTimestamp(since)}` },
          ':to': { S: `${VISIT_SK_PREFIX}999999999999999#￿` },
        },
        // Whether to open a visit, or to ask about one, is decided on what is read.
        ConsistentRead: true,
      }));
      return (res.Items ?? []).flatMap((item) => {
        const visit = visitFromItem(item);
        return visit ? [visit] : [];
      });
    },

    setLeft: (visit, leftAt) =>
      whether(new UpdateItemCommand({
        TableName: table,
        Key: keyOf(visit),
        UpdateExpression: 'SET leftAt = :at',
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(askedAt) AND (attribute_not_exists(leftAt) OR leftAt < :at)',
        ExpressionAttributeValues: { ':at': num(leftAt) },
      })),

    claimAsk: (visit, at) =>
      whether(new UpdateItemCommand({
        TableName: table,
        Key: keyOf(visit),
        UpdateExpression: 'SET askedAt = :at',
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(askedAt)',
        ExpressionAttributeValues: { ':at': num(at) },
      })),

    async releaseAsk(visit) {
      await whether(new UpdateItemCommand({
        TableName: table,
        Key: keyOf(visit),
        UpdateExpression: 'REMOVE askedAt',
        ConditionExpression: 'attribute_not_exists(answer)',
      }));
    },

    async answer(householdId, id, answer, at) {
      const parsed = parseVisitId(id);
      if (!parsed) return undefined;
      try {
        const res = await send(new UpdateItemCommand({
          TableName: table,
          Key: keyOf({ householdId, ...parsed }),
          UpdateExpression: 'SET answer = :answer, answeredAt = :at',
          // Only a question that was put can be answered, and only once.
          ConditionExpression: 'attribute_exists(askedAt) AND attribute_not_exists(answer)',
          ExpressionAttributeValues: { ':answer': { S: answer }, ':at': num(at) },
          ReturnValues: 'ALL_NEW',
        }));
        return visitFromItem(res.Attributes);
      } catch (err) {
        if (refused(err)) return undefined;
        throw err;
      }
    },
  };
}
