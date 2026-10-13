/**
 * POST /pair/refresh {deviceId} — mints a fresh device-bound JWT for a
 * television that is already paired, without going through a new six-digit
 * code.
 *
 * Exists because CardService.ts (apps/tv-vega) runs in a process separate
 * from App.tsx with no shared JS memory, and on the Vega Virtual Device
 * `/data` never actually holds a written file (FRICTION.md FL-013) — so the
 * on-disk token cache both processes normally share can never actually do
 * its job. This endpoint makes the durable binding pair-claim.mjs writes
 * the real source of truth for "is this device paired", instead of that
 * broken local disk file.
 *
 * INV-8: the household is looked up from the device id (device-owner.mjs).
 * It used to be read from the request body, so a caller could name any
 * household a device id happened to be bound under.
 *
 * SECURITY NOTE (root cause: FRICTION.md FL-013): this endpoint still has
 * no proof of possession — the device id is the only input, and on a
 * television whose storage does not persist it is a constant in the build
 * (apps/tv-vega/src/deviceId.ts). Anyone who knows a paired television's
 * id can mint a token for it. The textbook fix — a client-held asymmetric
 * keypair, proof-of-possession on refresh — doesn't work in this codebase
 * today: the client can't persist anything reliably, and since this repo is
 * open source, no client-embedded secret would be confidential either.
 * Accepted, bounded trade-off instead: INV-1 already scopes what this token
 * can do (no Ring/family-surface access — see PairingFlow.ts),
 * REFRESH_TOKEN_TTL_SEC is far shorter than a real pairing's token so a
 * wrongly-minted one expires fast, the cooldown throttles repeated minting,
 * and a television with working storage generates an unguessable id of its
 * own. Revisit if SP-8 (real Fire TV hardware, FRICTION.md Open Slots) shows
 * on-device storage actually works there, since that would make real
 * proof-of-possession viable.
 *
 * `createHandler` takes its DynamoDB send, signing key and clock, so it is
 * tested without AWS (__tests__/pair-refresh.test.ts).
 */
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { signJwt, verifyJwt } from './jwt.mjs';
import { REFRESH_TOKEN_TTL_SEC, nextRefreshWindow } from './pairing-code.mjs';
import { deviceOwnerKey, householdOfDevice } from './device-owner.mjs';
import { FAMILY_KIND, familyClaims, familyTelevisionKey } from './family-television.mjs';

/** The bearer token of a request, whatever case the header arrived in. */
function bearer(headers) {
  const value = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'authorization')?.[1];
  const match = typeof value === 'string' ? /^Bearer\s+(\S+)$/i.exec(value) : null;
  return match ? match[1] : undefined;
}

export function createHandler({ send, privateKey, publicKey, now, table }) {
  return async (event) => {
    let body;
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return { statusCode: 400, body: 'bad_json' };
    }
    const { deviceId } = body;
    if (!deviceId) return { statusCode: 400, body: 'deviceId_required' };

    const owner = await send(new GetItemCommand({ TableName: table, Key: deviceOwnerKey(deviceId) }));
    const householdId = householdOfDevice(owner.Item);
    if (!householdId) return { statusCode: 404, body: 'device_not_paired' };

    // Which kind of television this is comes from which row it has — never from
    // the request. The resident's is a DEV# row; a family member's own is an
    // FTV# row that says whose (family-television.mjs), and its token keeps
    // saying so: refreshing can never turn one kind into the other.
    const residentKey = { pk: { S: `HH#${householdId}` }, sk: { S: `DEV#${deviceId}` } };
    const isResidents = Boolean((await send(new GetItemCommand({ TableName: table, Key: residentKey }))).Item);
    const bindingKey = isResidents ? residentKey : familyTelevisionKey(householdId, deviceId);
    let familyUserId;

    // Counted on the binding row, and written only if the row still says
    // what was read: the app and its card service ask a second apart, and
    // neither may lose its place to the other.
    for (let attempt = 0; ; attempt += 1) {
      const item = (await send(new GetItemCommand({ TableName: table, Key: bindingKey }))).Item;
      if (!item) return { statusCode: 404, body: 'device_not_paired' };
      if (item.denylisted?.BOOL) return { statusCode: 403, body: 'device_denylisted' };
      if (!isResidents) {
        familyUserId = item.userId?.S;
        if (!familyUserId) return { statusCode: 404, body: 'device_not_paired' };
        // A family television shows one person's view of a home, so its token
        // is never minted from the device id alone — an id can be guessed.
        // It shows the token it held (one that has run out will do: the
        // question is whether it ever held one), and that token must be this
        // television's, this member's, and Wick's.
        const heldToken = bearer(event.headers);
        if (!heldToken) return { statusCode: 401, body: 'token_required' };
        let held;
        try {
          held = verifyJwt(heldToken, await publicKey(), { ignoreExpiry: true });
        } catch {
          return { statusCode: 401, body: 'invalid_token' };
        }
        if (held.kind !== FAMILY_KIND || held.deviceId !== deviceId || held.householdId !== householdId || held.userId !== familyUserId) {
          return { statusCode: 401, body: 'invalid_token' };
        }
      }

      const next = nextRefreshWindow(item, now());
      if (!next) return { statusCode: 429, body: 'refresh_rate_limited' };
      const counted = item.refreshWindowAt && item.refreshCount;
      try {
        await send(new UpdateItemCommand({
          TableName: table,
          Key: bindingKey,
          UpdateExpression: 'SET refreshWindowAt = :at, refreshCount = :count',
          ConditionExpression: counted
            ? 'refreshWindowAt = :wasAt AND refreshCount = :wasCount'
            : 'attribute_exists(pk) AND attribute_not_exists(refreshWindowAt)',
          ExpressionAttributeValues: {
            ':at': { N: String(next.at) },
            ':count': { N: String(next.count) },
            ...(counted ? { ':wasAt': item.refreshWindowAt, ':wasCount': item.refreshCount } : {}),
          },
        }));
        break;
      } catch (err) {
        if (err?.name !== 'ConditionalCheckFailedException') throw err;
        if (attempt >= 2) return { statusCode: 429, body: 'refresh_rate_limited' };
      }
    }

    const claims = { deviceId, householdId, ...(familyUserId ? familyClaims(familyUserId) : {}) };
    const jwt = signJwt(claims, await privateKey(), { expiresInSec: REFRESH_TOKEN_TTL_SEC });
    const token = { jwt, deviceId, householdId, expiresAt: now() + REFRESH_TOKEN_TTL_SEC * 1000, ...(familyUserId ? { kind: FAMILY_KIND } : {}) };

    return { statusCode: 200, body: JSON.stringify({ token }) };
  };
}

const ddb = new DynamoDBClient({});
const sm = new SecretsManagerClient({});

let cachedKeys = null;
async function keys() {
  if (cachedKeys) return cachedKeys;
  const r = await sm.send(new GetSecretValueCommand({ SecretId: process.env.PAIRING_SIGNING_KEY_SECRET_ARN }));
  cachedKeys = JSON.parse(r.SecretString);
  return cachedKeys;
}
const privateKey = async () => (await keys()).privateKeyPem;
const publicKey = async () => (await keys()).publicKeyPem;

export const handler = createHandler({
  send: (command) => ddb.send(command),
  privateKey,
  publicKey,
  now: Date.now,
  table: process.env.TABLE_NAME,
});
