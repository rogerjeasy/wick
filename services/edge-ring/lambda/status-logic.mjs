/**
 * Pure interpretation logic for GET /status (status.mjs is the I/O-heavy
 * composition root; this file has no AWS calls, no fetch, no Date.now()
 * default reliance in tests — everything here is a deterministic function
 * of its inputs, which is what makes it worth testing exhaustively).
 *
 * The one non-obvious design choice: statuses are three-valued (`ok` /
 * `warn` / `fail`), not boolean. `ringIntegrationCompleted` in particular
 * is a documented, accepted platform gap (FRICTION.md FL-010) — showing it
 * as a scary red failure on every load of the dashboard would be a false
 * alarm repeated forever. `warn` exists so the dashboard can say "known
 * limitation" in amber instead of "something is broken" in red.
 */
import { expiresAt } from './token-policy.mjs';

/** Mirrors ring-link-status.sh's own derived fields — never the raw tokens. */
export function interpretRingLink(record, now = Date.now()) {
  if (!record?.access_token) {
    return { linked: false, hasRefresh: false, hasAccountId: false, expiresInMinutes: 0, integrationCompleted: false };
  }
  const minutes = Math.max(0, Math.round((expiresAt(record) - now) / 60_000));
  return {
    linked: true,
    hasRefresh: Boolean(record.refresh_token),
    hasAccountId: Boolean(record.accountId),
    expiresInMinutes: minutes,
    integrationCompleted: Boolean(record.integrationCompletedAt),
  };
}

const HTTP_EXPECTATIONS = {
  mcpServer: { code: 200, label: 'MCP Server (App Runner)' },
  simAlexa: { code: 200, label: 'sim-alexa (CloudFront)' },
  ringAuthorize: { code: 302, label: 'Ring /authorize' },
  ringWebhook: { code: 401, label: 'Ring /webhook (unsigned rejected)' },
  pairingApi: { code: 404, label: 'Pairing API' },
  websocket: { code: 426, label: 'WebSocket transport' },
};

function httpCheck(id, actualCode) {
  const { code: wantCode, label } = HTTP_EXPECTATIONS[id];
  const ok = actualCode === wantCode;
  return { id, label, status: ok ? 'ok' : 'fail', detail: actualCode === null ? 'unreachable' : String(actualCode) };
}

/** Assembles every dashboard row from already-fetched raw results. Pure — no I/O. */
export function buildChecks(input) {
  const checks = Object.keys(HTTP_EXPECTATIONS).map((id) => httpCheck(id, input.http[id]));

  checks.push({
    id: 'appRunnerStatus',
    label: 'App Runner service',
    status: input.appRunnerStatus === 'RUNNING' ? 'ok' : 'fail',
    detail: input.appRunnerStatus ?? 'unknown',
  });

  const link = input.ringLink;
  checks.push({
    id: 'ringLink',
    label: 'Ring account linked',
    status: !link.linked ? 'fail' : link.expiresInMinutes <= 5 ? 'warn' : 'ok',
    detail: link.linked ? `expires in ${link.expiresInMinutes} min` : 'not linked',
  });

  checks.push({
    id: 'ringRefreshSchedule',
    label: 'Ring token auto-refresh (hourly)',
    status: input.refreshScheduleEnabled ? 'ok' : 'fail',
    detail: input.refreshScheduleEnabled ? 'ENABLED' : 'DISABLED',
  });

  checks.push({
    id: 'ringIntegrationCompleted',
    label: 'Ring webhook delivery',
    status: link.integrationCompleted ? 'ok' : 'warn',
    detail: link.integrationCompleted ? 'completed' : 'known limitation — see FRICTION.md FL-010',
  });

  checks.push({
    id: 'rhythmBuckets',
    label: 'Rhythm buckets recorded',
    status: 'info',
    detail: String(input.rhythmCount),
  });

  checks.push({
    id: 'doorEvents',
    label: 'Door timeline events',
    status: 'info',
    detail: String(input.doorEventCount),
  });

  return checks;
}

/** Overall health: informational rows never count against it; a single fail does. */
export function summarize(checks) {
  const counts = { total: checks.length, ok: 0, warn: 0, fail: 0 };
  for (const c of checks) {
    if (c.status === 'ok') counts.ok++;
    else if (c.status === 'warn') counts.warn++;
    else if (c.status === 'fail') counts.fail++;
  }
  return { ...counts, healthy: counts.fail === 0 };
}
