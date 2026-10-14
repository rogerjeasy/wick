/**
 * What the deployed Wick server is allowed, and given, to hear by voice
 * (infra/mcp.tf) — read from the Terraform as it is checked in, the way
 * scripts/__tests__/addon-package.test.ts reads infra/variables.tf.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = (path: string) => fileURLToPath(new URL(`../../../../../${path}`, import.meta.url));
const mcp = readFileSync(root('infra/mcp.tf'), 'utf8');

/** The body of one `data "aws_iam_policy_document" "<name>"` block, by brace counting. */
function block(source: string, header: string): string {
  const start = source.indexOf(header);
  expect(start, header).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated ${header}`);
}

/** Each `statement { … }` in a policy document, by brace counting. */
function statements(policy: string): string[] {
  const found: string[] = [];
  let at = policy.indexOf('statement {');
  while (at >= 0) {
    found.push(block(policy.slice(at), 'statement {'));
    at = policy.indexOf('statement {', at + 1);
  }
  return found;
}

describe('infra/mcp.tf — the App Runner instance role may hear', () => {
  const policy = block(mcp, 'data "aws_iam_policy_document" "apprunner_instance" {');

  it('allows transcribe:StartStreamTranscription, on "*" (the action has no resource type), and no other Transcribe action', () => {
    const transcribe = statements(policy).filter((s) => s.includes('transcribe:'));
    expect(transcribe).toHaveLength(1);
    expect(transcribe[0]).toMatch(/actions\s*=\s*\["transcribe:StartStreamTranscription"\]/);
    expect(transcribe[0]).toMatch(/resources\s*=\s*\["\*"\]/);
    expect(policy.match(/"transcribe:[A-Za-z*]+"/g)).toEqual(['"transcribe:StartStreamTranscription"']);
  });

  it('gives App Runner no new setting for it: the server finds its region as its other AWS clients do', () => {
    const env = block(mcp, 'runtime_environment_variables = merge(');
    expect(env).not.toMatch(/TRANSCRIBE|HEAR/i);
  });
});
