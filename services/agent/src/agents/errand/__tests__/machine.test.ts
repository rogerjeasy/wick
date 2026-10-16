import { describe, expect, it } from 'vitest';
import type { Errand } from '@wick/contracts';
import { doorWaitSeconds, executionInput, instant } from '../machine.js';

const NOW = Date.UTC(2026, 9, 13, 12);
const AT = Date.UTC(2026, 9, 15, 9);
const errand: Errand = {
  errandId: 'err_AAAAAAAAAAAAAAAAAAAA',
  householdId: 'hh-1',
  createdBy: 'u_sarah',
  createdByName: 'Sarah',
  who: 'the plumber',
  at: AT,
  windowMinutes: 60,
  remindAt: Date.UTC(2026, 9, 15, 7),
  tellMe: true,
  status: 'planned',
  createdAt: NOW,
};

describe('instant — a moment as a Wait state reads it', () => {
  it('is ISO 8601 to the second, never a moment early', () => {
    expect(instant(Date.UTC(2026, 9, 15, 7))).toBe('2026-10-15T07:00:00Z');
    expect(instant(Date.UTC(2026, 9, 15, 7, 0, 0, 1))).toBe('2026-10-15T07:00:01Z');
  });
});

describe('doorWaitSeconds — how long the door waits, from now to the end of the window', () => {
  it('counts whole seconds to the window’s end, rounded up', () => {
    expect(doorWaitSeconds(NOW + 90_500, NOW)).toBe(91);
  });

  it('is never under a minute, so a wait armed late still waits', () => {
    expect(doorWaitSeconds(NOW + 5_000, NOW)).toBe(60);
    expect(doorWaitSeconds(NOW - 5_000, NOW)).toBe(60);
  });
});

describe('executionInput — what the state machine is started with', () => {
  it('names the errand, when to remind her, when the window ends, and how long the door waits from now', () => {
    expect(executionInput(errand, NOW)).toEqual({
      householdId: 'hh-1',
      errandId: errand.errandId,
      remindAt: '2026-10-15T07:00:00Z',
      windowEnd: '2026-10-15T10:00:00Z',
      door: { waitSeconds: (AT + 3_600_000 - NOW) / 1000 },
    });
  });

  it('has no reminder when none was chosen, so the machine goes straight to the door', () => {
    const { remindAt: _none, ...noReminder } = errand;
    expect(executionInput(noReminder, NOW)).not.toHaveProperty('remindAt');
  });

  it('carries nothing about who is coming or who arranged it', () => {
    const input = JSON.stringify(executionInput(errand, NOW));
    expect(input).not.toContain('plumber');
    expect(input).not.toContain('Sarah');
    expect(input).not.toContain('u_sarah');
  });
});
