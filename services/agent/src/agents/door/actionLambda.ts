/**
 * EventBridge `wick.device` / `card.action` → whatever carries the press out.
 *
 *   TV card_action → ws route.mjs → EventBridge → (this)
 *     hallway_chime → AgentCore → door-action graph: gate → ring → notify → patch → TV
 *     ask_family    → askFamily.ts, here: gate → file the request → patch → TV
 *
 * A shim for the chime, because EventBridge cannot target an AgentCore
 * Runtime. "Ask Sarah to look" is answered here instead: it needs no model
 * and no Ring call, and a household's runtime session would only be woken to
 * write one row.
 *
 * A press is never retried here: the EventBridge target has zero retries,
 * and each handler's once-per-card claim makes any redelivery harmless.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DOOR_ACTIONS, PUSH_KINDS } from '@wick/contracts';
import { nudgeFamily, sendPatchToDevice } from '../../egress.js';
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
}

export async function routeCardAction(evt: { detail: Record<string, unknown> }, routes: CardActionRoutes): Promise<unknown> {
  if (evt.detail.action === DOOR_ACTIONS.askFamily) return { result: await routes.askFamily(evt.detail) };
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

export const handler = async (evt: { detail: Record<string, unknown> }): Promise<void> => {
  const out = await routeCardAction(evt, {
    // The runtime is looked up only for a press that needs it.
    invoke: (kind, hh, payload) => invokeRuntime((target ??= agentCoreTarget()), kind, hh, payload),
    askFamily,
  });
  // Ids and the outcome only — never card content.
  console.log(JSON.stringify({ level: 'info', msg: 'card_action_handled', cardId: evt.detail.cardId, action: evt.detail.action, out }));
};
