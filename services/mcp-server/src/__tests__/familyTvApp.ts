/**
 * Test-only: the real Wick server on a real socket with a family member's
 * own television connected to it, for the end-to-end tests of /tv. Nothing
 * is paired: the two rows pairing leaves behind (the television's own, and
 * the pairing key's public half) are written directly, and the token is
 * signed by the edge's own signJwt.
 */
import { generateKeyPairSync } from 'node:crypto';
import { PAIRING_PUBLIC_KEY_ROW, type CardPatch, type HomeState } from '@wick/contracts';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { signJwt } from '../../../edge-device/lambda/jwt.mjs';
import type { AppDeps } from '../server.js';
import { startServer, type Harness, type Linked } from './harness.js';
import { createMemoryTable, type MemoryTable } from './memoryTable.js';

export const MIN = 60_000;
export const PICTURE = 'https://download.example/ring/frame.jpg?sig=abc';

export const PAIRING = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
export const sign = signJwt as (claims: object, privateKeyPem: string, options: { expiresInSec: number }) => string;

const closers: (() => Promise<void>)[] = [];

/** For a test file's afterEach: every server this file's tests started is closed. */
export const closeServers = async (): Promise<void> => {
  await Promise.all(closers.splice(0).map((close) => close()));
};

export interface Home {
  readonly h: Harness;
  readonly table: MemoryTable;
  readonly patches: { patch: CardPatch; householdId: string }[];
  readonly homes: { householdId: string; home: HomeState }[];
  /** Every card taken back off the resident's televisions, in order. */
  readonly withdrawn: { householdId: string; cardId: string }[];
}

export async function server(overrides: Partial<AppDeps> = {}): Promise<Home> {
  const table = createMemoryTable();
  const patches: Home['patches'] = [];
  const homes: Home['homes'] = [];
  const withdrawn: Home['withdrawn'] = [];
  const h = await startServer({
    ddb: table.ddb,
    sendPatch: async (patch, householdId) => void patches.push({ patch, householdId }),
    sendHome: async (householdId, home) => void homes.push({ householdId, home }),
    withdrawCard: async (householdId, cardId) => void withdrawn.push({ householdId, cardId }),
    ...overrides,
  });
  closers.push(h.close);
  // What pair-claim.mjs publishes when a family television is connected.
  table.put({ pk: { S: PAIRING_PUBLIC_KEY_ROW.pk }, sk: { S: PAIRING_PUBLIC_KEY_ROW.sk }, publicKeyPem: { S: PAIRING.publicKey } });
  return { h, table, patches, homes, withdrawn };
}

/** Connects a television as this person's own, as pair-claim.mjs would with `as: 'family'`, and returns its token. */
export function connectTelevision(table: MemoryTable, who: Linked, deviceId = 'tv-own', extra: Record<string, unknown> = {}): string {
  table.put({
    pk: { S: `HH#${who.householdId}` },
    sk: { S: `FTV#${deviceId}` },
    deviceId: { S: deviceId },
    householdId: { S: who.householdId },
    userId: { S: who.userId },
    pairedAt: { N: String(Date.now()) },
    denylisted: { BOOL: false },
  });
  return sign({ deviceId, householdId: who.householdId, kind: 'family', userId: who.userId, ...extra }, PAIRING.privateKey, { expiresInSec: 3600 });
}

export const tv = (h: Harness, token: string | undefined, path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${h.base}${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...(token ? { authorization: `Bearer ${token}` } : {}) } });

export const press = (h: Harness, token: string | undefined, body: unknown, path = '/tv/press', headers: Record<string, string> = {}): Promise<Response> =>
  tv(h, token, path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

/** A stranger at the door, and the resident's press on "Ask … to look". */
export function askToLook(table: MemoryTable, householdId: string, cardId = 'door-abc'): void {
  const now = Date.now();
  table.put({
    pk: { S: `HH#${householdId}` },
    sk: { S: `CARD#${cardId}` },
    data: {
      S: JSON.stringify({
        id: cardId,
        urgency: 'DOOR',
        queuedAt: now - MIN,
        expiresAt: now + 4 * MIN,
        shownCount: 0,
        card: { type: 'DOOR', id: cardId, householdId, line: "Someone's at the front door.", description: 'A man in a yellow jacket.', imageRef: PICTURE, actions: [] },
      }),
    },
  });
  table.put({ pk: { S: `HH#${householdId}` }, sk: { S: `LOOK#${cardId}` }, cardId: { S: cardId }, askedAt: { N: String(now - 30_000) } });
}

export const lookRow = (table: MemoryTable, householdId: string, cardId = 'door-abc') => table.rows(`HH#${householdId}`).find((row) => row.sk?.S === `LOOK#${cardId}`);
