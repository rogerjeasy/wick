/**
 * Test-only: Margaret's home with Sarah's television connected, for the
 * tests of what the Wick server says to it (accounts/familyTelevision.ts).
 * A real RSA key pair signs the tokens; the table and the account store are
 * the in-memory ones, with every request of either counted.
 */
import { createHmac, createSign, generateKeyPairSync } from 'node:crypto';
import { expect } from 'vitest';
import type { AttributeValue, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PAIRING_PUBLIC_KEY_ROW, type CardPatch, type FamilyTvHome, type HomeState, type QueuedCard, type ReachPerson, type ReachRequest } from '@wick/contracts';
import { reachFromItem } from '@wick/agent';
import { createMemoryTable, type MemoryTable } from '../../__tests__/memoryTable.js';
import { createFamilyTelevision, type FamilyTelevisionDeps } from '../familyTelevision.js';
import type { AccountStore } from '../store.js';
import type { Membership } from '../types.js';
import { createMemoryStore } from './memoryStore.js';

/** Monday 12 October 2026, 10:30 in London (BST). */
export const NOW = Date.UTC(2026, 9, 12, 9, 30);
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const PICTURE = 'https://download.example/ring/frame.jpg?sig=abc';

export const pem = () => generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
/** The pairing key, as the edge holds it (Secrets Manager) and publishes its public half. */
export const PAIRING = pem();
/** Somebody else's key: a token signed with it is nobody's. */
export const STRANGER = pem();

export const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

export const SARAHS_TV = { deviceId: 'tv-sarah', householdId: 'hh-1', kind: 'family', userId: 'u_sarah' };

/**
 * A token as jwt.mjs's signJwt makes one, with every part open to being
 * made wrong: the header, when it expires, and what it is signed with.
 */
