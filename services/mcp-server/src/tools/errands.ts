/**
 * What the three errand tools share (arrange_visit, get_errands,
 * cancel_errand): the state machine they start and stop, the table, and an
 * errand as the family is shown it.
 *
 * An errand is shown to the member who arranged it, and the words are
 * honest about what Wick can know. The door knows that somebody rang, and
 * when; it does not know who. So a ring inside the window is told as
 * "Someone rang at 10:04 am, around when the plumber was expected" — never
 * "the plumber came". Nothing the operator keeps — the execution, the
 * door's token — is ever in it.
 */
import { z } from 'zod';
import { SFNClient, StartExecutionCommand, StopExecutionCommand } from '@aws-sdk/client-sfn';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { errandStore, windowEndOf, type ErrandExecutionInput, type ErrandSend, type ErrandStore, type HeldErrand } from '@wick/agent';
import { ERRAND_STATUSES, clockTime } from '@wick/contracts';

const TABLE = process.env.TABLE_NAME ?? 'wick';

export const ERRANDS_UNAVAILABLE_TEXT = 'This Wick cannot arrange visits yet.';
export const ARRANGE_BAD_WHO_TEXT = 'I need who is coming, in a few words, like the plumber.';
/**
 * Who is coming, in words the Guardian cannot clear: a role ("the nurse"),
 * or letters it cannot read. The member's own word, so they are told
 * plainly why — the errand's words are read back to them and on the door
 * card, and a clinical role is a fact about her health (INV-4).
 */
export const ARRANGE_WHO_NOT_SHARED_TEXT =
  'I need another word for who is coming, like the plumber or Dave: not a title or what they come for, because what you call them is read back by Wick.';
export const ARRANGE_TOO_SOON_TEXT = 'That is too soon for the door to be told. Give me a time at least two minutes from now.';
export const ARRANGE_TOO_MANY_TEXT = 'There are already ten visits arranged and still to come, which is as many as Wick carries at once.';

/** Starts and stops the errand state machine (infra/errands.tf). Injected, so the tools are tested without AWS. */
export interface ErrandMachine {
  /** Starts the execution named `name`; answers with its ARN. The same name twice is the same execution. */
  start(name: string, input: ErrandExecutionInput): Promise<string>;
  stop(executionArn: string): Promise<void>;
}

/** The ARN Step Functions gives an execution of `stateMachineArn` named `name`. */
export const executionArnOf = (stateMachineArn: string, name: string): string =>
  `${stateMachineArn.replace(':stateMachine:', ':execution:')}:${name}`;

/**
 * The real machine. A second start with the same name and input is answered
 * with the first execution by Step Functions itself; one that finds an
 * execution of that name already there (a retry after a timeout, with the
 * seconds to wait counted again) is the same errand, so its ARN is the answer.
 */
export function sfnErrandMachine(client: Pick<SFNClient, 'send'>, stateMachineArn: string): ErrandMachine {
  return {
    async start(name, input) {
      try {
        const res = await client.send(new StartExecutionCommand({ stateMachineArn, name, input: JSON.stringify(input) }));
        return res.executionArn ?? executionArnOf(stateMachineArn, name);
      } catch (err) {
        if ((err as { name?: string }).name === 'ExecutionAlreadyExists') return executionArnOf(stateMachineArn, name);
        throw err;
      }
    },
    async stop(executionArn) {
      try {
        await client.send(new StopExecutionCommand({ executionArn, cause: 'The member who arranged the visit called it off.' }));
      } catch (err) {
        // Already over: there is nothing left to stop.
        if ((err as { name?: string }).name !== 'ExecutionDoesNotExist') throw err;
      }
    },
  };
}

/** The machine of this deployment, or none where ERRAND_STATE_MACHINE_ARN is not set (a laptop, a test server). */
export function errandMachineFromEnv(env: NodeJS.ProcessEnv = process.env): ErrandMachine | undefined {
  const arn = env.ERRAND_STATE_MACHINE_ARN;
  return arn ? sfnErrandMachine(new SFNClient({}), arn) : undefined;
}

export const errandsOf = (ddb: DynamoDBClient): ErrandStore => errandStore((command) => ddb.send(command as never) as ReturnType<ErrandSend>, TABLE);

