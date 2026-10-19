/**
 * POST /assistant/turn — one turn of the family assistant as a Strands agent
 * on AgentCore Runtime (services/agent/src/agents/assistant/).
 *
 *   { question }               a question, in the member's words
 *   { resume: { approved } }   the member's answer to what was waiting:
 *                              yes or no to all, or { [id]: yes|no }
 *
 * The agent makes the tool calls itself, over MCP, with the member's own
 * token, which this route puts in the payload. Everything else the payload
 * says is the server's own: the home and the member from the token
 * (INV-8), the names from the account, the zone from the deployment. A
 * request can send a question or an answer and nothing more.
 *
 * Before the agent is asked: the token (router.ts requireAuth), whether the
 * resident still allows this person (INV-9, the same refusal every tool
 * gives, costing no model), and the assistant's allowance (router.ts).
 *
 * After: what the agent says passes the same check the stand-in's reply
 * does (brain.ts checkReply) — the Guardian (INV-2, INV-4), and every
 * number in it found in what the tools returned this turn, the member's
 * question, or today. A reply that fails is not said: the answer is
 * `{ unsupported: true }`, and the app says the tools' own sentences. What
 * waits for a yes is shown under this server's own tool titles.
 *
 * Unset (no ASSISTANT_RUNTIME_ARN), failing, or answering with anything but
 * a turn, the route says 503 and the family app asks /assistant/next, which
 * stays. Nothing about a failure is logged but its name: the payload holds
 * the token.
 */
import type { Request, Response } from 'express';
import { assistantSessionId } from '@wick/agent';
import { checkAccess } from '../accounts/circle.js';
import { grantOf } from '../accounts/oauthProvider.js';
import type { AccountStore } from '../accounts/store.js';
import { zoneOf } from '../accounts/types.js';
import { checkReply, type Turn, type Who } from './brain.js';

/** What the runtime is sent (services/agent/src/agents/assistant/turn.ts readTurnRequest). */
export interface AgentTurnPayload {
  readonly kind: 'assistant.turn';
  readonly householdId: string;
  readonly memberId: string;
  readonly memberToken: string;
  readonly who: Who;
  readonly timeZone: string;
  readonly question?: string;
  readonly resume?: { readonly approved: boolean | Readonly<Record<string, boolean>> };
}

export type InvokeAgentTurn = (runtimeSessionId: string, payload: AgentTurnPayload) => Promise<unknown>;

export interface AssistantAgent {
  readonly invoke: InvokeAgentTurn;
}

/**
 * A turn counts as this many steps of the assistant's allowance (router.ts):
 * it may ask the model up to seven times, and usually asks two or three.
 */
export const TURN_COST = 4;

const MAX_QUESTION_CHARS = 600;
/** Six rounds of four calls (the agent's own limits), and no more. */
const MAX_STEPS = 24;
const MAX_ANSWERS = 16;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

type TurnBody = { readonly question: string } | { readonly resume: { readonly approved: boolean | Readonly<Record<string, boolean>> } };

/** A question or an answer, never both; undefined for anything else. */
export function readTurnBody(body: unknown): TurnBody | undefined {
  if (!isRecord(body)) return undefined;
  const { question, resume } = body;
  if ((question === undefined) === (resume === undefined)) return undefined;
  if (question !== undefined) {
    const asked = typeof question === 'string' ? question.trim().slice(0, MAX_QUESTION_CHARS) : '';
    return asked ? { question: asked } : undefined;
  }
  if (!isRecord(resume)) return undefined;
  const { approved } = resume;
  if (typeof approved === 'boolean') return { resume: { approved } };
  if (!isRecord(approved)) return undefined;
  const entries = Object.entries(approved);
  if (entries.length === 0 || entries.length > MAX_ANSWERS) return undefined;
  if (!entries.every(([id, yes]) => id.length > 0 && id.length <= 300 && typeof yes === 'boolean')) return undefined;
  return { resume: { approved: Object.fromEntries(entries) as Record<string, boolean> } };
}

interface TraceStep {
  readonly tool: string;
  readonly ok: boolean;
  readonly args: unknown;
  readonly declined?: true;
}

