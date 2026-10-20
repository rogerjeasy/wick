/**
 * POST /pair/refresh {deviceId, proof?} — mints a fresh device-bound JWT for a
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
 * PROOF OF POSSESSION (proof.mjs). A television's id is not a secret: it
 * was shown to family members, it was logged, and on every Vega Virtual
 * Device it is the constant `wick-tv`. So:
 *
 *   - A row that holds a proof (`proofHash`) is answered only for a request
 *     that sends the secret it is the hash of (`proof` in the body,
 *     compared in constant time). Without it: 401 `proof_required`, before
 *     anything is counted, so a stranger cannot use up the television's
 *     share of refreshes either. The television made that secret when it
 *     was paired (pair-start.mjs) and keeps it in its own storage.
 *   - A row with no proof — paired before proofs existed, or by a
 *     television that can keep nothing — takes one the first time the
 *     television sends a secret WITH a token that proves it: a resident's
 *     token minted with proof and not run out (proof.mjs `isUnproven`), or a
 *     family television's own full token, not run out. From then on the
 *     row is under the rule above. A token minted without proof can never
 *     enrol one, so whoever minted it cannot take the television over or
 *     lock it out. Enrolled in the conditional write that counts the
 *     refresh, so two enrolments cannot both win.
 *   - A resident's row with no proof, IN A DEMO HOME, is still answered
 *     from the id alone: the KNOWN ACCEPTED EXCEPTION (AGENTS.md INV-1). In
 *     a real home it is refused (401 `proof_required`), and pair-claim.mjs
 *     never connects such a television to one. It exists for the Vega
 *     Virtual Device, whose disk keeps nothing (FRICTION.md FL-013/FL-014):
 *     its separate CardService process has no other way to learn it is
 *     paired, and a secret it made would be gone at the next launch. Such a
 *     token says `proof: 'none'`, and is refused everywhere the moment the
 *     row takes a proof (proof.mjs `refusesUnproven`). Bounded, not
 *     eliminated: REFRESH_TOKEN_TTL_SEC (an hour) and the per-device
 *     cooldown, and demo homes only. Anyone who knows such a television's
 *     id can still mint its token; for the simulator that id is public, and
 *     the home it reaches has nobody in it. And only for ID_ONLY_HOLD_MS
 *     after the pairing (proof.mjs): then the binding answers 404
 *     `device_not_paired`, the simulator shows a code, and whoever pairs it
 *     next takes it — one stale demo home no longer holds every simulator.
 *
 * A family member's own television is not under that exception: its token
 * is minted only for one that shows the token it held (below), and the
 * secret as well once its row holds one.
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
import { PROVEN_BY_SECRET, UNPROVEN, idOnlyLapsed, isDemoHome, isProof, isUnproven, proofHashOf, proofMatches } from './proof.mjs';
import { isResidentsToken } from './device-standing.mjs';

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
/**
 * And a third, for the resident's television answered from its id alone
 * (the exception, proof.mjs). Anybody who knows the id can be counted there,
 * so nothing proven is: a stranger asking over and over can use up only
 * this share, never the one a television showing its secret, or enrolling
 * one, is counted in. (Where the row keeps no secret the television itself
 * is counted here too — the simulator, which has nothing to prove itself
 * with.)
 */
const UNPROVEN_REFRESHES = { at: 'unprovenRefreshWindowAt', count: 'unprovenRefreshCount' };

