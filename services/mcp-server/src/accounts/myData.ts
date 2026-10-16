/**
 * A person's own data: everything Wick holds about them, as a file they can
 * keep, and their account taken away with all of it.
 *
 *   GET    /api/account/export     the file (accountDataRouter.ts)
 *   GET    /api/account/deletion   what deleting the account would take with it
 *   DELETE /api/account            the deletion itself
 *
 * Who is asking is the token's person (INV-8). Nothing here takes a person
 * or a household from a request: the homes are the ones that person belongs
 * to, found through the index of their memberships.
 *
 * What a deletion takes:
 *
 *   - their Cognito user, deleted with their own token after they give their
 *     password again (identity.ts). A guest has none, and nothing to give.
 *   - their profile and every browser kept to be nudged (`USER#<id>`);
 *   - every token, sign-in and invitation they hold (the owned records,
 *     store.ts `listOwnedRecords`), and the token the request came with;
 *   - in each home they were in: their place in its circle (the row, not a
 *     `removed` status — the row is their name), the visits they announced,
 *     any television they connected as their own, and their id on the notes
 *     they wrote (`sentBy`, which egress.ts keeps on a note's row and never
 *     sends to the television): the note stays the home's, written by nobody
 *     on record, and is read to nobody as theirs (tools/get_replies.ts).
 *   - what the family assistant kept of them in each home (assistant/forget.ts):
 *     their conversation and their own words in AgentCore Memory — and, in a
 *     home that closes, everyone's. Forgotten before their place in the
 *     circle goes, so a deletion that stops there can be asked for again.
 *
 * And the one rule a real product has to decide: **a home is never left
 * without the person who set it up.** Deleting the account of a home's
 * organiser closes that home, and is refused, in a sentence that says what
 * would go, until they choose that (`closeHomes`). Closing a home
 * disconnects its Ring doorbell first — through the function that holds the
 * link, which is the only thing that can (INV-8) — and refuses the whole
 * deletion if that cannot be done, so a Ring link is never left behind a
 * home that is gone. Then its televisions are disconnected (the resident's
 * shows its pairing code again), the pictures sent to her are deleted from
 * their bucket, and every row of the household is deleted: its circle, its
 * cards, its weeks, its schedules of the day and the simulated history of a
 * demo home alike. Nothing is counted on the way: what she kept, and how
 * much, is told to nobody (packages/contracts mantel.ts).
 *
 * What stays: a note or a picture sent to somebody else's home is that
 * home's — it was given to her — and goes when that home is closed. The
 * export lists them. And the table's point-in-time recovery keeps what was
 * deleted for 35 days more, which docs/privacy.html says.
 *
 * A deletion that stops half way can be asked for again with the same
 * token: the `DELETING` record says the password was checked and the
 * Cognito user is already gone, so the rest is finished without it.
 */
import { DeleteItemCommand, QueryCommand, UpdateItemCommand, type AttributeValue, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { QueuedCard } from '@wick/contracts';
import type { PhotoObjects } from '../photos/objects.js';
import { listPhotos } from '../photos/rows.js';
import type { RingLinks } from './apiRouter.js';
import { isGuest } from './demo.js';
import { isWaveCardId } from './familyTvWave.js';
import { IdentityError, type IdentityProvider } from './identity.js';
import type { AssistantMemory } from '../assistant/forget.js';
import type { PushStore } from './push.js';
import type { AccountStore } from './store.js';
import { hashToken } from './tokens.js';
import type { Household, Membership, OwnedRecord } from './types.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';

/** Long enough to try again after a deletion stopped half way; no longer. */
const DELETING_TTL_MS = 24 * 60 * 60 * 1000;

type Item = Record<string, AttributeValue>;

export interface MyDataDeps {
  readonly store: AccountStore;
  /** The households' own rows: their notes and pictures for the export, and every row of a home being closed. */
  readonly ddb: DynamoDBClient;
  readonly identity: IdentityProvider;
  readonly now: () => number;
  /** The browsers kept to be nudged (push.ts). Absent where the deployment has none. */
  readonly push?: PushStore | undefined;
  /** The function with custody of each home's Ring link. Absent where the deployment has no Ring. */
  readonly ringLinks?: RingLinks | undefined;
  /** The pictures' bucket. Absent where no picture can be sent, so none was. */
  readonly photos?: PhotoObjects | undefined;
  /** What the family assistant kept in AgentCore Memory. Absent where the deployment has no assistant memory. */
  readonly assistantMemory?: AssistantMemory | undefined;
}

/** A refusal, with the sentence the family app shows. */
export class AccountRefusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'AccountRefusal';
  }
}

