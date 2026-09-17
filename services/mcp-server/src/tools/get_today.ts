/**
 * MCP tool: get_today — bounded Query over the EVT# timeline. See §7.3.
 *
 * Reads the same EVT#<ts>#<ulid> entity route.mjs already writes for
 * card_shown/card_action (real, in production), extended with door/presence
 * kinds that only a seed script writes today. Deterministic formatting only —
 * no model call, matching §9.3's latency budget.
 *
 * route.mjs (services/edge-device/lambda/route.mjs) never writes a separate
 * `at` attribute on these items — the timestamp lives ONLY in the sort key,
 * as `EVT#<15-digit-zero-padded-ms>#<uuid>` (`String(deviceEvent.at).padStart(15,
 * '0')`). So `at` here is parsed back out of the sort key rather than read off
 * an item attribute that real production rows don't have.
 */
import { QueryCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { padTimestamp as padTs, parseTimestampFromSortKey as parseTsFromSk } from '@wick/contracts';
import { DEFAULT_POLICY, type HouseholdPolicy } from '@wick/policy';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HOUSEHOLD_ID } from '../auth.js';
import { loadHouseholdPolicy, isSharedWithFamily, FAMILY_REFUSAL_TEXT } from './get_resident_shared_view.js';
import { withFriendlyErrors } from './errors.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';

export interface RawTimelineEvent {
  readonly type: 'card_shown' | 'card_action' | 'door' | 'presence';
  readonly cardId?: string;
  readonly action?: string;
  readonly personName?: string;
}

export function summariseEvent(event: RawTimelineEvent): string {
  switch (event.type) {
    case 'card_shown':
      return 'A card was shown on the television.';
    case 'card_action':
      return `The resident chose "${event.action}" on a card.`;
    case 'door':
      return 'Someone was at the front door.';
    case 'presence':
      return event.personName ? `${event.personName} arrived.` : 'Someone arrived.';
    default:
      return 'Something happened.';
  }
}

export interface TodayEntry {
  readonly at: number;
  readonly summary: string;
}

export async function loadTodayEvents(
  ddb: DynamoDBClient,
  householdId: string,
  now: Date,
  policy: HouseholdPolicy = DEFAULT_POLICY,
): Promise<readonly TodayEntry[]> {
  const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  // Upper bound is exclusive of the next day's midnight: an event at exactly
  // 00:00:00.000 tomorrow must appear in tomorrow's results only, not both.
  const endOfDay = startOfDay + 86_400_000 - 1;

  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
    ExpressionAttributeValues: {
      ':pk': { S: `HH#${householdId}` },
      ':from': { S: `EVT#${padTs(startOfDay)}` },
      ':to': { S: `EVT#${padTs(endOfDay)}#￿` },
    },
  }));

  // Mirrors get_resident_shared_view.ts's disclosure check independently per
  // event class — a household could exclude PRESENCE but not DOOR_EVENT, or
  // vice versa, so each is gated on its own rather than as an all-or-nothing
  // response (§6.4: refusal is a feature, never silent).
  const doorShared = isSharedWithFamily('DOOR_EVENT', policy);
  const presenceShared = isSharedWithFamily('PRESENCE', policy);

  return (res.Items ?? []).map((item) => {
    const event: RawTimelineEvent = {
      type: item.type?.S as RawTimelineEvent['type'],
      ...(item.cardId?.S !== undefined && { cardId: item.cardId.S }),
      ...(item.action?.S !== undefined && { action: item.action.S }),
      ...(item.personName?.S !== undefined && { personName: item.personName.S }),
    };
    const at = parseTsFromSk(item.sk?.S ?? '');
    if (event.type === 'door' && !doorShared) return { at, summary: FAMILY_REFUSAL_TEXT };
    if (event.type === 'presence' && !presenceShared) return { at, summary: FAMILY_REFUSAL_TEXT };
    return { at, summary: summariseEvent(event) };
  });
}

export function registerGetToday(mcpServer: McpServer, ddb: DynamoDBClient): void {
  mcpServer.registerTool(
    'get_today',
    {
      title: "Today's events",
      description: "Returns a plain-language summary of today's household events: door activity, presence, and what showed on the television.",
      inputSchema: {},
    },
    withFriendlyErrors(async () => {
      const policy = await loadHouseholdPolicy(ddb, HOUSEHOLD_ID);
      const entries = await loadTodayEvents(ddb, HOUSEHOLD_ID, new Date(), policy);
      return { content: [{ type: 'text' as const, text: JSON.stringify(entries) }] };
    }),
  );
}
