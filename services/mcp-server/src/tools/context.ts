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
): (...args: Args) => Promise<R | Refusal> {
  return async (...args: Args) => {
    const access = await ctx.access();
    if (!access.ok) return { content: [{ type: 'text' as const, text: access.say }] };
    return handler(access, ...args);
  };
}