/** Who is asking: the token's person, and the token itself, which is ended with the rest. */
export interface Asker {
  readonly userId: string;
  readonly token: string;
}

// --- The homes a person is in -------------------------------------------------

interface Home {
  readonly membership: Membership;
  readonly household: Household | undefined;
}

async function homesOf(store: AccountStore, userId: string): Promise<Home[]> {
  const memberships = await store.listMemberships(userId);
  return Promise.all(memberships.map(async (membership) => ({ membership, household: await store.getHousehold(membership.householdId) })));
}

/** A home this person set up. Closing it is what deleting their account does to it. */
const organises = (membership: Membership): boolean => membership.role === 'organiser' && membership.status !== 'removed';

/** Everyone else still in a home's circle: waiting for the resident, or allowed by her. */
async function othersIn(store: AccountStore, householdId: string, userId: string): Promise<number> {
  return (await store.listMembers(householdId)).filter((m) => m.userId !== userId && (m.status === 'pending' || m.status === 'allowed')).length;
}

const homeName = (home: Home): string => home.household?.name ?? 'a home that is no longer there';

// --- What deleting would take --------------------------------------------------

export interface HomeInDeletion {
  readonly name: string;
  readonly residentName: string;
  /** They set it up, so deleting their account closes it. */
  readonly closes: boolean;
  /** How many others are still in its circle. Told only for a home that closes: they lose their place. */
  readonly others: number;
  readonly simulated: boolean;
}

export interface DeletionPlan {
  readonly guest: boolean;
  /** A guest has no password; anybody else gives theirs again. */
  readonly needsPassword: boolean;
  readonly homes: readonly HomeInDeletion[];
}

export async function deletionPlan(deps: Pick<MyDataDeps, 'store'>, userId: string): Promise<DeletionPlan> {
  const guest = isGuest(userId);
  const homes: HomeInDeletion[] = [];
  for (const home of await homesOf(deps.store, userId)) {
    if (!home.household || home.membership.status === 'removed') continue;
    const closes = organises(home.membership);
    homes.push({
      name: home.household.name,
      residentName: home.household.residentName,
      closes,
      others: closes ? await othersIn(deps.store, home.household.householdId, userId) : 0,
      simulated: home.household.simulated === true,
    });
  }
  return { guest, needsPassword: !guest, homes };
}

/** The sentence a deletion is refused with until the organiser chooses to close their homes. */
export function closesHomesSentence(homes: readonly Pick<HomeInDeletion, 'name' | 'residentName'>[]): string {
  const names = homes.map((h) => h.name);
  const which = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
  const residents = homes.length === 1 ? `${homes[0]!.residentName}’s television is disconnected` : 'their televisions are disconnected';
  return `You set up ${which}, and a home is never left without the person who set it up. Deleting your account closes ${homes.length === 1 ? 'it' : 'them'}: ${residents}, everyone in the circle loses their place, and everything Wick holds about ${homes.length === 1 ? 'the home' : 'them'} is deleted. Choose to close ${homes.length === 1 ? 'it' : 'them'} too, or keep your account.`;
}

// --- The deletion ------------------------------------------------------------------

export interface DeletionRequest {
  readonly password?: unknown;
  readonly closeHomes?: unknown;
}

const IDENTITY_REFUSALS: Readonly<Record<string, AccountRefusal>> = {
  wrong_credentials: new AccountRefusal(400, 'wrong_password', 'That password is not right. Nothing was deleted.'),
  too_many_attempts: new AccountRefusal(429, 'too_many_attempts', 'Too many attempts. Wait a few minutes and try again. Nothing was deleted.'),
};
const IDENTITY_UNAVAILABLE = new AccountRefusal(502, 'identity_unavailable', 'Your sign-in could not be reached just now. Nothing was deleted: try again in a moment.');

const refusalFor = (err: unknown): AccountRefusal =>
  (err instanceof IdentityError && IDENTITY_REFUSALS[err.code]) || IDENTITY_UNAVAILABLE;

