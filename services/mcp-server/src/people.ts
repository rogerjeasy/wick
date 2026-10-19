/**
 * The household's own people, by name, for the Guardian.
 *
 * A name is not a sentence (policy's foreign.ts): where the gate is given
 * who is who, it clears a string that is exactly one of their names, and
 * sets aside, inside a sentence, a word of one that is written in another
 * script. So the resident, her carer and her daughter can be written in
 * Cyrillic or Chinese and every answer that names them still reaches the
 * family. Read only when an answer would otherwise be withheld
 * (guardian.ts), so the common case costs nothing.
 *
 * The resident's own name and the home's label are in it as well as the
 * roster and the circle: a sentence about her light names her.
 */
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { AccountStore } from './accounts/store.js';
import { loadRoster } from './tools/list_regular_visitors.js';

export async function householdPeople(ddb: DynamoDBClient, store: AccountStore, householdId: string): Promise<readonly string[]> {
  const [household, roster, members] = await Promise.all([
    store.getHousehold(householdId),
    loadRoster(ddb, householdId),
    store.listMembers(householdId),
  ]);
  const names = [
    ...(household ? [household.residentName, household.name] : []),
    ...roster.map((person) => person.name),
    ...members.map((member) => member.name),
  ];
  return names.filter((name) => typeof name === 'string' && name.trim() !== '');
}
