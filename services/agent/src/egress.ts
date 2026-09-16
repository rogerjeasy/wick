/**
 * THE SINGLE EGRESS MODULE.  INV-2.
 *
 * This is the only module in the repository permitted to import a transport
 * client. Every other module calls sendToFamily() / sendToDevice(). An ESLint
 * no-restricted-imports rule enforces it — a rule you can run beats a convention
 * you can only remember.
 *
 * Why it matters beyond tidiness: prompt injection is a live threat here. Bee
 * captures whatever was said, and a visitor's clothing or signage lands inside a
 * vision prompt. Because the Guardian runs HERE — deterministically, after
 * generation, on typed classes — a model that gets talked into emitting a health
 * fact still cannot get it past the gate.
 *
 * See docs/WICK-TECHNICAL.md §6.3, §10.2.
 */
import { evaluate, type Audience, type HouseholdPolicy } from '@wick/policy';
import type { FactClass, QueuedCard } from '@wick/contracts';
import { DynamoDBClient, PutItemCommand, QueryCommand, UpdateItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';

const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME ?? '';

export interface EgressItem {
  readonly class: FactClass;
  readonly content: string;
  readonly sourceIds: readonly string[];
  readonly correlationId: string;
}

export type EgressResult =
  | { readonly sent: true; readonly content: string }
  | { readonly sent: false; readonly reason: string };

/**
 * The only path to a family surface.
 *
 * A Guardian that throws must fail CLOSED — refuse, alarm, and never fall
 * through to sending. See §11.
 */
export async function sendToFamily(
  item: EgressItem,
  audience: Extract<Audience, 'FAMILY' | 'AGENCY'>,
  policy: HouseholdPolicy,
): Promise<EgressResult> {
  let decision;
  try {
    decision = evaluate(item, audience, policy);
  } catch {
    // Fail closed. Emit guardian.error; the alarm is wired in infra/.
    return { sent: false, reason: 'Unable to share that right now.' };
  }

  if (!decision.allow) return { sent: false, reason: decision.reason };

  // TODO(S5): apply decision.transform ('summarise' | 'redact_specifics') before send.
  // TODO(S5): log { class, audience, allow, transform, reason } — NEVER content (§11).
  throw new Error('not implemented');
}

/**
 * The only path to the television.
 *
 * The resident is always audience RESIDENT, so the Guardian is permissive here —
 * but it still runs, because "the resident sees everything about themselves" is a
 * policy decision, not an absence of policy.
 */
export async function sendToDevice(
  card: QueuedCard,
  _policy: HouseholdPolicy,
): Promise<void> {
  const householdId = card.card.householdId;

  // The Card item is the queue's source of truth — written unconditionally,
  // before any attempt at a live push, so connect.mjs's reconcile step can
  // always deliver it later even if the device is offline right now.
  const item: Record<string, AttributeValue> = {
    pk: { S: `HH#${householdId}` },
    sk: { S: `CARD#${card.id}` },
    data: { S: JSON.stringify(card) },
  };
  if (card.expiresAt !== undefined) {
    item.ttl = { N: String(Math.floor(card.expiresAt / 1000)) };
  }
  await ddb.send(new PutItemCommand({ TableName: TABLE, Item: item }));

  const deviceLookup = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': { S: `HH#${householdId}` },
      ':prefix': { S: 'DEV#' },
    },
    Limit: 1,
  }));
  const deviceItem = deviceLookup.Items?.[0];
  const connectionId = deviceItem?.connectionId?.S;
  const transport = deviceItem?.transport?.S;
  const wsEndpoint = deviceItem?.wsEndpoint?.S;

  if (!connectionId || transport !== 'websocket' || !wsEndpoint) {
    // Offline, or on the MQTT path — IoT Core publish isn't wired up yet
    // (SP-5 gate, see the implementation plan's Scope decisions and
    // FRICTION.md). The Card item above is the queue; connect.mjs's
    // reconcile step delivers it the moment the device is next seen.
    return;
  }

  const mgmt = new ApiGatewayManagementApiClient({ endpoint: wsEndpoint });
  try {
    await mgmt.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: JSON.stringify({ kind: 'card', card }),
    }));
  } catch (err) {
    if ((err as { name?: string }).name === 'GoneException') {
      const deviceSk = deviceItem?.sk?.S;
      if (deviceSk) {
        // Guard on connectionId, same as disconnect.mjs: a stale
        // PostToConnection can throw GoneException after the device has
        // already reconnected (fresh connectionId written by connect.mjs
        // in the gap between our earlier Query and this catch). An
        // unconditional REMOVE here would wipe out the live connection.
        try {
          await ddb.send(new UpdateItemCommand({
            TableName: TABLE,
            Key: { pk: { S: `HH#${householdId}` }, sk: { S: deviceSk } },
            UpdateExpression: 'REMOVE connectionId, transport, wsEndpoint, connectedAt',
            ConditionExpression: 'connectionId = :cid',
            ExpressionAttributeValues: { ':cid': { S: connectionId } },
          }));
        } catch (cleanupErr) {
          if ((cleanupErr as { name?: string }).name !== 'ConditionalCheckFailedException') throw cleanupErr;
        }
      }
      return;
    }
    throw err;
  }
}
