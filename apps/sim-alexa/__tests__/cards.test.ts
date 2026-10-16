/**
 * The family app's first screen and its cards: what each says and holds,
 * decided in surface.js with no DOM, so it is tested here. main.js only puts
 * these on the page.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain browser module, deliberately untyped (no build step).
import { CAROUSEL_INLINE, developerMode, presentChecklist, presentResult, routeUtterance, weekDays } from '../surface.js';

const at = (ms: number) => `t${ms}`;

const me = (membership: { role: string; status: string }, household: Record<string, unknown> = {}) => ({
  user: { userId: 'guest_1', name: 'Guest', guest: true },
  household: { householdId: 'hh_1', name: 'Demo home', residentName: 'Margaret', ...household },
  membership,
});

describe('developerMode — the server address is a developer’s, and shown only when asked for', () => {
  it('is off for an ordinary visit', () => {
    expect(developerMode('', null)).toBe(false);
    expect(developerMode('?invite=abc', null)).toBe(false);
  });

  it('is on when the page is opened with ?dev, and stays on in that tab once it was', () => {
    expect(developerMode('?dev', null)).toBe(true);
    expect(developerMode('?dev=1&pair=123456', null)).toBe(true);
    expect(developerMode('', '1')).toBe(true);
  });
});

describe('presentChecklist — what is left to set up, from real state', () => {
  it('walks an organiser through the three steps, the first one open', () => {
    const list = presentChecklist(me({ role: 'organiser', status: 'pending' }), 0, false);

    expect(list.steps.map((s: { key: string }) => s.key)).toEqual(['television', 'allowed', 'ask']);
    expect(list.steps.map((s: { done: boolean }) => s.done)).toEqual([false, false, false]);
    expect(list.current).toBe('television');
    expect(list.steps[0].title).toBe('Connect Margaret’s television');
    expect(list.steps[0].action).toEqual({ kind: 'connect', label: 'Connect a television' });
    // Nothing further can be done yet: only the open step offers its action.
    expect(list.steps[1].action).toBeUndefined();
    expect(list.steps[2].action).toBeUndefined();
    expect(list.complete).toBe(false);
  });

  it('ticks the television once one is connected, and then waits for her press', () => {
    const list = presentChecklist(me({ role: 'organiser', status: 'pending' }), 1, false);

    expect(list.steps[0]).toMatchObject({ done: true, detail: 'Connected.' });
    expect(list.current).toBe('allowed');
    expect(list.steps[1].detail).toMatch(/Margaret’s television asks whether to allow you/);
    // Waiting on the resident: there is nothing to press here, and nothing pretends there is.
    expect(list.steps[1].action).toBeUndefined();
    expect(list.waiting).toBe(true);
  });

  it('offers the first question once she has allowed you', () => {
    const list = presentChecklist(me({ role: 'organiser', status: 'allowed' }), 1, false);

    expect(list.steps.slice(0, 2).every((s: { done: boolean }) => s.done)).toBe(true);
    expect(list.current).toBe('ask');
    expect(list.steps[2].action).toEqual({ kind: 'ask', label: 'Ask how Margaret has been', utterance: 'How has Margaret been this week?' });
    expect(list.waiting).toBe(false);
  });

  it('asks a first question that is answered even with no model: by the rules, it is the week', () => {
    const { action } = presentChecklist(me({ role: 'organiser', status: 'allowed' }), 1, false).steps[2];
    expect(routeUtterance(action.utterance)).toEqual({ kind: 'tool', tool: 'get_week_narrative', args: {} });
  });

  it('is complete once the first question has been asked', () => {
    const list = presentChecklist(me({ role: 'organiser', status: 'allowed' }), 1, true);
    expect(list.complete).toBe(true);
    expect(list.current).toBeNull();
  });

  it('does not ask a family member to connect her television: the organiser does', () => {
    const list = presentChecklist(me({ role: 'family', status: 'pending' }), undefined, false);
    expect(list.steps.map((s: { key: string }) => s.key)).toEqual(['allowed', 'ask']);
    expect(list.current).toBe('allowed');
  });

  it('has nothing to set up for somebody she turned down or removed', () => {
    expect(presentChecklist(me({ role: 'family', status: 'declined' }), undefined, false)).toBeNull();
    expect(presentChecklist(me({ role: 'family', status: 'removed' }), undefined, false)).toBeNull();
  });

  it('is only ever a step to take, never a count of anything in the house', () => {
    const list = presentChecklist(me({ role: 'organiser', status: 'allowed' }), 3, false);
    expect(JSON.stringify(list)).not.toMatch(/\b3\b|three/i);
  });
});

describe('weekDays — the days of a week, from its timeline and nothing else', () => {
  // Tuesday 29 September and Friday 2 October 2026, in London (UTC+1).
  const tue0905 = Date.UTC(2026, 8, 29, 8, 5);
  const tue1730 = Date.UTC(2026, 8, 29, 16, 30);
  const fri0910 = Date.UTC(2026, 9, 2, 8, 10);
  const lateSunUtc = Date.UTC(2026, 9, 4, 23, 30); // Monday 00:30 in London

  it('groups the entries by the day they happened at the house, oldest first', () => {
    const days = weekDays(
      [
        { at: fri0910, kind: 'visit', summary: 'Maria visited.' },
        { at: tue1730, kind: 'door', summary: 'Someone came to the door.' },
        { at: tue0905, kind: 'visit', summary: 'Maria visited.' },
      ],
      'Europe/London',
    );

    expect(days).toEqual([
      {
        date: '2026-09-29',
        weekday: 'Tuesday',
        dayMonth: '29 Sept',
        count: 'Two things',
        entries: [
          { time: '09:05', text: 'Maria visited.' },
          { time: '17:30', text: 'Someone came to the door.' },
        ],
      },
      { date: '2026-10-02', weekday: 'Friday', dayMonth: '2 Oct', count: 'One thing', entries: [{ time: '09:10', text: 'Maria visited.' }] },
    ]);
  });

  it('counts a day in the house’s time zone, not the reader’s', () => {
    expect(weekDays([{ at: lateSunUtc, kind: 'door', summary: 'Post.' }], 'Europe/London')[0].weekday).toBe('Monday');
    expect(weekDays([{ at: lateSunUtc, kind: 'door', summary: 'Post.' }], 'UTC')[0].weekday).toBe('Sunday');
  });

  it('shows no day that has nothing in it: an empty day is not a fact the week gave', () => {
    expect(weekDays([], 'UTC')).toEqual([]);
  });

  it('leaves out an entry it cannot read rather than guess at it', () => {
    const days = weekDays(
      [
        { at: 'soon', kind: 'door', summary: 'x' },
        { at: tue0905, kind: 'door', summary: 42 },
        { at: tue0905, kind: 'door', summary: 'Post.' },
      ],
      'UTC',
    );
    expect(days).toHaveLength(1);
    expect(days[0].entries).toEqual([{ time: '08:05', text: 'Post.' }]);
  });

  it('carries every string from the tool as it was, and only as text', () => {
    const odd = '<img src=x onerror=alert(1)>';
    const [day] = weekDays([{ at: tue0905, kind: 'door', summary: odd }], 'UTC');
    expect(day.entries[0].text).toBe(odd);
  });
});

describe('the week card — the paragraph, then a carousel of its days', () => {
  const week = {
    isoWeek: '2026-W40',
    text: 'A steady week. Maria came on Tuesday and Friday.',
    timeline: [
      { at: Date.UTC(2026, 8, 29, 8, 5), kind: 'visit', summary: 'Maria visited.' },
      { at: Date.UTC(2026, 9, 2, 8, 10), kind: 'visit', summary: 'Maria visited.' },
    ],
    deltas: [{ metric: 'door', label: 'the front door', thisWeek: 4, lastWeek: 5, baseline: 5, zScore: 0, baselineWeeks: 6, verdict: 'usual' }],
  };
  const context = { now: Date.UTC(2026, 9, 1, 12), timeZone: 'Europe/London' };

  it('is a week card: the paragraph the tool wrote, its days, its measures and its footnote', () => {
    const r = presentResult('get_week_narrative', JSON.stringify(week), context, at);

    expect(r.card.kind).toBe('week');
    expect(r.card.text).toBe(week.text);
    expect(r.card.days.map((d: { weekday: string }) => d.weekday)).toEqual(['Tuesday', 'Friday']);
    expect(r.card.facts).toEqual([{ label: 'The front door', value: '4 this week · 5 the week before · usually about 5' }]);
    expect(r.card.footnote).toMatch(/read it first/);
  });

  it('says it is simulated, on the card, for a demo home’s week', () => {
    const r = presentResult('get_week_narrative', JSON.stringify({ ...week, simulated: true }), context, at);
    expect(r.card.footnote).toBe('Simulated: this is a demo home, and nobody lived this week.');
  });

  it('has no days to show for a week with nothing at the door, and says so in the words it always used', () => {
    const r = presentResult('get_week_narrative', JSON.stringify({ ...week, timeline: [] }), context, at);
    expect(r.card.days).toEqual([]);
    expect(r.card.empty).toBe('Nothing at the door this week.');
  });

  it('shows the guide’s three to five items inline before “See all”', () => {
    expect(CAROUSEL_INLINE).toBeGreaterThanOrEqual(3);
    expect(CAROUSEL_INLINE).toBeLessThanOrEqual(5);
  });
});

describe('the door card — header, picture, sentence, and at most three answers', () => {
  const request = {
    requestId: 'req_1',
    state: 'waiting',
    line: 'Margaret asked you to look at who is at the door.',
    askedAt: 1000,
    pictureUrl: 'https://example.com/door.jpg',
    description: 'A woman in a blue coat holding a folder.',
    answers: [
      { key: 'known', text: "It's all right, I know who that is." },
      { key: 'dont_open', text: "Please don't open the door. I'll ring you now." },
      { key: 'not_sure', text: "I can't tell who that is. I'll ring you now." },
      { key: 'extra', text: 'Let them in.' },
    ],
  };

  it('holds what the tool returned and no more than three answers it knows', () => {
    const r = presentResult('get_door_request', JSON.stringify(request), {}, at);
    expect(r.card.kind).toBe('door');
    expect(r.card.title).toBe(request.line);
    expect(r.card.pictureUrl).toBe(request.pictureUrl);
    expect(r.card.description).toBe(request.description);
    expect(r.card.answers.map((a: { key: string }) => a.key)).toEqual(['known', 'dont_open', 'not_sure']);
  });

  it('never draws a picture from an address that is not https', () => {
    for (const pictureUrl of ['http://example.com/a.jpg', 'javascript:alert(1)', 'https://x.com/a b.jpg', 42]) {
      expect(presentResult('get_door_request', JSON.stringify({ ...request, pictureUrl }), {}, at).card.pictureUrl).toBeNull();
    }
  });
});
