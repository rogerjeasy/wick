import { describe, expect, it, vi } from 'vitest';
import { gated, type ToolContext } from '../context.js';
import { allowedContext } from './toolContext.js';

describe('gated — INV-9 on every tool call', () => {
  it('answers with the refusal, in words, and never runs the tool', async () => {
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'the week' }] }));
    const ctx: ToolContext = {
      householdId: 'hh_1',
      userId: 'u_sarah',
      access: async () => ({ ok: false, reason: 'waiting', say: 'Margaret hasn’t allowed this yet.' }),
    };

    const result = await gated(ctx, handler)();

    expect(result).toEqual({ content: [{ type: 'text', text: 'Margaret hasn’t allowed this yet.' }] });
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs the tool for someone the resident allowed, and tells it who they are', async () => {
    const ctx = allowedContext('hh_1', { name: 'Sarah' });

    const result = await gated(ctx, async (allowed, args: { n: number }) => `${allowed.membership.name}:${args.n}`)({ n: 2 });

    expect(result).toBe('Sarah:2');
  });

  it('asks again on every call: the resident’s answer counts at once, both ways', async () => {
    let allowed = false;
    const base = allowedContext('hh_1');
    const ctx: ToolContext = {
      ...base,
      access: async () => (allowed ? base.access() : { ok: false, reason: 'waiting', say: 'Not yet.' }),
    };
    const tool = gated(ctx, async () => 'ok');

    expect(await tool()).toEqual({ content: [{ type: 'text', text: 'Not yet.' }] });
    allowed = true;
    expect(await tool()).toBe('ok');
  });
});
