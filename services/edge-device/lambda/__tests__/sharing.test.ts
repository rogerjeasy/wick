import { describe, expect, it } from 'vitest';
import {
  allowedFirstNames,
  buildSharingCard,
  exclusionUpdate,
  readExclusions,
  sharingStep,
  visibleClasses,
  // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
} from '../sharing.mjs';

const NOW = 1_790_900_000_000;
const NEVER = 'Never shared, whatever you choose: your health, money, relationships, where you go, or your words.';

const policyJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    table: {
      DOOR_EVENT: { FAMILY: { allow: true } },
      PRESENCE: { FAMILY: { allow: true } },
      RHYTHM: { FAMILY: { allow: true, transform: 'summarise' } },
      COMMITMENT: { FAMILY: { allow: false } },
      HEALTH: { FAMILY: { allow: false } },
    },
    residentExclusions: [],
    familyPermitted: [],
    ...over,
  });

describe('visibleClasses — what the household lets the family see, before the resident’s own choices', () => {
  it('is the default policy’s four family-visible classes when the household has no policy of its own', () => {
    expect(visibleClasses(undefined)).toEqual(['DOOR_EVENT', 'PRESENCE', 'RHYTHM', 'COMMITMENT']);
  });

  it('follows the household’s own table', () => {
    expect(visibleClasses(policyJson())).toEqual(['DOOR_EVENT', 'PRESENCE', 'RHYTHM']);
  });

  it('includes an explicit opt-in, but never one the hard cap forbids', () => {
    expect(visibleClasses(policyJson({ familyPermitted: ['COMMITMENT', 'HEALTH'] }))).toEqual(['DOOR_EVENT', 'PRESENCE', 'RHYTHM', 'COMMITMENT']);
  });
});

describe('readExclusions — the resident’s choices, wherever they were recorded', () => {
  it('merges the policy document’s list with the television’s string set', () => {
    const meta = { policy: { S: policyJson({ residentExclusions: ['RHYTHM'] }) }, residentExclusions: { SS: ['PRESENCE'] } };
    expect(readExclusions(meta).sort()).toEqual(['PRESENCE', 'RHYTHM']);
  });

  it('is empty for a household with no META item', () => {
    expect(readExclusions(undefined)).toEqual([]);
  });
});

describe('buildSharingCard — one thing Sarah can see, in plain words', () => {
  const build = (page: number, exclusions: string[] = []) =>
    buildSharingCard({ householdId: 'margaret', page, policyJson: undefined, exclusions, familyName: 'Sarah', now: NOW, respondsTo: 'week-2026-W40' });

  it('opens on the first thing, shared, with one button to keep it private', () => {
    expect(build(0)).toEqual({
      id: 'sharing',
      urgency: 'DEFERRED',
      queuedAt: NOW,
      shownCount: 0,
      respondsTo: 'week-2026-W40',
      card: {
        type: 'SHARING',
        id: 'sharing',
        householdId: 'margaret',
        correlationId: 'sharing',
        createdAt: NOW,
        factClass: 'DOOR_EVENT',
        page: 0,
        pages: 4,
        headline: 'When someone comes to your front door.',
        detail: `1 of 4. Sarah can see this. ${NEVER}`,
        actions: [
          { id: 'toggle', label: 'Keep this private', kind: 'primary' },
          { id: 'next', label: 'Next', kind: 'secondary' },
          { id: 'done', label: 'Done', kind: 'secondary' },
        ],
      },
    });
  });

  it('says plainly when the resident is keeping something private, and offers to share it again', () => {
    const card = build(1, ['PRESENCE']).card;
    expect(card.headline).toBe('Who visits you, by name, like Maria.');
    expect(card.detail).toBe(`2 of 4. You’re keeping this private. ${NEVER}`);
    expect(card.actions[0]).toEqual({ id: 'toggle', label: 'Share it again', kind: 'primary' });
  });

  it('wraps past the last page, and fits the card body', () => {
    const card = build(4).card;
    expect(card.page).toBe(0);
    expect(card.detail.length).toBeLessThanOrEqual(240);
  });

  it('says "your family" when the household has not named anyone', () => {
    const card = buildSharingCard({ householdId: 'h', page: 0, policyJson: undefined, exclusions: [], now: NOW }).card;
    expect(card.detail).toContain('Your family can see this.');
  });
});

