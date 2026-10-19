/**
 * POST /assistant/next — one step of the stand-in assistant (brain.ts),
 * for the family app.
 *
 * The app sends the conversation so far; the answer is either the tools to
 * call next or the sentence to say. The app then makes those calls itself,
 * over MCP, with the same token — this route never touches a household's
 * data, and holds no conversation: every request carries all it needs.
 *
 * What is trusted is what the server already knows. The tools the model is
 * shown are this server's own tools/list. The names in its instructions
 * come from the account the token belongs to (INV-8). A request can supply
 * a conversation and nothing else: there is no field in which to send a
 * prompt, a tool or a name.
 *
 * INV-9 holds here as it does on every tool: someone the resident has not
 * allowed — or has since removed — is given that answer, in the same
 * words, and the model is never asked. The tools would refuse them anyway;
 * this keeps a refused person from spending a model to be told so.
 *
 * A model costs money and a guest account costs nothing (accounts/demo.ts),
 * so steps are bounded three ways: for each person, for everyone together
 * (so a new guest is not a way round the first), and for the day (so the
 * worst a day can cost is a known number). Where no model is configured
 * the route says so, and the app falls back to the rules it used before
 * there was one.
 */
import cors from 'cors';
import express, { type RequestHandler } from 'express';
import { checkAccess } from '../accounts/circle.js';
import { isGuest } from '../accounts/demo.js';
import { grantOf } from '../accounts/oauthProvider.js';
import type { AccountStore } from '../accounts/store.js';
import { zoneOf } from '../accounts/types.js';
import { nextStep, readTurns, type Converse, type ToolSpec } from './brain.js';
import { turnRoute, type AssistantAgent } from './turn.js';
import type { Allowance, Budget } from '../budget.js';

export interface AssistantDeps {
  readonly converse: Converse;
}

export interface AssistantRouterOptions {
  /** Absent where the deployment has no model: the route then answers 503. */
  readonly assistant?: AssistantDeps | undefined;
  readonly requireAuth: () => RequestHandler;
  readonly store: AccountStore;
  /** This server's own tool list, as tools/list gives it. */
  readonly toolSpecs: () => Promise<readonly ToolSpec[]>;
  /**
   * The assistant as a Strands agent on AgentCore Runtime (turn.ts,
   * POST /assistant/turn). Absent where no runtime is configured: that route
   * then answers 503 and the app asks /assistant/next.
   */
  readonly agent?: AssistantAgent | undefined;
  /** Each of this server's tools' name and title, for what waits for a member's yes. */
  readonly toolTitles?: () => Promise<ReadonlyMap<string, string>>;
  /** What an anonymous visitor may spend: counted for the whole deployment (budget.ts). */
  readonly budget: Budget;
  readonly now: () => number;
}

const WINDOW_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** One person, in ten minutes: a dozen questions of three steps each. */
export const STEPS_PER_PERSON = 40;
/** Everyone in one budget together — guests, or people with accounts — in ten minutes. */
export const STEPS_PER_WINDOW = 200;
/** The same, in a day: the worst a day can cost is twice this many steps. */
export const STEPS_PER_DAY = 2_000;

/**
 * The allowances that stand in front of one assistant step: this person's, the
 * guests' or the accounts' together, and the day's. A step is taken only when
 * all three have room (budget.ts), and counted in the table, so the limits
 * hold across every instance of the server and every restart.
 *
 * Guests and people with accounts are counted apart, each against the same
 * caps. A guest account costs one click, so a flood of them can spend the
 * guests' budget; it must not also be able to silence the person who
 * signed up to look after their mother. And a spent budget silences only
 * the model: the app answers by its rules until the window turns.
 */
export function stepAllowances(userId: string): readonly Allowance[] {
  const group = isGuest(userId) ? 'guest' : 'account';
  return [
    { counter: `assistant#${group}#person#${userId}`, limit: STEPS_PER_PERSON, windowMs: WINDOW_MS },
    { counter: `assistant#${group}#window`, limit: STEPS_PER_WINDOW, windowMs: WINDOW_MS },
    { counter: `assistant#${group}#day`, limit: STEPS_PER_DAY, windowMs: DAY_MS },
  ];
}

/**
 * Whether one more step may be taken now, counting it if so. `cost`: a turn
 * of the agent (turn.ts) counts as several steps; it is taken whole or not
 * at all. A table that cannot be asked allows nothing (budget.ts).
 */
export function createStepLimiter(budget: Budget): (userId: string, cost?: number) => Promise<boolean> {
  return async (userId, cost = 1) => {
    try {
      return await budget.take(stepAllowances(userId), cost);
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: 'assistant_budget_unavailable', error: (err as Error).name || 'Error' }));
      return false;
    }
  };
}

export function createAssistantRouter(options: AssistantRouterOptions): express.Router {
  const { assistant, store, toolSpecs, now } = options;
  const mayStep = createStepLimiter(options.budget);
  const router = express.Router();
  // Any origin, as /api: no cookie is used, and a token is only sent by the page that holds it.
  router.use('/assistant', cors(), options.requireAuth());

  router.post('/assistant/next', async (req, res) => {
    const grant = grantOf(req.auth);
    if (!grant) return void res.status(401).json({ error: 'invalid_token', message: 'Link Wick again.' });
    if (!assistant) return void res.status(503).json({ error: 'assistant_unavailable', message: 'There is no assistant here.' });

    try {
      // INV-9, asked on every step as on every tool call: the refusal is the answer, and costs no model.
      const access = await checkAccess(store, grant.householdId, grant.userId);
      // `refused` says why, for the app to act on: no longer in the circle may mean she has closed the home.
      if (!access.ok) return void res.json({ done: true, say: access.say, refused: access.reason });
      const { household, membership } = access;

      if (!(await mayStep(grant.userId))) {
        return void res.status(429).json({ error: 'assistant_busy', message: 'That is a lot of questions. Give me a few minutes.' });
      }

      const tools = await toolSpecs();
      const turns = readTurns((req.body as { turns?: unknown } | undefined)?.turns, tools);
      if (!turns) return void res.status(400).json({ error: 'not_a_conversation', message: 'I could not follow that.' });

      const step = await nextStep({
        converse: assistant.converse,
        tools,
        who: { memberName: membership.name, residentName: household.residentName, householdName: household.name, simulated: household.simulated === true },
        now: new Date(now()),
        // Where the house is: every time the assistant says is said on its clock.
        timeZone: zoneOf(household),
      }, turns);
      res.json(step);
    } catch (err) {
      // The reason stays in the log: a model's error names accounts and resources.
      console.error(JSON.stringify({ level: 'error', msg: 'assistant_step_failed', error: (err as Error).name || 'Error' }));
      res.status(502).json({ error: 'assistant_failed', message: 'I could not think that through just now.' });
    }
  });

  router.post('/assistant/turn', turnRoute({
    agent: options.agent,
    store,
    toolTitles: options.toolTitles ?? (async () => new Map((await toolSpecs()).map((t) => [t.name, t.name]))),
    mayStep,
    now,
  }));

  return router;
}
