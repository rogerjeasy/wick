import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain browser module, deliberately untyped (no build step).
import {
  timeFormatter,
  confirmWrite,
  describeCall,
  inviteLink,
  needsConfirmation,
  presentCircle,
  presentDoorbell,
  presentListing,
  presentResult,
  presentTurn,
  presentWelcome,
  routeUtterance,
  serverFor,
  suggestionsFor,
  REPLY_CHOICES,
  SUGGESTIONS,
  DOOR_ANSWERS,
  doorQuestionToAnnounce,
  applicationServerKey,
  presentNotifications,
  madeWithKey,
  toldToAnnounce,
  FILMS,
  WATCH_ANSWERS,
  lightToShow,
  follow,
  watchStatus,
  watchToAnnounce,
} from '../surface.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REPLY_CHOICES as SERVER_REPLY_CHOICES } from '../../../services/mcp-server/src/tools/send_note_to_tv.js';
import { DOOR_ANSWERS as CONTRACT_DOOR_ANSWERS } from '../../../packages/contracts/src/door.js';
import { PROGRAMMES } from '../../../packages/contracts/src/programmes.js';
import { WATCH_ANSWERS as CONTRACT_WATCH_ANSWERS, WATCH_QUESTION } from '../../../packages/contracts/src/watch.js';

const at = (ms: number) => `t${ms}`;

describe('routeUtterance', () => {
  it('routes every suggestion chip to a tool — a chip that leads nowhere is a broken promise', () => {
    for (const s of SUGGESTIONS) expect(routeUtterance(s.utterance).kind).not.toBe('help');
  });

  it('asks for the week', () => {
    expect(routeUtterance("How's Mum been this week?")).toEqual({ kind: 'tool', tool: 'get_week_narrative', args: {} });
  });

  it('asks for exactly last week when that is what was said', () => {
    const wednesdayOfW42 = Date.UTC(2026, 9, 14, 15);
    expect(routeUtterance('How was last week?', wednesdayOfW42)).toEqual({ kind: 'tool', tool: 'get_week_narrative', args: { isoWeek: '2026-W41' } });
    expect(routeUtterance("How's Mum been this week?", wednesdayOfW42)).toEqual({ kind: 'tool', tool: 'get_week_narrative', args: {} });
  });

  it('knows that the week before the first of a year belongs to the year before', () => {
    // Wednesday 6 January 2027 is in 2027-W01; 2026 has 53 ISO weeks.
    expect(routeUtterance('and last week?', Date.UTC(2027, 0, 6)).args).toEqual({ isoWeek: '2026-W53' });
  });

  it('asks about today', () => {
    expect(routeUtterance('what happened today')).toEqual({ kind: 'tool', tool: 'get_today', args: {} });
  });

  it('asks whether the carer came', () => {
    expect(routeUtterance('Did Maria come today?')).toEqual({ kind: 'tool', tool: 'did_visitor_come', args: { personId: 'maria' } });
  });

  it('asks whether there is a reply — before it could be mistaken for a note', () => {
    expect(routeUtterance('Has Mum replied to my note?')).toEqual({ kind: 'tool', tool: 'get_replies', args: {} });
  });

  it('asks what the family is allowed to see', () => {
    expect(routeUtterance('What can I see about Mum?')).toEqual({ kind: 'tool', tool: 'get_resident_shared_view', args: {} });
  });

  it('opens the note form when no message was given', () => {
    expect(routeUtterance("Put a note on Mum's television")).toEqual({ kind: 'compose' });
  });

  it('takes the message from the utterance when one was given', () => {
    expect(routeUtterance('Tell Mum the plumber is coming Thursday at ten')).toEqual({
      kind: 'compose',
      message: 'The plumber is coming Thursday at ten',
    });
    expect(routeUtterance('Send a note saying: call me when you can')).toEqual({ kind: 'compose', message: 'Call me when you can' });
  });

  it('says what it can do when it does not understand, instead of guessing a tool', () => {
    expect(routeUtterance('what is the weather')).toEqual({ kind: 'help' });
    expect(routeUtterance('   ')).toEqual({ kind: 'help' });
  });
});

describe('presentResult — the week', () => {
  const week = JSON.stringify({
    isoWeek: '2026-W40',
    text: 'A steady week. Someone came to the door four times.',
    timeline: [
      { at: 200, kind: 'door', summary: 'Someone came to the door.' },
      { at: 100, kind: 'visit', summary: 'Maria visited.' },
    ],
  });

  // Thursday 1 October 2026: 2026-W40 is this week.
  const duringW40 = { now: Date.UTC(2026, 9, 1, 12) };

  it('speaks the prose and shows the timeline it was built from, oldest first', () => {
    const r = presentResult('get_week_narrative', week, duringW40, at);
    expect(r.say).toBe('A steady week. Someone came to the door four times.');
    expect(r.card.title).toBe('This week');
    expect(r.card.items).toEqual([
      { primary: 'Maria visited.', secondary: 't100' },
      { primary: 'Someone came to the door.', secondary: 't200' },
    ]);
    expect(r.card.footnote).toMatch(/read it first/);
  });

  it('says which week it is reading when this week is not written yet — never last week passed off as this one', () => {
    const r = presentResult('get_week_narrative', JSON.stringify({ ...JSON.parse(week), thisWeek: 'not_written' }), {}, at);

    expect(r.say).toBe(
      'This week’s story isn’t written yet: Wick writes it on Sunday evening. Here is the week of 28 September. ' +
        'A steady week. Someone came to the door four times.',
    );
    expect(r.card.title).toBe('Week of 28 September');
  });

  it('names a week that was asked for by name, and is not this one, by its date', () => {
    const aWeekLater = { now: Date.UTC(2026, 9, 8, 12) };

    const r = presentResult('get_week_narrative', week, aWeekLater, at);

    expect(r.card.title).toBe('Week of 28 September');
    expect(r.card.empty).toBe('Nothing at the door that week.');
    // It was asked for: nothing needs explaining before the story.
    expect(r.say).toBe('A steady week. Someone came to the door four times.');
  });

  it('says so when this week is on the television, waiting to be read there first', () => {
    const r = presentResult('get_week_narrative', JSON.stringify({ ...JSON.parse(week), thisWeek: 'awaiting_resident' }), {}, at);

    expect(r.say).toMatch(/^This week’s story is on the television, where the person it’s about reads it first\. Here is the week of 28 September\. A steady week\./);
  });

  it('says a simulated week is simulated, on the card that shows it', () => {
    const r = presentResult('get_week_narrative', JSON.stringify({ ...JSON.parse(week), simulated: true }), {}, at);

    expect(r.card.footnote).toBe('Simulated: this is a demo home, and nobody lived this week.');
    expect(presentResult('get_week_narrative', week, {}, at).card.footnote).not.toMatch(/Simulated/);
  });

  it('says the server\'s own sentence when the week is withheld, with no card', () => {
    const r = presentResult('get_week_narrative', "This week's story is written, and it's on the television now.", {}, at);
    expect(r).toEqual({ say: "This week's story is written, and it's on the television now.", card: null, tone: 'waiting' });
  });
});

describe('presentResult — refusals', () => {
  it('marks a refusal as kept private, and never dresses it up as an error', () => {
    const text = "That's something the resident is keeping to themselves. I'm not able to share it.";
    expect(presentResult('did_visitor_come', text, {}, at)).toEqual({ say: text, card: null, tone: 'private' });
  });
});

describe('presentResult — today', () => {
  it('says so plainly when nothing has happened', () => {
    const r = presentResult('get_today', JSON.stringify({ events: [], keptPrivate: [] }), {}, at);
    expect(r.say).toBe('Nothing at the door so far today.');
    expect(r.card).toBeNull();
  });

  it('counts the events and reads the most recent', () => {
    const raw = JSON.stringify({
      events: [
        { at: 300, summary: 'Someone came to the door.' },
        { at: 100, summary: 'Maria visited.' },
      ],
      keptPrivate: [],
    });
    const r = presentResult('get_today', raw, {}, at);
    expect(r.say).toBe('Two things so far today. Most recently: someone came to the door.');
    expect(r.card.items[0]).toEqual({ primary: 'Maria visited.', secondary: 't100' });
  });

  it('names what is kept private, in the spoken answer and on the card', () => {
    const kept = 'Who visits, by name. That is something the resident keeps to themselves.';
    const r = presentResult('get_today', JSON.stringify({ events: [{ at: 1, summary: 'Someone came to the door.' }], keptPrivate: [kept] }), {}, at);
    expect(r.say).toContain(kept);
    expect(r.card.footnote).toBe(kept);
  });
});

describe('presentResult — did a visitor come', () => {
  it('answers yes with the time', () => {
    const r = presentResult('did_visitor_come', JSON.stringify({ visited: true, at: 500, name: 'Maria', expectedToday: true }), {}, at);
    expect(r.say).toBe('Yes. Maria came at t500. Today is one of their usual days.');
  });

  it('answers not yet on a usual day', () => {
    const r = presentResult('did_visitor_come', JSON.stringify({ visited: false, name: 'Maria', expectedToday: true }), {}, at);
    expect(r.say).toBe('Not yet. Maria usually comes today.');
  });

  it('answers no on a day they are not expected', () => {
    const r = presentResult('did_visitor_come', JSON.stringify({ visited: false, name: 'Maria', expectedToday: false }), {}, at);
    expect(r.say).toBe("No. Maria hasn't come today, and today isn't one of their usual days.");
  });

  it('says when it does not know the person, rather than answering no', () => {
    const r = presentResult('did_visitor_come', JSON.stringify({ visited: false, expectedToday: false }), {}, at);
    expect(r.say).toBe("I don't have anyone by that name among the regular visitors.");
  });
});

