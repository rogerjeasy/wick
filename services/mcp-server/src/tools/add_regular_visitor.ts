/**
 * MCP tool: add_regular_visitor — "Maria comes on Tuesdays and Fridays at nine."
 *
 * M4. The roster is what lets the door say "this looks like Maria" and what
 * Something's Different measures a missed visit against — and until now the
 * only way onto it was a row written into the table by hand. This is the
 * way in for the family: a name, the days, a time.
 *
 * It is still a schedule and nothing more (docs/WICK.md §5.1 M4): no face, no
 * photograph, no description of the person. Saying it again for the same
 * name changes that visitor's days and time; it never makes a second Maria.
 *
 * And a name is only a name. "Dr Patel GP" on the roster would tell the
 * whole family, every time the door or the week named the visitor, that a
 * doctor comes — a fact about her health (INV-4). So a name passes the
 * Guardian before it is kept, and one it cannot clear is refused in words.
 *
 * Who visits, by name, is the PRESENCE class. A resident who keeps that
 * from the family is not having it curated by them either: the tool
 * refuses, exactly as list_regular_visitors does.
 *
 * The time is given in the household's own clock and stored as it was
 * given: the door agent reads every pattern on the household's clock
 * (services/agent/src/agents/door/roster.ts), so nine o'clock stays nine
 * o'clock when the clocks change (issue #84).
 *
 * The door's "this looks like Maria" is only a schedule, and this tool is
 * how a schedule gets written — so what it writes is kept narrow:
 *
 *   - It stands on the word of the member who added it, and only while the
 *     resident still allows that member (`addedBy`, door/roster.ts
 *     stillWelcome): take someone out of the circle and the visitors they
 *     vouched for leave the roster with them.
 *   - Two visitors cannot be expected at the same time. The door agent
 *     takes the first entry that fits, so an overlapping one would speak
 *     over the visitor already there — or be spoken over.
 *   - Half an hour either side, and a dozen entries: a roster cannot be
 *     made to say "looks like someone" about every caller.
 *   - A visitor is changed only by the member who added them. Somebody
 *     else's entry — another member's, or one the household's operator
 *     made — is not this caller's to rewrite or take over.
 *
 * Those rules are checked against every entry the table really holds, and
 * then written as one transaction in which each thing the checks relied on
 * is checked again:
 *
 *   - the roster's version, which every write here bumps — so two people
 *     adding at once cannot both pass a check the other has just made
 *     untrue;
 *   - the row being written: created only if it is still not there,
 *     replaced only if it is still exactly the entry that was read — so a
 *     row somebody else made in between, by any route, is never written
 *     over;
 *   - each entry being cleared away, and that its author is still not
 *     allowed. An entry whose author the resident no longer allows is not
 *     on the roster and counts for nothing, and is cleared by the same
 *     write so that it cannot come back later on top of someone added
 *     since; but if the resident let that person back in a moment ago, it
 *     is theirs again and the whole write is refused.
 *
 * The caller's own standing is not re-checked at the write. It does not
 * need to be: an entry stands only while its author is allowed, so one
 * written in the instant after its author was removed is never on the
 * roster at all.
 */
