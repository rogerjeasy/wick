import { describe, it, expect, vi } from 'vitest';
import { forwardCardAction } from '../actionLambda.js';

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
