/**
 * The Sunday brief's fan-out: one queue message per home, one home per
 * worker invocation (infra/brief.tf).
 *
 *   EventBridge (Sunday 20:00 UTC) ─▶ brief-dispatch ─▶ SQS, one message per home with a television
 *   SQS ─▶ brief-worker (batch 1, at most 2 at once) ─▶ AgentCore `brief.weekly`, in that home's session
 *                                                    └─ the Narrator, for that home, if the agents could not
 *
 * It replaces one 900-second Lambda writing every home in turn: a home
 * whose week fails is retried on its own (the queue's redrive, then its
 * dead-letter queue and an alarm), and no home waits for another.
 *
 * Every step may happen twice — EventBridge, SQS and the dispatch's own
 * retry all deliver at least once — and that is safe because brief.weekly
 * is idempotent (runtime/briefHandler.ts).
 *
 * Pure: the Lambdas (dispatchLambda.ts, workerLambda.ts) wire SQS, the
 * runtime and the Narrator in.
 */

export const BRIEF_ORIGINS = ['weekly', 'demo'] as const;
export type BriefOrigin = (typeof BRIEF_ORIGINS)[number];

export interface BriefMessage {
  readonly householdId: string;
  readonly isoWeek: string;
  /**
   * `weekly`: the Sunday run, for a home with a television — the Narrator
   * writes the week if the agents cannot. `demo`: a demo home just made
   * (the Wick server, accounts/demoHome.ts); its simulated week is already
   * there, so there is nothing to fall back to.
   */
  readonly origin: BriefOrigin;
}

const ISO_WEEK = /^\d{4}-W\d{2}$/;

export const briefMessage = (message: BriefMessage): string => JSON.stringify(message);

/** A message's body, read rather than trusted. */
export function readBriefMessage(body: string): BriefMessage | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { householdId, isoWeek, origin } = raw as Record<string, unknown>;
  if (typeof householdId !== 'string' || !householdId || typeof isoWeek !== 'string' || !ISO_WEEK.test(isoWeek)) return undefined;
  if (typeof origin !== 'string' || !(BRIEF_ORIGINS as readonly string[]).includes(origin)) return undefined;
  return { householdId, isoWeek, origin: origin as BriefOrigin };
}

/** SendMessageBatch, narrowed: the ids of the entries that were not queued. */
export type SendBatch = (entries: readonly { readonly Id: string; readonly MessageBody: string }[]) => Promise<{ readonly failed: readonly string[] }>;

/** SQS takes at most ten messages a batch. */
const BATCH = 10;

export async function dispatchWeek(
  isoWeek: string,
  deps: { readonly listHouseholds: () => Promise<readonly string[]>; readonly sendBatch: SendBatch },
): Promise<{ readonly queued: number }> {
  const homes = await deps.listHouseholds();
  let failed = 0;
  for (let i = 0; i < homes.length; i += BATCH) {
    const entries = homes.slice(i, i + BATCH).map((householdId, j) => ({ Id: `home-${i + j}`, MessageBody: briefMessage({ householdId, isoWeek, origin: 'weekly' }) }));
    failed += (await deps.sendBatch(entries)).failed.length;
  }
  // Thrown, so EventBridge runs the dispatch again: a home queued twice is written once (briefHandler.ts).
  if (failed) throw new Error(`brief_dispatch_incomplete: ${failed} of ${homes.length}`);
  return { queued: homes.length };
}

export interface WorkDeps {
  /** The runtime's answer to `brief.weekly` for this home (runtime/invoke.ts); throws when it cannot be reached. */
  readonly invokeBrief: (householdId: string, isoWeek: string) => Promise<unknown>;
  /** The Narrator, for this one home (narrator/lambda.ts narratorDeps). True when it wrote the week. */
  readonly narrate: (householdId: string, isoWeek: string) => Promise<boolean>;
}

export type WorkOutcome = 'written' | 'skipped' | 'not_written' | 'narrated' | 'bad_request';

const log = (line: Record<string, unknown>) => console.log(JSON.stringify(line));

/**
 * One home's week. Done when the agents wrote it or had nothing to write.
 * When they could not write it — the runtime unreachable, or a node failed
 * before anything was stored — the Narrator writes it, so every home with a
 * television has a week on Monday. When the week was stored but her card
 * could not be sent, the message is retried instead: brief.weekly then
 * sends the card again, and the Narrator must not write over the agents'.
 */
export async function workMessage(message: BriefMessage, deps: WorkDeps): Promise<WorkOutcome> {
  let answer: Record<string, unknown> | undefined;
  try {
    const raw = await deps.invokeBrief(message.householdId, message.isoWeek);
    answer = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  } catch (err) {
    if (message.origin === 'demo') throw err;
    log({ level: 'warn', msg: 'brief_runtime_unavailable', isoWeek: message.isoWeek, error: (err as Error).message || String(err) });
  }

  const status = answer?.status;
  if (status === 'written' || status === 'skipped' || status === 'not_written' || status === 'bad_request') return status;
  if (status === 'failed' && answer?.stored === true) throw new Error('brief_card_not_sent');
  if (message.origin === 'demo') throw new Error(`brief_failed: ${String(answer?.error ?? status)}`);

  log({ level: 'warn', msg: 'brief_fell_back_to_narrator', isoWeek: message.isoWeek, error: String(answer?.error ?? 'runtime_unavailable') });
  if (!(await deps.narrate(message.householdId, message.isoWeek))) throw new Error('week_not_written');
  return 'narrated';
}

export interface SqsBatch {
  readonly Records: readonly { readonly messageId: string; readonly body: string }[];
}

/** Partial batch failure reporting: only the messages that failed come back (ReportBatchItemFailures). */
export async function workBatch(
  event: SqsBatch,
  work: (message: BriefMessage) => Promise<WorkOutcome>,
): Promise<{ batchItemFailures: { itemIdentifier: string }[] }> {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    const message = readBriefMessage(record.body);
    if (!message) {
      // Retrying a message nobody can read only fills the dead-letter queue later.
      log({ level: 'error', msg: 'brief_message_unreadable' });
      continue;
    }
    try {
      const outcome = await work(message);
      log({ level: 'info', msg: 'brief_worked', isoWeek: message.isoWeek, origin: message.origin, outcome });
    } catch (err) {
      log({ level: 'error', msg: 'brief_message_failed', isoWeek: message.isoWeek, origin: message.origin, error: (err as Error).message || String(err) });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
