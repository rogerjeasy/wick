/**
 * The errand Lambdas' composition roots (infra/errands.tf):
 *
 *   errand-step   invoked by the errand state machine, one action at a time (step.ts)
 *   errand-door   invoked by the EventBridge rule on door.rang (door.ts)
 *
 * Composition, not logic, so it is left untested in the same way the door
 * Lambda's handler is: what decides anything is in step.ts and door.ts,
 * with every client injected.
 *
 * What reaches her television goes through egress.ts sendToDevice, and what
 * reaches a family member's browser through egress.ts nudgeFamily (INV-2).
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SFNClient, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import { DEFAULT_POLICY } from '@wick/policy';
import { nudgeFamily, sendToDevice } from '../../egress.js';
import { errandStore, type ErrandSend } from '../../store/errands.js';
import { memberAllowed, type AllowedSend } from './allowed.js';
import { handleDoorRang } from './door.js';
import { handleErrandStep } from './step.js';
import { loadHouseholdTimeZone } from '../../store/household.js';

const ddb = new DynamoDBClient({});
const sfn = new SFNClient({});
const TABLE = process.env.TABLE_NAME ?? '';

const errands = errandStore((command) => ddb.send(command as never) as ReturnType<ErrandSend>, TABLE);
const handBack = async (taskToken: string, output: object): Promise<void> => {
  await sfn.send(new SendTaskSuccessCommand({ taskToken, output: JSON.stringify(output) }));
};

/** errand-step: one state of the machine. What it answers is the state's result. */
export const stepHandler = (event: unknown): Promise<Record<string, unknown>> =>
  handleErrandStep(event, {
    errands,
    isAllowed: memberAllowed((command) => ddb.send(command as never) as ReturnType<AllowedSend>, TABLE),
    sendCard: (card) => sendToDevice(card, DEFAULT_POLICY),
    nudge: async (userIds, kind) => void (await nudgeFamily(userIds, kind)),
    handBack,
    // Where "this morning at ten" is this morning at ten: each home's own clock.
    timeZoneOf: (householdId) => loadHouseholdTimeZone(ddb, TABLE, householdId),
    now: Date.now,
  });

/** errand-door: a door.rang event from the bus. */
export const doorHandler = async (event: { readonly detail?: unknown }): Promise<void> => {
  await handleDoorRang(event.detail, { errands, handBack });
};
