/**
 * AWS IoT Core custom authorizer: is this a television Wick paired?
 *
 * IoT Core calls this when a client asks to connect naming the authorizer
 * (`…/mqtt?x-amz-customauthorizer-name=…&token=<device token>`), and again
 * every few minutes for as long as the connection lives. The answer is the
 * policy in iot-policy.mjs: that television's own topics and nothing else.
 *
 * The checks are connect.mjs's, for the same token: a signature made with
 * the pairing key, not expired, and a television that has not been revoked.
 * Any failure is the same refusal — a caller is not told which check failed.
 */
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { verifyJwt } from './jwt.mjs';
import { deviceBindingKey, isResidentsToken, isServed } from './device-standing.mjs';
import { DENIED, SAFE_DEVICE_ID, allowed, placeOf, tokenFrom } from './iot-policy.mjs';
import { isUnproven, refusesUnproven } from './proof.mjs';

const ddb = new DynamoDBClient({});
const sm = new SecretsManagerClient({});
const TABLE = process.env.TABLE_NAME;
const SIGNING_KEY_SECRET_ARN = process.env.PAIRING_SIGNING_KEY_SECRET_ARN;

let cachedPublicKey = null;
async function publicKey() {
  if (cachedPublicKey) return cachedPublicKey;
  const r = await sm.send(new GetSecretValueCommand({ SecretId: SIGNING_KEY_SECRET_ARN }));
  cachedPublicKey = JSON.parse(r.SecretString).publicKeyPem;
  return cachedPublicKey;
}

export const handler = async (event, context) => {
  const token = tokenFrom(event);
  if (!token) return DENIED;

  let claims;
  try {
    claims = verifyJwt(token, await publicKey());
  } catch {
    return DENIED;
  }
  // The resident's channel is for the resident's television (device-standing.mjs).
  if (!isResidentsToken(claims)) return DENIED;
  const { deviceId, householdId, exp } = claims;
  if (typeof deviceId !== 'string' || !SAFE_DEVICE_ID.test(deviceId) || typeof householdId !== 'string') return DENIED;

  // Consistent: this runs again every few minutes, and that re-check is what
  // cuts a revoked television off an open connection.
  const device = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: deviceBindingKey(householdId, deviceId),
    ConsistentRead: true,
  }));
  if (!isServed(device.Item)) return DENIED;
  // A token minted from the id alone is refused once the television has enrolled a secret — at the next re-check too, which ends a connection already open (proof.mjs).
  if (refusesUnproven(device.Item, isUnproven(claims))) return DENIED;

  return allowed({ ...placeOf(context?.invokedFunctionArn), deviceId, exp, nowS: Math.floor(Date.now() / 1000) });
};
