/**
 * The week, in prose. §5.4: "THE MODEL NEVER COUNTS." Every fact in the
 * prompt is already computed deterministically (timeline.ts, isoWeek.ts) —
 * this only asks the model to narrate a list it is forbidden from
 * recalculating, consistent with prompts/narrator-week.md's own brief.
 *
 * Model ID default is a best-known Claude Sonnet-class id at the time this
 * was written — Bedrock model catalogs move, and Anthropic model
 * availability varies by account and region. Confirm it against what this
 * deployment's Bedrock account actually has enabled before relying on it;
 * override via WICK_NARRATIVE_MODEL if it doesn't match.
 */
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { TimelineEntry } from '@wick/contracts';

export const NARRATIVE_MODEL_ID =
  process.env.WICK_NARRATIVE_MODEL ?? 'anthropic.claude-sonnet-4-5-20250929-v1:0';

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