interface WaitingCall {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

interface AgentAnswer {
  readonly say?: string;
  readonly needsApproval?: readonly WaitingCall[];
  readonly trace: readonly TraceStep[];
  readonly toolTexts: readonly string[];
  readonly asked?: string;
}

/** The runtime's answer, if it is a turn — with every call it names one of this server's tools. */
export function readAgentAnswer(raw: unknown, tools: ReadonlyMap<string, string>): AgentAnswer | undefined {
  if (!isRecord(raw) || 'error' in raw) return undefined;
  const { say, needsApproval, trace, toolTexts, asked } = raw;
  if (!Array.isArray(trace) || !Array.isArray(toolTexts) || trace.length !== toolTexts.length || trace.length > MAX_STEPS) return undefined;
  if (!toolTexts.every((t) => typeof t === 'string')) return undefined;
  const steps: TraceStep[] = [];
  for (const step of trace) {
    if (!isRecord(step) || typeof step.tool !== 'string' || !tools.has(step.tool) || typeof step.ok !== 'boolean') return undefined;
    steps.push({ tool: step.tool, ok: step.ok, args: isRecord(step.args) ? step.args : {}, ...(step.declined === true ? { declined: true as const } : {}) });
  }
  if (say !== undefined && typeof say !== 'string') return undefined;
  if (asked !== undefined && typeof asked !== 'string') return undefined;

  let waiting: WaitingCall[] | undefined;
  if (needsApproval !== undefined) {
    if (!Array.isArray(needsApproval) || needsApproval.length === 0 || needsApproval.length > MAX_ANSWERS) return undefined;
    waiting = [];
    for (const call of needsApproval) {
      if (!isRecord(call) || typeof call.id !== 'string' || !call.id || typeof call.name !== 'string' || !tools.has(call.name)) return undefined;
      waiting.push({ id: call.id, name: call.name, args: isRecord(call.args) ? call.args : {} });
    }
  }
  return {
    trace: steps,
    toolTexts: toolTexts as string[],
    ...(typeof say === 'string' ? { say } : {}),
    ...(waiting ? { needsApproval: waiting } : {}),
    ...(typeof asked === 'string' ? { asked } : {}),
  };
}

/** What the family app is told: what waits, what may be said, or that the tools' own sentences must do. */
export function answerFor(answer: AgentAnswer, titles: ReadonlyMap<string, string>, now: Date, timeZone: string, people: readonly string[] = []): Record<string, unknown> {
  const { trace, toolTexts } = answer;
  if (answer.needsApproval) {
    const needsApproval = answer.needsApproval.map((call) => ({ ...call, title: titles.get(call.name) ?? call.name }));
    return { needsApproval, plan: needsApproval.map((call) => call.title), trace, toolTexts };
  }
  const turns: Turn[] = [
    ...(answer.asked ? [{ role: 'user' as const, text: answer.asked }] : []),
    { role: 'tool', results: toolTexts.map((text, i) => ({ id: `t${i}`, name: trace[i]!.tool, text })) },
  ];
  if (answer.say !== undefined) {
    const check = checkReply(answer.say, turns, now, timeZone, people);
    if (check.ok) return { say: answer.say.trim(), trace, toolTexts };
    // Which check refused it, never the words: a number with nothing under it, a protected class, or its length.
    const named = ['empty', 'too long', 'protected'].includes(check.detail);
    console.warn(JSON.stringify({ level: 'warn', msg: 'assistant_reply_unsupported', why: named ? check.detail : 'invented_number', ...(named ? {} : { number: check.detail }) }));
  }
  return { unsupported: true, trace, toolTexts };
}

export interface TurnRouteDeps {
  readonly agent?: AssistantAgent | undefined;
  readonly store: AccountStore;
  /** This server's own tools: each name and its title (tools/list). */
  readonly toolTitles: () => Promise<ReadonlyMap<string, string>>;
  /** The household's own people, by name (people.ts), for the reply check. Absent, nobody is. */
  readonly peopleOf?: ((householdId: string) => Promise<readonly string[]>) | undefined;
  /** The assistant's allowance (router.ts createStepLimiter), shared with /assistant/next. */
  readonly mayStep: (userId: string, cost: number) => boolean;
  readonly now: () => number;
}

export function turnRoute(deps: TurnRouteDeps): (req: Request, res: Response) => Promise<void> {
  return async (req, res) => {
    const grant = grantOf(req.auth);
    if (!grant || !req.auth) return void res.status(401).json({ error: 'invalid_token', message: 'Link Wick again.' });
    if (!deps.agent) return void res.status(503).json({ error: 'assistant_unavailable', message: 'There is no assistant agent here.' });

    const body = readTurnBody(req.body);
    if (!body) return void res.status(400).json({ error: 'not_a_turn', message: 'I could not follow that.' });

    try {
      // INV-9, asked on every turn as on every tool call: the refusal is the answer, and costs no model.
      const access = await checkAccess(deps.store, grant.householdId, grant.userId);
      // `refused` says why, for the app to act on: no longer in the circle may mean she has closed the home.
      if (!access.ok) return void res.json({ say: access.say, trace: [], toolTexts: [], refused: access.reason });
      const { household, membership } = access;

      if (!deps.mayStep(grant.userId, TURN_COST)) {
        return void res.status(429).json({ error: 'assistant_busy', message: 'That is a lot of questions. Give me a few minutes.' });
      }

      const payload: AgentTurnPayload = {
        kind: 'assistant.turn',
        householdId: grant.householdId,
        memberId: grant.userId,
        memberToken: req.auth.token,
        who: { memberName: membership.name, residentName: household.residentName, householdName: household.name, simulated: household.simulated === true },
        // Where the house is: the agent says every time on its clock.
        timeZone: zoneOf(household),
        ...body,
      };
      const raw = await deps.agent.invoke(assistantSessionId(grant.householdId, grant.userId), payload);
      const titles = await deps.toolTitles();
      const answer = readAgentAnswer(raw, titles);
      if (!answer) throw Object.assign(new Error('not a turn'), { name: 'AgentAnswerRefused' });
      // Read only when the reply would otherwise be refused: the common reply costs no read.
      let sent = answerFor(answer, titles, new Date(deps.now()), zoneOf(household));
      if (sent.unsupported === true && deps.peopleOf) {
        const people = await deps.peopleOf(grant.householdId).catch(() => []);
        if (people.length > 0) sent = answerFor(answer, titles, new Date(deps.now()), zoneOf(household), people);
      }
      res.json(sent);
    } catch (err) {
      // The name only: the payload held the token, and a runtime's error names accounts and resources.
      console.error(JSON.stringify({ level: 'error', msg: 'assistant_turn_failed', error: (err as Error).name || 'Error' }));
      res.status(503).json({ error: 'assistant_unavailable', message: 'The assistant agent could not answer just now.' });
    }
  };
}
