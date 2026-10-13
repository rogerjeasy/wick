/**
 * An inbound DeviceEvent, handled the same whichever channel carried it:
 * the WebSocket (route.mjs) or MQTT over IoT Core (iot-events.mjs). §4.3.
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
 * Watch together: a press on one of a session's cards (`watch-<kind>-<id>`)
 * is the resident's yes, her "Start the film" or her answer at the credits,
 * and a `watch_position` is her player saying where that film is — kept
 * only when the session's own row allows it, and answered with the one
 * question when the credits begin. watch-together.mjs.
 *
 * A card_action the agent plane must carry out (today only M1's
 * `hallway_chime`) is also published to EventBridge as `wick.device` /
 * `card.action` — see card-action-event.mjs. Door presses that keep the card
 * on screen (the chime, Watch live) don't retire it (card-acted.mjs).
 *
 * The light in the window: `{ t: 'light' }` is her press on the home
 * screen's light, answered with the Light card; its two presses put the
 * light out for the day or light it again; and every reconcile is followed
 * by what the home screen says beside its cards — her light, and who in the
 * family looked in today. light.mjs.
 *
 * reconcile: the client sends `{ t: 'reconcile', sinceCardId, holding }` as a normal
 * message as soon as it is connected (WebSocketChannel.ts and MqttChannel.ts
 * in apps/tv-vega/src/transport) — which is why this lives here rather than
 * in a connect handler. Every card the resident hasn't acted on (and no door
 * card whose visitor has gone) is sent back on the channel the request came
 * by, through the `sendCard` the caller supplies. `sinceCardId` is still
 * sent but no longer filters: card ids are not time-ordered, so it dropped
 * cards (card-acted.mjs's isReplayable). `holding` is the cards the
 * television has: any of them already finished — answered on another
 * television in the home — is taken back with a `revoke`, through the
 * `sendControl` the caller supplies (card-acted.mjs's finishedAmong).
 */
import { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { randomUUID } from 'node:crypto';
import { finishedAmong, isReplayable, markCardActed, markCardShown, replayedCard, retiresCard } from './card-acted.mjs';
import { deviceBindingKey, isServed } from './device-standing.mjs';
import { circleDecision, membershipDecisionUpdate } from './circle.mjs';
import { announcesRetirement, buildCardActionEntry, buildCardRetiredEntry, shouldPublish } from './card-action-event.mjs';
import { markNoteReplied, replyIndex, replyText } from './note-reply.mjs';
import { answerUpdate, askedUpdate, buildQuestionCard, decisionUpdate, notNowUpdate, positionUpdate, shouldAsk, startUpdate, watchPress } from './watch-together.mjs';
import { SHARING_CARD_ID, allowedFirstNames, buildSharingCard, exclusionUpdate, readExclusions, sharingStep } from './sharing.mjs';
import { buildTelevisionActiveEntry, claimActiveSignal, isActiveSignal } from './television-active.mjs';
import { buildHomeChangedEntry, buildLightCard, homeRange, homeState, lightPress, lightUpdate } from './light.mjs';

const ddb = new DynamoDBClient({});
const events = new EventBridgeClient({});
const TABLE = process.env.TABLE_NAME;
const BUS = process.env.EVENT_BUS_NAME;
/** Where the house is: what "today" means for the light in the window (light.mjs). */
const HOUSEHOLD_TZ = process.env.WICK_HOUSEHOLD_TZ || 'Europe/London';

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

/**
 * One event from a television, whichever way it came.
 *
 * @param {object} input
 * @param {string} input.householdId  from the television's own connection — never from the event (INV-8)
 * @param {string} input.deviceId
 * @param {object} input.deviceEvent  the DeviceEvent as the television sent it
 * @param {(card: object) => Promise<boolean>} input.sendCard  puts a card on
 *   that television over the channel the event arrived on; false when the
 *   television has gone
 * @param {(control: object) => Promise<boolean>} input.sendControl  the same,
 *   for a control message (a `revoke`)
 */
export async function handleDeviceEvent({ householdId, deviceId, deviceEvent, sendCard, sendControl }) {
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

    if (deviceEvent.t === 'card_shown') await countShowing(householdId, deviceEvent.cardId);

    if (deviceEvent.t === 'card_action' && retiresCard(deviceEvent.action)) {
      await retireActedCard(householdId, deviceEvent.cardId, deviceEvent.at);
    }

    if (deviceEvent.t === 'card_action' && announcesRetirement(deviceEvent.action)) {
      await publishCardRetired({ householdId, deviceId, cardId: deviceEvent.cardId, at: deviceEvent.at });
    }

    if (deviceEvent.t === 'card_action' && typeof deviceEvent.action === 'string' && shouldPublish(deviceEvent.action)) {
      await publishCardAction({ householdId, deviceId, cardId: deviceEvent.cardId, action: deviceEvent.action, at: deviceEvent.at });
    }

    if (deviceEvent.t === 'card_action') {
      const decision = circleDecision(deviceEvent.cardId, deviceEvent.action);
      if (decision) {
        await recordCircleDecision(householdId, decision, deviceEvent.at);
        // There is now somebody to tell: anything already different is asked about at once.
        if (decision.status === 'allowed') await signalActive(householdId, deviceId, { always: true });
        // Who can see her light has changed — the first person allowed is when there is a light at all.
        await tellEveryHome({ sendControl, householdId, deviceId });
      }

      const index = replyIndex(deviceEvent.cardId, deviceEvent.action);
      if (index !== undefined) await recordNoteReply(householdId, deviceEvent.cardId, index, deviceEvent.at);

      const light = lightPress(deviceEvent.cardId, deviceEvent.action);
      if (light) await changeLight({ sendControl, householdId, deviceId, press: light });

      const watch = watchPress(deviceEvent.cardId, deviceEvent.action);
      if (watch) await recordWatchPress(householdId, watch);

      if (deviceEvent.action === 'sharing' && WEEK_CARD_ID.test(deviceEvent.cardId)) {
        await showSharing({ sendCard, householdId, page: 0, respondsTo: deviceEvent.cardId });
      } else if (deviceEvent.cardId === SHARING_CARD_ID) {
        // What is shared decides whether there is a light at all: a change is told to every home screen.
        if (await advanceSharing({ sendCard, householdId, action: deviceEvent.action })) await tellEveryHome({ sendControl, householdId, deviceId });
      }
    }

    if (deviceEvent.t === 'card_action' && deviceEvent.action === 'seen') {
      const weekMatch = WEEK_CARD_ID.exec(deviceEvent.cardId);
      if (weekMatch) await markNarrativeSeen(householdId, weekMatch[1], deviceEvent.at);
    }
  } else if (deviceEvent.t === 'watch_position') {
    await recordWatchPosition({ sendCard, householdId, deviceEvent });
  } else if (deviceEvent.t === 'light') {
    await showLight({ sendCard, householdId });
  } else if (deviceEvent.t === 'reconcile') {
    await reconcile({ sendCard, sendControl, householdId, holding: deviceEvent.holding });
    await tellHome({ sendControl, householdId });
  }

  if (isActiveSignal(deviceEvent)) await signalActive(householdId, deviceId);

  return { statusCode: 200, body: '' };
};

/**
 * Tells the agent plane the resident is at the television, so it can ask
 * what there is to ask (television-active.mjs). At most once every little
 * while per television — unless `always`, for the one moment that cannot
 * wait: the resident has just allowed someone, so there is now somebody to
 * tell. Logged, never thrown: a look that was not asked for is asked for at
 * the next signal.
 */
async function signalActive(householdId, deviceId, { always = false } = {}) {
  const now = Date.now();
  try {
    if (!always) await ddb.send(new UpdateItemCommand(claimActiveSignal({ table: TABLE, householdId, deviceId, now })));
    const res = await events.send(new PutEventsCommand({ Entries: [buildTelevisionActiveEntry({ busName: BUS, householdId, deviceId, at: now })] }));
    if (res.FailedEntryCount) console.error('television_active_publish_rejected', { code: res.Entries?.[0]?.ErrorCode });
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return; // signalled lately, or not a paired television
    console.error('television_active_signal_failed', { householdId, err: err?.name });
  }
}

/**
 * See card-acted.mjs markCardShown. Logged, never thrown: the showing is
 * already on the timeline, and a count that fails means at worst one
 * showing too many.
 */
async function countShowing(householdId, cardId) {
  try {
    await ddb.send(new UpdateItemCommand(markCardShown({ table: TABLE, householdId, cardId })));
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return; // not a card the server sent
    console.error('card_shown_count_failed', { householdId, err: err?.name });
  }
}

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
 * Watch together — see watch-together.mjs. The time is this server's own:
 * whether a session is still open is not the television's to say. Logged,
 * never thrown: the press is already on the timeline. A failed condition
 * means the press no longer applies (answered already, nobody sat down, or
 * the session is over), and what is on record stands.
 */
