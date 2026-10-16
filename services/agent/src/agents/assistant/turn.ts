/**
 * The family assistant as a Strands agent on AgentCore Runtime — the
 * runtime kind `assistant.turn`.
 *
 * One invocation is one turn: a question, or the member's answer to a
 * write the agent stopped before. The Wick server sends it
 * (services/mcp-server/src/assistant/turn.ts) after checking the member's
 * token and that the resident still allows them (INV-8, INV-9), with that
 * token in the payload. Here:
 *
 *   1. An Agent is built for this turn alone: the model (Claude Sonnet 4.5,
 *      with the Bedrock Guardrail, main.ts), the system prompt (prompt.ts),
 *      and Wick's tools, discovered from Wick's own MCP server through an
 *      McpClient that sends the member's token. The agent can call nothing
 *      the member could not, and every rule the tools keep — the circle,
 *      what she keeps private, the Guardian on every answer — holds.
 *   2. Its SessionManager restores the member's conversation
 *      (sessions.ts, identity.ts) and saves it again when the turn ends.
 *   3. Its MemoryManager, where there is a memory, puts what the member
 *      said before in front of the model and keeps their new words
 *      (memory.ts).
 *   4. Writes stop for the member's yes (approval.ts). The turn answers
 *      with what is waiting — `needsApproval`, with the exact arguments,
 *      and `plan`, what it would do — and the next invocation carries the
 *      answer.
 *
 * What it answers is checked again on the Wick server: the Guardian, and
 * that every number in `say` is in `toolTexts`, the question, or today
 * (brain.ts checkReply). The model chooses the words and cannot add a fact.
 *
 * The member's token is used for one thing: the McpClient's Authorization
 * header, for this turn. It is not put in the agent's state, the prompt,
 * the saved session, a log line or the answer.
 */
import {
  Agent,
  BeforeToolCallEvent,
  BeforeToolsEvent,
  InterruptResponseContent,
  McpClient,
  Message,
  SessionManager,
  SlidingWindowConversationManager,
  TextBlock,
  type AgentResult,
  type JSONValue,
  type MemoryStore,
  type Model,
} from '@strands-agents/sdk';
import type { RuntimeHandler } from '../../runtime/server.js';
import { APPROVAL, DECLINED_TEXT, MAX_TOOL_ROUNDS, askBeforeWriting, keepTheTurnSmall, type ApprovalReason } from './approval.js';
import { ASSISTANT_AGENT_ID, assistantSessionId } from './identity.js';
import { memoryManagerFor } from './memory.js';
import { assistantPrompt, type Who } from './prompt.js';
import type { SessionStorage } from './sessions.js';

export { DECLINED_TEXT } from './approval.js';

/** The same sentence the stand-in assistant says (services/mcp-server/src/assistant/brain.ts). */
export const TOO_MANY_STEPS_TEXT = 'That is more than I can do in one go. Ask me for one part of it at a time.';
export const TOO_SLOW_TEXT = 'That took me too long. Ask me again in a moment.';
export const NOTHING_WAITING_TEXT = 'There was nothing waiting for your answer. Ask me again.';
/** Said, in the conversation the model keeps, of a write the member never answered because they asked something else. */
const LEFT_TEXT = 'I did not do that: you asked me something else first.';

/** A person's question in one go — the stand-in's own limit (brain.ts MAX_USER_CHARS). */
const MAX_QUESTION_CHARS = 600;
/** Messages the model is shown: a long conversation is not a better one. */
const CONVERSATION_WINDOW = 24;
/** The whole turn, model and tools, as the stand-in's single step had (bedrock.ts STEP_TIMEOUT_MS). */
const TURN_TIMEOUT_MS = 20_000;

export interface TurnLimits {
  readonly timeoutMs: number;
}

