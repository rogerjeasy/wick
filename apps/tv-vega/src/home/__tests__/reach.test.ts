import { describe, expect, it } from 'vitest';
import { REACH_ACTIONS, buildReachAskCard, buildReachCard, type QueuedCard, type ReachPerson } from '@wick/contracts';
import { HOLD_GUARD_MS, RELEASE_GRACE_MS, backAnswersReach, holdGuard, newestReachCard, reachOffersToPutAway } from '../reach.js';
import { removesCard } from '../../cards/cardActions.js';
import { waitingLine } from '../waiting.js';

const NOW = 1_790_900_000_000;
const sarah: ReachPerson = { userId: 'u_sarah', name: 'Sarah', role: 'organiser' };

const offer = (at: number): QueuedCard => buildReachAskCard({ householdId: 'hh-1', reachId: String(at), first: sarah, now: at });
const status = (at: number): QueuedCard => buildReachCard({ householdId: 'hh-1', reachId: String(at), kind: 'ring', askedAt: at, order: [sarah], asked: 1 }, at);
const note = { id: 'note-1', urgency: 'DEFERRED', queuedAt: NOW, shownCount: 0, card: { type: 'MESSAGE', id: 'note-1' } } as unknown as QueuedCard;

describe('newestReachCard — the card her hold brought', () => {
  it('is the latest one held, whatever order they arrived in', () => {
    expect(newestReachCard([offer(NOW - 5_000), note, offer(NOW)])?.id).toBe(`reach-${NOW}`);
    expect(newestReachCard([offer(NOW), offer(NOW - 5_000)])?.id).toBe(`reach-${NOW}`);
  });

  it('is nothing when there is none', () => {
    expect(newestReachCard([note])).toBeUndefined();
  });
});

describe('reachOffersToPutAway — an offer is the answer to her hold and nothing else', () => {
  it('puts away an offer she is not looking at: an earlier hold, or one left by a launch that was cut short', () => {
    const cards = [offer(NOW - 5_000), offer(NOW), note];
    expect(reachOffersToPutAway(cards, `reach-${NOW}`)).toEqual([`reach-${NOW - 5_000}`]);
    expect(reachOffersToPutAway(cards, null)).toEqual([`reach-${NOW - 5_000}`, `reach-${NOW}`]);
  });

  it('never puts away what was said about a request she made: that waits for a break like a note', () => {
    expect(reachOffersToPutAway([status(NOW)], null)).toEqual([]);
  });
});

describe('her press on the card', () => {
  it('leaves the card up when it asks for something: who was asked is written onto it', () => {
    expect(removesCard(offer(NOW).card, REACH_ACTIONS.ring)).toBe(false);
    expect(removesCard(offer(NOW).card, REACH_ACTIONS.hello)).toBe(false);
  });

  it('puts it away on the way out, and when she has read where things stand', () => {
    expect(removesCard(offer(NOW).card, REACH_ACTIONS.notNow)).toBe(true);
    expect(removesCard(status(NOW).card, REACH_ACTIONS.ok)).toBe(true);
  });
});

describe('Back on the card', () => {
  it('is the way out of an offer, and "All right" to anything else', () => {
    expect(backAnswersReach(offer(NOW).card)).toBe(REACH_ACTIONS.notNow);
    expect(backAnswersReach(status(NOW).card)).toBe(REACH_ACTIONS.ok);
  });

  it('is nothing to do with any other card', () => {
    expect(backAnswersReach(note.card)).toBeUndefined();
    expect(backAnswersReach(undefined)).toBeUndefined();
  });
});

describe('waiting on the home screen', () => {
  it('says what the card says: it is the answer to something she asked', () => {
    expect(waitingLine(status(NOW))).toBe('Sarah has been asked to ring you.');
  });
});

describe('holdGuard — letting go of the hold must never press the card it brought', () => {
  const HELD = NOW;

  it('swallows the press that is only her thumb coming up, when the card arrived while OK was still down', () => {
    const guard = holdGuard();
    guard.held(HELD);
    // No release was seen: the card's focused button took the key coming up as a press.
    expect(guard.swallows(HELD + 4_000)).toBe(true);
  });

  it('swallows it whichever is heard first, the release or the press it made', () => {
    const guard = holdGuard();
    guard.held(HELD);
    guard.released(HELD + 4_000);
    expect(guard.swallows(HELD + 4_000 + RELEASE_GRACE_MS - 1)).toBe(true);
  });

  it('swallows once: the next press is hers', () => {
    const guard = holdGuard();
    guard.held(HELD);
    expect(guard.swallows(HELD + 4_000)).toBe(true);
    expect(guard.swallows(HELD + 4_050)).toBe(false);
  });

  it('takes nothing from a press she makes after letting go and reading the card', () => {
    const guard = holdGuard();
    guard.held(HELD);
    guard.released(HELD + 300);
    expect(guard.swallows(HELD + 300 + RELEASE_GRACE_MS)).toBe(false);
    expect(guard.swallows(HELD + 6_000)).toBe(false);
  });

  it('gives up after a while, so a remote that never says the key came up costs her one press at most, and only at first', () => {
    const guard = holdGuard();
    guard.held(HELD);
    expect(guard.swallows(HELD + HOLD_GUARD_MS)).toBe(false);
  });

  it('is nothing when there was no hold, and a release with no hold is nothing either', () => {
    const guard = holdGuard();
    guard.released(HELD);
    expect(guard.swallows(HELD + 1)).toBe(false);
  });

  it('starts afresh with each hold', () => {
    const guard = holdGuard();
    guard.held(HELD);
    guard.released(HELD + 300);
    guard.held(HELD + 60_000);
    expect(guard.swallows(HELD + 64_000)).toBe(true);
  });
});

