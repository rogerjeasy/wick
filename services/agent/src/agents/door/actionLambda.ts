/**
 * EventBridge `wick.device` events → whatever carries them out.
 *
 *   TV → ws route.mjs / iot-events.mjs → EventBridge → (this)
 *
 *   card.action
 *     hallway_chime            → AgentCore → door-action graph: gate → ring → notify → patch → TV
 *     ask_family               → door/askFamily.ts, here: gate → file the request → patch → TV → nudge
 *     tell_family/keep_private → tell/answer.ts, here: record the answer → nudge, or nothing
 *     ring_me/say_hello        → reach/ask.ts, here: file the request → card → TV → nudge one person → set the timer
 *     visit_right/visit_wrong  → visit/answer.ts, here: her yes or no on a visit → kept; a no becomes "Shall I tell …?"
 *   television.active          → tell/ask.ts, here: is anything different? → file the question → card → TV
 *                              → visit/ask.ts too: a visit that is ready is put to her
 *   card.retired               → egress.ts, here: the home's other televisions put the card away
 *   home.changed               → egress.ts, here: the home's other televisions are told how the home screen stands
 *     … languageChangedTo      → egress.ts, here: the cards she has not answered are put into the language she has just chosen
 *   reach.due                  → reach/due.ts, here: three minutes on and no answer → the next person is asked
 *                                (not from the bus: the one-time schedule reach/timer.ts set calls this function)
 *
 * A shim for the chime, because EventBridge cannot target an AgentCore
 * Runtime. Everything else is answered here: none of it needs a model or a
 * Ring call, and a household's runtime session would only be woken to write
 * a row.
 *
 * Nothing is retried here: the EventBridge targets have zero retries, and
 * each handler's once-only claim makes any redelivery harmless.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { CreateScheduleCommand, SchedulerClient } from '@aws-sdk/client-scheduler';
import { randomUUID } from 'node:crypto';
import { DEFAULT_LANGUAGE, DOOR_ACTIONS, PUSH_KINDS, isHouseholdLanguage, reachKindOf, readHomeState, tellAnswerOf, visitAnswerOf, type HomeState, type HouseholdLanguage } from '@wick/contracts';
import { DEFAULT_POLICY } from '@wick/policy';
import { nudgeFamily, sendHomeToDevices, sendPatchToDevice, sendToDevice, sendWaitingCardsInLanguage, withdrawFromDevices } from '../../egress.js';
import { loadShareableDifferences } from '../../rhythm/loadDifferent.js';
import { tellStore, type TellSend } from '../../store/tells.js';
import { handleTellAnswer, type TellAnswerResult } from '../tell/answer.js';
import { askAboutDifferences } from '../tell/ask.js';
import { cardStore, type DdbSend } from '../../store/cards.js';
import { lookStore, type LookSend } from '../../store/looks.js';
import { familyOnly, handleAskFamily, type AskResult } from './askFamily.js';
import { handleReachAsk, type ReachAskResult, type ReachDue } from '../reach/ask.js';
import { handleReachDue, type ReachDueResult } from '../reach/due.js';
import { REACH_DUE, reachDueSchedule } from '../reach/timer.js';
import { reachStore, type ReachSend } from '../../store/reaches.js';
import { askAboutVisits } from '../visit/ask.js';
import { handleVisitAnswer, type VisitAnswerResult } from '../visit/answer.js';
import { visitStore, type VisitSend } from '../../store/visits.js';
import { isSharedWithFamily, loadHouseholdPolicy } from '../../store/household.js';
import { buildTellCard } from '../tell/ask.js';
import { familyToAsk } from './index.js';
import { agentCoreTarget, invokeRuntime, type RuntimeTarget } from '../../runtime/invoke.js';

type Invoke = (kind: string, householdId: string, payload: Record<string, unknown>) => Promise<unknown>;

export async function forwardCardAction(evt: { detail: Record<string, unknown> }, invoke: Invoke): Promise<unknown> {
  const householdId = evt.detail.householdId;
  if (typeof householdId !== 'string' || !householdId) return { result: 'ignored' };
  return invoke('door.action', householdId, { detail: evt.detail });
}

export interface CardActionRoutes {
  readonly invoke: Invoke;
  readonly askFamily: (detail: Record<string, unknown>) => Promise<AskResult>;
  /** The resident's press on a Tell card (tell/answer.ts). */
  readonly tellAnswer: (detail: Record<string, unknown>) => Promise<TellAnswerResult>;
  /** Looks for anything different and asks the resident about it (tell/ask.ts). Answers with what was asked. */
  readonly askResident: (householdId: string) => Promise<readonly string[]>;
  /** Takes a card off the home's televisions that still have it up, but for the one that was pressed (egress.ts withdrawFromDevices). */
  readonly withdraw: (householdId: string, cardId: string, pressedOn?: string) => Promise<void>;
  /** Tells the home's other televisions how the home screen now stands, whole (egress.ts sendHomeToDevices). */
  readonly tellHome: (householdId: string, home: HomeState, pressedOn?: string) => Promise<void>;
  /**
   * Her press changed the language her television speaks, to one that is not
   * English: the cards she has not yet answered are put into it and sent
   * again (egress.ts sendWaitingCardsInLanguage). Absent, nothing more is done.
   */
  readonly languageChanged?: (householdId: string, language: HouseholdLanguage, correlationId?: string) => Promise<{ readonly sent: number }>;
  /** This server's clock: how old an event is, is not the event's to say. */
  readonly now?: () => number;
  /** The resident's "Yes, ask Sarah" or "Just say hello" on the card her hold brought (reach/ask.ts). */
  readonly reachAsk: (detail: Record<string, unknown>) => Promise<ReachAskResult>;
  /** Three minutes on and no answer: the next person is asked (reach/due.ts). */
  readonly reachDue: (detail: Record<string, unknown>) => Promise<ReachDueResult>;
  /** The resident's yes or no to what the door noted of a visit (visit/answer.ts). */
  readonly visitAnswer: (detail: Record<string, unknown>) => Promise<VisitAnswerResult>;
  /** Puts any visit that is ready to the resident (visit/ask.ts). Answers with the visits asked about. */
  readonly askVisits: (householdId: string) => Promise<readonly string[]>;
}

