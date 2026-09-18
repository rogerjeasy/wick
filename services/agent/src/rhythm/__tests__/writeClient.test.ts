import { describe, it, expect, vi } from 'vitest';
import { UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { createRhythmWriter } from '../writeClient.js';
import { buildDoorActivityKey } from '../records.js';

function fakeClient() {
  return { send: vi.fn(async (_command: UpdateItemCommand) => ({})) };
}

describe('createRhythmWriter', () => {
  it('atomically increments the bucket\'s count with UpdateItem, never a PutItem replace', async () => {
    const client = fakeClient();
    const writer = createRhythmWriter(client, 'wick');
    const key = buildDoorActivityKey({
      householdId: 'hh-1',
      deviceId: 'dev-1',
      subType: 'human',
      measureName: 'motion',
      at: 1789455093305,
    });

    await writer.increment(key, 1789455093305);

    expect(client.send).toHaveBeenCalledTimes(1);
    const command = client.send.mock.calls[0]![0]!;
    expect(command).toBeInstanceOf(UpdateItemCommand);
    expect(command.input).toEqual({
      TableName: 'wick',
      Key: { pk: { S: key.pk }, sk: { S: key.sk } },
      UpdateExpression: 'ADD #count :incr SET lastSeenAt = :now',
      ExpressionAttributeNames: { '#count': 'count' },
      ExpressionAttributeValues: {
        ':incr': { N: '1' },
        ':now': { N: '1789455093305' },
      },
    });
  });

  it('rejects when the underlying client rejects — a caller decides whether to swallow it', async () => {
    const client = { send: vi.fn(async () => { throw new Error('ddb_down'); }) };
    const writer = createRhythmWriter(client, 'wick');
    const key = buildDoorActivityKey({
      householdId: 'hh-1',
      deviceId: 'dev-1',
      subType: 'human',
      measureName: 'motion',
      at: 1789455093305,
    });

    await expect(writer.increment(key, 1789455093305)).rejects.toThrow('ddb_down');
  });
});