describe('presentResult — notes and replies', () => {
  it('confirms a note with who the server sent it from, and when it will be shown', () => {
    const r = presentResult('send_note_to_tv', JSON.stringify({ sent: true, cardId: 'note-1', fromName: 'Sarah' }), { message: 'Call me.' }, at);
    expect(r.say).toMatch(/never in the middle of a programme/);
    expect(r.card).toMatchObject({ kind: 'confirmation', title: 'Note sent to the television', fields: [['From', 'Sarah'], ['Message', 'Call me.']] });
  });

  it('reads the newest reply aloud and lists every note', () => {
    const raw = JSON.stringify({
      notes: [
        { from: 'Sarah', message: 'Lunch on Sunday?', sentAt: 900, reply: { text: "I'll call you soon.", at: 950 } },
        { from: 'Sarah', message: 'Call me.', sentAt: 100, reply: null },
      ],
    });
    const r = presentResult('get_replies', raw, {}, at);
    expect(r.say).toBe('Yes. To “Lunch on Sunday?” the reply was: “I\'ll call you soon.”');
    expect(r.card.items).toEqual([
      { primary: 'Lunch on Sunday?', secondary: 'Sarah · t900', reply: "I'll call you soon.", replyMeta: 'Replied t950' },
      { primary: 'Call me.', secondary: 'Sarah · t100', reply: null, replyMeta: 'No reply yet' },
    ]);
  });

  it('says not yet when the newest note has no reply', () => {
    const raw = JSON.stringify({ notes: [{ from: 'Sarah', message: 'Call me.', sentAt: 100, reply: null }] });
    expect(presentResult('get_replies', raw, {}, at).say).toBe('Not yet. Your note is on the television, waiting.');
  });
});

describe('presentResult — what the family can see', () => {
  it('lists what is shared in plain words, and what is kept private', () => {
    const raw = JSON.stringify({ sharedWithFamily: ['DOOR_EVENT', 'RHYTHM'], residentExclusions: ['PRESENCE'] });
    const r = presentResult('get_resident_shared_view', raw, {}, at);
    expect(r.say).toBe('You can see two kinds of thing. One is kept private.');
    expect(r.card.items).toEqual([
      { primary: 'When someone comes to the door', secondary: 'Shared with you' },
      { primary: 'The shape of the week', secondary: 'Shared with you' },
      { primary: 'Who visits, by name', secondary: 'Kept private' },
    ]);
  });
});

describe('presentResult — failures', () => {
  it('keeps the server\'s calm sentence for an error and marks it', () => {
    const r = presentResult('get_today', 'Something went wrong on my end — try again in a moment.', {}, at, true);
    expect(r).toEqual({ say: 'Something went wrong on my end — try again in a moment.', card: null, tone: 'error' });
  });
});

describe('routeUtterance — the family circle', () => {
  it('opens the circle for questions about who is in it, inviting, and connecting a television', () => {
    expect(routeUtterance('Who is in the family circle?')).toEqual({ kind: 'circle' });
    expect(routeUtterance('Invite my brother')).toEqual({ kind: 'circle' });
    expect(routeUtterance('Connect a television')).toEqual({ kind: 'circle' });
  });

  it('still sends a note when the television is only where the note is going', () => {
    expect(routeUtterance("Put a note on Mum's television")).toEqual({ kind: 'compose' });
  });
});

describe('presentResult — waiting for the resident (INV-9)', () => {
  it('marks the server’s sentence as waiting, never as an error, whichever tool was asked', () => {
    const text = 'Margaret hasn’t allowed this yet. A card is waiting on the television, and it only takes one press.';
    expect(presentResult('get_today', text, {}, at)).toEqual({ say: text, card: null, tone: 'waiting' });
  });

  it('marks a refusal by the resident as their choice', () => {
    const text = 'Margaret chose not to share this with you.';
    expect(presentResult('get_today', text, {}, at)).toEqual({ say: text, card: null, tone: 'private' });
  });
});

const me = (role: string, status: string) => ({
  user: { userId: 'u_sarah', name: 'Sarah', email: 'sarah@example.com' },
  household: { householdId: 'hh_1', name: 'Margaret’s home', residentName: 'Margaret' },
  membership: { role, status },
});

describe('presentWelcome — the first thing said after linking', () => {
  it('invites a question from someone the resident has allowed', () => {
    expect(presentWelcome(me('organiser', 'allowed'), 1)).toEqual({
      say: 'Wick is linked to Margaret’s home. What would you like to know?',
      tone: 'answer',
      next: null,
    });
  });

  it('says that a demo home’s history is simulated before anything is asked about it', () => {
    const demo = { ...me('organiser', 'allowed'), household: { householdId: 'hh_d', name: 'Demo home', residentName: 'Margaret', simulated: true } };

    expect(presentWelcome(demo, 1).say).toBe(
      'Wick is linked to Demo home. Its history is simulated, so there is a week to ask about. What would you like to know?',
    );
  });

  it('tells a new organiser to connect the television first: nobody can be asked without one', () => {
    expect(presentWelcome(me('organiser', 'pending'), 0)).toEqual({
      say: 'Welcome, Sarah. Connect Margaret’s television next. Margaret will then be asked, on it, whether to allow you.',
      tone: 'waiting',
      next: 'connect',
    });
  });

  it('tells an organiser whose television is connected that the question is on it', () => {
    expect(presentWelcome(me('organiser', 'pending'), 1).say).toBe(
      'The television is connected. Margaret is being asked whether to allow you. It appears at the end of a programme, and takes one press.',
    );
  });

  it('tells an invited person they are waiting, and that nothing is visible until then', () => {
    expect(presentWelcome(me('family', 'pending'), undefined)).toEqual({
      say: 'You have asked to join Margaret’s home. Margaret will be asked on the television whether to allow you. Until then there is nothing I can show you.',
      tone: 'waiting',
      next: null,
    });
  });

  it('says plainly when the resident said no', () => {
    expect(presentWelcome(me('family', 'declined'), undefined).say).toBe('Margaret chose not to share this with you.');
  });
});

describe('presentCircle', () => {
  const circle = {
    household: { householdId: 'hh_1', name: 'Margaret’s home', residentName: 'Margaret' },
    members: [
      { userId: 'u_sarah', name: 'Sarah', role: 'organiser', status: 'allowed', you: true },
      { userId: 'u_tom', name: 'Tom', role: 'family', status: 'pending', you: false },
      { userId: 'u_amy', name: 'Amy', role: 'family', status: 'declined', you: false },
    ],
    televisions: [{ deviceId: 'tv-1', pairedAt: 5, connected: true }],
  };

  it('says who is in the circle and what the resident has said about each', () => {
    const r = presentCircle(circle, me('organiser', 'allowed'));

    expect(r.say).toBe('Three people are in Margaret’s family circle. One is waiting for Margaret to allow them.');
    expect(r.card.title).toBe('Margaret’s family circle');
    expect(r.card.members).toEqual([
      { userId: 'u_sarah', primary: 'Sarah (you)', secondary: 'Organiser · allowed by Margaret', removable: false },
      { userId: 'u_tom', primary: 'Tom', secondary: 'Waiting for Margaret', removable: true },
      { userId: 'u_amy', primary: 'Amy', secondary: 'Margaret said no', removable: true },
    ]);
  });

  it('says whether the television is connected', () => {
    expect(presentCircle(circle, me('organiser', 'allowed')).card.television).toBe('One television connected, and on now.');
    expect(presentCircle({ ...circle, televisions: [{ deviceId: 'tv-1', connected: false }] }, me('organiser', 'allowed')).card.television).toBe(
      'One television connected. It is off, or showing something else.',
    );
    expect(presentCircle({ ...circle, televisions: [] }, me('organiser', 'allowed')).card.television).toBe('No television is connected yet.');
  });

  it('says how many of several televisions are on, and never that all are when some are off', () => {
    const tvs = (...on: boolean[]) => ({ ...circle, televisions: on.map((connected, i) => ({ deviceId: `tv-${i}`, pairedAt: i, connected })) });
    const line = (...on: boolean[]) => presentCircle(tvs(...on), me('organiser', 'allowed')).card.television;

    expect(line(true, false, false)).toBe('Three televisions connected. One is on now.');
    expect(line(true, true, false, false)).toBe('Four televisions connected. Two are on now.');
    expect(line(true, true)).toBe('Two televisions connected, both on now.');
    expect(line(true, true, true)).toBe('Three televisions connected, all on now.');
    expect(line(false, false)).toBe('Two televisions connected. They are off, or showing something else.');
  });

  it('offers inviting, connecting and removing to the organiser only', () => {
    expect(presentCircle(circle, me('organiser', 'allowed')).card.organiser).toBe(true);
    const family = presentCircle(circle, me('family', 'allowed'));
    expect(family.card.organiser).toBe(false);
    expect(family.card.members.every((m: { removable: boolean }) => !m.removable)).toBe(true);
  });
});

describe('inviteLink', () => {
  it('opens this same app with the invitation in the address', () => {
    expect(inviteLink('https://family.example/?pair=123456', 'abc_DEF-123')).toBe('https://family.example/?invite=abc_DEF-123');
  });
});

// ---------------------------------------------------------------------------
// The model-driven conversation: a turn can take several tools.
// ---------------------------------------------------------------------------

