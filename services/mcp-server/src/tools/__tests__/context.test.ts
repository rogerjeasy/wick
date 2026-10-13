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

describe('gated — a neighbour is asked two things, and shown nothing else', () => {
  const tom = allowedContext('hh_1', { userId: 'u_tom', name: 'Tom', role: 'neighbour' });

  it('refuses a neighbour any tool that was not made for one, in words, and never runs it', async () => {
    const handler = vi.fn(async () => 'the week');

    const result = await gated(tom, handler)();

    expect(result).toEqual({ content: [{ type: 'text', text: 'Margaret has asked you to help in two ways: to look at who is at the door, and to ring when asked. Nothing else about the house is shared with a neighbour.' }] });
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs the tools that are a neighbour’s: the door, and being asked to ring', async () => {
    expect(await gated(tom, async (allowed) => allowed.membership.name, { neighbour: true })()).toBe('Tom');
  });

  it('does not note a look by a neighbour: a neighbour cannot ask after her', async () => {
    const lookedIn = vi.fn(async () => {});
    await gated({ ...tom, lookedIn }, async () => 'the light', { looksIn: true })();
    expect(lookedIn).not.toHaveBeenCalled();
  });

  it('changes nothing for the family', async () => {
    expect(await gated(allowedContext('hh_1', { role: 'family' }), async () => 'the week')()).toBe('the week');
  });
});

