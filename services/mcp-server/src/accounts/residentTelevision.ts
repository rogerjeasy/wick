/**
 * The resident stops Wick, from her own television: the last page of "What
 * your family sees" (edge-device sharing.mjs), then her "Yes, delete
 * everything". Her television asks this itself, with its own device token,
 * because it is the one thing in Wick she alone may decide and no family
 * member's sign-in should be needed for it (docs/WICK.md §8: withdrawal is
 * unconditional).
 *
 *   POST /tv/stop   { "confirm": "stop" }   → { "stopped": true }
 *
 * Who is asking is the token's television, and nothing else (INV-8): a
 * resident's device token — not a family member's television's, not the
 * narrow token of a background service — whose `DEV#` row is still there
 * and not revoked. Its home is closed as its organiser's deletion closes it
 * (myData.ts closeHomeAtHerWord): the doorbell disconnected first, then
 * every television, picture, membership, memory and row. The television
 * then shows a new code, as a disconnected one does.
 *
 * The body must say `confirm: "stop"`: a request that does not say so in
 * words closes nothing.
 */
import { GetItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { isFamilyTelevisionToken } from '@wick/contracts';
import { deviceTokenVerifier } from './familyTelevision.js';
import { AccountRefusal } from './myData.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';

export const STOP_CONFIRMATION = 'stop';

export interface ResidentTelevisionDeps {
  readonly ddb: DynamoDBClient;
  readonly now: () => number;
  /** myData.ts closeHomeAtHerWord, bound to the deployment's stores. */
  readonly closeHome: (householdId: string) => Promise<void>;
}

export type StopReply =
  | { readonly status: 200; readonly body: { readonly stopped: true } }
  | { readonly status: 400 | 401 | 403 | 502; readonly body: { readonly error: string; readonly say?: string } };

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128;

export function createResidentTelevision(deps: ResidentTelevisionDeps): { stop(authorization: string | undefined, body: unknown): Promise<StopReply> } {
  const verifiedClaims = deviceTokenVerifier(deps.ddb, deps.now);

  return {
    async stop(authorization, body) {
      const verified = await verifiedClaims(authorization);
      // The verifier refuses only with 401 (no token, a bad one, one run out).
      if ('status' in verified) return { status: 401, body: verified.body };
      const { claims } = verified;
      // Hers alone: a family member's television, and any token that names a scope, is refused.
      if (isFamilyTelevisionToken(claims) || 'scope' in claims || 'kind' in claims) return { status: 403, body: { error: 'not_her_television' } };
      const { householdId, deviceId } = claims;
      if (!text(householdId) || !text(deviceId)) return { status: 401, body: { error: 'invalid_token' } };

      if ((body as { confirm?: unknown } | null)?.confirm !== STOP_CONFIRMATION) return { status: 400, body: { error: 'not_confirmed' } };

      // Consistent: a television disconnected a moment ago closes nothing.
      const row = (await deps.ddb.send(new GetItemCommand({
        TableName: TABLE,
        Key: { pk: { S: `HH#${householdId}` }, sk: { S: `DEV#${deviceId}` } },
        ConsistentRead: true,
      }))).Item;
      if (!row || (row.denylisted !== undefined && row.denylisted.BOOL !== false)) return { status: 401, body: { error: 'television_not_connected' } };

      try {
        await deps.closeHome(householdId);
      } catch (err) {
        if (err instanceof AccountRefusal && err.status === 502) return { status: 502, body: { error: err.code, say: err.message } };
        throw err;
      }
      // What was closed, and nothing from the token.
      console.log(JSON.stringify({ level: 'info', msg: 'home_stopped_by_resident' }));
      return { status: 200, body: { stopped: true } };
    },
  };
}