/** How long after her press a change of language is still acted on. */
export const LANGUAGE_CHANGE_FRESH_MS = 2 * 60_000;
/** How far ahead of this server's clock the edge's may be, and its event still be taken for one just made. */
const LANGUAGE_CHANGE_CLOCK_SKEW_MS = 5_000;

export interface DeviceBusEvent {
  /** Absent on events from before there was more than one: those were all card.action. */
  readonly 'detail-type'?: string;
  readonly detail: Record<string, unknown>;
}

export async function routeCardAction(evt: DeviceBusEvent, routes: CardActionRoutes): Promise<unknown> {
  if (evt['detail-type'] === 'television.active') {
    const householdId = evt.detail.householdId;
    if (typeof householdId !== 'string' || !householdId) return { result: 'ignored' };
    // She is at the television: a visit that is ready is put to her too. Never in the way of the other asking.
    const visits = await routes.askVisits(householdId).catch((err: unknown) => {
      console.error(JSON.stringify({ level: 'error', msg: 'visits_not_asked', err: err instanceof Error ? err.name : 'unknown' }));
      return [];
    });
    return { result: 'asked', about: (await routes.askResident(householdId)).length, visits: visits.length };
  }
  if (evt['detail-type'] === 'card.retired') {
    // Answered on one television: a second one in the home must not go on asking.
    const { householdId, cardId, deviceId } = evt.detail;
    if (typeof householdId !== 'string' || !householdId || typeof cardId !== 'string' || !cardId) return { result: 'ignored' };
    await routes.withdraw(householdId, cardId, typeof deviceId === 'string' ? deviceId : undefined);
    return { result: 'withdrawn' };
  }
  if (evt['detail-type'] === 'home.changed') {
    // The light put out or lit again, or what is shared changed, on one television: a second one in the home must not go on saying otherwise.
    const { householdId, deviceId } = evt.detail;
    const home = readHomeState(evt.detail.home);
    if (typeof householdId !== 'string' || !householdId || !home) return { result: 'ignored' };
    await routes.tellHome(householdId, home, typeof deviceId === 'string' ? deviceId : undefined);

    // The edge says so when — and only when — her press changed the language
    // (edge-device light.mjs buildHomeChangedEntry). It is what the event
    // says changed that counts here, never the language the home state
    // carries: every home message of a Spanish household names Spanish.
    // English needs nothing: what is stored is English.
    const { languageChangedTo, correlationId, at } = evt.detail;
    if (!routes.languageChanged || !isHouseholdLanguage(languageChangedTo) || languageChangedTo === DEFAULT_LANGUAGE) return { result: 'home_told' };
    // Acted on when it happens, or not at all. An event delivered again long
    // after — the bus does redeliver — must not translate and re-send
    // today's cards for a change of language that is long past: one that
    // does not say when it happened, or was not just now, is left alone.
    // (Her television has had its cards replayed in her language by the edge
    // since; only a note's own text may still be as it was written.)
    const age = typeof at === 'number' && Number.isFinite(at) ? (routes.now ?? Date.now)() - at : Number.NaN;
    if (!(age >= -LANGUAGE_CHANGE_CLOCK_SKEW_MS && age <= LANGUAGE_CHANGE_FRESH_MS)) return { result: 'home_told' };
    const follow = typeof correlationId === 'string' && correlationId ? correlationId : undefined;
    try {
      const { sent } = await routes.languageChanged(householdId, languageChangedTo, follow);
      return { result: 'home_told', cardsSentAgain: sent };
    } catch (err) {
      // The televisions have heard of the language; a card left as it was is put right when it is next sent.
      console.error(JSON.stringify({ level: 'error', msg: 'cards_not_put_in_her_language', correlationId: follow, err: err instanceof Error ? err.name : 'unknown' }));
      return { result: 'home_told' };
    }
  }
  // A timer, and so never a press — whatever else it may carry.
  if (evt['detail-type'] === REACH_DUE) return { result: await routes.reachDue(evt.detail) };
  if (evt.detail.action === DOOR_ACTIONS.askFamily) return { result: await routes.askFamily(evt.detail) };
  if (reachKindOf(evt.detail.action)) return { result: await routes.reachAsk(evt.detail) };
  if (tellAnswerOf(evt.detail.action)) return { result: await routes.tellAnswer(evt.detail) };
  if (visitAnswerOf(evt.detail.action)) return { result: await routes.visitAnswer(evt.detail) };
  return forwardCardAction(evt, routes.invoke);
}

