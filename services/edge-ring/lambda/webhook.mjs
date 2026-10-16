/**
 * Ring webhook receiver, as deployed: webhook-receiver.mjs's handler, given
 * the real HMAC key, table and bus. Everything it decides is there, and
 * tested there (__tests__/webhook.test.ts).
 *
 * See docs/WICK-TECHNICAL.md §7.1.
 */
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { createWebhookHandler } from './webhook-receiver.mjs';

const ddb = new DynamoDBClient({});
const bus = new EventBridgeClient({});
const sm = new SecretsManagerClient({});

export const handler = createWebhookHandler({
  readKey: async () => {
    const r = await sm.send(new GetSecretValueCommand({ SecretId: process.env.RING_SECRET_ARN }));
    return JSON.parse(r.SecretString).hmacKey;
  },
  putItem: (input) => ddb.send(new PutItemCommand(input)),
  putEvents: (input) => bus.send(new PutEventsCommand(input)),
  table: process.env.TABLE_NAME,
  busName: process.env.BUS_NAME,
});