export function createHandler({ send, privateKey, publicKey, now, table }) {
  return async (event) => {
    let body;
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return { statusCode: 400, body: 'bad_json' };
    }
    const { deviceId } = body;
    if (typeof deviceId !== 'string' || !deviceId) return { statusCode: 400, body: 'deviceId_required' };
    // The television's secret, when it has one (proof.mjs). Anything not shaped like one is no proof at all.
    const proof = isProof(body.proof) ? body.proof : undefined;

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
    // What the row holds of the television's secret, as read; whether this
    // request showed that secret; whether it enrols one (proof.mjs).
    let storedHash;
    let proven = false;
    let enrols = false;
    // Whether this home is a demo home, read once and only when it matters.
    let isDemo;
    const demoHome = async () => {
      if (isDemo === undefined) isDemo = isDemoHome((await send(new GetItemCommand({ TableName: table, Key: { pk: { S: `HH#${householdId}` }, sk: { S: 'META' } } }))).Item);
      return isDemo;
    };

    // Counted on the binding row, and written only if the row still says
    // what was read: the app and its card service ask a second apart, and
    // neither may lose its place to the other.
    for (let attempt = 0; ; attempt += 1) {
      const item = (await send(new GetItemCommand({ TableName: table, Key: bindingKey }))).Item;
      if (!item) return { statusCode: 404, body: 'device_not_paired' };
      if (item.denylisted?.BOOL) return { statusCode: 403, body: 'device_denylisted' };
      storedHash = item.proofHash?.S;
      proven = false;
      enrols = false;
      if (isResidents) {
        if (storedHash) {
          // This television keeps a secret: nothing without it. Refused
          // before anything is counted, so a stranger who knows the id
          // cannot use up the television's own share of refreshes.
          if (!proofMatches(proof, storedHash)) return { statusCode: 401, body: 'proof_required' };
          proven = true;
        } else if (proof && publicKey) {
          // A row with no proof yet takes this one only from a television
          // that proves itself another way: a token of its own, minted with
          // proof and not run out. An unproven token proves nothing, so it
          // can never enrol a secret — and without that, the request is
          // answered under the exception, in a demo home only (below).
          const heldToken = bearer(event.headers);
          let held;
          try {
            held = heldToken ? verifyJwt(heldToken, await publicKey()) : undefined;
          } catch {
            held = undefined;
          }
          if (held && isResidentsToken(held) && held.deviceId === deviceId && held.householdId === householdId && !isUnproven(held)) {
            proven = true;
            enrols = true;
          }
        }
        // Answered from the id alone only in a demo home (proof.mjs): its
        // rows are made up, and nobody lives there. A real home's television
        // shows its secret, or the token it was paired with, or nothing is
        // minted — an id was shown to the family and written in logs, and
        // knowing it must never be enough to speak for her television.
        if (!proven && !(await demoHome())) return { statusCode: 401, body: 'proof_required' };
        // And only for ID_ONLY_HOLD_MS after it was paired: every simulator has
        // this id, so a binding that never ran out held them all. Run out, it
        // is no longer connected — the television shows a code, and the next
        // pairing takes it.
        if (!proven && idOnlyLapsed(item, now())) return { statusCode: 404, body: 'device_not_paired' };
      } else {
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
          if (held.scope === undefined) {
            // The television's own full token. Where its row keeps a secret,
            // the token alone is not enough: one copied off the television, or
            // run out and found later, is no use without the secret too. A
            // row with no secret yet takes one shown with a token that has
            // not run out.
            if (storedHash) {
              if (!proofMatches(proof, storedHash)) return { statusCode: 401, body: 'proof_required' };
              proven = true;
            } else if (proof) {
              let current = false;
              try {
                verifyJwt(heldToken, await publicKey());
                current = true;
              } catch {
                current = false;
              }
              proven = current;
              enrols = current;
            }
          }
          claims = false;
          scope = held.scope;
          since = held.scope === undefined ? undefined : held.since;
          opens = forService && scope === undefined && Boolean(from);
        }
      }

      // A narrow token — being minted, or being renewed — is counted in its
      // own place, and nothing else is; so is a mint from the id alone.
      const bucket = scope ? NARROW_REFRESHES : isResidents && !proven ? UNPROVEN_REFRESHES : OWN_REFRESHES;
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
          //
          // And the row's proof is as it was read: the secret checked above
          // is still the one it keeps, a row with none has still none — so a
          // refresh that raced an enrolment is asked again under the new
          // rule — and a secret is enrolled only over nothing.
          UpdateExpression: `SET ${bucket.at} = :at, ${bucket.count} = :count${enrols ? ', proofHash = :proofHash' : ''}${opens ? ', serviceUntil = :until, serviceFrom = :from REMOVE serviceSince' : ''}${claims ? ', serviceSince = :since, serviceLastSince = :since REMOVE serviceUntil, serviceFrom' : ''}`,
          ConditionExpression: `${counted
            ? `${bucket.at} = :wasAt AND ${bucket.count} = :wasCount`
            : `attribute_exists(pk) AND attribute_not_exists(${bucket.at})`}${storedHash ? ' AND proofHash = :proofHash' : ' AND attribute_not_exists(proofHash)'}${claims ? ' AND serviceUntil > :now AND serviceFrom = :from' : ''}${scope && !claims ? ' AND serviceSince = :since' : ''}`,
          ExpressionAttributeValues: {
            ':at': { N: String(next.at) },
            ':count': { N: String(next.count) },
            ...(counted ? { ':wasAt': item[bucket.at], ':wasCount': item[bucket.count] } : {}),
            ...(storedHash ? { ':proofHash': { S: storedHash } } : enrols ? { ':proofHash': { S: proofHashOf(proof) } } : {}),
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

    // How the token was earned (proof.mjs). Only the resident's television is
    // ever minted one from its id alone, and then it says so; a family
    // television's token always rested on the token it showed.
    const proofClaim = proven ? { proof: PROVEN_BY_SECRET } : isResidents ? { proof: UNPROVEN } : {};
    const tokenClaims = { deviceId, householdId, ...(familyUserId ? familyClaims(familyUserId, scope, since) : {}), ...proofClaim };
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
