/**
 * MCP tool: get_pictures — "has Mum seen the picture I sent?"
 *
 * The mantelpiece (packages/contracts mantel.ts), as far as the family is
 * told of it. A member sends a picture from the family app (photos/send.ts:
 * a picture is a file, and no tool takes one). This says how the member's
 * own pictures of the last week stand: each is waiting on her television,
 * or she has seen it.
 *
 * And that is all there is to say. Whether she kept a picture, only
 * thanked them for it, or took it down a week later is hers alone: this
 * reads the pictures' own rows and nothing else, and those rows say only
 * that one was seen — so the three look exactly the same from here, and an
 * assistant cannot be asked into telling them apart.
 *
 * One Query and no model call, inside Alexa+'s 500ms budget (§9.3). It
 * gives no picture's id and no address: there is nothing an assistant
 * could do with either. Not for a neighbour, who sends nothing.
 */
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { photoSeenText } from '@wick/contracts';
import { loadSentPictures } from '../photos/pictures.js';
import { gated, type ToolContext } from './context.js';
import { withFriendlyErrors } from './errors.js';
import { answerSchema, READS, data, say } from './result.js';
import { z } from 'zod';
import { HOUSEHOLD_TZ, whenInWords } from './watchSession.js';

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const inWords = (n: number): string => NUMBER_WORDS[n] ?? String(n);

/** The one sentence that answers the question, for however many pictures there are. */
function summaryOf(sent: number, seen: number, resident: string): string {
  if (sent === 1) return seen === 1 ? photoSeenText(resident) : `Your picture is waiting on ${resident}’s television.`;
  const lead = `You have sent ${resident} ${inWords(sent)} pictures this week.`;
  if (seen === 0) return `${lead} They are waiting on ${resident}’s television.`;
  return `${lead} ${resident} has seen ${seen === sent ? 'all' : inWords(seen)} of them.`;
}

/** What this tool's structured content is (result.ts `answerSchema`): built once, for every request. */
const OUTPUT = answerSchema({
  summary: z.string(),
  pictures: z.array(z.strictObject({ sent: z.string(), sentAt: z.number(), seen: z.boolean(), say: z.string() })).describe('Newest first.'),
});

export function registerGetPictures(mcpServer: McpServer, ddb: DynamoDBClient, ctx: ToolContext, now: () => number = Date.now, timeZone: string = HOUSEHOLD_TZ): void {
  mcpServer.registerTool(
    'get_pictures',
    {
      title: 'Pictures sent to the television',
      description:
        "Returns the pictures the person asking has sent to the household television in the last week, newest first, each either waiting on the television or one the resident has seen. " +
        'Use it for "has Mum seen my picture" or "did she get the photo". Say `summary` as it stands. ' +
        'It says only whether a picture has been seen: nobody is told whether the resident kept it, and that must never be said or guessed. ' +
        'A picture is sent from the Wick app itself, not through a tool.',
      inputSchema: {},
      outputSchema: OUTPUT,
      annotations: READS,
    },
    withFriendlyErrors(gated(ctx, async (allowed) => {
      const resident = allowed.household.residentName;
      const pictures = await loadSentPictures(ddb, ctx, resident, now());
      if (pictures.length === 0) return say(`You have not sent a picture to ${resident}’s television this week.`);
      return data({
        summary: summaryOf(pictures.length, pictures.filter((picture) => picture.seen).length, resident),
        pictures: pictures.map((picture) => ({ sent: whenInWords(picture.sentAt, timeZone), sentAt: picture.sentAt, seen: picture.seen, say: picture.say })),
      });
    })),
  );
}
