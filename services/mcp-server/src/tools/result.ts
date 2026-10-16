/**
 * What a tool hands back, in the two shapes MCP gives it.
 *
 * `data` is an answer: the object as structured content, for a client that
 * renders it (a card, a list), and the same object as JSON text, for one
 * that only reads text. `say` is a sentence to be told as it stands — a
 * refusal, "not yet", "nothing for that week" (§6.4: a refusal is an
 * answer, not an error) — as text, and as `{ say }` in structured content.
 *
 * Every tool declares what its structured content is (`answerSchema`): its
 * own fields, or `say` alone. MCP requires a tool with an output schema to
 * return structured content on every answer that is not an error, so a
 * sentence carries one too. A failure (`isError`: withFriendlyErrors, or an
 * answer the Guardian withheld) carries none, and is not held to the schema.
 *
 * The annotations tell an assistant what a call can do before it makes it:
 * every read is marked read-only, and the two tools that put something on
 * a television or a roster are marked as writes it should confirm first.
 * None reaches outside the household's own data (openWorldHint: false).
 */
import { z } from 'zod';

export const say = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  structuredContent: { say: text } as { say: string } & Record<string, unknown>,
});

/** The words of a `say` answer, in every tool's output schema. */
const SAY = z.string().describe('A sentence to tell as it stands — a refusal, "not yet", "nothing then". When it is present, nothing else is.');

/**
 * A tool's output schema: `shape` when it answers, or `{ say }` when it has
 * a sentence instead. One object schema (MCP requires `type: "object"`),
 * with every field optional, and the two forms told apart by `anyOf` — so
 * a client's JSON Schema validator checks each form whole — and by the same
 * rule here, where the SDK checks the answer before it is sent. Strict: a
 * field the schema does not name is refused, here and by the client.
 *
 * Built once per process, at module scope, so the parsers Zod compiles for
 * it are reused by every request rather than compiled again for each.
 */
export function answerSchema<S extends z.ZodRawShape>(shape: S) {
  const required = Object.entries(shape)
    .filter(([, field]) => !(field as z.ZodType).safeParse(undefined).success)
    .map(([key]) => key);
  const optional = Object.fromEntries(Object.entries(shape).map(([key, field]) => [key, (field as z.ZodType).optional()])) as unknown as {
    [K in keyof S]: z.ZodOptional<S[K]>;
  };
  return z
    .strictObject({ ...optional, say: SAY.optional() })
    .superRefine((value, check) => {
      const keys = Object.keys(value).filter((key) => (value as Record<string, unknown>)[key] !== undefined);
      if (keys.includes('say')) {
        if (keys.length > 1) check.addIssue({ code: 'custom', message: '`say` comes alone' });
        return;
      }
      for (const key of required) if (!keys.includes(key)) check.addIssue({ code: 'custom', path: [key], message: 'required' });
    })
    .meta({
      anyOf: [
        { required: ['say'], maxProperties: 1 },
        { ...(required.length ? { required } : {}), not: { required: ['say'] } },
      ],
    });
}

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

/** What an answer chosen for the resident's television says once it is shown (`AnswerOutcome`'s first half). */
export const ANSWER_OUTCOME = answerSchema({
  shown: z.literal(true),
  by: z.string().describe('The name the answer is shown under.'),
  text: z.string().describe('The answer, as the television shows it.'),
});

export const READS ={ readOnlyHint: true, openWorldHint: false } as const;
export const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