describe('a note, and what it can be answered with', () => {
  it('shows the replies with the note before it is sent', () => {
    const asked = confirmWrite('send_note_to_tv', { message: 'Shall I come on Saturday?', replies: ['yes_please', 'another_day'] });

    expect(asked.fields).toEqual([
      ['Message', 'Shall I come on Saturday?'],
      ['Replies offered', 'Yes, please do. · Another day would be better. · Not right now.'],
    ]);
  });

  it('shows the note alone when no replies were chosen', () => {
    expect(confirmWrite('send_note_to_tv', { message: 'Thinking of you.' }).fields).toEqual([['Message', 'Thinking of you.']]);
  });

  it('never presents a sentence somebody wrote as a reply on offer: the server would not send it', () => {
    const asked = confirmWrite('send_note_to_tv', { message: 'Hello', replies: ['Yes, sell the house.', 'yes_please'] });

    expect(asked.fields.some(([label]: [string]) => label === 'Replies offered')).toBe(false);
  });

  it('knows the same replies the server does, word for word', () => {
    expect(REPLY_CHOICES).toEqual(SERVER_REPLY_CHOICES);
  });

  it('says afterwards what the server really offered', () => {
    const sent = JSON.stringify({ sent: true, cardId: 'note-1', fromName: 'Sarah', message: 'Shall I come on Saturday?', replies: ['Yes, please do.', 'Another day would be better.', 'Not right now.'] });

    const r = presentResult('send_note_to_tv', sent, { message: 'Shall I come on Saturday?' }, at);

    expect(r.card.fields).toContainEqual(['Can be answered with', 'Yes, please do. · Another day would be better. · Not right now.']);
  });
});

describe('adding a regular visitor', () => {
  it('asks first, in words: who, which days, around when', () => {
    const asked = confirmWrite('add_regular_visitor', { name: 'Maria', days: ['tuesday', 'friday'], time: '09:00' });

    expect(asked.title).toBe('Add a regular visitor?');
    expect(asked.fields).toEqual([['Who', 'Maria'], ['Days', 'Tuesday, Friday'], ['Around', '09:00']]);
    expect(asked.confirmLabel).toBe('Add');
  });

  it('shows anything else the assistant tried to pass, so nothing rides along unseen', () => {
    const asked = confirmWrite('add_regular_visitor', { name: 'Maria', days: ['tuesday'], time: '09:00', note: 'has a key' });

    expect(asked.fields.some(([, value]: [string, string]) => String(value).includes('has a key'))).toBe(true);
  });

  it('says it is done, and when the door will expect them', () => {
    const added = JSON.stringify({ added: true, changed: false, personId: 'maria', name: 'Maria', usualDays: 'Tuesday and Friday mornings' });

    const r = presentResult('add_regular_visitor', added, {}, at);

    expect(r.say).toBe('Added. The door will expect Maria on Tuesday and Friday mornings.');
    expect(r.card.fields).toEqual([['Who', 'Maria'], ['Usually', 'Tuesday and Friday mornings']]);
  });

  it('says changed, not added, for someone already on the roster', () => {
    const changed = JSON.stringify({ added: true, changed: true, personId: 'maria', name: 'Maria', usualDays: 'Monday mornings' });

    expect(presentResult('add_regular_visitor', changed, {}, at).say).toBe('Changed. Maria is now expected on Monday mornings.');
  });
});

describe("Something's Different", () => {
  it('is asked for in the words people use, before "today" or "Maria" can take the question', () => {
    const asked = { kind: 'tool', tool: 'get_whats_different', args: {} };

    expect(routeUtterance('Is anything different?')).toEqual(asked);
    expect(routeUtterance('Is anything different today?')).toEqual(asked);
    expect(routeUtterance('Is everything all right with Mum?')).toEqual(asked);
    expect(routeUtterance('Anything unusual about Maria this week?')).toEqual(asked);
  });

  const told = { id: 'missed_visit-maria-2026-10-09', kind: 'missed_visit', sentence: 'Maria usually comes on Friday mornings. There was no visit on Friday.', at: 700, toldAt: 900 };

  it("says the server's own summary, and lays out what the resident asked to be told, with when it was", () => {
    const answer = JSON.stringify({ differences: [told], weeksObserved: 6, keptPrivate: [], summary: `Margaret asked Wick to tell you: ${told.sentence}` });

    const r = presentResult('get_whats_different', answer, {}, at);

    expect(r.say).toBe('Margaret asked Wick to tell you: Maria usually comes on Friday mornings. There was no visit on Friday.');
    expect(r.card.title).toBe('One thing to tell you');
    expect(r.card.items).toEqual([{ primary: told.sentence, secondary: 't700 · told t900' }]);
    expect(r.card.footnote).toBe('Against the last 6 weeks in this house, and nothing else.');
  });

  it('counts them when there are several', () => {
    const answer = JSON.stringify({ differences: [told, { ...told, id: 'door_at_night-2026-10-09' }], weeksObserved: 6, keptPrivate: [], summary: 's' });

    expect(presentResult('get_whats_different', answer, {}, at).card.title).toBe('Two things to tell you');
  });

  it('shows no card when nothing has been told, and never says that nothing is different', () => {
    const summary = "Margaret hasn't asked Wick to tell you anything.";
    const answer = JSON.stringify({ differences: [], keptPrivate: [], summary });

    const r = presentResult('get_whats_different', answer, {}, at);

    expect(r).toMatchObject({ say: summary, card: null });
  });

  it('has words of its own, just as careful, if the server sends no summary', () => {
    const r = presentResult('get_whats_different', JSON.stringify({ differences: [], keptPrivate: [] }), {}, at);

    expect(r.say).toBe('Nothing has been passed on to you.');
    expect(r.say).not.toMatch(/nothing is different/i);
  });
});

describe('toldToAnnounce — what the app says unasked when it is opened', () => {
  const answer = (ids: string[]) => JSON.stringify({ differences: ids.map((id) => ({ id, kind: 'missed_visit', sentence: 's', at: 1, toldAt: 2 })), keptPrivate: [], summary: 's' });

  it('is what the resident asked to be told that this browser has not shown yet', () => {
    expect(toldToAnnounce(answer(['a', 'b']), ['a'])).toEqual(['b']);
    expect(toldToAnnounce(answer(['a', 'b']), [])).toEqual(['a', 'b']);
  });

  it('is nothing when everything has been shown, nothing has been told, or the answer is a refusal', () => {
    expect(toldToAnnounce(answer(['a']), ['a'])).toEqual([]);
    expect(toldToAnnounce(answer([]), [])).toEqual([]);
    expect(toldToAnnounce("That's something the resident is keeping to themselves. I'm not able to share it.", [])).toEqual([]);
  });
});

describe('describeCall — what a step did, in a few words', () => {
  it('names each tool by what it does for the customer, never by its name', () => {
    expect(describeCall('get_week_narrative', {})).toBe('Read the week');
    expect(describeCall('get_today', { day: 'yesterday' })).toBe('Looked at yesterday');
    expect(describeCall('get_today', {})).toBe('Looked at today');
    expect(describeCall('list_regular_visitors', {})).toBe('Checked who visits');
    expect(describeCall('get_whats_different', {})).toBe('Looked for anything to tell you');
    expect(describeCall('did_visitor_come', { personId: 'maria', day: 'tuesday' })).toBe('Checked Tuesday’s visits');
    expect(describeCall('send_note_to_tv', { message: 'Hi' })).toBe('Put a note on the television');
    expect(describeCall('expect_visit', { date: '2026-10-17', time: '15:00' })).toBe('Told the door');
    expect(describeCall('add_regular_visitor', { name: 'Maria' })).toBe('Added a regular visitor');
    expect(describeCall('did_visitor_come', { personId: 'maria', date: '2026-10-09' })).toBe('Checked 9 October’s visits');
    expect(describeCall('get_today', { date: '2026-10-09' })).toBe('Looked at 9 October');
    expect(describeCall('something_new', {})).toBe('Asked Wick');
  });
});

describe('timeFormatter — a time is the time it was at the house', () => {
  it('shows a moment in the household’s zone, whatever zone the person reading is in', () => {
    // 09:08 UTC on Friday 9 October 2026 is 10:08 in London's summer.
    expect(timeFormatter('Europe/London')(Date.UTC(2026, 9, 9, 9, 8))).toBe('Fri 9 Oct, 10:08');
    expect(timeFormatter('America/New_York')(Date.UTC(2026, 9, 9, 9, 8))).toBe('Fri 9 Oct, 05:08');
  });
});