describe('who can see it — named from the household’s own circle, not from a setting', () => {
  const member = (userId: string, name: string, status = 'allowed') => ({ pk: { S: 'HH#margaret' }, sk: { S: `MEM#${userId}` }, name: { S: name }, status: { S: status } });
  const card = (watchers: string[] | undefined) =>
    buildSharingCard({ householdId: 'margaret', page: 0, policyJson: undefined, exclusions: [], watchers, now: NOW }).card;

  it('reads the first names of the people she has allowed, and nobody else', () => {
    const rows = [member('u1', 'Sarah Hughes'), member('u2', 'Tom', 'pending'), member('u3', 'Amy', 'declined'), { pk: { S: 'HH#margaret' }, sk: { S: 'META' } }];

    expect(allowedFirstNames(rows)).toEqual(['Sarah']);
    expect(allowedFirstNames([])).toEqual([]);
  });

  it('names the one person who can see it', () => {
    expect(card(['Guest']).detail).toBe(`1 of 4. Guest can see this. ${NEVER}`);
  });

  it('speaks of her family when more than one person can', () => {
    expect(card(['Sarah', 'Tom']).detail).toBe(`1 of 4. Your family can see this. ${NEVER}`);
  });

  it('says that nobody can yet, when she has allowed nobody', () => {
    expect(card([]).detail).toBe(`1 of 4. Nobody can see this yet: you have not allowed anyone. ${NEVER}`);
  });
});

describe('sharingStep — what a press on the sharing card does', () => {
  const stored = { card: { type: 'SHARING', factClass: 'PRESENCE', page: 1 } };

  it('Keep this private / Share it again flips that one class, and stays on the page', () => {
    expect(sharingStep(stored, 'toggle', [])).toEqual({ page: 1, set: { factClass: 'PRESENCE', keepPrivate: true } });
    expect(sharingStep(stored, 'toggle', ['PRESENCE'])).toEqual({ page: 1, set: { factClass: 'PRESENCE', keepPrivate: false } });
  });

  it('Next moves on, and changes nothing', () => {
    expect(sharingStep(stored, 'next', [])).toEqual({ page: 2 });
  });

  it('Done, an unknown press, or no stored card does nothing more', () => {
    expect(sharingStep(stored, 'done', [])).toBeUndefined();
    expect(sharingStep(stored, 'reply_0', [])).toBeUndefined();
    expect(sharingStep(undefined, 'toggle', [])).toBeUndefined();
  });
});

describe('exclusionUpdate — the television can only ever change the resident’s own exclusions', () => {
  it('adds a class to the META item’s string set', () => {
    expect(exclusionUpdate({ table: 'wick', householdId: 'margaret', factClass: 'PRESENCE', keepPrivate: true })).toEqual({
      TableName: 'wick',
      Key: { pk: { S: 'HH#margaret' }, sk: { S: 'META' } },
      UpdateExpression: 'ADD residentExclusions :c',
      ExpressionAttributeValues: { ':c': { SS: ['PRESENCE'] } },
    });
  });

  it('removes it again', () => {
    expect(exclusionUpdate({ table: 'wick', householdId: 'margaret', factClass: 'PRESENCE', keepPrivate: false }).UpdateExpression).toBe(
      'DELETE residentExclusions :c',
    );
  });

  it('refuses a class that has no page — the policy table and opt-ins are never the television’s to touch', () => {
    expect(() => exclusionUpdate({ table: 'wick', householdId: 'margaret', factClass: 'HEALTH', keepPrivate: false })).toThrow(/not a sharing class/);
  });
});
