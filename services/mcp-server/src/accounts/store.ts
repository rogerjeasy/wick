/**
 * Where accounts, households, memberships and sign-in state are kept: the
 * one `wick` table, beside the household's own rows.
 *
 *   USER#<id>          / PROFILE        a person            (gsi1: EMAIL#<email>)
 *   HH#<id>            / META           the household       (shared with its policy)
 *   HH#<id>            / MEM#<userId>   a membership        (gsi1: USER#<userId>)
 *   HH#<id>            / DEV#<deviceId> a paired television (written by the pairing Lambdas)
 *   HH#<id>            / FTV#<deviceId> a member's own television (written by the pairing Lambdas)
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
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import {
  DEFAULT_LANGUAGE,
  FAMILY_TV_SK_PREFIX,
  HOUSEHOLD_LANGUAGE_ATTRS,
  LANGUAGE_ASK_AGAIN_AFTER_MS,
  isHouseholdLanguage,
  type CircleRole,
  type HouseholdLanguage,
  type MemberStatus,
} from '@wick/contracts';
import { announcedVisitPrefix } from './announcedVisits.js';
import type { AskedLanguage, FamilyTelevision, Household, Membership, RecordKind, Television, User } from './types.js';

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
  /** `consistent` for a decision that has to stand on what was written a moment ago (the television's language). */
  getHousehold(householdId: string, options?: { readonly consistent?: boolean }): Promise<Household | undefined>;

  /**
   * Puts a question about the television's language beside the household
   * (packages/contracts language.ts): the three `languageAsked*` attributes,
   * in one conditional update. False, and nothing written, when the
   * household is no longer as it was read — it speaks that language already,
   * the question open on it is not `replacing` (none, when undefined), or
   * she said no to that language within the week before `question.at`.
   *
   * The language itself is never written from here. Only the resident's
   * press on her own television does that (the edge), for the same reason
   * nothing on the family side writes `status: 'allowed'` (INV-9).
   */
  askLanguage(householdId: string, question: AskedLanguage, replacing: HouseholdLanguage | undefined): Promise<boolean>;
  /** Takes back exactly that question. False when it is no longer the one open: answered, or asked again since. */
  clearLanguageQuestion(householdId: string, question: Pick<AskedLanguage, 'language' | 'at'>): Promise<boolean>;

  putMembership(membership: Membership): Promise<void>;
  getMembership(householdId: string, userId: string): Promise<Membership | undefined>;
  listMembers(householdId: string): Promise<Membership[]>;
  listMemberships(userId: string): Promise<Membership[]>;
  setMemberStatus(householdId: string, userId: string, status: MemberStatus, at: number): Promise<void>;

  listTelevisions(householdId: string): Promise<Television[]>;
  /**
   * Disconnects a television from the household: its pairing, and the claim
   * that keeps its id from being connected anywhere else. False when it was
   * not this household's. A television with no pairing is refused everywhere
   * it is served (edge-device device-standing.mjs), and shows the pairing
   * code again when it is next opened.
   */
  removeTelevision(householdId: string, deviceId: string): Promise<boolean>;

  /** The televisions members connected as their own (`FTV#` rows) — never the resident's, which are `listTelevisions`. */
  listFamilyTelevisions(householdId: string): Promise<FamilyTelevision[]>;
  /**
   * Disconnects a member's own television: its row, and the claim on its id,
   * as `removeTelevision` does for the resident's. With `ownedBy` it is
   * removed only if it is that member's. False when the household has no
   * such family television — or it is somebody else's.
   */
  removeFamilyTelevision(householdId: string, deviceId: string, ownedBy?: string): Promise<boolean>;

  /** Takes every visit a person announced off the household's roster (announcedVisits.ts). */
  forgetAnnouncedVisits(householdId: string, userId: string): Promise<void>;

  putRecord<T>(kind: RecordKind, id: string, value: T, expiresAt?: number): Promise<void>;
  /** Undefined once past its expiry, whether or not DynamoDB has deleted it yet. */
  getRecord<T>(kind: RecordKind, id: string): Promise<T | undefined>;
  /** Atomic: at most one caller ever receives the record. */
  takeRecord<T>(kind: RecordKind, id: string): Promise<T | undefined>;
  deleteRecord(kind: RecordKind, id: string): Promise<void>;
}

