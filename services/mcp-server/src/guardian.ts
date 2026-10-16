/**
 * The family read boundary: the Guardian's content gate, at the one place
 * every family-bound string leaves this server.
 *
 * The family is never sent words. They read — through the MCP tools, and
 * through their own television's routes (accounts/familyTelevision.ts) —
 * and the family app's assistant says only what those tools returned
 * (assistant/brain.ts). So the gate stands at those reads:
 *
 *   - `guardTools` wraps the MCP server every tool is registered on
 *     (server.ts). Each tool's answer, whatever helper built it, is read
 *     string by string before it is returned. A tool written later is
 *     behind the gate by being registered; there is no other way to
 *     register one (`server.tool` is refused).
 *   - `guardTelevision` does the same for every route of a family member's
 *     own television.
 *   - `familyText` is the gate one field at a time, for the free text Wick
 *     knows it hands out — the door's sentence, the week's paragraph, a
 *     visitor's name — so that what is withheld is withheld in a shape that
 *     already happens. The door card with no sentence looks exactly like
 *     one where the vision model was unsure; a week rewritten from its
 *     counts looks like one the model was not used for. Withholding must
 *     not itself tell the family something (the reasoning of INV-10).
 *
 * Fail closed. When a whole answer holds a string the gate cannot clear
 * and no field rule caught it first, the answer is not sent: the family is
 * told what any failed answer tells them — "Something went wrong on my
 * end" — which says nothing about what was in it. That should never
 * happen; the log line says where it did (`guardian_withheld`, with the
 * classes and the place, never the words).
 *
 * What is not read: identifiers and addresses a person never reads as
 * words (NOT_WORDS), and the words Wick itself uses to name the classes
 * ("Health", "Money") when it tells a family member what the resident
 * shares. And the reader's own words, handed back to them: a note is read
 * back to the person who wrote it (`theirOwnWords`).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FactClass } from '@wick/contracts';
import { clearForFamily } from '@wick/policy';
import { SOMETHING_WENT_WRONG_TEXT } from './tools/errors.js';
import { FACT_CLASS_WORDS } from './tools/get_resident_shared_view.js';
import { timed, type PhaseTimer } from './timing.js';

/**
 * Values that are never read as words: an id, a picture's address, a week's
 * code. A random id can hold any letters; reading it would withhold an
 * answer for a coincidence. A person's id made from their name (`personId`)
 * is not here: it is the name, spelt another way.
 */
const NOT_WORDS: ReadonlySet<string> = new Set(['id', 'requestId', 'sessionId', 'cardId', 'householdId', 'correlationId', 'pictureUrl', 'isoWeek']);

/** The words Wick uses to name the classes themselves: a label, not a fact about anyone. */
const CLASS_NAMES: ReadonlySet<string> = new Set([...Object.keys(FACT_CLASS_WORDS), ...Object.values(FACT_CLASS_WORDS)]);

const NOTHING: ReadonlySet<string> = new Set();

export interface Uncleared {
  /** Where in the answer, as a path: `$.notes[0].message`. */
  readonly at: string;
  /** What the lexicon found. Empty when the string could not be read at all. */
  readonly classes: readonly FactClass[];
}

/** Notes, for the log, that something was held back — where, and why. Never the words. */
function logWithheld(where: string, uncleared: Uncleared): void {
  console.warn(JSON.stringify({ level: 'warn', msg: 'guardian_withheld', where, at: uncleared.at, classes: uncleared.classes }));
}

/**
 * One string, for the family: itself when the gate clears it, undefined when
 * not. `where` names the field for the log.
 */
export function familyText(text: string, where: string): string | undefined {
  const clearance = clearForFamily(text);
  if (clearance.cleared) return text;
  logWithheld(where, { at: '$', classes: clearance.classes });
  return undefined;
}

/** Whether a string may be shown to the family. For a rule that needs only the answer, without the log. */
export const clears = (text: string): boolean => clearForFamily(text).cleared;

/**
 * The first string in `value` the gate cannot clear, or undefined when
 * every one clears. `own`: strings that are the reader's own words, exactly.
 */
