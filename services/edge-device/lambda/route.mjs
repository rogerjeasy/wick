/**
 * WebSocket `$default` — inbound DeviceEvent. §4.3.
 *
 * card_shown / card_action are persisted to the timeline now, because INV-6's
 * correlation loop closes here. A card_action also stamps the CARD# item as
 * acted on, so reconcile never replays it (card-acted.mjs). playback / app_lifecycle are the Rhythm
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
 * Trust promise 2: `sharing` on a Week card opens "What Sarah sees", and the
 * sharing card's own presses change the resident's exclusions and turn its
 * pages — sharing.mjs.
 *
 * INV-9: `allow` or `decline` on a Circle card (`circle-<userId>`) is the
 * resident's answer to someone who asked to join the family circle, and the
 * only thing that can turn a pending membership into an allowed one —
 * circle.mjs.
 *
 * M3: a `reply_<n>` on a family note (`note-<uuid>`) records the reply on
 * the note's CARD# item, in the words Wick offered — note-reply.mjs.
 *
 * A card_action the agent plane must carry out (today only M1's
 * `hallway_chime`) is also published to EventBridge as `wick.device` /
 * `card.action` — see card-action-event.mjs. Door presses that keep the card
 * on screen (the chime, Watch live) don't retire it (card-acted.mjs).
 *
 * reconcile: the client sends `{ t: 'reconcile', sinceCardId }` as a normal
 * message right after `onopen` (see
 * apps/tv-vega/src/transport/WebSocketChannel.ts) — not in the $connect
 * query string, which is why this lives here rather than in connect.mjs.
 * Every card the resident hasn't acted on (and no door card whose visitor
 * has gone) is pushed back over this same connection. `sinceCardId` is
 * still sent but no longer filters: card ids are not time-ordered, so it
 * dropped cards (card-acted.mjs's isReplayable).
 */
import { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { randomUUID } from 'node:crypto';
import { isReplayable, markCardActed, retiresCard } from './card-acted.mjs';
import { deviceBindingKey, isServed } from './device-standing.mjs';
import { circleDecision, membershipDecisionUpdate } from './circle.mjs';
import { buildCardActionEntry, shouldPublish } from './card-action-event.mjs';
import { markNoteReplied, replyIndex, replyText } from './note-reply.mjs';
import { SHARING_CARD_ID, buildSharingCard, exclusionUpdate, readExclusions, sharingStep } from './sharing.mjs';

const ddb = new DynamoDBClient({});
const events = new EventBridgeClient({});
const TABLE = process.env.TABLE_NAME;
const BUS = process.env.EVENT_BUS_NAME;
/** The family member as the resident knows them — "What Sarah sees". */
const FAMILY_NAME = process.env.WICK_FAMILY_NAME || undefined;

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

  // A television revoked after it connected still holds this connection.
  // Refused here, before any message is acted on (device-standing.mjs).
  // A consistent read: a revocation written a moment ago must count.
  const device = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: deviceBindingKey(householdId, deviceId),
    ConsistentRead: true,
  }));
  if (!isServed(device.Item)) return { statusCode: 403, body: 'revoked' };

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

    if (deviceEvent.t === 'card_action' && retiresCard(deviceEvent.action)) {
      await retireActedCard(householdId, deviceEvent.cardId, deviceEvent.at);
    }

    if (deviceEvent.t === 'card_action' && typeof deviceEvent.action === 'string' && shouldPublish(deviceEvent.action)) {
      await publishCardAction({ householdId, deviceId, cardId: deviceEvent.cardId, action: deviceEvent.action, at: deviceEvent.at });
    }

    if (deviceEvent.t === 'card_action') {
      const decision = circleDecision(deviceEvent.cardId, deviceEvent.action);
      if (decision) await recordCircleDecision(householdId, decision, deviceEvent.at);

      const index = replyIndex(deviceEvent.cardId, deviceEvent.action);
      if (index !== undefined) await recordNoteReply(householdId, deviceEvent.cardId, index, deviceEvent.at);

      if (deviceEvent.action === 'sharing' && WEEK_CARD_ID.test(deviceEvent.cardId)) {
        await showSharing({ event, householdId, connectionId, page: 0, respondsTo: deviceEvent.cardId });
      } else if (deviceEvent.cardId === SHARING_CARD_ID) {
        await advanceSharing({ event, householdId, connectionId, action: deviceEvent.action });
      }
    }

    if (deviceEvent.t === 'card_action' && deviceEvent.action === 'seen') {
      const weekMatch = WEEK_CARD_ID.exec(deviceEvent.cardId);
      if (weekMatch) await markNarrativeSeen(householdId, weekMatch[1], deviceEvent.at);
    }
  } else if (deviceEvent.t === 'reconcile') {
    await reconcile({ event, householdId, connectionId });
  }

  return { statusCode: 200, body: '' };
};

/**
 * See card-acted.mjs. Logged, never thrown: the action is already on the
 * timeline above, and a failed stamp only means the card may be replayed
 * once more — not a reason to fail the socket route.
 */
async function retireActedCard(householdId, cardId, at) {
  try {
    await ddb.send(new UpdateItemCommand(markCardActed({ table: TABLE, householdId, cardId, at })));
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return; // not a card the server sent — nothing to retire
    console.error('card_acted_write_failed', { householdId, cardId, err });
  }
}

/**
 * INV-9 — see circle.mjs. The household is this connection's own, so a
 * television can only ever answer for the home it is in. Logged, never
 * thrown: the press is already on the timeline. A failed condition means
 * the question was no longer open (answered already, or the organiser
 * removed the person), and the answer on record stands.
 */
