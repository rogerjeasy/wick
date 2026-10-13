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

/**
 * What became of an answer chosen for the resident's television (the door,
 * a request to ring): it is on the television under `by`'s name, or it is
 * not, and `say` is the sentence that tells the person why — somebody
 * answered first, the card has gone, they were not asked. One outcome for
 * every way in: the MCP tool and a family member's own television
 * (accounts/familyTelevision.ts) both run the same function and word it
 * from this.
 */
export type AnswerOutcome =
  | { readonly shown: true; readonly by: string; readonly text: string }
  | { readonly shown: false; readonly say: string };

export const READS ={ readOnlyHint: true, openWorldHint: false } as const;
export const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
