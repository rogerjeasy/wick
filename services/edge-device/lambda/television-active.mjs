/**
 * "The resident is at the television" — said to the agent plane, so that it
 * can ask what there is to ask ("Shall I tell Sarah?", services/agent
 * agents/tell).
 *
 * A question for the resident can only be put while they are watching, so
 * that is when one is looked for: when the television connects, comes to
 * the front, or is being watched. Not on a timer over every household.
 *
 * The signal carries which household and which television, and nothing
 * about what is on it. It is claimed on the television's own row first, so
 * an evening of pausing and playing asks the agent plane to look once every
 * little while, not at every press.
 *
 * Pure: device-event.mjs owns the DynamoDB and EventBridge clients.
 */
import { deviceBindingKey } from './device-standing.mjs';

/** How often one television may ask the agent plane to look. */
export const ACTIVE_SIGNAL_EVERY_MS = 2 * 60 * 1000;

const WATCHING = new Set(['PLAYING', 'PAUSED']);

/** Whether a device event means someone is at the television now. */
export function isActiveSignal(deviceEvent) {
  if (!deviceEvent) return false;
  if (deviceEvent.t === 'reconcile') return true;
  if (deviceEvent.t === 'app_lifecycle') return deviceEvent.state === 'fg';
  if (deviceEvent.t === 'playback') return WATCHING.has(deviceEvent.state);
  return false;
}

/** UpdateItem input that succeeds only if this television has not signalled lately. */
export function claimActiveSignal({ table, householdId, deviceId, now }) {
  return {
    TableName: table,
    Key: deviceBindingKey(householdId, deviceId),
    UpdateExpression: 'SET activeSignalAt = :now',
    // Never conjure a television that is not paired.
    ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(activeSignalAt) OR activeSignalAt < :cutoff)',
    ExpressionAttributeValues: { ':now': { N: String(now) }, ':cutoff': { N: String(now - ACTIVE_SIGNAL_EVERY_MS) } },
  };
}

export function buildTelevisionActiveEntry({ busName, householdId, deviceId, at }) {
  return {
    EventBusName: busName,
    Source: 'wick.device',
    DetailType: 'television.active',
    Detail: JSON.stringify({ householdId, deviceId, at }),
  };
}
