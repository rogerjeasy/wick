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
 * A family member's own television is not under that exception: its token
 * is minted only for one that shows the token it held (below).
 *
 * SECOND KNOWN EXCEPTION, CONTAINED — what waits, said off the screen
 * (root cause: FRICTION.md FL-013 again, and what was found on the Vega
 * Virtual Device on 2026-10-13). A family television's background service
 * (apps/tv-vega CardService.ts) is a separate process from its app, and on
 * Vega nothing passes from one to the other on the television: the
 * service's start is given no data, a query on its `pkg://` address is
 * readable nowhere, storage is not shared, and a second launch of the
 * running service is not delivered. So the app cannot hand over the token
 * that is the proof. The hand-off goes through here instead:
 *
 *   - The app, showing its own token as always, adds `forService: true`.
 *     That stamps two things on its row: `serviceUntil`, SERVICE_WINDOW_MS
 *     from now, and `serviceFrom`, a keyed fingerprint of the address the
 *     request came from (`addressFingerprint`, below).
 *   - Until then, ONE request without a token is answered, if it says
 *     `forService: true` too and comes from that same address — the app
 *     and its service are one television. The stamp is checked and removed
 *     in the one conditional write that counts the refresh, so two asks at
 *     once cannot both be answered, and nothing can be slipped in between
 *     the check and the use.
 *
 * What that request gets is not the television's token. It carries
 * `scope: 'waiting'` (family-television.mjs WAITING_SCOPE), which the Wick
 * server takes for one thing: `GET /tv/waiting`, a sentence for each thing
 * waiting for that one member's answer — no light, no week, no picture, no
 * press. A request without a token can obtain nothing else here, ever.
 *
 * A shared secret between the app and its service would be the textbook
 * bound, and is not possible: the app can hand the service nothing. What
 * bounds it instead, exactly:
 *
 *   - Opened only by the app's own proof: its full token, never a narrow one.
 *   - Ninety seconds (SERVICE_WINDOW_MS).
 *   - Single use.
 *   - The same source address as the request that opened it. A request with
 *     no source address neither opens a way nor uses one. What is kept of
 *     the address is a keyed fingerprint: an HMAC-SHA-256 under a secret
 *     only this Lambda has, derived from the pairing signing key and a
 *     fixed label. Nobody who reads the row can work the address back out
 *     of it, as they could from a plain hash.
 *   - One scope. A narrow token shown here as proof brings another narrow
 *     token, never a full one, and never opens a way: scope is not widened.
 *   - A narrow token cannot be renewed once it has run out. Its expiry is
 *     NOT ignored, as a full token's is: it is renewed while still good (the
 *     service does so at three quarters of its hour), or the service falls
 *     silent until the app is next on screen and opens the way again.
 *   - One session at a time, and a new one every time the app is on screen.
 *     Letting the service in writes `serviceSince` (when, in ms) on the
 *     row, in the same conditional write, and the narrow token says the
 *     same in its claim `since`. A narrow token is renewed only while the
 *     row still names its session — checked in the write, not only on a
 *     read — and the renewed token says the same `since`. The app opening
 *     the way removes `serviceSince` in the write that opens it, so the
 *     session there was ends at that moment, whoever holds its tokens; the
 *     television's own service is refused at its next question, knocks, and
 *     is let in again inside that same way, with a new session. An opening
 *     that is refused — a bad token, the cooldown, no source address —
 *     ends nothing. The Wick server makes the same comparison on every
 *     `/tv/waiting` call, and a row with no `serviceSince` matches no
 *     token. A narrow token that names no session is refused.
 *   - Seven days at most (SERVICE_SESSION_MAX_MS). A narrow token whose
 *     session began longer ago than that is not renewed, whatever its
 *     expiry; the service is let in afresh when the app next opens the way.
 *   - A cooldown of its own. The mint without proof and every renewal of a
 *     narrow token are counted in their own place on the row
 *     (`serviceRefreshWindowAt` / `serviceRefreshCount`), with the same
 *     limits as any refresh — and only there. The app's refreshes with its
 *     full token, opening the way or not, are counted where they always
 *     were, and only there. So a narrow token, however often it is asked
 *     for, cannot keep the television's own app from refreshing; and an app
 *     at its limit does not make its service wait.
 *   - The short TTL (REFRESH_TOKEN_TTL_SEC), as for every refresh; and the
 *     member and household are the row's, never the request's (INV-8).
 *   - Never for a row that is revoked (`denylisted`). Whether the member is
 *     still in the circle is NOT looked at here — this Lambda reads no
 *     membership row, and none is added for it: the Wick server asks that
 *     of every `/tv/waiting` call (INV-9), so a narrow token for a member
 *     the resident has removed reads nothing.
 *
 *   What it can reach:  one-sentence lines of what waits for one member.
 *   Why it exists:      FL-013 — the television gives the app no way to
 *                       hand its service anything.
 *
 * What is left: someone on the same network address as the television (the
 * same home, or the same carrier NAT) who knows its id and asks inside those
 * ninety seconds before its own service does, gets those sentences for an
 * hour — and for as long after as they keep renewing in time, which is
 * until the television's app is next on screen: its opening the way ends
 * their session in that write, and never later than seven days. The same
 * goes for a token copied out of the television's running service. In the
 * meantime the television's own service, refused, says nothing; it is let
 * in when the app is next opened. Nothing else changes: outside the way a
 * request without a token is refused exactly as before, and the resident's
 * channel refuses every token that names a kind (connect.mjs,
 * iot-authorize.mjs).
 *
 * `createHandler` takes its DynamoDB send, signing key and clock, so it is
 * tested without AWS (__tests__/pair-refresh.test.ts).
 */
