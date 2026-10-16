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

describe('routeCardAction — her press changed the language her television speaks', () => {
  const routes = () => ({
    invoke: vi.fn(),
    askFamily: vi.fn(),
    tellAnswer: vi.fn(),
    askResident: vi.fn(),
    withdraw: vi.fn(),
    tellHome: vi.fn(async () => undefined),
    languageChanged: vi.fn(async () => ({ waiting: 3, translated: 1, sent: 1 })),
    // A second after the press (`at: 5` below).
    now: () => 1005,
    reachAsk: vi.fn(),
    reachDue: vi.fn(),
    visitAnswer: vi.fn(),
    askVisits: vi.fn(async () => []),
  });
  const changed = (detail: Record<string, unknown>) => ({ 'detail-type': 'home.changed', detail: { householdId: 'margaret', deviceId: 'wick-tv', home: { light: 'on', language: 'es' }, at: 5, ...detail } });

  it('tells the home’s other televisions first, then has the cards she has not answered put into it — under the change’s own id', async () => {
    const r = routes();
    const order: string[] = [];
    r.tellHome.mockImplementation(async () => { order.push('home told'); });
    r.languageChanged.mockImplementation(async () => { order.push('cards caught up'); return { waiting: 3, translated: 1, sent: 1 }; });

    const out = await routeCardAction(changed({ languageChangedTo: 'es', correlationId: 'corr-9' }), r);

    expect(order).toEqual(['home told', 'cards caught up']);
    expect(r.tellHome).toHaveBeenCalledWith('margaret', { light: 'on', language: 'es' }, 'wick-tv');
    // Every television of the home, the one she pressed included: the cards on it are in the old language too.
    expect(r.languageChanged).toHaveBeenCalledWith('margaret', 'es', 'corr-9');
    expect(out).toEqual({ result: 'home_told', cardsSentAgain: 1 });
    expect(r.invoke).not.toHaveBeenCalled();
  });

  it('does nothing more for a change to English: the stored cards are English already', async () => {
    const r = routes();

    const out = await routeCardAction({ 'detail-type': 'home.changed', detail: { householdId: 'margaret', deviceId: 'wick-tv', home: { light: 'on' }, languageChangedTo: 'en', correlationId: 'corr-9' } }, r);

    expect(r.tellHome).toHaveBeenCalledTimes(1);
    expect(r.languageChanged).not.toHaveBeenCalled();
    expect(out).toEqual({ result: 'home_told' });
  });

  it('does nothing more when the event does not say the language changed, or names one that is not a language', async () => {
    const r = routes();

    for (const detail of [{}, { languageChangedTo: undefined }, { languageChangedTo: 'fr' }, { languageChangedTo: 7 }, { languageChangedTo: '' }]) {
      expect(await routeCardAction(changed(detail), r)).toEqual({ result: 'home_told' });
    }

    expect(r.languageChanged).not.toHaveBeenCalled();
    expect(r.tellHome).toHaveBeenCalledTimes(5);
  });

  it('goes by what the event says changed, never by what the home state happens to carry: every home message of a Spanish household names Spanish', async () => {
    const r = routes();

    // The light put out in a household that already speaks Spanish.
    await routeCardAction({ 'detail-type': 'home.changed', detail: { householdId: 'margaret', deviceId: 'wick-tv', home: { light: 'out', lightOutUntil: 9000, language: 'es' } } }, r);

    expect(r.languageChanged).not.toHaveBeenCalled();
  });

  it('still tells the home when the catching-up fails: the televisions hear of the language whatever becomes of the cards', async () => {
    const r = routes();
    r.languageChanged.mockRejectedValue(Object.assign(new Error('for margaret'), { name: 'ThrottlingException' }));
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});

    const out = await routeCardAction(changed({ languageChangedTo: 'es', correlationId: 'corr-9' }), r);

    expect(out).toEqual({ result: 'home_told' });
    expect(r.tellHome).toHaveBeenCalledTimes(1);
    expect(said.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([{ level: 'error', msg: 'cards_not_put_in_her_language', correlationId: 'corr-9', err: 'ThrottlingException' }]);
    said.mockRestore();
  });

  describe('an old event is not acted on: a change of language is put into her cards when it happens, or not at all', () => {
    const pressedAt = 1_800_000_000_000;
    const at = (ageMs: number) => ({ ...routes(), now: () => pressedAt + ageMs });

    it('acts on one that has just happened', async () => {
      for (const age of [0, 1000, 119_999]) {
        const r = at(age);
        await routeCardAction(changed({ languageChangedTo: 'es', correlationId: 'c', at: pressedAt }), r);
        expect(r.languageChanged).toHaveBeenCalledTimes(1);
      }
    });

    it('does not act on one delivered again minutes, or days, later — today’s cards are not translated and re-sent for a change that is long past', async () => {
      for (const age of [120_001, 3_600_000, 3 * 24 * 3_600_000]) {
        const r = at(age);

        const out = await routeCardAction(changed({ languageChangedTo: 'es', correlationId: 'c', at: pressedAt }), r);

        expect(r.languageChanged).not.toHaveBeenCalled();
        expect(out).toEqual({ result: 'home_told' });
      }
    });

    it('nor on one that does not say when it happened, or claims to be from the future', async () => {
      for (const when of [undefined, 'yesterday', Number.NaN, pressedAt + 10 * 60_000]) {
        const r = at(0);
        await routeCardAction(changed({ languageChangedTo: 'es', correlationId: 'c', at: when }), r);
        expect(r.languageChanged).not.toHaveBeenCalled();
      }
    });
  });

  it('carries the change without an id as well: one is not required to act on it', async () => {
    const r = routes();

    await routeCardAction(changed({ languageChangedTo: 'es' }), r);

    expect(r.languageChanged).toHaveBeenCalledWith('margaret', 'es', undefined);
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


describe('routeCardAction — she has read her week (week.seen)', () => {
  const routes = () => ({
    invoke: vi.fn(),
    askFamily: vi.fn(),
    tellAnswer: vi.fn(),
    askResident: vi.fn(async () => []),
    withdraw: vi.fn(),
    tellHome: vi.fn(),
    reachAsk: vi.fn(),
    reachDue: vi.fn(),
    visitAnswer: vi.fn(),
    askVisits: vi.fn(async () => []),
    weekSeen: vi.fn(async () => ({ result: 'nudged' as const, members: 1 })),
  });
  const seen = { householdId: 'margaret', isoWeek: '2026-W38', at: 5 };

  it('tells the family the week is ready, and is never mistaken for a press', async () => {
    const r = routes();

    const out = await routeCardAction({ 'detail-type': 'week.seen', detail: seen }, r);

    expect(r.weekSeen).toHaveBeenCalledWith(seen);
    expect(r.invoke).not.toHaveBeenCalled();
    expect(out).toEqual({ result: { result: 'nudged', members: 1 } });
  });

  it('ignores it in a deployment that tells nobody', async () => {
    const { weekSeen: _none, ...r } = routes();
    expect(await routeCardAction({ 'detail-type': 'week.seen', detail: seen }, r)).toEqual({ result: 'ignored' });
    expect(r.invoke).not.toHaveBeenCalled();
  });
});
