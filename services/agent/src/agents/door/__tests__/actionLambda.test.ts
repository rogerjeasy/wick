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

    const out = await routeCardAction({ detail: ask }, { invoke, askFamily, tellAnswer: vi.fn(), askResident: vi.fn(), withdraw: vi.fn() });

    expect(askFamily).toHaveBeenCalledWith(ask);
    expect(invoke).not.toHaveBeenCalled();
    expect(out).toEqual({ result: 'asked' });
  });

  it('still hands the hallway chime to the runtime session', async () => {
    const invoke = vi.fn(async () => ({ result: 'rang' }));
    const askFamily = vi.fn();

    const out = await routeCardAction({ detail }, { invoke, askFamily, tellAnswer: vi.fn(), askResident: vi.fn(), withdraw: vi.fn() });

    expect(invoke).toHaveBeenCalledWith('door.action', 'margaret', { detail });
    expect(askFamily).not.toHaveBeenCalled();
    expect(out).toEqual({ result: 'rang' });
  });
});

describe('routeCardAction — "Shall I tell Sarah?"', () => {
  const routes = () => ({
    invoke: vi.fn(),
    askFamily: vi.fn(),
    tellAnswer: vi.fn(async () => 'told' as const),
    askResident: vi.fn(async () => ['missed_visit-maria-2026-10-09']),
    withdraw: vi.fn(async () => undefined),
  });

  it('looks for something to ask when a television says its resident is there', async () => {
    const r = routes();

    const out = await routeCardAction({ 'detail-type': 'television.active', detail: { householdId: 'margaret', deviceId: 'wick-tv', at: 5 } }, r);

    expect(r.askResident).toHaveBeenCalledWith('margaret');
    expect(out).toEqual({ result: 'asked', about: 1 });
    expect(r.invoke).not.toHaveBeenCalled();
  });

  it('asks nothing of a signal that names no household', async () => {
    const r = routes();

    expect(await routeCardAction({ 'detail-type': 'television.active', detail: { deviceId: 'wick-tv' } }, r)).toEqual({ result: 'ignored' });
    expect(r.askResident).not.toHaveBeenCalled();
  });

  it('records either answer itself, without waking the runtime', async () => {
    for (const action of ['tell_family', 'keep_private']) {
      const r = routes();
      const press = { householdId: 'margaret', deviceId: 'wick-tv', cardId: 'tell-missed_visit-maria-2026-10-09', action, at: 5 };

      const out = await routeCardAction({ 'detail-type': 'card.action', detail: press }, r);

      expect(r.tellAnswer).toHaveBeenCalledWith(press);
      expect(out).toEqual({ result: 'told' });
      expect(r.invoke).not.toHaveBeenCalled();
    }
  });
});

describe('routeCardAction — a card finished on one television', () => {
  const routes = () => ({ invoke: vi.fn(), askFamily: vi.fn(), tellAnswer: vi.fn(), askResident: vi.fn(), withdraw: vi.fn(async () => undefined) });
  const retired = { householdId: 'margaret', deviceId: 'wick-tv', cardId: 'note-abc', at: 5 };

  it('is taken off the home’s other televisions, without waking the runtime', async () => {
    const r = routes();

    const out = await routeCardAction({ 'detail-type': 'card.retired', detail: retired }, r);

    // Not the one that was pressed: it has put the card away already.
    expect(r.withdraw).toHaveBeenCalledWith('margaret', 'note-abc', 'wick-tv');
    expect(out).toEqual({ result: 'withdrawn' });
    expect(r.invoke).not.toHaveBeenCalled();
  });

  it('does nothing with one that names no household or no card', async () => {
    const r = routes();

    expect(await routeCardAction({ 'detail-type': 'card.retired', detail: { cardId: 'note-abc' } }, r)).toEqual({ result: 'ignored' });
    expect(await routeCardAction({ 'detail-type': 'card.retired', detail: { householdId: 'margaret' } }, r)).toEqual({ result: 'ignored' });
    expect(r.withdraw).not.toHaveBeenCalled();
    expect(r.invoke).not.toHaveBeenCalled();
  });
});