async function recordCircleDecision(householdId, decision, at) {
  try {
    await ddb.send(new UpdateItemCommand(membershipDecisionUpdate({ table: TABLE, householdId, ...decision, at })));
    console.log(JSON.stringify({ level: 'info', msg: 'circle_decision', status: decision.status }));
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      console.log(JSON.stringify({ level: 'info', msg: 'circle_decision_not_open' }));
      return;
    }
    console.error('circle_decision_write_failed', { householdId, err: err?.name });
  }
}

/**
 * M3 — see note-reply.mjs. The words are read back from the stored card, so
 * only a reply Wick offered can reach the family. Logged, never thrown: the
 * press is already on the timeline.
 */
async function recordNoteReply(householdId, cardId, index, at) {
  try {
    const res = await ddb.send(new GetItemCommand({
      TableName: TABLE,
      Key: { pk: { S: `HH#${householdId}` }, sk: { S: `CARD#${cardId}` } },
    }));
    const text = replyText(res.Item, index);
    if (text === undefined) {
      console.error('note_reply_unknown', { householdId, cardId, index });
      return;
    }
    await ddb.send(new UpdateItemCommand(markNoteReplied({ table: TABLE, householdId, cardId, text, at })));
    console.log(JSON.stringify({ level: 'info', msg: 'note_replied', cardId, index }));
  } catch (err) {
    console.error('note_reply_write_failed', { householdId, cardId, err: err?.name });
  }
}

/**
 * "What Sarah sees" — see sharing.mjs. Logged, never thrown: the press is
 * already on the timeline, and the card stays on screen, so pressing again
 * is the resident's retry.
 */
async function loadMeta(householdId) {
  const res = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: 'META' } },
  }));
  return res.Item;
}

async function showSharing({ event, householdId, connectionId, page, respondsTo }) {
  try {
    const meta = await loadMeta(householdId);
    const queued = buildSharingCard({
      householdId,
      page,
      policyJson: meta?.policy?.S,
      exclusions: readExclusions(meta),
      familyName: FAMILY_NAME,
      now: Date.now(),
      respondsTo,
    });
    if (!queued) return;
    // PutItem, not Update: a fresh card, without the actedAt a previous Done left.
    await ddb.send(new PutItemCommand({
      TableName: TABLE,
      Item: { pk: { S: `HH#${householdId}` }, sk: { S: `CARD#${SHARING_CARD_ID}` }, data: { S: JSON.stringify(queued) } },
    }));
    const mgmt = new ApiGatewayManagementApiClient({ endpoint: `https://${event.requestContext.domainName}/${event.requestContext.stage}` });
    await mgmt.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: JSON.stringify({ kind: 'card', card: queued }) }));
  } catch (err) {
    console.error('sharing_show_failed', { householdId, page, err: err?.name });
  }
}

async function advanceSharing({ event, householdId, connectionId, action }) {
  try {
    const [stored, meta] = await Promise.all([
      ddb.send(new GetItemCommand({ TableName: TABLE, Key: { pk: { S: `HH#${householdId}` }, sk: { S: `CARD#${SHARING_CARD_ID}` } } })),
      loadMeta(householdId),
    ]);
    const storedQueued = stored.Item?.data?.S ? JSON.parse(stored.Item.data.S) : undefined;
    const step = sharingStep(storedQueued, action, readExclusions(meta));
    if (!step) return;
    if (step.set) {
      await ddb.send(new UpdateItemCommand(exclusionUpdate({ table: TABLE, householdId, ...step.set })));
      console.log(JSON.stringify({ level: 'info', msg: 'sharing_changed', factClass: step.set.factClass, keepPrivate: step.set.keepPrivate }));
    }
    await showSharing({ event, householdId, connectionId, page: step.page, respondsTo: storedQueued?.respondsTo });
  } catch (err) {
    console.error('sharing_step_failed', { householdId, action, err: err?.name });
  }
}

/**
 * Hand the press to the agent plane (M1). Logged, never thrown: the press is
 * already on the timeline, and the card keeps its button, so pressing again
 * is the resident's retry — the consumer's once-per-card claim makes that safe.
 */
async function publishCardAction(detail) {
  try {
    const res = await events.send(new PutEventsCommand({ Entries: [buildCardActionEntry({ busName: BUS, ...detail })] }));
    if (res.FailedEntryCount) console.error('card_action_publish_rejected', { cardId: detail.cardId, code: res.Entries?.[0]?.ErrorCode });
  } catch (err) {
    console.error('card_action_publish_failed', { cardId: detail.cardId, err: err?.name });
  }
}

async function reconcile({ event, householdId, connectionId }) {
  // Derived the same way connect.mjs derives it — API Gateway populates
  // requestContext.domainName/stage on every WebSocket route, not just
  // $connect, so no need to have stored wsEndpoint on the CONN#.../META item.
  const wsEndpoint = `https://${event.requestContext.domainName}/${event.requestContext.stage}`;

  // Every CARD# item for the household, page by page: a card the resident
  // hasn't acted on is replayed whatever its id (card-acted.mjs's
  // isReplayable says why the device's sinceCardId is no longer used to
  // filter). The device upserts by id, so a card it already holds is a no-op.
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': { S: `HH#${householdId}` }, ':prefix': { S: 'CARD#' } },
      ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
    }));
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  const mgmt = new ApiGatewayManagementApiClient({ endpoint: wsEndpoint });

  const now = Date.now();
  for (const item of items) {
    if (!isReplayable(item, now)) continue;
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
