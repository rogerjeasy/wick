/**
 * Visit errands in the family app (errands.js): the card each errand tool's
 * answer becomes, the question asked before one is arranged or called off,
 * and what is news when a nudge says a visit has an answer. No DOM, no
 * network: main.js only puts these on the page.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain browser module, deliberately untyped (no build step).
import { ARRANGE_NEEDS_ASSISTANT, ERRAND_SUGGESTION, confirmErrand, describeErrandCall, errandNews, presentErrand, withNoteSent } from '../errands.js';
// @ts-expect-error — the same.
import { SUGGESTIONS, confirmWrite, describeCall, presentResult, presentTurn, routeUtterance } from '../surface.js';

const THURSDAY_TEN = Date.UTC(2026, 9, 15, 9);
const view = (over: Record<string, unknown> = {}) => ({
  errandId: 'err_AAAAAAAAAAAAAAAAAAAA',
  who: 'the plumber',
  at: THURSDAY_TEN,
  when: 'Thursday 15 October at 10:00 am',
  windowMinutes: 60,
  remindAt: Date.UTC(2026, 9, 15, 7),
  reminded: false,
  tellMe: true,
  status: 'planned',
  said: 'The door knows to expect the plumber on Thursday 15 October at 10:00 am.',
  ...over,
});
const labels = (entry: { steps: { label: string; state: string }[] }) => entry.steps.map((s) => `${s.label}: ${s.state}`);

describe('presentErrand — an errand tool’s answer, as a card with its steps', () => {
  it('says a visit was arranged, and shows the door told, the reminder to come and the ring still to come', () => {
    const presented = presentResult('arrange_visit', JSON.stringify({ arranged: true, errand: view() }));

    expect(presented.tone).toBe('answer');
    expect(presented.say).toBe('Arranged. The door will expect the plumber on Thursday 15 October at 10:00 am. Her television will remind her at a calm moment, and you will be told how it went.');
    expect(presented.card).toMatchObject({ kind: 'errand', title: 'A visit you arranged' });
    const [entry] = presented.card.errands;
    expect(entry).toMatchObject({ errandId: 'err_AAAAAAAAAAAAAAAAAAAA', who: 'the plumber', when: 'Thursday 15 October at 10:00 am', cancellable: true });
    expect(labels(entry)).toEqual(['Door told: done', 'Reminded: next', 'Rang or nobody came: next']);
  });

  it('shows the steps as the visit goes: reminded, then somebody rang — never who', () => {
    const rang = presentResult('get_errands', JSON.stringify({ errands: [view({ status: 'rang', reminded: true, rangAt: THURSDAY_TEN + 4 * 60_000, said: 'Someone rang at 10:04 am, around when the plumber was expected.' })] }));

    expect(rang.say).toBe('Someone rang at 10:04 am, around when the plumber was expected.');
    expect(labels(rang.card.errands[0])).toEqual(['Door told: done', 'Reminded: done', 'Someone rang: done']);
    expect(rang.card.errands[0].cancellable).toBe(false);
    expect(rang.card.footnote).toMatch(/not who/);
  });

  it('says nobody came, a visit with no reminder, one called off and one that did not go through', () => {
    const noShow = presentResult('get_errands', JSON.stringify({ errands: [view({ status: 'no_show', remindAt: undefined })] })).card.errands[0];
    expect(labels(noShow)).toEqual(['Door told: done', 'No reminder: skipped', 'Nobody came: done']);
    const cancelled = presentResult('get_errands', JSON.stringify({ errands: [view({ status: 'cancelled' })] })).card.errands[0];
    expect(labels(cancelled)).toEqual(['Door told: done', 'Reminded: skipped', 'Called off: done']);
    const failed = presentResult('get_errands', JSON.stringify({ errands: [view({ status: 'failed' })] })).card.errands[0];
    expect(labels(failed)).toEqual(['Door told: stopped', 'Reminded: skipped', 'Did not go through: stopped']);
  });

  it('lists several, newest first as the server sent them, each with its own Call it off while it is still to come', () => {
    const presented = presentResult('get_errands', JSON.stringify({ errands: [view({ errandId: 'err_B', who: 'the window cleaner' }), view({ status: 'rang', reminded: true })] }));
    expect(presented.say).toBe('You have arranged two visits. The door knows to expect the plumber on Thursday 15 October at 10:00 am.');
    expect(presented.card.errands.map((e: { cancellable: boolean }) => e.cancellable)).toEqual([true, false]);
  });

  it('says only what was chosen: no reminder, or not to be told', () => {
    expect(presentResult('arrange_visit', JSON.stringify({ arranged: true, errand: view({ remindAt: undefined }) })).say).toBe(
      'Arranged. The door will expect the plumber on Thursday 15 October at 10:00 am. You will be told how it went.',
    );
    expect(presentResult('arrange_visit', JSON.stringify({ arranged: true, errand: view({ tellMe: false }) })).say).toBe(
      'Arranged. The door will expect the plumber on Thursday 15 October at 10:00 am. Her television will remind her at a calm moment.',
    );
  });

  it('says a visit was called off', () => {
    const presented = presentResult('cancel_errand', JSON.stringify({ cancelled: true, errand: view({ status: 'cancelled' }) }));
    expect(presented.say).toBe('Called off. The door is no longer expecting the plumber, and nothing more will be sent.');
    expect(presented.card.errands[0].cancellable).toBe(false);
  });

  it('says the server’s sentence as it stands when there is nothing to show, and is not reached for other tools', () => {
    // A sentence comes as plain text (the server's result.ts `say`), and is said as it stands.
    expect(presentResult('get_errands', 'You have no visits arranged, and none in the last week.').say).toBe('You have no visits arranged, and none in the last week.');
    expect(presentErrand('get_light', { lit: true })).toBeUndefined();
    expect(presentErrand('arrange_visit', { arranged: true })).toBeUndefined();
  });
});

describe('withNoteSent — the note sent in the same turn is the first step', () => {
  it('marks the arranged visit’s note as sent when send_note_to_tv ran beside it', () => {
    const arranged = presentResult('arrange_visit', JSON.stringify({ arranged: true, errand: view() }));
    const note = { say: 'Sent.', tone: 'answer', card: { kind: 'confirmation', title: 'Note sent to the television', fields: [] } };

    const turn = presentTurn('Done.', [
      { name: 'arrange_visit', args: {}, presented: arranged },
      { name: 'send_note_to_tv', args: { message: 'The plumber is coming on Thursday at ten.' }, presented: note },
    ]);

    const card = turn.cards.find((c: { kind: string }) => c.kind === 'errand');
    expect(labels(card.errands[0])).toEqual(['Note sent: done', 'Door told: done', 'Reminded: next', 'Rang or nobody came: next']);
    expect(turn.trace).toBe('Arranged the visit · Put a note on the television');
  });

  it('adds no such step when no note went, and leaves other cards alone', () => {
    const arranged = presentResult('arrange_visit', JSON.stringify({ arranged: true, errand: view() }));
    expect(withNoteSent([arranged.card], ['arrange_visit'])[0].errands[0].steps[0].label).toBe('Door told');
    const other = { kind: 'confirmation', title: 'x', fields: [] };
    expect(withNoteSent([other], ['send_note_to_tv'])).toEqual([other]);
  });
});

describe('confirmErrand — the question before anything is arranged or called off', () => {
  it('shows who, when, the reminder and whether you are told, and every other value as it would be sent', () => {
    const asked = confirmWrite('arrange_visit', { who: 'the plumber', date: '2026-10-15', time: '10:00', reminder: 'hour_before', tellMe: false, idempotencyKey: 'k-12345678' });

    expect(asked).toMatchObject({ title: 'Arrange this visit?', confirmLabel: 'Arrange it' });
    expect(asked.fields).toEqual([
      ['Who is coming', 'the plumber'],
      ['When', 'Thursday 15 October, 10:00 am'],
      ['Remind her', 'An hour before'],
      ['Tell you how it went', 'No'],
      ['idempotencyKey', 'k-12345678'],
    ]);
  });

  it('says what the defaults are when none was chosen', () => {
    const asked = confirmErrand('arrange_visit', { who: 'the plumber', date: '2026-10-15', time: '10:00' });
    expect(asked.fields).toEqual([
      ['Who is coming', 'the plumber'],
      ['When', 'Thursday 15 October, 10:00 am'],
      ['Remind her', 'On the morning, at eight'],
      ['Tell you how it went', 'Yes'],
    ]);
  });

  it('asks before calling one off, naming the visit when it has been shown', () => {
    presentResult('get_errands', JSON.stringify({ errands: [view()] }));
    expect(confirmWrite('cancel_errand', { errandId: 'err_AAAAAAAAAAAAAAAAAAAA' })).toMatchObject({
      title: 'Call off this visit?',
      fields: [['Visit', 'the plumber, Thursday 15 October at 10:00 am']],
      confirmLabel: 'Call it off',
    });
    expect(confirmWrite('cancel_errand', { errandId: 'err_NEVERSHOWNNEVERSHOWN' }).fields).toEqual([['Visit', 'err_NEVERSHOWNNEVERSHOWN']]);
  });
});

describe('the chip, the trace and the nudge', () => {
  it('offers "Arrange a visit", which puts an example in the field to be changed rather than sending it', () => {
    expect(ERRAND_SUGGESTION).toEqual({ label: 'Arrange a visit', utterance: 'The plumber is coming on Thursday at ten. Let Mum know.', prefill: true });
    expect(SUGGESTIONS).toContainEqual(ERRAND_SUGGESTION);
  });

  it('without a model, asks for the visits you arranged by rule — and says an arrangement needs the assistant, never guessing one', () => {
    expect(routeUtterance('Which visits have I arranged?')).toEqual({ kind: 'tool', tool: 'get_errands', args: {} });
    expect(routeUtterance('How did the visit I arranged go?')).toEqual({ kind: 'tool', tool: 'get_errands', args: {} });
    expect(routeUtterance(ERRAND_SUGGESTION.utterance)).toEqual({ kind: 'arrange' });
    expect(routeUtterance('Arrange a visit from the window cleaner')).toEqual({ kind: 'arrange' });
    expect(ARRANGE_NEEDS_ASSISTANT).toMatch(/note/);
    // What was routed before is routed as before.
    expect(routeUtterance('Did Maria come today?')).toEqual({ kind: 'tool', tool: 'did_visitor_come', args: { personId: 'maria' } });
  });

  it('describes each call in a few words, never by its name', () => {
    expect(describeCall('arrange_visit')).toBe('Arranged the visit');
    expect(describeCall('get_errands')).toBe('Looked at the visits you arranged');
    expect(describeCall('cancel_errand')).toBe('Called off the visit');
    expect(describeErrandCall('get_light')).toBeUndefined();
    expect(presentTurn(undefined, [{ name: 'arrange_visit', args: {}, presented: null }]).trace).toBe('Did not arrange it');
  });

  it('finds the news a nudge was about: a visit that has rung or passed since it was last seen, once', () => {
    const seen = new Map();
    const raw = JSON.stringify({ errands: [view({ errandId: 'err_B', status: 'planned' }), view({ status: 'rang', reminded: true })] });

    const news = errandNews(raw, seen);
    expect(news).toMatchObject({ errandId: 'err_AAAAAAAAAAAAAAAAAAAA', status: 'rang', view: { who: 'the plumber' } });
    seen.set(news.errandId, news.status);
    expect(errandNews(raw, seen)).toBeNull();
    expect(errandNews(JSON.stringify({ say: 'None.' }), seen)).toBeNull();
    expect(errandNews('not json', seen)).toBeNull();
  });
});