const householdPk = (householdId: string): AttributeValue => ({ S: `HH#${householdId}` });

const LANGUAGE = HOUSEHOLD_LANGUAGE_ATTRS;
/** The attributes of a question about the language. These are all this store ever writes of it. */
const QUESTION_NAMES = { '#asked': LANGUAGE.asked, '#by': LANGUAGE.askedBy, '#at': LANGUAGE.askedAt } as const;

const conditionFailed = (err: unknown): boolean => (err as { name?: string }).name === 'ConditionalCheckFailedException';

/** The language on a household's row, a question open beside it, and her last no. English is the absence of a language. */
function languageFromItem(item: Item): Pick<Household, 'language' | 'languageAsked' | 'languageDeclined'> {
  const language = item[LANGUAGE.language]?.S;
  const asked = item[LANGUAGE.asked]?.S;
  const declined = item[LANGUAGE.declined]?.S;
  const declinedAt = Number(item[LANGUAGE.declinedAt]?.N);
  return {
    // A no with no time cannot be counted from, and is not kept against anybody.
    ...(isHouseholdLanguage(declined) && Number.isFinite(declinedAt) ? { languageDeclined: { language: declined, at: declinedAt } } : {}),
    ...(isHouseholdLanguage(language) && language !== DEFAULT_LANGUAGE ? { language } : {}),
    ...(isHouseholdLanguage(asked)
      ? { languageAsked: { language: asked, by: item[LANGUAGE.askedBy]?.S ?? '', at: Number(item[LANGUAGE.askedAt]?.N ?? 0) } }
      : {}),
  };
}
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
          UpdateExpression: `SET #name = :name, residentName = :resident, createdBy = :by, createdAt = :at${household.simulated ? ', simulated = :simulated' : ''}`,
          ConditionExpression: 'attribute_not_exists(createdBy)',
          ExpressionAttributeNames: { '#name': 'name' },
          ExpressionAttributeValues: {
            ':name': { S: household.name },
            ':resident': { S: household.residentName },
            ':by': { S: household.createdBy },
            ':at': num(household.createdAt),
            ...(household.simulated ? { ':simulated': { BOOL: true } } : {}),
          },
        }));
      } catch (err) {
        if ((err as { name?: string }).name === 'ConditionalCheckFailedException') throw new HouseholdExistsError(household.householdId);
        throw err;
      }
    },

    async getHousehold(householdId, options) {
      const item = (await send(new GetItemCommand({
        TableName: table,
        Key: { pk: householdPk(householdId), sk: { S: 'META' } },
        ...(options?.consistent ? { ConsistentRead: true } : {}),
      }))).Item;
      // A META item with a policy but no creator is a household nobody has claimed.
      if (!item?.createdBy?.S || !item.name?.S || !item.residentName?.S) return undefined;
      return {
        householdId,
        name: item.name.S,
        residentName: item.residentName.S,
        createdBy: item.createdBy.S,
        createdAt: Number(item.createdAt?.N ?? 0),
        ...(item.simulated?.BOOL ? { simulated: true } : {}),
        ...languageFromItem(item),
      };
    },

    async askLanguage(householdId, question, replacing) {
      // English is the absence of the attribute, so "does not speak it already" is asked two ways.
      const speaksAnother =
        question.language === DEFAULT_LANGUAGE
          ? 'attribute_exists(#language) AND #language <> :asked'
          : '(attribute_not_exists(#language) OR #language <> :asked)';
      const questionAsRead = replacing === undefined ? 'attribute_not_exists(#asked)' : '#asked = :replacing';
      // Her no stands for a week, even against a request that read the household a moment before she gave it.
      const noStandingNo = '(attribute_not_exists(#declined) OR #declined <> :asked OR #declinedAt <= :stale)';
      try {
        await send(new UpdateItemCommand({
          TableName: table,
          Key: { pk: householdPk(householdId), sk: { S: 'META' } },
          UpdateExpression: 'SET #asked = :asked, #by = :by, #at = :at',
          // Named in the condition only: the language and her no are read here to refuse, and never set.
          ConditionExpression: `attribute_exists(createdBy) AND ${speaksAnother} AND ${questionAsRead} AND ${noStandingNo}`,
          ExpressionAttributeNames: { '#language': LANGUAGE.language, '#declined': LANGUAGE.declined, '#declinedAt': LANGUAGE.declinedAt, ...QUESTION_NAMES },
          ExpressionAttributeValues: {
            ':asked': { S: question.language },
            ':by': { S: question.by },
            ':at': num(question.at),
            ':stale': num(question.at - LANGUAGE_ASK_AGAIN_AFTER_MS),
            ...(replacing === undefined ? {} : { ':replacing': { S: replacing } }),
          },
        }));
        return true;
      } catch (err) {
        if (conditionFailed(err)) return false;
        throw err;
      }
    },

    async clearLanguageQuestion(householdId, question) {
      try {
        await send(new UpdateItemCommand({
          TableName: table,
          Key: { pk: householdPk(householdId), sk: { S: 'META' } },
          UpdateExpression: 'REMOVE #asked, #by, #at',
          ConditionExpression: '#asked = :asked AND #at = :at',
          ExpressionAttributeNames: { ...QUESTION_NAMES },
          ExpressionAttributeValues: { ':asked': { S: question.language }, ':at': num(question.at) },
        }));
        return true;
      } catch (err) {
        if (conditionFailed(err)) return false;
        throw err;
      }
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

    async forgetAnnouncedVisits(householdId, userId) {
      const rows = await queryAll({
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': householdPk(householdId), ':prefix': { S: announcedVisitPrefix(userId) } },
      });
      for (const row of rows) {
        await send(new DeleteItemCommand({ TableName: table, Key: { pk: householdPk(householdId), sk: row.sk! } }));
      }
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

    async removeTelevision(householdId, deviceId) {
      try {
        // Both or neither: a pairing without its claim could be claimed twice, a claim without its pairing never again.
        await send(new TransactWriteItemsCommand({
          TransactItems: [
            { Delete: { TableName: table, Key: { pk: householdPk(householdId), sk: { S: `DEV#${deviceId}` } }, ConditionExpression: 'attribute_exists(pk)' } },
            {
              Delete: {
                TableName: table,
                Key: { pk: { S: `DEV#${deviceId}` }, sk: { S: 'META' } },
                // Only this home's claim: a television since connected somewhere else keeps the one it has.
                ConditionExpression: 'attribute_not_exists(pk) OR householdId = :hh',
                ExpressionAttributeValues: { ':hh': { S: householdId } },
              },
            },
          ],
        }));
        return true;
      } catch (err) {
        if ((err as { name?: string }).name === 'TransactionCanceledException') return false;
        throw err;
      }
    },

    async listFamilyTelevisions(householdId) {
      const items = await queryAll({
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': householdPk(householdId), ':prefix': { S: FAMILY_TV_SK_PREFIX } },
      });
      return items.flatMap((item): FamilyTelevision[] => {
        const deviceId = item.deviceId?.S ?? item.sk?.S?.slice(FAMILY_TV_SK_PREFIX.length);
        const userId = item.userId?.S;
        // One revoked, or one that does not say whose it is, is nobody's television.
        if (!deviceId || !userId || item.denylisted?.BOOL === true) return [];
        return [{ deviceId, userId, ...(item.pairedAt?.N ? { pairedAt: Number(item.pairedAt.N) } : {}) }];
      });
    },

    async removeFamilyTelevision(householdId, deviceId, ownedBy) {
      try {
        // Both or neither, as for the resident's television above.
        await send(new TransactWriteItemsCommand({
          TransactItems: [
            {
              Delete: {
                TableName: table,
                Key: { pk: householdPk(householdId), sk: { S: `${FAMILY_TV_SK_PREFIX}${deviceId}` } },
                ...(ownedBy === undefined
                  ? { ConditionExpression: 'attribute_exists(pk)' }
                  : { ConditionExpression: 'attribute_exists(pk) AND userId = :user', ExpressionAttributeValues: { ':user': { S: ownedBy } } }),
              },
            },
            {
              Delete: {
                TableName: table,
                Key: { pk: { S: `DEV#${deviceId}` }, sk: { S: 'META' } },
                // Only this home's claim: a television since connected somewhere else keeps the one it has.
                ConditionExpression: 'attribute_not_exists(pk) OR householdId = :hh',
                ExpressionAttributeValues: { ':hh': { S: householdId } },
              },
            },
          ],
        }));
        return true;
      } catch (err) {
        if ((err as { name?: string }).name === 'TransactionCanceledException') return false;
        throw err;
      }
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
