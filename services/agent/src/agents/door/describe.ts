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
import { validateDescription, type DescriptionCandidate } from './index.js';

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

const SYSTEM = `You describe a single still frame from a doorbell camera for an older adult reading it on a television.

Rules, all mandatory:
- One sentence. Present tense. At most 14 words.
- Only what is visibly there. Never infer intent, mood, purpose or identity.
- Never use: seems, appears, probably, likely, might, trying, waiting for.
- Never name anyone.
- If the frame is unclear, empty, or you are not confident, reply with exactly: UNCLEAR

Good: A man in a delivery uniform, holding a parcel.
Good: Two people standing at the door with a large box.
Bad:  Someone who seems to be a delivery driver waiting patiently.`;

export interface DescribeResult {
  readonly candidate: DescriptionCandidate | null;
  readonly reason: string;
  readonly elapsedMs: number;
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
        system: [{ text: SYSTEM }],
        messages: [{ role: 'user', content }],
        inferenceConfig: { maxTokens: 60, temperature: 0.2 },
      }),
      { requestTimeout: DESCRIBE_TIMEOUT_MS },
    );

    const text = res.output?.message?.content?.find((c) => 'text' in c)?.text?.trim() ?? '';

    if (!text) return { candidate: null, reason: 'model returned nothing', elapsedMs: elapsed() };
    if (/^UNCLEAR\b/i.test(text)) {
      return { candidate: null, reason: 'model declined: unclear frame', elapsedMs: elapsed() };
    }
    if (!validateDescription(text)) {
      // Worth logging loudly: it means the prompt is losing to the image.
      return { candidate: null, reason: `rejected by validator: "${text}"`, elapsedMs: elapsed() };
    }

    return { candidate: { description: text, confidence: 0.9 }, reason: 'ok', elapsedMs: elapsed() };
  } catch (err) {
    return {
      candidate: null,
      reason: `bedrock: ${err instanceof Error ? err.message : String(err)}`,
      elapsedMs: elapsed(),
    };
  }
}
