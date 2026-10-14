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
 *                                       (gsi1: USER#<holder> / OWN#<kind>#<id>, when it has a holder)
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
  LANGUAGE_ASK_AFTER_TAKING_BACK_MS,
  LANGUAGE_ASK_AGAIN_AFTER_MS,
  isHouseholdLanguage,
  type CircleRole,
  type HouseholdLanguage,
  type MemberStatus,
} from '@wick/contracts';
import { randomBytes } from 'node:crypto';
import { announcedVisitPrefix } from './announcedVisits.js';
import type { AskedLanguage, FamilyTelevision, Household, Membership, OwnedRecord, RecordKind, Television, User } from './types.js';

/** What a record's place in the index begins with, under the person who holds it. Never `HH#`: that is a membership's. */
export const OWNED_RECORD_PREFIX = 'OWN#';

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
   * the question beside it is not `replacing` (none, when undefined), she
   * said no to that language within the week before `question.at`, or a
   * question for it was taken back within the day before.
   *
   * A question that was `open` and is replaced has left her television as
   * surely as one taken back, and is recorded as taken back by the same
   * update. One left over for the language she already speaks is not.
   *
   * The language itself is never written from here, and nor is her no. Only
   * the resident's press on her own television does that (the edge), for
   * the same reason nothing on the family side writes `status: 'allowed'`
   * (INV-9).
   */
  askLanguage(
    householdId: string,
    question: AskedLanguage,
    replacing: { readonly language: HouseholdLanguage; readonly open: boolean } | undefined,
  ): Promise<boolean>;
  /**
   * The organiser takes exactly that question back: it is cleared, and
   * that it was taken back — which language, and `at` — is recorded, in
   * one conditional update. False, and nothing written, when it is no
   * longer the question open: answered, or asked again since.
   */
  takeBackLanguageQuestion(householdId: string, question: Pick<AskedLanguage, 'language' | 'at'>, at: number): Promise<boolean>;
  /**
   * Undoes a question whose card could not be sent. She was never asked, so
   * nothing is recorded: this is not a taking back, and starts no wait.
   */
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

  /**
   * With `ownerId`, the record is also filed under that person (gsi1:
   * `USER#<id>` / `OWN#…`), so `listOwnedRecords` finds it: their tokens,
   * sign-ins and invitations, shown in their export and taken with their
   * account.
   */
  putRecord<T>(kind: RecordKind, id: string, value: T, expiresAt?: number, ownerId?: string): Promise<void>;
  /** Undefined once past its expiry, whether or not DynamoDB has deleted it yet. */
  getRecord<T>(kind: RecordKind, id: string): Promise<T | undefined>;
  /** Atomic: at most one caller ever receives the record. */
  takeRecord<T>(kind: RecordKind, id: string): Promise<T | undefined>;
  deleteRecord(kind: RecordKind, id: string): Promise<void>;

  // --- A person's own data: their export, and their account's deletion (myData.ts) ---

  /** Every live record put with this person as its owner. */
  listOwnedRecords(userId: string): Promise<OwnedRecord[]>;
  /** The person's own rows: `USER#<id>` and everything in it (the profile, the browsers that asked to be told). */
  deleteUser(userId: string): Promise<void>;
  /** A membership's row, gone — not `removed`: the person it named has asked for their account to be deleted. */
  deleteMembership(householdId: string, userId: string): Promise<void>;
  /** A household's own row (`HH#<id>` / `META`). Only ever as the last step of its organiser closing it. */
  deleteHousehold(householdId: string): Promise<void>;
}

const householdPk = (householdId: string): AttributeValue => ({ S: `HH#${householdId}` });

const LANGUAGE = HOUSEHOLD_LANGUAGE_ATTRS;
/** The attributes of a question about the language. */
const QUESTION_NAMES = { '#asked': LANGUAGE.asked, '#by': LANGUAGE.askedBy, '#at': LANGUAGE.askedAt } as const;
/** And of the organiser's own taking back. With the question's, these are all this store ever writes about the language. */
const TAKEN_BACK_NAMES = { '#takenBack': LANGUAGE.takenBack, '#takenBackAt': LANGUAGE.takenBackAt } as const;

