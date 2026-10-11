/**
 * What a tool hands back, in the two shapes MCP gives it.
 *
 * `data` is an answer: the object as structured content, for a client that
 * renders it (a card, a list), and the same object as JSON text, for one
 * that only reads text. `say` is a sentence to be told as it stands — a
 * refusal, "not yet", "nothing for that week" — and carries no structure,
 * because there is nothing behind it to render (§6.4: a refusal is an
 * answer, not an error).
 *
 * The annotations tell an assistant what a call can do before it makes it:
 * every read is marked read-only, and the two tools that put something on
 * a television or a roster are marked as writes it should confirm first.
 * None reaches outside the household's own data (openWorldHint: false).
 */
export const say = (text: string) => ({ content: [{ type: 'text' as const, text }] });

export const data = <T extends object>(value: T) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  structuredContent: value as T & Record<string, unknown>,
});

export const READS = { readOnlyHint: true, openWorldHint: false } as const;
export const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