describe('confirmWrite — nothing is put on a television or a roster without being shown first', () => {
  it('asks before a note is sent, showing the words that would be sent', () => {
    expect(needsConfirmation('send_note_to_tv')).toBe(true);
    expect(confirmWrite('send_note_to_tv', { message: 'I’m coming on Saturday at three.' })).toEqual({
      title: 'Send this note to the television?',
      fields: [['Message', 'I’m coming on Saturday at three.']],
      confirmLabel: 'Send',
      footnote: 'It appears at the next natural break, never in the middle of a programme.',
    });
  });

  it('asks before a visit is announced, with the day worked out in full so a wrong one is seen', () => {
    expect(needsConfirmation('expect_visit')).toBe(true);
    expect(confirmWrite('expect_visit', { date: '2026-10-17', time: '15:00' })).toMatchObject({
      title: 'Tell the door you are coming?',
      fields: [['When', 'Saturday 17 October, 15:00']],
      confirmLabel: 'Tell the door',
    });
  });

  it('asks nothing before a tool the server marks read-only', () => {
    for (const tool of ['get_week_narrative', 'get_today', 'did_visitor_come', 'get_replies', 'get_resident_shared_view', 'list_regular_visitors']) {
      expect(needsConfirmation(tool, { readOnlyHint: true })).toBe(false);
    }
  });

  it('fails closed: a tool is asked about unless the server itself says it only reads', () => {
    // A tool this page has never heard of, a tool with no annotations, and one the server could not be asked about.
    expect(needsConfirmation('a_tool_added_next_month', { readOnlyHint: false })).toBe(true);
    expect(needsConfirmation('a_tool_added_next_month', {})).toBe(true);
    expect(needsConfirmation('get_today', undefined)).toBe(true);
    // The page's own knowledge never overrides the server's: a "read" that is marked a write is asked about.
    expect(needsConfirmation('get_today', { readOnlyHint: false })).toBe(true);
  });

  it('shows a write it does not know as exactly what it is: its own name, and every value that would be sent', () => {
    expect(confirmWrite('forget_everything', { scope: 'all', days: 30 }, 'Forget the history')).toEqual({
      title: 'Forget the history?',
      fields: [['scope', 'all'], ['days', '30']],
      confirmLabel: 'Go ahead',
      footnote: 'This changes something. Nothing is done until you say so.',
    });
    // Never dressed up as a note.
    expect(confirmWrite('forget_everything', {}).title).toBe('forget_everything?');
  });

  it('shows every value a known write would send, not only the one it expects', () => {
    expect(confirmWrite('send_note_to_tv', { message: 'Hello', urgent: true }).fields).toEqual([['Message', 'Hello'], ['urgent', 'true']]);
    expect(confirmWrite('expect_visit', { date: '2026-10-17', time: '15:00', name: 'Maria' }).fields).toEqual([
      ['When', 'Saturday 17 October, 15:00'],
      ['name', 'Maria'],
    ]);
  });
});

describe('presentResult — the visitors', () => {
  const visitors = JSON.stringify({
    visitors: [{ personId: 'maria', name: 'Maria', usualDays: 'Tuesday and Friday mornings', expectedToday: false, lastVisitAt: 500 }],
    expected: [{ name: 'Sarah', at: 900 }],
  });

  it('lists who comes, when they last did, and who has said they are coming', () => {
    const r = presentResult('list_regular_visitors', visitors, {}, at);

    expect(r.say).toBe('Maria usually comes on Tuesday and Friday mornings.');
    expect(r.card.title).toBe('Who visits');
    expect(r.card.items).toEqual([
      { primary: 'Maria', secondary: 'Tuesday and Friday mornings · last came t500' },
      { primary: 'Sarah', secondary: 'Expected t900' },
    ]);
  });

  it('says so when nobody visits regularly', () => {
    expect(presentResult('list_regular_visitors', JSON.stringify({ visitors: [], expected: [] }), {}, at)).toMatchObject({
      say: 'Nobody is down as a regular visitor yet.',
      card: null,
    });
  });
});

describe('presentResult — a visit announced', () => {
  it('confirms what the door now expects, and who else is due', () => {
    const r = presentResult('expect_visit', JSON.stringify({ expected: true, name: 'Sarah', at: 900, windowMinutes: 60, alsoExpectedThatDay: ['Maria'] }), {}, at);

    expect(r.say).toBe('The door will expect you around t900.');
    expect(r.card).toMatchObject({ kind: 'confirmation', title: 'The door expects you', fields: [['Who', 'Sarah'], ['When', 't900'], ['Also due that day', 'Maria']] });
  });
});

describe('presentResult — a day that is not today', () => {
  const now = Date.UTC(2026, 9, 13, 12);

  it('says which day it is answering for', () => {
    const day = JSON.stringify({ date: '2026-10-10', dayInWords: 'Saturday 10 October 2026', events: [{ at: 100, summary: 'Someone was at the front door.' }], keptPrivate: [] });

    const r = presentResult('get_today', day, { now }, at);

    expect(r.say).toBe('One thing on Saturday 10 October: someone was at the front door.');
    expect(r.card.title).toBe('Saturday 10 October');
  });

  it('keeps "so far today" for today', () => {
    const today = JSON.stringify({ date: '2026-10-13', dayInWords: 'Tuesday 13 October 2026', events: [], keptPrivate: [] });

    expect(presentResult('get_today', today, { now }, at).say).toBe('Nothing at the door so far today.');
  });

  it('answers a visit on a named day in the past tense, naming the day', () => {
    const came = JSON.stringify({ visited: true, at: 100, name: 'Maria', expectedToday: true, date: '2026-10-09', dayInWords: 'Friday 9 October 2026' });
    const not = JSON.stringify({ visited: false, name: 'Maria', expectedToday: false, date: '2026-10-12', dayInWords: 'Monday 12 October 2026' });

    expect(presentResult('did_visitor_come', came, { now }, at).say).toBe('Yes. Maria came on Friday 9 October, at t100.');
    expect(presentResult('did_visitor_come', not, { now }, at).say).toBe('No. Maria did not come on Monday 12 October, and it is not one of their usual days.');
  });
});

describe('presentResult — the week, measured', () => {
  it('shows this week beside last week and a usual one, for the door and each visitor', () => {
    const week = JSON.stringify({
      isoWeek: '2026-W41', text: 'Nothing unusual this week.', timeline: [],
      deltas: [
        { metric: 'door', label: 'the front door', thisWeek: 6, lastWeek: 7, baseline: 6.2, zScore: -0.2, baselineWeeks: 5, verdict: 'usual' },
        { metric: 'visit:maria', label: 'Maria', thisWeek: 2, lastWeek: 2, baseline: 2, zScore: 0, baselineWeeks: 5, verdict: 'usual' },
        { metric: 'visit:tom', label: 'Tom', thisWeek: 1, baseline: 0, zScore: 0, baselineWeeks: 0 },
      ],
    });

    expect(presentResult('get_week_narrative', week, { now: Date.UTC(2026, 9, 8) }, at).card.facts).toEqual([
      { label: 'The front door', value: '6 this week · 7 the week before · usually about 6' },
      { label: 'Maria', value: '2 this week · 2 the week before · usually about 2' },
      { label: 'Tom', value: '1 this week' },
    ]);
  });
});

describe('presentTurn — several tools, one answer', () => {
  const step = (name: string, raw: string, args = {}) => ({ name, args, presented: presentResult(name, raw, {}, at) });
  const visitors = JSON.stringify({ visitors: [{ personId: 'maria', name: 'Maria', expectedToday: false }], expected: [] });
  const note = JSON.stringify({ sent: true, cardId: 'note-1', fromName: 'Sarah', message: 'See you Saturday.' });

  it('says the model’s sentence, shows each tool’s card, and says what was done to get there', () => {
    const turn = presentTurn('I have told the door and sent the note.', [step('list_regular_visitors', visitors), step('send_note_to_tv', note, { message: 'See you Saturday.' })]);

    expect(turn.say).toBe('I have told the door and sent the note.');
    expect(turn.tone).toBe('answer');
    expect(turn.trace).toBe('Checked who visits · Put a note on the television');
    expect(turn.cards.map((c: { title: string }) => c.title)).toEqual(['Who visits', 'Note sent to the television']);
  });

  it('says what the tools themselves said when the model’s words were not fit to use', () => {
    const turn = presentTurn(undefined, [step('list_regular_visitors', visitors), step('send_note_to_tv', note)]);

    expect(turn.say).toBe('Maria is a regular visitor. Sent. It will appear on the television at the next natural break, never in the middle of a programme.');
  });

  it('keeps a refusal a refusal: the tone is the tool’s when nothing was answered', () => {
    const turn = presentTurn('Margaret keeps that to herself.', [step('get_today', 'That is something Margaret is keeping to themselves.')]);

    expect(turn.tone).toBe('private');
    expect(turn.cards).toEqual([]);
  });

  it('is just the sentence when no tool was needed', () => {
    expect(presentTurn('I can only help with the house.', [])).toEqual({ say: 'I can only help with the house.', tone: 'answer', cards: [], trace: '' });
  });

  it('marks a step the customer declined, and shows nothing for it', () => {
    const declined = { name: 'send_note_to_tv', args: { message: 'x' }, presented: null };

    expect(presentTurn('All right, I have not sent it.', [declined])).toMatchObject({ trace: 'Did not send the note', cards: [] });
  });
});