export async function deleteAccount(deps: MyDataDeps, asker: Asker, request: DeletionRequest): Promise<void> {
  const { store } = deps;
  const { userId } = asker;
  const user = await store.getUser(userId);
  if (!user) throw new AccountRefusal(404, 'no_account', 'There is no account here to delete.');
  const homes = await homesOf(store, userId);

  // A home is never left without the person who set it up: closing it has to be chosen.
  const closing = homes.filter((home) => organises(home.membership));
  if (closing.length > 0 && request.closeHomes !== true) {
    const named = closing.map((home) => ({ name: homeName(home), residentName: home.household?.residentName ?? 'the person at home' }));
    throw new AccountRefusal(409, 'closes_a_home', closesHomesSentence(named));
  }

  // The password again, unless a deletion already checked it and got as far as Cognito.
  const guest = isGuest(userId);
  const resuming = !guest && (await store.getRecord<{ at: number }>('DELETING', userId)) !== undefined;
  const password = typeof request.password === 'string' ? request.password : '';
  if (!guest && !resuming) {
    if (!password) throw new AccountRefusal(400, 'password_required', 'Enter your password to delete your account.');
    try {
      await deps.identity.signIn({ email: user.email, password });
    } catch (err) {
      throw refusalFor(err);
    }
  }

  // Each home's doorbell first: a link that cannot be ended stops everything, before anything is gone.
  for (const home of closing) {
    if (!deps.ringLinks) break;
    let answer;
    try {
      answer = await deps.ringLinks.disconnect(home.membership.householdId);
    } catch {
      answer = undefined;
    }
    if (!answer?.ok) {
      throw new AccountRefusal(502, 'doorbell_unavailable', `The doorbell of ${homeName(home)} could not be disconnected just now, so nothing was deleted. Try again in a moment.`);
    }
  }

  if (!guest && !resuming) {
    // Written before Cognito is asked, and taken back if it says no: a deletion that stops after it can be finished.
    await store.putRecord('DELETING', userId, { at: deps.now() }, deps.now() + DELETING_TTL_MS);
    try {
      await deps.identity.deleteAccount({ email: user.email, password });
    } catch (err) {
      await store.deleteRecord('DELETING', userId);
      throw refusalFor(err);
    }
  }

  for (const home of homes) {
    const householdId = home.membership.householdId;
    if (organises(home.membership)) {
      await closeHome(deps, householdId);
      continue;
    }
    await leaveHome(deps, householdId, userId);
  }

  for (const record of await store.listOwnedRecords(userId)) await store.deleteRecord(record.kind, record.id);
  // The token this was asked with, whenever it was issued: it ends here too.
  await store.deleteRecord('OAUTH#AT', hashToken(asker.token));
  await deps.push?.removeAll(userId);
  await store.deleteUser(userId);
  await store.deleteRecord('DELETING', userId);
}

/** Their place in a home somebody else set up: their row, the visits they announced, a television of their own, and their id on their notes. */
async function leaveHome(deps: MyDataDeps, householdId: string, userId: string): Promise<void> {
  const { store, ddb } = deps;
  for (const { item } of await notesIn(ddb, householdId, userId)) {
    // Only while it is still theirs: the condition is the row's, so nothing else's writer is ever taken off.
    await ddb.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: { pk: item.pk!, sk: item.sk! },
      UpdateExpression: 'REMOVE sentBy',
      ConditionExpression: 'sentBy = :me',
      ExpressionAttributeValues: { ':me': { S: userId } },
    })).catch((err: unknown) => {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    });
  }
  await store.forgetAnnouncedVisits(householdId, userId);
  await deps.assistantMemory?.forget(householdId, userId);
  for (const tv of await store.listFamilyTelevisions(householdId)) {
    if (tv.userId === userId) await store.removeFamilyTelevision(householdId, tv.deviceId, userId);
  }
  await store.deleteMembership(householdId, userId);
}

/**
 * A home closed by the person who set it up. Its doorbell has already been
 * disconnected. The televisions go through the store, so each one's claim on
 * its id goes with it; the pictures' bytes before their rows, which are how
 * they are found; and then every row the household has, whoever wrote it.
 */
