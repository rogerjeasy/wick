/**
 * brief-dispatch — the Sunday rule's target (infra/brief.tf): one SQS
 * message per home with a television, for the week that is ending
 * (fanout.ts dispatchWeek). Thin wiring; what it decides is tested in
 * fanout.ts and loaders.ts.
 *
 * A dispatch that could not queue every home throws, and EventBridge runs it
 * again: a home queued twice has its week written once.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { currentIsoWeek } from '@wick/contracts';
import { dispatchWeek } from './fanout.js';
import { scanHouseholdsWithTelevision, type PagedSend } from './loaders.js';

const ddb = new DynamoDBClient({});
const sqs = new SQSClient({});
const TABLE = process.env.TABLE_NAME ?? '';
const QUEUE_URL = process.env.BRIEF_QUEUE_URL ?? '';
const paged: PagedSend = (cmd) => ddb.send(cmd as never) as ReturnType<PagedSend>;

export const handler = async (): Promise<void> => {
  if (!QUEUE_URL) throw new Error('BRIEF_QUEUE_URL not set');
  const isoWeek = currentIsoWeek(new Date());
  const { queued } = await dispatchWeek(isoWeek, {
    listHouseholds: () => scanHouseholdsWithTelevision(paged, TABLE),
    sendBatch: async (entries) => {
      const res = await sqs.send(new SendMessageBatchCommand({ QueueUrl: QUEUE_URL, Entries: [...entries] }));
      return { failed: (res.Failed ?? []).map((f) => f.Id ?? '') };
    },
  });
  // Counts only: which homes is nobody's business in a log.
  console.log(JSON.stringify({ level: 'info', msg: 'brief_dispatched', isoWeek, queued }));
};
