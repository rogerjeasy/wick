/**
 * Pure interpretation logic for GET /status (status.mjs is the I/O-heavy
 * composition root; this file has no AWS calls, no fetch, no Date.now()
 * default reliance in tests — everything here is a deterministic function
 * of its inputs, which is what makes it worth testing exhaustively).
 *
 * Statuses are `ok` / `warn` / `fail`, plus `info` for a row that is a fact
 * rather than a health. `fail` is for something broken that a person should
 * fix. `warn` is for a state that is expected but limits what can be shown —
 * a Playground token that has run out after its thirty minutes, as it is
 * made to — so the page says what it means instead of turning red on every
 * load. A known platform gap that nothing here can change (Ring delivering
 * no webhooks, FL-027 and FL-010) is `info`: it is not a health at all.
 */
import { PLAYGROUND_TOKEN_MS } from './household-links.mjs';

/**
 * How long a link that refreshes itself may sit past its expiry before that
 * is a fault. The hourly refresh renews a token only inside its last ten
 * minutes (token-policy.mjs REFRESH_SKEW_MS), so between two ticks a token can
 * be up to fifty minutes past its time — and the door's own lazy refresh
 * covers that gap. Past an hour and a quarter, a tick has been missed or has
 * failed, and that is worth someone's attention.
 */
export const REFRESH_GRACE_MS = 75 * 60_000;

/**
 * What the status page can say about a household's Ring link without
 * reading its tokens. Two sources, neither secret:
 *
 *   row     the HH#<household>/RING row (household-links.mjs): how it was
 *           linked, whether it refreshes itself, and until when — written by
 *           every link made from the family app, kept current by the refresh.
 *   secret  DescribeSecret on wick/ring/tokens/<household>: that it exists
 *           and when it last changed. scripts/set-ring-token.sh writes the
 *           secret and no row, so for a token pasted from a laptop this is
 *           all there is.
 *
 * Never the secret's value: this runs behind a public, unauthenticated route.
 */
export function interpretRingLink({ row, secret } = {}, now = Date.now()) {
  if (row) {
    const source = row.source?.S ?? 'oauth';
    const expiresAt = row.expiresAt?.N ? Number(row.expiresAt.N) : undefined;
    return {
      linked: true,
      recorded: true,
      source: source === 'playground' ? 'playground' : 'oauth',
      refreshable: row.refreshable?.BOOL === true,
      ...(expiresAt === undefined ? {} : { msLeft: expiresAt - now }),
    };
  }
  if (secret?.exists) {
    return {
      linked: true,
      recorded: false,
      source: 'unknown',
      refreshable: false,
      ...(Number.isFinite(secret.lastChangedAt) ? { msSinceStored: now - secret.lastChangedAt } : {}),
    };
  }
  return { linked: false };
}

const minutes = (ms) => Math.max(0, Math.round(ms / 60_000));

/** What it means for the stand-in doorbell, said wherever Ring itself is out. */
const STAND_IN = "A demo home's stand-in doorbell does not use Ring and is unaffected.";

/** One row: is this household's Ring link usable, and if not, is that a fault or how a Playground token is? */
export function ringLinkCheck(link, householdId = 'the operator household') {
  const base = { id: 'ringLink', label: `Ring link (${householdId})` };
  if (!link?.linked) {
    return { ...base, status: 'fail', detail: `No Ring link. Connect Ring from the family app's Doorbell card. ${STAND_IN}` };
  }

  if (link.source === 'unknown') {
    // A token stored from a laptop. Nothing refreshes it (refresh.mjs walks RING rows only).
    const since = link.msSinceStored;
    if (since !== undefined && since <= PLAYGROUND_TOKEN_MS) {
      return { ...base, status: 'ok', detail: `A token stored from a laptop ${minutes(since)} min ago (scripts/set-ring-token.sh). A Playground token lasts about 30 minutes.` };
    }
    return {
      ...base,
      status: 'warn',
      detail: `A token stored from a laptop${since === undefined ? '' : ` ${minutes(since)} min ago`} (scripts/set-ring-token.sh). If it was a Playground token it ran out after about 30 minutes, by design: Watch live and the door picture at this home need a fresh one (npm run ring:check). ${STAND_IN}`,
    };
  }

  if (link.source === 'playground') {
    if (link.msLeft !== undefined && link.msLeft > 0) {
      return { ...base, status: 'ok', detail: `Ring's simulator (a Playground token), ${minutes(link.msLeft)} min left of about 30.` };
    }
    return {
      ...base,
      status: 'warn',
      detail: `Ring's simulator (a Playground token)${link.msLeft === undefined ? ' has run out' : ` ran out ${minutes(-link.msLeft)} min ago`}, as a Playground token does after about 30 minutes. Watch live and the door picture at this home need a fresh one, pasted in the family app. ${STAND_IN}`,
    };
  }

  // A linked Ring account.
  if (link.refreshable) {
    if (link.msLeft === undefined || link.msLeft > -REFRESH_GRACE_MS) {
      return { ...base, status: 'ok', detail: link.msLeft !== undefined && link.msLeft > 0 ? `Linked account, refreshed hourly; ${minutes(link.msLeft)} min left on this token.` : 'Linked account, refreshed hourly; this token is due its refresh.' };
    }
    return { ...base, status: 'fail', detail: `Linked account, but the hourly refresh has not renewed it for ${minutes(-link.msLeft)} min. See the wick-ring-refresh log.` };
  }
  if (link.msLeft !== undefined && link.msLeft <= 0) {
    return { ...base, status: 'fail', detail: `Linked account with no refresh token; it ran out ${minutes(-link.msLeft)} min ago. Connect Ring again from the family app.` };
  }
  return { ...base, status: 'warn', detail: `Linked account with no refresh token${link.msLeft === undefined ? '' : `; ${minutes(link.msLeft)} min left`}. It will need connecting again.` };
}

