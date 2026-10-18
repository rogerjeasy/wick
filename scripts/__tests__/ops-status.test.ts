import { describe, expect, it } from 'vitest';
import { readStatusAnswer, statusLines } from '../ops/status.js';

const answer = (body: unknown, statusCode = 200) => JSON.stringify({ statusCode, body: JSON.stringify(body) });

describe('the operator health report', () => {
  it("reads the status Lambda's answer and says each check on a line", () => {
    const report = readStatusAnswer(answer({
      checks: [
        { id: 'mcpServer', label: 'MCP Server (App Runner)', status: 'ok', detail: '200' },
        { id: 'ringLink', label: 'Ring link', status: 'warn', detail: 'a Playground token ran out' },
      ],
      summary: { healthy: true },
    }));

    expect(statusLines(report!)).toEqual([
      '✓ MCP Server (App Runner): 200',
      '! Ring link: a Playground token ran out',
      'Production is healthy.',
    ]);
  });

  it('says plainly when production is not healthy', () => {
    const report = readStatusAnswer(answer({ checks: [{ id: 'mcpServer', status: 'fail', detail: '503' }], summary: { healthy: false } }));

    expect(statusLines(report!).at(-1)).toBe('Production is NOT healthy.');
  });

  it('refuses anything that is not a report', () => {
    expect(readStatusAnswer('not json')).toBeUndefined();
    expect(readStatusAnswer(answer({ checks: [] }, 500))).toBeUndefined();
    expect(readStatusAnswer(answer({ summary: { healthy: true } }))).toBeUndefined();
  });
});