let target: RuntimeTarget | undefined;
const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME ?? '';

function askFamily(detail: Record<string, unknown>): Promise<AskResult> {
  const looks = lookStore((cmd) => ddb.send(cmd as never) as ReturnType<LookSend>, TABLE);
  const cards = cardStore((cmd) => ddb.send(cmd as never) as ReturnType<DdbSend>, TABLE);
  const householdId = typeof detail.householdId === 'string' ? detail.householdId : '';
  return handleAskFamily(detail, {
    loadCard: cards.loadCard,
    listFamily: looks.listFamily,
    claimOnce: looks.claimOnce,
    sendPatch: (patch) => sendPatchToDevice(patch, householdId),
    nudge: async (userIds) => void (await nudgeFamily(userIds, PUSH_KINDS.doorLook)),
    now: Date.now,
  });
}

const looks = () => lookStore((cmd) => ddb.send(cmd as never) as ReturnType<LookSend>, TABLE);
/** Who is told what the resident chose to share: the family, never a neighbour (askFamily.ts familyOnly). */
const listFamilyOnly = async (householdId: string) => familyOnly(await looks().listFamily(householdId));
const tells = () => tellStore((cmd) => ddb.send(cmd as never) as ReturnType<TellSend>, TABLE);

function tellAnswer(detail: Record<string, unknown>): Promise<TellAnswerResult> {
  return handleTellAnswer(detail, {
    recordAnswer: tells().recordAnswer,
    listFamily: listFamilyOnly,
    nudge: async (userIds) => void (await nudgeFamily(userIds, PUSH_KINDS.told)),
    withdraw: (householdId, cardId) => withdrawFromDevices(cardId, householdId),
    now: Date.now,
  });
}

function askResident(householdId: string): Promise<readonly string[]> {
  const store = tells();
  return askAboutDifferences(householdId, {
    loadDifferences: (hh) => loadShareableDifferences(ddb, TABLE, hh, Date.now(), process.env.WICK_HOUSEHOLD_TZ ?? 'Europe/London'),
    listFamily: listFamilyOnly,
    claimOnce: store.claimOnce,
    release: store.release,
    sendCard: (card) => sendToDevice(card, DEFAULT_POLICY),
    now: Date.now,
    newCorrelationId: randomUUID,
  });
}

const reaches = () => reachStore((cmd) => ddb.send(cmd as never) as ReturnType<ReachSend>, TABLE);

let scheduler: SchedulerClient | undefined;

/**
 * Sets the three minutes going (reach/timer.ts). A deployment that has no
 * timer to set says so in its log and asks only the first person: the
 * request itself is already filed and already told. A timer set twice is
 * refused by its name, which is the request and the step.
 */