async function closeHome(deps: MyDataDeps, householdId: string): Promise<void> {
  const { store, ddb } = deps;
  for (const tv of await store.listTelevisions(householdId)) await store.removeTelevision(householdId, tv.deviceId);
  for (const tv of await store.listFamilyTelevisions(householdId)) await store.removeFamilyTelevision(householdId, tv.deviceId);
  if (deps.photos) {
    for (const photo of await listPhotos(ddb, householdId)) await deps.photos.remove(householdId, photo.photoId);
  }
  const members = await store.listMembers(householdId);
  for (const member of members) await deps.assistantMemory?.forget(householdId, member.userId);
  for (const member of members) await store.deleteMembership(householdId, member.userId);

  const pk: AttributeValue = { S: `HH#${householdId}` };
  let startKey: Item | undefined;
  do {
    const page = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': pk },
      ProjectionExpression: 'pk, sk',
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
    }));
    for (const row of page.Items ?? []) {
      if (row.sk) await ddb.send(new DeleteItemCommand({ TableName: TABLE, Key: { pk, sk: row.sk } }));
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  await store.deleteHousehold(householdId);
}

// --- The export --------------------------------------------------------------------

/** The file's own name for its shape, so a later one can be told apart. */
export const EXPORT_FORMAT = 'wick-my-data/1';

interface ExportedHome {
  readonly home: string;
  readonly residentName: string;
  readonly simulated?: true;
}

export interface MyDataExport {
  readonly format: typeof EXPORT_FORMAT;
  readonly exportedAt: string;
  readonly about: string;
  readonly account: { readonly name: string; readonly email: string | null; readonly guest: boolean; readonly createdAt: string };
  readonly circles: readonly (ExportedHome & {
    readonly nameInTheCircle: string;
    readonly role: string;
    readonly status: string;
    readonly askedAt: string;
    readonly answeredAt?: string;
  })[];
  readonly invitationsSent: readonly (ExportedHome & { readonly role: string; readonly createdAt: string; readonly expiresAt: string })[];
  readonly notesSent: readonly (ExportedHome & {
    readonly message: string | null;
    readonly sentAt: string;
    readonly repliesOffered: readonly string[];
    readonly reply?: { readonly text: string; readonly at: string };
  })[];
  readonly picturesSent: readonly (ExportedHome & { readonly sentAt: string; readonly seen?: boolean })[];
  readonly ownTelevisions: readonly (ExportedHome & { readonly connectedAt?: string })[];
  readonly browsersToNudge: readonly { readonly pushService: string; readonly savedAt: string }[];
  readonly linkedApps: readonly { readonly app: string; readonly token: 'access' | 'refresh'; readonly home?: string; readonly expiresAt?: string }[];
  readonly signIns: readonly { readonly expiresAt?: string }[];
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** A push service's address is itself the capability to reach that browser: only which service it is goes in the file. */
function pushServiceOf(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return 'unknown';
  }
}

/**
 * The notes in a home this person wrote: the rows whose `sentBy` is their id,
 * kept there by egress.ts when the note was sent. Never by the name on the
 * card — two people in one circle can share a name (every demo guest is
 * "Sarah"), and each would be handed the other's notes and her replies to
 * them. A note sent before `sentBy` was kept has no writer on record, and is
 * in nobody's export.
 */
async function notesIn(ddb: DynamoDBClient, householdId: string, userId: string): Promise<{ queued: QueuedCard; item: Item }[]> {
  const found: { queued: QueuedCard; item: Item }[] = [];
  let startKey: Item | undefined;
  do {
    const page = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': { S: `HH#${householdId}` }, ':prefix': { S: 'CARD#note-' } },
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
    }));
    for (const item of page.Items ?? []) {
      const raw = item.data?.S;
      if (!raw) continue;
      const queued = JSON.parse(raw) as QueuedCard;
      // A wave is a press on a remote, not a note anybody wrote (familyTvWave.ts).
      if (queued.card.type !== 'MESSAGE' || isWaveCardId(queued.id) || item.sentBy?.S !== userId) continue;
      found.push({ queued, item });
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return found;
}

