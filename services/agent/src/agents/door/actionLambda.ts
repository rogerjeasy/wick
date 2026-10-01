/**
 * EventBridge `wick.device` / `card.action` → the household's AgentCore
 * Runtime session, which runs the door-action graph (graphs/doorAction.ts).
 *
 *   TV card_action → ws route.mjs → EventBridge → (this) → AgentCore
 *     → door-action graph: gate → ring → notify → patch → TV
 *
 * A shim because EventBridge cannot target an AgentCore Runtime. The press
 * is never retried here: the EventBridge target has zero retries, and the
 * graph's once-per-card claim makes any redelivery harmless.
 */
import { agentCoreTarget, invokeRuntime, type RuntimeTarget } from '../../runtime/invoke.js';

type Invoke = (kind: string, householdId: string, payload: Record<string, unknown>) => Promise<unknown>;

export async function forwardCardAction(evt: { detail: Record<string, unknown> }, invoke: Invoke): Promise<unknown> {
  const householdId = evt.detail.householdId;
  if (typeof householdId !== 'string' || !householdId) return { result: 'ignored' };
  return invoke('door.action', householdId, { detail: evt.detail });
}

let target: RuntimeTarget | undefined;

export const handler = async (evt: { detail: Record<string, unknown> }): Promise<void> => {
  target ??= agentCoreTarget();
  const t = target;
  const out = await forwardCardAction(evt, (kind, hh, payload) => invokeRuntime(t, kind, hh, payload));
  // Ids and the outcome only — never card content.
  console.log(JSON.stringify({ level: 'info', msg: 'card_action_handled', cardId: evt.detail.cardId, action: evt.detail.action, out }));
};
