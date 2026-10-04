import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain browser module, deliberately untyped (no build step).
import { inviteLink, presentCircle, presentResult, presentWelcome, routeUtterance, SUGGESTIONS } from '../surface.js';

const at = (ms: number) => `t${ms}`;

describe('routeUtterance', () => {
  it('routes every suggestion chip to a tool — a chip that leads nowhere is a broken promise', () => {
    for (const s of SUGGESTIONS) expect(routeUtterance(s.utterance).kind).not.toBe('help');
  });

  it('asks for the week', () => {
    expect(routeUtterance("How's Mum been this week?")).toEqual({ kind: 'tool', tool: 'get_week_narrative', args: {} });
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

  it('speaks the prose and shows the timeline it was built from, oldest first', () => {
    const r = presentResult('get_week_narrative', week, {}, at);
    expect(r.say).toBe('A steady week. Someone came to the door four times.');
    expect(r.card.title).toBe('This week');
    expect(r.card.items).toEqual([
      { primary: 'Maria visited.', secondary: 't100' },
      { primary: 'Someone came to the door.', secondary: 't200' },
    ]);
    expect(r.card.footnote).toMatch(/read it first/);
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
