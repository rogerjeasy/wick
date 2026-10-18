/**
 * The production health report, for the people who run Wick and nobody
 * else: what GET /status used to answer to anyone on the internet.
 *
 * The report says which household is the operator's, how old its Ring token
 * is, how many rows the table holds and what the dead-letter queue has in
 * it. None of that is anybody's business but the operator's, so the route is
 * gone from the public API (infra/edge.tf) and the same Lambda is invoked
 * here, with the operator's own AWS credentials (scripts/ops-status.ts).
 */

export interface StatusCheck {
  readonly id?: unknown;
  readonly label?: unknown;
  readonly status?: unknown;
  readonly detail?: unknown;
}

export interface StatusReport {
  readonly checks: readonly StatusCheck[];
  readonly summary: { readonly healthy: boolean };
}

const MARKS: Record<string, string> = { ok: '✓', warn: '!', fail: '✗', info: '·' };

/** The Lambda's answer, as API Gateway would have been handed it: `{ statusCode, body }` with the report in `body`. */
export function readStatusAnswer(payload: string): StatusReport | undefined {
  try {
    const outer = JSON.parse(payload) as { statusCode?: unknown; body?: unknown };
    if (outer.statusCode !== 200 || typeof outer.body !== 'string') return undefined;
    const report = JSON.parse(outer.body) as { checks?: unknown; summary?: { healthy?: unknown } };
    if (!Array.isArray(report.checks) || typeof report.summary?.healthy !== 'boolean') return undefined;
    return { checks: report.checks as StatusCheck[], summary: { healthy: report.summary.healthy } };
  } catch {
    return undefined;
  }
}

/** One line a check, then the verdict. */
export function statusLines(report: StatusReport): string[] {
  const lines = report.checks.map((check) => {
    const status = String(check.status);
    return `${MARKS[status] ?? '?'} ${String(check.label ?? check.id)}: ${String(check.detail ?? status)}`;
  });
  lines.push(report.summary.healthy ? 'Production is healthy.' : 'Production is NOT healthy.');
  return lines;
}
