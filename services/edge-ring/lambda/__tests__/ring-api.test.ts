import { describe, it, expect } from 'vitest';
import {
  refreshTokens,
  fetchAccountIdentifier,
  completeAppIntegration,
  // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
} from '../ring-api.mjs';

type Call = { url: string; init: RequestInit };

/** A fetch stub that records what was sent and replays a scripted response. */
function stubFetch(response: { ok: boolean; status?: number; json?: unknown; text?: string }) {
  const calls: Call[] = [];
  const impl = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      json: async () => response.json,
      text: async () => response.text ?? '',
    };
  };
  return { impl, calls };
}

const bodyParams = (init: RequestInit) =>
  Object.fromEntries(new URLSearchParams(String(init.body)));

describe('refreshTokens', () => {
  it('sends the refresh_token grant with the client credentials', async () => {
    const { impl, calls } = stubFetch({ ok: true, json: { access_token: 'fresh' } });

    const out = await refreshTokens({
      refreshToken: 'r-123',
      clientId: 'cid',
      clientSecret: 'secret',
      fetchImpl: impl,
    });

    expect(out).toEqual({ access_token: 'fresh' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://oauth.ring.com/oauth/token');
    expect(calls[0]!.init.method).toBe('POST');
    expect(bodyParams(calls[0]!.init)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'r-123',
      client_id: 'cid',
      client_secret: 'secret',
    });
  });

  it('surfaces the status when Ring declines, so a 400 is not read as a 500', async () => {
    const { impl } = stubFetch({ ok: false, status: 400, text: 'invalid_grant' });

    await expect(refreshTokens({
      refreshToken: 'dead', clientId: 'c', clientSecret: 's', fetchImpl: impl,
    })).rejects.toMatchObject({ message: 'refresh_failed', status: 400, detail: 'invalid_grant' });
  });
});

describe('fetchAccountIdentifier', () => {
  it('reads the account id from the JSON:API envelope Ring actually returns', async () => {
    // Verified against the live API: { data: { type: 'users', id: 'ava1.ring.account.…' } }
    const { impl, calls } = stubFetch({
      ok: true,
      json: { data: { type: 'users', id: 'ava1.ring.account.FDZC4GQ', attributes: {} } },
    });

    await expect(fetchAccountIdentifier({ accessToken: 'tok', fetchImpl: impl }))
      .resolves.toBe('ava1.ring.account.FDZC4GQ');

    expect(calls[0]!.url).toBe('https://api.amazonvision.com/v1/users/me');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization)
      .toBe('Bearer tok');
  });

  it('prefers the envelope over a stray top-level id', async () => {
    const both = stubFetch({
      ok: true,
      json: { id: 'wrong', data: { id: 'ava1.ring.account.RIGHT' } },
    });
    await expect(fetchAccountIdentifier({ accessToken: 't', fetchImpl: both.impl }))
      .resolves.toBe('ava1.ring.account.RIGHT');
  });

  it('falls back through the field names Ring might use', async () => {
    const byAccountId = stubFetch({ ok: true, json: { account_id: 'acct-9' } });
    await expect(fetchAccountIdentifier({ accessToken: 't', fetchImpl: byAccountId.impl }))
      .resolves.toBe('acct-9');

    const byId = stubFetch({ ok: true, json: { id: 'acct-id' } });
    await expect(fetchAccountIdentifier({ accessToken: 't', fetchImpl: byId.impl }))
      .resolves.toBe('acct-id');

    const byEmail = stubFetch({ ok: true, json: { email: 'a@b.c' } });
    await expect(fetchAccountIdentifier({ accessToken: 't', fetchImpl: byEmail.impl }))
      .resolves.toBe('a@b.c');

    const empty = stubFetch({ ok: true, json: {} });
    await expect(fetchAccountIdentifier({ accessToken: 't', fetchImpl: empty.impl }))
      .resolves.toBeNull();
  });
});

describe('completeAppIntegration', () => {
  it('PATCHes status completed with the account identifier', async () => {
    const { impl, calls } = stubFetch({ ok: true, json: {} });

    await expect(completeAppIntegration({
      accessToken: 'tok', accountIdentifier: 'acct-9', fetchImpl: impl,
    })).resolves.toBe(true);

    expect(calls[0]!.url).toBe('https://api.amazonvision.com/v1/accounts/me/app-integrations');
    expect(calls[0]!.init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      status: 'completed',
      account_identifier: 'acct-9',
    });
  });

  it('still completes when the identifier lookup came back empty', async () => {
    const { impl, calls } = stubFetch({ ok: true, json: {} });

    await completeAppIntegration({ accessToken: 'tok', accountIdentifier: null, fetchImpl: impl });

    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ status: 'completed' });
  });

  it('reports the failure rather than letting the link look finished', async () => {
    const { impl } = stubFetch({ ok: false, status: 403, text: 'forbidden' });

    await expect(completeAppIntegration({ accessToken: 't', accountIdentifier: 'a', fetchImpl: impl }))
      .rejects.toMatchObject({ message: 'complete_integration_failed', status: 403 });
  });
});
