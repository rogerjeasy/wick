/**
 * Wick going behind another app and coming back (break/followScreen.ts),
 * with a real BreakController: a note is not shown, nor counted, on a
 * screen she cannot see, the door still is, and coming back waits the
 * twenty settled seconds again. The edge hears each change.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceEvent, DoorCard, MessageCard, QueuedCard } from '@wick/contracts';
import { BreakController } from '../BreakController.js';
import { followScreen } from '../followScreen.js';
import { SETTLED_AFTER_MS } from '../types.js';

const NOW = 1_000_000;

const note: QueuedCard = {
  id: 'm1',
  urgency: 'DEFERRED',
  queuedAt: NOW,
  shownCount: 0,
  card: { type: 'MESSAGE', id: 'm1', householdId: 'hh-1', correlationId: 'c1', createdAt: NOW, actions: [], fromName: 'Sarah', suggestedReplies: [] } satisfies MessageCard,
};

const door: QueuedCard = {
  id: 'd1',
  urgency: 'DOOR',
  queuedAt: NOW,
  shownCount: 0,
  card: { type: 'DOOR', id: 'd1', householdId: 'hh-1', correlationId: 'c2', createdAt: NOW, actions: [], line: 'Someone is at the door' } satisfies DoorCard,
};

function television() {
  const engine = new BreakController();
  const sent: DeviceEvent[] = [];
  const screen = (onScreen: boolean, at: number) => followScreen(engine, (e) => sent.push(e), onScreen, at);
  return { engine, sent, screen };
}

describe('followScreen', () => {
  it('tells the edge each time Wick comes on screen or goes behind another app', () => {
    const { sent, screen } = television();
    screen(true, NOW);
    screen(false, NOW + 60_000);
    screen(true, NOW + 120_000);
    expect(sent).toEqual([
      { t: 'app_lifecycle', state: 'fg', at: NOW },
      { t: 'app_lifecycle', state: 'bg', at: NOW + 60_000 },
      { t: 'app_lifecycle', state: 'fg', at: NOW + 120_000 },
    ]);
  });

  it('a note on screen when Wick goes behind another app ends its showing, and is not shown behind it', () => {
    const { engine, screen } = television();
    screen(true, NOW);
    const settled = NOW + SETTLED_AFTER_MS;
    expect(engine.pickCard([note], settled)?.id).toBe('m1');
    expect(engine.noteShown(note, [note], settled).began?.id).toBe('m1');

    screen(false, settled + 5_000);
    expect(engine.breakState(settled + 5_000)).toBe('IDLE');
    const picked = engine.pickCard([note], settled + 5_000);
    expect(picked).toBeUndefined();
    // One of its two showings is over: it was left unanswered when she left.
    expect(engine.noteShown(picked, [note], settled + 5_000).ended?.id).toBe('m1');
    // However long the app's JavaScript goes on running, the note stays put.
    expect(engine.pickCard([note], settled + 600_000)).toBeUndefined();
  });

  it('the door still comes while Wick is behind another app', () => {
    const { engine, screen } = television();
    screen(false, NOW);
    expect(engine.pickCard([door, note], NOW)?.id).toBe('d1');
  });

  it('back on screen, a note waits the twenty settled seconds again', () => {
    const { engine, screen } = television();
    screen(true, NOW);
    screen(false, NOW + SETTLED_AFTER_MS + 1_000);
    const back = NOW + 300_000;
    screen(true, back);
    expect(engine.pickCard([note], back + SETTLED_AFTER_MS - 1)).toBeUndefined();
    expect(engine.pickCard([note], back + SETTLED_AFTER_MS)?.id).toBe('m1');
  });
});
