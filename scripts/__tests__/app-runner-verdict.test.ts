import { describe, expect, it } from 'vitest';
import { appRunnerVerdict, startedAtMs } from '../deploy/app-runner.js';

const REPO = '707938860881.dkr.ecr.us-east-1.amazonaws.com/wick-mcp-server';
const SINCE = Date.parse('2026-10-14T10:00:00Z');
const op = (Status: string, StartedAt = '2026-10-14T12:05:00+02:00', Type = 'UPDATE_SERVICE') => ({ Id: 'op-1', Type, Status, StartedAt });
const running = (tag: string) => ({ status: 'RUNNING', imageIdentifier: `${REPO}:${tag}` });

describe('appRunnerVerdict', () => {
  it('waits while this apply\'s operation is still going', () => {
    expect(appRunnerVerdict([op('IN_PROGRESS')], { status: 'OPERATION_IN_PROGRESS', imageIdentifier: `${REPO}:abc1234` }, 'abc1234', SINCE)).toEqual({
      done: false,
      line: 'UPDATE_SERVICE IN_PROGRESS',
    });
  });

  it('passes an operation that succeeded and left the pinned image running', () => {
    expect(appRunnerVerdict([op('SUCCEEDED')], running('abc1234'), 'abc1234', SINCE)).toEqual({
      done: true,
      ok: true,
      line: `UPDATE_SERVICE succeeded; running ${REPO}:abc1234`,
    });
  });

  it('fails a deployment App Runner rolled back, though the service is RUNNING again', () => {
    const verdict = appRunnerVerdict([op('ROLLBACK_SUCCEEDED')], running('6b75aaa'), 'abc1234', SINCE);
    expect(verdict).toMatchObject({ done: true, ok: false });
    expect(verdict.line).toContain('ended ROLLBACK_SUCCEEDED');
  });

  it('fails a failed operation', () => {
    expect(appRunnerVerdict([op('FAILED')], running('abc1234'), 'abc1234', SINCE)).toMatchObject({ done: true, ok: false });
  });

  it('judges only the newest operation since the apply began, never one from before it', () => {
    const before = op('FAILED', '2026-10-14T11:00:00+02:00');
    const ours = [op('SUCCEEDED', '2026-10-14T12:01:00+02:00'), op('IN_PROGRESS', '2026-10-14T12:09:00+02:00')];
    expect(appRunnerVerdict([before, ...ours], running('abc1234'), 'abc1234', SINCE)).toMatchObject({ done: false });
    expect(appRunnerVerdict([before], running('abc1234'), 'abc1234', SINCE)).toMatchObject({ done: true, ok: true, line: `already running ${REPO}:abc1234; this apply deployed nothing` });
  });

  it('fails an apply that changed nothing while the service runs another image', () => {
    expect(appRunnerVerdict([], running('latest'), 'abc1234', SINCE)).toMatchObject({ done: true, ok: false, line: `the service runs ${REPO}:latest, not the pinned tag abc1234` });
  });

  it('matches the whole tag, so xabc1234 is not abc1234', () => {
    expect(appRunnerVerdict([], running('xabc1234'), 'abc1234', SINCE)).toMatchObject({ done: true, ok: false });
  });

  it('waits on a service in progress with no operation seen yet', () => {
    expect(appRunnerVerdict([], { status: 'OPERATION_IN_PROGRESS', imageIdentifier: `${REPO}:abc1234` }, 'abc1234', SINCE).done).toBe(false);
  });

  it('reads the CLI\'s ISO times and its epoch seconds alike', () => {
    expect(startedAtMs({ StartedAt: '2026-10-14T12:00:00+02:00' })).toBe(SINCE);
    expect(startedAtMs({ StartedAt: SINCE / 1000 })).toBe(SINCE);
    expect(startedAtMs({})).toBe(0);
  });
});
