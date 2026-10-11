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
  presentResult,
  presentTurn,
  presentWelcome,
  routeUtterance,
  REPLY_CHOICES,
  SUGGESTIONS,
} from '../surface.js';
import { REPLY_CHOICES as SERVER_REPLY_CHOICES } from '../../../services/mcp-server/src/tools/send_note_to_tv.js';

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
  const missed = { kind: 'missed_visit', sentence: 'Maria usually comes on Friday mornings. There has been no visit today.', at: 700 };

  it('is asked for in the words people use, before "today" or "Maria" can take the question', () => {
    const asked = { kind: 'tool', tool: 'get_whats_different', args: {} };

    expect(routeUtterance('Is anything different?')).toEqual(asked);
    expect(routeUtterance('Is anything different today?')).toEqual(asked);
    expect(routeUtterance('Is everything all right with Mum?')).toEqual(asked);
    expect(routeUtterance('Anything unusual about Maria this week?')).toEqual(asked);
  });

  it("says the server's own summary, and lays each difference out with when it was", () => {
    const answer = JSON.stringify({
      weeksObserved: 6,
      enoughHistory: true,
      differences: [missed],
      keptPrivate: [],
      summary: `${missed.sentence} Nothing else is different from the usual.`,
    });

    const r = presentResult('get_whats_different', answer, {}, at);

    expect(r.say).toBe('Maria usually comes on Friday mornings. There has been no visit today. Nothing else is different from the usual.');
    expect(r.card.title).toBe('One thing is different');
    expect(r.card.items).toEqual([{ primary: missed.sentence, secondary: 't700' }]);
    expect(r.card.footnote).toBe('Against the last 6 weeks in this house, and nothing else.');
  });

  it('shows no card on a usual day: there is nothing behind "nothing is different" to look at', () => {
    const answer = JSON.stringify({ weeksObserved: 6, enoughHistory: true, differences: [], keptPrivate: [], summary: 'Nothing is different from the usual today.' });

    expect(presentResult('get_whats_different', answer, {}, at)).toMatchObject({ say: 'Nothing is different from the usual today.', card: null });
  });

  it('says it cannot tell yet, in the server\'s words, when Wick has not been there three weeks', () => {
    const summary = 'Wick has been here for one week. It needs three weeks before it knows what is usual, so it cannot yet say what is different.';
    const answer = JSON.stringify({ weeksObserved: 1, enoughHistory: false, differences: [], keptPrivate: [], summary });

    expect(presentResult('get_whats_different', answer, {}, at)).toMatchObject({ say: summary, card: null });
  });
});

describe('describeCall — what a step did, in a few words', () => {
  it('names each tool by what it does for the customer, never by its name', () => {
    expect(describeCall('get_week_narrative', {})).toBe('Read the week');
    expect(describeCall('get_today', { day: 'yesterday' })).toBe('Looked at yesterday');
    expect(describeCall('get_today', {})).toBe('Looked at today');
    expect(describeCall('list_regular_visitors', {})).toBe('Checked who visits');
    expect(describeCall('get_whats_different', {})).toBe('Looked for anything different');
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
