/**
 * The assistant's model, one step at a time — the part of a simulated
 * Alexa+ that Alexa+ itself would bring.
 *
 * Amazon's assistant is not open to this project (FRICTION.md FL-001), so
 * the family app stands in for it. Until now it stood in with a handful of
 * rules: a question that did not match one got a list of what could be
 * asked. This is the missing half — a model that reads the question,
 * chooses among Wick's MCP tools, reads what they return and says it.
 *
 * The division of labour is the one a real assistant has:
 *
 *   - This module decides WHAT to call and WHAT to say. It never calls a
 *     tool. It is handed the conversation so far and answers with either
 *     the calls it wants made or the sentence to say.
 *   - The app makes the calls, over MCP, with the customer's own token —
 *     exactly as before. Every rule the tools enforce (INV-8, INV-9, what
 *     the resident keeps private) is therefore enforced on the model too:
 *     it can ask for nothing the customer could not.
 *
 * And the rule the Narrator lives by holds here as well: the model chooses
 * the words, and cannot add a fact. A reply is checked against what the
 * tools returned; one with a number that came from nowhere is sent back
 * once with the reason, and after that the app says the tools' own
 * sentences instead (checkReply).
 *
 * Pure: the model is a function passed in (`Converse`), so every rule is
 * tested without one. bedrock.ts is the real one.
 */
import { localWhen, systemPrompt, todayLine, type Who } from '@wick/agent';
import { familyText } from '../guardian.js';

// The rules and the day the model is told are the agent's too (services/agent/src/agents/assistant/prompt.ts): one set for both assistants.
export { localWhen, systemPrompt, type Who };

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema, as the MCP server's own tools/list gives it. */
  readonly inputSchema: object;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface ToolResult {
  readonly id: string;
  readonly name: string;
  readonly text: string;
  readonly isError?: boolean;
}

/** The conversation as the app keeps it: what was asked, what was called, what came back. */
export type Turn =
  | { readonly role: 'user'; readonly text: string }
  | { readonly role: 'assistant'; readonly text?: string; readonly calls?: readonly ToolCall[] }
  | { readonly role: 'tool'; readonly results: readonly ToolResult[] };

export type Block =
  | { readonly text: string }
  | { readonly toolUse: { readonly toolUseId: string; readonly name: string; readonly input: Record<string, unknown> } }
  | { readonly toolResult: { readonly toolUseId: string; readonly content: readonly { readonly text: string }[]; readonly status?: 'error' } };

export interface Message {
  readonly role: 'user' | 'assistant';
  readonly content: readonly Block[];
}

export interface ModelRequest {
  readonly system: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolSpec[];
}

export interface ModelReply {
  readonly text: string;
  readonly calls: readonly ToolCall[];
}

export type Converse = (request: ModelRequest) => Promise<ModelReply>;

export type Step =
  /** Call these over MCP, then come back with the results. */
  | { readonly done: false; readonly calls: readonly ToolCall[] }
  /** Say this. */
  | { readonly done: true; readonly say: string }
  /** The model had nothing fit to say: the app says what the tools themselves said. */
  | { readonly done: true; readonly unsupported: true };

/** More turns than this is not a conversation: refused before any of it is read. */
export const MAX_RAW_TURNS = 100;
/** How much of a conversation the model is shown. */
const MAX_TURNS = 24;
/** Everything the model is shown, in characters: what one step may cost is fixed, whatever is sent. */
export const MAX_TRANSCRIPT_CHARS = 24_000;
/** What is left of an old tool result when the newest question alone is over the size. */
const SHORTENED_RESULT_CHARS = 500;
const MAX_USER_CHARS = 600;
const MAX_ASSISTANT_CHARS = 1000;
const MAX_RESULT_CHARS = 8000;
const MAX_CALLS_PER_STEP = 4;
/** How many times the model may go back to the tools for one question. */
export const MAX_TOOL_ROUNDS = 4;
/** Two spoken sentences, with room to spare. */
const MAX_REPLY_CHARS = 400;

export const TOO_MANY_STEPS_TEXT = 'That is more than I can do in one go. Ask me for one part of it at a time.';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const cut = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text);

function readCalls(raw: unknown, known: ReadonlySet<string>): ToolCall[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_CALLS_PER_STEP) return undefined;
  const calls: ToolCall[] = [];
  for (const call of raw) {
    if (!isRecord(call) || typeof call.id !== 'string' || !call.id || call.id.length > 128) return undefined;
    if (typeof call.name !== 'string' || !known.has(call.name)) return undefined;
    calls.push({ id: call.id, name: call.name, args: isRecord(call.args) ? call.args : {} });
  }
  return calls;
}

/**
 * The conversation a browser sent, or undefined if it is not one. Nothing
 * a browser sends is trusted: there are three kinds of turn and no other
 * (no "system" turn to rewrite the rules with), a call must be to a tool
 * Wick has, and a tool turn must answer the calls just before it.
 */
