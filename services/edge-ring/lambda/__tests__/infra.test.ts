/**
 * The Ring webhook as infra/edge.tf and infra/variables.tf deploy it, read
 * the way errand/__tests__/infra.test.ts reads infra/errands.tf.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), 'utf8');

describe("the Ring webhook's own concurrency", () => {
  it('keeps 20 for the webhook alone, now that the account quota is 1,000, so the agent plane can never starve Ring\'s five-second acknowledgement', () => {
    const variable = /variable "ring_webhook_reserved_concurrency" \{[\s\S]*?\n\}/.exec(read('infra/variables.tf'))![0];
    expect(variable).toMatch(/default\s*=\s*20\b/);
    expect(read('infra/edge.tf')).toMatch(/reserved_concurrent_executions = var\.ring_webhook_reserved_concurrency/);
  });
});
