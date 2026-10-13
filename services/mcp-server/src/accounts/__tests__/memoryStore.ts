/**
 * Test-only AccountStore, held in memory. It keeps the same promises as the
 * DynamoDB one (store.ts): a household is created once, a record past its
 * expiry is gone, and a taken record is handed to one caller only.
 */
import { HouseholdExistsError, type AccountStore } from '../store.js';
import type { FamilyTelevision, Household, Membership, Television, User } from '../types.js';

export interface MemoryStore extends AccountStore {
  /** Pretend a television was paired, as pair-claim.mjs would have done. */
  addTelevision(householdId: string, tv: Television): void;
  /** Pretend a member connected a television of their own, as pair-claim.mjs would have done with `as: 'family'`. */
  addFamilyTelevision(householdId: string, tv: FamilyTelevision): void;
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
      televisions.set(householdId, [...(televisions.get(householdId) ?? []), tv]);
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
      familyTelevisions.set(householdId, [...(familyTelevisions.get(householdId) ?? []).filter((held) => held.deviceId !== tv.deviceId), tv]);
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