import { createHash, createHmac } from 'node:crypto';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { signJwt, verifyJwt } from './jwt.mjs';
import { REFRESH_TOKEN_TTL_SEC, nextRefreshWindow } from './pairing-code.mjs';
import { deviceOwnerKey, householdOfDevice } from './device-owner.mjs';
import { FAMILY_KIND, SERVICE_SESSION_MAX_MS, SERVICE_WINDOW_MS, WAITING_SCOPE, familyClaims, familyTelevisionKey } from './family-television.mjs';

/** The bearer token of a request, whatever case the header arrived in. */
function bearer(headers) {
  const value = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'authorization')?.[1];
  const match = typeof value === 'string' ? /^Bearer\s+(\S+)$/i.exec(value) : null;
  return match ? match[1] : undefined;
}

/** Says what the key below is for, so it is good for nothing else. Changing it closes every way that is open. */
const SERVICE_FROM_LABEL = 'wick-service-from-v1';

/**
 * A fingerprint of where a request came from, as the HTTP API says it
 * (payload format 2.0), for the television it is about. Neither the address
 * nor anything it can be worked back from is stored: a plain hash of an
 * IPv4 address is the address, to anyone who can read the row and try four
 * billion of them. So it is an HMAC, keyed with a secret only this Lambda
 * has — derived from the pairing signing key, which it already holds, and
 * a fixed label. Never the signing key itself, and nothing of the key is
 * written anywhere.
 *
 * Undefined when the request carries no address: such a request neither
 * opens the way for a service nor uses it.
 */
function addressFingerprint(event, deviceId, signingKeyPem) {
  const address = event?.requestContext?.http?.sourceIp;
  if (typeof address !== 'string' || address.length === 0) return undefined;
  const key = createHash('sha256').update(`${SERVICE_FROM_LABEL}\n${signingKeyPem}`).digest();
  return createHmac('sha256', key).update(`${deviceId}\n${address}`).digest('hex');
}

/**
 * Where a refresh is counted on the binding row. There are two places, and
 * a request is counted in exactly one. The television's own refreshes — the
 * resident's, and a family television's app showing its full token, whether
 * or not it is opening the way — in the first. Everything to do with a
 * narrow token — the service's mint without proof, and every renewal of a
 * narrow token — in the second. Same limits (pairing-code.mjs).
 *
 * Apart, so that neither can use up the other's share: whoever holds a
 * narrow token, the least trusted token there is, cannot keep the app that
 * holds the real one from refreshing — and an app at its limit does not
 * make its own service wait.
 */
