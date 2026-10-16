/**
 * The ERRAND# rows behind a visit errand (packages/contracts errand.ts), and
 * the roster entry each one puts on the door.
 *
 *   HH#<household> / ERRAND#<errandId>         the errand, and how far it has got
 *   HH#<household> / PER#errand:<errandId>     whom the door is told to expect
 *
 * Read and written by two planes: the Wick server's tools make, list and
 * cancel an errand (arrange_visit, get_errands, cancel_errand), and the
 * errand Lambdas carry it out (agents/errand). One module, so the two agree
 * on every attribute.
 *
 * Every step is a conditional write from the statuses it may follow, because
 * each is a promise: a cancelled errand is never reminded, a visit that rang
 * is never then said to have had nobody, and the door's token is handed back
 * once. The token is kept on the row for the door Lambda alone; `list`
 * never returns it, and nothing here returns it to the family.
 *
 * `send` is a DynamoDBClient's send, injected so the requests are tested
 * against the table in memory without AWS.
 */
import { DeleteItemCommand, GetItemCommand, QueryCommand, TransactWriteItemsCommand, UpdateItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { ERRAND_SK_PREFIX, ERRAND_STATUSES, errandPersonId, errandSk, type Errand, type ErrandStatus, type RosterEntry } from '@wick/contracts';

type Item = Record<string, AttributeValue>;

export type ErrandSend = (command: { readonly input: object }) => Promise<{ Item?: Item | undefined; Items?: Item[] | undefined }>;

const DAY_MS = 86_400_000;
/** The door forgets the visitor two days after the window, as it forgets an announced visit (expect_visit.ts). */
const ROSTER_KEPT_MS = 2 * DAY_MS;
/** The errand is kept a week past its window: long enough to be asked "how did it go?". */
const ERRAND_KEPT_MS = 8 * DAY_MS;

/** An errand as it is held: what the steps learned on the way, and the door's token while it waits. */
export interface HeldErrand extends Errand {
  /** When her reminder was put on the television. */
  readonly remindedAt?: number;
  /** The door card of the ring that ended the wait. */
  readonly cardId?: string;
  /** Step Functions' task token while the door waits (agents/errand). Never shown to anyone. */
  readonly taskToken?: string;
}

/** What a step may learn and keep on the row. */
export interface ErrandFacts {
  readonly remindedAt?: number;
  readonly rangAt?: number;
  readonly cardId?: string;
  readonly taskToken?: string;
}

const num = (value: number): AttributeValue => ({ N: String(value) });
const numberOf = (attribute: AttributeValue | undefined): number | undefined => {
  const value = Number(attribute?.N);
  return attribute?.N !== undefined && Number.isFinite(value) ? value : undefined;
};
const isStatus = (value: unknown): value is ErrandStatus => typeof value === 'string' && (ERRAND_STATUSES as readonly string[]).includes(value);

const windowEnd = (errand: Pick<Errand, 'at' | 'windowMinutes'>): number => errand.at + errand.windowMinutes * 60_000;
const seconds = (ms: number): AttributeValue => num(Math.floor(ms / 1000));

const keyOf = (householdId: string, sk: string) => ({ pk: { S: `HH#${householdId}` }, sk: { S: sk } });

/** The ERRAND# row. Pure, so its shape is tested without AWS. */
export function errandItem(errand: Errand): Item {
  return {
    ...keyOf(errand.householdId, errandSk(errand.errandId)),
    errandId: { S: errand.errandId },
    createdBy: { S: errand.createdBy },
    createdByName: { S: errand.createdByName },
    who: { S: errand.who },
    at: num(errand.at),
    windowMinutes: num(errand.windowMinutes),
    ...(errand.remindAt === undefined ? {} : { remindAt: num(errand.remindAt) }),
    tellMe: { BOOL: errand.tellMe },
    status: { S: errand.status },
    ...(errand.rangAt === undefined ? {} : { rangAt: num(errand.rangAt) }),
    ...(errand.executionArn === undefined ? {} : { executionArn: { S: errand.executionArn } }),
    createdAt: num(errand.createdAt),
    ttl: seconds(windowEnd(errand) + ERRAND_KEPT_MS),
  };
}

/** The roster entry the door matches by its time (agents/door/roster.ts), standing on the member's word. */
export function errandRosterEntry(errand: Errand): RosterEntry {
  return {
    personId: errandPersonId(errand.errandId),
    name: errand.who,
    expectedOnce: { at: errand.at, windowMin: errand.windowMinutes },
    // Off the roster the moment the resident stops allowing them (roster.ts stillWelcome).
    addedBy: errand.createdBy,
    arrangedByName: errand.createdByName,
  };
}

export function errandRosterItem(errand: Errand): Item {
  return {
    ...keyOf(errand.householdId, `PER#${errandPersonId(errand.errandId)}`),
    data: { S: JSON.stringify(errandRosterEntry(errand)) },
    ttl: seconds(windowEnd(errand) + ROSTER_KEPT_MS),
  };
}

/** An errand from its row, or undefined for a row that is not one. The token is left on only where `withToken`. */
export function errandFromItem(item: Item | undefined, withToken = false): HeldErrand | undefined {
  const householdId = item?.pk?.S?.replace(/^HH#/, '');
  const errandId = item?.errandId?.S;
  const createdBy = item?.createdBy?.S;
  const createdByName = item?.createdByName?.S;
  const who = item?.who?.S;
  const at = numberOf(item?.at);
  const windowMinutes = numberOf(item?.windowMinutes);
  const createdAt = numberOf(item?.createdAt);
  const status = item?.status?.S;
  if (!item || !householdId || !errandId || !createdBy || !createdByName || !who || at === undefined || windowMinutes === undefined || createdAt === undefined || !isStatus(status)) {
    return undefined;
  }
  const remindAt = numberOf(item.remindAt);
  const rangAt = numberOf(item.rangAt);
  const remindedAt = numberOf(item.remindedAt);
  return {
    errandId,
    householdId,
    createdBy,
    createdByName,
    who,
    at,
    windowMinutes,
    ...(remindAt === undefined ? {} : { remindAt }),
    tellMe: item.tellMe?.BOOL === true,
    status,
    ...(rangAt === undefined ? {} : { rangAt }),
    ...(item.executionArn?.S ? { executionArn: item.executionArn.S } : {}),
    createdAt,
    ...(remindedAt === undefined ? {} : { remindedAt }),
    ...(item.cardId?.S ? { cardId: item.cardId.S } : {}),
    ...(withToken && item.taskToken?.S ? { taskToken: item.taskToken.S } : {}),
  };
}

export interface ErrandStore {
  /** The errand and the door's roster entry, in one transaction. False when that id is already taken. */
  create(errand: Errand): Promise<boolean>;
  /** One errand as it stands, read consistently, with the door's token if it has one. */
  get(householdId: string, errandId: string): Promise<HeldErrand | undefined>;
  /** Every errand of the household, newest first, without a token. */
  list(householdId: string): Promise<HeldErrand[]>;
  setExecution(householdId: string, errandId: string, executionArn: string): Promise<void>;
  /** On to `to`, only from one of `from`. False when it is not in one of them, or not there at all. */
  move(householdId: string, errandId: string, from: readonly ErrandStatus[], to: ErrandStatus, facts?: ErrandFacts, options?: { readonly forgetToken?: boolean }): Promise<boolean>;
  /** The token handed back: taken off the row, only while it is the one given. False when it was already spent. */
  spendToken(householdId: string, errandId: string, token: string): Promise<boolean>;
  /** The visitor off the door. The errand stays, to say how it ended. */
  forgetRoster(householdId: string, errandId: string): Promise<void>;
}

const refused = (err: unknown): boolean => {
  const name = (err as { name?: string }).name;
  return name === 'ConditionalCheckFailedException' || name === 'TransactionCanceledException';
};

export function errandStore(send: ErrandSend, table: string): ErrandStore {
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
    create: (errand) =>
      whether(new TransactWriteItemsCommand({
        TransactItems: [
          { Put: { TableName: table, Item: errandItem(errand), ConditionExpression: 'attribute_not_exists(pk)' } },
          { Put: { TableName: table, Item: errandRosterItem(errand) } },
        ],
      })),

    async get(householdId, errandId) {
      const res = await send(new GetItemCommand({ TableName: table, Key: keyOf(householdId, errandSk(errandId)), ConsistentRead: true }));
      return errandFromItem(res.Item, true);
    },

    async list(householdId) {
      const res = await send(new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': { S: `HH#${householdId}` }, ':prefix': { S: ERRAND_SK_PREFIX } },
        ConsistentRead: true,
      }));
      return (res.Items ?? [])
        .flatMap((item) => {
          const errand = errandFromItem(item);
          return errand ? [errand] : [];
        })
        .sort((a, b) => b.createdAt - a.createdAt);
    },

    async setExecution(householdId, errandId, executionArn) {
      await send(new UpdateItemCommand({
        TableName: table,
        Key: keyOf(householdId, errandSk(errandId)),
        UpdateExpression: 'SET executionArn = :arn',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':arn': { S: executionArn } },
      }));
    },

    move(householdId, errandId, from, to, facts = {}, options = {}) {
      const values: Record<string, AttributeValue> = { ':to': { S: to } };
      from.forEach((status, i) => {
        values[`:from${i}`] = { S: status };
      });
      const sets = ['#s = :to'];
      for (const [name, value] of Object.entries(facts) as [keyof ErrandFacts, number | string | undefined][]) {
        if (value === undefined) continue;
        values[`:${name}`] = typeof value === 'number' ? num(value) : { S: value };
        sets.push(`${name} = :${name}`);
      }
      return whether(new UpdateItemCommand({
        TableName: table,
        Key: keyOf(householdId, errandSk(errandId)),
        UpdateExpression: `SET ${sets.join(', ')}${options.forgetToken ? ' REMOVE taskToken' : ''}`,
        ConditionExpression: `attribute_exists(pk) AND (${from.map((_, i) => `#s = :from${i}`).join(' OR ')})`,
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: values,
      }));
    },

    spendToken: (householdId, errandId, token) =>
      whether(new UpdateItemCommand({
        TableName: table,
        Key: keyOf(householdId, errandSk(errandId)),
        UpdateExpression: 'REMOVE taskToken',
        ConditionExpression: 'taskToken = :token',
        ExpressionAttributeValues: { ':token': { S: token } },
      })),

    async forgetRoster(householdId, errandId) {
      await send(new DeleteItemCommand({ TableName: table, Key: keyOf(householdId, `PER#${errandPersonId(errandId)}`) }));
    },
  };
}