async function scheduleReachDue(due: ReachDue): Promise<void> {
  const targetArn = process.env.REACH_TIMER_TARGET_ARN;
  const roleArn = process.env.REACH_TIMER_ROLE_ARN;
  const group = process.env.REACH_TIMER_GROUP;
  if (!targetArn || !roleArn || !group) {
    console.error(JSON.stringify({ level: 'error', msg: 'reach_timer_not_configured' }));
    return;
  }
  try {
    await (scheduler ??= new SchedulerClient({})).send(new CreateScheduleCommand(reachDueSchedule({ due, targetArn, roleArn, group })));
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConflictException') throw err;
  }
}

function reachAsk(detail: Record<string, unknown>): Promise<ReachAskResult> {
  const store = reaches();
  return handleReachAsk(detail, {
    listCircle: store.listCircle,
    claimOnce: store.claimOnce,
    sendCard: (card) => sendToDevice(card, DEFAULT_POLICY),
    nudge: async (userIds, kind) => void (await nudgeFamily(userIds, kind)),
    schedule: scheduleReachDue,
    now: Date.now,
  });
}

function reachDue(detail: Record<string, unknown>): Promise<ReachDueResult> {
  const store = reaches();
  return handleReachDue(detail, {
    load: store.load,
    listCircle: store.listCircle,
    advance: store.advance,
    finish: store.finish,
    sendCard: (card) => sendToDevice(card, DEFAULT_POLICY),
    nudge: async (userIds, kind) => void (await nudgeFamily(userIds, kind)),
    schedule: scheduleReachDue,
    now: Date.now,
  });
}

const visits = () => visitStore((cmd) => ddb.send(cmd as never) as ReturnType<VisitSend>, TABLE);
const HOUSEHOLD_TZ = process.env.WICK_HOUSEHOLD_TZ ?? 'Europe/London';

function askVisits(householdId: string): Promise<readonly string[]> {
  const store = visits();
  return askAboutVisits(householdId, {
    recent: store.recent,
    claimAsk: store.claimAsk,
    releaseAsk: store.releaseAsk,
    sendCard: (card) => sendToDevice(card, DEFAULT_POLICY),
    now: Date.now,
    timeZone: HOUSEHOLD_TZ,
  });
}

function visitAnswer(detail: Record<string, unknown>): Promise<VisitAnswerResult> {
  return handleVisitAnswer(detail, {
    answer: visits().answer,
    withdraw: (householdId, cardId) => withdrawFromDevices(cardId, householdId),
    // Somebody she allows, who she shares her visitors and the shape of her week with:
    // otherwise what she told could not be read (get_whats_different), so it is not offered.
    whoToTell: async (householdId) => {
      const policy = await loadHouseholdPolicy(ddb, TABLE, householdId);
      if (!isSharedWithFamily('PRESENCE', policy) || !isSharedWithFamily('RHYTHM', policy)) return undefined;
      return familyToAsk((await listFamilyOnly(householdId)).map((member) => member.name));
    },
    offerToTell: async (offer) => {
      const claimed = await tells().claimOnce({
        householdId: offer.householdId,
        differenceId: offer.differenceId,
        kind: 'visit_disputed',
        factClass: 'PRESENCE',
        sentence: offer.sentence,
        at: offer.at,
        askedAt: offer.now,
        weeksObserved: 0,
      });
      if (claimed) await sendToDevice(buildTellCard({ ...offer, correlationId: randomUUID() }), DEFAULT_POLICY);
      return claimed;
    },
    now: Date.now,
    timeZone: HOUSEHOLD_TZ,
  });
}

export const handler = async (evt: DeviceBusEvent): Promise<void> => {
  const out = await routeCardAction(evt, {
    // The runtime is looked up only for a press that needs it.
    invoke: (kind, hh, payload) => invokeRuntime((target ??= agentCoreTarget()), kind, hh, payload),
    askFamily,
    tellAnswer,
    askResident,
    withdraw: (householdId, cardId, pressedOn) => withdrawFromDevices(cardId, householdId, pressedOn),
    tellHome: (householdId, home, pressedOn) => sendHomeToDevices(householdId, home, { whole: true, exceptDeviceId: pressedOn }),
    languageChanged: sendWaitingCardsInLanguage,
    reachAsk,
    reachDue,
    visitAnswer,
    askVisits,
  });
  // Ids and the outcome only — never card content.
  console.log(JSON.stringify({ level: 'info', msg: 'card_action_handled', cardId: evt.detail.cardId, action: evt.detail.action, out }));
};