import { z } from 'zod';
import { GetItemCommand, QueryCommand, TransactWriteItemsCommand, type DynamoDBClient, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { personIdFor, type RosterEntry } from '@wick/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { withFriendlyErrors } from './errors.js';
import { FAMILY_REFUSAL_TEXT, isSharedWithFamily, loadHouseholdPolicy } from './get_resident_shared_view.js';
import { parsePattern, stillWelcome } from '@wick/agent';
import { describePattern } from './list_regular_visitors.js';
import { answerSchema, WRITES, data, say } from './result.js';
import { familyName } from '../guardian.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';

/** A ring this long either side of the usual time still looks like them. */
export const REGULAR_WINDOW_MIN = 30;
/** A roster is a handful of people the resident knows, not a contact list. */
export const MAX_REGULAR_VISITORS = 12;

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const DAY_CODES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
type DayName = (typeof DAY_NAMES)[number];

export const VISITOR_BAD_NAME_TEXT = 'I need the name they go by, in a word or two, like Maria.';
/**
 * A name the Guardian cannot clear: a role ("Dr Patel", "the nurse", or the
 * word for one in another script), or letters it cannot read (a word that mixes
 * scripts, an invisible character, an emoji). It is the family member's own word, so they are
 * told plainly why — the roster's names are read back to everyone in the
 * family, and a clinical role is a fact about her health (INV-4).
 */
export const VISITOR_NAME_NOT_SHARED_TEXT =
  'I need just the name they go by, like Maria: not a title or what they come for. Names on the roster are read back to the whole family.';
export const VISITOR_BAD_TIME_TEXT = 'I need the time they usually come, like nine in the morning.';
export const VISITOR_TOO_MANY_TEXT = 'There are already twelve regular visitors, which is as many as the door keeps.';
export const VISITOR_CHANGED_MEANWHILE_TEXT = 'The roster was changed by someone else just now. Ask me again.';

/** The roster's version: bumped by every write here, so a check and its write are one step. */
export const ROSTER_VERSION_SK = 'ROSTER#VERSION';
/** Entries cleared away in one write. Far more than a household's roster ever leaves behind. */
const MAX_CLEARED = 20;

/** A name as a person would say it: letters, and the marks names have. One to forty characters. */
export function visitorName(raw: string): string | undefined {
  const name = raw.trim().replace(/\s+/g, ' ');
  return /^[\p{L}][\p{L}\p{M}' .-]{0,39}$/u.test(name) ? name : undefined;
}

/**
 * The roster's key for a name: "Maria" is "maria", "Mary-Jo O'Neil" is
 * "mary-jo-o-neil", "Мария" is "u-" and a fingerprint (contracts person.ts,
 * which the Guardian reads too).
 */
export { personIdFor };

/**
 * The pattern the door agent reads: "TUE,FRI 09:00±30m", on the household's
 * own clock, as the time was given. `time` is HH:MM.
 */
export function regularPattern(days: readonly DayName[], time: string): string | undefined {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return undefined;
  const codes = [...new Set(days.map((d) => DAY_NAMES.indexOf(d)))]
    // Monday first, as a week is said.
    .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
    .map((i) => DAY_CODES[i]!);
  return `${codes.join(',')} ${time}±${REGULAR_WINDOW_MIN}m`;
}

const WEEKDAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'] as const;

/**
 * The visitor already expected at a time this pattern would also claim, and
 * the day they collide on — or nothing. Two windows collide when they share
 * a day and overlap at all.
 */
export function collidesWith(pattern: string, others: readonly RosterEntry[]): { readonly name: string; readonly day: string } | undefined {
  const mine = parsePattern(pattern);
  if (!mine) return undefined;
  for (const other of others) {
    const theirs = parsePattern(other.expectedPattern);
    if (!theirs) continue;
    const day = mine.days.find((d) => theirs.days.includes(d));
    if (day === undefined) continue;
    if (Math.abs(mine.minuteOfDay - theirs.minuteOfDay) <= mine.windowMin + theirs.windowMin) return { name: other.name, day: WEEKDAYS[day]! };
  }
  return undefined;
}

interface Regulars {
  /** On the roster: an operator's entries, and those whose author the resident still allows. */
  readonly live: readonly RosterEntry[];
  /** Still in the table, but not on the roster: their author is no longer allowed. */
  readonly dead: readonly RosterEntry[];
  /** Each entry exactly as stored, by personId — what a write is conditioned on. */
  readonly stored: ReadonlyMap<string, string>;
  readonly version: number;
}

/** Every regular visitor the table holds for the household, live or not, and the roster's version. */
async function loadRegulars(ddb: DynamoDBClient, householdId: string): Promise<Regulars> {
  const pk = { S: `HH#${householdId}` };
  const rows = (prefix: string) => ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':pk': pk, ':prefix': { S: prefix } },
  }));
  const [people, members, versionRow] = await Promise.all([
    rows('PER#'),
    rows('MEM#'),
    ddb.send(new GetItemCommand({ TableName: TABLE, Key: { pk, sk: { S: ROSTER_VERSION_SK } }, ConsistentRead: true })),
  ]);
  const stored = new Map<string, string>();
  const all: RosterEntry[] = [];
  for (const item of people.Items ?? []) {
    if (!item.data?.S) continue;
    const entry = JSON.parse(item.data.S) as RosterEntry;
    if (entry.expectedOnce) continue;
    all.push(entry);
    stored.set(entry.personId, item.data.S);
  }
  const live = stillWelcome(all, members.Items ?? []);
  return { live, dead: all.filter((p) => !live.includes(p)), stored, version: Number(versionRow.Item?.version?.N ?? 0) };
}

export interface RegularVisitorAnswer {
  readonly added: true;
  /** True when this name was already on the roster and its days or time were changed. */
  readonly changed: boolean;
  readonly personId: string;
  readonly name: string;
  /** "Tuesday and Friday mornings". */
  readonly usualDays: string;
}

/** What this tool's structured content is (result.ts `answerSchema`): built once, for every request. */
const OUTPUT = answerSchema({
  added: z.literal(true),
  changed: z.boolean().describe('True when an entry this person added before was changed.'),
  personId: z.string(),
  name: z.string(),
  usualDays: z.string(),
});

