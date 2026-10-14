import { describe, it, expect } from 'vitest';
import {
  interpretRingLink,
  ringLinkCheck,
  operatorLinkCheck,
  buildChecks,
  summarize,
  REFRESH_GRACE_MS,
  // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
} from '../status-logic.mjs';

const NOW = 1_790_000_000_000;
const MIN = 60_000;

/** The HH#<household>/RING row as household-links.mjs linkRow writes it. */
const row = (fields: { source?: string; expiresAt?: number; refreshable?: boolean }) => ({
  pk: { S: 'HH#margaret' },
  sk: { S: 'RING' },
  ...(fields.source ? { source: { S: fields.source } } : {}),
  ...(fields.expiresAt === undefined ? {} : { expiresAt: { N: String(fields.expiresAt) } }),
  refreshable: { BOOL: fields.refreshable === true },
});

const check = (r: unknown, s: unknown = null, now = NOW) => ringLinkCheck(interpretRingLink({ row: r, secret: s }, now), 'margaret');

describe('interpretRingLink — from the row and the secret\'s metadata, never its value', () => {
  it('is not linked when there is neither a row nor a secret', () => {
    expect(interpretRingLink({ row: null, secret: null }, NOW)).toEqual({ linked: false });
  });

  it('reads how a home linked, whether it refreshes, and how long it has, from the row', () => {
    expect(interpretRingLink({ row: row({ source: 'playground', expiresAt: NOW + 12 * MIN }) }, NOW)).toEqual({
      linked: true, recorded: true, source: 'playground', refreshable: false, msLeft: 12 * MIN,
    });
    expect(interpretRingLink({ row: row({ source: 'oauth', expiresAt: NOW + MIN, refreshable: true }) }, NOW)).toMatchObject({
      source: 'oauth', refreshable: true,
    });
  });

  it('knows only that a token was stored, and when, for one written from a laptop with no row', () => {
    expect(interpretRingLink({ row: null, secret: { exists: true, lastChangedAt: NOW - 40 * MIN } }, NOW)).toEqual({
      linked: true, recorded: false, source: 'unknown', refreshable: false, msSinceStored: 40 * MIN,
    });
  });
});

describe('ringLinkCheck — honest about a Playground token, still red for a real failure', () => {
  it('fails when the household has no link at all', () => {
    expect(check(null)).toMatchObject({ status: 'fail' });
  });

  it('is ok for a Playground token with time left, and says it is Ring\'s simulator', () => {
    const c = check(row({ source: 'playground', expiresAt: NOW + 20 * MIN }));
    expect(c.status).toBe('ok');
    expect(c.detail).toMatch(/simulator/);
    expect(c.detail).toMatch(/20 min left/);
  });

  it('warns — not fails — when a Playground token has run out, as it is made to, and says what that costs and what does not', () => {
    const c = check(row({ source: 'playground', expiresAt: NOW - 90 * MIN }));
    expect(c.status).toBe('warn');
    expect(c.detail).toMatch(/ran out 90 min ago/);
    expect(c.detail).toMatch(/about 30 minutes/);
    expect(c.detail).toMatch(/Watch live/);
    expect(c.detail).toMatch(/stand-in doorbell/);
  });

  it('never says "expires in 0 min" for a token that ran out long ago', () => {
    expect(check(row({ source: 'playground', expiresAt: NOW - 600 * MIN })).detail).not.toMatch(/expires in 0/);
  });

  it('reads a token stored from a laptop as fresh for its first half hour, then warns', () => {
    expect(check(null, { exists: true, lastChangedAt: NOW - 10 * MIN }).status).toBe('ok');
    const stale = check(null, { exists: true, lastChangedAt: NOW - 24 * 60 * MIN });
    expect(stale.status).toBe('warn');
    expect(stale.detail).toMatch(/set-ring-token\.sh/);
  });

  it('is ok for a linked account that refreshes itself, even just past its expiry between two hourly ticks', () => {
    expect(check(row({ source: 'oauth', expiresAt: NOW + 100 * MIN, refreshable: true })).status).toBe('ok');
    expect(check(row({ source: 'oauth', expiresAt: NOW - 40 * MIN, refreshable: true })).status).toBe('ok');
  });

  it('fails a linked account the hourly refresh has stopped renewing', () => {
    const c = check(row({ source: 'oauth', expiresAt: NOW - REFRESH_GRACE_MS - MIN, refreshable: true }));
    expect(c.status).toBe('fail');
    expect(c.detail).toMatch(/wick-ring-refresh/);
  });

  it('fails a linked account with no refresh token once it has run out', () => {
    expect(check(row({ source: 'oauth', expiresAt: NOW - MIN, refreshable: false })).status).toBe('fail');
  });
});

describe('operatorLinkCheck — the unauthenticated /ring/authorize, which is off unless set', () => {
  const edge404 = { status: 404, body: 'Ring is connected from the Wick family app, by the person who set the home up.' };

  it('is ok when it is off and the edge itself answers 404 in its own words', () => {
    expect(operatorLinkCheck(edge404, false)).toMatchObject({ status: 'ok' });
  });

  it('fails on API Gateway\'s own 404: the route or the function is missing', () => {
    expect(operatorLinkCheck({ status: 404, body: '{"message":"Not Found"}' }, false)).toMatchObject({ status: 'fail' });
  });

  it('warns while it is on, because anyone who signs in links the operator\'s household', () => {
    const c = operatorLinkCheck({ status: 302, body: '' }, true);
    expect(c.status).toBe('warn');
    expect(c.detail).toMatch(/ring_operator_link/);
  });

  it('fails when it answers what the setting does not say', () => {
    expect(operatorLinkCheck({ status: 302, body: '' }, false).status).toBe('fail');
    expect(operatorLinkCheck(edge404, true).status).toBe('fail');
    expect(operatorLinkCheck({ status: null, body: '' }, false)).toMatchObject({ status: 'fail', detail: 'unreachable' });
  });
});