const conditionFailed = (err: unknown): boolean => (err as { name?: string }).name === 'ConditionalCheckFailedException';

/** The language on a household's row, a question open beside it, her last no and the last taking back. English is the absence of a language. */
function languageFromItem(item: Item): Pick<Household, 'language' | 'languageAsked' | 'languageDeclined' | 'languageTakenBack'> {
  const language = item[LANGUAGE.language]?.S;
  const asked = item[LANGUAGE.asked]?.S;
  const declined = item[LANGUAGE.declined]?.S;
  const declinedAt = Number(item[LANGUAGE.declinedAt]?.N);
  const takenBack = item[LANGUAGE.takenBack]?.S;
  const takenBackAt = Number(item[LANGUAGE.takenBackAt]?.N);
  return {
    ...(isHouseholdLanguage(takenBack) && Number.isFinite(takenBackAt) ? { languageTakenBack: { language: takenBack, at: takenBackAt } } : {}),
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

  /**
   * The name the family app calls a television by (`televisionRef`). The
   * pairing Lambda writes one on every row it connects; a row paired before
   * it did is given one here, the first time it is listed, and keeps it.
   * Undefined for a row that went while this was being asked.
   */
  const televisionRefOf = async (householdId: string, item: Item): Promise<string | undefined> => {
    const held = item.televisionRef?.S;
    if (held) return held;
    if (!item.sk?.S) return undefined;
    const Key = { pk: householdPk(householdId), sk: item.sk };
    try {
      const ref = randomBytes(16).toString('base64url');
      await send(new UpdateItemCommand({
        TableName: table,
        Key,
        UpdateExpression: 'SET televisionRef = :ref',
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(televisionRef)',
        ExpressionAttributeValues: { ':ref': { S: ref } },
      }));
      return ref;
    } catch (err) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
      // Given one by another request meanwhile, or gone.
      const again = await send(new GetItemCommand({ TableName: table, Key, ConsistentRead: true }));
      return again.Item?.televisionRef?.S;
    }
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
      // And a taking back stands for a day, against a request that read the household a moment before it too.
      const notTakenBackLately = '(attribute_not_exists(#takenBack) OR #takenBack <> :asked OR #takenBackAt <= :takenBackStale)';
      // An open question this replaces leaves her television with it: that is a taking back, and is recorded as one.
      const recordReplaced = replacing?.open ? ', #takenBack = :replacing, #takenBackAt = :at' : '';
      try {
        await send(new UpdateItemCommand({
          TableName: table,
          Key: { pk: householdPk(householdId), sk: { S: 'META' } },
          UpdateExpression: `SET #asked = :asked, #by = :by, #at = :at${recordReplaced}`,
          // Named in the condition only: the language and her no are read here to refuse, and never set.
          ConditionExpression: `attribute_exists(createdBy) AND ${speaksAnother} AND ${questionAsRead} AND ${noStandingNo} AND ${notTakenBackLately}`,
          ExpressionAttributeNames: {
            '#language': LANGUAGE.language,
            '#declined': LANGUAGE.declined,
            '#declinedAt': LANGUAGE.declinedAt,
            ...TAKEN_BACK_NAMES,
            ...QUESTION_NAMES,
          },
          ExpressionAttributeValues: {
            ':asked': { S: question.language },
            ':by': { S: question.by },
            ':at': num(question.at),
            ':stale': num(question.at - LANGUAGE_ASK_AGAIN_AFTER_MS),
            ':takenBackStale': num(question.at - LANGUAGE_ASK_AFTER_TAKING_BACK_MS),
            ...(replacing === undefined ? {} : { ':replacing': { S: replacing.language } }),
          },
        }));
        return true;
      } catch (err) {
        if (conditionFailed(err)) return false;
        throw err;
      }
    },

    async takeBackLanguageQuestion(householdId, question, at) {
      try {
        await send(new UpdateItemCommand({
          TableName: table,
          Key: { pk: householdPk(householdId), sk: { S: 'META' } },
          // One update: there is no moment at which the question is gone and its taking back not yet recorded.
          UpdateExpression: 'SET #takenBack = :asked, #takenBackAt = :takenBackAt REMOVE #asked, #by, #at',
          ConditionExpression: '#asked = :asked AND #at = :at',
          ExpressionAttributeNames: { ...TAKEN_BACK_NAMES, ...QUESTION_NAMES },
          ExpressionAttributeValues: { ':asked': { S: question.language }, ':at': num(question.at), ':takenBackAt': num(at) },
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
      const listed: Television[] = [];
      for (const item of items.filter((row) => row.denylisted?.BOOL !== true)) {
        const ref = await televisionRefOf(householdId, item);
        if (!ref) continue;
        listed.push({
          deviceId: item.deviceId?.S ?? item.sk?.S?.replace(/^DEV#/, '') ?? '',
          ref,
          ...(item.pairedAt?.N ? { pairedAt: Number(item.pairedAt.N) } : {}),
          connected: Boolean(item.connectionId?.S),
        });
      }
      return listed;
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
      const listed: FamilyTelevision[] = [];
      for (const item of items) {
        const deviceId = item.deviceId?.S ?? item.sk?.S?.slice(FAMILY_TV_SK_PREFIX.length);
        const userId = item.userId?.S;
        // One revoked, or one that does not say whose it is, is nobody's television.
        if (!deviceId || !userId || item.denylisted?.BOOL === true) continue;
        const ref = await televisionRefOf(householdId, item);
        if (!ref) continue;
        listed.push({ deviceId, ref, userId, ...(item.pairedAt?.N ? { pairedAt: Number(item.pairedAt.N) } : {}) });
      }
      return listed;
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

    async putRecord(kind, id, value, expiresAt, ownerId) {
      await send(new PutItemCommand({
        TableName: table,
        Item: {
          ...recordKey(kind, id),
          data: { S: JSON.stringify(value) },
          ...(expiresAt === undefined ? {} : { expiresAt: num(expiresAt), ttl: num(Math.floor(expiresAt / 1000)) }),
          // Filed under its holder too, by kind and id as they were given: the key itself does not say where one ends.
          ...(ownerId === undefined
            ? {}
            : { gsi1pk: userPk(ownerId), gsi1sk: { S: `${OWNED_RECORD_PREFIX}${kind}#${id}` }, recordKind: { S: kind }, recordId: { S: id } }),
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

    async listOwnedRecords(userId) {
      const items = await queryAll({
        IndexName: 'gsi1',
        KeyConditionExpression: 'gsi1pk = :pk AND begins_with(gsi1sk, :prefix)',
        ExpressionAttributeValues: { ':pk': userPk(userId), ':prefix': { S: OWNED_RECORD_PREFIX } },
      });
      return items.flatMap((item): OwnedRecord[] => {
        const kind = item.recordKind?.S as RecordKind | undefined;
        const id = item.recordId?.S;
        const value = liveValue<unknown>(item);
        if (!kind || !id || value === undefined) return [];
        return [{ kind, id, value, ...(item.expiresAt?.N ? { expiresAt: Number(item.expiresAt.N) } : {}) }];
      });
    },

    async deleteUser(userId) {
      // Every row of the person's own partition, whatever kind: the profile and each browser kept for a nudge.
      const rows = await queryAll({ KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': userPk(userId) } });
      for (const row of rows) {
        if (row.sk) await send(new DeleteItemCommand({ TableName: table, Key: { pk: userPk(userId), sk: row.sk } }));
      }
    },

    async deleteMembership(householdId, userId) {
      await send(new DeleteItemCommand({ TableName: table, Key: { pk: householdPk(householdId), sk: { S: `MEM#${userId}` } } }));
    },

    async deleteHousehold(householdId) {
      await send(new DeleteItemCommand({ TableName: table, Key: { pk: householdPk(householdId), sk: { S: 'META' } } }));
    },
  };
}
