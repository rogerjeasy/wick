/**
 * WebSocket `$default` — inbound DeviceEvent. §4.3.
 *
 * card_shown / card_action are persisted to the timeline now, because INV-6's
 * correlation loop closes here. playback / app_lifecycle are the Rhythm
 * pillar's device-side input (§3.3, §8.2) and now increment atomic
 * day-of-week/hour bucket counters in this same DynamoDB table —
 * buildTvActivityKey (services/agent/src/rhythm/records.ts) is the
 * canonical, tested builder; this plain .mjs Lambda can't import that TS
 * module (same constraint timeline.ts's own comment describes for
 * padTimestamp), so the same key shape is inlined below with a pointer back
 * to it. This targets DynamoDB rather than Amazon Timestream — §8.2 named
 * Timestream, but it turns out to reject `CreateDatabase` for this AWS
 * account (`AccessDeniedException: Only existing Timestream for
 * LiveAnalytics customers can access the service`), a platform restriction
 * with no IAM fix. records.ts's header has the full account of why.
 * break_state carries no Rhythm measure of its own — it is derived
 * on-device from playback, which is what's recorded.
 *
 * Only `state: 'fg'` and `state: 'PLAYING'` are written. An ADD counter has
 * no sensible "0" — `bg`/PAUSED/STOPPED/BUFFERING are silently not an
 * occurrence, not a negative one. `session_minutes` is NOT computed here:
 * that needs a stateful PLAYING-to-next-event duration, which belongs in a
 * batch job over the raw occurrences, not this per-event handler — left
 * honestly unbuilt rather than guessed at (same call narrator/index.ts makes
 * for the baseline itself).
 *
 * Rhythm write failures are caught and logged, never thrown: it's a
 * background signal, and losing one occurrence is not a reason to fail the
 * socket route or force a client retry.
 *
 * INV-7: a card_action of `seen` on a WeekCard (id `week-<isoWeek>`,
 * services/agent/src/agents/narrator/weekCard.ts) is the one and only path
 * that sets WeekNarrative.residentSeenAt — get_week_narrative.ts's gate for
 * the family. Read-check-write, not a DynamoDB condition expression: the
 * narrative lives as one JSON blob (`data`), and residentSeenAt is a field
 * inside it, not a top-level attribute a ConditionExpression can see. A
 * near-simultaneous double press racing this is harmless — first write
 * wins with a timestamp a few milliseconds apart from the second, and
 * "not already set" is still checked so the resident's actual first
 * viewing is never overwritten by a later stray press.
 *
 * reconcile: the client sends `{ t: 'reconcile', sinceCardId }` as a normal
 * message right after `onopen` (see
 * apps/tv-vega/src/transport/WebSocketChannel.ts) — not in the $connect
 * query string, which is why this lives here rather than in connect.mjs.
 * Anything queued after `sinceCardId` is pushed back over this same
 * connection.
 */
import { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { randomUUID } from 'node:crypto';

const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME;

const WEEK_CARD_ID = /^week-(\d{4}-W\d{2})$/;
const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/**
 * Inlined from services/agent/src/rhythm/records.ts's dowHourBucket +
 * buildTvActivityKey — keep byte-for-byte equivalent if either changes.
 */
function tvActivityKey(householdId, deviceId, measureName, at) {
  const d = new Date(at);
  const bucket = `${DOW[d.getUTCDay()]}-${String(d.getUTCHours()).padStart(2, '0')}`;
  return {
    pk: `HH#${householdId}`,
    sk: `RHYTHM#tv_activity#${deviceId}#${measureName}#${bucket}`,
  };
}

async function recordTvActivity(householdId, deviceId, measureName, at) {
  const key = tvActivityKey(householdId, deviceId, measureName, at);
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: { pk: { S: key.pk }, sk: { S: key.sk } },
      UpdateExpression: 'ADD #count :incr SET lastSeenAt = :now',
      ExpressionAttributeNames: { '#count': 'count' },
      ExpressionAttributeValues: {
        ':incr': { N: '1' },
        ':now': { N: String(at) },
      },
    }));
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error', msg: 'record_tv_activity_failed',
      err: err instanceof Error ? err.message : String(err),
    }));
  }
}

/** INV-7. See this file's header comment for why it's read-check-write, not a condition. */
async function markNarrativeSeen(householdId, isoWeek, seenAt) {
  const res = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: `NARR#${isoWeek}` } },
  }));
  const raw = res.Item?.data?.S;
  if (!raw) return; // no narrative stored for this week — nothing to mark

  const narrative = JSON.parse(raw);
  if (narrative.residentSeenAt !== undefined) return; // first viewing is authoritative

  narrative.residentSeenAt = seenAt;
  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: { S: `HH#${householdId}` },
      sk: { S: `NARR#${isoWeek}` },
      data: { S: JSON.stringify(narrative) },
    },
  }));
}

