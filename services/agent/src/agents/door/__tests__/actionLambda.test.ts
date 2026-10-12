import { describe, it, expect, vi } from 'vitest';
import { forwardCardAction, routeCardAction } from '../actionLambda.js';

const detail = { householdId: 'margaret', deviceId: 'wick-tv', cardId: 'door-abc', action: 'hallway_chime', at: 5 };

describe('forwardCardAction — EventBridge cannot target AgentCore, so this does', () => {
  it('hands the press to the household\'s runtime session as door.action', async () => {
    const invoke = vi.fn(async () => ({ result: 'rang', path: ['gate', 'ring', 'notify'] }));

    const out = await forwardCardAction({ detail }, invoke);

    expect(invoke).toHaveBeenCalledWith('door.action', 'margaret', { detail });
    expect(out).toEqual({ result: 'rang', path: ['gate', 'ring', 'notify'] });
  });

  it('drops an event with no household rather than invoking a session named after nothing', async () => {
    const invoke = vi.fn();
    expect(await forwardCardAction({ detail: { cardId: 'x' } }, invoke)).toEqual({ result: 'ignored' });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('routeCardAction — which presses need the runtime, and which do not', () => {
  const ask = { ...detail, action: 'ask_family' };

  it('answers "Ask Sarah to look" itself: nothing in it needs a model or a Ring call', async () => {
    const invoke = vi.fn();
    const askFamily = vi.fn(async () => 'asked' as const);

    const out = await routeCardAction({ detail: ask }, { invoke, askFamily });

    expect(askFamily).toHaveBeenCalledWith(ask);
    expect(invoke).not.toHaveBeenCalled();
    expect(out).toEqual({ result: 'asked' });
  });

  it('still hands the hallway chime to the runtime session', async () => {
    const invoke = vi.fn(async () => ({ result: 'rang' }));
    const askFamily = vi.fn();

    const out = await routeCardAction({ detail }, { invoke, askFamily });

    expect(invoke).toHaveBeenCalledWith('door.action', 'margaret', { detail });
    expect(askFamily).not.toHaveBeenCalled();
    expect(out).toEqual({ result: 'rang' });
  });
});
