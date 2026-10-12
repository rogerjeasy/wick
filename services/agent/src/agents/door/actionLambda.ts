/**
 * EventBridge `wick.device` events → whatever carries them out.
 *
 *   TV → ws route.mjs / iot-events.mjs → EventBridge → (this)
 *
 *   card.action
 *     hallway_chime            → AgentCore → door-action graph: gate → ring → notify → patch → TV
 *     ask_family               → door/askFamily.ts, here: gate → file the request → patch → TV → nudge
 *     tell_family/keep_private → tell/answer.ts, here: record the answer → nudge, or nothing
 *   television.active          → tell/ask.ts, here: is anything different? → file the question → card → TV
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
import { randomUUID } from 'node:crypto';
import { DOOR_ACTIONS, PUSH_KINDS, tellAnswerOf } from '@wick/contracts';
import { DEFAULT_POLICY } from '@wick/policy';
import { nudgeFamily, sendPatchToDevice, sendToDevice } from '../../egress.js';
import { loadShareableDifferences } from '../../rhythm/loadDifferent.js';
import { tellStore, type TellSend } from '../../store/tells.js';
import { handleTellAnswer, type TellAnswerResult } from '../tell/answer.js';
import { askAboutDifferences } from '../tell/ask.js';
import { cardStore, type DdbSend } from '../../store/cards.js';
import { lookStore, type LookSend } from '../../store/looks.js';
import { handleAskFamily, type AskResult } from './askFamily.js';
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
}

export interface DeviceBusEvent {
  /** Absent on events from before there was more than one: those were all card.action. */
  readonly 'detail-type'?: string;
  readonly detail: Record<string, unknown>;
}

export async function routeCardAction(evt: DeviceBusEvent, routes: CardActionRoutes): Promise<unknown> {
  if (evt['detail-type'] === 'television.active') {
    const householdId = evt.detail.householdId;
    if (typeof householdId !== 'string' || !householdId) return { result: 'ignored' };
    return { result: 'asked', about: (await routes.askResident(householdId)).length };
  }
  if (evt.detail.action === DOOR_ACTIONS.askFamily) return { result: await routes.askFamily(evt.detail) };
  if (tellAnswerOf(evt.detail.action)) return { result: await routes.tellAnswer(evt.detail) };
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
const tells = () => tellStore((cmd) => ddb.send(cmd as never) as ReturnType<TellSend>, TABLE);

function tellAnswer(detail: Record<string, unknown>): Promise<TellAnswerResult> {
  return handleTellAnswer(detail, {
    recordAnswer: tells().recordAnswer,
    listFamily: looks().listFamily,
    nudge: async (userIds) => void (await nudgeFamily(userIds, PUSH_KINDS.told)),
    now: Date.now,
  });
}

function askResident(householdId: string): Promise<readonly string[]> {
  const store = tells();
  return askAboutDifferences(householdId, {
    loadDifferences: (hh) => loadShareableDifferences(ddb, TABLE, hh, Date.now(), process.env.WICK_HOUSEHOLD_TZ ?? 'Europe/London'),
    listFamily: looks().listFamily,
    claimOnce: store.claimOnce,
    release: store.release,
    sendCard: (card) => sendToDevice(card, DEFAULT_POLICY),
    now: Date.now,
    newCorrelationId: randomUUID,
  });
}

export const handler = async (evt: DeviceBusEvent): Promise<void> => {
  const out = await routeCardAction(evt, {
    // The runtime is looked up only for a press that needs it.
    invoke: (kind, hh, payload) => invokeRuntime((target ??= agentCoreTarget()), kind, hh, payload),
    askFamily,
    tellAnswer,
    askResident,
  });
  // Ids and the outcome only — never card content.
  console.log(JSON.stringify({ level: 'info', msg: 'card_action_handled', cardId: evt.detail.cardId, action: evt.detail.action, out }));
};
