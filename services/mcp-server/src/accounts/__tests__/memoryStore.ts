/**
 * Test-only AccountStore, held in memory. It keeps the same promises as the
 * DynamoDB one (store.ts): a household is created once, a record past its
 * expiry is gone, and a taken record is handed to one caller only.
 */
import { DEFAULT_LANGUAGE, LANGUAGE_ASK_AFTER_TAKING_BACK_MS, LANGUAGE_ASK_AGAIN_AFTER_MS } from '@wick/contracts';
import { HouseholdExistsError, type AccountStore } from '../store.js';
import type { FamilyTelevision, Household, Membership, Television, User } from '../types.js';

export interface MemoryStore extends AccountStore {
  /** Pretend a television was paired, as pair-claim.mjs would have done. Without a `ref`, it is given `ref-<deviceId>`. */
  addTelevision(householdId: string, tv: Omit<Television, 'ref'> & { ref?: string }): void;
  /** Pretend a member connected a television of their own, as pair-claim.mjs would have done with `as: 'family'`. Its `ref` as above. */
  addFamilyTelevision(householdId: string, tv: Omit<FamilyTelevision, 'ref'> & { ref?: string }): void;
  /**
   * Pretend the resident pressed a button on the LANGUAGE card, as the edge
   * will have it: only a question still open is answered; "yes" makes it the
   * television's language and forgets any no; "no" is kept, with when (her
   * no stands for a week); either answer closes the question. Says which
   * language her television speaks afterwards, or undefined when nothing was
   * open.
   */
  answerLanguage(householdId: string, answer: 'yes' | 'no'): 'en' | 'es' | undefined;
  /** Every forgetAnnouncedVisits call, in order. */
  readonly forgottenVisits: { householdId: string; userId: string }[];
}

