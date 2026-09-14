#!/usr/bin/env node
/**
 * Wick infrastructure entry point.
 *
 * Two environments, no staging:
 *   dev   — yours
 *   home  — Margaret's, and it carries real personal data about a real person.
 *           No experiments, no content in debug logs, tested rollback only.
 *
 * See docs/WICK-TECHNICAL.md §13.1, §13.3.
 */
import { App } from 'aws-cdk-lib';
import { WickCoreStack } from '../lib/core-stack.js';
import { WickEdgeStack } from '../lib/edge-stack.js';

const app = new App();

// `exactOptionalPropertyTypes` distinguishes "absent" from "present and
// undefined", and CDK's Environment declares `account?: string`. So omit the key
// rather than setting it to undefined — CDK then resolves it at deploy time.
const account = process.env.CDK_DEFAULT_ACCOUNT;
const env = {
  ...(account ? { account } : {}),
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

const core = new WickCoreStack(app, 'WickCore', { env });

new WickEdgeStack(app, 'WickEdge', {
  env,
  table: core.table,
  bus: core.bus,
  ringSecret: core.ringSecret,
  ringTokenSecret: core.ringTokenSecret,
});
