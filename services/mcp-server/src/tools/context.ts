/**
 * Who a tool call is for, and whether the resident has allowed them.
 *
 * INV-8: `householdId` is the household the caller's token was approved
 * for (accounts/oauthProvider.ts). No tool takes one as an argument, reads
 * one from the environment, or can be asked about another.
 *
 * INV-9: `gated` asks, on every call, whether the resident has allowed this
 * person. Not once per session: the resident's press on the television
 * must count on the very next question, and so must a removal. It costs
 * two GetItems, well inside the 500ms round trip (§9.3).
 *
 * And `gated` is where a neighbour's narrower part is kept (packages/
 * contracts circle.ts). A neighbour is asked two things — to look at who is
 * at the door, and to ring when asked — and is shown nothing else about the
 * house. So a tool runs for a neighbour only when it says it is one of
 * those (`neighbour: true`); every other tool, and every tool written
 * later, refuses a neighbour without having to remember to.
 */
import type { Access } from '../accounts/circle.js';
import { timed, type PhaseTimer } from '../timing.js';
import { say } from './result.js';

export interface ToolContext {
  readonly householdId: string;
  readonly userId: string;
  access(): Promise<Access>;
  /**
   * Notes that this person asked after the resident, so the resident's own
   * home screen can say who looked in (tools/lookIn.ts). Absent, nothing is
   * noted.
   */
  lookedIn?(allowed: Extract<Access, { ok: true }>): Promise<void>;
  /** This request's timing (timing.ts): the gate and the handler are timed here. Absent, nothing is. */
  readonly timing?: PhaseTimer;
  /**
   * The household's own people, by name: its regular visitors and the
   * members of its circle. The gate sets them aside before it reads an
   * answer it would otherwise withhold, so a surname is not taken for a fact
   * ("Anna Cash"; guardian.ts guardTools). Absent, nobody is.
   */
  people?(): Promise<readonly string[]>;
}

export type Allowed = Extract<Access, { ok: true }>;

/** A refusal is told as any sentence is (result.ts `say`): as text, and as `{ say }` in structured content. */
type Refusal = ReturnType<typeof say>;

/** What a neighbour is told by any tool that is not theirs: what they are for, and that there is nothing more. */
export const neighbourRefusal = (residentName: string): string =>
  `${residentName} has asked you to help in two ways: to look at who is at the door, and to ring when asked. Nothing else about the house is shared with a neighbour.`;

/**
 * Runs a tool only for someone the resident has allowed. Anyone else gets
 * the refusal as an ordinary answer, in words they can be told as they
 * stand — a refusal is a feature, not an error (§6.4).
 */
export function gated<Args extends unknown[], R>(
  ctx: ToolContext,
  handler: (allowed: Allowed, ...args: Args) => Promise<R>,
  /**
   * `looksIn`: this tool asks after the resident — how the day or the week
   * has been, whether the light is on — and asking is something the
   * resident is told (the light in the window, packages/contracts light.ts).
   * Not for a tool the app calls by itself to keep a card up to date.
   */
  options: {
    readonly looksIn?: boolean;
    /** This tool is one a neighbour may use: the door, and being asked to ring. Absent, a neighbour is refused. */
    readonly neighbour?: boolean;
  } = {},
): (...args: Args) => Promise<R | Refusal> {
  return async (...args: Args) => {
    const access = await timed(ctx.timing, 'gate', () => ctx.access());
    if (!access.ok) return say(access.say);
    if (access.membership.role === 'neighbour' && !options.neighbour) return say(neighbourRefusal(access.household.residentName));
    if (options.looksIn && ctx.lookedIn) {
      // Never the reason an answer fails: the question is answered whether or not the look was noted.
      const lookedIn = ctx.lookedIn;
      await timed(ctx.timing, 'gate', () => lookedIn(access)).catch((err: unknown) => console.error(JSON.stringify({ level: 'error', msg: 'look_not_noted', err: err instanceof Error ? err.name : 'unknown' })));
    }
    return timed(ctx.timing, 'handler', () => handler(access, ...args));
  };
}
