/**
 * MCP tool: make_visit_pass — "Send Doctor Rossi a link."
 *
 * The visit pass (packages/contracts visitPass.ts). An expected stranger and
 * an unknown stranger look the same at her door: the door alone can say who
 * is due, never who has come. So the member who arranged a visit
 * (arrange_visit.ts) is handed a link to forward to the visitor — by
 * WhatsApp, a text, an email — and the visitor, from their own phone, can say
 * three things about that one visit: on my way, running late, I'm at the
 * door. Her television then says who is at the door on a ring around "I'm at
 * the door" (the agent's door/route.ts), and her day says who is on the way.
 *
 * What the link can do is what visitPass.ts lists, inside the visit's hours
 * (it opens three hours before, and is over when the visit's window closes):
 * nothing about the house, nobody named, never "you can open".
 *
 * The token is 128 random bits, shown once, in the answer's link and nowhere
 * else: not on a row, not in a log. The pass row is found by the token's
 * sha-256 (`VPASS#<hash>`), and the errand keeps the hash (`passHash`) so
 * that a new link replaces the old one — the old pass row is deleted in the
 * same transaction, and the old link then answers as a link that is over.
 * The token goes after `#` in the link, so no server's access log holds it
 * either (VISIT_PAGE_PATH).
 *
 * Only the member who arranged the visit, and only while it is still to
 * come. Anyone else — and an id that is nobody's — is told there is no such
 * visit, in the words cancel_errand uses, so nothing is said about another
 * member's errands. The link and the sentence around it are handed back as
 * the member's own words: "Send this link to Doctor Rossi" is theirs to read
 * (errands.ts `toItsAuthor`).
 *
 * The family app's address comes from the server's environment
 * (`FAMILY_APP_URL`, infra/mcp.tf). Without it, the tool says it cannot.
 */
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { TransactWriteItemsCommand, type DynamoDBClient, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { windowEndOf } from '@wick/agent';
import { VISIT_PAGE_PATH, VISIT_PASS_LIMITS, VISIT_PASS_SK, clockTime, errandSk, isErrandOpen, passStateAt, visitPassPk } from '@wick/contracts';
import { gated, type ToolContext } from './context.js';
import { withFriendlyErrors } from './errors.js';
import { answerSchema, data, say } from './result.js';
import { ERRAND_NOT_FOUND_TEXT } from './cancel_errand.js';
import { errandsOf } from './errands.js';
import { theirOwnWords } from '../guardian.js';
import { zoneOf } from '../accounts/types.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';
const DAY_MS = 86_400_000;

export const VISIT_PASS_UNAVAILABLE_TEXT = 'This Wick cannot make links for visitors yet.';
export const VISIT_PASS_OVER_TEXT = 'That visit is over or was called off, so there is no link to make for it.';
export const VISIT_PASS_BUSY_TEXT = 'Another link for that visit was being made at the same moment. Ask me again.';

/**
 * Not read-only; destructive, because a new link stops the one made before
 * from working; and not idempotent, because each call makes a new link. The
 * family app asks the member first.
 */
export const MAKES_PASS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

const OUTPUT = answerSchema({
  link: z.string().describe('The link to send to the visitor. It is shown this once: Wick keeps no copy.'),
  who: z.string().describe('Who it is for, in the words of the member who arranged the visit.'),
  opensAt: z.number().describe('When the link starts to work, epoch ms: three hours before the visit.'),
  closesAt: z.number().describe('When it stops working, epoch ms: when the visit’s window closes.'),
  said: z.string().describe('What to tell the member, in one sentence to tell as it is.'),
});

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const dayInWords = (at: number, timeZone: string): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long', day: 'numeric', month: 'long' }).format(at).replace(',', '');

/** "It works from 7:00 am to 11:00 am on Thursday 22 October", or across midnight with both days. */
function hoursInWords(opensAt: number, closesAt: number, timeZone: string): string {
  const opensOn = dayInWords(opensAt, timeZone);
  const closesOn = dayInWords(closesAt, timeZone);
  return opensOn === closesOn
    ? `from ${clockTime(opensAt, timeZone)} to ${clockTime(closesAt, timeZone)} on ${closesOn}`
    : `from ${clockTime(opensAt, timeZone)} on ${opensOn} to ${clockTime(closesAt, timeZone)} on ${closesOn}`;
}

export function registerMakeVisitPass(
  mcpServer: McpServer,
  ddb: DynamoDBClient,
  ctx: ToolContext,
  /** The family app's origin, where visit.html is. Unset, no link can be made. */
  familyAppUrl: string | undefined = process.env.FAMILY_APP_URL || undefined,
  now: () => number = Date.now,
): void {
  const errands = errandsOf(ddb);
  mcpServer.registerTool(
    'make_visit_pass',
    {
      title: 'Send a link to the visitor',
      description:
        'Makes a link for the visitor of a visit the signed-in family member arranged with arrange_visit (its `errandId`, from arrange_visit or get_errands), ' +
        'for the member to send them by message or email — use it when they want to send the doctor, the nurse or whoever is coming a link, ' +
        'or want the resident’s television to know when that visitor is really at the door. ' +
        'From the link the visitor can say three things, and only these: they are on the way, running late, or at the door; ' +
        'her television then says so, and the member is told. It works from three hours before the visit until its window closes. ' +
        'A new link replaces any link made before for that visit: the old one stops working. ' +
        'Give the member `link` exactly as it is, and `said`. Only the person who arranged the visit can make one.',
      inputSchema: {
        errandId: z.string().max(64).describe('The visit, as arrange_visit or get_errands named it.'),
      },
      outputSchema: OUTPUT,
      annotations: MAKES_PASS,
    },
    withFriendlyErrors(gated(ctx, async (allowed, { errandId }: { errandId: string }) => {
      if (!familyAppUrl) return say(VISIT_PASS_UNAVAILABLE_TEXT);
      const held = await errands.get(ctx.householdId, errandId);
      // Not theirs is no such visit: nothing is said about another member's errands.
      if (!held || held.createdBy !== ctx.userId) return say(ERRAND_NOT_FOUND_TEXT);
      const asked = now();
      if (!isErrandOpen(held.status) || passStateAt(held, asked) === 'over') return say(VISIT_PASS_OVER_TEXT);

      const token = randomBytes(16).toString('hex');
      const hash = sha256(token);
      const closesAt = windowEndOf(held);
      const opensAt = held.at - VISIT_PASS_LIMITS.opensBeforeMs;
      const errandKey = { pk: { S: `HH#${ctx.householdId}` }, sk: { S: errandSk(held.errandId) } };

      const writes: TransactWriteItem[] = [
        {
          // The hash on the errand, only while the errand is still the member's, still to come, and still holds the pass read above.
          Update: {
            TableName: TABLE,
            Key: errandKey,
            UpdateExpression: 'SET passHash = :hash',
            ConditionExpression: `attribute_exists(pk) AND createdBy = :me AND (#s = :planned OR #s = :reminded OR #s = :waiting) AND ${held.passHash ? 'passHash = :was' : 'attribute_not_exists(passHash)'}`,
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: {
              ':hash': { S: hash },
              ':me': { S: ctx.userId },
              ':planned': { S: 'planned' },
              ':reminded': { S: 'reminded' },
              ':waiting': { S: 'waiting' },
              ...(held.passHash ? { ':was': { S: held.passHash } } : {}),
            },
          },
        },
        {
          Put: {
            TableName: TABLE,
            Item: {
              pk: { S: visitPassPk(hash) },
              sk: { S: VISIT_PASS_SK },
              householdId: { S: ctx.householdId },
              errandId: { S: held.errandId },
              presses: { N: '0' },
              ttl: { N: String(Math.floor((closesAt + DAY_MS) / 1000)) },
            },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        // The link made before stops working with this one.
        ...(held.passHash ? [{ Delete: { TableName: TABLE, Key: { pk: { S: visitPassPk(held.passHash) }, sk: { S: VISIT_PASS_SK } } } }] : []),
      ];
      try {
        await ddb.send(new TransactWriteItemsCommand({ TransactItems: writes }));
      } catch (err) {
        if ((err as { name?: string }).name !== 'TransactionCanceledException') throw err;
        // Something moved in between: the visit ended, was called off, or another link was made. Answer for how it stands now.
        const latest = await errands.get(ctx.householdId, errandId);
        if (!latest || !isErrandOpen(latest.status) || passStateAt(latest, asked) === 'over') return say(VISIT_PASS_OVER_TEXT);
        return say(VISIT_PASS_BUSY_TEXT);
      }
      // The errand and whether a link was replaced; never the token, nor its hash.
      console.log(JSON.stringify({ level: 'info', msg: 'visit_pass_made', errandId: held.errandId, replaced: held.passHash !== undefined }));

      const timeZone = zoneOf(allowed.household);
      const link = `${familyAppUrl.replace(/\/+$/, '')}${VISIT_PAGE_PATH}#${token}`;
      const said = `Send this link to ${held.who}. It works ${hoursInWords(opensAt, closesAt, timeZone)}, and lets them say they are on the way, running late, or at the door — nothing else.`;
      // The member's own words, and the link made for them, handed back to the member who arranged the visit (checked above).
      return theirOwnWords(data({ link, who: held.who, opensAt, closesAt, said }), [link, held.who, said]);
    })),
  );
}