export function readTurns(raw: unknown, tools: readonly ToolSpec[]): Turn[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_RAW_TURNS) return undefined;
  const known = new Set(tools.map((t) => t.name));

  const turns: Turn[] = [];
  for (const turn of raw) {
    if (!isRecord(turn)) return undefined;
    const before = turns.at(-1);

    if (turn.role === 'user') {
      if (typeof turn.text !== 'string' || !turn.text.trim()) return undefined;
      turns.push({ role: 'user', text: cut(turn.text.trim(), MAX_USER_CHARS) });
    } else if (turn.role === 'assistant') {
      const text = typeof turn.text === 'string' && turn.text.trim() ? cut(turn.text.trim(), MAX_ASSISTANT_CHARS) : undefined;
      const calls = turn.calls === undefined ? undefined : readCalls(turn.calls, known);
      if (turn.calls !== undefined && !calls) return undefined;
      if (!text && !calls) return undefined;
      turns.push({ role: 'assistant', ...(text ? { text } : {}), ...(calls ? { calls } : {}) });
    } else if (turn.role === 'tool') {
      const asked = before?.role === 'assistant' ? before.calls : undefined;
      if (!asked || !Array.isArray(turn.results) || turn.results.length !== asked.length) return undefined;
      const results: ToolResult[] = [];
      for (const call of asked) {
        const result = (turn.results as unknown[]).find((r) => isRecord(r) && r.id === call.id);
        if (!isRecord(result) || typeof result.text !== 'string') return undefined;
        results.push({ id: call.id, name: call.name, text: cut(result.text, MAX_RESULT_CHARS), ...(result.isError === true ? { isError: true } : {}) });
      }
      turns.push({ role: 'tool', results });
    } else {
      return undefined;
    }
  }

  // A turn that asked for tools must have been answered, and the last word is never the assistant's.
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i]!;
    if (turn.role === 'assistant' && turn.calls && turns[i + 1]?.role !== 'tool') return undefined;
  }
  if (turns.at(-1)!.role === 'assistant') return undefined;

  let recent = turns.slice(-MAX_TURNS);
  while (recent.length && recent[0]!.role !== 'user') recent = recent.slice(1);
  if (!recent.length) return undefined;
  return withinSize(recent);
}

const sizeOf = (turn: Turn): number =>
  turn.role === 'tool' ? turn.results.reduce((n, r) => n + r.text.length, 0) : (turn.text?.length ?? 0);

/**
 * The conversation, small enough to show a model. Whole questions are
 * dropped from the front first; if the newest question's own tool results
 * are still too much, the oldest of them are cut short.
 */
function withinSize(turns: Turn[]): Turn[] {
  let kept = turns;
  const total = (): number => kept.reduce((n, t) => n + sizeOf(t), 0);

  while (total() > MAX_TRANSCRIPT_CHARS) {
    const nextQuestion = kept.findIndex((t, i) => i > 0 && t.role === 'user');
    if (nextQuestion === -1) break;
    kept = kept.slice(nextQuestion);
  }
  for (let i = 0; i < kept.length && total() > MAX_TRANSCRIPT_CHARS; i += 1) {
    const turn = kept[i]!;
    if (turn.role !== 'tool') continue;
    const shortened: Turn = { role: 'tool', results: turn.results.map((r) => ({ ...r, text: cut(r.text, SHORTENED_RESULT_CHARS) })) };
    kept = [...kept.slice(0, i), shortened, ...kept.slice(i + 1)];
  }
  return kept;
}

/** Milliseconds since 1970 for any date a household's timeline could hold. */
const looksLikeAMoment = (value: unknown): value is number => typeof value === 'number' && value > 1e12 && value < 1e13;

/** Beside every moment (`at`, `sentAt`, `lastVisitAt`…) its words: `atLocal`, `sentAtLocal`. */
function withLocalTimes(value: unknown, timeZone: string): unknown {
  if (Array.isArray(value)) return value.map((v) => withLocalTimes(v, timeZone));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = withLocalTimes(inner, timeZone);
    if ((key === 'at' || key.endsWith('At')) && looksLikeAMoment(inner)) out[`${key}Local`] = localWhen(inner, timeZone);
  }
  return out;
}

/** A tool's result as the model reads it: its JSON with every moment written out, or its sentence as it stands. */
function shownResult(text: string, timeZone: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? JSON.stringify(withLocalTimes(parsed, timeZone)) : text;
  } catch {
    return text;
  }
}

