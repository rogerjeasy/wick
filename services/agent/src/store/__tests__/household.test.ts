import { describe, expect, it, vi } from 'vitest';
import { GetItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { isDemoHome } from '../household.js';

const ddbWith = (item: Record<string, AttributeValue> | undefined) => ({ send: vi.fn(async (_command: GetItemCommand) => ({ Item: item })) });

describe('isDemoHome — is this household a guest’s demo home?', () => {
  it('is, when the household was set up as one: its META row is marked simulated', async () => {
    const ddb = ddbWith({ createdBy: { S: 'guest_abc' }, simulated: { BOOL: true } });
    expect(await isDemoHome(ddb, 'wick', 'hh-demo')).toBe(true);
    const command = ddb.send.mock.calls[0]![0]!;
    expect(command.input).toMatchObject({ TableName: 'wick', Key: { pk: { S: 'HH#hh-demo' }, sk: { S: 'META' } }, ConsistentRead: true });
  });

  it('is not, for a household a person set up', async () => {
    expect(await isDemoHome(ddbWith({ createdBy: { S: 'user-1' } }), 'wick', 'hh-1')).toBe(false);
    expect(await isDemoHome(ddbWith({ createdBy: { S: 'user-1' }, simulated: { BOOL: false } }), 'wick', 'hh-1')).toBe(false);
  });

  it('is not, for a household nobody set up, or none at all', async () => {
    expect(await isDemoHome(ddbWith({ simulated: { BOOL: true } }), 'wick', 'hh-x')).toBe(false);
    expect(await isDemoHome(ddbWith(undefined), 'wick', 'hh-x')).toBe(false);
  });
});
