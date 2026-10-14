/**
 * Has the Wick server's App Runner deployment finished, and did it work?
 *
 * Terraform's UpdateService returns once the service is RUNNING again, and a
 * deployment App Runner rolled back also ends RUNNING, on the old image. So
 * the apply succeeding says nothing about the new image: this reads the
 * service's own operations instead. Pure: the answers are fetched by
 * scripts/wait-for-app-runner.ts.
 */

export interface Operation {
  readonly Id?: string;
  readonly Type?: string;
  readonly Status?: string;
  /** ISO 8601 from the AWS CLI, or epoch seconds from its other timestamp format. */
  readonly StartedAt?: string | number;
}

export interface ServiceNow {
  readonly status: string;
  readonly imageIdentifier: string;
}

export type Verdict = { readonly done: false; readonly line: string } | { readonly done: true; readonly ok: boolean; readonly line: string };

const STILL_GOING = new Set(['PENDING', 'IN_PROGRESS']);

export function startedAtMs(op: Operation): number {
  if (typeof op.StartedAt === 'number') return op.StartedAt * 1000;
  const at = Date.parse(op.StartedAt ?? '');
  return Number.isNaN(at) ? 0 : at;
}

const runs = (service: ServiceNow, tag: string) => service.imageIdentifier.endsWith(`:${tag}`);

/**
 * `since` is when the apply started, in ms: an operation from before it is
 * not this deploy's. With none since, the service must already be running
 * the expected tag — an apply that had nothing to change.
 */
export function appRunnerVerdict(operations: readonly Operation[], service: ServiceNow, expectedTag: string, since: number): Verdict {
  const ours = operations.filter((op) => startedAtMs(op) >= since).sort((a, b) => startedAtMs(b) - startedAtMs(a));
  const latest = ours[0];

  if (latest && STILL_GOING.has(latest.Status ?? '')) {
    return { done: false, line: `${latest.Type ?? 'operation'} ${latest.Status}` };
  }
  if (!latest && service.status === 'OPERATION_IN_PROGRESS') {
    return { done: false, line: 'an operation is in progress' };
  }
  if (latest && latest.Status !== 'SUCCEEDED') {
    return { done: true, ok: false, line: `${latest.Type ?? 'operation'} ${latest.Id ?? ''} ended ${latest.Status}; the service runs ${service.imageIdentifier}` };
  }
  if (service.status !== 'RUNNING') {
    return { done: true, ok: false, line: `the service is ${service.status}` };
  }
  if (!runs(service, expectedTag)) {
    return { done: true, ok: false, line: `the service runs ${service.imageIdentifier}, not the pinned tag ${expectedTag}` };
  }
  return latest
    ? { done: true, ok: true, line: `${latest.Type ?? 'operation'} succeeded; running ${service.imageIdentifier}` }
    : { done: true, ok: true, line: `already running ${service.imageIdentifier}; this apply deployed nothing` };
}