/**
 * The operator's unauthenticated way to link Ring, GET /ring/authorize
 * (authorize.mjs). Off by default (infra var.ring_operator_link): then the
 * function itself answers 404 in Wick's words, and that is the healthy
 * answer. API Gateway's own 404 ({"message":"Not Found"}) means the route or
 * the function is missing — the same test deploy-edge.yml makes after an
 * apply. On, it redirects to Ring, and anyone who signs in links the
 * operator's household: right while setting up, wrong to leave.
 */
export function operatorLinkCheck(answer, operatorLinkOn) {
  const base = { id: 'ringOperatorLink', label: 'Ring operator link (GET /ring/authorize)' };
  const code = answer?.status ?? null;
  if (code === null) return { ...base, status: 'fail', detail: 'unreachable' };
  if (!operatorLinkOn) {
    if (code === 404 && /Wick family app/.test(answer.body ?? '')) {
      return { ...base, status: 'ok', detail: 'Off, as set: a home connects Ring from the family app.' };
    }
    return { ...base, status: 'fail', detail: `Expected the edge's own 404 (the operator link is off), got ${code}.` };
  }
  if (code === 302) {
    return { ...base, status: 'warn', detail: "On: whoever signs in links the operator's household. Turn ring_operator_link off once linked." };
  }
  return { ...base, status: 'fail', detail: `Expected a 302 to Ring (the operator link is on), got ${code}.` };
}

const HTTP_EXPECTATIONS = {
  mcpServer: { code: 200, label: 'MCP Server (App Runner)' },
  simAlexa: { code: 200, label: 'sim-alexa (CloudFront)' },
  // How a home links Ring now: the family app, through the Wick server. Unsigned, it is refused.
  ringLinkRoute: { code: 401, label: 'Ring link from the family app (GET /api/ring, unsigned refused)' },
  ringWebhook: { code: 401, label: 'Ring /webhook (unsigned rejected)' },
  pairingApi: { code: 404, label: 'Pairing API' },
  websocket: { code: 426, label: 'WebSocket transport' },
};

function httpCheck(id, actualCode) {
  const { code: wantCode, label } = HTTP_EXPECTATIONS[id];
  const ok = actualCode === wantCode;
  return { id, label, status: ok ? 'ok' : 'fail', detail: actualCode === null || actualCode === undefined ? 'unreachable' : String(actualCode) };
}

/** Assembles every dashboard row from already-fetched raw results. Pure — no I/O. */
export function buildChecks(input) {
  const checks = Object.keys(HTTP_EXPECTATIONS).map((id) => httpCheck(id, input.http[id]));

  checks.push(operatorLinkCheck(input.ringAuthorize, input.operatorLinkOn === true));

  checks.push({
    id: 'appRunnerStatus',
    label: 'App Runner service',
    status: input.appRunnerStatus === 'RUNNING' ? 'ok' : 'fail',
    detail: input.appRunnerStatus ?? 'unknown',
  });

  checks.push(ringLinkCheck(input.ringLink, input.householdId));

  checks.push({
    id: 'ringRefreshSchedule',
    label: 'Ring token auto-refresh (hourly)',
    status: input.refreshScheduleEnabled ? 'ok' : 'fail',
    detail: input.refreshScheduleEnabled ? 'ENABLED' : 'DISABLED',
  });

  // Not a fault, and not something this page can measure: said once, in words.
  checks.push({
    id: 'ringWebhookDelivery',
    label: 'Ring webhook delivery',
    status: 'info',
    detail: "None expected: Ring's Playground sends no doorbell webhooks (FRICTION.md FL-027) and Ring will not complete a private app's integration (FL-010). Doors ring by the signed test webhook or a demo home's stand-in doorbell; the receiver is checked above.",
  });

  // The door path's dead letters (infra/alarms.tf): a ring that failed every try is kept here, and pages.
  const dead = input.doorDeadLetters;
  checks.push({
    id: 'doorDeadLetters',
    label: 'Door events that failed every try',
    status: dead === null || dead === undefined ? 'warn' : dead > 0 ? 'fail' : 'ok',
    detail: dead === null || dead === undefined ? 'could not be read' : dead > 0 ? `${dead} waiting in the dead-letter queue` : 'none',
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
