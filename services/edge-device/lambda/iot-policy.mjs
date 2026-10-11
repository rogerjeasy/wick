/**
 * What a television may do on AWS IoT Core, and how it proves who it is.
 *
 * A television on the MQTT channel holds the same single credential it holds
 * on the WebSocket: its device-bound token (INV-1). IoT Core's custom
 * authorizer (iot-authorize.mjs) checks that token and answers with the
 * policy built here — one television, its own three topics, nothing else.
 *
 * Pure: no AWS, no network. Tested in __tests__/iot-policy.test.ts.
 */

/**
 * A device id that is safe to write into an IoT policy. `*` and `?` are
 * wildcards there, and `/` a topic level: an id carrying one could widen the
 * policy to other televisions' topics. Ids Wick issues are a UUID or
 * `wick-tv`; anything else is refused before a policy is built.
 */
export const SAFE_DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** IoT Core's own bounds for both timers, in seconds. */
const MIN_SESSION_S = 300;
const MAX_SESSION_S = 86_400;
/** How often IoT Core asks again. A revoked television is cut off within this. */
export const REAUTHORISE_S = MIN_SESSION_S;

export const topicsOf = (deviceId) => ({
  cards: `wick/device/${deviceId}/cards`,
  control: `wick/device/${deviceId}/control`,
  events: `wick/device/${deviceId}/events`,
});

/**
 * The token a television sent. A WebSocket opened from JavaScript can only
 * carry it in the address (`?token=`): AWS requires ALPN for credentials in
 * the MQTT CONNECT, and a WebSocket cannot set ALPN. A client that can —
 * plain MQTT on port 443 — may send it as the MQTT password, which IoT Core
 * hands over base64-encoded.
 */
export function tokenFrom(event) {
  const query = event?.protocolData?.http?.queryString;
  if (typeof query === 'string') {
    const token = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query).get('token');
    if (token) return token;
  }
  const password = event?.protocolData?.mqtt?.password;
  if (typeof password === 'string' && password) return Buffer.from(password, 'base64').toString('utf8');
  return undefined;
}

/** Connect as itself, hear its own cards and control messages, send its own events. */
export function devicePolicy({ region, accountId, deviceId }) {
  if (!SAFE_DEVICE_ID.test(deviceId)) throw new Error('unsafe_device_id');
  const arn = (kind, name) => `arn:aws:iot:${region}:${accountId}:${kind}/${name}`;
  const topics = topicsOf(deviceId);
  return {
    Version: '2012-10-17',
    Statement: [
      { Effect: 'Allow', Action: 'iot:Connect', Resource: arn('client', deviceId) },
      { Effect: 'Allow', Action: 'iot:Subscribe', Resource: [arn('topicfilter', topics.cards), arn('topicfilter', topics.control)] },
      { Effect: 'Allow', Action: 'iot:Receive', Resource: [arn('topic', topics.cards), arn('topic', topics.control)] },
      { Effect: 'Allow', Action: 'iot:Publish', Resource: arn('topic', topics.events) },
    ],
  };
}

/** How long the connection may live: as long as the token, within IoT Core's bounds. */
export function sessionSeconds({ exp, nowS }) {
  const left = typeof exp === 'number' ? exp - nowS : MAX_SESSION_S;
  return Math.min(MAX_SESSION_S, Math.max(MIN_SESSION_S, Math.floor(left)));
}

export const DENIED = { isAuthenticated: false, principalId: 'refused', disconnectAfterInSeconds: 0, refreshAfterInSeconds: 0, policyDocuments: [] };

export function allowed({ region, accountId, deviceId, exp, nowS }) {
  return {
    isAuthenticated: true,
    // IoT Core takes letters and digits only here; it is a label for logs.
    principalId: deviceId.replace(/[^A-Za-z0-9]/g, '').slice(0, 128) || 'television',
    disconnectAfterInSeconds: sessionSeconds({ exp, nowS }),
    refreshAfterInSeconds: REAUTHORISE_S,
    policyDocuments: [devicePolicy({ region, accountId, deviceId })],
  };
}

/** Region and account of the Lambda that is running, read from its own ARN. */
export function placeOf(functionArn) {
  const [, , , region, accountId] = String(functionArn ?? '').split(':');
  return { region, accountId };
}

const MQTT_PREFIX = 'mqtt:';

/**
 * The name the device row keeps for an MQTT connection. IoT Core gives every
 * session an id; holding it is what lets a late "disconnected" for an old
 * session leave a newer one alone (as disconnect.mjs does for the WebSocket).
 */
export const mqttConnectionId = (sessionIdentifier) => `${MQTT_PREFIX}${sessionIdentifier}`;

/** The television is on screen and reachable over MQTT. Refused for one that is revoked or unknown. */
export function presenceConnected({ table, householdId, deviceId, sessionIdentifier, at }) {
  return {
    TableName: table,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: `DEV#${deviceId}` } },
    UpdateExpression: 'SET connectionId = :c, transport = :t, connectedAt = :ca REMOVE wsEndpoint',
    ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(denylisted) OR denylisted = :false)',
    ExpressionAttributeValues: {
      ':c': { S: mqttConnectionId(sessionIdentifier) },
      ':t': { S: 'mqtt' },
      ':ca': { N: String(at) },
      ':false': { BOOL: false },
    },
  };
}

/** The session ended. Clears the row only if it still names that session. */
export function presenceDisconnected({ table, householdId, deviceId, sessionIdentifier }) {
  return {
    TableName: table,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: `DEV#${deviceId}` } },
    UpdateExpression: 'REMOVE connectionId, transport, wsEndpoint, connectedAt',
    ConditionExpression: 'connectionId = :cid',
    ExpressionAttributeValues: { ':cid': { S: mqttConnectionId(sessionIdentifier) } },
  };
}