export function registerAddRegularVisitor(
  mcpServer: McpServer,
  ddb: DynamoDBClient,
  ctx: ToolContext,
  now: () => Date = () => new Date(),
): void {
  mcpServer.registerTool(
    'add_regular_visitor',
    {
      title: 'Add a regular visitor',
      description:
        'Puts someone who visits regularly on the household’s roster: the name they go by, the days they come and the time (the household’s local time). ' +
        'From then on, when the doorbell rings around that time on one of those days the resident’s television says who it looks like, and a visit that does not happen can be noticed. ' +
        'Saying it again for the same name changes that visitor’s days and time. It is a schedule only: never ask for or pass a description of the person.',
      inputSchema: {
        name: z.string().describe('The name the visitor goes by, e.g. "Maria".'),
        days: z.array(z.enum(DAY_NAMES)).min(1).max(7).describe('The days of the week they usually come, e.g. ["tuesday","friday"].'),
        time: z.string().describe('The time they usually come, in 24-hour HH:MM, in the household’s local time.'),
      },
      outputSchema: OUTPUT,
      annotations: WRITES,
    },
    withFriendlyErrors(gated(ctx, async (_allowed, asked: { name: string; days: DayName[]; time: string }) => {
      if (!isSharedWithFamily('PRESENCE', await loadHouseholdPolicy(ddb, ctx.householdId))) return say(FAMILY_REFUSAL_TEXT);

      const name = visitorName(asked.name);
      const personId = name ? personIdFor(name) : '';
      // `member-…` is how an announced visit is filed (contracts memberPersonId): never a name's key.
      if (!name || !personId || personId.startsWith('member-')) return say(VISITOR_BAD_NAME_TEXT);
      // INV-4: a name is read back to the family by every visitor tool, so it is cleared here, once, before it is kept.
      if (!familyName(name, 'visitor.name')) return say(VISITOR_NAME_NOT_SHARED_TEXT);
      const expectedPattern = regularPattern(asked.days, asked.time);
      if (!expectedPattern) return say(VISITOR_BAD_TIME_TEXT);

      const { live, dead, stored, version } = await loadRegulars(ddb, ctx.householdId);
      const existing = live.find((p) => p.personId === personId);
      // Somebody else's entry — another member's, or the operator's — is not this caller's to rewrite.
      if (existing && existing.addedBy !== ctx.userId) {
        return say(`${existing.name} is already on the roster, and was not added by you. Only whoever added ${existing.name} can change those days.`);
      }
      if (!existing && live.length >= MAX_REGULAR_VISITORS) return say(VISITOR_TOO_MANY_TEXT);
      const taken = collidesWith(expectedPattern, live.filter((p) => p.personId !== personId));
      if (taken) {
        return say(`${taken.name} is already expected around then on ${taken.day}. The door can only expect one person at a time: give another time, or change ${taken.name}’s first.`);
      }

      const pk = { S: `HH#${ctx.householdId}` };
      const entry: RosterEntry = { personId, name, expectedPattern, addedBy: ctx.userId };
      const cleared = dead.filter((p) => p.personId !== personId).slice(0, MAX_CLEARED);
      /** The row as it was read, or that there was none: the write holds only if that is still so. */
      const unchanged = (id: string) => {
        const seen = stored.get(id);
        return seen === undefined
          ? { ConditionExpression: 'attribute_not_exists(pk)' }
          : { ConditionExpression: '#d = :seen', ExpressionAttributeNames: { '#d': 'data' }, ExpressionAttributeValues: { ':seen': { S: seen } } };
      };
      // Whoever's entries are being cleared, or written over, as no longer allowed.
      const gone = new Set(dead.filter((p) => p.personId === personId || cleared.includes(p)).flatMap((p) => (p.addedBy ? [p.addedBy] : [])));
      const writes: TransactWriteItem[] = [
        {
          // The guard: this write happens only if nobody else has written here since the roster was read.
          Update: {
            TableName: TABLE,
            Key: { pk, sk: { S: ROSTER_VERSION_SK } },
            UpdateExpression: 'SET version = :next',
            ConditionExpression: version === 0 ? 'attribute_not_exists(version)' : 'version = :seen',
            ExpressionAttributeValues: {
              ':next': { N: String(version + 1) },
              ...(version === 0 ? {} : { ':seen': { N: String(version) } }),
            },
          },
        },
        {
          Put: {
            TableName: TABLE,
            Item: { pk, sk: { S: `PER#${personId}` }, data: { S: JSON.stringify(entry) }, addedAt: { N: String(now().getTime()) } },
            ...unchanged(personId),
          },
        },
        ...cleared.map((p) => ({ Delete: { TableName: TABLE, Key: { pk, sk: { S: `PER#${p.personId}` } }, ...unchanged(p.personId) } })),
        ...[...gone].map((userId) => ({
          ConditionCheck: {
            TableName: TABLE,
            Key: { pk, sk: { S: `MEM#${userId}` } },
            ConditionExpression: 'attribute_not_exists(pk) OR #s <> :allowed',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':allowed': { S: 'allowed' } },
          },
        })),
      ];
      try {
        await ddb.send(new TransactWriteItemsCommand({ TransactItems: writes }));
      } catch (err) {
        if ((err as { name?: string }).name === 'TransactionCanceledException') return say(VISITOR_CHANGED_MEANWHILE_TEXT);
        throw err;
      }

      const answer: RegularVisitorAnswer = {
        added: true,
        changed: existing !== undefined,
        personId,
        name,
        usualDays: describePattern(expectedPattern) ?? '',
      };
      return data(answer);
    })),
  );
}
