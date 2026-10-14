/**
 * POST /pair/claim {code}, with the organiser's bearer token — the family
 * app confirms the six-digit code shown on the television.
 *
 * Until accounts existed, this took `{code, householdId}` from anyone and
 * believed it. Now:
 *
 *   - The caller must hold a Wick access token (wick-auth.mjs), and must be
 *     the organiser of the household that token is for.
 *   - INV-8: the television is connected to that household. Nothing in the
 *     request can name another.
 *   - A television that already belongs to another household is refused
 *     (device-owner.mjs).
 *
 * With `as: 'family'` the television is connected as the signed-in member's
 * own ("Sarah's television", family-television.mjs): any member the resident
 * has allowed, a row of its own kind, and a token that says whose it is.
 *
 * Binds deviceId <-> householdId, mints the device-bound JWT (§4.2 step 3),
 * and stores it on the pairing nonce for the TV's next poll to collect.
 *
 * The television's proof (proof.mjs) goes with the binding: the hash
 * pair-start.mjs wrote on the nonce is written on the television's row, and
 * a television paired without one has none. The token says it was earned by
 * pairing (`proof: 'pairing'`). And when the television said which one it
 * was until now (`replaces`, pair-start.mjs), that television's row is
 * removed — from this home only, and only if it keeps the same proof
 * (`removeReplaced`). Nothing here returns the device id: the Wick server
 * that calls this needs only to know it worked.
 *
 * `createHandler` takes its DynamoDB send, signing key and clock, so the
 * whole decision is tested without AWS (__tests__/pair-claim.test.ts).
 */
