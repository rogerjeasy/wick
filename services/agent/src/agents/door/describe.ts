/**
 * Phase 2b — the sentence.
 *
 * "The hard part is not the card. It is the description." (docs/WICK.md S1)
 * "Motion detected" is worthless; "A man in a delivery uniform, holding a
 * parcel" is the product.
 *
 * Nova is used rather than a reasoning model because this is description under
 * a latency budget, not analysis. The constraints are in the prompt AND in
 * validateDescription() — the prompt is a request, the validator is what holds
 * when a visitor's t-shirt slogan or a sign in shot talks the model out of it.
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { parseDescribeReply, validateDescription, type DescriptionCandidate } from './index.js';

/** Vision-capable, fast, cheap. §5.1. */
export const DESCRIBE_MODEL_ID = process.env.WICK_VISION_MODEL ?? 'amazon.nova-lite-v1:0';

/** Hard cancel. A description that arrives after this is worse than none. */
export const DESCRIBE_TIMEOUT_MS = 2500;

/**
 * Lambda sets AWS_REGION for us; a laptop does not, and the SDK's failure for a
 * missing region ("Region is missing") looks nothing like a configuration
 * problem when it surfaces through the describe path.
 */
export const DESCRIBE_REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';

/** Shared with the Strands describe agent (graphs/doorDescribe.ts). */
export const DESCRIBE_SYSTEM_PROMPT = `You describe a single still frame from a doorbell camera for an older adult reading it on a television.

Reply in exactly two lines:
PERSON: yes   (or: PERSON: no) — whether any person is visible in the frame
<the description>

Rules for the description, all mandatory:
- One sentence. Present tense. At most 14 words.
- Only what is visibly there. Never infer intent, mood, purpose or identity.
- Never use: seems, appears, probably, likely, might, trying, waiting for.
- Never name anyone.
- If the frame is unclear, empty, or you are not confident, reply with exactly: UNCLEAR

Good:
PERSON: yes
A man in a delivery uniform, holding a parcel.

Good:
PERSON: no
An empty porch with a parcel on the step.

Bad:
Someone who seems to be a delivery driver waiting patiently.`;

export interface DescribeResult {
  readonly candidate: DescriptionCandidate | null;
  readonly reason: string;
  readonly elapsedMs: number;
}

/**
 * What a model's raw reply is worth: a candidate to show, or a reason not to.
 * Shared by describeFrame and the Strands describe graph, so the validator
 * holds the same way whichever path asked the model.
 */
export function judgeDescribeReply(raw: string): Omit<DescribeResult, 'elapsedMs'> {
  const { personVisible, sentence: text } = parseDescribeReply(raw.trim());

  if (!text) return { candidate: null, reason: 'model returned nothing' };
  if (/^UNCLEAR\b/i.test(text)) return { candidate: null, reason: 'model declined: unclear frame' };
  // Worth logging loudly: it means the prompt is losing to the image.
  if (!validateDescription(text)) return { candidate: null, reason: `rejected by validator: "${text}"` };

  const candidate: DescriptionCandidate = {
    description: text,
    confidence: 0.9,
    ...(personVisible === undefined ? {} : { personVisible }),
  };
  return { candidate, reason: 'ok' };
}

/**
 * Describe a frame, or decline to.
 *
 * Never throws: every failure path returns a null candidate with a reason,
 * because the caller's correct response to all of them is identical — leave
 * Phase 1 on screen. Turning that into exception handling at each call site
 * would be the only way to get it wrong.
 */
export async function describeFrame(
  imageBytes: Uint8Array,
  format: 'jpeg' | 'png' = 'jpeg',
  client = new BedrockRuntimeClient({ region: DESCRIBE_REGION }),
): Promise<DescribeResult> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;

  const content: ContentBlock[] = [
    { image: { format, source: { bytes: imageBytes } } },
    { text: 'Describe this frame under the rules.' },
  ];

  try {
    const res = await client.send(
      new ConverseCommand({
        modelId: DESCRIBE_MODEL_ID,
        system: [{ text: DESCRIBE_SYSTEM_PROMPT }],
        messages: [{ role: 'user', content }],
        inferenceConfig: { maxTokens: 60, temperature: 0.2 },
      }),
      { requestTimeout: DESCRIBE_TIMEOUT_MS },
    );

    const raw = res.output?.message?.content?.find((c) => 'text' in c)?.text?.trim() ?? '';
    return { ...judgeDescribeReply(raw), elapsedMs: elapsed() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // In Lambda the role supplies credentials; on a laptop nothing does, and
    // the SDK's wording sends you looking at Bedrock rather than at your shell.
    const hint = /credential/i.test(message)
      ? ' — no AWS credentials in this shell; try AWS_PROFILE=wick-dev'
      : /region/i.test(message)
        ? ' — no AWS region; try AWS_REGION=us-east-1'
        : '';

    return { candidate: null, reason: `bedrock: ${message}${hint}`, elapsedMs: elapsed() };
  }
}
