/**
 * One sentence about each calm point, for the break map (page.ts).
 *
 *   AWS_PROFILE=wick-dev npm run calm:describe
 *
 * For every calm point choose.ts picked, the frame just before the cut and
 * the frame just after it are taken from the published encode with ffmpeg
 * (docs/calm-points/frames), and a model on Amazon Bedrock is shown the two
 * and asked what the picture changes from and to.
 *
 * The model describes; it decides nothing. The calm points were chosen
 * before it was asked, by rule, and the television never sees its words.
 * Its sentence is held to a form and a standard (sentence.ts): "From … to
 * ….", one plain sentence, no guessing at feelings or intent — and where it
 * does not meet them, the page simply has no sentence. Silence beats a
 * wrong description.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { readMeasured } from './build.js';
import { chooseCalmPoints } from './choose.js';
import { DESCRIBED_FILE, FRAMES_DIR, frameName } from './page.js';
import { MAX_SENTENCE_WORDS, fitToShow } from './sentence.js';

const ROOT = join(FRAMES_DIR, '..', '..', '..');
const MODEL_ID = process.env.WICK_VISION_MODEL ?? 'amazon.nova-lite-v1:0';
/** How far either side of the cut a frame is taken: clear of any dissolve. */
const BEFORE_CUT_MS = 700;
const AFTER_CUT_MS = 500;

const SYSTEM =
  'You are shown two frames from a film: the first just before a cut, the second just after it. ' +
  'Answer with one sentence in exactly this form: "From <what the first frame shows> to <what the second frame shows>." ' +
  `At most ${MAX_SENTENCE_WORDS} words. Describe only what can be seen in each frame, in plain words. ` +
  'Do not guess at feelings, intentions or what happens next. Answer with the sentence only.';

function frame(programmeId: string, atMs: number, side: 'before' | 'after'): Uint8Array {
  const at = (side === 'before' ? atMs - BEFORE_CUT_MS : atMs + AFTER_CUT_MS) / 1000;
  const file = join(FRAMES_DIR, frameName(programmeId, atMs, side));
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', at.toFixed(3), '-i', join(ROOT, '.programmes', 'out', programmeId, 'index.m3u8'), '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', file]);
  return readFileSync(file);
}

async function main(): Promise<void> {
  mkdirSync(FRAMES_DIR, { recursive: true });
  const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  const described: Record<string, Record<string, string>> = {};

  for (const measured of readMeasured()) {
    described[measured.programmeId] = {};
    for (const point of chooseCalmPoints(measured)) {
      const [before, after] = [frame(measured.programmeId, point.atMs, 'before'), frame(measured.programmeId, point.atMs, 'after')];
      const reply = await bedrock.send(new ConverseCommand({
        modelId: MODEL_ID,
        system: [{ text: SYSTEM }],
        messages: [{ role: 'user', content: [{ image: { format: 'jpeg', source: { bytes: before } } }, { image: { format: 'jpeg', source: { bytes: after } } }, { text: 'The two frames.' }] }],
        inferenceConfig: { maxTokens: 60, temperature: 0 },
      }));
      const sentence = (reply.output?.message?.content?.[0]?.text ?? '').trim().replace(/\s+/g, ' ');
      const kept = fitToShow(sentence);
      if (kept) described[measured.programmeId]![String(point.atMs)] = sentence;
      console.log(`${measured.programmeId} ${point.atMs}: ${kept ? sentence : `(no sentence — not fit to show: "${sentence}")`}`);
    }
  }
  writeFileSync(DESCRIBED_FILE, `${JSON.stringify(described, null, 2)}\n`);
}

await main();