import { randomBytes } from 'node:crypto';
import { DynamoDBClient, GetItemCommand, PutItemCommand, TransactWriteItemsCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { signJwt } from './jwt.mjs';
import { isExpired, DEVICE_TOKEN_TTL_SEC } from './pairing-code.mjs';
import { accessTokenKey, bearerToken, grantFromItem, mayConnectOwnTelevision, mayConnectTelevision, membershipKey } from './wick-auth.mjs';
import { FAMILY_KIND, familyClaims, familyTelevisionKey, kindAskedFor, publicKeyItem } from './family-television.mjs';
import { claimDeviceOwner, deviceOwnerKey } from './device-owner.mjs';
import { PROVEN_BY_PAIRING } from './proof.mjs';

/**
 * What the family app may call a television by (`televisionRef` on its row):
 * random, and nothing of the device id. The family is never told the id
 * itself (AGENTS.md INV-1), so this is how a television is named when one
 * is disconnected. Kept on a row that already has one.
 */
export function newTelevisionRef() {
  return randomBytes(16).toString('base64url');
}

const conditionFailed = (err) => err?.name === 'ConditionalCheckFailedException';

export function createHandler({ send, privateKey, publicKey, now, table }) {
  const get = async (Key, extra = {}) => (await send(new GetItemCommand({ TableName: table, Key, ...extra }))).Item;

  return async (event) => {
    let body;
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return { statusCode: 400, body: 'bad_json' };
    }
    const { code } = body;
    if (!code) return { statusCode: 400, body: 'code_required' };
    const kind = kindAskedFor(body.as);
    if (kind === null) return { statusCode: 400, body: 'bad_kind' };
    const asFamily = kind === FAMILY_KIND;

    const token = bearerToken(event.headers);
    if (!token) return { statusCode: 401, body: 'sign_in_required' };
    const grant = grantFromItem(await get(accessTokenKey(token), { ConsistentRead: true }), now());
    if (!grant) return { statusCode: 401, body: 'invalid_token' };
    const { householdId, userId } = grant;

    const member = await get(membershipKey(householdId, userId), { ConsistentRead: true });
    if (asFamily) {
      if (!mayConnectOwnTelevision(member)) return { statusCode: 403, body: 'not_allowed_yet' };
    } else if (!mayConnectTelevision(member)) {
      return { statusCode: 403, body: 'only_the_organiser_can_connect_a_television' };
    }

    const item = await get({ pk: { S: `PAIR#${code}` }, sk: { S: 'META' } });
    if (!item) return { statusCode: 404, body: 'unknown_or_expired_code' };
    if (isExpired({ expiresAt: Number(item.expiresAt.N) }, now())) return { statusCode: 410, body: 'code_expired' };
    if (item.claimed?.BOOL) return { statusCode: 409, body: 'already_claimed' };

    const deviceId = item.deviceId.S;

    // One television, one kind. The resident's is a DEV# row and a family
    // member's own is an FTV# row; a television with both would be served
    // as either. It has to be disconnected before it can be the other.
    const residents = { pk: { S: `HH#${householdId}` }, sk: { S: `DEV#${deviceId}` } };
    if (asFamily && (await get(residents, { ConsistentRead: true }))) return { statusCode: 409, body: 'already_the_residents_television' };
    if (!asFamily && (await get(familyTelevisionKey(householdId, deviceId), { ConsistentRead: true }))) return { statusCode: 409, body: 'already_a_family_television' };

    // A television belongs to one household. Claimed before anything else is
    // written, so a refusal here leaves no trace.
    try {
      await send(new PutItemCommand(claimDeviceOwner({ table, deviceId, householdId, at: now() })));
    } catch (err) {
      if (!conditionFailed(err)) throw err;
      return { statusCode: 409, body: 'television_in_another_home' };
    }

    const jwt = signJwt({ deviceId, householdId, ...(asFamily ? familyClaims(userId) : {}), proof: PROVEN_BY_PAIRING }, await privateKey(), { expiresInSec: DEVICE_TOKEN_TTL_SEC });
    const tokenExpiresAt = now() + DEVICE_TOKEN_TTL_SEC * 1000;

    // Atomically claim the pairing code BEFORE writing the device binding.
    // This is the sole correctness guarantee against two concurrent claims of
    // the same code (INV-1: exactly one household per device): the read above
    // is only a fast-path/UX check (404/410 messages), not the gate. Exactly
    // one concurrent caller can win this conditional update; the loser hits
    // ConditionalCheckFailedException below and never writes a device binding.
    try {
      await send(new UpdateItemCommand({
        TableName: table,
        Key: { pk: { S: `PAIR#${code}` }, sk: { S: 'META' } },
        UpdateExpression: 'SET claimed = :true, deliveryToken = :tok',
        ConditionExpression: 'attribute_exists(pk) AND claimed = :false',
        ExpressionAttributeValues: {
          ':true': { BOOL: true },
          ':false': { BOOL: false },
          ':tok': { S: JSON.stringify({ jwt, deviceId, householdId, expiresAt: tokenExpiresAt, ...(asFamily ? { kind: FAMILY_KIND } : {}) }) },
        },
      }));
    } catch (err) {
      if (!conditionFailed(err)) throw err;
      // The condition is a conjunction, so DynamoDB doesn't tell us which half
      // failed. The item existed and was unclaimed at the GetItem above a
      // moment ago, so the overwhelmingly likely cause is a concurrent claim
      // winning the race — 409 is the right status for that case.
      return { statusCode: 409, body: 'already_claimed' };
    }

    // Bind deviceId <-> householdId without clobbering an existing denylist
    // flag: this row may already exist for this device from a prior pairing
    // that was since denylisted, and re-pairing must not silently restore
    // access. UpdateItem + if_not_exists only initializes `denylisted` to
    // false when the attribute is not already present; an existing `true`
    // survives untouched.
    // A family television's row is of its own kind — never DEV#, which is
    // what makes a television the resident's (family-television.mjs) — and
    // says whose it is.
    //
    // The proof is the pairing's: the hash this code was asked for with, or
    // none. A television paired again brings its own, and the organiser
    // entering the code on its screen is what makes it the right one.
    const proofHash = item.proofHash?.S;
    await send(new UpdateItemCommand({
      TableName: table,
      Key: asFamily ? familyTelevisionKey(householdId, deviceId) : { pk: { S: `HH#${householdId}` }, sk: { S: `DEV#${deviceId}` } },
      UpdateExpression:
        `SET deviceId = :did, householdId = :hhid, pairedAt = :pa, pairedBy = :by, denylisted = if_not_exists(denylisted, :false), televisionRef = if_not_exists(televisionRef, :ref)${asFamily ? ', userId = :by' : ''}${proofHash ? ', proofHash = :proofHash' : ' REMOVE proofHash'}`,
      ExpressionAttributeValues: {
        ':did': { S: deviceId },
        ':hhid': { S: householdId },
        ':pa': { N: String(now()) },
        ':by': { S: userId },
        ':false': { BOOL: false },
        ':ref': { S: newTelevisionRef() },
        ...(proofHash ? { ':proofHash': { S: proofHash } } : {}),
      },
    }));

    // The television this one was until now, if it said so and can prove it.
    if (item.replacesDeviceId?.S && item.replacesProofHash?.S && item.replacesDeviceId.S !== deviceId) {
      await removeReplaced({ send, table, householdId, deviceId: item.replacesDeviceId.S, proofHash: item.replacesProofHash.S });
    }

    if (asFamily && publicKey) {
      // So the Wick server can check this television's token (family-television.mjs). Never the reason a pairing fails.
      try {
        await send(new PutItemCommand({ TableName: table, Item: publicKeyItem(await publicKey()) }));
      } catch (err) {
        console.error('pairing_public_key_not_published', { err: err?.name });
      }
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, ...(asFamily ? { kind: FAMILY_KIND } : {}) }) };
  };
}

