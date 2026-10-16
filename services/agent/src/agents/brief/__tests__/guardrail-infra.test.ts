/**
 * The Guardrail as it is checked in (infra/guardrail.tf), read the way
 * errand/__tests__/infra.test.ts reads infra/errands.tf. The thresholds were
 * measured on the deployed guardrail (FRICTION.md FL-048); this keeps them.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const guardrail = readFileSync(fileURLToPath(new URL('../../../../../../infra/guardrail.tf', import.meta.url)), 'utf8');
const code = guardrail
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n');

describe('infra/guardrail.tf — the contextual grounding check', () => {
  it('grounds at 0.5: faithful paraphrases scored 0.68 to 1.00, sentences adding anything 0.00 to 0.04', () => {
    expect(code).toMatch(/type\s*=\s*"GROUNDING"\s*\n\s*threshold\s*=\s*0\.5\b/);
  });

  it('has no relevance filter: it scored honest answers about her week 0.07 to 0.15 and refused them', () => {
    // "How has my mum been this week?" is answered with what the house saw,
    // never with how she feels, and the relevance score reads that honesty
    // as not answering the question. Grounding and the denied topics are the
    // checks that matter; relevance only refused the true answers.
    expect(code).not.toMatch(/"RELEVANCE"/);
  });
});