export function createMemoryStore(now: () => number = Date.now): MemoryStore {
  const forgottenVisits: { householdId: string; userId: string }[] = [];
  const users = new Map<string, User>();
  const households = new Map<string, Household>();
  const memberships = new Map<string, Membership>();
  const televisions = new Map<string, Television[]>();
  const familyTelevisions = new Map<string, FamilyTelevision[]>();
  const records = new Map<string, { value: string; expiresAt: number | undefined }>();

  const memberKey = (householdId: string, userId: string) => `${householdId}/${userId}`;
  const live = <T>(key: string): T | undefined => {
    const record = records.get(key);
    if (!record) return undefined;
    if (record.expiresAt !== undefined && record.expiresAt <= now()) return undefined;
    return JSON.parse(record.value) as T;
  };

  return {
    async putUser(user) {
      users.set(user.userId, { ...user, createdAt: users.get(user.userId)?.createdAt ?? user.createdAt });
    },
    async getUser(userId) {
      return users.get(userId);
    },
    async findUserByEmail(email) {
      if (!email.trim()) return undefined;
      return [...users.values()].find((u) => u.email.toLowerCase() === email.trim().toLowerCase());
    },
    async createHousehold(household) {
      if (households.has(household.householdId)) throw new HouseholdExistsError(household.householdId);
      households.set(household.householdId, household);
    },
    async getHousehold(householdId) {
      return households.get(householdId);
    },
    // The same conditions as the table's (store.ts askLanguage), so a test over this store is refused what it would be there.
    async askLanguage(householdId, question, replacing) {
      const household = households.get(householdId);
      if (!household) return false;
      if ((household.language ?? DEFAULT_LANGUAGE) === question.language) return false;
      if (household.languageAsked?.language !== replacing?.language) return false;
      const no = household.languageDeclined;
      if (no && no.language === question.language && no.at > question.at - LANGUAGE_ASK_AGAIN_AFTER_MS) return false;
      const taken = household.languageTakenBack;
      if (taken && taken.language === question.language && taken.at > question.at - LANGUAGE_ASK_AFTER_TAKING_BACK_MS) return false;
      households.set(householdId, {
        ...household,
        languageAsked: question,
        // An open question this replaces is recorded as taken back, as on the table.
        ...(replacing?.open ? { languageTakenBack: { language: replacing.language, at: question.at } } : {}),
      });
      return true;
    },
    async takeBackLanguageQuestion(householdId, question, at) {
      const household = households.get(householdId);
      const asked = household?.languageAsked;
      if (!household || !asked || asked.language !== question.language || asked.at !== question.at) return false;
      const { languageAsked: _taken, ...rest } = household;
      households.set(householdId, { ...rest, languageTakenBack: { language: question.language, at } });
      return true;
    },
    async clearLanguageQuestion(householdId, question) {
      const household = households.get(householdId);
      const asked = household?.languageAsked;
      if (!household || !asked || asked.language !== question.language || asked.at !== question.at) return false;
      const { languageAsked: _taken, ...rest } = household;
      households.set(householdId, rest);
      return true;
    },
    answerLanguage(householdId, answer) {
      const household = households.get(householdId);
      const asked = household?.languageAsked;
      if (!household || !asked) return undefined;
      const { languageAsked: _answered, language: before, languageDeclined: lastNo, ...rest } = household;
      const language = answer === 'yes' ? asked.language : (before ?? DEFAULT_LANGUAGE);
      households.set(householdId, {
        ...rest,
        // English is the absence of one, as on the table.
        ...(language === DEFAULT_LANGUAGE ? {} : { language }),
        // Her no is kept, with when; her yes forgets whatever she said no to before.
        ...(answer === 'no' ? { languageDeclined: { language: asked.language, at: now() } } : {}),
      });
      void lastNo;
      return language;
    },
    async putMembership(membership) {
      memberships.set(memberKey(membership.householdId, membership.userId), membership);
    },
    async getMembership(householdId, userId) {
      return memberships.get(memberKey(householdId, userId));
    },
    async listMembers(householdId) {
      return [...memberships.values()].filter((m) => m.householdId === householdId);
    },
    async listMemberships(userId) {
      return [...memberships.values()].filter((m) => m.userId === userId);
    },
    async setMemberStatus(householdId, userId, status, at) {
      const key = memberKey(householdId, userId);
      const existing = memberships.get(key);
      if (!existing) throw Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });
      memberships.set(key, { ...existing, status, decidedAt: at });
    },
    forgottenVisits,
    async forgetAnnouncedVisits(householdId, userId) {
      forgottenVisits.push({ householdId, userId });
    },
    async listTelevisions(householdId) {
      return televisions.get(householdId) ?? [];
    },
    async removeTelevision(householdId, deviceId) {
      const held = televisions.get(householdId) ?? [];
      if (!held.some((tv) => tv.deviceId === deviceId)) return false;
      televisions.set(householdId, held.filter((tv) => tv.deviceId !== deviceId));
      return true;
    },
    addTelevision(householdId, tv) {
      televisions.set(householdId, [...(televisions.get(householdId) ?? []), { ...tv, ref: tv.ref ?? `ref-${tv.deviceId}` }]);
    },
    async listFamilyTelevisions(householdId) {
      return familyTelevisions.get(householdId) ?? [];
    },
    async removeFamilyTelevision(householdId, deviceId, ownedBy) {
      const held = familyTelevisions.get(householdId) ?? [];
      const mine = (tv: FamilyTelevision) => tv.deviceId === deviceId && (ownedBy === undefined || tv.userId === ownedBy);
      if (!held.some(mine)) return false;
      familyTelevisions.set(householdId, held.filter((tv) => !mine(tv)));
      return true;
    },
    addFamilyTelevision(householdId, tv) {
      // One row per television, as the table's key makes it: connecting it again replaces whose it was.
      familyTelevisions.set(householdId, [...(familyTelevisions.get(householdId) ?? []).filter((held) => held.deviceId !== tv.deviceId), { ...tv, ref: tv.ref ?? `ref-${tv.deviceId}` }]);
    },
    async putRecord(kind, id, value, expiresAt) {
      records.set(`${kind}#${id}`, { value: JSON.stringify(value), expiresAt });
    },
    async getRecord<T>(kind: string, id: string) {
      return live<T>(`${kind}#${id}`);
    },
    async takeRecord<T>(kind: string, id: string) {
      const key = `${kind}#${id}`;
      const value = live<T>(key);
      records.delete(key);
      return value;
    },
    async deleteRecord(kind, id) {
      records.delete(`${kind}#${id}`);
    },
  };
}
