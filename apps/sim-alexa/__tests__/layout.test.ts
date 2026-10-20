/**
 * The redesigned page's own decisions, with no DOM (main.js only draws them):
 * which suggestions are shown in the row and how the rest are grouped, what
 * the waiting card says as the seconds pass, and what the panel about her
 * home shows from what the app already fetched.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  FEATURED_SUGGESTIONS,
  SUGGESTIONS,
  SUGGESTION_GROUPS,
  WAITING_STAGES_MS,
  arrangeSuggestions,
  presentListing,
  suggestionsFor,
  waitingTopic,
  waitingWords,
  elapsedLabel,
} from '../surface.js';
import { presentHome } from '../home.js';

const listing = presentListing(JSON.parse(readFileSync(new URL('../../../addon-package/addon.json', import.meta.url), 'utf8')));
const demoMe = {
  user: { userId: 'u1', name: 'Sarah' },
  household: { householdId: 'h1', name: 'Demo home', residentName: 'Margaret', timeZone: 'Europe/London', simulated: true, demoSession: 'AB12CD' },
  membership: { role: 'organiser', status: 'allowed' },
  virtualTelevisionUrl: 'https://tv.example/tv.html',
};
const realMe = {
  user: { userId: 'u2', name: 'Tom' },
  household: { householdId: 'h2', name: 'Mum’s', residentName: 'Joan', timeZone: 'Europe/London' },
  membership: { role: 'family', status: 'allowed' },
};

describe('arrangeSuggestions — one row of the most useful, and the rest grouped under More', () => {
  it('shows at most six in the row, the week first', () => {
    for (const me of [null, realMe, demoMe]) {
      for (const shown of [null, listing]) {
        const { featured } = arrangeSuggestions(suggestionsFor(shown, me));
        expect(featured.length).toBeGreaterThanOrEqual(5);
        expect(featured.length).toBeLessThanOrEqual(FEATURED_SUGGESTIONS);
        expect(featured[0].utterance).toMatch(/week/i);
      }
    }
  });

  it('puts the stand-in doorbell in the row of a demo home, and never in another', () => {
    const demo = arrangeSuggestions(suggestionsFor(listing, demoMe));
    expect(demo.featured.map((s) => s.label)).toContain('Ring the stand-in doorbell');
    const real = arrangeSuggestions(suggestionsFor(listing, realMe));
    expect(real.featured.map((s) => s.label)).not.toContain('Ring the stand-in doorbell');
    expect(real.groups.map((g) => g.title)).not.toContain('Demo');
  });

  it('lists every suggestion exactly once in the groups, in the four groups’ order', () => {
    const all = suggestionsFor(listing, demoMe);
    const { groups } = arrangeSuggestions(all);
    expect(groups.map((g) => g.title)).toEqual(SUGGESTION_GROUPS);
    const listed = groups.flatMap((g) => g.items);
    expect(listed).toHaveLength(all.length);
    expect(new Set(listed.map((s) => s.label))).toEqual(new Set(all.map((s) => s.label)));
  });

  it('groups by what a suggestion asks, not by its words', () => {
    const { groups } = arrangeSuggestions(SUGGESTIONS);
    const titleOf = (label: string) => groups.find((g) => g.items.some((s) => s.label === label))?.title;
    expect(titleOf('How’s Mum been this week?')).toBe('Ask about her');
    expect(titleOf('Send a note to her television')).toBe('Send or arrange');
    expect(titleOf('Arrange a visit')).toBe('Send or arrange');
    expect(titleOf('Send a picture')).toBe('Send or arrange');
    expect(titleOf('Is the light on?')).toBe('Her home and circle');
    expect(titleOf('Family circle')).toBe('Her home and circle');
    expect(titleOf('Television language')).toBe('Her home and circle');
  });

  it('leaves out a group with nothing in it', () => {
    expect(arrangeSuggestions(SUGGESTIONS).groups.map((g) => g.title)).toEqual(['Ask about her', 'Send or arrange', 'Her home and circle']);
  });
});

describe('waitingWords — never a bare "Thinking": what is happening, honestly, as the seconds pass', () => {
  it('says the agent is being asked, at once', () => {
    expect(waitingWords(0, { agent: true })).toEqual({ words: 'Asking Wick’s agent…', detail: '' });
    expect(waitingWords(WAITING_STAGES_MS.reading - 1, { agent: true }).words).toBe('Asking Wick’s agent…');
  });

  it('says what it is most likely reading after a few seconds', () => {
    const topic = waitingTopic('How has Mum been this week?');
    expect(topic).toBe('Reading her week…');
    expect(waitingWords(WAITING_STAGES_MS.reading, { agent: true, topic }).words).toBe('Reading her week…');
    expect(waitingTopic('Is the light on at mum’s?')).toBe('Looking at her light…');
    expect(waitingTopic('Put a note on her television saying hello')).toBe('Getting the note ready…');
    expect(waitingTopic('What colour is the sky?')).toBe('Asking Wick’s tools…');
  });

  it('says why the first answer is slow once it is', () => {
    const late = waitingWords(WAITING_STAGES_MS.cold, { agent: true, topic: 'Reading her week…' });
    expect(late.words).toBe('Reading her week…');
    expect(late.detail).toBe('The first answer can take up to a minute while the agent wakes up.');
  });

  it('says what happens if the agent never answers', () => {
    const last = waitingWords(WAITING_STAGES_MS.fallback + 5000, { agent: true });
    expect(last.words).toBe('Still waiting for the agent…');
    expect(last.detail).toMatch(/answers from its own tools/);
  });

  it('says Wick, not the agent, when only a tool is being asked', () => {
    expect(waitingWords(0).words).toBe('Asking Wick…');
    expect(waitingWords(WAITING_STAGES_MS.reading).words).toBe('Still asking Wick…');
    expect(waitingWords(WAITING_STAGES_MS.cold).detail).toBe('');
  });

  it('counts the seconds in words a person reads at a glance', () => {
    expect(elapsedLabel(400)).toBe('0 s');
    expect(elapsedLabel(12_300)).toBe('12 s');
    expect(elapsedLabel(65_000)).toBe('1 min 5 s');
  });
});

describe('presentHome — the panel about her home, from what the app already fetched', () => {
  const circle = {
    household: demoMe.household,
    members: [
      { userId: 'u1', name: 'Sarah', role: 'organiser', status: 'allowed', you: true },
      { userId: 'u3', name: 'Ben', role: 'family', status: 'pending', you: false },
    ],
    televisions: [
      { ref: 'b', pairedAt: 2000, connected: false },
      { ref: 'a', pairedAt: 1000, connected: true },
    ],
    familyTelevisions: [],
  };
  const errands = JSON.stringify({
    errands: [
      { errandId: 'e1', who: 'the plumber', when: 'Thursday 22 October, 10:00', status: 'planned', said: 'The door expects the plumber.' },
      { errandId: 'e2', who: 'Maria', when: 'Monday 19 October, 09:00', status: 'rang', said: 'Someone rang.' },
    ],
  });

  it('names her home and says plainly when it is a demo', () => {
    const home = presentHome({ me: demoMe });
    expect(home.title).toBe('Margaret’s home');
    expect(home.demo).toBe('Demo home AB12CD · simulated history');
    expect(home.virtualTelevisionUrl).toBe('https://tv.example/tv.html');
    expect(presentHome({ me: realMe }).demo).toBeNull();
  });

  it('shows her light only once it has been seen, in words and not colour alone', () => {
    expect(presentHome({ me: demoMe }).light).toBeNull();
    expect(presentHome({ me: demoMe, light: { lit: true } }).light).toEqual({ lit: true, words: 'Her light is on' });
    expect(presentHome({ me: demoMe, light: { lit: false } }).light).toEqual({ lit: false, words: 'Her light is not on' });
  });

  it('lists her televisions in the order they were connected, each on or not in words', () => {
    const home = presentHome({ me: demoMe, circle });
    expect(home.televisions?.line).toBe('Two televisions connected. One is on now.');
    expect(home.televisions?.rows).toEqual([
      { name: 'Television 1', on: true, state: 'On now' },
      { name: 'Television 2', on: false, state: 'Off, or showing something else' },
    ]);
    expect(home.circle).toBe('Two people in the family circle. One is waiting for Margaret to allow them.');
  });

  it('shows who is expected next from the visits still to come, and none that are over', () => {
    const home = presentHome({ me: demoMe, errands });
    expect(home.expected).toEqual([{ who: 'the plumber', when: 'Thursday 22 October, 10:00' }]);
    expect(presentHome({ me: demoMe, errands: JSON.stringify({ errands: [] }) }).expected).toEqual([]);
    // Not asked, or not answered: nothing is said about visits at all.
    expect(presentHome({ me: demoMe }).expected).toBeNull();
    expect(presentHome({ me: demoMe, errands: 'not json' }).expected).toBeNull();
  });

  it('shows nothing it was not given', () => {
    const home = presentHome({ me: realMe });
    expect(home.televisions).toBeNull();
    expect(home.circle).toBeNull();
  });
});