describe('presentDoorbell — the home\'s own Ring link, for its organiser', () => {
  const me = { household: { residentName: 'Margaret' } };

  it('says no doorbell is connected, and offers both ways where a Playground token is taken', () => {
    const out = presentDoorbell({ linked: false, playgroundAllowed: true }, me, at);

    expect(out.say).toBe('No doorbell is connected to Margaret’s home yet.');
    expect(out.card.actions).toEqual({ connectRing: true, playground: true, disconnect: false });
    expect(out.card.footnote).toContain('simulator');
  });

  it('offers only a Ring account where a Playground token is not taken', () => {
    const out = presentDoorbell({ linked: false, playgroundAllowed: false }, me, at);

    expect(out.card.actions).toEqual({ connectRing: true, playground: false, disconnect: false });
    expect(out.card.footnote).not.toContain('simulator');
  });

  it('never passes the simulator off as a real doorbell: it says so in the sentence, the rows and the footnote', () => {
    const out = presentDoorbell(
      { linked: true, source: 'playground', simulated: true, expired: false, expiresAt: 5000, cameras: ['Front Door'], heldElsewhere: 0, playgroundAllowed: true },
      me,
      at,
    );

    expect(out.say).toBe('Margaret’s home is connected to Ring’s simulator, not to a real doorbell.');
    expect(out.card.rows).toEqual([{ primary: 'Front Door', secondary: 'Simulated camera' }]);
    expect(out.card.footnote).toContain('simulated doorbell');
    expect(out.card.footnote).toContain('works until t5000');
    expect(out.card.actions).toEqual({ connectRing: true, playground: true, disconnect: true });
  });

  it('says when a pasted token has stopped working, as something still to be done', () => {
    const out = presentDoorbell(
      { linked: true, source: 'playground', simulated: true, expired: true, expiresAt: 5000, cameras: ['Front Door'], heldElsewhere: 0, playgroundAllowed: true },
      me,
      at,
    );

    expect(out.tone).toBe('waiting');
    expect(out.say).toContain('that link has ended');
    expect(out.card.footnote).toContain('stopped working t5000');
  });

  it('says a Ring account keeps itself going, and offers only to disconnect it', () => {
    const out = presentDoorbell(
      { linked: true, source: 'ring', simulated: false, refreshable: true, expired: false, cameras: ['Front Door', 'Back Door'], heldElsewhere: 0, playgroundAllowed: true },
      me,
      at,
    );

    expect(out.say).toBe('Margaret’s doorbell is connected through Ring.');
    expect(out.card.rows.map((r: { secondary: string }) => r.secondary)).toEqual(['Ring', 'Ring']);
    expect(out.card.actions).toEqual({ connectRing: false, playground: false, disconnect: true });
  });

  it('says when a device was left with another home, and when Ring listed none', () => {
    const one = presentDoorbell({ linked: true, source: 'ring', simulated: false, cameras: [], heldElsewhere: 1 }, me, at);
    const two = presentDoorbell({ linked: true, source: 'ring', simulated: false, cameras: ['Front Door'], heldElsewhere: 2 }, me, at);

    expect(one.card.footnote).toContain('Ring listed no camera for it.');
    expect(one.card.footnote).toContain('One of its devices belongs to another home and was left alone.');
    expect(two.card.footnote).toContain('Two of its devices belong to another home and were left alone.');
  });
});

describe('asking about the doorbell', () => {
  it('opens the doorbell card, not a tool', () => {
    expect(routeUtterance('Connect the doorbell')).toEqual({ kind: 'doorbell' });
    expect(routeUtterance('disconnect Ring')).toEqual({ kind: 'doorbell' });
    expect(routeUtterance('Is the doorbell connected?')).toEqual({ kind: 'doorbell' });
  });

  it('still asks the day\'s tool who came to the door', () => {
    expect(routeUtterance('Did anyone ring the doorbell today?').tool).toBe('get_today');
    expect(routeUtterance('Connect a television').kind).toBe('circle');
  });
});

describe('the add-on listing', () => {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../../addon-package/addon.json', import.meta.url)), 'utf8'));
  /** A manifest of its own, so a test can break one thing. */
  const copy = () => structuredClone(manifest);

  it('shows what the package says: the name, the short description, the phrases and the legal links', () => {
    const listing = presentListing(manifest);

    expect(listing).toMatchObject({
      name: 'Wick',
      summary: 'Ask how someone living alone has been this week, in plain language.',
      phrases: ['how has my mum been this week', 'did the carer come today', "is everything alright at mum's"],
      privacyUrl: 'https://rogerjeasy.github.io/wick/privacy.html',
      termsUrl: 'https://rogerjeasy.github.io/wick/terms.html',
      serverUrl: 'https://tqcu7pa3ip.us-east-1.awsapprunner.com',
    });
  });

  it('shows the largest dark-theme icon — the page is dark — and the light one when there is no dark set', () => {
    const lightOnly = copy();
    lightOnly.storeListing.locales['en-US'].mediaAssets.icons.dark = [];

    expect(presentListing(manifest).iconUrl).toBe('https://rogerjeasy.github.io/wick/icons/dark-241.png');
    expect(presentListing(lightOnly).iconUrl).toBe('https://rogerjeasy.github.io/wick/icons/light-241.png');
  });

  it('breaks the full description into paragraphs and one list', () => {
    const { about } = presentListing(manifest);

    expect(about[0]).toEqual({ text: expect.stringContaining('how has my mum been this week') });
    expect(about.find((part: { items?: string[] }) => part.items)).toEqual({
      lead: 'What you can do:',
      items: [
        'Hear how the week went, and what was different from usual',
        'Check whether a regular visitor, such as a carer, came today',
        'Put a short note on their television and hear their one-button reply',
        'Tell them you are coming to visit',
      ],
    });
    expect(about.at(-1).text).toContain('you link a Wick account');
  });

  it('shows nothing for a package it cannot stand behind: no name, or no HTTPS server', () => {
    const nameless = copy();
    nameless.storeListing.locales['en-US'].name.value = '';
    const placeholder = copy();
    placeholder.integrations[0].config.endpoints.default.uri = 'SET-FROM-WICKMCP-STACK-OUTPUT';
    const plain = copy();
    plain.integrations[0].config.endpoints.default.uri = 'http://mcp.wick.test/mcp';

    expect(presentListing(nameless)).toBeNull();
    expect(presentListing(placeholder)).toBeNull();
    expect(presentListing(plain)).toBeNull();
    expect(presentListing(undefined)).toBeNull();
    expect(presentListing({})).toBeNull();
  });

  it('answers every phrase the listing promises — the store guidance says each must work when said', () => {
    const routed = presentListing(manifest).phrases.map((phrase: string) => routeUtterance(phrase));

    expect(routed).toEqual([
      { kind: 'tool', tool: 'get_week_narrative', args: {} },
      { kind: 'tool', tool: 'did_visitor_come', args: { personId: 'maria' } },
      { kind: 'tool', tool: 'get_whats_different', args: {} },
    ]);
  });

  it('understands "alright" as well as "all right"', () => {
    expect(routeUtterance('Is everything alright?').tool).toBe('get_whats_different');
    expect(routeUtterance('Is everything all right with Mum?').tool).toBe('get_whats_different');
  });
});

describe('serverFor', () => {
  const listing = { serverUrl: 'https://mcp.wick.test' };

  it('is the server the package names, on the deployed page', () => {
    expect(serverFor(listing, 'd111111abcdef8.cloudfront.net')).toBe('https://mcp.wick.test');
  });

  it('leaves a developer\'s own server alone, on a laptop', () => {
    expect(serverFor(listing, '127.0.0.1')).toBeNull();
    expect(serverFor(listing, 'localhost')).toBeNull();
  });

  it('is nothing when there is no listing to read it from', () => {
    expect(serverFor(null, 'd111111abcdef8.cloudfront.net')).toBeNull();
  });
});

describe('suggestionsFor', () => {
  const listing = { phrases: ['how has my mum been this week', 'did the carer come today', "is everything alright at mum's"] };

  it('offers the listing\'s phrases first, written as questions', () => {
    expect(suggestionsFor(listing).slice(0, 3)).toEqual([
      { label: 'How has my mum been this week?', utterance: 'how has my mum been this week' },
      { label: 'Did the carer come today?', utterance: 'did the carer come today' },
      { label: 'Is everything alright at mum\u2019s?', utterance: "is everything alright at mum's" },
    ]);
  });

  it('then the app\'s own chips, without the ones that ask the same thing', () => {
    const labels = suggestionsFor(listing).slice(3).map((s: { label: string }) => s.label);

    expect(labels).toEqual(['What happened today?', 'Is the light on?', 'Send a note to her television', 'Has Mum replied?', 'Did Mum ask me to look?', 'Watch a film with Mum', 'What can I see?', 'Family circle']);
  });

  it('is the app\'s own chips when there is no listing', () => {
    expect(suggestionsFor(null)).toEqual(SUGGESTIONS);
  });
});

