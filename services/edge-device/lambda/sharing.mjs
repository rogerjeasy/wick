/**
 * "What Sarah sees" — trust promise 2: the resident can see everything the
 * family can see, on their own television, and keep any of it private with
 * one button — or share it again.
 *
 * One page per thing the household lets the family see, in plain words.
 * Each press is a card_action; route.mjs applies it, rebuilds the page from
 * the live policy and pushes it back over the same connection, replacing
 * the card in place.
 *
 * The television can change exactly one thing: the resident's own
 * exclusions, held as a `residentExclusions` string set on the household's
 * META item (ADD / DELETE, so no read-modify-write of the policy document).
 * services/mcp-server's loadHouseholdPolicy merges that set into the policy.
 * Exclusions can only narrow what the family sees (services/policy), so the
 * worst a stolen or confused television can do is make the household more
 * private.
 *
 * This plain .mjs Lambda can't import TS, so the policy facts it needs are
 * inlined below, each with a pointer to its source — keep them in step.
 *
 * Pure: route.mjs owns the DynamoDB and WebSocket clients.
 */

export const SHARING_CARD_ID = 'sharing'; // packages/contracts/src/card.ts SHARING_CARD_ID

/** The plain-language page for each class the family can be allowed to see. */
const ITEMS = [
  { factClass: 'DOOR_EVENT', headline: 'When someone comes to your front door.' },
  { factClass: 'PRESENCE', headline: 'Who visits you, by name, like Maria.' },
  { factClass: 'RHYTHM', headline: 'A short summary of your week.' },
  { factClass: 'COMMITMENT', headline: 'Your appointments, in summary.' },
];

/** services/policy/src/policy.ts DEFAULT_TABLE: the classes whose FAMILY rule allows. */
const DEFAULT_FAMILY_ALLOWED = new Set(['DOOR_EVENT', 'PRESENCE', 'RHYTHM', 'COMMITMENT']);

/** packages/contracts/src/fact.ts NEVER_TO_FAMILY: no opt-in can widen past these. */
const NEVER_TO_FAMILY = new Set(['HEALTH', 'FINANCIAL', 'RELATIONSHIP', 'LOCATION', 'VERBATIM']);

const NEVER_LINE = 'Never shared, whatever you choose: your health, money, relationships, where you go, or your words.';

/**
 * The classes the household lets the family see, before the resident's own
 * exclusions, in page order. Mirrors services/mcp-server's
 * isSharedWithFamily without its last, exclusion step.
 */
export function visibleClasses(policyJson) {
  if (!policyJson) return ITEMS.map((i) => i.factClass).filter((c) => DEFAULT_FAMILY_ALLOWED.has(c));
  const policy = JSON.parse(policyJson);
  const permitted = policy.familyPermitted ?? [];
  return ITEMS.map((i) => i.factClass).filter(
    (c) => policy.table?.[c]?.FAMILY?.allow === true || (permitted.includes(c) && !NEVER_TO_FAMILY.has(c)),
  );
}

/** The resident's exclusions: the policy document's list plus the television's string set. */
export function readExclusions(metaItem) {
  const fromPolicy = metaItem?.policy?.S ? JSON.parse(metaItem.policy.S).residentExclusions ?? [] : [];
  const fromTv = metaItem?.residentExclusions?.SS ?? [];
  return [...new Set([...fromPolicy, ...fromTv])];
}

/**
 * The first names of the people the resident has allowed, from the
 * household's own rows (`MEM#<userId>`): who "can see this" is. Asked of
 * the circle each time, so the card names the people who really can see —
 * not a name set once for every home.
 */
export function allowedFirstNames(items) {
  return (items ?? [])
    // Not a neighbour: a neighbour is asked things and shown nothing (packages/contracts circle.ts).
    .filter((item) => item.sk?.S?.startsWith('MEM#') && item.status?.S === 'allowed' && item.role?.S !== 'neighbour')
    .map((item) => String(item.name?.S ?? '').trim().split(/\s+/)[0])
    .filter(Boolean);
}

/** Who can see a thing that is shared, in a sentence: one person by name, the family, or nobody yet. */
function seenBy(watchers, familyName) {
  if (!watchers) return `${familyName ?? 'Your family'} can see this.`;
  if (watchers.length === 0) return 'Nobody can see this yet: you have not allowed anyone.';
  return `${watchers.length === 1 ? watchers[0] : 'Your family'} can see this.`;
}

/**
 * One page, as a QueuedCard. Undefined when the family can see nothing at all.
 * `watchers` is allowedFirstNames of the household; without it the card
 * speaks of `familyName`, or of "your family".
 */
export function buildSharingCard({ householdId, page, policyJson, exclusions, familyName, watchers, now, respondsTo }) {
  const classes = visibleClasses(policyJson);
  if (classes.length === 0) return undefined;

  const index = ((page % classes.length) + classes.length) % classes.length;
  const factClass = classes[index];
  const item = ITEMS.find((i) => i.factClass === factClass);
  const isPrivate = exclusions.includes(factClass);
  const status = isPrivate ? 'You’re keeping this private.' : seenBy(watchers, familyName);

  return {
    id: SHARING_CARD_ID,
    urgency: 'DEFERRED',
    queuedAt: now,
    shownCount: 0,
    ...(respondsTo ? { respondsTo } : {}),
    card: {
      type: 'SHARING',
      id: SHARING_CARD_ID,
      householdId,
      correlationId: SHARING_CARD_ID,
      createdAt: now,
      factClass,
      page: index,
      pages: classes.length,
      headline: item.headline,
      detail: `${index + 1} of ${classes.length}. ${status} ${NEVER_LINE}`,
      actions: [
        { id: 'toggle', label: isPrivate ? 'Share it again' : 'Keep this private', kind: 'primary' },
        { id: 'next', label: 'Next', kind: 'secondary' },
        { id: 'done', label: 'Done', kind: 'secondary' },
      ],
    },
  };
}

/**
 * What a press on the stored sharing card does: the page to show next, and
 * the exclusion to set, if any. Undefined for Done (route.mjs retires the
 * card) and anything else.
 */
export function sharingStep(storedQueued, action, exclusions) {
  const card = storedQueued?.card;
  if (card?.type !== 'SHARING') return undefined;
  if (action === 'next') return { page: card.page + 1 };
  if (action === 'toggle') {
    return { page: card.page, set: { factClass: card.factClass, keepPrivate: !exclusions.includes(card.factClass) } };
  }
  return undefined;
}

/** UpdateItem input for the one change the television may make. */
export function exclusionUpdate({ table, householdId, factClass, keepPrivate }) {
  if (!ITEMS.some((i) => i.factClass === factClass)) throw new Error(`${factClass} is not a sharing class`);
  return {
    TableName: table,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: 'META' } },
    UpdateExpression: `${keepPrivate ? 'ADD' : 'DELETE'} residentExclusions :c`,
    ExpressionAttributeValues: { ':c': { SS: [factClass] } },
  };
}
