/**
 * The errand state machine as it is checked in (infra/errand.asl.json):
 * valid JSON once Terraform's templatefile has put the Lambda's ARN in,
 * every transition pointing at a state that exists, and every path walked —
 * a reminder or none; the door rang, the window passed, the errand was
 * called off on the way; a step that failed.
 *
 * The walk is a small interpreter of the parts of the States Language this
 * machine uses (Choice with IsPresent and BooleanEquals, Wait, Task with
 * Parameters, ResultSelector, ResultPath, Retry and Catch, Succeed, Fail),
 * with each Lambda's answer supplied by the test.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ERRAND_STEP_ACTIONS } from '../step.js';

const source = readFileSync(fileURLToPath(new URL('../../../../../../infra/errand.asl.json', import.meta.url)), 'utf8');
const STEP_ARN = 'arn:aws:lambda:eu-west-2:111122223333:function:wick-errand-step';

type Json = Record<string, unknown>;
interface State extends Json {
  readonly Type: string;
}
interface Machine {
  readonly StartAt: string;
  readonly States: Record<string, State>;
}

const machine = JSON.parse(source.replaceAll('${errand_step_arn}', STEP_ARN)) as Machine;

/** Every state a state can go to next. */
function nextOf(state: State): string[] {
  const next: string[] = [];
  if (typeof state.Next === 'string') next.push(state.Next);
  if (typeof state.Default === 'string') next.push(state.Default);
  for (const choice of (state.Choices as Json[] | undefined) ?? []) next.push(choice.Next as string);
  for (const caught of (state.Catch as Json[] | undefined) ?? []) next.push(caught.Next as string);
  return next;
}

// ---------------------------------------------------------------------------
// A small interpreter.
// ---------------------------------------------------------------------------

function read(path: string, data: unknown, context: Json): unknown {
  const [root, rest] = path.startsWith('$$.') ? [context, path.slice(3)] : path === '$' ? [data, ''] : [data, path.slice(2)];
  if (!path.startsWith('$')) throw new Error(`not a path: ${path}`);
  let at: unknown = root;
  for (const key of rest ? rest.split('.') : []) {
    if (typeof at !== 'object' || at === null || !(key in at)) throw new Error(`States.Runtime: ${path} is not in ${JSON.stringify(data)}`);
    at = (at as Json)[key];
  }
  return at;
}

const present = (path: string, data: unknown): boolean => {
  try {
    read(path, data, {});
    return true;
  } catch {
    return false;
  }
};

/** Parameters and ResultSelector: a key ending ".$" takes a path's value. */
function fill(template: unknown, data: unknown, context: Json): unknown {
  if (Array.isArray(template)) return template.map((t) => fill(t, data, context));
  if (typeof template !== 'object' || template === null) return template;
  return Object.fromEntries(
    Object.entries(template).map(([key, value]) =>
      key.endsWith('.$') ? [key.slice(0, -2), read(value as string, data, context)] : [key, fill(value, data, context)]),
  );
}

/** ResultPath: null keeps the input, "$" replaces it, "$.a.b" puts the result there. */
function place(data: unknown, resultPath: unknown, result: unknown): unknown {
  if (resultPath === null) return data;
  if (resultPath === undefined || resultPath === '$') return result;
  const keys = (resultPath as string).slice(2).split('.');
  const out = structuredClone(data) as Json;
  let at = out;
  for (const key of keys.slice(0, -1)) {
    at[key] = typeof at[key] === 'object' && at[key] !== null ? { ...(at[key] as Json) } : {};
    at = at[key] as Json;
  }
  at[keys[keys.length - 1]!] = result;
  return out;
}

const matches = (errorEquals: readonly string[], error: string): boolean =>
  errorEquals.includes(error) || errorEquals.includes('States.ALL') || (errorEquals.includes('States.TaskFailed') && error !== 'States.Timeout');

/** What a Lambda task does, as the test says: an answer, or an error. Called once per attempt. */
type Lambda = (payload: Json, state: string) => { readonly result: unknown } | { readonly error: string };

interface Walk {
  readonly path: string[];
  readonly calls: { readonly state: string; readonly payload: Json }[];
  readonly status: 'SUCCEEDED' | 'FAILED';
}

