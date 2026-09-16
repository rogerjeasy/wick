import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { loadHouseholdPolicy } from '../get_resident_shared_view.js';
import { DEFAULT_POLICY } from '@wick/policy';

describe('loadHouseholdPolicy', () => {
  it('returns DEFAULT_POLICY when the household has no stored policy', async () => {
    const ddb = { send: vi.fn().mockResolvedValue({ Item: undefined }) } as unknown as DynamoDBClient;
    const policy = await loadHouseholdPolicy(ddb, 'hh-1');
    expect(policy).toEqual(DEFAULT_POLICY);
  });

  it('parses a stored policy from the household META item', async () => {
    const stored = { ...DEFAULT_POLICY, residentExclusions: ['FINANCIAL' as const] };
    const ddb = {
      send: vi.fn().mockResolvedValue({ Item: { policy: { S: JSON.stringify(stored) } } }),
    } as unknown as DynamoDBClient;
    const policy = await loadHouseholdPolicy(ddb, 'hh-1');
    expect(policy.residentExclusions).toEqual(['FINANCIAL']);
  });
});
