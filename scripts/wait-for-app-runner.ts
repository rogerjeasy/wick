/**
 * Wait for the Wick server's App Runner deployment to finish, and fail if it
 * did not deploy the pinned image.
 *
 *   SERVICE_ARN=… EXPECTED_TAG=… SINCE=<epoch seconds> npm run deploy:wait-app-runner
 *
 * deploy-agent.yml runs it straight after `terraform apply`. It reads with
 * the AWS CLI (apprunner list-operations, describe-service) and writes
 * nothing. Gives up after 25 minutes; a deployment usually takes five.
 */
import { execFileSync } from 'node:child_process';
import { appRunnerVerdict, type Operation } from './deploy/app-runner.js';

const POLL_MS = 15_000;
const GIVE_UP_MS = 25 * 60_000;

function aws(args: string[]): unknown {
  return JSON.parse(execFileSync('aws', [...args, '--output', 'json'], { encoding: 'utf8' }));
}

function need(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set`);
    process.exit(2);
  }
  return value;
}

async function main(): Promise<void> {
  const serviceArn = need('SERVICE_ARN');
  const expectedTag = need('EXPECTED_TAG');
  const since = Number(need('SINCE')) * 1000;
  const giveUpAt = Date.now() + GIVE_UP_MS;

  for (;;) {
    const operations = (aws(['apprunner', 'list-operations', '--service-arn', serviceArn, '--max-results', '10']) as { OperationSummaryList?: Operation[] }).OperationSummaryList ?? [];
    const service = (aws(['apprunner', 'describe-service', '--service-arn', serviceArn]) as {
      Service: { Status: string; SourceConfiguration?: { ImageRepository?: { ImageIdentifier?: string } } };
    }).Service;
    const verdict = appRunnerVerdict(operations, { status: service.Status, imageIdentifier: service.SourceConfiguration?.ImageRepository?.ImageIdentifier ?? '' }, expectedTag, since);

    if (verdict.done) {
      console.log(`${verdict.ok ? '✓' : '✗'} App Runner: ${verdict.line}`);
      process.exit(verdict.ok ? 0 : 1);
    }
    if (Date.now() > giveUpAt) {
      console.log(`✗ App Runner: still ${verdict.line} after 25 minutes`);
      process.exit(1);
    }
    console.log(`  App Runner: ${verdict.line}; asking again in 15 s`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

void main();
