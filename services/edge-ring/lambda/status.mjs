/**
 * GET /status — aggregated production health for apps/ops-console's
 * dashboard. Everything docs/PRODUCTION-TESTING-GUIDE.md §1 checks by hand
 * with curl/aws-cli, done server-side and returned as one JSON blob.
 *
 * Server-side, not client-side, for two reasons: a browser can't read a
 * cross-origin status code without CORS enabled on every target (Ring's
 * endpoints, the WebSocket API — none of that CORS exists and shouldn't,
 * those aren't browser-facing), and the Ring token's derived fields
 * (expiry, hasRefresh) require Secrets Manager access a frontend must
 * never have. This Lambda holds that access; the dashboard only ever sees
 * status.mjs's already-redacted derived booleans/numbers, never the token.
 *
 * Lives in edge-ring/lambda purely to reuse its existing zip artifact
 * (archive_file.edge_ring in infra/edge.tf) — this Lambda's own concerns
 * span Ring, the Door agent's Rhythm/timeline tables, App Runner and
 * EventBridge, not just Ring.
 *
 * CORS: handled entirely by the edge API Gateway's own cors_configuration
 * (infra/edge.tf) — HTTP APIs inject the headers automatically, so nothing
 * CORS-related happens in this file.
 */
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { CloudWatchEventsClient, DescribeRuleCommand } from '@aws-sdk/client-cloudwatch-events';
import { AppRunnerClient, DescribeServiceCommand } from '@aws-sdk/client-apprunner';
import { interpretRingLink, buildChecks, summarize } from './status-logic.mjs';

const ddb = new DynamoDBClient({});
const sm = new SecretsManagerClient({});
const events = new CloudWatchEventsClient({});
const apprunner = new AppRunnerClient({});

const TABLE = process.env.TABLE_NAME;
const HOUSEHOLD_ID = process.env.WICK_HOUSEHOLD_ID;
const RING_TOKEN_SECRET_PREFIX = process.env.RING_TOKEN_SECRET_PREFIX ?? 'wick/ring/tokens';
const MCP_SERVICE_ARN = process.env.MCP_SERVICE_ARN;
const RING_REFRESH_RULE_NAME = process.env.RING_REFRESH_RULE_NAME;

const URLS = {
  mcpServer: process.env.MCP_SERVER_URL,
  simAlexa: process.env.SIM_ALEXA_URL,
  ringAuthorize: process.env.RING_AUTHORIZE_URL,
  ringWebhook: process.env.RING_WEBHOOK_URL,
  pairingApi: process.env.PAIRING_API_URL,
  websocket: process.env.WEBSOCKET_HTTPS_URL,
};

const FETCH_TIMEOUT_MS = 5000;

/** A status code, or null if the endpoint didn't answer in time — never throws. */
async function checkCode(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, redirect: 'manual', signal: controller.signal });
    return res.status;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function countByPrefix(prefix) {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': { S: `HH#${HOUSEHOLD_ID}` },
      ':prefix': { S: prefix },
    },
    Select: 'COUNT',
  }));
  return res.Count ?? 0;
}

async function readRingLinkRecord() {
  try {
    // The ops console watches the household this deployment was set up around.
    const res = await sm.send(new GetSecretValueCommand({ SecretId: `${RING_TOKEN_SECRET_PREFIX}/${HOUSEHOLD_ID}` }));
    return res.SecretString ? JSON.parse(res.SecretString) : null;
  } catch {
    return null;
  }
}

async function refreshScheduleEnabled() {
  try {
    const res = await events.send(new DescribeRuleCommand({ Name: RING_REFRESH_RULE_NAME }));
    return res.State === 'ENABLED';
  } catch {
    return false;
  }
}

async function appRunnerStatus() {
  try {
    const res = await apprunner.send(new DescribeServiceCommand({ ServiceArn: MCP_SERVICE_ARN }));
    return res.Service?.Status ?? null;
  } catch {
    return null;
  }
}

export const handler = async () => {
  const [
    mcpServer, simAlexa, ringAuthorize, ringWebhook, pairingApi, websocket,
    appRunnerStat, ringLinkRecord, refreshEnabled, rhythmCount, doorEventCount,
  ] = await Promise.all([
    checkCode(`${URLS.mcpServer}/.well-known/oauth-authorization-server`),
    checkCode(`${URLS.simAlexa}/`),
    checkCode(URLS.ringAuthorize),
    checkCode(URLS.ringWebhook, { method: 'POST', body: '{}' }),
    checkCode(`${URLS.pairingApi}/pair/status?code=healthcheck`),
    checkCode(URLS.websocket),
    appRunnerStatus(),
    readRingLinkRecord(),
    refreshScheduleEnabled(),
    countByPrefix('RHYTHM#'),
    countByPrefix('EVT#'),
  ]);

  const checks = buildChecks({
    http: { mcpServer, simAlexa, ringAuthorize, ringWebhook, pairingApi, websocket },
    appRunnerStatus: appRunnerStat,
    ringLink: interpretRingLink(ringLinkRecord),
    refreshScheduleEnabled: refreshEnabled,
    rhythmCount,
    doorEventCount,
  });

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({ checks, summary: summarize(checks), generatedAt: Date.now() }),
  };
};
