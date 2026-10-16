/**
 * What the errands are allowed and given (infra/errands.tf), read from the
 * Terraform as it is checked in — the way services/mcp-server's
 * hear/__tests__/infra.test.ts reads infra/mcp.tf. `terraform validate`
 * says it is well formed; this says it grants no more than it should.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ERRAND_EVENTS } from '@wick/contracts';

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../../../../../${path}`, import.meta.url)), 'utf8');
const errands = read('infra/errands.tf');
const build = read('scripts/build-lambda.mjs');

/** One block, by brace counting from its header. */
function block(source: string, header: string): string {
  const start = source.indexOf(header);
  expect(start, header).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated ${header}`);
}

const actionsOf = (policy: string): string[] => [...policy.matchAll(/"([a-z0-9-]+:[A-Za-z]+)"/g)].map((m) => m[1]!).sort();

describe('infra/errands.tf', () => {
  it('fills the state machine with errand-step’s ARN, and is STANDARD, logging errors without an execution’s data', () => {
    const machine = block(errands, 'resource "aws_sfn_state_machine" "errand" {');
    expect(machine).toMatch(/templatefile\("\$\{path\.module\}\/errand\.asl\.json", \{\s*errand_step_arn = aws_lambda_function\.errand_step\.arn\s*\}\)/);
    expect(machine).toContain('type     = "STANDARD"');
    expect(machine).toContain('include_execution_data = false');
    expect(block(errands, 'resource "aws_cloudwatch_log_group" "errand_machine" {')).toContain('retention_in_days = 14');
  });

  it('lets the machine call errand-step and nothing else', () => {
    const policy = block(errands, 'data "aws_iam_policy_document" "errand_machine" {');
    const invoke = block(policy, 'statement {');
    expect(invoke).toContain('actions   = ["lambda:InvokeFunction"]');
    expect(invoke).toContain('resources = [aws_lambda_function.errand_step.arn, "${aws_lambda_function.errand_step.arn}:*"]');
    expect(policy).not.toContain('errand_door');
  });

  it('lets the two Lambdas hand a token back only to this machine, and gives errand-door only what finding one needs', () => {
    for (const name of ['errand_step', 'errand_door']) {
      const policy = block(errands, `data "aws_iam_policy_document" "${name}" {`);
      expect(policy).toMatch(/actions\s+= \["states:SendTaskSuccess"\]\s+resources = \[aws_sfn_state_machine\.errand\.arn\]/);
    }
    expect(actionsOf(block(errands, 'data "aws_iam_policy_document" "errand_door" {'))).toEqual(['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:UpdateItem', 'states:SendTaskSuccess']);
    // errand-step sends her reminder and a nudge; it is never given Translate: the reminder is the phrasebook's.
    expect(errands).not.toContain('translate:TranslateText');
  });

  it('lets the Wick server start this machine and stop its executions, and nothing else of Step Functions', () => {
    const policy = block(errands, 'data "aws_iam_policy_document" "apprunner_instance_errands" {');
    expect(actionsOf(policy)).toEqual(['states:StartExecution', 'states:StopExecution']);
    expect(read('infra/mcp.tf')).toContain('ERRAND_STATE_MACHINE_ARN = aws_sfn_state_machine.errand.arn');
  });

  it('wakes errand-door on the door’s own event, and lets the door put it on this bus alone', () => {
    const rule = block(errands, 'resource "aws_cloudwatch_event_rule" "door_rang" {');
    expect(rule).toContain(`source        = ["${ERRAND_EVENTS.source}"]`);
    expect(rule).toContain(`"detail-type" = ["${ERRAND_EVENTS.doorRang}"]`);
    expect(actionsOf(block(errands, 'data "aws_iam_policy_document" "agent_door_event_says_it_rang" {'))).toEqual(['events:PutEvents']);
    expect(read('infra/agent.tf')).toContain('EVENT_BUS_NAME = aws_cloudwatch_event_bus.wick.name');
  });

  it('zips what build-lambda.mjs builds, with the handler each bundle exports', () => {
    for (const [name, handler] of [['errand-step', 'stepHandler'], ['errand-door', 'doorHandler']] as const) {
      expect(errands).toContain(`source_dir  = "\${path.module}/../services/agent/.build/${name}"`);
      expect(errands).toContain(`handler       = "index.${handler}"`);
      expect(build).toContain(`outfile: 'services/agent/.build/${name}/index.mjs'`);
    }
  });

  it('pages for a failed execution, and for either Lambda’s errors or throttles', () => {
    expect(block(errands, 'resource "aws_cloudwatch_metric_alarm" "errand_executions_failed" {')).toContain('metric_name = "ExecutionsFailed"');
    expect(errands).toMatch(/errand_step = aws_lambda_function\.errand_step\.function_name\s+errand_door = aws_lambda_function\.errand_door\.function_name/);
    for (const metric of ['Errors', 'Throttles']) expect(errands).toContain(`metric_name = "${metric}"`);
  });
});
