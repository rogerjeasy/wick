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
 * A model costs money and a guest account costs nothing (accounts/demo.ts),
 * so each person may take a bounded number of steps in a while. Where no
 * model is configured the route says so, and the app falls back to the
 * rules it used before there was one.
 */
import cors from 'cors';
import express, { type RequestHandler } from 'express';
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

/** A long conversation is twenty questions of three steps each; nobody needs more in ten minutes. */
export const STEPS_PER_WINDOW = 60;
const WINDOW_MS = 10 * 60_000;
const MAX_TRACKED = 5_000;

/** Fixed windows per person, held in this process — one instance serves the deployment (infra/mcp.tf). */
function createStepLimiter(now: () => number): (userId: string) => boolean {
  const windows = new Map<string, { start: number; taken: number }>();
  return (userId) => {
    const at = now();
    if (windows.size > MAX_TRACKED) for (const [id, w] of windows) if (at - w.start >= WINDOW_MS) windows.delete(id);
    const current = windows.get(userId);
    if (!current || at - current.start >= WINDOW_MS) {
      windows.set(userId, { start: at, taken: 1 });
      return true;
    }
    if (current.taken >= STEPS_PER_WINDOW) return false;
    current.taken += 1;
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
    if (!mayStep(grant.userId)) {
      return void res.status(429).json({ error: 'assistant_busy', message: 'That is a lot of questions. Give me a few minutes.' });
    }

    try {
      const tools = await toolSpecs();
      const turns = readTurns((req.body as { turns?: unknown } | undefined)?.turns, tools);
      if (!turns) return void res.status(400).json({ error: 'not_a_conversation', message: 'I could not follow that.' });

      const [household, membership] = await Promise.all([
        store.getHousehold(grant.householdId),
        store.getMembership(grant.householdId, grant.userId),
      ]);
      if (!household || !membership) return void res.status(401).json({ error: 'invalid_token', message: 'Link Wick again.' });

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
