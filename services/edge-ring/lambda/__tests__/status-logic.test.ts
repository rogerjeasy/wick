import { describe, it, expect } from 'vitest';
import { interpretRingLink, buildChecks, summarize } from '../status-logic.mjs';

describe('interpretRingLink', () => {
  it('reports not linked when there is no access token', () => {
    const r = interpretRingLink(null, 1_000_000);
    expect(r).toEqual({
      linked: false, hasRefresh: false, hasAccountId: false,
      expiresInMinutes: 0, integrationCompleted: false,
    });
  });

  it('reports a linked, refreshing, completed account', () => {
    const now = 1_000_000;
    const record = {
      access_token: 'x', refresh_token: 'y', accountId: 'acct-1',
      expiresAt: now + 10 * 60_000, integrationCompletedAt: now - 1000,
    };
    expect(interpretRingLink(record, now)).toEqual({
      linked: true, hasRefresh: true, hasAccountId: true,
      expiresInMinutes: 10, integrationCompleted: true,
    });
  });

  it('never reports a negative expiry — an already-expired token reads as 0 minutes, not -5', () => {
    const now = 1_000_000;
    const record = { access_token: 'x', expiresAt: now - 5 * 60_000 };
    expect(interpretRingLink(record, now).expiresInMinutes).toBe(0);
  });

  it('reports no refresh token and no completed integration when absent, independent of linked state', () => {
    const now = 1_000_000;
    const record = { access_token: 'x', expiresAt: now + 60_000 };
    const r = interpretRingLink(record, now);
    expect(r.linked).toBe(true);
    expect(r.hasRefresh).toBe(false);
    expect(r.integrationCompleted).toBe(false);
  });
});

describe('buildChecks', () => {
  const baseInput = {
    http: {
      mcpServer: 200,
      simAlexa: 200,
      ringAuthorize: 302,
      ringWebhook: 401,
      pairingApi: 404,
      websocket: 426,
    },
    appRunnerStatus: 'RUNNING',
    ringLink: { linked: true, hasRefresh: true, hasAccountId: true, expiresInMinutes: 120, integrationCompleted: false },
    refreshScheduleEnabled: true,
    rhythmCount: 7,
    doorEventCount: 3,
  };

  it('marks every http check ok when the status code matches what that endpoint should return', () => {
    const checks = buildChecks(baseInput);
    const httpIds = ['mcpServer', 'simAlexa', 'ringAuthorize', 'ringWebhook', 'pairingApi', 'websocket'];
    for (const id of httpIds) {
      expect(checks.find((c) => c.id === id)?.status).toBe('ok');
    }
  });

  it('fails an http check when the status code does not match', () => {
    const checks = buildChecks({ ...baseInput, http: { ...baseInput.http, mcpServer: 500 } });
    expect(checks.find((c) => c.id === 'mcpServer')).toMatchObject({ status: 'fail', detail: '500' });
  });

  it('fails the http check when the endpoint is unreachable (null code)', () => {
    const checks = buildChecks({ ...baseInput, http: { ...baseInput.http, mcpServer: null } });
    expect(checks.find((c) => c.id === 'mcpServer')).toMatchObject({ status: 'fail' });
  });

  it('treats App Runner RUNNING as ok and anything else as fail', () => {
    expect(buildChecks(baseInput).find((c) => c.id === 'appRunnerStatus')?.status).toBe('ok');
    const notRunning = buildChecks({ ...baseInput, appRunnerStatus: 'OPERATION_IN_PROGRESS' });
    expect(notRunning.find((c) => c.id === 'appRunnerStatus')?.status).toBe('fail');
  });

  it('fails ringLink when not linked, warns (not fails) low expiry, oks a healthy link', () => {
    const notLinked = buildChecks({ ...baseInput, ringLink: { ...baseInput.ringLink, linked: false } });
    expect(notLinked.find((c) => c.id === 'ringLink')?.status).toBe('fail');

    const lowExpiry = buildChecks({ ...baseInput, ringLink: { ...baseInput.ringLink, expiresInMinutes: 2 } });
    expect(lowExpiry.find((c) => c.id === 'ringLink')?.status).toBe('warn');

    expect(buildChecks(baseInput).find((c) => c.id === 'ringLink')?.status).toBe('ok');
  });

  it('marks ring integration-completed as a known limitation (warn), never fail — FL-010', () => {
    const check = buildChecks(baseInput).find((c) => c.id === 'ringIntegrationCompleted');
    expect(check?.status).toBe('warn');
    expect(check?.detail).toMatch(/FL-010/);
  });

  it('reports ring integration as ok once Ring actually completes it', () => {
    const check = buildChecks({
      ...baseInput,
      ringLink: { ...baseInput.ringLink, integrationCompleted: true },
    }).find((c) => c.id === 'ringIntegrationCompleted');
    expect(check?.status).toBe('ok');
  });

  it('fails the refresh schedule check when the EventBridge rule is disabled', () => {
    const checks = buildChecks({ ...baseInput, refreshScheduleEnabled: false });
    expect(checks.find((c) => c.id === 'ringRefreshSchedule')?.status).toBe('fail');
  });

  it('always reports rhythm/door counts as informational, never failing on zero — a fresh household legitimately starts at zero', () => {
    const checks = buildChecks({ ...baseInput, rhythmCount: 0, doorEventCount: 0 });
    expect(checks.find((c) => c.id === 'rhythmBuckets')).toMatchObject({ status: 'info', detail: '0' });
    expect(checks.find((c) => c.id === 'doorEvents')).toMatchObject({ status: 'info', detail: '0' });
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