/**
 * Removes the row of the television a newly paired one was until now — of
 * either kind, in this home only (INV-8), and only if it keeps the proof the
 * television showed for it: nobody can name another television here and
 * have it disconnected. The claim on its old id goes with it, if it is this
 * home's.
 *
 * Never the reason a pairing fails. Removal needs DeleteItem; where this
 * Lambda's role has not been given it yet, the old row is revoked instead
 * (`denylisted`), which every path that serves a television honours and the
 * family app's lists leave out. Logged without either id.
 */
export async function removeReplaced({ send, table, householdId, deviceId, proofHash }) {
  for (const key of [{ pk: { S: `HH#${householdId}` }, sk: { S: `DEV#${deviceId}` } }, familyTelevisionKey(householdId, deviceId)]) {
    try {
      await send(new TransactWriteItemsCommand({
        TransactItems: [
          { Delete: { TableName: table, Key: key, ConditionExpression: 'proofHash = :proofHash', ExpressionAttributeValues: { ':proofHash': { S: proofHash } } } },
          {
            Delete: {
              TableName: table,
              Key: deviceOwnerKey(deviceId),
              ConditionExpression: 'attribute_not_exists(pk) OR householdId = :hh',
              ExpressionAttributeValues: { ':hh': { S: householdId } },
            },
          },
        ],
      }));
      console.log(JSON.stringify({ level: 'info', msg: 'replaced_television_removed' }));
      return 'removed';
    } catch (err) {
      // Not this kind, not this home's, or not the same proof: nothing to do with this key.
      if (err?.name === 'TransactionCanceledException') continue;
      try {
        await send(new UpdateItemCommand({
          TableName: table,
          Key: key,
          UpdateExpression: 'SET denylisted = :true',
          ConditionExpression: 'proofHash = :proofHash',
          ExpressionAttributeValues: { ':true': { BOOL: true }, ':proofHash': { S: proofHash } },
        }));
        console.log(JSON.stringify({ level: 'info', msg: 'replaced_television_revoked', removeFailed: err?.name ?? 'error' }));
        return 'revoked';
      } catch (fallback) {
        if (conditionFailed(fallback)) continue;
        console.error(JSON.stringify({ level: 'error', msg: 'replaced_television_kept', reason: fallback?.name ?? 'error' }));
        return 'kept';
      }
    }
  }
  return 'none';
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