export function token(
  claims: Record<string, unknown> = SARAHS_TV,
  made: { header?: Record<string, unknown>; exp?: unknown; signedWith?: string; signature?: 'rsa' | 'hmac-of-public-key' | 'none' } = {},
): string {
  const iat = Math.floor(NOW / 1000) - 60;
  // Thirty days, as a television is paired for (edge-device pairing-code.mjs DEVICE_TOKEN_TTL_SEC).
  const payload = { ...claims, iat, ...(made.exp === null ? {} : { exp: made.exp ?? iat + 30 * 86_400 }) };
  const signingInput = `${b64(made.header ?? { alg: 'RS256', typ: 'JWT' })}.${b64(payload)}`;
  const signature =
    made.signature === 'none'
      ? ''
      : made.signature === 'hmac-of-public-key'
        ? createHmac('sha256', PAIRING.publicKey).update(signingInput).digest('base64url')
        : createSign('RSA-SHA256').update(signingInput).sign(made.signedWith ?? PAIRING.privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

export const bearer = (jwt: string = token()): string => `Bearer ${jwt}`;

export interface TableRequest {
  readonly command: string;
  readonly pk: string;
  readonly sk: string;
  readonly consistent: boolean;
}

export interface World {
  readonly table: MemoryTable;
  readonly store: AccountStore;
  readonly tv: ReturnType<typeof createFamilyTelevision>;
  /** Every request made of the table, in order. */
  readonly requests: TableRequest[];
  /** Every call made of the account store, by name. */
  readonly storeCalls: string[];
  readonly patches: { patch: CardPatch; householdId: string }[];
  readonly cards: QueuedCard[];
  /** Every card taken back off the resident's televisions, in order. */
  readonly withdrawn: { householdId: string; cardId: string }[];
  readonly homes: { householdId: string; home: HomeState }[];
  /** Something to do just before the table carries out a request (a race, a fault). */
  before(hook: (request: TableRequest) => void): void;
  clock: number;
  /** The server's sender to her television fails (egress is down). */
  sendFails: boolean;
}

export const member = (over: Partial<Membership> = {}): Membership => ({
  householdId: 'hh-1',
  userId: 'u_sarah',
  name: 'Sarah Hughes',
  role: 'organiser',
  status: 'allowed',
  requestedAt: 1,
  ...over,
});

/** The row pair-claim.mjs writes for a family member's own television. */
/** When the television's background service was last handed its narrower token (edge-device pair-refresh.mjs `serviceSince`). */
export const SERVICE_SINCE = NOW - 2 * HOUR;

export function putFamilyTv(
  table: MemoryTable,
  over: { householdId?: string; deviceId?: string; userId?: string; denylisted?: boolean; /** null: no service has ever been started for it. */ serviceSince?: number | null } = {},
): void {
  const householdId = over.householdId ?? 'hh-1';
  const deviceId = over.deviceId ?? 'tv-sarah';
  table.put({
    pk: { S: `HH#${householdId}` },
    sk: { S: `FTV#${deviceId}` },
    deviceId: { S: deviceId },
    householdId: { S: householdId },
    userId: { S: over.userId ?? 'u_sarah' },
    pairedAt: { N: String(NOW - HOUR) },
    denylisted: { BOOL: over.denylisted ?? false },
    ...(over.serviceSince === null ? {} : { serviceSince: { N: String(over.serviceSince ?? SERVICE_SINCE) } }),
  });
}

export const putPublicKey = (table: MemoryTable, publicKeyPem: string = PAIRING.publicKey): void =>
  table.put({ pk: { S: PAIRING_PUBLIC_KEY_ROW.pk }, sk: { S: PAIRING_PUBLIC_KEY_ROW.sk }, publicKeyPem: { S: publicKeyPem } });

/**
 * Margaret's home (hh-1) with Sarah allowed and her television connected,
 * and a second home (hh-2, Edith's) that nothing here may ever reach.
 */
export async function world(options: { publicKey?: boolean; familyTv?: boolean; sarah?: Partial<Membership>; simulated?: boolean; resident?: string } = {}): Promise<World> {
  const table = createMemoryTable();
  const requests: TableRequest[] = [];
  const hooks: ((request: TableRequest) => void)[] = [];
  const ddb = {
    send: async (command: { constructor: { name: string }; input: { Key?: Record<string, AttributeValue>; Item?: Record<string, AttributeValue>; ExpressionAttributeValues?: Record<string, AttributeValue>; ConsistentRead?: boolean } }) => {
      const { input } = command;
      const request: TableRequest = {
        command: command.constructor.name,
        pk: input.Key?.pk?.S ?? input.Item?.pk?.S ?? input.ExpressionAttributeValues?.[':pk']?.S ?? '',
        sk: input.Key?.sk?.S ?? input.Item?.sk?.S ?? input.ExpressionAttributeValues?.[':prefix']?.S ?? input.ExpressionAttributeValues?.[':from']?.S ?? '',
        consistent: input.ConsistentRead === true,
      };
      requests.push(request);
      for (const hook of hooks) hook(request);
      return (table.ddb as unknown as { send: (c: unknown) => Promise<unknown> }).send(command);
    },
  } as unknown as DynamoDBClient;

  const memory = createMemoryStore();
  const storeCalls: string[] = [];
  const store = new Proxy(memory, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        storeCalls.push(String(property));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as AccountStore;

  await memory.createHousehold({ householdId: 'hh-1', name: 'Mum’s house', residentName: options.resident ?? 'Margaret', createdBy: 'u_sarah', createdAt: 1, ...(options.simulated ? { simulated: true } : {}) });
  await memory.putMembership(member(options.sarah));
  await memory.createHousehold({ householdId: 'hh-2', name: 'Edith’s home', residentName: 'Edith', createdBy: 'u_tom', createdAt: 1 });
  await memory.putMembership(member({ householdId: 'hh-2', userId: 'u_tom', name: 'Tom' }));

  if (options.publicKey !== false) putPublicKey(table);
  if (options.familyTv !== false) putFamilyTv(table);

  const patches: World['patches'] = [];
  const cards: QueuedCard[] = [];
  const withdrawn: World['withdrawn'] = [];
  const homes: World['homes'] = [];
  const w: World = {
    table,
    store,
    requests,
    storeCalls,
    patches,
    cards,
    withdrawn,
    homes,
    before: (hook) => void hooks.push(hook),
    clock: NOW,
    sendFails: false,
    tv: undefined as never,
  };
  const deps: FamilyTelevisionDeps = {
    ddb,
    store,
    sendCard: async (card) => {
      if (w.sendFails) throw new Error('egress is down');
      cards.push(card);
    },
    sendPatch: async (patch, householdId) => void patches.push({ patch, householdId }),
    withdrawCard: async (householdId, cardId) => void withdrawn.push({ householdId, cardId }),
    sendHome: async (householdId, home) => void homes.push({ householdId, home }),
    now: () => w.clock,
  };
  (w as { tv: World['tv'] }).tv = createFamilyTelevision(deps);
  return w;
}

/** A door card on the resident's television, as egress.ts stores it. */
export function putDoorCard(table: MemoryTable, cardId: string, over: { description?: string; imageRef?: string } = {}, expiresAt = NOW + 4 * MIN, householdId = 'hh-1'): void {
  table.put({
    pk: { S: `HH#${householdId}` },
    sk: { S: `CARD#${cardId}` },
    data: {
      S: JSON.stringify({
        id: cardId,
        urgency: 'DOOR',
        queuedAt: NOW - MIN,
        expiresAt,
        shownCount: 0,
        card: { type: 'DOOR', id: cardId, householdId, line: "Someone's at the front door.", actions: [], ...over },
      }),
    },
  });
}

/** The row askFamily.ts writes when the resident presses "Ask … to look". */
export function putLook(table: MemoryTable, cardId: string, askedAt: number, over: Record<string, AttributeValue> = {}, householdId = 'hh-1'): void {
  table.put({
    pk: { S: `HH#${householdId}` },
    sk: { S: `LOOK#${cardId}` },
    cardId: { S: cardId },
    askedAt: { N: String(askedAt) },
    ...over,
  });
}

export const lookRow = (table: MemoryTable, cardId: string, householdId = 'hh-1') => table.rows(`HH#${householdId}`).find((row) => row.sk?.S === `LOOK#${cardId}`);

export const REACH_ID = String(NOW - 2 * MIN);
export const sarah: ReachPerson = { userId: 'u_sarah', name: 'Sarah Hughes', role: 'organiser' };
export const david: ReachPerson = { userId: 'u_david', name: 'David', role: 'family' };

export const reach = (over: Partial<ReachRequest> = {}): ReachRequest => ({
  householdId: 'hh-1',
  reachId: REACH_ID,
  kind: 'ring',
  askedAt: NOW - 2 * MIN,
  order: [sarah, david],
  asked: 1,
  ...over,
});

export const storedReach = (table: MemoryTable, householdId = 'hh-1'): ReachRequest | undefined =>
  reachFromItem(table.rows(`HH#${householdId}`).find((row) => row.sk?.S === `REACH#${REACH_ID}`));

/** A television of Margaret's that has been in use today: her light is lit. */
export const litToday = (table: MemoryTable): void => table.put({ pk: { S: 'HH#hh-1' }, sk: { S: 'DEV#wick-tv' }, activeSignalAt: { N: String(NOW - HOUR) } });

export const keepsRhythmPrivate = (table: MemoryTable): void => table.put({ pk: { S: 'HH#hh-1' }, sk: { S: 'META' }, residentExclusions: { SS: ['RHYTHM'] } });

export const lookInRow = (table: MemoryTable) => table.rows('HH#hh-1').find((row) => row.sk?.S === 'LOOKIN#u_sarah');

export const homeOf = async (w: World, authorization: string = bearer()): Promise<FamilyTvHome> => {
  const reply = await w.tv.home(authorization);
  expect(reply.status).toBe(200);
  return reply.body as FamilyTvHome;
};

/** The household rows asked for: everything but the published key. */
export const householdRequests = (w: World): TableRequest[] => w.requests.filter((r) => r.pk !== PAIRING_PUBLIC_KEY_ROW.pk);