export function firstUncleared(value: unknown, own: ReadonlySet<string> = NOTHING, at = '$'): Uncleared | undefined {
  if (typeof value === 'string') {
    if (own.has(value) || CLASS_NAMES.has(value)) return undefined;
    const clearance = clearForFamily(value);
    return clearance.cleared ? undefined : { at, classes: clearance.classes };
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = firstUncleared(value[i], own, `${at}[${i}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      if (NOT_WORDS.has(key) && typeof inner === 'string') continue;
      const found = firstUncleared(inner, own, `${at}.${key}`);
      if (found) return found;
    }
  }
  // Numbers, booleans, null: no words.
  return undefined;
}

/** Where a tool's answer says which of its strings are the reader's own words. */
const READERS_OWN = Symbol('readersOwn');

type Marked = { [READERS_OWN]?: ReadonlySet<string> };

/**
 * Marks `words` in a tool's answer as the reader's own — the note they
 * wrote, handed back to them — so the gate passes them as they are. Only
 * those exact strings, only in this answer, and only for the person whose
 * words they are: a caller must have checked that.
 */
export function theirOwnWords<T extends object>(result: T, words: readonly string[]): T {
  Object.defineProperty(result, READERS_OWN, { value: new Set(words), enumerable: false });
  return result;
}

interface ToolAnswer {
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
  readonly structuredContent?: unknown;
}

const WITHHELD_ANSWER = { content: [{ type: 'text' as const, text: SOMETHING_WENT_WRONG_TEXT }], isError: true as const };

/** A tool's answer, read string by string: itself, or the answer a failure gets. */
export function guardToolAnswer<R extends object>(tool: string, result: R): R | typeof WITHHELD_ANSWER {
  const answer = result as R & ToolAnswer & Marked;
  const own = answer[READERS_OWN] ?? NOTHING;
  const structured = answer.structuredContent;

  let uncleared = structured === undefined ? undefined : firstUncleared(structured, own, '$.structuredContent');
  const content = answer.content ?? [];
  for (let i = 0; i < content.length && !uncleared; i += 1) {
    const item = content[i]!;
    // A picture, a file, a link: nothing here returns one, and none can be read. Not sent.
    if (item.type !== 'text' || typeof item.text !== 'string') {
      uncleared = { at: `$.content[${i}]`, classes: [] };
      break;
    }
    // The same answer as text, for a client that reads only text (tools/result.ts `data`): read once, above.
    if (structured !== undefined && item.text === JSON.stringify(structured)) continue;
    uncleared = firstUncleared(item.text, own, `$.content[${i}].text`);
  }

  if (!uncleared) return result;
  logWithheld(tool, uncleared);
  return WITHHELD_ANSWER;
}

/** The part of a Zod schema the gate needs: whether a value is one. */
interface OutputSchema {
  safeParse(value: unknown): { success: true } | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; code: string }[] } };
}

/**
 * An answer that is not what its tool declares is answered as any failure
 * is. The SDK would check it next and send the family its own message —
 * "Output validation error: …", naming fields — so it is checked here first,
 * and the log says which fields, never their values.
 */
function keptToSchema<R extends object>(tool: string, result: R, output: OutputSchema | undefined): R | typeof WITHHELD_ANSWER {
  const answer = result as R & ToolAnswer & { isError?: boolean };
  if (!output || answer.isError === true) return result;
  const checked = output.safeParse(answer.structuredContent);
  if (checked.success) return result;
  console.error(JSON.stringify({
    level: 'error',
    msg: 'tool_output_invalid',
    tool,
    issues: checked.error.issues.slice(0, 5).map((issue) => ({ at: issue.path.map(String).join('.'), code: issue.code })),
  }));
  return WITHHELD_ANSWER;
}

/** The tools behind the gate on each server, for the test that every tool is. */
const guardedTools = new WeakMap<McpServer, Set<string>>();

export function toolsBehindTheGate(server: McpServer): ReadonlySet<string> {
  return guardedTools.get(server) ?? NOTHING;
}

/**
 * The MCP server a family member's tools are registered on, with every
 * tool's answer passed through the gate. `registerTool` is the only way to
 * add one; the SDK's older `tool()` is refused, so it cannot be a way round.
 */
export function guardTools(server: McpServer, timer?: PhaseTimer): McpServer {
  const names = new Set<string>();
  guardedTools.set(server, names);
  const register = server.registerTool.bind(server) as (name: string, config: unknown, callback: (...args: unknown[]) => unknown) => unknown;

  const registerTool = (name: string, config: unknown, callback: (...args: unknown[]) => unknown): unknown => {
    names.add(name);
    const output = (config as { outputSchema?: OutputSchema } | undefined)?.outputSchema;
    return register(name, config, async (...args: unknown[]) => {
      const result = await callback(...args);
      if (typeof result !== 'object' || result === null) return result;
      return timed(timer, 'guard', async () => keptToSchema(name, guardToolAnswer(name, result), output));
    });
  };
  Object.assign(server, {
    registerTool,
    tool: () => {
      throw new Error('A family tool is registered with registerTool, behind the Guardian (guardian.ts).');
    },
  });
  return server;
}

/** Thrown when a television's answer holds what the gate cannot clear: the router answers it as it answers any failure. */
export class WithheldFromFamily extends Error {
  override readonly name = 'WithheldFromFamily';
}

/**
 * Every route of a family member's own television, with each answer it
 * gives read by the gate first. An answer that cannot be cleared is never
 * sent: the route fails, and the television says what it says when any
 * request fails.
 */
export function guardTelevision<E extends { [K in keyof E]: (...args: never[]) => Promise<{ readonly status: number; readonly body: unknown }> }>(endpoints: E): E {
  const guarded: Record<string, unknown> = {};
  for (const [route, endpoint] of Object.entries(endpoints) as [string, (...args: never[]) => Promise<{ readonly status: number; readonly body: unknown }>][]) {
    guarded[route] = async (...args: never[]) => {
      const reply = await endpoint(...args);
      const uncleared = firstUncleared(reply.body);
      if (uncleared) {
        logWithheld(`/tv/${route}`, uncleared);
        throw new WithheldFromFamily();
      }
      return reply;
    };
  }
  return guarded as E;
}
