import { describe, it, expect } from 'vitest';
import type { DoorCard, MessageCard, QueuedCard } from '@wick/contracts';
import { BreakController } from '../BreakController.js';

const NOW = 1_000_000;

function doorQueued(over: Partial<QueuedCard> = {}): QueuedCard {
  const card: DoorCard = {
    type: 'DOOR', id: 'd1', householdId: 'hh-1', correlationId: 'c1', createdAt: NOW, actions: [], line: 'x',
  };
  return { id: 'd1', urgency: 'DOOR', card, queuedAt: NOW, shownCount: 0, ...over };
}

function messageQueued(over: Partial<QueuedCard> = {}): QueuedCard {
  const card: MessageCard = {
    type: 'MESSAGE', id: 'm1', householdId: 'hh-1', correlationId: 'c1', createdAt: NOW, actions: [],
    fromName: 'Sarah', suggestedReplies: [],
  };
  return { id: 'm1', urgency: 'DEFERRED', card, queuedAt: NOW, shownCount: 0, ...over };
}

describe('BreakController — without a player attached (SP-1 unresolved)', () => {
  it('stays IDLE while the app is backgrounded', () => {
    const bc = new BreakController();
    bc.setForeground(false, NOW);
    expect(bc.breakState(NOW)).toBe('IDLE');
  });

  it('reaches TV_SETTLED 20s after foregrounding with no playback', () => {
    const bc = new BreakController();
    bc.setForeground(true, NOW);
    expect(bc.breakState(NOW + 19_999)).not.toBe('TV_SETTLED');
    expect(bc.breakState(NOW + 20_000)).toBe('TV_SETTLED');
  });

  it('releases a DOOR card immediately regardless of foreground timing', () => {
    const bc = new BreakController();
    bc.setForeground(true, NOW);
    expect(bc.pickCard([doorQueued()], NOW)).toMatchObject({ id: 'd1' });
  });

  it('withholds a DEFERRED card before TV_SETTLED, and releases it after', () => {
    const bc = new BreakController();
    bc.setForeground(true, NOW);
    expect(bc.pickCard([messageQueued()], NOW + 1000)).toBeUndefined();
    expect(bc.pickCard([messageQueued()], NOW + 20_000)).toMatchObject({ id: 'm1' });
  });

  it('prefers a DOOR card over a releasable DEFERRED card', () => {
    const bc = new BreakController();
    bc.setForeground(true, NOW);
    const picked = bc.pickCard([messageQueued(), doorQueued()], NOW + 20_000);
    expect(picked?.id).toBe('d1');
  });

  it('among DOOR cards, shows the newest visit — the earlier one is no longer at the door', () => {
    const bc = new BreakController();
    bc.setForeground(true, NOW);
    const earlier = doorQueued({ id: 'earlier', card: { ...doorQueued().card, id: 'earlier', createdAt: NOW - 600_000 } as DoorCard });
    const latest = doorQueued({ id: 'latest', card: { ...doorQueued().card, id: 'latest', createdAt: NOW - 5_000 } as DoorCard });
    expect(bc.pickCard([earlier, latest], NOW)?.id).toBe('latest');
  });

  it('puts a card the resident just asked for ahead of older DEFERRED cards', () => {
    const bc = new BreakController();
    bc.setForeground(true, NOW);
    const waitingNote = { ...messageQueued(), id: 'note', queuedAt: NOW - 60_000 };
    const asked = { ...messageQueued(), id: 'sharing', queuedAt: NOW, respondsTo: 'week-2026-W40' };
    expect(bc.pickCard([waitingNote, asked], NOW + 20_000)?.id).toBe('sharing');
  });

  it('still holds a card the resident asked for while a scene is playing — INV-5 has no third class', () => {
    const bc = new BreakController();
    bc.setForeground(true, NOW);
    bc.setPlayback({ state: 'PLAYING', positionMs: 1_000, durationMs: 3_600_000, contentId: 'ep1' }, NOW);
    const asked = { ...messageQueued(), id: 'sharing', respondsTo: 'week-2026-W40' };
    expect(bc.pickCard([asked], NOW + 20_000)).toBeUndefined();
  });

  it('among releasable DEFERRED cards, picks the longest-waiting one', () => {
    const bc = new BreakController();
    bc.setForeground(true, NOW);
    const older = messageQueued({ id: 'older', queuedAt: NOW - 5000, card: { ...messageQueued().card, id: 'older' } as MessageCard });
    const newer = messageQueued({ id: 'newer', queuedAt: NOW - 1000, card: { ...messageQueued().card, id: 'newer' } as MessageCard });
    const picked = bc.pickCard([newer, older], NOW + 20_000);
    expect(picked?.id).toBe('older');
  });

  it('backgrounding resets settled state — re-foregrounding needs another 20s', () => {
    const bc = new BreakController();
    bc.setForeground(true, NOW);
    expect(bc.breakState(NOW + 20_000)).toBe('TV_SETTLED');
    bc.setForeground(false, NOW + 20_000);
    bc.setForeground(true, NOW + 20_001);
    expect(bc.breakState(NOW + 20_500)).not.toBe('TV_SETTLED');
  });
});

describe('BreakController — with playback attached', () => {
  it('withholds a DEFERRED card while IN_SCENE', () => {
    const bc = new BreakController();
    bc.setForeground(true, NOW);
    bc.setPlayback({ state: 'PLAYING', positionMs: 10_000, durationMs: 600_000, contentId: 'ep1' }, NOW);
    expect(bc.breakState(NOW)).toBe('IN_SCENE');
    expect(bc.pickCard([messageQueued()], NOW)).toBeUndefined();
  });

  it('releases a DEFERRED card once playback crosses creditsPositionMs', () => {
    const bc = new BreakController();
    bc.setForeground(true, NOW);
    bc.setPlayback(
      { state: 'PLAYING', positionMs: 595_000, durationMs: 600_000, creditsPositionMs: 590_000, contentId: 'ep1' },
      NOW,
    );
    expect(bc.breakState(NOW)).toBe('AT_BREAK');
    expect(bc.pickCard([messageQueued()], NOW)).toMatchObject({ id: 'm1' });
  });

  it('treats a pause longer than PAUSE_IS_BREAK_MS as a break', () => {
    const bc = new BreakController();
    bc.setForeground(true, NOW);
    bc.setPlayback({ state: 'PAUSED', positionMs: 10_000, durationMs: 600_000, contentId: 'ep1' }, NOW);
    expect(bc.breakState(NOW + 1000)).toBe('IN_SCENE'); // not yet 5s
    expect(bc.breakState(NOW + 6000)).toBe('AT_BREAK');
  });

  it('a fresh pause after resuming play starts the pause clock over', () => {
    const bc = new BreakController();
    bc.setForeground(true, NOW);
    bc.setPlayback({ state: 'PAUSED', positionMs: 10_000, durationMs: 600_000, contentId: 'ep1' }, NOW);
    bc.setPlayback({ state: 'PLAYING', positionMs: 10_000, durationMs: 600_000, contentId: 'ep1' }, NOW + 6000);
    bc.setPlayback({ state: 'PAUSED', positionMs: 10_500, durationMs: 600_000, contentId: 'ep1' }, NOW + 6100);
    expect(bc.breakState(NOW + 6200)).toBe('IN_SCENE');
  });
});
