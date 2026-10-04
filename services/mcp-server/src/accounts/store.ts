/**
 * Where accounts, households, memberships and sign-in state are kept: the
 * one `wick` table, beside the household's own rows.
 *
 *   USER#<id>          / PROFILE        a person            (gsi1: EMAIL#<email>)
 *   HH#<id>            / META           the household       (shared with its policy)
 *   HH#<id>            / MEM#<userId>   a membership        (gsi1: USER#<userId>)
 *   HH#<id>            / DEV#<deviceId> a paired television (written by the pairing Lambdas)
 *   <KIND>#<id>        / META           a keyed record with an expiry
 *
 * `send` is a DynamoDBClient's send, injected so the exact requests are
 * tested without AWS — the same seam as services/agent/src/store/cards.ts.
 */
import {
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import type { CircleRole, MemberStatus } from '@wick/contracts';
import type { Household, Membership, RecordKind, Television, User } from './types.js';

type Item = Record<string, AttributeValue>;

export type DdbSend = (command: { readonly input: object }) => Promise<{
  Item?: Item | undefined;
  Items?: Item[] | undefined;
  Attributes?: Item | undefined;
  LastEvaluatedKey?: Item | undefined;
}>;

export class HouseholdExistsError extends Error {
  constructor(householdId: string) {
    super(`household ${householdId} already exists`);
    this.name = 'HouseholdExistsError';
  }
}

export interface AccountStore {
  putUser(user: User): Promise<void>;
  getUser(userId: string): Promise<User | undefined>;
  findUserByEmail(email: string): Promise<User | undefined>;

  /** Throws HouseholdExistsError rather than take over a household somebody created. */
  createHousehold(household: Household): Promise<void>;
  getHousehold(householdId: string): Promise<Household | undefined>;

  putMembership(membership: Membership): Promise<void>;
  getMembership(householdId: string, userId: string): Promise<Membership | undefined>;
  listMembers(householdId: string): Promise<Membership[]>;
  listMemberships(userId: string): Promise<Membership[]>;
  setMemberStatus(householdId: string, userId: string, status: MemberStatus, at: number): Promise<void>;

  listTelevisions(householdId: string): Promise<Television[]>;

  putRecord<T>(kind: RecordKind, id: string, value: T, expiresAt?: number): Promise<void>;
  /** Undefined once past its expiry, whether or not DynamoDB has deleted it yet. */
  getRecord<T>(kind: RecordKind, id: string): Promise<T | undefined>;
  /** Atomic: at most one caller ever receives the record. */
  takeRecord<T>(kind: RecordKind, id: string): Promise<T | undefined>;
  deleteRecord(kind: RecordKind, id: string): Promise<void>;
}

const householdPk = (householdId: string): AttributeValue => ({ S: `HH#${householdId}` });
const userPk = (userId: string): AttributeValue => ({ S: `USER#${userId}` });
const num = (value: number): AttributeValue => ({ N: String(value) });

function membershipFromItem(item: Item): Membership | undefined {
  const householdId = item.pk?.S?.replace(/^HH#/, '');
  const userId = item.sk?.S?.replace(/^MEM#/, '');
  if (!householdId || !userId || !item.name?.S || !item.role?.S || !item.status?.S) return undefined;
  return {
    householdId,
    userId,
    name: item.name.S,
    role: item.role.S as CircleRole,
    status: item.status.S as MemberStatus,
    requestedAt: Number(item.requestedAt?.N ?? 0),
    ...(item.decidedAt?.N ? { decidedAt: Number(item.decidedAt.N) } : {}),
    ...(item.invitedBy?.S ? { invitedBy: item.invitedBy.S } : {}),
  };
}

export function createDynamoAccountStore(send: DdbSend, table: string, now: () => number = Date.now): AccountStore {
  const recordKey = (kind: RecordKind, id: string): Item => ({ pk: { S: `${kind}#${id}` }, sk: { S: 'META' } });

  /** The stored value, unless the record is missing or past its expiry. */
  const liveValue = <T>(item: Item | undefined): T | undefined => {
    const raw = item?.data?.S;
    if (!raw) return undefined;
    const expiresAt = item?.expiresAt?.N;
    if (expiresAt !== undefined && Number(expiresAt) <= now()) return undefined;
    return JSON.parse(raw) as T;
  };

  const queryAll = async (input: object): Promise<Item[]> => {
    const items: Item[] = [];
    let startKey: Item | undefined;
    do {
      const page = await send(new QueryCommand({ TableName: table, ...input, ...(startKey ? { ExclusiveStartKey: startKey } : {}) } as never));
      items.push(...(page.Items ?? []));
      startKey = page.LastEvaluatedKey;
    } while (startKey);
    return items;
  };

  return {
    async putUser(user) {
      // An update, so signing in again refreshes the name without resetting createdAt.
      // A guest (accounts/demo.ts) has no email, so is filed under none:
      // every guest sharing one empty index key would make them findable by it.
      const byEmail = user.email !== '';
      await send(new UpdateItemCommand({
        TableName: table,
        Key: { pk: userPk(user.userId), sk: { S: 'PROFILE' } },
        UpdateExpression:
          `SET email = :email, #name = :name, createdAt = if_not_exists(createdAt, :at)${byEmail ? ', gsi1pk = :gpk, gsi1sk = :gsk' : ''}`,
        ExpressionAttributeNames: { '#name': 'name' },
        ExpressionAttributeValues: {
          ':email': { S: user.email },
          ':name': { S: user.name },
          ':at': num(user.createdAt),
          ...(byEmail ? { ':gpk': { S: `EMAIL#${user.email.toLowerCase()}` }, ':gsk': userPk(user.userId) } : {}),
        },
      }));
    },

    async getUser(userId) {
      const item = (await send(new GetItemCommand({ TableName: table, Key: { pk: userPk(userId), sk: { S: 'PROFILE' } } }))).Item;
      // A guest's email is the empty string, which is still a person.
      if (item?.email?.S === undefined || !item.name?.S) return undefined;
      return { userId, email: item.email.S, name: item.name.S, createdAt: Number(item.createdAt?.N ?? 0) };
    },

    async findUserByEmail(email) {
      if (!email.trim()) return undefined;
      const [item] = await queryAll({
        IndexName: 'gsi1',
        KeyConditionExpression: 'gsi1pk = :pk',
        ExpressionAttributeValues: { ':pk': { S: `EMAIL#${email.trim().toLowerCase()}` } },
      });
      const userId = item?.pk?.S?.replace(/^USER#/, '');
      if (!item || !userId || !item.email?.S || !item.name?.S) return undefined;
      return { userId, email: item.email.S, name: item.name.S, createdAt: Number(item.createdAt?.N ?? 0) };
    },

    async createHousehold(household) {
      try {
        // An update, not a put: a household's META item may already hold its
        // policy and the resident's own sharing choices (sharing.mjs).
        await send(new UpdateItemCommand({
          TableName: table,
          Key: { pk: householdPk(household.householdId), sk: { S: 'META' } },
          UpdateExpression: 'SET #name = :name, residentName = :resident, createdBy = :by, createdAt = :at',
          ConditionExpression: 'attribute_not_exists(createdBy)',
          ExpressionAttributeNames: { '#name': 'name' },
          ExpressionAttributeValues: {
            ':name': { S: household.name },
            ':resident': { S: household.residentName },
            ':by': { S: household.createdBy },
            ':at': num(household.createdAt),
          },
        }));
      } catch (err) {
        if ((err as { name?: string }).name === 'ConditionalCheckFailedException') throw new HouseholdExistsError(household.householdId);
        throw err;
      }
    },

    async getHousehold(householdId) {
      const item = (await send(new GetItemCommand({ TableName: table, Key: { pk: householdPk(householdId), sk: { S: 'META' } } }))).Item;
      // A META item with a policy but no creator is a household nobody has claimed.
      if (!item?.createdBy?.S || !item.name?.S || !item.residentName?.S) return undefined;
      return {
        householdId,
        name: item.name.S,
        residentName: item.residentName.S,
        createdBy: item.createdBy.S,
        createdAt: Number(item.createdAt?.N ?? 0),
      };
    },

    async putMembership(m) {
      await send(new PutItemCommand({
        TableName: table,
        Item: {
          pk: householdPk(m.householdId),
          sk: { S: `MEM#${m.userId}` },
          gsi1pk: userPk(m.userId),
          gsi1sk: householdPk(m.householdId),
          name: { S: m.name },
          role: { S: m.role },
          status: { S: m.status },
          requestedAt: num(m.requestedAt),
          ...(m.decidedAt === undefined ? {} : { decidedAt: num(m.decidedAt) }),
          ...(m.invitedBy === undefined ? {} : { invitedBy: { S: m.invitedBy } }),
        },
      }));
    },

    async getMembership(householdId, userId) {
      const item = (await send(new GetItemCommand({
        TableName: table,
        Key: { pk: householdPk(householdId), sk: { S: `MEM#${userId}` } },
        // The resident's answer must count on the very next request.
        ConsistentRead: true,
      }))).Item;
      return item ? membershipFromItem(item) : undefined;
    },

    async listMembers(householdId) {
      const items = await queryAll({
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': householdPk(householdId), ':prefix': { S: 'MEM#' } },
      });
      return items.map(membershipFromItem).filter((m): m is Membership => m !== undefined);
    },

    async listMemberships(userId) {
      const items = await queryAll({
        IndexName: 'gsi1',
        KeyConditionExpression: 'gsi1pk = :pk AND begins_with(gsi1sk, :prefix)',
        ExpressionAttributeValues: { ':pk': userPk(userId), ':prefix': { S: 'HH#' } },
      });
      return items.map(membershipFromItem).filter((m): m is Membership => m !== undefined);
    },

    async setMemberStatus(householdId, userId, status, at) {
      await send(new UpdateItemCommand({
        TableName: table,
        Key: { pk: householdPk(householdId), sk: { S: `MEM#${userId}` } },
        UpdateExpression: 'SET #status = :status, decidedAt = :at',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': { S: status }, ':at': num(at) },
      }));
    },

    async listTelevisions(householdId) {
      const items = await queryAll({
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': householdPk(householdId), ':prefix': { S: 'DEV#' } },
      });
      return items
        .filter((item) => item.denylisted?.BOOL !== true)
        .map((item) => ({
          deviceId: item.deviceId?.S ?? item.sk?.S?.replace(/^DEV#/, '') ?? '',
          ...(item.pairedAt?.N ? { pairedAt: Number(item.pairedAt.N) } : {}),
          connected: Boolean(item.connectionId?.S),
        }));
    },

    async putRecord(kind, id, value, expiresAt) {
      await send(new PutItemCommand({
        TableName: table,
        Item: {
          ...recordKey(kind, id),
          data: { S: JSON.stringify(value) },
          ...(expiresAt === undefined ? {} : { expiresAt: num(expiresAt), ttl: num(Math.floor(expiresAt / 1000)) }),
        },
      }));
    },

    async getRecord<T>(kind: RecordKind, id: string) {
      const res = await send(new GetItemCommand({ TableName: table, Key: recordKey(kind, id), ConsistentRead: true }));
      return liveValue<T>(res.Item);
    },

    async takeRecord<T>(kind: RecordKind, id: string) {
      const res = await send(new DeleteItemCommand({ TableName: table, Key: recordKey(kind, id), ReturnValues: 'ALL_OLD' }));
      return liveValue<T>(res.Attributes);
    },

    async deleteRecord(kind, id) {
      await send(new DeleteItemCommand({ TableName: table, Key: recordKey(kind, id) }));
    },
  };
}