export function toMessages(turns: readonly Turn[], timeZone: string): Message[] {
  return turns.map((turn): Message => {
    if (turn.role === 'user') return { role: 'user', content: [{ text: turn.text }] };
    if (turn.role === 'assistant') {
      return {
        role: 'assistant',
        content: [
          ...(turn.text ? [{ text: turn.text }] : []),
          ...(turn.calls ?? []).map((c) => ({ toolUse: { toolUseId: c.id, name: c.name, input: c.args } })),
        ],
      };
    }
    return {
      role: 'user',
      content: turn.results.map((r) => ({
        toolResult: { toolUseId: r.id, content: [{ text: shownResult(r.text, timeZone) }], ...(r.isError ? { status: 'error' as const } : {}) },
      })),
    };
  });
}

export type ReplyCheck = { readonly ok: true } | { readonly ok: false; readonly detail: string };

const numbersIn = (text: string): string[] => text.match(/\d+/g) ?? [];

/**
 * A reply is fit to say when it is something, short enough to be spoken,
 * and every number in it can be found in what the tools returned, what the
 * customer said, or today's date. The same rule the Narrator's prose is
 * held to (services/agent/src/agents/narrator/weekFacts.ts checkNarrative).
 *
 * And it passes the Guardian (INV-4). The tools' answers have already been
 * through it (guardian.ts), but a model can add words of its own, or say
 * back a question about her health as if it were an answer. A reply the
 * gate cannot clear is asked for once more, and then the app says the
 * tools' own sentences instead — the way any unfit reply ends.
 */
export function checkReply(text: string, turns: readonly Turn[], now: Date, timeZone: string): ReplyCheck {
  const reply = text.trim();
  if (!reply) return { ok: false, detail: 'empty' };
  if (reply.length > MAX_REPLY_CHARS) return { ok: false, detail: 'too long' };
  if (!familyText(reply, 'assistant.reply')) return { ok: false, detail: 'protected' };

  const evidence = new Set(numbersIn(todayLine(now, timeZone)));
  for (const turn of turns) {
    if (turn.role === 'user') numbersIn(turn.text).forEach((n) => evidence.add(n));
    if (turn.role === 'tool') for (const r of turn.results) numbersIn(shownResult(r.text, timeZone)).forEach((n) => evidence.add(n));
  }
  const invented = numbersIn(reply).find((n) => !evidence.has(n));
  return invented === undefined ? { ok: true } : { ok: false, detail: invented };
}

function retryReason(check: Extract<ReplyCheck, { ok: false }>): string {
  if (check.detail === 'empty') return 'You said nothing. Answer in one or two short sentences, from the tool results.';
  if (check.detail === 'too long') return 'That was too long to say aloud. Answer in one or two short sentences.';
  if (check.detail === 'protected') {
    return 'Wick never tells the family anything about health, money, relationships or where someone is, and that reply did. Answer again from the tool results without it, or say you cannot help with that.';
  }
  return `Your reply used "${check.detail}", which is not in the tool results. Say it again using only numbers, dates and times that the results give.`;
}

export interface StepDeps {
  readonly converse: Converse;
  readonly tools: readonly ToolSpec[];
  readonly who: Who;
  readonly now: Date;
  readonly timeZone: string;
}

/** One step of the model: the calls it wants made, or what to say. `turns` has been through readTurns. */
export async function nextStep(deps: StepDeps, turns: readonly Turn[]): Promise<Step> {
  const { converse, tools, now, timeZone } = deps;
  const known = new Set(tools.map((t) => t.name));
  const system = systemPrompt(deps.who, now, timeZone);
  const messages = toMessages(turns, timeZone);

  const lastQuestion = turns.map((t) => t.role).lastIndexOf('user');
  const rounds = turns.slice(lastQuestion + 1).filter((t) => t.role === 'tool').length;

  // A transcript already past the limit was not built by the app: it is not worth a model's time.
  if (rounds > MAX_TOOL_ROUNDS) return { done: true, say: TOO_MANY_STEPS_TEXT };

  const reply = await converse({ system, messages, tools });
  if (reply.calls.length) {
    if (rounds >= MAX_TOOL_ROUNDS) return { done: true, say: TOO_MANY_STEPS_TEXT };
    if (reply.calls.some((c) => !known.has(c.name))) return { done: true, unsupported: true };
    return { done: false, calls: reply.calls.slice(0, MAX_CALLS_PER_STEP) };
  }

  const check = checkReply(reply.text, turns, now, timeZone);
  if (check.ok) return { done: true, say: reply.text.trim() };

  // Once more, told why — as the Narrator is (narrator/index.ts).
  const again = await converse({
    system,
    tools,
    messages: [
      ...messages,
      { role: 'assistant', content: [{ text: reply.text.trim() || '(nothing)' }] },
      { role: 'user', content: [{ text: retryReason(check) }] },
    ],
  });
  if (!again.calls.length && checkReply(again.text, turns, now, timeZone).ok) return { done: true, say: again.text.trim() };
  return { done: true, unsupported: true };
}