export interface AssistantTurnDeps {
  /** Claude Sonnet 4.5 with the Bedrock Guardrail (main.ts); a scripted model in tests. */
  readonly model: Model;
  /** Wick's MCP endpoint (WICK_MCP_URL). */
  readonly mcpUrl: string;
  readonly sessions: SessionStorage;
  /** The member's long-term memory in this home; absent or undefined, nothing is remembered. */
  readonly memoryFor?: (householdId: string, memberId: string) => MemoryStore | undefined;
  readonly now: () => number;
  /** The household's zone when the request names none. */
  readonly timeZone?: string;
  readonly limits?: Partial<TurnLimits>;
}

/** The member's answer: yes or no to everything waiting, or yes or no to each, by interrupt id. */
export type Approval = boolean | Readonly<Record<string, boolean>>;

export interface AssistantTurnRequest {
  readonly householdId: string;
  readonly memberId: string;
  readonly memberToken: string;
  readonly who: Who;
  readonly timeZone?: string;
  readonly question?: string;
  readonly resume?: { readonly approved: Approval };
}

export interface WaitingCall {
  /** The interrupt's id: what the answer names. */
  readonly id: string;
  readonly name: string;
  readonly args: JSONValue;
  /** The tool's name here; the Wick server puts its own title in its place. */
  readonly title: string;
}

export interface TraceStep {
  readonly tool: string;
  readonly ok: boolean;
  readonly args: JSONValue;
  /** The member said no. */
  readonly declined?: true;
}

export interface AssistantTurnOutput {
  readonly say?: string;
  readonly needsApproval?: readonly WaitingCall[];
  readonly plan?: readonly string[];
  /** Every tool this turn called, since the member's question, in order. */
  readonly trace: readonly TraceStep[];
  /** What each of them returned, in the same order: the only facts `say` may use. */
  readonly toolTexts: readonly string[];
  /** The question this turn answers, in the member's own words: numbers in it may be said back. */
  readonly asked?: string;
}

// --- The request ------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
const isName = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;

function isZone(v: unknown): v is string {
  if (typeof v !== 'string' || !v) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: v });
    return true;
  } catch {
    return false;
  }
}

function readApproval(v: unknown): Approval | undefined {
  if (typeof v === 'boolean') return v;
  if (!isRecord(v)) return undefined;
  const answers: Record<string, boolean> = {};
  for (const [id, yes] of Object.entries(v)) {
    if (typeof yes !== 'boolean') return undefined;
    answers[id] = yes;
  }
  return answers;
}

/** A turn, or undefined. A question or an answer, never both; who is asking always. */
export function readTurnRequest(payload: Record<string, unknown>): AssistantTurnRequest | undefined {
  const { householdId, memberId, memberToken, who, timeZone, question, resume } = payload;
  if (!isId(householdId) || !isId(memberId) || typeof memberToken !== 'string' || !memberToken || memberToken.length > 8192) return undefined;
  if (!isRecord(who) || !isName(who.memberName) || !isName(who.residentName) || !isName(who.householdName) || typeof who.simulated !== 'boolean') return undefined;
  if (timeZone !== undefined && !isZone(timeZone)) return undefined;

  const asked = typeof question === 'string' ? question.trim().slice(0, MAX_QUESTION_CHARS) : undefined;
  const answered = isRecord(resume) ? readApproval(resume.approved) : undefined;
  if (question !== undefined && !asked) return undefined;
  if (resume !== undefined && answered === undefined) return undefined;
  if ((asked === undefined) === (answered === undefined)) return undefined;

  return {
    householdId,
    memberId,
    memberToken,
    who: { memberName: who.memberName, residentName: who.residentName, householdName: who.householdName, simulated: who.simulated },
    ...(timeZone !== undefined ? { timeZone } : {}),
    ...(asked !== undefined ? { question: asked } : {}),
    ...(answered !== undefined ? { resume: { approved: answered } } : {}),
  };
}

// --- What the turn did --------------------------------------------------------------

const textOf = (message: Message): string =>
  message.content.flatMap((block) => (block.type === 'textBlock' ? [block.text] : [])).join('').trim();

