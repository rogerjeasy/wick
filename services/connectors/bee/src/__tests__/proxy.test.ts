import { describe, it, expect, vi } from 'vitest';
import {
  BeeProxyClient,
  BeeProxyError,
  getChanges,
  getDaily,
  listFacts,
  listTodos,
  searchConversationsNeural,
} from '../proxy.js';

function fakeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  ) as unknown as typeof fetch;
}

describe('BeeProxyClient', () => {
  it('defaults to the loopback proxy address', () => {
    expect(new BeeProxyClient().baseUrl).toBe('http://127.0.0.1:8787');
  });

  it('GETs facts from /v1/facts', async () => {
    const fetchImpl = fakeFetch(200, [{ id: 'f1', text: 'mentioned her knee', createdAt: '2026-09-15T09:00:00Z' }]);
    const client = new BeeProxyClient({ fetchImpl });
    const facts = await listFacts(client);
    expect(facts).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8787/v1/facts');
  });

  it('GETs todos from /v1/todos', async () => {
    const fetchImpl = fakeFetch(200, []);
    const client = new BeeProxyClient({ fetchImpl });
    await listTodos(client);
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8787/v1/todos');
  });

  it('appends a cursor query param to /v1/changes only when given one', async () => {
    const fetchImpl = fakeFetch(200, { cursor: 'c2', changes: [] });
    const client = new BeeProxyClient({ fetchImpl });
    await getChanges(client, 'c1');
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8787/v1/changes?cursor=c1');
    await getChanges(client);
    expect(fetchImpl).toHaveBeenLastCalledWith('http://127.0.0.1:8787/v1/changes');
  });

  it('routes a daily id to /v1/daily/:id, and no id to the collection', async () => {
    const fetchImpl = fakeFetch(200, {});
    const client = new BeeProxyClient({ fetchImpl });
    await getDaily(client, 'd1');
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8787/v1/daily/d1');
    await getDaily(client);
    expect(fetchImpl).toHaveBeenLastCalledWith('http://127.0.0.1:8787/v1/daily');
  });

  it('POSTs a neural search query', async () => {
    const fetchImpl = fakeFetch(200, []);
    const client = new BeeProxyClient({ fetchImpl });
    await searchConversationsNeural(client, 'knee');
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:8787/v1/search/conversations/neural',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ query: 'knee' }) }),
    );
  });

  it('throws BeeProxyError on a non-OK response, naming the path', async () => {
    const fetchImpl = fakeFetch(503, { error: 'unavailable' });
    const client = new BeeProxyClient({ fetchImpl });
    await expect(listFacts(client)).rejects.toBeInstanceOf(BeeProxyError);
    await expect(listFacts(client)).rejects.toThrow('bee_proxy_503_/v1/facts');
  });
});
