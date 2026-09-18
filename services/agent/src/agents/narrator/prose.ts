/**
 * The week, in prose. §5.4: "THE MODEL NEVER COUNTS." Every fact in the
 * prompt is already computed deterministically (timeline.ts, isoWeek.ts) —
 * this only asks the model to narrate a list it is forbidden from
 * recalculating, consistent with prompts/narrator-week.md's own brief.
 *
 * Model ID is the regional cross-region inference profile for Claude
 * Sonnet 5 — confirmed against this deployment's actual Bedrock account
 * (`aws bedrock list-foundation-models`/`list-inference-profiles`,
 * 2026-09-18). The bare foundation-model id (anthropic.claude-sonnet-5) is
 * also ACTIVE in this account, but newer large Anthropic models on Bedrock
 * typically require invocation through an inference profile rather than
 * on-demand throughput on the bare id — this account has one provisioned
 * for exactly this model, which is the strong signal it's the required
 * path. infra/narrator.tf's IAM grants InvokeModel on both this profile
 * ARN and the underlying foundation-model ARN it routes to, which AWS
 * requires for cross-region inference profile invocation.
 */
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { TimelineEntry } from '@wick/contracts';

export const NARRATIVE_MODEL_ID =
  process.env.WICK_NARRATIVE_MODEL ?? 'us.anthropic.claude-sonnet-5';

export const NARRATIVE_REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';

const SYSTEM = `Write the week for a distant family member.

Rules, all mandatory:
- The events listed are ALL the facts you have. Never invent, infer, count, or round a number that isn't already in the list.
- One short paragraph. Plain, unsensational prose — a thoughtful neighbour's tone, not a report.
- If the list is empty, say plainly that it was a quiet week. That is the most valuable sentence you can write, not a failure to find something to say.
- Never speculate about how anyone felt. Report what happened, not what it meant.`;

function describeEvents(entries: readonly TimelineEntry[]): string {
  if (entries.length === 0) return '(no events this week)';
  return entries
    .slice()
    .sort((a, b) => a.at - b.at)
    .map((e) => `- ${new Date(e.at).toISOString()}: ${e.summary}`)
    .join('\n');
}

export async function writeNarrative(
  entries: readonly TimelineEntry[],
  client: BedrockRuntimeClient = new BedrockRuntimeClient({ region: NARRATIVE_REGION }),
): Promise<string> {
  const res = await client.send(
    new ConverseCommand({
      modelId: NARRATIVE_MODEL_ID,
      system: [{ text: SYSTEM }],
      messages: [{ role: 'user', content: [{ text: describeEvents(entries) }] }],
      inferenceConfig: { maxTokens: 200, temperature: 0.3 },
    }),
  );

  const text = res.output?.message?.content?.find((c) => 'text' in c)?.text?.trim();
  if (!text) throw new Error('narrative model returned no text');
  return text;
}
