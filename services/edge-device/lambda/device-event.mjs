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
 * viewing is never overwritten by a later stray press. The press that does
 * set it also puts `wick.device` / `week.seen` on the bus, so the family is
 * nudged that the week is there to read (week_ready).
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
 * the note's CARD# item, in the words Wick offered — note-reply.mjs. Its
 * `later` (Back) records only that she has seen it, and leaves it open.
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
 * Hold for Sarah: `{ t: 'reach' }` is her two-second hold on OK, answered
 * with the card that offers to ask someone to ring her — or, when a request
 * is already under way, with that request as it now stands. Her press on
 * the card is the agent plane's to carry out. reach.mjs.
 *
 * The television speaks her language: every card and every control message
 * this file sends goes out through `inHerLanguage` (language.mjs), wrapped
 * once around the two send functions the caller supplies — so no send site
 * below has to remember. A press on the question's card (`language-<lang>`)
 * is her yes or no to the language the organiser asked for, and the only
 * thing that changes it. The edge never translates: free text is in her
 * language only where the agent plane kept a translation beside the stored
 * card. language.mjs.
 *
 * The mantelpiece: a press on a picture's card (`photo-<photoId>`) is her
 * "Keep it" or her "Thank you" — both say she has seen it, and nothing a
 * family tool reads tells them apart, down to the timeline row above, which
 * for these cards is written without its button. `{ t: 'mantel' }` is her
 * opening her mantelpiece, answered on the channel it came in on and
 * nowhere else; `{ t: 'mantel_take_down' }` takes one thing down. A
 * picture's address is minted on the way out (language.mjs's one wrapper,
 * presign.mjs) and written nowhere. mantel.mjs.
 *
 * Read to me: `{ t: 'read', cardId }` is her pressing Play on a card, and
 * the answer — the address of a reading of that card, as her television
 * shows it — goes to that television, on the channel it asked on, and
 * nowhere else. Nothing of it is written but a count for the hour: no
 * timeline row, nothing a family tool reads. speech.mjs.
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
import { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, TransactWriteItemsCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { randomUUID } from 'node:crypto';
import { finishedAmong, finishedSince, isReplayable, markCardActed, markCardShown, replayedCard, retiresCard } from './card-acted.mjs';
import { deviceBindingKey, isServed } from './device-standing.mjs';
import { refusesUnproven } from './proof.mjs';
import { circleDecision, membershipDecisionUpdate } from './circle.mjs';
import { announcesRetirement, buildCardActionEntry, buildCardRetiredEntry, buildWeekSeenEntry, shouldPublish } from './card-action-event.mjs';
import { markNoteReplied, markNoteSeen, putsNoteAway, replyIndex, replyText } from './note-reply.mjs';
import { answerUpdate, askedUpdate, buildQuestionCard, decisionUpdate, notNowUpdate, positionUpdate, shouldAsk, startUpdate, watchPress } from './watch-together.mjs';
import { SHARING_CARD_ID, allowedFirstNames, buildSharingCard, exclusionUpdate, readExclusions, sharingStep } from './sharing.mjs';
import { buildTelevisionActiveEntry, claimActiveSignal, isActiveSignal } from './television-active.mjs';
import { LIGHT_CARD_ID, buildHomeChangedEntry, buildLightCard, homeRange, homeState, lightPress, lightUpdate } from './light.mjs';
import { LANGUAGE_ACTIONS, inHerLanguage, languageAnswerUpdate, languageOfMeta, languagePress, languageRead } from './language.mjs';
import {
  PHOTO_ACTIONS,
  PHOTO_STATES,
  cardBack,
  isMissingObject,
  isPhotoId,
  keepOutcome,
  keepWrite,
  mantelCountKey,
  mantelItems,
  mantelRoom,
  photoCardKey,
  photoIdOfCardId,
  photoPress,
  pictureAddress,
  retagInput,
  seenUpdate,
  storedPhotoCard,
  takeDownWrite,
  thanksClaim,
} from './mantel.mjs';
// Generated from packages/contracts/src/phrasebook — the same sentences the agent plane sends.
import { cardIn, homeIn, patchIn } from './phrasebook.generated.mjs';
import { buildReachAskCard, firstToAsk, latestReach, reachUnderWayId, storedCardKey } from './reach.mjs';
import { answerReading, reachOfferId, readableCard, readingAddress, readingClaim } from './speech.mjs';
import { timeZoneOfRows } from './household-zone.mjs';

const ddb = new DynamoDBClient({});
const events = new EventBridgeClient({});
const TABLE = process.env.TABLE_NAME;
const BUS = process.env.EVENT_BUS_NAME;
/** Where the family's pictures are kept (infra/photos.tf). Without it a picture's card goes without its picture. */
const PHOTOS_BUCKET = process.env.PHOTOS_BUCKET;
/** Where a reading is kept for its day, under `tts/` (infra/core.tf, infra/speech.tf). Without it nothing is read aloud. */
const MEDIA_BUCKET = process.env.MEDIA_BUCKET;
/** The longest id a card has; anything longer is not one. */
const MAX_CARD_ID_CHARS = 200;

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

/**
 * INV-7. See this file's header comment for why it's read-check-write, not a condition.
 * True when this press is the one that made the week readable.
 */
async function markNarrativeSeen(householdId, isoWeek, seenAt) {
  const res = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: `NARR#${isoWeek}` } },
  }));
  const raw = res.Item?.data?.S;
  if (!raw) return false; // no narrative stored for this week — nothing to mark

  const narrative = JSON.parse(raw);
  if (narrative.residentSeenAt !== undefined) return false; // first viewing is authoritative

  narrative.residentSeenAt = seenAt;
  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: { S: `HH#${householdId}` },
      sk: { S: `NARR#${isoWeek}` },
      data: { S: JSON.stringify(narrative) },
    },
  }));
  return true;
}

