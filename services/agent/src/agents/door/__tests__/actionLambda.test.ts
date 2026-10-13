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

    const out = await routeCardAction({ detail: ask }, { invoke, askFamily, tellAnswer: vi.fn(), askResident: vi.fn(), withdraw: vi.fn(), tellHome: vi.fn(), reachAsk: vi.fn(), reachDue: vi.fn(), visitAnswer: vi.fn(), askVisits: vi.fn(async () => []) });

    expect(askFamily).toHaveBeenCalledWith(ask);
    expect(invoke).not.toHaveBeenCalled();
    expect(out).toEqual({ result: 'asked' });
  });

  it('still hands the hallway chime to the runtime session', async () => {
    const invoke = vi.fn(async () => ({ result: 'rang' }));
    const askFamily = vi.fn();

    const out = await routeCardAction({ detail }, { invoke, askFamily, tellAnswer: vi.fn(), askResident: vi.fn(), withdraw: vi.fn(), tellHome: vi.fn(), reachAsk: vi.fn(), reachDue: vi.fn(), visitAnswer: vi.fn(), askVisits: vi.fn(async () => []) });

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
    tellHome: vi.fn(async () => undefined),
    reachAsk: vi.fn(),
    reachDue: vi.fn(),
    visitAnswer: vi.fn(),
    askVisits: vi.fn(async () => []),
  });

  it('looks for something to ask when a television says its resident is there', async () => {
    const r = routes();

    const out = await routeCardAction({ 'detail-type': 'television.active', detail: { householdId: 'margaret', deviceId: 'wick-tv', at: 5 } }, r);

    expect(r.askResident).toHaveBeenCalledWith('margaret');
    expect(out).toEqual({ result: 'asked', about: 1, visits: 0 });
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
  const routes = () => ({ invoke: vi.fn(), askFamily: vi.fn(), tellAnswer: vi.fn(), askResident: vi.fn(), withdraw: vi.fn(async () => undefined), tellHome: vi.fn(async () => undefined), reachAsk: vi.fn(), reachDue: vi.fn(), visitAnswer: vi.fn(), askVisits: vi.fn(async () => []) });
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

describe('routeCardAction — the home screen changed on one television', () => {
  const routes = () => ({ invoke: vi.fn(), askFamily: vi.fn(), tellAnswer: vi.fn(), askResident: vi.fn(), withdraw: vi.fn(), tellHome: vi.fn(async () => undefined), reachAsk: vi.fn(), reachDue: vi.fn(), visitAnswer: vi.fn(), askVisits: vi.fn(async () => []) });
  const home = { light: 'out', lightOutUntil: 9000 };

  it('is told to the home’s other televisions, whole, without waking the runtime', async () => {
    const r = routes();

    const out = await routeCardAction({ 'detail-type': 'home.changed', detail: { householdId: 'margaret', deviceId: 'wick-tv', home, at: 5 } }, r);

    // Not the one that was pressed: the edge has told it already.
    expect(r.tellHome).toHaveBeenCalledWith('margaret', home, 'wick-tv');
    expect(out).toEqual({ result: 'home_told' });
    expect(r.invoke).not.toHaveBeenCalled();
  });

  it('passes on only what a home screen is ever told', async () => {
    const r = routes();

    await routeCardAction({ 'detail-type': 'home.changed', detail: { householdId: 'margaret', home: { light: 'on', programme: 'sintel', lookedIn: { name: 'Sarah' } } } }, r);

    expect(r.tellHome).toHaveBeenCalledWith('margaret', { light: 'on' }, undefined);
  });

  it('tells them when there is no light left to show: nobody can see one any more', async () => {
    const r = routes();

    await routeCardAction({ 'detail-type': 'home.changed', detail: { householdId: 'margaret', deviceId: 'wick-tv', home: {} } }, r);

    expect(r.tellHome).toHaveBeenCalledWith('margaret', {}, 'wick-tv');
  });

  it('does nothing with one that names no household or carries no state', async () => {
    const r = routes();

    expect(await routeCardAction({ 'detail-type': 'home.changed', detail: { home } }, r)).toEqual({ result: 'ignored' });
    expect(await routeCardAction({ 'detail-type': 'home.changed', detail: { householdId: 'margaret' } }, r)).toEqual({ result: 'ignored' });
    expect(r.tellHome).not.toHaveBeenCalled();
  });
});

describe('routeCardAction — "Hold for Sarah"', () => {
  const others = { invoke: vi.fn(), askFamily: vi.fn(), tellAnswer: vi.fn(), askResident: vi.fn(), withdraw: vi.fn(), tellHome: vi.fn(), visitAnswer: vi.fn(), askVisits: vi.fn(async () => []) };
  const reach = { ...detail, cardId: 'reach-1790000000000' };

  it('carries out "Yes, ask Sarah" and "Just say hello" itself, without waking the runtime', async () => {
    for (const action of ['ring_me', 'say_hello']) {
      const invoke = vi.fn();
      const reachAsk = vi.fn(async () => 'asked' as const);
      const out = await routeCardAction({ 'detail-type': 'card.action', detail: { ...reach, action } }, { ...others, invoke, reachAsk, reachDue: vi.fn() });
      expect(reachAsk).toHaveBeenCalledWith({ ...reach, action });
      expect(invoke).not.toHaveBeenCalled();
      expect(out).toEqual({ result: 'asked' });
    }
  });

  it('asks the next person when the three minutes are over', async () => {
    const reachDue = vi.fn(async () => 'asked_next' as const);
    const reachAsk = vi.fn();
    const due = { householdId: 'margaret', reachId: '1790000000000', step: 1 };
    const out = await routeCardAction({ 'detail-type': 'reach.due', detail: due }, { ...others, reachAsk, reachDue });
    expect(reachDue).toHaveBeenCalledWith(due);
    expect(reachAsk).not.toHaveBeenCalled();
    expect(out).toEqual({ result: 'asked_next' });
  });

  it('never takes a timer for a press: a timer that names one of her buttons still asks nobody anew', async () => {
    const reachAsk = vi.fn();
    const reachDue = vi.fn(async () => 'ignored' as const);
    await routeCardAction({ 'detail-type': 'reach.due', detail: { ...reach, action: 'ring_me' } }, { ...others, reachAsk, reachDue });
    expect(reachAsk).not.toHaveBeenCalled();
  });
});

describe('routeCardAction — "The visit, witnessed"', () => {
  const routes = () => ({
    invoke: vi.fn(), askFamily: vi.fn(), tellAnswer: vi.fn(), withdraw: vi.fn(), tellHome: vi.fn(), reachAsk: vi.fn(), reachDue: vi.fn(),
    askResident: vi.fn(async () => ['missed_visit-maria-2026-10-09']),
    visitAnswer: vi.fn(async () => 'confirmed' as const),
    askVisits: vi.fn(async () => ['1791878520000-maria']),
  });

  it('records her yes or no itself, without waking the runtime', async () => {
    for (const action of ['visit_right', 'visit_wrong']) {
      const r = routes();
      const press = { ...detail, cardId: 'visit-1791878520000-maria', action };
      expect(await routeCardAction({ 'detail-type': 'card.action', detail: press }, r)).toEqual({ result: 'confirmed' });
      expect(r.visitAnswer).toHaveBeenCalledWith(press);
      expect(r.invoke).not.toHaveBeenCalled();
    }
  });

  it('asks about a visit when a television says its resident is there — beside anything that is different', async () => {
    const r = routes();
    const out = await routeCardAction({ 'detail-type': 'television.active', detail: { householdId: 'margaret' } }, r);
    expect(r.askVisits).toHaveBeenCalledWith('margaret');
    expect(r.askResident).toHaveBeenCalledWith('margaret');
    expect(out).toEqual({ result: 'asked', about: 1, visits: 1 });
  });

  it('still asks about what is different when the visits cannot be read', async () => {
    const r = { ...routes(), askVisits: vi.fn(async () => { throw new Error('ddb_down'); }) };
    expect(await routeCardAction({ 'detail-type': 'television.active', detail: { householdId: 'margaret' } }, r)).toEqual({ result: 'asked', about: 1, visits: 0 });
  });
});