function walk(input: Json, lambda: Lambda): Walk {
  const path: string[] = [];
  const calls: Walk['calls'] = [];
  let data: unknown = input;
  let name = machine.StartAt;
  for (let guard = 0; guard < 50; guard += 1) {
    path.push(name);
    const state = machine.States[name]!;
    switch (state.Type) {
      case 'Succeed':
        return { path, calls, status: 'SUCCEEDED' };
      case 'Fail':
        return { path, calls, status: 'FAILED' };
      case 'Wait':
        // The moment is read, so a path that is not there fails as it would in Step Functions.
        if (state.TimestampPath) expect(String(read(state.TimestampPath as string, data, {}))).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        name = state.Next as string;
        break;
      case 'Choice': {
        const chosen = (state.Choices as Json[]).find((choice) => {
          if (choice.IsPresent !== undefined) return present(choice.Variable as string, data) === choice.IsPresent;
          if (choice.BooleanEquals !== undefined) return present(choice.Variable as string, data) && read(choice.Variable as string, data, {}) === choice.BooleanEquals;
          throw new Error(`unsupported choice in ${name}`);
        });
        name = (chosen?.Next ?? state.Default) as string;
        break;
      }
      case 'Task': {
        const params = fill(state.Parameters, data, { Task: { Token: `token-${path.length}` } }) as Json;
        if (state.TimeoutSecondsPath) expect(Number(read(state.TimeoutSecondsPath as string, data, {}))).toBeGreaterThanOrEqual(60);
        const payload = params.Payload as Json;
        const retries = ((state.Retry as Json[] | undefined) ?? []);
        let answer = lambda(payload, name);
        calls.push({ state: name, payload });
        let attempts = 0;
        while ('error' in answer) {
          const retry = retries.find((r) => matches(r.ErrorEquals as string[], (answer as { error: string }).error));
          if (!retry || attempts >= (retry.MaxAttempts as number)) break;
          attempts += 1;
          answer = lambda(payload, name);
          calls.push({ state: name, payload });
        }
        if ('error' in answer) {
          const error = answer.error;
          const caught = ((state.Catch as Json[] | undefined) ?? []).find((c) => matches(c.ErrorEquals as string[], error));
          if (!caught) return { path, calls, status: 'FAILED' };
          data = place(data, caught.ResultPath, { Error: error, Cause: 'test' });
          name = caught.Next as string;
          break;
        }
        // lambda:invoke wraps the function's answer as `Payload`; a task token's answer is what SendTaskSuccess was given.
        const raw = (state.Resource as string).endsWith('.waitForTaskToken') ? answer.result : { Payload: answer.result, StatusCode: 200 };
        const selected = state.ResultSelector ? fill(state.ResultSelector, raw, {}) : raw;
        data = place(data, state.ResultPath, selected);
        name = state.Next as string;
        break;
      }
      default:
        throw new Error(`unsupported state type ${state.Type}`);
    }
  }
  throw new Error('the walk did not end');
}

const ERRAND = { householdId: 'hh-1', errandId: 'err_AAAAAAAAAAAAAAAAAAAA' };
const START = { ...ERRAND, remindAt: '2026-10-15T07:00:00Z', windowEnd: '2026-10-15T10:00:00Z', door: { waitSeconds: 162_000 } };
const { remindAt: _noReminder, ...START_NO_REMINDER } = START;

/** The Lambdas as they answer when all goes well, the door ringing at 10:04. */
const allWell = (door: unknown = { rangAt: 1_791_968_640_000, cardId: 'door-abc' }): Lambda => (payload) => {
  switch (payload.action) {
    case 'remind': return { result: { ended: false, doorWaitSeconds: 10_800 } };
    case 'arm': return { result: door };
    default: return { result: { status: payload.action } };
  }
};