describe('a question from the front door', () => {
  const PICTURE = 'https://download.example/ring/frame.jpg?sig=abc';
  const ANSWERS = [
    { key: 'known', text: "It's all right, I know who that is." },
    { key: 'dont_open', text: "Please don't open the door. I'll ring you now." },
    { key: 'not_sure', text: "I can't tell who that is. I'll ring you now." },
  ];
  const waiting = (over: object = {}) => JSON.stringify({
    requestId: 'door-abc',
    state: 'waiting',
    askedAt: 1000,
    line: "Someone's at the front door.",
    description: 'A man in a yellow jacket holding a clipboard.',
    pictureUrl: PICTURE,
    answers: ANSWERS,
    ...over,
  });

  it('is asked for by name, and has a chip', () => {
    expect(routeUtterance('Has Mum asked me to look at the door?')).toEqual({ kind: 'tool', tool: 'get_door_request', args: {} });
    expect(routeUtterance("Who's at Mum's door?")).toEqual({ kind: 'tool', tool: 'get_door_request', args: {} });
    expect(SUGGESTIONS.some((s: { utterance: string }) => routeUtterance(s.utterance).tool === 'get_door_request')).toBe(true);
  });

  it('leaves "did anyone come to the door today" to the day\'s list', () => {
    expect(routeUtterance('Did anyone come to the door today?').tool).toBe('get_today');
  });

  it('shows the picture, the sentence and the answers that can be given while it waits', () => {
    const r = presentResult('get_door_request', waiting(), {}, at);

    expect(r.say).toBe('You have been asked to look at the door. A man in a yellow jacket holding a clipboard.');
    expect(r.card).toEqual({
      kind: 'door',
      title: "Someone's at the front door.",
      meta: 'Asked t1000',
      requestId: 'door-abc',
      pictureUrl: PICTURE,
      description: 'A man in a yellow jacket holding a clipboard.',
      answers: ANSWERS,
      footnote: 'Your answer goes on the television at once, under your name.',
    });
  });

  it('says so when the picture has not arrived yet, and draws none', () => {
    const r = presentResult('get_door_request', waiting({ pictureUrl: undefined, description: undefined }), {}, at);

    expect(r.say).toBe('You have been asked to look at the door. The picture has not arrived yet.');
    expect(r.card.pictureUrl).toBeNull();
    expect(r.card.description).toBeNull();
  });

  it('draws only a picture served over https — never a script or a page', () => {
    const r = presentResult('get_door_request', waiting({ pictureUrl: 'javascript:alert(1)' }), {}, at);

    expect(r.card.pictureUrl).toBeNull();
  });

  it('offers only answers it knows, in the server\'s words', () => {
    const r = presentResult('get_door_request', waiting({ answers: [...ANSWERS, { key: 'open_up', text: 'Open the door.' }] }), {}, at);

    expect(r.card.answers).toEqual(ANSWERS);
  });

  it('says who answered once someone has, and shows no card', () => {
    const answered = JSON.stringify({ requestId: 'door-abc', state: 'answered', askedAt: 1000, answer: { by: 'Tom', text: ANSWERS[0]!.text, at: 2000 } });

    expect(presentResult('get_door_request', answered, {}, at)).toMatchObject({ say: `Tom answered t2000: “${ANSWERS[0]!.text}”`, card: null, tone: 'answer' });
  });

  it('says the card has gone when nobody answered in time', () => {
    const gone = JSON.stringify({ requestId: 'door-abc', state: 'gone', askedAt: 1000 });

    expect(presentResult('get_door_request', gone, {}, at)).toMatchObject({
      say: 'You were asked to look at the door t1000. The door card has since gone from the television.',
      card: null,
    });
  });

  it('says what is now on the television after an answer', () => {
    const shown = JSON.stringify({ shown: true, by: 'Sarah', text: ANSWERS[1]!.text });

    expect(presentResult('answer_door_request', shown, {}, at)).toMatchObject({
      say: `It is on the television now: “Sarah says: ${ANSWERS[1]!.text}”`,
      card: null,
      tone: 'answer',
    });
  });

  it('knows the same answers the server does, word for word', () => {
    expect(DOOR_ANSWERS).toEqual(CONTRACT_DOOR_ANSWERS);
  });

  it('shows the sentence itself before the assistant may send it', () => {
    const asked = confirmWrite('answer_door_request', { requestId: 'door-abc', answer: 'dont_open' }, 'Answer a question from the front door');

    expect(asked.title).toBe('Show this on the television?');
    // Every argument is on the card, as for any write: nothing is sent that was not shown.
    expect(asked.fields).toEqual([['Your answer', ANSWERS[1]!.text], ['requestId', 'door-abc']]);
    expect(asked.confirmLabel).toBe('Show it');
  });

  it('shows an answer it does not know as it was passed, never as one it does', () => {
    const asked = confirmWrite('answer_door_request', { requestId: 'door-abc', answer: 'open_up' }, 'Answer');

    expect(asked.fields).toEqual([['Your answer', 'open_up'], ['requestId', 'door-abc']]);
  });

  it('describes both steps in words, not tool names', () => {
    expect(describeCall('get_door_request', {})).toBe('Looked at the question from the door');
    expect(describeCall('answer_door_request', {})).toBe('Answered on the television');
  });
});

describe('doorQuestionToAnnounce — what the app says unasked while it is open', () => {
  const waiting = JSON.stringify({ requestId: 'door-abc', state: 'waiting', askedAt: 1000, line: "Someone's at the front door.", answers: [] });

  it('announces a waiting question once', () => {
    const seen = new Set<string>();

    expect(doorQuestionToAnnounce(waiting, seen)).toBe('door-abc');
    seen.add('door-abc');
    expect(doorQuestionToAnnounce(waiting, seen)).toBeNull();
  });

  it('announces nothing that is not a waiting question', () => {
    const none = new Set<string>();

    expect(doorQuestionToAnnounce("Margaret hasn't asked anyone to look at the door.", none)).toBeNull();
    expect(doorQuestionToAnnounce(JSON.stringify({ requestId: 'door-abc', state: 'answered', askedAt: 1, answer: {} }), none)).toBeNull();
    expect(doorQuestionToAnnounce(JSON.stringify({ requestId: 'door-abc', state: 'gone', askedAt: 1 }), none)).toBeNull();
    expect(doorQuestionToAnnounce('{"state":"waiting"}', none)).toBeNull();
  });
});