async function recordWatchPress(householdId, { sessionId, press, answer }) {
  const at = Date.now();
  const target = { table: TABLE, householdId, sessionId, at };
  try {
    const update =
      press === 'accept' ? decisionUpdate({ ...target, accepted: true })
      : press === 'decline' ? decisionUpdate({ ...target, accepted: false })
      : press === 'start' ? startUpdate(target)
      : press === 'not_now' ? notNowUpdate(target)
      : answerUpdate({ ...target, answer });
    await ddb.send(new UpdateItemCommand(update));
    console.log(JSON.stringify({ level: 'info', msg: 'watch_press', press }));
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      console.log(JSON.stringify({ level: 'info', msg: 'watch_press_not_applied', press }));
      return;
    }
    console.error('watch_press_write_failed', { householdId, press, err: err?.name });
  }
}

/**
 * Where the film is, for the one person watching along — kept only when the
 * session's own row allows it (watch-together.mjs positionUpdate), which is
 * what a failed condition means: not started by her, not that film, or over.
 * At the credits the one question is put on her television, once. Logged,
 * never thrown: a position that is lost is followed by the next.
 */
async function recordWatchPosition({ sendCard, householdId, deviceEvent }) {
  const now = Date.now();
  const update = positionUpdate({ table: TABLE, householdId, event: deviceEvent, now });
  if (!update) return;
  try {
    const { Attributes: row } = await ddb.send(new UpdateItemCommand(update));
    if (!shouldAsk(row)) return;
    await ddb.send(new UpdateItemCommand(askedUpdate({ table: TABLE, householdId, sessionId: deviceEvent.sessionId, at: now })));
    const queued = buildQuestionCard({ householdId, item: row, now });
    await ddb.send(new PutItemCommand({
      TableName: TABLE,
      Item: { pk: { S: `HH#${householdId}` }, sk: { S: `CARD#${queued.id}` }, data: { S: JSON.stringify(queued) } },
    }));
    await sendCard(queued);
    console.log(JSON.stringify({ level: 'info', msg: 'watch_question_asked' }));
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return; // not hers to share, or already asked
    console.error('watch_position_failed', { householdId, err: err?.name });
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

async function showSharing({ sendCard, householdId, page, respondsTo }) {
  try {
    // The household's own row and its circle sit in one range (light.mjs homeRange): who can see is read with what is shared.
    const rows = await loadHomeRows(householdId);
    const meta = rows.find((item) => item.sk?.S === 'META');
    const queued = buildSharingCard({
      householdId,
      page,
      policyJson: meta?.policy?.S,
      exclusions: readExclusions(meta),
      watchers: allowedFirstNames(rows),
      now: Date.now(),
      respondsTo,
    });
    if (!queued) return;
    // PutItem, not Update: a fresh card, without the actedAt a previous Done left.
    await ddb.send(new PutItemCommand({
      TableName: TABLE,
      Item: { pk: { S: `HH#${householdId}` }, sk: { S: `CARD#${SHARING_CARD_ID}` }, data: { S: JSON.stringify(queued) } },
    }));
    await sendCard(queued);
  } catch (err) {
    console.error('sharing_show_failed', { householdId, page, err: err?.name });
  }
}

async function advanceSharing({ sendCard, householdId, action }) {
  try {
    const [stored, meta] = await Promise.all([
      ddb.send(new GetItemCommand({ TableName: TABLE, Key: { pk: { S: `HH#${householdId}` }, sk: { S: `CARD#${SHARING_CARD_ID}` } } })),
      loadMeta(householdId),
    ]);
    const storedQueued = stored.Item?.data?.S ? JSON.parse(stored.Item.data.S) : undefined;
    const step = sharingStep(storedQueued, action, readExclusions(meta));
    if (!step) return false;
    if (step.set) {
      await ddb.send(new UpdateItemCommand(exclusionUpdate({ table: TABLE, householdId, ...step.set })));
      console.log(JSON.stringify({ level: 'info', msg: 'sharing_changed', factClass: step.set.factClass, keepPrivate: step.set.keepPrivate }));
    }
    await showSharing({ sendCard, householdId, page: step.page, respondsTo: storedQueued?.respondsTo });
    // Whether what is shared changed.
    return Boolean(step.set);
  } catch (err) {
    console.error('sharing_step_failed', { householdId, action, err: err?.name });
    return false;
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

/**
 * The light in the window — see light.mjs. One read of the household's rows
 * says what her home screen is told and what the Light card says.
 */
async function loadHomeRows(householdId) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new QueryCommand({ ...homeRange({ table: TABLE, householdId }), ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}) }));
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

/**
 * What the home screen says beside its cards: her light, and who looked in.
 * Sent when the television asks for what it is owed, and again after she
 * changes the light. Logged, never thrown: a home screen without the line
 * is still a home screen.
 */
async function tellHome({ sendControl, householdId }) {
  try {
    const items = await loadHomeRows(householdId);
    const home = homeState({ items, now: Date.now(), timeZone: HOUSEHOLD_TZ });
    // `whole`: this is all of it, so a light she has since made private is not left showing.
    await sendControl({ t: 'home', home, whole: true });
    return home;
  } catch (err) {
    console.error('home_state_failed', { householdId, err: err?.name });
    return undefined;
  }
}

/**
 * The home screen changed by a press here — her light, or what is shared.
 * This television is told at once; the home's others are the agent plane's
 * to tell (light.mjs buildHomeChangedEntry; INV-2). Logged, never thrown:
 * one that is not told now is told when it next connects.
 */
async function tellEveryHome({ sendControl, householdId, deviceId }) {
  const home = await tellHome({ sendControl, householdId });
  if (!home) return;
  try {
    const res = await events.send(new PutEventsCommand({ Entries: [buildHomeChangedEntry({ busName: BUS, householdId, deviceId, home, at: Date.now() })] }));
    if (res.FailedEntryCount) console.error('home_changed_publish_rejected', { householdId, code: res.Entries?.[0]?.ErrorCode });
  } catch (err) {
    console.error('home_changed_publish_failed', { householdId, err: err?.name });
  }
}

/** Her press on the home screen's light: the Light card, on the television that asked. Never stored — it is hers to look at, not owed. */
async function showLight({ sendCard, householdId }) {
  try {
    const items = await loadHomeRows(householdId);
    const queued = buildLightCard({ householdId, items, now: Date.now(), timeZone: HOUSEHOLD_TZ });
    if (queued) await sendCard(queued);
  } catch (err) {
    console.error('light_show_failed', { householdId, err: err?.name });
  }
}

/** "Put it out for today" or "Light it again". The time is this server's own; then the home screen is told how it stands. */
async function changeLight({ sendControl, householdId, deviceId, press }) {
  try {
    await ddb.send(new UpdateItemCommand(lightUpdate({ table: TABLE, householdId, press, at: Date.now() })));
    // The press and nothing about the household: which way the light went is hers alone.
    console.log(JSON.stringify({ level: 'info', msg: 'light_changed' }));
  } catch (err) {
    console.error('light_change_failed', { householdId, err: err?.name });
    return;
  }
  await tellEveryHome({ sendControl, householdId, deviceId });
}

/**
 * Tell the agent plane this card is finished, so the home's other
 * televisions put it away (card-action-event.mjs announcesRetirement).
 * Logged, never thrown: the press is kept already, and a television that is
 * not told now is told when it next connects (reconcile, below).
 */
async function publishCardRetired(detail) {
  try {
    const res = await events.send(new PutEventsCommand({ Entries: [buildCardRetiredEntry({ busName: BUS, ...detail })] }));
    if (res.FailedEntryCount) console.error('card_retired_publish_rejected', { cardId: detail.cardId, code: res.Entries?.[0]?.ErrorCode });
  } catch (err) {
    console.error('card_retired_publish_failed', { cardId: detail.cardId, err: err?.name });
  }
}

async function reconcile({ sendCard, sendControl, householdId, holding }) {
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

  // First what to put away: a card this television still holds that was
  // answered on another one while it was off (card-acted.mjs finishedAmong).
  for (const cardId of finishedAmong(items, holding)) {
    if (!(await sendControl({ t: 'revoke', cardId }))) {
      console.log('reconcile: television gone mid-replay, stopping', { householdId });
      return;
    }
  }

  const now = Date.now();
  for (const item of items) {
    if (!isReplayable(item, now)) continue;
    if (!(await sendCard(replayedCard(item)))) {
      console.log('reconcile: television gone mid-replay, stopping', { householdId });
      return;
    }
  }
}
