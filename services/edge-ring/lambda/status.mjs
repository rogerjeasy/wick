/**
 * GET /status — aggregated production health for apps/ops-console's
 * dashboard. Everything docs/PRODUCTION-TESTING-GUIDE.md §1 checks by hand
 * with curl/aws-cli, done server-side and returned as one JSON blob.
 *
 * Server-side, not client-side, for two reasons: a browser can't read a
 * cross-origin status code without CORS enabled on every target (Ring's
 * endpoints, the WebSocket API — none of that CORS exists and shouldn't,
 * those aren't browser-facing), and the Ring link's state lives in the
 * table and in Secrets Manager's metadata, which a frontend must not reach.
 *
 * It never reads a token. This is a public, unauthenticated route, so its
 * role may not read the Ring secret's value at all (infra/status.tf): the
 * link's state comes from the household's RING row (household-links.mjs)
 * and from DescribeSecret — that the secret exists and when it last
 * changed — for a token stored from a laptop, which writes no row.
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
import { SecretsManagerClient, DescribeSecretCommand } from '@aws-sdk/client-secrets-manager';
import { SQSClient, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { CloudWatchEventsClient, DescribeRuleCommand } from '@aws-sdk/client-cloudwatch-events';
import { AppRunnerClient, DescribeServiceCommand } from '@aws-sdk/client-apprunner';
import { interpretRingLink, buildChecks, summarize } from './status-logic.mjs';
import { LINK_SK } from './household-links.mjs';

const ddb = new DynamoDBClient({});
const sm = new SecretsManagerClient({});
const events = new CloudWatchEventsClient({});
const apprunner = new AppRunnerClient({});
const sqs = new SQSClient({});

const TABLE = process.env.TABLE_NAME;
const HOUSEHOLD_ID = process.env.WICK_HOUSEHOLD_ID;
const RING_TOKEN_SECRET_PREFIX = process.env.RING_TOKEN_SECRET_PREFIX ?? 'wick/ring/tokens';
const MCP_SERVICE_ARN = process.env.MCP_SERVICE_ARN;
const RING_REFRESH_RULE_NAME = process.env.RING_REFRESH_RULE_NAME;
const OPERATOR_LINK_ON = process.env.RING_OPERATOR_LINK === 'true';
const DOOR_DLQ_URL = process.env.DOOR_DLQ_URL;

const URLS = {
  mcpServer: process.env.MCP_SERVER_URL,
  simAlexa: process.env.SIM_ALEXA_URL,
  ringAuthorize: process.env.RING_AUTHORIZE_URL,
  ringWebhook: process.env.RING_WEBHOOK_URL,
  pairingApi: process.env.PAIRING_API_URL,
  websocket: process.env.WEBSOCKET_HTTPS_URL,
};

const FETCH_TIMEOUT_MS = 5000;

/** A status code and the start of the body, or a null status if the endpoint didn't answer in time — never throws. */
async function probe(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, redirect: 'manual', signal: controller.signal });
    const body = await res.text().catch(() => '');
    return { status: res.status, body: body.slice(0, 500) };
  } catch {
    return { status: null, body: '' };
  } finally {
    clearTimeout(timer);
  }
}

async function checkCode(url, init = {}) {
  return (await probe(url, init)).status;
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

/** The household's RING row: how it was linked and until when. Nothing secret is in it. */
async function readLinkRow() {
  try {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND sk = :sk',
      ExpressionAttributeValues: { ':pk': { S: `HH#${HOUSEHOLD_ID}` }, ':sk': { S: LINK_SK } },
    }));
    return res.Items?.[0] ?? null;
  } catch {
    return null;
  }
}

/** That the household's Ring secret exists, and when it last changed — never its value. */
async function describeLinkSecret() {
  try {
    const res = await sm.send(new DescribeSecretCommand({ SecretId: `${RING_TOKEN_SECRET_PREFIX}/${HOUSEHOLD_ID}` }));
    const changed = res.LastChangedDate ?? res.CreatedDate;
    return { exists: !res.DeletedDate, lastChangedAt: changed ? new Date(changed).getTime() : undefined };
  } catch {
    return null;
  }
}

/** Failed door events waiting in the dead-letter queue (infra/alarms.tf), or null if it cannot be read. */
async function doorDeadLetters() {
  if (!DOOR_DLQ_URL) return null;
  try {
    const res = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: DOOR_DLQ_URL,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }));
    return Number(res.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(res.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
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
    mcpServer, simAlexa, ringLinkRoute, ringAuthorize, ringWebhook, pairingApi, websocket,
    appRunnerStat, linkRow, linkSecret, refreshEnabled, deadLetters, rhythmCount, doorEventCount,
  ] = await Promise.all([
    checkCode(`${URLS.mcpServer}/.well-known/oauth-authorization-server`),
    checkCode(`${URLS.simAlexa}/`),
    checkCode(`${URLS.mcpServer}/api/ring`),
    probe(URLS.ringAuthorize),
    checkCode(URLS.ringWebhook, { method: 'POST', body: '{}' }),
    checkCode(`${URLS.pairingApi}/pair/status?code=healthcheck`),
    checkCode(URLS.websocket),
    appRunnerStatus(),
    readLinkRow(),
    describeLinkSecret(),
    refreshScheduleEnabled(),
    doorDeadLetters(),
    countByPrefix('RHYTHM#'),
    countByPrefix('EVT#'),
  ]);

  const checks = buildChecks({
    http: { mcpServer, simAlexa, ringLinkRoute, ringWebhook, pairingApi, websocket },
    ringAuthorize,
    operatorLinkOn: OPERATOR_LINK_ON,
    appRunnerStatus: appRunnerStat,
    householdId: HOUSEHOLD_ID,
    ringLink: interpretRingLink({ row: linkRow, secret: linkSecret }),
    refreshScheduleEnabled: refreshEnabled,
    doorDeadLetters: deadLetters,
    rhythmCount,
    doorEventCount,
  });

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({ checks, summary: summarize(checks), generatedAt: Date.now() }),
  };
};