const resultText = (content: readonly unknown[]): string =>
  content
    .map((block) => {
      const b = block as { type?: string; text?: string; json?: unknown };
      if (b.type === 'textBlock' && typeof b.text === 'string') return b.text;
      if (b.type === 'jsonBlock') return JSON.stringify(b.json);
      return '';
    })
    .join('');

/** Everything since the member's last question: the question, each call, and what it returned. */
function thisTurn(messages: readonly Message[]): Pick<AssistantTurnOutput, 'trace' | 'toolTexts' | 'asked'> {
  let start = messages.length - 1;
  while (start >= 0 && !(messages[start]!.role === 'user' && messages[start]!.content.some((b) => b.type === 'textBlock'))) start -= 1;
  const calls = new Map<string, { name: string; input: JSONValue }>();
  const trace: TraceStep[] = [];
  const toolTexts: string[] = [];
  for (const message of messages.slice(start + 1)) {
    for (const block of message.content) {
      if (block.type === 'toolUseBlock') calls.set(block.toolUseId, { name: block.name, input: block.input });
      if (block.type === 'toolResultBlock') {
        const call = calls.get(block.toolUseId);
        if (!call) continue;
        const text = resultText(block.content);
        const declined = block.status === 'error' && text === DECLINED_TEXT;
        trace.push({ tool: call.name, ok: block.status === 'success', args: call.input, ...(declined ? { declined: true as const } : {}) });
        toolTexts.push(text);
      }
    }
  }
  const asked = start >= 0 ? textOf(messages[start]!) : '';
  return { trace, toolTexts, ...(asked ? { asked } : {}) };
}

interface Waiting {
  readonly id: string;
  readonly reason: ApprovalReason;
}

/** The writes waiting for an answer, as the saved session holds them (Strands' own snapshot, not its internals). */
function waitingFor(agent: Agent): Waiting[] {
  const state = agent.takeSnapshot({ include: ['interrupts'] }).data.interrupts as
    | { activated?: boolean; interrupts?: Record<string, { id: string; name: string; reason?: JSONValue; response?: JSONValue }> }
    | null
    | undefined;
  if (!state?.activated) return [];
  return Object.values(state.interrupts ?? {})
    .filter((i) => i.name === APPROVAL && i.response === undefined && isRecord(i.reason) && typeof i.reason.tool === 'string')
    .map((i) => ({ id: i.id, reason: i.reason as unknown as ApprovalReason }));
}

const approves = (approved: Approval, id: string): boolean => (typeof approved === 'boolean' ? approved : approved[id] === true);

const answersFor = (waiting: readonly Waiting[], approved: Approval): InterruptResponseContent[] =>
  waiting.map((w) => new InterruptResponseContent({ interruptId: w.id, response: approves(approved, w.id) }));

/**
 * Bedrock's Converse takes a conversation that alternates. A turn that
 * stopped on the member's side — a limit, the clock, a write let go — gets
 * the assistant's side said for it, in the conversation it keeps.
 */
function closeTheTurn(agent: Agent, text: string): void {
  if (agent.messages.at(-1)?.role === 'user') agent.messages.push(new Message({ role: 'assistant', content: [new TextBlock(text)] }));
}

// --- The turn -----------------------------------------------------------------------

