import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { loadHouseholdPolicy, registerGetResidentSharedView } from '../get_resident_shared_view.js';
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

  it('honours what the resident chose on their own television — the META string set — with no stored policy', async () => {
    const ddb = {
      send: vi.fn().mockResolvedValue({ Item: { residentExclusions: { SS: ['PRESENCE'] } } }),
    } as unknown as DynamoDBClient;
    const policy = await loadHouseholdPolicy(ddb, 'hh-1');
    expect(policy.table).toEqual(DEFAULT_POLICY.table);
    expect(policy.residentExclusions).toEqual(['PRESENCE']);
  });

  it('merges the television’s choices with the stored policy’s own exclusions', async () => {
    const stored = { ...DEFAULT_POLICY, residentExclusions: ['FINANCIAL' as const] };
    const ddb = {
      send: vi.fn().mockResolvedValue({ Item: { policy: { S: JSON.stringify(stored) }, residentExclusions: { SS: ['PRESENCE', 'FINANCIAL'] } } }),
    } as unknown as DynamoDBClient;
    expect((await loadHouseholdPolicy(ddb, 'hh-1')).residentExclusions).toEqual(['FINANCIAL', 'PRESENCE']);
  });
});

describe('get_resident_shared_view NEVER_TO_FAMILY guard', () => {
  it('never reports a NEVER_TO_FAMILY class as shared, even when familyPermitted opts it in', async () => {
    // HEALTH is in NEVER_TO_FAMILY (packages/contracts/src/fact.ts). A household
    // policy that opts it into familyPermitted must NOT have this tool report it as
    // shared — matching services/policy/src/evaluate.ts's `!isNeverToFamily(...)` guard.
    const stored = { ...DEFAULT_POLICY, familyPermitted: ['HEALTH' as const] };
    const ddb = {
      send: vi.fn().mockResolvedValue({ Item: { policy: { S: JSON.stringify(stored) } } }),
    } as unknown as DynamoDBClient;

    const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerGetResidentSharedView(mcpServer, ddb);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'get_resident_shared_view', arguments: {} });
    const content = result.content as { type: string; text: string }[];
    const parsed = JSON.parse(content[0]!.text) as { sharedWithFamily: string[] };

    expect(parsed.sharedWithFamily).not.toContain('HEALTH');
  });
});
