/**
 * The idle screen (apps/tv-vega/src/mantel/idle.ts) ends on any key, and
 * that press does nothing else. Which events a press arrives as is the one
 * thing that differs here from Vega (FRICTION.md FL-028), so the rule is
 * run on keys as this app's adapter says them.
 */
import { describe, expect, it } from 'vitest';
import { remoteKeyEvents } from '../adapters/remoteEvents.js';
import { IDLE_OFF, idleOnKey, type Idle } from '../../../tv-vega/src/mantel/idle.js';

const NOW = 1_800_000_000_000;
const ON: Idle = { phase: 'on', startedAt: NOW };

describe('the idle screen on Fire OS — keys as the adapter says them (FRICTION.md FL-028)', () => {
  const through = (android: ReadonlyArray<{ eventType: string; eventKeyAction?: number }>, from: Idle = ON) => {
    const toKeys = remoteKeyEvents();
    const phases: string[] = [];
    let idle = from;
    for (const event of android) {
      for (const said of toKeys(event)) {
        idle = idleOnKey(idle, said, NOW);
        phases.push(idle.phase);
      }
    }
    return { idle, phases };
  };

  it('a short press of OK reaches JavaScript as the key coming up and nothing else: said whole, it ends the idle screen and is consumed', () => {
    expect(through([{ eventType: 'select', eventKeyAction: 1 }])).toEqual({ idle: IDLE_OFF, phases: ['ending', 'off'] });
  });

  it('a held OK arrives as longSelect, down and then up: the home screen stays out of reach until it is let go', () => {
    const held = through([{ eventType: 'longSelect', eventKeyAction: 0 }, { eventType: 'longSelect', eventKeyAction: 0 }]);
    expect(held.idle).toMatchObject({ phase: 'ending', key: 'select' });

    expect(through([{ eventType: 'longSelect', eventKeyAction: 0 }, { eventType: 'longSelect', eventKeyAction: 1 }])).toEqual({ idle: IDLE_OFF, phases: ['ending', 'off'] });
  });

  it('focus moving is not a key: it does not end the idle screen', () => {
    expect(through([{ eventType: 'focus' }, { eventType: 'blur' }]).idle).toBe(ON);
  });

  it('an arrow, and play/pause that arrives only as the key coming up, end it like any key', () => {
    expect(through([{ eventType: 'right', eventKeyAction: 0 }, { eventType: 'right', eventKeyAction: 1 }]).idle).toBe(IDLE_OFF);
    expect(through([{ eventType: 'playPause', eventKeyAction: 1 }]).idle).toBe(IDLE_OFF);
  });
});