const OWN_REFRESHES = { at: 'refreshWindowAt', count: 'refreshCount' };
const NARROW_REFRESHES = { at: 'serviceRefreshWindowAt', count: 'serviceRefreshCount' };

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
    // For a family television only (the second exception, above). `opens`:
    // the app, with its own token, asks for the way to be opened for its
    // service. `claims`: a request without a token takes the one mint that
    // way allows. `scope`: what the token minted is narrowed to.
    const forService = !isResidents && body.forService === true;
    const from = forService ? addressFingerprint(event, deviceId, await privateKey()) : undefined;
    let opens = false;
    let claims = false;
    let scope;
    // When the service's session began (ms): written on the row as
    // `serviceSince` when the service is let in, and carried unchanged in
    // every narrow token of that session as the claim `since`.
    let since;

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
        if (!heldToken) {
          // The one way round it: the service's own ask, while the way its
          // app opened is still open. Anything else is refused as always —
          // a plain refresh without a token never takes the service's turn.
          // What is read here only saves a write: the gate is the condition
          // on the write below.
          const until = Number(item.serviceUntil?.N ?? 0);
          if (!forService || !from || !(until > now()) || item.serviceFrom?.S !== from) return { statusCode: 401, body: 'token_required' };
          claims = true;
          scope = WAITING_SCOPE;
          // A new session, and by that the end of any before it. Never the
          // same moment as an earlier one — the one the row names, or the
          // last one it named before the app's opening took the name away
          // (`serviceLastSince`) — so no earlier token can pass for this
          // session's.
          since = Math.max(now(), Number(item.serviceSince?.N ?? 0) + 1, Number(item.serviceLastSince?.N ?? 0) + 1);
        } else {
          let held;
          try {
            held = verifyJwt(heldToken, await publicKey(), { ignoreExpiry: true });
          } catch {
            return { statusCode: 401, body: 'invalid_token' };
          }
          if (held.kind !== FAMILY_KIND || held.deviceId !== deviceId || held.householdId !== householdId || held.userId !== familyUserId) {
            return { statusCode: 401, body: 'invalid_token' };
          }
          // A narrowed token brings a narrowed token, and opens nothing.
          if (held.scope !== undefined && held.scope !== WAITING_SCOPE) return { statusCode: 401, body: 'invalid_token' };
          // And it is the one token whose expiry is not overlooked: it was
          // minted without proof, so it is renewed while good or not at all.
          if (held.scope !== undefined) {
            try {
              verifyJwt(heldToken, await publicKey());
            } catch {
              return { statusCode: 401, body: 'token_expired' };
            }
          }
          if (held.scope !== undefined) {
            // And it belongs to one session, which is the one the row names
            // and is not yet seven days old. A token that does not say when
            // its session began belongs to none.
            if (typeof held.since !== 'number' || !Number.isFinite(held.since)) return { statusCode: 401, body: 'invalid_token' };
            if (now() - held.since > SERVICE_SESSION_MAX_MS) return { statusCode: 401, body: 'session_over' };
            // Read here only to save a write: the gate is the condition below.
            if (item.serviceSince?.N !== String(held.since)) return { statusCode: 401, body: 'session_replaced' };
          }
          claims = false;
          scope = held.scope;
          since = held.scope === undefined ? undefined : held.since;
          opens = forService && scope === undefined && Boolean(from);
        }
      }

      // A narrow token — being minted, or being renewed — is counted in its
      // own place, and nothing else is.
      const bucket = scope ? NARROW_REFRESHES : OWN_REFRESHES;
      const next = nextRefreshWindow({ refreshWindowAt: item[bucket.at], refreshCount: item[bucket.count] }, now());
      if (!next) return { statusCode: 429, body: 'refresh_rate_limited' };
      const counted = item[bucket.at] && item[bucket.count];
      try {
        await send(new UpdateItemCommand({
          TableName: table,
          Key: bindingKey,
          // The way is opened, or used up, in the same write that counts the
          // refresh — and it is used up only if it still stands as it was
          // read, so two asks at once cannot both be answered.
          //
          // A session begins in that same write (`serviceSince`), and a
          // narrow token is renewed only if the row still names its session
          // at the moment of writing: a hand-off that lands between the read
          // and the write ends the renewal with it.
          //
          // And opening the way ends the session there is (`REMOVE
          // serviceSince`), in the write that opens it: a service that still
          // holds a good token would never ask to be let in again, and a
          // copy of that token would go on with it. Ended, the service is
          // refused at its next question, knocks, and is let in afresh
          // inside this same way.
          UpdateExpression: `SET ${bucket.at} = :at, ${bucket.count} = :count${opens ? ', serviceUntil = :until, serviceFrom = :from REMOVE serviceSince' : ''}${claims ? ', serviceSince = :since, serviceLastSince = :since REMOVE serviceUntil, serviceFrom' : ''}`,
          ConditionExpression: `${counted
            ? `${bucket.at} = :wasAt AND ${bucket.count} = :wasCount`
            : `attribute_exists(pk) AND attribute_not_exists(${bucket.at})`}${claims ? ' AND serviceUntil > :now AND serviceFrom = :from' : ''}${scope && !claims ? ' AND serviceSince = :since' : ''}`,
          ExpressionAttributeValues: {
            ':at': { N: String(next.at) },
            ':count': { N: String(next.count) },
            ...(counted ? { ':wasAt': item[bucket.at], ':wasCount': item[bucket.count] } : {}),
            ...(opens ? { ':until': { N: String(now() + SERVICE_WINDOW_MS) }, ':from': { S: from } } : {}),
            ...(claims ? { ':now': { N: String(now()) }, ':from': { S: from } } : {}),
            ...(scope ? { ':since': { N: String(since) } } : {}),
          },
        }));
        break;
      } catch (err) {
        if (err?.name !== 'ConditionalCheckFailedException') throw err;
        if (attempt >= 2) return { statusCode: 429, body: 'refresh_rate_limited' };
      }
    }

    const tokenClaims = { deviceId, householdId, ...(familyUserId ? familyClaims(familyUserId, scope, since) : {}) };
    const jwt = signJwt(tokenClaims, await privateKey(), { expiresInSec: REFRESH_TOKEN_TTL_SEC });
    const token = {
      jwt,
      deviceId,
      householdId,
      expiresAt: now() + REFRESH_TOKEN_TTL_SEC * 1000,
      ...(familyUserId ? { kind: FAMILY_KIND } : {}),
      // Said beside the token as well as inside it, so the television knows what it was handed without reading the JWT.
      ...(familyUserId && scope ? { scope } : {}),
    };

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