export async function exportMyData(deps: MyDataDeps, userId: string): Promise<MyDataExport> {
  const { store, ddb } = deps;
  const user = await store.getUser(userId);
  if (!user) throw new AccountRefusal(404, 'no_account', 'There is no account here.');
  const homes = await homesOf(store, userId);
  const named = new Map(homes.map((home) => [home.membership.householdId, home]));
  const where = (householdId: string): ExportedHome => {
    const household = named.get(householdId)?.household;
    return {
      home: household?.name ?? 'a home that is no longer there',
      residentName: household?.residentName ?? '',
      ...(household?.simulated ? { simulated: true as const } : {}),
    };
  };

  const circles: MyDataExport['circles'][number][] = [];
  const notesSent: MyDataExport['notesSent'][number][] = [];
  const picturesSent: MyDataExport['picturesSent'][number][] = [];
  const ownTelevisions: MyDataExport['ownTelevisions'][number][] = [];
  for (const { membership } of homes) {
    const householdId = membership.householdId;
    // What the resident said back is hers to share, so it is in the file only while she allows them.
    const allowed = membership.status === 'allowed';
    circles.push({
      ...where(householdId),
      nameInTheCircle: membership.name,
      role: membership.role,
      status: membership.status,
      askedAt: iso(membership.requestedAt),
      ...(membership.decidedAt === undefined ? {} : { answeredAt: iso(membership.decidedAt) }),
    });
    for (const { queued, item } of await notesIn(ddb, householdId, userId)) {
      const card = queued.card.type === 'MESSAGE' ? queued.card : undefined;
      const replyText = item.replyText?.S;
      const repliedAt = item.repliedAt?.N;
      notesSent.push({
        ...where(householdId),
        message: card?.transcript ?? null,
        sentAt: iso(queued.queuedAt),
        repliesOffered: card?.suggestedReplies ?? [],
        ...(allowed && replyText !== undefined && repliedAt !== undefined ? { reply: { text: replyText, at: iso(Number(repliedAt)) } } : {}),
      });
    }
    for (const photo of await listPhotos(ddb, householdId)) {
      if (photo.sentBy !== userId) continue;
      // Whether she has seen it is the one thing the family is told about a picture, and only while allowed.
      picturesSent.push({ ...where(householdId), sentAt: iso(photo.sentAt), ...(allowed ? { seen: photo.seen } : {}) });
    }
    for (const tv of await store.listFamilyTelevisions(householdId)) {
      if (tv.userId === userId) ownTelevisions.push({ ...where(householdId), ...(tv.pairedAt === undefined ? {} : { connectedAt: iso(tv.pairedAt) }) });
    }
  }

  const owned = await store.listOwnedRecords(userId);
  const of = (kind: OwnedRecord['kind']) => owned.filter((record) => record.kind === kind);
  const invitationsSent = of('INV').map((record) => {
    // Never the code: it is still the way into the home for whoever holds it.
    const invitation = record.value as { householdId: string; role?: string; createdAt: number; expiresAt: number };
    return { ...where(invitation.householdId), role: invitation.role ?? 'family', createdAt: iso(invitation.createdAt), expiresAt: iso(invitation.expiresAt) };
  });

  const appNames = new Map<string, string>();
  const appName = async (clientId: string): Promise<string> => {
    if (!appNames.has(clientId)) {
      const client = await store.getRecord<{ client_name?: string }>('OAUTH#CLIENT', clientId);
      appNames.set(clientId, client?.client_name ?? 'an app');
    }
    return appNames.get(clientId)!;
  };
  const linkedApps: MyDataExport['linkedApps'][number][] = [];
  for (const record of [...of('OAUTH#AT'), ...of('OAUTH#RT')]) {
    // What each token is for, never the token: only its digest is kept, and that is not given out either.
    const grant = record.value as { clientId: string; householdId: string };
    linkedApps.push({
      app: await appName(grant.clientId),
      token: record.kind === 'OAUTH#AT' ? 'access' : 'refresh',
      home: where(grant.householdId).home,
      ...(record.expiresAt === undefined ? {} : { expiresAt: iso(record.expiresAt) }),
    });
  }

  const browsers = (await deps.push?.list(userId)) ?? [];

  return {
    format: EXPORT_FORMAT,
    exportedAt: iso(deps.now()),
    about:
      'Everything Wick holds about you. Your password is not here: Amazon Cognito keeps it, and Wick never stored it. ' +
      'Codes, tokens and the addresses of your browsers are left out: each is a way in, not something about you. ' +
      'A note sent before Wick kept who wrote each note is not here, because it cannot be told for certain whose it is.',
    account: {
      name: user.name,
      email: user.email || null,
      guest: isGuest(userId),
      createdAt: iso(user.createdAt),
    },
    circles,
    invitationsSent,
    notesSent,
    picturesSent,
    ownTelevisions,
    browsersToNudge: browsers.map((b) => ({ pushService: pushServiceOf(b.endpoint), savedAt: iso(b.savedAt) })),
    linkedApps,
    signIns: of('SESSION').map((record) => (record.expiresAt === undefined ? {} : { expiresAt: iso(record.expiresAt) })),
  };
}
