/**
 * The Sunday brief — each home's week, as a Strands Graph, run on AgentCore
 * (runtime kind `brief.weekly`).
 *
 *   analyst (code) ─▶ writer (Agent · Sonnet) ─▶ check (code) ─▶ suggester (Agent · structured) ─▶ validate (code) ─▶ store (code)
 *      ▲                                            │
 *      └──────────── once, with the reason ─────────┘
 *
 * The Narrator's rules hold, and are the same code: THE MODEL NEVER COUNTS
 * (the analyst counts with summariseWeek, weekDeltas and factLines, and
 * adds the week's errands and whether a film was played, agents/brief/
 * facts.ts), and the model's prose is checked rather than trusted. The
 * check is now three: the Narrator's numbers-and-comparisons check, the
 * Guardian (INV-2, the household's own policy), and the Bedrock Guardrail
 * with contextual grounding against the fact lines (agents/brief/
 * guardrail.ts). A refused draft goes back to the writer once, with the
 * reason; a second refusal, or a Guardrail that cannot be asked, and the
 * week is written from the facts alone (fallbackNarrative) — never a
 * paragraph nobody checked.
 *
 * Then one suggestion for the family member, from a fixed menu, as Strands
 * structured output (a zod schema, agents/brief/suggestion.ts), judged by
 * code: an action the week does not support, a reason with a number the
 * facts never gave, one the Guardian or the Guardrail refuses — any of it,
 * and the suggestion is "nothing".
 *
 * store writes the week where the Narrator does, and sends her the week
 * card (INV-7: she reads it first; nothing here sets residentSeenAt). A
 * demo home's simulated week is kept simulated, and gets no card: nobody
 * lived it (agents/brief/store.ts).
 *
 * Why the retry goes back through the analyst: the TypeScript SDK's Graph
 * runs a node only when every one of its incoming edges is satisfied (AND,
 * where the Python SDK uses OR). A writer with two incoming edges — the
 * analyst's and the check's — would wait for a check that cannot run before
 * it. So the cycle is analyst → writer → check → analyst, the analyst is the
 * graph's declared source, and on its second visit it hands the writer the
 * same facts with the reason the draft was refused (FRICTION.md FL-047).
 *
 * Never throws: a node that fails ends the run, and the result says so —
 * whether anything was stored — so the worker can fall back to the Narrator
 * for that one home.
 */
import { Agent, BedrockModel, Graph, type Model } from '@strands-agents/sdk';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import type { BriefSuggestion, RhythmDelta, SuggestedAction, TimelineEntry, WeekNarrative } from '@wick/contracts';
import { clearForFamily, type HouseholdPolicy } from '@wick/policy';
import { countWeek } from '../agents/narrator/index.js';
import { isoWeekRange, type WeekRange } from '../agents/narrator/isoWeek.js';
import { comparisonLines } from '../agents/narrator/comparisons.js';
import { checkNarrative, factLines, fallbackNarrative, refusalReason, type WeekFacts } from '../agents/narrator/weekFacts.js';
import { NARRATIVE_MODEL_ID, NARRATIVE_REGION, NARRATIVE_SYSTEM_PROMPT } from '../agents/narrator/prose.js';
import { baselineWindow } from '../rhythm/baseline.js';
import { FILM_LINE, errandLines, missedUsualVisit, readErrandRow, watchedFilms } from '../agents/brief/facts.js';
import { checkWithGuardrail, type GuardrailRef, type GuardrailSend } from '../agents/brief/guardrail.js';
import { NO_SUGGESTION, SUGGESTER_SYSTEM_PROMPT, allowedActions, judgeSuggestion, suggestionSchema, type SuggestionContext } from '../agents/brief/suggestion.js';
import type { KeptFromSimulated, StoredWeek } from '../agents/brief/store.js';
import { StepNode, pathOf, when } from './step.js';
import type { GraphRun } from './doorAction.js';

type Item = Record<string, AttributeValue>;

export const BRIEF_NODES = { analyst: 'analyst', writer: 'writer', check: 'check', suggester: 'suggester', validate: 'validate', store: 'store' } as const;

/** A draft is written at most this many times; then the facts speak for themselves. */
export const WRITER_ATTEMPTS = 2;