export async function runAssistantTurn(request: AssistantTurnRequest, deps: AssistantTurnDeps): Promise<AssistantTurnOutput> {
  const timeoutMs = deps.limits?.timeoutMs ?? TURN_TIMEOUT_MS;
  const timeZone = request.timeZone ?? deps.timeZone ?? 'Europe/London';
  const sessionManager = new SessionManager({ sessionId: assistantSessionId(request.householdId, request.memberId), storage: deps.sessions });
  // The token is on this client's headers, for this turn, and nowhere else.
  const mcp = new McpClient({
    url: deps.mcpUrl,
    headers: { Authorization: `Bearer ${request.memberToken}` },
    applicationName: 'wick-assistant',
  });
  const memory = deps.memoryFor?.(request.householdId, request.memberId);

  const agent = new Agent({
    id: ASSISTANT_AGENT_ID,
    name: 'Wick assistant',
    model: deps.model,
    tools: [mcp],
    printer: false,
    sessionManager,
    conversationManager: new SlidingWindowConversationManager({ windowSize: CONVERSATION_WINDOW }),
    ...(memory ? { memoryManager: memoryManagerFor(memory) } : {}),
  });
  agent.addHook(BeforeToolCallEvent, askBeforeWriting);
  agent.addHook(BeforeToolsEvent, keepTheTurnSmall);

  try {
    await agent.initialize();
    // The restored session carries the prompt it was saved with; today is today.
    agent.systemPrompt = assistantPrompt(request.who, new Date(deps.now()), timeZone);

    const deadline = AbortSignal.timeout(timeoutMs);
    const invoke = (args: Parameters<Agent['invoke']>[0], turns = MAX_TOOL_ROUNDS + 1): Promise<AgentResult> =>
      agent.invoke(args, { cancelSignal: deadline, limits: { turns } });

    const waiting = waitingFor(agent);
    let result: AgentResult;
    if (request.resume) {
      if (waiting.length === 0) return { say: NOTHING_WAITING_TEXT, trace: [], toolTexts: [] };
      result = await invoke(answersFor(waiting, request.resume.approved));
    } else {
      if (waiting.length > 0) {
        // Asked something else instead: what was waiting is not done, and the conversation says so.
        await invoke(answersFor(waiting, false), 1);
        closeTheTurn(agent, LEFT_TEXT);
      }
      result = await invoke(request.question!);
    }

    const done = thisTurn(agent.messages);
    if (result.stopReason === 'interrupt') {
      const calls = waitingFor(agent).map((w): WaitingCall => ({ id: w.id, name: w.reason.tool, args: w.reason.args, title: w.reason.tool }));
      return { needsApproval: calls, plan: calls.map((c) => c.title), ...done };
    }

    let say = textOf(result.lastMessage);
    if (result.stopReason === 'limitTurns') say = TOO_MANY_STEPS_TEXT;
    if (result.stopReason === 'cancelled') say = TOO_SLOW_TEXT;
    if (agent.messages.at(-1)?.role === 'user') {
      closeTheTurn(agent, say);
      await sessionManager.saveSnapshot({ target: agent, isLatest: true });
    }
    // The member's words are written before the answer leaves: the microVM may idle after it.
    await agent.memoryManager?.flush();
    return { ...(say ? { say } : {}), ...done };
  } finally {
    await mcp.disconnect().catch(() => undefined);
  }
}

// --- The runtime kind -------------------------------------------------------------------

/** One turn at a time for each member: two tabs asking at once take turns, not each other's session. */
const queues = new Map<string, Promise<unknown>>();

function oneAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
  const before = queues.get(key) ?? Promise.resolve();
  const mine = before.catch(() => undefined).then(work);
  const settled = mine.catch(() => undefined);
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return mine;
}

/**
 * `assistant.turn`. `depsFor` is undefined where the deployment has no MCP
 * address or model (main.ts): the turn says so, and the Wick server sends
 * the family app back to the stand-in.
 */
export function assistantTurnHandler(depsFor: () => AssistantTurnDeps | undefined): RuntimeHandler {
  return async (payload, ctx) => {
    const deps = depsFor();
    if (!deps) return { error: 'not_configured' };
    const request = readTurnRequest(payload);
    if (!request) return { error: 'bad_request' };
    const session = assistantSessionId(request.householdId, request.memberId);
    // The Wick server picks the member's own runtime session (and may add the runtime version to it).
    if (ctx.sessionId && ctx.sessionId !== session && !ctx.sessionId.startsWith(`${session}-v`)) return { error: 'wrong_session' };
    return oneAtATime(session, () => runAssistantTurn(request, deps));
  };
}