describe('infra/errand.asl.json — the errand as a state machine', () => {
  it('is valid JSON once the Lambda’s ARN is put in, and asks for nothing else', () => {
    expect([...source.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1])).toEqual(expect.arrayContaining(['errand_step_arn']));
    expect(new Set([...source.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]))).toEqual(new Set(['errand_step_arn']));
    expect(machine.States[machine.StartAt]).toBeDefined();
  });

  it('points every transition at a state that exists, and reaches every state', () => {
    const names = new Set(Object.keys(machine.States));
    const reached = new Set<string>();
    const queue = [machine.StartAt];
    while (queue.length) {
      const name = queue.pop()!;
      if (reached.has(name)) continue;
      reached.add(name);
      for (const next of nextOf(machine.States[name]!)) {
        expect(names.has(next), `${name} -> ${next}`).toBe(true);
        queue.push(next);
      }
    }
    expect(reached).toEqual(names);
  });

  it('calls only errand-step, with only the actions it knows', () => {
    const tasks = Object.values(machine.States).filter((s) => s.Type === 'Task');
    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) {
      const params = task.Parameters as { FunctionName: string; Payload: { action: string } };
      expect(params.FunctionName).toBe(STEP_ARN);
      expect(ERRAND_STEP_ACTIONS).toContain(params.Payload.action);
    }
    expect(new Set(tasks.map((t) => (t.Parameters as { Payload: { action: string } }).Payload.action))).toEqual(new Set(ERRAND_STEP_ACTIONS));
  });

  it('retries every Lambda task twice, with backoff, and catches what is left in MarkFailed', () => {
    for (const [name, task] of Object.entries(machine.States).filter(([, s]) => s.Type === 'Task')) {
      const retry = (task.Retry as Json[])[0]!;
      expect(retry, name).toMatchObject({ MaxAttempts: 2 });
      expect(retry.BackoffRate as number, name).toBeGreaterThan(1);
      if (name !== 'MarkFailed') expect((task.Catch as Json[]).at(-1), name).toMatchObject({ ErrorEquals: ['States.ALL'], Next: 'MarkFailed' });
    }
    expect(machine.States.MarkFailed!.Next).toBe('Failed');
    expect(machine.States.Failed!.Type).toBe('Fail');
  });

  it('waits at the door with a task token, until the end of the window and no longer', () => {
    const door = machine.States.WaitForDoor!;
    expect(door.Resource).toBe('arn:aws:states:::lambda:invoke.waitForTaskToken');
    expect(door.TimeoutSecondsPath).toBe('$.door.waitSeconds');
    expect((door.Parameters as { Payload: Json }).Payload['taskToken.$']).toBe('$$.Task.Token');
    expect((door.Catch as Json[])[0]).toMatchObject({ ErrorEquals: ['States.Timeout'], Next: 'NoShow' });
  });
});

describe('the paths through it', () => {
  it('reminds her at the moment, then waits at the door, and is told it rang', () => {
    const run = walk(START, allWell());

    expect(run.path).toEqual(['HasReminder', 'WaitForReminder', 'Remind', 'AfterRemind', 'WaitForDoor', 'DidTheDoorRing', 'Rang', 'Done']);
    expect(run.status).toBe('SUCCEEDED');
    expect(run.calls.map((c) => c.payload)).toEqual([
      { action: 'remind', ...ERRAND },
      { action: 'arm', ...ERRAND, taskToken: expect.stringMatching(/^token-/) },
      { action: 'rang', ...ERRAND, rangAt: 1_791_968_640_000, cardId: 'door-abc' },
    ]);
  });

  it('goes straight to the door when no reminder was chosen', () => {
    const run = walk(START_NO_REMINDER, allWell());
    expect(run.path).toEqual(['HasReminder', 'WaitForDoor', 'DidTheDoorRing', 'Rang', 'Done']);
  });

  it('says nobody came when the window passes with no ring', () => {
    const run = walk(START_NO_REMINDER, (payload) => (payload.action === 'arm' ? { error: 'States.Timeout' } : { result: {} }));

    expect(run.path).toEqual(['HasReminder', 'WaitForDoor', 'NoShow', 'Done']);
    expect(run.calls.at(-1)!.payload).toEqual({ action: 'no_show', ...ERRAND });
    // A timeout is the window passing, not a failure: it is never retried.
    expect(run.calls.filter((c) => c.state === 'WaitForDoor')).toHaveLength(1);
  });

  it('ends quietly when the reminder step finds the errand called off, or its author no longer allowed', () => {
    const run = walk(START, (payload) => (payload.action === 'remind' ? { result: { ended: true, doorWaitSeconds: 60 } } : { result: {} }));
    expect(run.path).toEqual(['HasReminder', 'WaitForReminder', 'Remind', 'AfterRemind', 'Ended']);
    expect(run.status).toBe('SUCCEEDED');
  });

  it('ends quietly when the door step hands its own token back, for an errand called off on the way', () => {
    const run = walk(START_NO_REMINDER, allWell({ ended: true }));
    expect(run.path).toEqual(['HasReminder', 'WaitForDoor', 'DidTheDoorRing', 'Ended']);
  });

  it('tries a failing step twice more, then marks the errand failed and fails the execution', () => {
    const run = walk(START, (payload) => (payload.action === 'remind' ? { error: 'Lambda.ServiceException' } : { result: {} }));

    expect(run.calls.filter((c) => c.state === 'Remind')).toHaveLength(3);
    expect(run.path).toEqual(['HasReminder', 'WaitForReminder', 'Remind', 'MarkFailed', 'Failed']);
    expect(run.calls.at(-1)!.payload).toEqual({ action: 'failed', ...ERRAND });
    expect(run.status).toBe('FAILED');
  });

  it('marks it failed when telling the member fails too', () => {
    const run = walk(START_NO_REMINDER, (payload) => (payload.action === 'rang' ? { error: 'States.TaskFailed' } : allWell()(payload, '')));
    expect(run.path.slice(-3)).toEqual(['Rang', 'MarkFailed', 'Failed']);
  });
});