describe('watching a film together', () => {
  const STREAM = { url: 'https://films.example/sintel/index.m3u8', durationMs: 888_000, attribution: '© Blender Foundation | durian.blender.org' };
  const ANSWERS = Object.entries(CONTRACT_WATCH_ANSWERS).map(([key, text]) => ({ key, text }));
  const view = (over: object = {}) => JSON.stringify({
    sessionId: 's-1',
    film: 'Sintel',
    startsAt: 5000,
    when: 'Sunday 18 October at 3 pm',
    state: 'invited',
    ...over,
  });

  it('keeps the films and the answers as the server has them', () => {
    expect(FILMS).toEqual(Object.fromEntries(PROGRAMMES.map((p) => [p.id, p.title])));
    expect(WATCH_ANSWERS).toEqual(CONTRACT_WATCH_ANSWERS);
  });

  describe('what was said', () => {
    it('sends a question about the film to the tool, and has a chip that starts an invitation', () => {
      expect(routeUtterance('Did Mum say yes to the film?')).toEqual({ kind: 'tool', tool: 'get_watch_together', args: {} });
      expect(routeUtterance('Is it time for the film?')).toEqual({ kind: 'tool', tool: 'get_watch_together', args: {} });
      expect(routeUtterance('Are we watching together on Sunday?')).toEqual({ kind: 'tool', tool: 'get_watch_together', args: {} });
      expect(SUGGESTIONS.some((s: { utterance: string }) => routeUtterance(s.utterance).kind === 'invite')).toBe(true);
    });

    it('offers the invitation when that is what was asked for', () => {
      expect(routeUtterance('Ask Mum to watch a film with me')).toEqual({ kind: 'invite' });
      expect(routeUtterance("I'd like to watch a film with Mum on Sunday")).toEqual({ kind: 'invite' });
      expect(routeUtterance('Can we watch a movie together?')).toEqual({ kind: 'invite' });
    });

    it('knows an invitation to a film from an invitation to the family circle', () => {
      expect(routeUtterance('Invite Mum to watch Sintel with me today at 10:45')).toEqual({ kind: 'invite' });
      expect(routeUtterance('Invite Mum to a film on Sunday')).toEqual({ kind: 'invite' });
      expect(routeUtterance('Did Mum accept my invitation to the film?')).toMatchObject({ kind: 'tool', tool: 'get_watch_together' });
      // Nothing about a film: still the circle.
      expect(routeUtterance('Invite my brother')).toEqual({ kind: 'circle' });
      expect(routeUtterance('Send an invitation to my sister')).toEqual({ kind: 'circle' });
    });

    it('leaves a note about a film a note', () => {
      expect(routeUtterance('Tell Mum the film was lovely').kind).toBe('compose');
    });
  });

  describe('the invitation', () => {
    it('is shown in full before it is sent: the film by its name, the day in words', () => {
      const asked = confirmWrite('invite_to_watch', { programme: 'sintel', date: '2026-10-18', time: '15:00' });

      expect(asked.title).toBe('Ask to watch this together?');
      expect(asked.fields).toEqual([['Film', 'Sintel'], ['When', 'Sunday 18 October, 15:00']]);
      expect(asked.confirmLabel).toBe('Ask');
    });

    it('shows a film it does not know by the id that would be sent, never dressed up', () => {
      expect(confirmWrite('invite_to_watch', { programme: 'casablanca', date: '2026-10-18', time: '15:00' }).fields[0]).toEqual(['Film', 'casablanca']);
    });

    it('says it was sent, and when it will be seen', () => {
      const r = presentResult('invite_to_watch', JSON.stringify({ invited: true, sessionId: 's-1', film: 'Sintel', startsAt: 5000, when: 'Sunday 18 October at 3 pm', fromName: 'Sarah' }), {}, at);

      expect(r.say).toBe('Asked. The invitation will appear on the television at the next natural break, and is answered there with one button.');
      expect(r.card).toMatchObject({ kind: 'confirmation', title: 'Invitation sent to the television', fields: [['Film', 'Sintel'], ['When', 'Sunday 18 October at 3 pm'], ['From', 'Sarah']] });
    });
  });

  describe('how it stands', () => {
    it('says an invitation is still waiting, and offers the one thing that can be done: taking it back', () => {
      const r = presentResult('get_watch_together', view(), {}, at);

      expect(r.say).toBe('The invitation to watch Sintel on Sunday 18 October at 3 pm is on the television. It has not been answered yet.');
      expect(r.card).toEqual({
        kind: 'invitation',
        title: 'Sintel',
        meta: 'Sunday 18 October at 3 pm',
        sessionId: 's-1',
        footnote: 'It stays on the television until it is answered. If your plans change, you can take it back.',
      });
    });

    it('says an invitation was taken back, and that another can be sent', () => {
      const r = presentResult('get_watch_together', view({ state: 'withdrawn' }), {}, at);

      expect(r.say).toBe('You took back the invitation to watch Sintel on Sunday 18 October at 3 pm. You can ask again whenever you like.');
      expect(r.card).toBeNull();
    });

    it('says so when an invitation has just been taken back', () => {
      const taken = JSON.stringify({ withdrawn: true, sessionId: 's-1', film: 'Sintel', when: 'Sunday 18 October at 3 pm' });

      expect(presentResult('withdraw_watch_invitation', taken, {}, at)).toEqual({
        say: 'Taken back. The invitation to watch Sintel on Sunday 18 October at 3 pm is no longer on the television.',
        card: null,
        tone: 'answer',
      });
      // Not taken back — she had already answered: said as the server said it.
      expect(presentResult('withdraw_watch_invitation', 'Margaret has already said yes to Sintel on Sunday 18 October at 3 pm, so it cannot be taken back.', {}, at).say).toBe(
        'Margaret has already said yes to Sintel on Sunday 18 October at 3 pm, so it cannot be taken back.',
      );
    });

    it('says yes, and when to sit down, before it is time', () => {
      const r = presentResult('get_watch_together', view({ state: 'accepted', canSitDown: false, opensAt: 4000 }), {}, at);

      expect(r.say).toBe('The answer was yes. Sintel is on Sunday 18 October at 3 pm; you can sit down from half an hour before.');
      expect(r.card).toBeNull();
    });

    it('says no as it was said', () => {
      expect(presentResult('get_watch_together', view({ state: 'declined' }), {}, at).say).toBe('The answer to Sintel on Sunday 18 October at 3 pm was: not this time.');
      expect(presentResult('get_watch_together', view({ state: 'passed' }), {}, at).say).toBe('When it came to it, the answer was: not now.');
      expect(presentResult('get_watch_together', view({ state: 'over' }), {}, at).say).toBe('The time for Sintel has passed.');
      // She started it and left it: said plainly, with nothing to sit down to — and it can be asked again.
      const stopped = presentResult('get_watch_together', view({ state: 'stopped' }), {}, at);
      expect(stopped.say).toBe('Sintel was stopped on the television before the end. You can ask again whenever you like.');
      expect(stopped.card).toBeNull();
    });

    it('offers the seat when it is time', () => {
      const r = presentResult('get_watch_together', view({ state: 'accepted', canSitDown: true, opensAt: 4000 }), {}, at);

      expect(r.say).toBe('It is time for Sintel. Sit down when you are ready.');
      expect(r.card).toMatchObject({ kind: 'watch', title: 'Sintel', meta: 'Sunday 18 October at 3 pm', sessionId: 's-1', state: 'accepted', canSitDown: true, stream: null });
    });

    it('opens the seat with the film once sat down, and says who holds the remote', () => {
      const r = presentResult('join_watch_together', view({ state: 'ready', stream: STREAM }), {}, at);

      expect(r.say).toBe('You are sitting down. The television says you are ready, and the film starts when it is started there.');
      expect(r.card).toMatchObject({ kind: 'watch', state: 'ready', stream: STREAM, playback: null });
      expect(r.card.footnote).toBe('Your screen follows the television. You cannot pause or skip: the remote is theirs. No camera, no microphone.');
    });

    it('carries where the film is while it is on', () => {
      const playback = { state: 'PLAYING', positionMs: 61_000, ageMs: 1_200 };
      const r = presentResult('get_watch_together', view({ state: 'watching', stream: STREAM, playback }), {}, at);

      expect(r.say).toBe('Sintel is on. Your screen follows the television.');
      expect(r.card).toMatchObject({ kind: 'watch', state: 'watching', playback });
    });

    it('plays only from an address that is https, or this machine', () => {
      const from = (url: string) => presentResult('get_watch_together', view({ state: 'watching', stream: { ...STREAM, url } }), {}, at).card.stream;

      expect(from('https://films.example/sintel/index.m3u8')).not.toBeNull();
      expect(from('http://127.0.0.1:3300/dev/programmes/sintel/index.m3u8')).not.toBeNull();
      expect(from('http://films.example/sintel/index.m3u8')).toBeNull();
      expect(from('javascript:alert(1)')).toBeNull();
    });

    it('asks the one question at the end, with only the answers this page knows', () => {
      const r = presentResult('get_watch_together', view({
        state: 'watched', stream: STREAM, question: WATCH_QUESTION,
        answers: [...ANSWERS, { key: 'made_up', text: 'Sell the television.' }, { key: 'loved_it', text: 'Something else.' }],
      }), {}, at);

      expect(r.say).toBe('Sintel has reached its end. What did you think of it?');
      expect(r.card.question).toBe(WATCH_QUESTION);
      expect(r.card.answers).toEqual(ANSWERS);
    });

    it('says what each of them thought, once it is known', () => {
      const r = presentResult('get_watch_together', view({ state: 'watched', question: WATCH_QUESTION, yourAnswer: 'I loved it.', theirAnswer: 'It was all right.' }), {}, at);

      expect(r.say).toBe('You watched Sintel together. You said: “I loved it.” The answer on the television was: “It was all right.”');
      expect(r.card).toBeNull();
    });

    it('says an answer is on the television', () => {
      const r = presentResult('answer_watch_together', JSON.stringify({ shown: true, by: 'Sarah', text: 'I loved it.' }), {}, at);
      expect(r.say).toBe('It is on the television now: “Sarah says: I loved it.”');
    });

    it('confirms an answer by its sentence, and sitting down as what it is', () => {
      expect(confirmWrite('answer_watch_together', { sessionId: 's-1', answer: 'loved_it' }).fields[0]).toEqual(['Your answer', 'I loved it.']);
      expect(confirmWrite('answer_watch_together', { sessionId: 's-1', answer: 'nope' }).fields[0]).toEqual(['Your answer', 'nope']);
      expect(confirmWrite('join_watch_together', { sessionId: 's-1' }).title).toBe('Sit down to watch now?');
    });

    it('confirms taking an invitation back as what it is', () => {
      const asked = confirmWrite('withdraw_watch_invitation', { sessionId: 's-1' });

      expect(asked.title).toBe('Take the invitation back?');
      expect(asked.confirmLabel).toBe('Take it back');
      expect(asked.footnote).toBe('It leaves the television. You can ask again whenever you like.');
    });

    it('names each step in plain words', () => {
      expect(describeCall('invite_to_watch')).toBe('Asked to watch a film together');
      expect(describeCall('get_watch_together')).toBe('Looked at the film');
      expect(describeCall('join_watch_together')).toBe('Sat down to watch');
      expect(describeCall('answer_watch_together')).toBe('Answered on the television');
      expect(describeCall('withdraw_watch_invitation')).toBe('Took the invitation back');
    });

    it('sends "cancel the film" to what stands, where taking it back is offered', () => {
      expect(routeUtterance('Cancel the film invitation')).toEqual({ kind: 'tool', tool: 'get_watch_together', args: {} });
      expect(routeUtterance('I want to take back the invitation to watch the film')).toEqual({ kind: 'tool', tool: 'get_watch_together', args: {} });
    });
  });

  describe('follow — where this screen should be, given where the television is', () => {
    it('plays on from where the television was, by as long ago as that was', () => {
      // Heard 1.2s before the server answered, and the answer is 0.3s old: the film is 1.5s further on.
      expect(follow({ state: 'PLAYING', positionMs: 60_000, ageMs: 1_200 }, 300, { positionMs: 61_400, paused: false })).toEqual({ play: true, seekToMs: null });
    });

    it('jumps when it has fallen behind, or the television skipped', () => {
      expect(follow({ state: 'PLAYING', positionMs: 90_000, ageMs: 500 }, 0, { positionMs: 61_000, paused: false })).toEqual({ play: true, seekToMs: 90_500 });
      expect(follow({ state: 'PLAYING', positionMs: 30_000, ageMs: 0 }, 0, { positionMs: 61_000, paused: false })).toEqual({ play: true, seekToMs: 30_000 });
    });

    it('starts playing when the television does', () => {
      expect(follow({ state: 'PLAYING', positionMs: 60_000, ageMs: 0 }, 0, { positionMs: 60_000, paused: true })).toEqual({ play: true, seekToMs: null });
    });

    it('pauses where the television paused, to the frame it stopped near', () => {
      expect(follow({ state: 'PAUSED', positionMs: 75_000, ageMs: 40_000 }, 5_000, { positionMs: 76_200, paused: false })).toEqual({ play: false, seekToMs: 75_000 });
      expect(follow({ state: 'PAUSED', positionMs: 75_000, ageMs: 0 }, 0, { positionMs: 75_100, paused: true })).toEqual({ play: false, seekToMs: null });
    });

    it('waits where the television was when it has gone quiet, and does not run on', () => {
      expect(follow({ state: 'WAITING', positionMs: 120_000, ageMs: 30_000 }, 0, { positionMs: 121_000, paused: false })).toEqual({ play: false, seekToMs: 120_000 });
    });

    it('stops where it is when the film is stopped, and before anything is known', () => {
      expect(follow({ state: 'STOPPED', positionMs: 5_000, ageMs: 0 }, 0, { positionMs: 300_000, paused: false })).toEqual({ play: false, seekToMs: null });
      expect(follow(null, 0, { positionMs: 0, paused: true })).toEqual({ play: false, seekToMs: null });
    });

    it('never asks for a place past the end of the film', () => {
      expect(follow({ state: 'PLAYING', positionMs: 887_000, ageMs: 60_000 }, 0, { positionMs: 0, paused: true }, 888_000)).toEqual({ play: true, seekToMs: 888_000 });
    });
  });

  describe('watchStatus — one line under the picture', () => {
    it('says what the television is doing, in words', () => {
      const line = (state: string, playback: object | null) => watchStatus({ state, playback });

      expect(line('accepted', null)).toBe('Sit down when you are ready.');
      expect(line('ready', null)).toBe('Waiting for the film to be started on the television.');
      expect(line('watching', null)).toBe('The film is starting on the television.');
      expect(line('watching', { state: 'PLAYING' })).toBe('Playing, as on the television.');
      expect(line('watching', { state: 'PAUSED' })).toBe('Paused on the television.');
      expect(line('watching', { state: 'WAITING' })).toBe('Waiting for the television.');
      expect(line('watching', { state: 'STOPPED' })).toBe('The film was stopped on the television.');
      expect(line('watched', { state: 'PLAYING' })).toBe('The credits are playing.');
      expect(line('passed', null)).toBe('When it came to it, the answer was: not now.');
      expect(line('over', null)).toBe('This has finished.');
    });
  });

  describe('watchToAnnounce — what is worth saying unasked', () => {
    const seen = (entries: [string, string][] = []) => new Map(entries);

    it('says when it is time to sit down, once', () => {
      const raw = view({ state: 'accepted', canSitDown: true });

      expect(watchToAnnounce(raw, seen())).toEqual({ sessionId: 's-1', key: 'time', announce: true });
      expect(watchToAnnounce(raw, seen([['s-1', 'time']]))).toEqual({ sessionId: 's-1', key: 'time', announce: false });
    });

    it('says a film already on is on, and that there is a question to answer', () => {
      expect(watchToAnnounce(view({ state: 'watching' }), seen()).announce).toBe(true);
      expect(watchToAnnounce(view({ state: 'ready' }), seen()).announce).toBe(true);
      expect(watchToAnnounce(view({ state: 'watched', answers: [] }), seen()).announce).toBe(true);
    });

    it('says the answer to an invitation when it comes while the app is open, and not an old one on opening', () => {
      expect(watchToAnnounce(view({ state: 'accepted', canSitDown: false }), seen([['s-1', 'invited']])).announce).toBe(true);
      expect(watchToAnnounce(view({ state: 'declined' }), seen([['s-1', 'invited']])).announce).toBe(true);
      expect(watchToAnnounce(view({ state: 'declined' }), seen()).announce).toBe(false);
      expect(watchToAnnounce(view({ state: 'accepted', canSitDown: false }), seen()).announce).toBe(false);
    });

    it('says nothing about an invitation still waiting, one that is over, or an answer that is not a session', () => {
      expect(watchToAnnounce(view(), seen()).announce).toBe(false);
      expect(watchToAnnounce(view({ state: 'over' }), seen([['s-1', 'watching']])).announce).toBe(false);
      expect(watchToAnnounce(view({ state: 'watched', yourAnswer: 'I loved it.' }), seen()).announce).toBe(false);
      expect(watchToAnnounce("You haven't asked Margaret to watch anything.", seen())).toBeNull();
    });
  });
});

