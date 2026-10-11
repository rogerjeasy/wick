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
import { grantOf } from '../accounts/oauthProvider.js';
import type { AccountStore } from '../accounts/store.js';
import { nextStep, readTurns, type Converse, type ToolSpec } from './brain.js';

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
  readonly now: () => number;
  readonly timeZone: string;
}

const WINDOW_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** One person, in ten minutes: a dozen questions of three steps each. */
export const STEPS_PER_PERSON = 40;
/** Everyone together, in ten minutes. */
export const STEPS_PER_WINDOW = 300;
/** Everyone together, in a day. */
export const STEPS_PER_DAY = 3_000;

/**
 * Whether one more step may be taken now, counting it if so. Fixed windows
 * held in this process — one instance serves the deployment (infra/mcp.tf).
 * Everyone's ten minutes start together, so what is remembered is never
 * more than one window's worth of people.
 */
export function createStepLimiter(now: () => number): (userId: string) => boolean {
  let windowStart = now();
  let windowTaken = 0;
  let dayStart = windowStart;
  let dayTaken = 0;
  const people = new Map<string, number>();

  return (userId) => {
    const at = now();
    if (at - windowStart >= WINDOW_MS) {
      windowStart = at;
      windowTaken = 0;
      people.clear();
    }
    if (at - dayStart >= DAY_MS) {
      dayStart = at;
      dayTaken = 0;
    }
    const mine = people.get(userId) ?? 0;
    if (dayTaken >= STEPS_PER_DAY || windowTaken >= STEPS_PER_WINDOW || mine >= STEPS_PER_PERSON) return false;
    people.set(userId, mine + 1);
    windowTaken += 1;
    dayTaken += 1;
    return true;
  };
}

export function createAssistantRouter(options: AssistantRouterOptions): express.Router {
  const { assistant, store, toolSpecs, now, timeZone } = options;
  const mayStep = createStepLimiter(now);
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
      if (!access.ok) return void res.json({ done: true, say: access.say });
      const { household, membership } = access;

      if (!mayStep(grant.userId)) {
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
        timeZone,
      }, turns);
      res.json(step);
    } catch (err) {
      // The reason stays in the log: a model's error names accounts and resources.
      console.error(JSON.stringify({ level: 'error', msg: 'assistant_step_failed', error: (err as Error).name || 'Error' }));
      res.status(502).json({ error: 'assistant_failed', message: 'I could not think that through just now.' });
    }
  });

  return router;
}
