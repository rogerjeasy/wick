/**
 * Deleting an account takes what the assistant kept of the person too: their
 * conversation and their own words in AgentCore Memory (forget.ts), in every
 * home they were in — and, for a home that closes with them, everyone's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../../server.js';
import { linkInvited, linkNewOrganiser, residentAllows, SARAH, startServer, TOM, type Harness, type Linked } from '../../__tests__/harness.js';
import type { AssistantMemory } from '../forget.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function server(overrides: Partial<AppDeps>): Promise<Harness> {
  const h = await startServer(overrides);
  closers.push(h.close);
  return h;
}

const call = (h: Harness, who: Linked, path: string, init: RequestInit = {}) =>
  fetch(`${h.base}${path}`, { ...init, headers: { authorization: `Bearer ${who.tokens.access_token}`, ...(init.headers ?? {}) } });

const deleteAccount = (h: Harness, who: Linked, body: Record<string, unknown>) =>
  call(h, who, '/api/account', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function sarahAndTom(h: Harness): Promise<{ sarah: Linked; tom: Linked }> {
  const sarah = await linkNewOrganiser(h);
  await residentAllows(h, sarah.householdId, sarah.userId);
  const res = await call(h, sarah, '/api/circle/invitations', { method: 'POST' });
  const tom = await linkInvited(h, TOM, ((await res.json()) as { code: string }).code);
  await residentAllows(h, tom.householdId, tom.userId);
  return { sarah, tom };
}

function recordingMemory(failFor?: string): AssistantMemory & { forgotten: { householdId: string; memberId: string }[] } {
  const forgotten: { householdId: string; memberId: string }[] = [];
  return {
    forgotten,
    forget: async (householdId, memberId) => {
      if (memberId === failFor) throw new Error('ThrottlingException');
      forgotten.push({ householdId, memberId });
    },
  };
}

describe('deleting an account forgets what the assistant kept', () => {
  it('forgets a member’s conversation and words in the home they leave, and nobody else’s', async () => {
    const memory = recordingMemory();
    const h = await server({ assistantMemory: memory });
    const { tom } = await sarahAndTom(h);

    expect((await deleteAccount(h, tom, { password: TOM.password })).status).toBe(200);

    expect(memory.forgotten).toEqual([{ householdId: tom.householdId, memberId: tom.userId }]);
  });

  it('forgets everyone’s in a home that closes with the person who set it up', async () => {
    const memory = recordingMemory();
    const h = await server({ assistantMemory: memory });
    const { sarah, tom } = await sarahAndTom(h);

    expect((await deleteAccount(h, sarah, { password: SARAH.password, closeHomes: true })).status).toBe(200);

    expect(memory.forgotten).toEqual(expect.arrayContaining([
      { householdId: sarah.householdId, memberId: sarah.userId },
      { householdId: sarah.householdId, memberId: tom.userId },
    ]));
  });

  it('stops before their place in the circle goes when the memory cannot be reached, so asking again finishes it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing = recordingMemory('never-matches');
    const h = await server({ assistantMemory: failing });
    const { tom } = await sarahAndTom(h);
    failing.forget = async () => { throw new Error('ThrottlingException'); };

    expect((await deleteAccount(h, tom, { password: TOM.password })).status).toBe(500);
    expect(await h.store.getMembership(tom.householdId, tom.userId)).toBeDefined();

    const working = recordingMemory();
    failing.forget = working.forget;
    expect((await deleteAccount(h, tom, {})).status).toBe(200);
    expect(working.forgotten).toEqual([{ householdId: tom.householdId, memberId: tom.userId }]);
    expect(await h.store.getMembership(tom.householdId, tom.userId)).toBeUndefined();
  });

  it('deletes as before where the deployment has no assistant memory', async () => {
    const h = await server({});
    const { tom } = await sarahAndTom(h);

    expect((await deleteAccount(h, tom, { password: TOM.password })).status).toBe(200);
  });
});
