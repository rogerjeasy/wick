/**
 * A household's Ring link, as the table knows it — and nothing secret.
 *
 * The tokens are in Secrets Manager (ring-token.mjs). What is kept here is
 * what may be read without them: that a home is linked, how, since when,
 * until when, and which of Ring's devices it holds. The family app shows
 * this; the hourly refresh walks it to find every link.
 *
 *   HH#<householdId> / RING      this row
 *   RINGDEV#<deviceId> / META    which household holds a doorbell
 *                                (services/agent/src/store/ringDevices.ts reads it)
 *
 * Pure: builders in, DynamoDB inputs out. Tested in
 * __tests__/household-links.test.ts.
 */
export const LINK_SK = 'RING';

/** A token pasted from Ring's Developer Playground lasts about this long, and says nothing about itself. */
export const PLAYGROUND_TOKEN_MS = 30 * 60 * 1000;
/** The longest a pasted token is ever taken to last, whatever it claims. */
export const PLAYGROUND_TOKEN_MAX_MS = 60 * 60 * 1000;

const linkKey = (householdId) => ({ pk: { S: `HH#${householdId}` }, sk: { S: LINK_SK } });
const deviceKey = (deviceId) => ({ pk: { S: `RINGDEV#${deviceId}` }, sk: { S: 'META' } });

/**
 * When a pasted token stops working: its own `exp` if it is a JWT that says
 * so, otherwise half an hour from now — and never more than an hour. The
 * claim is read from a token nobody here can verify, and what it sets is
 * what the family app tells the organiser; a token that says it lasts a
 * year must not have the app saying so.
 */
export function pastedTokenExpiry(token, now) {
  const parts = String(token).split('.');
  if (parts.length === 3) {
    try {
      const { exp } = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (Number.isFinite(exp) && exp * 1000 > now) return Math.min(exp * 1000, now + PLAYGROUND_TOKEN_MAX_MS);
    } catch {
      // Not a JWT after all.
    }
  }
  return now + PLAYGROUND_TOKEN_MS;
}

/** The record kept for a pasted Playground token. No refresh token exists for one. */
export function playgroundRecord(token, now) {
  return { access_token: token, source: 'playground', obtainedAt: now, expiresAt: pastedTokenExpiry(token, now) };
}

/** The row for a link just made. `devices` are the ones this household now holds. */
export function linkRow({ table, householdId, record, linkedBy, devices, heldElsewhere = 0, now }) {
  return {
    TableName: table,
    Item: {
      ...linkKey(householdId),
      source: { S: record.source ?? 'oauth' },
      linkedAt: { N: String(now) },
      ...(linkedBy ? { linkedBy: { S: linkedBy } } : {}),
      ...(record.accountId ? { accountId: { S: record.accountId } } : {}),
      ...(Number.isFinite(record.expiresAt) ? { expiresAt: { N: String(record.expiresAt) } } : {}),
      refreshable: { BOOL: Boolean(record.refresh_token) },
      devices: { S: JSON.stringify(devices.map((d) => ({ id: d.id, name: d.name ?? null }))) },
      heldElsewhere: { N: String(heldElsewhere) },
    },
  };
}

export const readLinkRow = ({ table, householdId }) => ({ TableName: table, Key: linkKey(householdId), ConsistentRead: true });
export const removeLinkRow = ({ table, householdId }) => ({ TableName: table, Key: linkKey(householdId) });

/** Keep the row's expiry in step with the secret after a refresh. Does nothing for a home with no row. */
export function touchLinkExpiry({ table, householdId, expiresAt }) {
  return {
    TableName: table,
    Key: linkKey(householdId),
    UpdateExpression: 'SET expiresAt = :e',
    ConditionExpression: 'attribute_exists(pk)',
    ExpressionAttributeValues: { ':e': { N: String(expiresAt) } },
  };
}

/** What the family app is told. Never a token: there is none in the row to tell. */
export function linkSummary(item, now) {
  if (!item) return { linked: false };
  let devices = [];
  try {
    devices = JSON.parse(item.devices?.S ?? '[]');
  } catch {
    devices = [];
  }
  const expiresAt = item.expiresAt?.N ? Number(item.expiresAt.N) : undefined;
  const refreshable = item.refreshable?.BOOL === true;
  const source = item.source?.S ?? 'oauth';
  return {
    linked: true,
    source,
    simulated: source === 'playground',
    linkedAt: Number(item.linkedAt?.N ?? 0),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    refreshable,
    // A link that refreshes itself does not expire for the person looking at
    // it; a pasted token does, and saying so is the difference between "it
    // stopped working" and "it was always going to".
    expired: !refreshable && expiresAt !== undefined && expiresAt <= now,
    devices,
    heldElsewhere: Number(item.heldElsewhere?.N ?? 0),
  };
}

/** Take a doorbell for a household. Fails, by condition, if another household holds it. */
export function claimDevice({ table, deviceId, householdId, now }) {
  return {
    TableName: table,
    Item: { ...deviceKey(deviceId), householdId: { S: householdId }, assignedAt: { N: String(now) } },
    ConditionExpression: 'attribute_not_exists(pk) OR householdId = :hh',
    ExpressionAttributeValues: { ':hh': { S: householdId } },
  };
}

/** Let a doorbell go. Only the household that holds it can. */
export function releaseDevice({ table, deviceId, householdId }) {
  return {
    TableName: table,
    Key: deviceKey(deviceId),
    ConditionExpression: 'householdId = :hh',
    ExpressionAttributeValues: { ':hh': { S: householdId } },
  };
}

/** Every household with a link, a page at a time: the hourly refresh's list. */
export function linkedHouseholdsPage({ table, startKey }) {
  return {
    TableName: table,
    FilterExpression: 'sk = :ring AND begins_with(pk, :hh)',
    ExpressionAttributeValues: { ':ring': { S: LINK_SK }, ':hh': { S: 'HH#' } },
    ProjectionExpression: 'pk, refreshable',
    ...(startKey ? { ExclusiveStartKey: startKey } : {}),
  };
}

export const householdOfLinkRow = (item) => (item?.pk?.S ?? '').replace(/^HH#/, '') || undefined;
