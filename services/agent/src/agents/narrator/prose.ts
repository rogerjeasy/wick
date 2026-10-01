/**
 * The week, in prose. §5.4: "THE MODEL NEVER COUNTS." The model sees only
 * fact lines that weekFacts.ts already counted — never a raw timestamp —
 * and index.ts checks what comes back. Consistent with
 * prompts/narrator-week.md's own brief.
 *
 * Model ID is the regional cross-region inference profile for Claude
 * Sonnet 4.5. Claude Sonnet 5 is listed in this account, with an inference
 * profile, yet every Converse call to it is refused with
 * AccessDeniedException "not available for this account" — so every weekly
 * run failed until 2026-10-01 (FRICTION.md FL-020). Sonnet 4.5 answers.
 * infra/narrator.tf sets WICK_NARRATIVE_MODEL from the same local it grants
 * InvokeModel on, so the deployed id and the IAM grant cannot drift apart;
 * this default only matters for local runs.
 */
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { MAX_NARRATIVE_CHARS } from '@wick/contracts';

export const NARRATIVE_MODEL_ID =
  process.env.WICK_NARRATIVE_MODEL ?? 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

export const NARRATIVE_REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';

const SYSTEM = `Write the week for a distant family member. The resident reads it first, on their own television.

Rules, all mandatory:
- The facts given are ALL you know. Use only the numbers that appear in them, in digits or words. Never add a number, a clock time, or a count of your own.
- At most two short sentences, under ${MAX_NARRATIVE_CHARS} characters in all.
- Plain, unsensational prose: a thoughtful neighbour's tone, not a report. No "flurry", no "busy", no exclamation.
- If the week is not over, say "so far". If nothing happened, say plainly that it was a quiet week. That is the most valuable sentence you can write.
- Never speculate about how anyone felt, or why anyone came. Report what happened, not what it meant.`;

export async function writeNarrative(
  facts: readonly string[],
  retryReason?: string,
  client: BedrockRuntimeClient = new BedrockRuntimeClient({ region: NARRATIVE_REGION }),
): Promise<string> {
  const prompt = facts.map((f) => `- ${f}`).join('\n') + (retryReason ? `\n\n${retryReason}` : '');
  const res = await client.send(
    new ConverseCommand({
      modelId: NARRATIVE_MODEL_ID,
      system: [{ text: SYSTEM }],
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 120, temperature: 0.3 },
    }),
  );

  const text = res.output?.message?.content?.find((c) => 'text' in c)?.text?.trim();
  if (!text) throw new Error('narrative model returned no text');
  return text;
}
