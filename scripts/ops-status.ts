/**
 * The production health report, for operators only:
 *
 *   AWS_PROFILE=wick-dev npm run ops:status
 *
 * Invokes the status Lambda (infra/status.tf) with your own AWS credentials
 * and prints each check. There is no public route to it any more: what it
 * says about the stack is the operator's, not the internet's
 * (scripts/ops/status.ts). Exits 1 when production is not healthy.
 */
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { readStatusAnswer, statusLines } from './ops/status.js';

async function main(): Promise<void> {
  const functionName = process.env.WICK_STATUS_FUNCTION ?? 'wick-status';
  const lambda = new LambdaClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  const answer = await lambda.send(new InvokeCommand({ FunctionName: functionName }));
  const report = readStatusAnswer(new TextDecoder().decode(answer.Payload ?? new Uint8Array()));
  if (!report) {
    console.error(`${functionName} did not answer with a report${answer.FunctionError ? ` (${answer.FunctionError})` : ''}.`);
    process.exit(1);
  }
  for (const line of statusLines(report)) console.log(line);
  if (!report.summary.healthy) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  process.exit(1);
});