export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  let deviceEvent;
  try {
    deviceEvent = JSON.parse(event.body ?? '{}');
  } catch {
    return { statusCode: 400, body: 'bad_json' };
  }

  const lookup = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `CONN#${connectionId}` }, sk: { S: 'META' } },
  }));
  if (!lookup.Item) return { statusCode: 401, body: 'unknown_connection' };
  const householdId = lookup.Item.householdId.S;
  const deviceId = lookup.Item.deviceId.S;

  if (deviceEvent.t === 'app_lifecycle') {
    if (typeof deviceEvent.at !== 'number' || (deviceEvent.state !== 'fg' && deviceEvent.state !== 'bg')) {
      return { statusCode: 400, body: 'bad_device_event' };
    }
    // See this file's header comment: 'bg' is not-an-occurrence, not a zero.
    if (deviceEvent.state === 'fg') {
      await recordTvActivity(householdId, deviceId, 'foreground', deviceEvent.at);
    }
  } else if (deviceEvent.t === 'playback') {
    if (typeof deviceEvent.at !== 'number' || typeof deviceEvent.state !== 'string') {
      return { statusCode: 400, body: 'bad_device_event' };
    }
    if (deviceEvent.state === 'PLAYING') {
      await recordTvActivity(householdId, deviceId, 'power_on', deviceEvent.at);
    }
  } else if (deviceEvent.t === 'card_shown' || deviceEvent.t === 'card_action') {
    if (typeof deviceEvent.at !== 'number' || typeof deviceEvent.cardId !== 'string') {
      return { statusCode: 400, body: 'bad_device_event' };
    }
    await ddb.send(new PutItemCommand({
      TableName: TABLE,
      Item: {
        pk: { S: `HH#${householdId}` },
        // Wire-format source of truth: packages/contracts/src/timeline.ts's
        // `padTimestamp`. This plain .mjs Lambda can't import that TS module,
        // so the 15-digit zero-padded-ms encoding is inlined here — keep it
        // byte-for-byte identical to padTimestamp() if either ever changes.
        sk: { S: `EVT#${String(deviceEvent.at).padStart(15, '0')}#${randomUUID()}` },
        type: { S: deviceEvent.t },
        cardId: { S: deviceEvent.cardId },
        ...(deviceEvent.action ? { action: { S: deviceEvent.action } } : {}),
      },
    }));

    if (deviceEvent.t === 'card_action' && deviceEvent.action === 'seen') {
      const weekMatch = WEEK_CARD_ID.exec(deviceEvent.cardId);
      if (weekMatch) await markNarrativeSeen(householdId, weekMatch[1], deviceEvent.at);
    }
  } else if (deviceEvent.t === 'reconcile') {
    await reconcile({ event, householdId, connectionId, sinceCardId: deviceEvent.sinceCardId });
  }

  return { statusCode: 200, body: '' };
};

async function reconcile({ event, householdId, connectionId, sinceCardId }) {
  // Derived the same way connect.mjs derives it — API Gateway populates
  // requestContext.domainName/stage on every WebSocket route, not just
  // $connect, so no need to have stored wsEndpoint on the CONN#.../META item.
  const wsEndpoint = `https://${event.requestContext.domainName}/${event.requestContext.stage}`;

  // Let DynamoDB do the filtering instead of scanning the household's whole
  // CARD# history into memory: bound to the CARD# sort-key range (upper
  // bound 'CARD$' — '$' sorts immediately after '#', so it's above every
  // 'CARD#<id>' key and below 'DEV#'/'EVT#' keys sharing this pk) and capped
  // with Limit so a large backlog can't blow the Lambda timeout or the WS
  // frame size.
  const pending = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: sinceCardId ? 'pk = :pk AND sk BETWEEN :since AND :max' : 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: sinceCardId
      ? {
          ':pk': { S: `HH#${householdId}` },
          ':since': { S: `CARD#${sinceCardId}` },
          ':max': { S: 'CARD$' },
        }
      : {
          ':pk': { S: `HH#${householdId}` },
          ':prefix': { S: 'CARD#' },
        },
    Limit: 50,
  }));

  if (pending.LastEvaluatedKey) {
    // Backlog exceeds the Limit — leaving this unhandled for now (log, don't
    // error); the device will still get everything up to the Limit and can
    // reconcile the rest on its next reconnect.
    console.log('reconcile: backlog truncated at Limit', { householdId, connectionId });
  }

  const mgmt = new ApiGatewayManagementApiClient({ endpoint: wsEndpoint });

  for (const item of pending.Items ?? []) {
    if (sinceCardId && item.sk.S === `CARD#${sinceCardId}`) continue; // exact match: client already has this one
    const card = JSON.parse(item.data.S);
    try {
      await mgmt.send(new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: JSON.stringify({ kind: 'card', card }),
      }));
    } catch (err) {
      if (err?.name === 'GoneException') {
        console.log('reconcile: connection gone mid-replay, stopping', { connectionId });
        return;
      }
      throw err;
    }
  }
}
