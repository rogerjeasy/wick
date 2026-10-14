/**
 * POST /pair/start {deviceId, proof? | keeps?, replaces?} -> {code, url, expiresAt}
 * TV boots unpaired, calls this once, displays the code and URL.
 * See docs/WICK-TECHNICAL.md §4.2.
 *
 * `proof` is the secret a television that can keep one has just made for
 * itself (proof.mjs). Only its hash is written, on the pairing nonce, and
 * pair-claim.mjs moves it to the television's row: from then on a refresh
 * for that television must show the secret (pair-refresh.mjs). A television
 * that can keep nothing — the Vega Virtual Device — sends none.
 *
 * `keeps: true` instead says the television keeps a file but cannot make a
 * secret (no cryptographic generator — Vega): pair-claim.mjs makes one for
 * it. Never for the simulator's id, whose storage keeps nothing, and never
 * beside a proof of its own.
 *
 * `replaces` is `{deviceId, proof}` of the television this one was until
 * now. A television with storage takes a new id each time it is paired
 * again, so an id a family member once saw, or a log once held, stops being
 * this television's. Only the hash of the old secret is written; when the
 * code is entered, pair-claim.mjs removes the old row — but only from the
 * organiser's own home, and only if that row keeps the same hash.
 *
 * Nothing here is trusted: anybody can ask for a code. What a code is worth
 * is decided when the organiser enters it.
 *
 * `createHandler` takes its DynamoDB send and clock, so it is tested without
 * AWS (__tests__/pair-start.test.ts).
 */
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { generatePairingCode, PAIRING_CODE_TTL_MS, pairingUrl } from './pairing-code.mjs';
import { SIMULATOR_DEVICE_ID, isProof, proofHashOf } from './proof.mjs';
import { SAFE_DEVICE_ID } from './iot-policy.mjs';

export function createHandler({ send, now, table, pairingUrlBase, code = generatePairingCode }) {
  return async (event) => {
    let body;
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return { statusCode: 400, body: 'bad_json' };
    }
    const deviceId = body.deviceId;
    if (!deviceId) return { statusCode: 400, body: 'deviceId_required' };
    // An id is a key on the table and a name on the MQTT channel (iot-policy.mjs): nothing else is one.
    if (typeof deviceId !== 'string' || !SAFE_DEVICE_ID.test(deviceId)) return { statusCode: 400, body: 'bad_deviceId' };
    if (body.proof !== undefined && !isProof(body.proof)) return { statusCode: 400, body: 'bad_proof' };
    if (body.keeps !== undefined && body.keeps !== true) return { statusCode: 400, body: 'bad_keeps' };
    // A secret made by the server, for a television that keeps a file and cannot make one — not for the simulator, which keeps nothing.
    const wantsProof = body.keeps === true && body.proof === undefined && deviceId !== SIMULATOR_DEVICE_ID;
    const replaces = body.replaces;
    const replacing = replaces !== undefined && replaces !== null;
    if (replacing && (typeof replaces.deviceId !== 'string' || !SAFE_DEVICE_ID.test(replaces.deviceId) || replaces.deviceId === deviceId || !isProof(replaces.proof))) {
      return { statusCode: 400, body: 'bad_replaces' };
    }

    const expiresAt = now() + PAIRING_CODE_TTL_MS;

    // Retry on the rare collision with a still-live code — the conditional
    // PutItem is the correctness guarantee, this loop is just about not failing
    // the one-in-a-million case.
    for (let attempt = 0; attempt < 5; attempt++) {
      const pairingCode = code();
      try {
        await send(new PutItemCommand({
          TableName: table,
          Item: {
            pk: { S: `PAIR#${pairingCode}` },
            sk: { S: 'META' },
            deviceId: { S: deviceId },
            claimed: { BOOL: false },
            expiresAt: { N: String(expiresAt) },
            ttl: { N: String(Math.floor(expiresAt / 1000)) },
            // Hashes only: the secrets stay on the television.
            ...(body.proof !== undefined ? { proofHash: { S: proofHashOf(body.proof) } } : {}),
            ...(wantsProof ? { keeps: { BOOL: true } } : {}),
            ...(replacing ? { replacesDeviceId: { S: replaces.deviceId }, replacesProofHash: { S: proofHashOf(replaces.proof) } } : {}),
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        }));
        return {
          statusCode: 200,
          body: JSON.stringify({ code: pairingCode, url: pairingUrl(pairingUrlBase, pairingCode), expiresAt }),
        };
      } catch (err) {
        if (err?.name !== 'ConditionalCheckFailedException') throw err;
      }
    }
    return { statusCode: 503, body: 'code_space_exhausted' };
  };
}

const ddb = new DynamoDBClient({});

export const handler = createHandler({
  send: (command) => ddb.send(command),
  now: Date.now,
  table: process.env.TABLE_NAME,
  pairingUrlBase: process.env.PAIRING_URL_BASE,
});