const longDay = (at: number, timeZone: string): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long', day: 'numeric', month: 'long' }).format(at).replace(',', '');
const sameDay = (a: number, b: number, timeZone: string): boolean => {
  const day = (at: number) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  return day(a) === day(b);
};

/** "Thursday 15 October at 10:00 am", where the house is. */
export const whenInWords = (at: number, timeZone: string): string => `${longDay(at, timeZone)} at ${clockTime(at, timeZone)}`;

/** One sentence saying how the errand stands — what the door saw, never who it was. */
export function errandSentence(errand: HeldErrand, residentName: string, timeZone: string): string {
  const when = whenInWords(errand.at, timeZone);
  switch (errand.status) {
    case 'planned':
    case 'reminded':
    case 'waiting':
      return errand.remindedAt === undefined && errand.status !== 'reminded'
        ? `The door knows to expect ${errand.who} on ${when}.`
        : `${residentName} has been reminded that ${errand.who} is coming on ${when}.`;
    case 'rang': {
      const rangAt = errand.rangAt ?? errand.at;
      const day = sameDay(rangAt, errand.at, timeZone) ? '' : ` on ${longDay(rangAt, timeZone)}`;
      return `Someone rang at ${clockTime(rangAt, timeZone)}${day}, around when ${errand.who} was expected.`;
    }
    case 'no_show': {
      const half = errand.windowMinutes * 60_000;
      return `Nobody rang between ${clockTime(errand.at - half, timeZone)} and ${clockTime(errand.at + half, timeZone)}, when ${errand.who} was expected.`;
    }
    case 'cancelled':
      return `The visit from ${errand.who} on ${when} was called off.`;
    case 'failed':
      return `Wick could not carry this visit through, so the door may not be expecting ${errand.who}.`;
  }
}

export interface ErrandView {
  readonly errandId: string;
  readonly who: string;
  readonly at: number;
  readonly when: string;
  readonly windowMinutes: number;
  readonly remindAt?: number;
  readonly reminded: boolean;
  readonly tellMe: boolean;
  readonly status: HeldErrand['status'];
  readonly rangAt?: number;
  readonly said: string;
}

/** An errand as its author is shown it: named fields only, so nothing the operator keeps can slip in. */
export function errandView(errand: HeldErrand, residentName: string, timeZone: string): ErrandView {
  return {
    errandId: errand.errandId,
    who: errand.who,
    at: errand.at,
    when: whenInWords(errand.at, timeZone),
    windowMinutes: errand.windowMinutes,
    ...(errand.remindAt === undefined ? {} : { remindAt: errand.remindAt }),
    reminded: errand.remindedAt !== undefined || errand.status === 'reminded',
    tellMe: errand.tellMe,
    status: errand.status,
    ...(errand.rangAt === undefined ? {} : { rangAt: errand.rangAt }),
    said: errandSentence(errand, residentName, timeZone),
  };
}

/** Over, and not to be shown after a week: the window has passed, whatever came of it. */
export const isOverBefore = (errand: HeldErrand, since: number): boolean => windowEndOf(errand) < since;

/** An errand in the tools' structured content (result.ts `answerSchema`). */
export const ERRAND_VIEW = z.strictObject({
  errandId: z.string().describe('What cancel_errand takes.'),
  who: z.string().describe('Who is coming, in the words of the member who arranged it.'),
  at: z.number().describe('The expected moment, epoch ms.'),
  when: z.string().describe('The expected moment in words, in the household’s time.'),
  windowMinutes: z.number().describe('A ring this many minutes either side counts.'),
  remindAt: z.number().optional().describe('When the resident is reminded; absent when no reminder was chosen.'),
  reminded: z.boolean().describe('Whether the reminder has been put on her television.'),
  tellMe: z.boolean().describe('Whether the member is told, by a notification, how it went.'),
  status: z.enum(ERRAND_STATUSES).describe('planned, reminded, waiting (the door is watching), rang, no_show, cancelled or failed.'),
  rangAt: z.number().optional().describe('When the doorbell rang inside the window. Somebody rang: the door cannot say who.'),
  said: z.string().describe('How it stands, in one sentence to tell as it is.'),
});