describe('notifications — being told when Wick is closed', () => {
  const ready = { supported: true, available: true, permission: 'default', subscribed: false };

  it('offers to turn them on, saying exactly how little a notification says', () => {
    const r = presentNotifications(ready, 'Margaret');

    expect(r.offer).toBe(true);
    expect(r.say).toBe('This browser can tell you when Margaret asks you to look at the door, even when Wick is closed.');
    expect(r.card).toEqual({
      title: 'Be told at once',
      body: 'The notification says only that there is something to look at. The picture and everything else stay in Wick.',
      confirmLabel: 'Turn on notifications',
    });
  });

  it('says they are on, and offers nothing more', () => {
    expect(presentNotifications({ ...ready, permission: 'granted', subscribed: true }, 'Margaret')).toEqual({
      offer: false,
      say: 'Notifications are on in this browser. It will tell you when Margaret asks you to look at the door.',
      card: null,
    });
  });

  it('offers again when the browser allows them but this browser is not yet registered', () => {
    expect(presentNotifications({ ...ready, permission: 'granted', subscribed: false }, 'Margaret').offer).toBe(true);
  });

  it('says where to change it when the browser has blocked them — the page cannot ask twice', () => {
    expect(presentNotifications({ ...ready, permission: 'denied' }, 'Margaret')).toEqual({
      offer: false,
      say: 'This browser has blocked notifications for Wick. They can be allowed again in the browser’s site settings.',
      card: null,
    });
  });

  it('says so plainly where there is nothing to offer', () => {
    expect(presentNotifications({ supported: false }, 'Margaret')).toMatchObject({ offer: false, say: 'This browser cannot show notifications from Wick.' });
    expect(presentNotifications({ ...ready, available: false }, 'Margaret')).toMatchObject({ offer: false, say: 'This Wick cannot send notifications yet.' });
  });

  it('is asked for by name', () => {
    expect(routeUtterance('Turn on notifications')).toEqual({ kind: 'notifications' });
    expect(routeUtterance('Can you notify me?')).toEqual({ kind: 'notifications' });
  });
});

describe('applicationServerKey', () => {
  it('turns the server’s base64url key into the bytes a browser subscribes with', () => {
    // "hello?>" in base64url is aGVsbG8_Pg (no padding, with both url-safe characters once + is included).
    expect([...applicationServerKey('aGVsbG8_Pg')]).toEqual([104, 101, 108, 108, 111, 63, 62]);
    expect([...applicationServerKey('-_-_')]).toEqual([251, 255, 191]);
  });
});

describe('madeWithKey — whether a browser’s subscription still belongs to this Wick', () => {
  const key = 'aGVsbG8_Pg';
  const bytes = (values: number[]) => new Uint8Array(values).buffer;

  it('is true for a subscription made with the server’s present key', () => {
    expect(madeWithKey({ options: { applicationServerKey: bytes([104, 101, 108, 108, 111, 63, 62]) } }, key)).toBe(true);
  });

  it('is false for one made with another key: Wick’s nudges to it would be refused', () => {
    expect(madeWithKey({ options: { applicationServerKey: bytes([104, 101, 108, 108, 111, 63, 63]) } }, key)).toBe(false);
    expect(madeWithKey({ options: { applicationServerKey: bytes([104, 101]) } }, key)).toBe(false);
  });

  it('is false when the browser does not say which key it was made with', () => {
    expect(madeWithKey({ options: {} }, key)).toBe(false);
    expect(madeWithKey({}, key)).toBe(false);
  });
});

describe('the light in the window', () => {
  const lit = JSON.stringify({ lit: true, summary: 'The light is on at Margaret’s: the day has begun there.', seen: 'Margaret can see that you looked in.' });
  const unlit = JSON.stringify({ lit: false, summary: 'The light isn’t on at Margaret’s. It may not be lit yet today, or Margaret may have put it out.', seen: 'Margaret can see that you looked in.' });

  it('has a chip, and sends a question about the light to its tool', () => {
    const asked = { kind: 'tool', tool: 'get_light', args: {} };

    expect(routeUtterance("Is the light on at Mum's?")).toEqual(asked);
    expect(routeUtterance('Is Mum’s light lit?')).toEqual(asked);
    expect(SUGGESTIONS.some((s: { utterance: string }) => routeUtterance(s.utterance).tool === 'get_light')).toBe(true);
  });

  it('leaves a note that mentions a light a note', () => {
    expect(routeUtterance('Tell Mum to leave the porch light on').kind).toBe('compose');
  });

  it('says the server’s sentence as it stands, shows the light, and says she can see the look', () => {
    const r = presentResult('get_light', lit, {}, at);

    expect(r.say).toBe('The light is on at Margaret’s: the day has begun there.');
    expect(r.card).toMatchObject({ kind: 'light', lit: true, title: 'The light is on', note: 'Margaret can see that you looked in.' });
    expect(r.card.footnote).toBe('One thing about today, and nothing else: no time, and nothing about what is on.');
  });

  it('shows an unlit window without a reason of its own', () => {
    const r = presentResult('get_light', unlit, {}, at);

    expect(r.say).toBe('The light isn’t on at Margaret’s. It may not be lit yet today, or Margaret may have put it out.');
    expect(r.card).toMatchObject({ kind: 'light', lit: false, title: 'The light is not on' });
    expect(JSON.stringify(r.card)).not.toMatch(/asleep|not up|wrong|worry/i);
  });

  it('says a refusal as the server said it, with no light at all', () => {
    const r = presentResult('get_light', "That's something the resident is keeping to themselves. I'm not able to share it.", {}, at);

    expect(r.card).toBeNull();
    expect(r.say).toContain('keeping to themselves');
  });

  it('knows what to show in the corner of the page: lit, not lit, or nothing when there is no light to see', () => {
    expect(lightToShow(lit)).toEqual({ lit: true });
    expect(lightToShow(unlit)).toEqual({ lit: false });
    expect(lightToShow("That's something the resident is keeping to themselves. I'm not able to share it.")).toBeNull();
    expect(lightToShow('Margaret hasn’t allowed this yet.')).toBeNull();
  });

  it('says in a few words what the step did', () => {
    expect(describeCall('get_light')).toBe('Looked at the light');
  });
});