describe('buildChecks', () => {
  const baseInput = {
    http: {
      mcpServer: 200,
      simAlexa: 200,
      ringLinkRoute: 401,
      ringWebhook: 401,
      pairingApi: 404,
      websocket: 426,
    },
    ringAuthorize: { status: 404, body: 'Ring is connected from the Wick family app.' },
    operatorLinkOn: false,
    appRunnerStatus: 'RUNNING',
    householdId: 'margaret',
    ringLink: { linked: true, recorded: true, source: 'oauth', refreshable: true, msLeft: 120 * MIN },
    refreshScheduleEnabled: true,
    doorDeadLetters: 0,
    rhythmCount: 7,
    doorEventCount: 3,
  };

  it('is healthy when every endpoint answers what it should — the deployed stack as it is meant to be', () => {
    const checks = buildChecks(baseInput);
    expect(checks.filter((c: { status: string }) => c.status === 'fail')).toEqual([]);
    expect(summarize(checks).healthy).toBe(true);
  });

  it('probes how a home links Ring now — the family app\'s /api/ring, refused unsigned — not the operator\'s route', () => {
    const checks = buildChecks(baseInput);
    expect(checks.find((c: { id: string }) => c.id === 'ringLinkRoute')).toMatchObject({ status: 'ok', detail: '401' });
    expect(checks.find((c: { id: string }) => c.id === 'ringAuthorize')).toBeUndefined();
    const gone = buildChecks({ ...baseInput, http: { ...baseInput.http, ringLinkRoute: 404 } });
    expect(gone.find((c: { id: string }) => c.id === 'ringLinkRoute')).toMatchObject({ status: 'fail', detail: '404' });
  });

  it('fails an http check when the status code does not match, or nothing answers', () => {
    expect(buildChecks({ ...baseInput, http: { ...baseInput.http, mcpServer: 500 } }).find((c: { id: string }) => c.id === 'mcpServer'))
      .toMatchObject({ status: 'fail', detail: '500' });
    expect(buildChecks({ ...baseInput, http: { ...baseInput.http, mcpServer: null } }).find((c: { id: string }) => c.id === 'mcpServer'))
      .toMatchObject({ status: 'fail', detail: 'unreachable' });
  });

  it('treats App Runner RUNNING as ok and anything else as fail', () => {
    const notRunning = buildChecks({ ...baseInput, appRunnerStatus: 'OPERATION_IN_PROGRESS' });
    expect(notRunning.find((c: { id: string }) => c.id === 'appRunnerStatus')?.status).toBe('fail');
  });

  it('says once, as information, why no Ring webhook arrives — not a warning on every load', () => {
    const c = buildChecks(baseInput).find((c: { id: string }) => c.id === 'ringWebhookDelivery');
    expect(c?.status).toBe('info');
    expect(c?.detail).toMatch(/FL-027/);
    expect(c?.detail).toMatch(/FL-010/);
  });

  it('fails while a door event waits in the dead-letter queue, and warns when the queue cannot be read', () => {
    expect(buildChecks({ ...baseInput, doorDeadLetters: 2 }).find((c: { id: string }) => c.id === 'doorDeadLetters'))
      .toMatchObject({ status: 'fail', detail: '2 waiting in the dead-letter queue' });
    expect(buildChecks({ ...baseInput, doorDeadLetters: null }).find((c: { id: string }) => c.id === 'doorDeadLetters')?.status).toBe('warn');
    expect(buildChecks(baseInput).find((c: { id: string }) => c.id === 'doorDeadLetters')?.status).toBe('ok');
  });

  it('fails the refresh schedule check when the EventBridge rule is disabled', () => {
    const checks = buildChecks({ ...baseInput, refreshScheduleEnabled: false });
    expect(checks.find((c: { id: string }) => c.id === 'ringRefreshSchedule')?.status).toBe('fail');
  });

  it('always reports rhythm/door counts as informational, never failing on zero — a fresh household legitimately starts at zero', () => {
    const checks = buildChecks({ ...baseInput, rhythmCount: 0, doorEventCount: 0 });
    expect(checks.find((c: { id: string }) => c.id === 'rhythmBuckets')).toMatchObject({ status: 'info', detail: '0' });
    expect(checks.find((c: { id: string }) => c.id === 'doorEvents')).toMatchObject({ status: 'info', detail: '0' });
  });

  it('is healthy — with one amber row — for the deployment as it stands today: a Playground token that ran out hours ago', () => {
    const checks = buildChecks({ ...baseInput, ringLink: { linked: true, recorded: false, source: 'unknown', refreshable: false, msSinceStored: 20 * 60 * MIN } });
    const summary = summarize(checks);
    expect(summary.healthy).toBe(true);
    expect(summary.warn).toBe(1);
  });
});

describe('summarize', () => {
  it('counts statuses and is healthy only when nothing fails', () => {
    const checks = [
      { id: 'a', status: 'ok' }, { id: 'b', status: 'ok' },
      { id: 'c', status: 'warn' }, { id: 'd', status: 'info' },
    ];
    expect(summarize(checks)).toEqual({ total: 4, ok: 2, warn: 1, fail: 0, healthy: true });
  });

  it('is unhealthy the moment anything fails, regardless of how many things are ok', () => {
    const checks = [{ id: 'a', status: 'ok' }, { id: 'b', status: 'fail' }];
    expect(summarize(checks).healthy).toBe(false);
  });
});