/**
 * The week is the family's to read now (buildWeekSeenEntry). Logged, never
 * thrown: the week is already readable, and a nudge is a courtesy — the
 * family app finds the week when it next asks either way.
 */
async function publishWeekSeen(detail) {
  try {
    const res = await events.send(new PutEventsCommand({ Entries: [buildWeekSeenEntry({ busName: BUS, ...detail })] }));
    if (res.FailedEntryCount) console.error('week_seen_publish_rejected', { isoWeek: detail.isoWeek, code: res.Entries?.[0]?.ErrorCode });
  } catch (err) {
    console.error('week_seen_publish_failed', { isoWeek: detail.isoWeek, err: err?.name });
  }
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
 * @param {(input: object, signal: AbortSignal) => Promise<Uint8Array>} [input.synthesize]
 *   the voice a card is read in (speech.mjs); Amazon Polly unless one is handed in
 */
export async function handleDeviceEvent({ householdId, deviceId, unproven = false, deviceEvent, sendCard: sendCardAsWritten, sendControl: sendControlAsWritten, synthesize = pollySynthesize }) {
  const device = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: deviceBindingKey(householdId, deviceId),
    ConsistentRead: true,
  }));
  if (!isServed(device.Item)) return { statusCode: 403, body: 'revoked' };
  // A connection opened on a token minted without proof, for a television that has since enrolled a secret (proof.mjs).
  if (refusesUnproven(device.Item, unproven)) return { statusCode: 403, body: 'proof_required' };

  // Everything sent below goes out in the household's language (language.mjs):
  // wrapped here, once, so every send site is covered without knowing it.
  // The same wrapper gives a picture's card its address — minted now, for
  // this household's own object and no other, and kept nowhere (mantel.mjs).
  const { sendCard, sendControl, cardAsShown, language: householdLanguage } = inHerLanguage({
    sendCard: sendCardAsWritten,
    sendControl: sendControlAsWritten,
    readLanguage: () => readLanguage(householdId),
    phrasebook: { cardIn, homeIn, patchIn },
    pictureAddress: (photoId) => pictureAddress({ bucket: PHOTOS_BUCKET, householdId, photoId }),
  });

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
    // A picture's card: which of its two buttons was pressed is hers alone
    // (mantel.mjs, THE RULE), so the press goes on the timeline without it.
    const onPicture = photoIdOfCardId(deviceEvent.cardId) !== undefined;
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
        ...(deviceEvent.action && !onPicture ? { action: { S: deviceEvent.action } } : {}),
      },
    }));

    if (deviceEvent.t === 'card_shown') await countShowing(householdId, deviceEvent.cardId);

    // Whether this press finishes its card. Any other card: by the button
    // alone (card-acted.mjs). A picture's: by what her answer came to —
    // "Keep it" on a full mantelpiece leaves the card where it is.
    let finishes = deviceEvent.t === 'card_action';
    if (finishes && onPicture) {
      const photo = photoPress(deviceEvent.cardId, deviceEvent.action);
      finishes = photo ? await answerPhoto({ sendCard, sendControl, householdId, deviceId, press: photo }) : false;
    }

    if (finishes && retiresCard(deviceEvent.action)) {
      await retireActedCard(householdId, deviceEvent.cardId, deviceEvent.at);
    }

    if (finishes && announcesRetirement(deviceEvent.action)) {
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
      if (putsNoteAway(deviceEvent.cardId, deviceEvent.action)) await recordNoteSeen(householdId, deviceEvent.cardId, deviceEvent.at);

      const light = lightPress(deviceEvent.cardId, deviceEvent.action);
      if (light) await changeLight({ sendControl, householdId, deviceId, press: light });

      const language = languagePress(deviceEvent.cardId, deviceEvent.action);
      if (language) {
        const languageChangedTo = await recordLanguageAnswer(householdId, language);
        // Which language the home speaks is told to every television in it — this one at once, the others by the agent plane.
        // And when this press changed it, the agent plane is told so, to put what she has not yet answered into it.
        await tellEveryHome({ sendControl, householdId, deviceId, consistent: true, languageChangedTo });
      }

      const watch = watchPress(deviceEvent.cardId, deviceEvent.action);
      if (watch) await recordWatchPress(householdId, watch);

      if (deviceEvent.action === 'sharing' && WEEK_CARD_ID.test(deviceEvent.cardId)) {
        await showSharing({ sendCard, householdId, page: 0, respondsTo: deviceEvent.cardId });
      } else if (deviceEvent.action === 'sharing' && deviceEvent.cardId === LIGHT_CARD_ID) {
        // From her Light card, at any time. Not over it: the Light card is not kept, so Done goes home.
        await showSharing({ sendCard, householdId, page: 0 });
      } else if (deviceEvent.cardId === SHARING_CARD_ID) {
        // What is shared decides whether there is a light at all: a change is told to every home screen.
        if (await advanceSharing({ sendCard, householdId, action: deviceEvent.action })) await tellEveryHome({ sendControl, householdId, deviceId });
      }
    }

    if (deviceEvent.t === 'card_action' && deviceEvent.action === 'seen') {
      const weekMatch = WEEK_CARD_ID.exec(deviceEvent.cardId);
      // The first reading only: the week has just become the family's to read, and they are told so once.
      if (weekMatch && (await markNarrativeSeen(householdId, weekMatch[1], deviceEvent.at))) {
        await publishWeekSeen({ householdId, isoWeek: weekMatch[1], at: deviceEvent.at });
      }
    }
  } else if (deviceEvent.t === 'watch_position') {
    await recordWatchPosition({ sendCard, householdId, deviceEvent });
  } else if (deviceEvent.t === 'light') {
    await showLight({ sendCard, householdId });
  } else if (deviceEvent.t === 'reach') {
    await showReach({ sendCard, householdId });
  } else if (deviceEvent.t === 'mantel') {
    await showMantel({ sendControl, householdId });
  } else if (deviceEvent.t === 'mantel_take_down') {
    if (!isPhotoId(deviceEvent.photoId)) return { statusCode: 400, body: 'bad_device_event' };
    await takeDown({ sendControl, householdId, deviceId, photoId: deviceEvent.photoId });
  } else if (deviceEvent.t === 'read') {
    const { cardId } = deviceEvent;
    if (typeof cardId !== 'string' || cardId.length === 0 || cardId.length > MAX_CARD_ID_CHARS) return { statusCode: 400, body: 'bad_device_event' };
    await readToHer({ sendControl, cardAsShown, householdLanguage, householdId, cardId, synthesize });
  } else if (deviceEvent.t === 'reconcile') {
    await reconcile({ sendCard, sendControl, householdId, holding: deviceEvent.holding });
    // Read as it is this instant: a television asks for what it is owed the
    // moment its language changes, and this home is told whole — a read a
    // moment old would tell it the language she has just left.
    await tellHome({ sendControl, householdId, consistent: true });
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
 * The television speaks her language — see language.mjs. Her yes or no to
 * the language the organiser asked for; the household is this connection's
 * own, and the time — kept with a no, which stands for a week at the Wick
 * server — is this server's: when she answered is not the television's to
 * say. Logged, never thrown: the press is already on the timeline. A failed
 * condition means the question was no longer open, or was about another
 * language, and what the household's row says stands.
 *
 * Answers with the language the household now speaks when — and only when —
 * this press changed it: her yes, written. Undefined for a no, and for a
 * press that changed nothing.
 */
async function recordLanguageAnswer(householdId, { language, answer }) {
  try {
    await ddb.send(new UpdateItemCommand(languageAnswerUpdate({ table: TABLE, householdId, language, answer, at: Date.now() })));
    console.log(JSON.stringify({ level: 'info', msg: 'language_answered', language, answer }));
    return answer === LANGUAGE_ACTIONS.yes ? language : undefined;
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      console.log(JSON.stringify({ level: 'info', msg: 'language_question_not_open' }));
      return undefined;
    }
    console.error('language_answer_write_failed', { householdId, err: err?.name });
    return undefined;
  }
}

