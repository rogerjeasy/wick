/**
 * The WebSocket route's heartbeat (route.mjs): a television's `ping` is
 * answered with a `pong` on the same connection, before anything is read.
 * Nothing else about the route changes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const aws = vi.hoisted(() => {
  process.env.TABLE_NAME = 'wick';
  return {
    table: [] as string[],
    posted: [] as { ConnectionId: string; Data: string }[],
  };
});

vi.mock('@aws-sdk/client-dynamodb', () => {
  class GetItemCommand {
    constructor(readonly input: Record<string, unknown>) {}
  }
  class DynamoDBClient {
    async send(cmd: GetItemCommand) {
      aws.table.push(JSON.stringify(cmd.input));
      return { Item: undefined };
    }
  }
  return { DynamoDBClient, GetItemCommand };
});

vi.mock('@aws-sdk/client-apigatewaymanagementapi', () => {
  class PostToConnectionCommand {
    constructor(readonly input: { ConnectionId: string; Data: string }) {}
  }
  class ApiGatewayManagementApiClient {
    async send(cmd: PostToConnectionCommand) {
      aws.posted.push(cmd.input);
      return {};
    }
  }
  return { ApiGatewayManagementApiClient, PostToConnectionCommand };
});

vi.mock('../device-event.mjs', () => ({ handleDeviceEvent: vi.fn(async () => ({ statusCode: 200 })) }));

// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { handler } from '../route.mjs';

const event = (body: string) => ({
  body,
  requestContext: { connectionId: 'conn-1', domainName: 'ws.example', stage: 'prod' },
});

describe('the WebSocket route heartbeat', () => {
  beforeEach(() => {
    aws.table.length = 0;
    aws.posted.length = 0;
  });

  it('answers a ping with a pong on the same connection', async () => {
    const result = await handler(event(JSON.stringify({ t: 'ping' })));
    expect(result.statusCode).toBe(200);
    expect(aws.posted).toHaveLength(1);
    expect(aws.posted[0]!.ConnectionId).toBe('conn-1');
    expect(JSON.parse(aws.posted[0]!.Data)).toEqual({ kind: 'control', control: { t: 'pong' } });
  });

  it('reads no table for a ping: it says nothing of any home', async () => {
    await handler(event(JSON.stringify({ t: 'ping' })));
    expect(aws.table).toEqual([]);
  });

  it('still refuses an event from a connection it does not know', async () => {
    const result = await handler(event(JSON.stringify({ t: 'card_shown', cardId: 'c1', at: 1 })));
    expect(result.statusCode).toBe(401);
    expect(aws.posted).toEqual([]);
  });

  it('still refuses a body that is not JSON', async () => {
    expect((await handler(event('{nope'))).statusCode).toBe(400);
  });
});
