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
 */
import type { Access } from '../accounts/circle.js';

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
}

export type Allowed = Extract<Access, { ok: true }>;

/** A type alias, not an interface: the SDK's tool result has an index signature, which an interface cannot satisfy. */
type Refusal = { content: [{ type: 'text'; text: string }] };

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
  options: { readonly looksIn?: boolean } = {},
): (...args: Args) => Promise<R | Refusal> {
  return async (...args: Args) => {
    const access = await ctx.access();
    if (!access.ok) return { content: [{ type: 'text' as const, text: access.say }] };
    if (options.looksIn && ctx.lookedIn) {
      // Never the reason an answer fails: the question is answered whether or not the look was noted.
      await ctx.lookedIn(access).catch((err: unknown) => console.error(JSON.stringify({ level: 'error', msg: 'look_not_noted', err: err instanceof Error ? err.name : 'unknown' })));
    }
    return handler(access, ...args);
  };
}