/**
 * The household's language, for a card sent when no other read has brought
 * the household's row (language.mjs inHerLanguage asks at most once an event).
 */
async function readLanguage(householdId) {
  const res = await ddb.send(new GetItemCommand(languageRead({ table: TABLE, householdId })));
  return languageOfMeta(res.Item);
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
 * A note she put away with Back (note-reply.mjs markNoteSeen). Logged, never
 * thrown: the press is already on the timeline, and a failed stamp only
 * means the family is not yet told she has seen it.
 */
async function recordNoteSeen(householdId, cardId, at) {
  try {
    await ddb.send(new UpdateItemCommand(markNoteSeen({ table: TABLE, householdId, cardId, at })));
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return; // not a note the server sent
    console.error('note_seen_write_failed', { householdId, cardId, err: err?.name });
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
    // The rows just read say which language (language.mjs).
    await sendCard(queued, { rows });
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
async function loadHomeRows(householdId, { consistent = false } = {}) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new QueryCommand({
      ...homeRange({ table: TABLE, householdId }),
      // For the moment after a press that changed one of these rows: what is told must be what was just written.
      ...(consistent ? { ConsistentRead: true } : {}),
      ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
    }));
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
async function tellHome({ sendControl, householdId, consistent = false }) {
  try {
    const items = await loadHomeRows(householdId, { consistent });
    // Where the house is: what "today" means for the light in the window (household-zone.mjs).
    const home = homeState({ items, now: Date.now(), timeZone: timeZoneOfRows(items) });
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
async function tellEveryHome({ sendControl, householdId, deviceId, consistent = false, languageChangedTo }) {
  const home = await tellHome({ sendControl, householdId, consistent });
  if (!home) return;
  try {
    // A change of language gets an id of its own, carried by whatever the agent plane does about it (INV-6).
    const changed = languageChangedTo ? { languageChangedTo, correlationId: randomUUID() } : {};
    const res = await events.send(new PutEventsCommand({ Entries: [buildHomeChangedEntry({ busName: BUS, householdId, deviceId, home, at: Date.now(), ...changed })] }));
    if (res.FailedEntryCount) console.error('home_changed_publish_rejected', { householdId, code: res.Entries?.[0]?.ErrorCode });
  } catch (err) {
    console.error('home_changed_publish_failed', { householdId, err: err?.name });
  }
}

/** Her press on the home screen's light: the Light card, on the television that asked. Never stored — it is hers to look at, not owed. */
async function showLight({ sendCard, householdId }) {
  try {
    const items = await loadHomeRows(householdId);
    const queued = buildLightCard({ householdId, items, now: Date.now(), timeZone: timeZoneOfRows(items) });
    if (queued) await sendCard(queued, { rows: items });
  } catch (err) {
    console.error('light_show_failed', { householdId, err: err?.name });
  }
}

/**
 * Her two-second hold on OK — see reach.mjs. A request already under way is
 * shown as it stands (the card the agent plane last stored); otherwise she
 * is offered one, naming who would be asked first. The id of a new offer is
 * this server's own clock: it becomes the request's name if she says yes.
 * Logged, never thrown: a hold that brings nothing can be made again.
 */
async function showReach({ sendCard, householdId }) {
  try {
    const now = Date.now();
    const newest = await ddb.send(new QueryCommand(latestReach({ table: TABLE, householdId })));
    const underWay = reachUnderWayId(newest.Items?.[0], now);
    if (underWay) {
      const stored = await ddb.send(new GetItemCommand({ TableName: TABLE, Key: storedCardKey(householdId, underWay), ConsistentRead: true }));
      if (stored.Item?.data?.S) {
        // A stored card goes with its row: any free text kept beside it in her language is taken from there.
        await sendCard(JSON.parse(stored.Item.data.S), { row: stored.Item });
        return;
      }
    }
    const rows = await loadHomeRows(householdId);
    const first = firstToAsk(rows);
    await sendCard(buildReachAskCard({ householdId, reachId: String(now), first, now }), { rows });
    // That she held the button, and nothing about whom she might ask.
    console.log(JSON.stringify({ level: 'info', msg: 'reach_offered', somebody: Boolean(first) }));
  } catch (err) {
    console.error('reach_show_failed', { householdId, err: err?.name });
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

// ---------------------------------------------------------------------------
// The mantelpiece — see mantel.mjs, whose header says what each step is for.
// ---------------------------------------------------------------------------

let s3;

/** S3, loaded at the first picture or the first reading — not at every television's every event. */
function bucketClient() {
  s3 ??= import('@aws-sdk/client-s3').then((sdk) => ({ client: new sdk.S3Client({}), sdk }));
  return s3;
}

/**
 * Tells the bucket what a picture now is, so its own rules keep it or let it
 * go (infra/photos.tf). `ok`; `missing` when the picture's bytes are no
 * longer there; `failed` otherwise — tried twice, and said without naming
 * the picture.
 */
async function retag(householdId, photoId, state) {
  if (!PHOTOS_BUCKET) return 'failed';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const { client, sdk } = await bucketClient();
      await client.send(new sdk.PutObjectTaggingCommand(retagInput({ bucket: PHOTOS_BUCKET, householdId, photoId, state })));
      return 'ok';
    } catch (err) {
      // Not there: nothing to tag, nothing to try again, and nothing worth saying.
      if (isMissingObject(err)) return 'missing';
      if (attempt === 2) console.error('photo_retag_failed', { err: err?.name });
      else s3 = undefined;
    }
  }
  return 'failed';
}

/** A transaction, tried again while another write is in its way. Throws what it is finally refused with. */
async function transact(input) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await ddb.send(new TransactWriteItemsCommand(input));
    } catch (err) {
      if (keepOutcome(err) !== 'again' || attempt === 3) throw err;
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
    }
  }
}

/**
 * Her answer to a picture: "Keep it" or "Thank you". Says whether the card
 * is finished by it. Everything is decided from rows read here — the stored
 * card, the count — and nothing from the press but which card and which
 * button; the time is this server's.
 *
 * Logged, never thrown, and never which answer it was: the press is already
 * on the timeline, and a keeping that fails leaves the card as it was and
 * sends it back to be pressed again.
 */
async function answerPhoto({ sendCard, sendControl, householdId, deviceId, press: { photoId, answer } }) {
  const now = Date.now();
  let stored;
  try {
    const [card, count] = await Promise.all([
      ddb.send(new GetItemCommand({ TableName: TABLE, Key: photoCardKey(householdId, photoId), ConsistentRead: true })),
      ddb.send(new GetItemCommand({ TableName: TABLE, Key: mantelCountKey(householdId), ConsistentRead: true })),
    ]);
    stored = storedPhotoCard(card.Item, photoId);
    // Not a picture that was sent to this home: nothing to answer.
    if (!stored) return false;
    // Answered already — on another television, or a moment ago: what was answered stands.
    if (stored.answered) return true;

    console.log(JSON.stringify({ level: 'info', msg: 'photo_answered' }));
    // The one thing the family is told, and the same whichever button this was.
    await markSeen(householdId, photoId, now);

    if (answer === PHOTO_ACTIONS.thanks) {
      // The first answer is the answer: only a card still waiting is thanked for.
      if (!(await claimed(thanksClaim({ table: TABLE, householdId, photoId, at: now })))) return true;
      await retag(householdId, photoId, PHOTO_STATES.gone);
      return true;
    }

    if (!mantelRoom(count.Item)) return await noRoom({ sendCard, stored, row: card.Item });

    // The bytes are secured before anything is promised: nothing is put on
    // her mantelpiece that the bucket might still let go of.
    const secured = await retag(householdId, photoId, PHOTO_STATES.kept);
    if (secured === 'missing') {
      // The picture itself is gone — the bucket let go of it before she
      // answered. There is nothing to keep and never will be, so the card
      // must not come back to be pressed again for ever: it is finished as
      // any answered card is (claimed here, seen above, taken off the home's
      // other televisions by the caller), and an empty frame is not kept.
      await claimed(thanksClaim({ table: TABLE, householdId, photoId, at: now }));
      return true;
    }
    if (secured !== 'ok') return await notPutAway({ sendCard, stored, row: card.Item, full: false });

    try {
      await transact(keepWrite({ table: TABLE, householdId, photoId, fromName: stored.fromName, at: now }));
    } catch (err) {
      const outcome = keepOutcome(err);
      // On her mantelpiece already, kept on another television a moment before.
      if (outcome === 'kept') return true;
      if (outcome === 'answered') {
        // She said thank you on another television, and that came first.
        await retag(householdId, photoId, PHOTO_STATES.gone);
        return true;
      }
      // Not kept after all: the picture is put back as it was, still to be answered.
      await retag(householdId, photoId, PHOTO_STATES.sent);
      if (outcome === 'full') return await noRoom({ sendCard, stored, row: card.Item });
      console.error('photo_answer_failed', { err: err?.name });
      return await notPutAway({ sendCard, stored, row: card.Item, full: false });
    }

    // The count has changed: every home screen is told — this one at once, the others by the agent plane.
    await tellEveryHome({ sendControl, householdId, deviceId, consistent: true });
    return true;
  } catch (err) {
    console.error('photo_answer_failed', { err: err?.name });
    // Left as it was; when the card could be read, it goes back to be pressed again.
    if (stored && !stored.answered) {
      try {
        await sendCard(cardBack(stored.queued, { full: false }));
      } catch (sendErr) {
        console.error('photo_card_back_failed', { err: sendErr?.name });
      }
    }
    return false;
  }
}

/** "Keep it", and no room: nothing is kept and the card is not finished — it goes back saying so. */
const noRoom = ({ sendCard, stored, row }) => notPutAway({ sendCard, stored, row, full: true });

/**
 * The card back on the television that pressed (mantel.mjs cardBack): it
 * took the card off at the press, so it is sent again — through the one
 * wrapper, which gives it her language and a fresh address. Never stored.
 */
async function notPutAway({ sendCard, stored, row, full }) {
  await sendCard(cardBack(stored.queued, { full }), { row });
  return false;
}

/** A conditional write that is somebody's claim: whether it went through. */
async function claimed(update) {
  try {
    await ddb.send(new UpdateItemCommand(update));
    return true;
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/** She has seen it (mantel.mjs seenUpdate). Logged, never thrown: what she pressed still counts. */
async function markSeen(householdId, photoId, at) {
  try {
    await ddb.send(new UpdateItemCommand(seenUpdate({ table: TABLE, householdId, photoId, at })));
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return; // no row for this picture: nothing to say it on
    console.error('photo_seen_write_failed', { err: err?.name });
  }
}

/**
 * Her mantelpiece, for the television that asked — THE ONE PLACE the
 * `mantel` control is sent, and it is sent only as the answer to that
 * television's own asking, on the channel it asked on (INV-2's accepted
 * exception: a reply to the television that just spoke). Each thing carries
 * an address minted for this asking. It is never put on the bus, never sent
 * to another television, never stored and never logged — not even how many.
 */
async function showMantel({ sendControl, householdId, consistent = false }) {
  try {
    const rows = await loadHomeRows(householdId, { consistent });
    const items = mantelItems(rows, (photoId) => pictureAddress({ bucket: PHOTOS_BUCKET, householdId, photoId }));
    await sendControl({ t: 'mantel', items });
  } catch (err) {
    console.error('mantel_show_failed', { err: err?.name });
  }
}

/**
 * She takes one thing down. Only a thing that is there: anything else
 * changes nothing, and tells the bucket nothing — a picture still waiting
 * for her answer must not be let go of because somebody named it here. The
 * television that asked is answered with the mantelpiece as it now stands;
 * when it changed, every home screen is told the count. Logged, never thrown.
 */
async function takeDown({ sendControl, householdId, deviceId, photoId }) {
  let taken = false;
  try {
    await transact(takeDownWrite({ table: TABLE, householdId, photoId, at: Date.now() }));
    taken = true;
    await retag(householdId, photoId, PHOTO_STATES.gone);
  } catch (err) {
    if (err?.name !== 'TransactionCanceledException') console.error('mantel_take_down_failed', { err: err?.name });
  }
  await showMantel({ sendControl, householdId, consistent: true });
  if (taken) await tellEveryHome({ sendControl, householdId, deviceId, consistent: true });
}

// ---------------------------------------------------------------------------
// Read to me — see speech.mjs, whose header says what each rule is for.
// ---------------------------------------------------------------------------

let polly;

/**
 * Amazon Polly, from the SDK the runtime brings — loaded the first time she
 * asks for a reading, not before. A runtime that could not load it costs
 * her a reading (speech.mjs answers with no address and says why), never
 * anything else this function does.
 */
async function pollySynthesize(input, signal) {
  polly ??= import('@aws-sdk/client-polly').then((sdk) => ({ client: new sdk.PollyClient({}), Command: sdk.SynthesizeSpeechCommand }));
  let loaded;
  try {
    loaded = await polly;
  } catch (err) {
    // Tried again at the next asking.
    polly = undefined;
    throw err;
  }
  const spoken = await loaded.client.send(new loaded.Command(input), { abortSignal: signal });
  return spoken.AudioStream?.transformToByteArray();
}

/**
 * The card she is asking to have read, as it is stored — or, for the two
 * cards that are on her screen without being stored, built again exactly as
 * they were built for her: the Light card (showLight) and the offer her
 * hold brought (showReach). Undefined for anything else: a card that is not
 * there, has been answered, or is over, is not on her screen to be read.
 */
async function cardOnHerScreen(householdId, cardId, now) {
  const stored = await ddb.send(new GetItemCommand({ TableName: TABLE, Key: { pk: { S: `HH#${householdId}` }, sk: { S: `CARD#${cardId}` } } }));
  if (stored.Item) {
    const queued = readableCard(stored.Item, now);
    return queued ? { queued, from: { row: stored.Item } } : undefined;
  }
  if (cardId === LIGHT_CARD_ID) {
    const rows = await loadHomeRows(householdId);
    const queued = buildLightCard({ householdId, items: rows, now, timeZone: timeZoneOfRows(rows) });
    return queued ? { queued, from: { rows } } : undefined;
  }
  const reachId = reachOfferId(cardId);
  if (reachId) {
    const rows = await loadHomeRows(householdId);
    return { queued: buildReachAskCard({ householdId, reachId, first: firstToAsk(rows), now }), from: { rows } };
  }
  return undefined;
}

/**
 * Her pressing Play on a card: the reading's address, to the television
 * that asked — THE ONE PLACE the `speech` control is sent, and it is sent
 * only as the answer to that television's own asking, on the channel it
 * asked on (INV-2's accepted exception: a reply to the television that just
 * spoke). The address is never put on the bus, never sent to another
 * television, never stored and never logged; neither is the card's id, or a
 * word of what was read.
 *
 * Always answered, with an address or without: without one the television
 * says nothing and shows nothing changed. Never thrown.
 */
async function readToHer({ sendControl, cardAsShown, householdLanguage, householdId, cardId, synthesize }) {
  const now = Date.now();
  const url = await answerReading({
    householdId,
    // The card as her television shows it: her language, and the translation kept beside it (language.mjs).
    card: async () => {
      const found = await cardOnHerScreen(householdId, cardId, now);
      return found ? (await cardAsShown(found.queued, found.from)).card : undefined;
    },
    language: householdLanguage,
    claim: () => claimed(readingClaim({ table: TABLE, householdId, now })),
    kept: async (key) => {
      const { client, sdk } = await bucketClient();
      await client.send(new sdk.HeadObjectCommand({ Bucket: MEDIA_BUCKET, Key: key }));
      return true;
    },
    synthesize,
    keep: async (key, bytes, signal) => {
      const { client, sdk } = await bucketClient();
      await client.send(new sdk.PutObjectCommand({ Bucket: MEDIA_BUCKET, Key: key, Body: bytes, ContentType: 'audio/mpeg' }), { abortSignal: signal });
    },
    address: (key) => readingAddress({ bucket: MEDIA_BUCKET, key }),
  });
  try {
    await sendControl({ t: 'speech', cardId, ...(url ? { url } : {}) });
  } catch (err) {
    console.error('reading_answer_failed', { err: err?.name });
  }
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

/**
 * Every CARD# item of the household, as it is this instant, page by page.
 * A consistent read: what a television is handed, and what is taken back
 * from it, is decided by whether a card has been answered — and an answer
 * given a moment ago, on another television, must count.
 */
async function loadCardRows(householdId) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': { S: `HH#${householdId}` }, ':prefix': { S: 'CARD#' } },
      ConsistentRead: true,
      ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
    }));
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function reconcile({ sendCard, sendControl, householdId, holding }) {
  // Every CARD# item for the household: a card the resident
  // hasn't acted on is replayed whatever its id (card-acted.mjs's
  // isReplayable says why the device's sinceCardId is no longer used to
  // filter). The device upserts by id, so a card it already holds is a no-op.
  const items = await loadCardRows(householdId);

  // First what to put away: a card this television still holds that was
  // answered on another one while it was off (card-acted.mjs finishedAmong).
  for (const cardId of finishedAmong(items, holding)) {
    if (!(await sendControl({ t: 'revoke', cardId }))) {
      console.log('reconcile: television gone mid-replay, stopping', { householdId });
      return;
    }
  }

  const now = Date.now();
  const replayed = [];
  for (const item of items) {
    if (!isReplayable(item, now)) continue;
    // The stored card is English; it goes out in her language, with the free
    // text the agent plane translated and kept on this same row (language.mjs).
    const queued = replayedCard(item);
    if (!(await sendCard(queued, { row: item }))) {
      console.log('reconcile: television gone mid-replay, stopping', { householdId });
      return;
    }
    replayed.push(queued.id);
  }

  // The cards were read, then handed over one by one — and in that time a
  // card can be answered on another television of the home, taken back by
  // its sender, or (a door card) be over. Its own `revoke` may have reached
  // this television before the card did, which would leave a finished card
  // on her screen until she next reconnects. So the rows are read once more
  // — one read for all of them, and none when nothing was handed over — and
  // anything just replayed that is finished by now is taken back
  // (card-acted.mjs finishedSince). What is left is the instant between
  // this read and the `revoke` arriving; a press in it changes nothing,
  // since every answer is written only while its question is open.
  if (replayed.length === 0) return;
  for (const cardId of finishedSince(replayed, await loadCardRows(householdId), Date.now())) {
    if (!(await sendControl({ t: 'revoke', cardId }))) {
      console.log('reconcile: television gone mid-replay, stopping', { householdId });
      return;
    }
  }
}