export interface WeeklyBriefDeps {
  readonly writerModel: Model;
  readonly suggesterModel: Model;
  /** Called once, with the week and the six before it (rhythm/baseline.ts baselineWindow). */
  readonly loadEvents: (range: WeekRange) => Promise<readonly Item[]>;
  /** The household's first recorded event, ever — where its baseline can begin. */
  readonly firstEventAt: () => Promise<number | undefined>;
  /** The household's ERRAND# rows (read defensively: agents/brief/facts.ts). */
  readonly loadErrands: () => Promise<readonly Item[]>;
  /** The household's RHYTHM#tv_activity# rows: whether a film was played. */
  readonly loadTvActivity: () => Promise<readonly Item[]>;
  /** What she keeps private: the Guardian reads with it. */
  readonly loadPolicy: () => Promise<HouseholdPolicy>;
  /**
   * The household's own people, by name — the resident, her regular visitors, her circle. A week names them,
   * and the Guardian cannot read a name in Cyrillic or Chinese unless it is told whose it is. Absent, nobody is:
   * every name in another script then makes the draft refused, and the week is written from the facts.
   */
  readonly loadPeople?: () => Promise<readonly string[]>;
  readonly guardrail: GuardrailSend;
  /** Undefined in a deployment with no Guardrail: every draft then falls back to the facts. */
  readonly guardrailRef: GuardrailRef | undefined;
  /** False when the row changed since it was read: nothing is written (agents/brief/store.ts). */
  readonly saveWeek: (narrative: WeekNarrative, existing: StoredWeek | undefined) => Promise<boolean>;
  /** Her copy, on her own television (narrator/weekCard.ts). */
  readonly sendWeekCard: (narrative: WeekNarrative) => Promise<void>;
  readonly now: () => number;
  /** The household's IANA time zone: "Wednesday evening" means theirs. */
  readonly timeZone: string;
}

export interface BriefInput {
  readonly householdId: string;
  readonly isoWeek: string;
  /** The row as it was read, if there was one: the write is conditional on it. */
  readonly existing?: StoredWeek;
  /** A demo home's simulated week: what the rewrite keeps (agents/brief/store.ts briefDecision). */
  readonly keep?: KeptFromSimulated;
}

export type BriefOutcome =
  | { readonly status: 'written'; readonly textSource: 'agents' | 'facts'; readonly suggestion: BriefSuggestion; readonly attempts: number }
  | { readonly status: 'not_written'; readonly why: 'changed_while_written' }
  | { readonly status: 'failed'; readonly error: string; readonly stored: boolean };

/** The writer's rules: the Narrator's, and how to treat the brief's own lines. */
export const WRITER_SYSTEM_PROMPT = `${NARRATIVE_SYSTEM_PROMPT}
- A line about a visit the family arranged, or a film played, is a fact like the others: mention it only as it is given, or leave it out.
- Never suggest anything the family could do: no advice, no "one thing you could do". Another step chooses the one suggestion.
- Reply with the paragraph only.`;

const WRITER_QUESTION = 'How was the week at home?';
/**
 * The question a reason answers, the query contextual grounding needs: the
 * reason for a note is asked against "why send a note", not against a
 * question about the whole week it was never trying to answer.
 */
const SUGGESTER_QUESTION: Readonly<Record<SuggestedAction, string>> = {
  send_note: 'Why might the family member send a note to her television this week?',
  arrange_visit: 'Why might the family member arrange a visit this week?',
  watch_together: 'Why might the family member invite her to watch a film together this week?',
  nothing: 'Why does this week need nothing more than reading it?',
};

export function briefModel(maxTokens: number): Model {
  return new BedrockModel({ modelId: NARRATIVE_MODEL_ID, region: NARRATIVE_REGION, maxTokens, temperature: 0.3 });
}

function buildAgent(id: string, model: Model, systemPrompt: string, description: string, structured = false): Agent {
  return new Agent({
    id,
    name: `brief-${id}`,
    description,
    model,
    systemPrompt,
    // No tools on purpose: the facts are handed over, never looked up.
    tools: [],
    printer: false,
    ...(structured ? { structuredOutputSchema: suggestionSchema } : {}),
  });
}

/** What the analyst found: everything after it reads this, never the raw rows. */
interface Analysed {
  readonly facts: WeekFacts;
  readonly deltas: RhythmDelta[];
  readonly timeline: TimelineEntry[];
  readonly lines: string[];
  readonly context: SuggestionContext;
  readonly policy: HouseholdPolicy;
  /** The household's own people, by name: the Guardian sets aside their names in other scripts (policy foreign.ts). */
  readonly people: readonly string[];
  readonly generatedAt: number;
}

const bullets = (lines: readonly string[]) => lines.map((l) => `- ${l}`).join('\n');
const log = (line: Record<string, unknown>) => console.log(JSON.stringify(line));

export function buildWeeklyBriefGraph(input: BriefInput, deps: WeeklyBriefDeps) {
  const range = isoWeekRange(input.isoWeek);
  let analysed: Analysed | undefined;
  let attempts = 0;
  let retryReason: string | undefined;
  let text: string | undefined;
  let textSource: 'agents' | 'facts' = 'facts';
  let suggestion: BriefSuggestion = NO_SUGGESTION;
  let stored = false;
  let outcome: BriefOutcome | undefined;

  const analyst = new StepNode(BRIEF_NODES.analyst, async () => {
    if (!analysed) {
      // A simulated week is counted as it was when it was first written, so the rewrite tells the same week.
      const now = input.keep?.generatedAt ?? deps.now();
      const [rawItems, observedSince, errandRows, tvRows, policy, people] = await Promise.all([
        deps.loadEvents(baselineWindow(range)),
        deps.firstEventAt(),
        deps.loadErrands(),
        deps.loadTvActivity(),
        deps.loadPolicy(),
        // A circle that cannot be read costs a name in another script its place in the draft, never the household its week.
        (deps.loadPeople?.() ?? Promise.resolve<readonly string[]>([])).catch(() => []),
      ]);
      const { timeline, facts, deltas } = countWeek(rawItems, range, { now, timeZone: deps.timeZone, observedSince });
      const errands = errandRows.map(readErrandRow).filter((e) => e !== undefined);
      const films = watchedFilms(tvRows, range);
      const lines = [...factLines(facts), ...comparisonLines(deltas, facts.weekComplete), ...errandLines(errands, range), ...(films ? [FILM_LINE] : [])];
      analysed = { facts, deltas, timeline, lines, context: { missedUsualVisit: missedUsualVisit(deltas), watchedFilms: films }, policy, people, generatedAt: now };
    }
    const facts = `The facts:\n${bullets(analysed.lines)}`;
    return retryReason ? `${facts}\n\nYour last draft was refused: ${retryReason}` : facts;
  }, 'Counts the week from the timeline, its errands and its films: the only facts the writer is shown');

  const writer = buildAgent(BRIEF_NODES.writer, deps.writerModel, WRITER_SYSTEM_PROMPT, 'Writes the week in two short sentences, from the facts only.');

  const check = new StepNode(BRIEF_NODES.check, async (ctx) => {
    const week = analysed!;
    attempts += 1;
    const draft = ctx.output(BRIEF_NODES.writer).trim();
    let refused: string | undefined;
    let unchecked = false;

    const numbers = checkNarrative(draft, week.facts, week.deltas);
    if (!numbers.ok) refused = refusalReason(numbers);
    else if (!clearForFamily(draft, week.policy, { people: week.people }).cleared) {
      refused = 'Your draft named something Wick never tells the family: health, care, money or anything private. Leave it out.';
    } else {
      try {
        const grounded = await checkWithGuardrail(deps.guardrail, deps.guardrailRef, { source: week.lines, query: WRITER_QUESTION, content: draft });
        if (!grounded.ok) refused = `A check found that ${grounded.reason}. Say only what the facts say.`;
      } catch (err) {
        // Nobody could check it, so it is not written: the facts are.
        unchecked = true;
        log({ level: 'warn', msg: 'brief_guardrail_unavailable', isoWeek: input.isoWeek, error: (err as Error).message || String(err) });
      }
    }

    if (!refused && !unchecked) {
      text = draft;
      textSource = 'agents';
      ctx.set('check', 'done');
    } else if (refused && attempts < WRITER_ATTEMPTS) {
      retryReason = refused;
      // Why, never what: the reason is the one the writer is told, not its words.
      log({ level: 'warn', msg: 'brief_draft_refused', isoWeek: input.isoWeek, attempt: attempts, why: refused });
      ctx.set('check', 'retry');
      return refused;
    } else {
      text = fallbackNarrative(week.facts, week.deltas);
      textSource = 'facts';
      ctx.set('check', 'done');
    }
    const allowed = allowedActions(week.context).join(', ');
    return `The paragraph about the week:\n${text}\n\nThe facts:\n${bullets(week.lines)}\n\nAllowed actions this week: ${allowed}.`;
  }, 'The Narrator’s number check, the Guardian, and the Bedrock Guardrail’s contextual grounding');

  const suggester = buildAgent(BRIEF_NODES.suggester, deps.suggesterModel, SUGGESTER_SYSTEM_PROMPT, 'Picks one thing the family member could do, from a fixed menu.', true);

  const validate = new StepNode(BRIEF_NODES.validate, async (ctx) => {
    const week = analysed!;
    const verdict = judgeSuggestion(ctx.structured(BRIEF_NODES.suggester), week.context, week.policy, (t) => checkNarrative(t, week.facts, week.deltas).ok, week.people);
    if (!verdict.ok) {
      log({ level: 'warn', msg: 'brief_suggestion_refused', isoWeek: input.isoWeek, why: verdict.why });
      return 'nothing';
    }
    try {
      const grounded = await checkWithGuardrail(deps.guardrail, deps.guardrailRef, { source: week.lines, query: SUGGESTER_QUESTION[verdict.suggestion.action], content: verdict.suggestion.reason });
      if (!grounded.ok) {
        log({ level: 'warn', msg: 'brief_suggestion_refused', isoWeek: input.isoWeek, why: 'guardrail' });
        return 'nothing';
      }
    } catch (err) {
      log({ level: 'warn', msg: 'brief_guardrail_unavailable', isoWeek: input.isoWeek, error: (err as Error).message || String(err) });
      return 'nothing';
    }
    suggestion = verdict.suggestion;
    return suggestion.action;
  }, 'Only an action the week supports, with a reason that passes the Guardian and the Guardrail — else nothing');

  const store = new StepNode(BRIEF_NODES.store, async () => {
    const week = analysed!;
    const narrative: WeekNarrative = {
      householdId: input.householdId,
      isoWeek: input.isoWeek,
      text: text!,
      textSource,
      suggestion,
      deltas: week.deltas,
      timeline: week.timeline,
      generatedAt: week.generatedAt,
      ...(input.keep?.residentSeenAt === undefined ? {} : { residentSeenAt: input.keep.residentSeenAt }),
      ...(input.keep ? { simulated: true as const } : {}),
    };
    if (!(await deps.saveWeek(narrative, input.existing))) {
      outcome = { status: 'not_written', why: 'changed_while_written' };
      return 'unchanged';
    }
    stored = true;
    // Her copy first (INV-7). A simulated week was "read" by nobody, and gets no card.
    if (!input.keep) await deps.sendWeekCard(narrative);
    outcome = { status: 'written', textSource, suggestion, attempts };
    return 'stored';
  }, 'The week, where the Narrator writes it, and her copy on her television');

  const graph = new Graph({
    id: 'weekly-brief',
    nodes: [analyst, writer, check, suggester, validate, store],
    sources: [BRIEF_NODES.analyst],
    edges: [
      [BRIEF_NODES.analyst, BRIEF_NODES.writer],
      [BRIEF_NODES.writer, BRIEF_NODES.check],
      { source: BRIEF_NODES.check, target: BRIEF_NODES.analyst, handler: when<string>('check', (c) => c === 'retry') },
      { source: BRIEF_NODES.check, target: BRIEF_NODES.suggester, handler: when<string>('check', (c) => c === 'done') },
      [BRIEF_NODES.suggester, BRIEF_NODES.validate],
      [BRIEF_NODES.validate, BRIEF_NODES.store],
    ],
    // analyst, writer, check twice; then suggester, validate, store.
    maxSteps: 3 * WRITER_ATTEMPTS + 3,
    nodeTimeout: 45_000,
    timeout: 150_000,
  });

  return { graph, outcome: () => outcome, stored: () => stored };
}

export async function runWeeklyBriefGraph(input: BriefInput, deps: WeeklyBriefDeps): Promise<GraphRun<BriefOutcome>> {
  const built = buildWeeklyBriefGraph(input, deps);
  try {
    // The task reaches every node, the writer's included: it asks for the week only. The suggester's
    // own rules ask it for the one suggestion (live, a task that asked for one had the writer add advice).
    const run = await built.graph.invoke(`Write the week ${input.isoWeek} for the family.`);
    const failed = run.results.find((r) => r.status !== 'COMPLETED');
    const outcome = built.outcome();
    if (failed || !outcome) {
      return { result: { status: 'failed', error: `${failed?.nodeId ?? 'graph'}: ${failed?.error?.message ?? 'did not finish'}`, stored: built.stored() }, path: pathOf(run) };
    }
    return { result: outcome, path: pathOf(run) };
  } catch (err) {
    return { result: { status: 'failed', error: err instanceof Error ? err.message : String(err), stored: built.stored() }, path: [] };
  }
}
