import { describe, expect, it } from 'vitest';
import {
  ERRAND_EVENTS,
  ERRAND_LIMITS,
  ERRAND_SK_PREFIX,
  ERRAND_STATUSES,
  REMINDER_CHOICES,
  errandIdOf,
  errandPersonId,
  errandSk,
  isErrandId,
  isErrandOpen,
  isReminderChoice,
  newErrandId,
  readDoorRangDetail,
  remindAtFor,
} from '../errand.js';

const HOUR = 3_600_000;

describe('errand ids and keys', () => {
  it('makes ids that say what they are, and nothing else passes for one', () => {
    const id = newErrandId();
    expect(id).toMatch(/^err_[A-Za-z0-9_-]{20}$/);
    expect(isErrandId(id)).toBe(true);
    expect(newErrandId()).not.toBe(id);
    for (const bad of ['', 'err_', 'err_short', 'ERR_abcdefghijklmnopqrst', `err_${'a'.repeat(21)}`, 'err_abcdefghij/lmnopqrst', 42, undefined]) {
      expect(isErrandId(bad), String(bad)).toBe(false);
    }
  });

  it('files an errand under the household, and its expected visitor on the roster under the errand', () => {
    const id = 'err_abcdefghijklmnopqrst';
    expect(errandSk(id)).toBe(`${ERRAND_SK_PREFIX}${id}`);
    expect(errandPersonId(id)).toBe(`errand:${id}`);
    expect(errandIdOf(errandPersonId(id))).toBe(id);
  });

  it('tells a roster entry made by an errand from any other', () => {
    expect(errandIdOf('member:usr_1')).toBeUndefined();
    expect(errandIdOf('maria')).toBeUndefined();
    expect(errandIdOf('errand:not-an-id')).toBeUndefined();
    expect(errandIdOf(undefined)).toBeUndefined();
  });
});

describe('errand status', () => {
  it('knows which statuses are still open', () => {
    expect(ERRAND_STATUSES).toEqual(['planned', 'reminded', 'waiting', 'rang', 'no_show', 'cancelled', 'failed']);
    expect(['planned', 'reminded', 'waiting'].every((s) => isErrandOpen(s as never))).toBe(true);
    expect(['rang', 'no_show', 'cancelled', 'failed'].some((s) => isErrandOpen(s as never))).toBe(false);
  });
});

describe('reminders', () => {
  it('knows the three choices and no others', () => {
    expect(REMINDER_CHOICES).toEqual(['morning_of', 'hour_before', 'none']);
    expect(isReminderChoice('hour_before')).toBe(true);
    expect(isReminderChoice('tomorrow')).toBe(false);
  });

  // Thursday 15 October 2026, 10:00 in London is 09:00 UTC (BST).
  const at = Date.UTC(2026, 9, 15, 9, 0);
  const tz = 'Europe/London';

  it('an hour before is an hour before', () => {
    expect(remindAtFor('hour_before', at, tz, at - 48 * HOUR)).toBe(at - HOUR);
  });

  it('the morning of is eight o’clock on the day, in her time zone', () => {
    expect(remindAtFor('morning_of', at, tz, at - 48 * HOUR)).toBe(Date.UTC(2026, 9, 15, 7, 0));
  });

  it('the morning of follows the clock change: eight in London is 08:00 UTC in winter', () => {
    const winter = Date.UTC(2026, 10, 5, 10, 0); // 5 November, GMT
    expect(remindAtFor('morning_of', winter, tz, winter - 48 * HOUR)).toBe(Date.UTC(2026, 10, 5, 8, 0));
  });

  it('a reminder whose moment has passed is sent now, if the visit is still ahead', () => {
    const now = at - 30 * 60_000; // 09:30 local, after eight
    expect(remindAtFor('morning_of', at, tz, now)).toBe(now);
    expect(remindAtFor('hour_before', at, tz, now)).toBe(now);
  });

  it('is never later than the visit’s window opens, so the door is listening for the whole window', () => {
    // 08:30 in London (07:30 UTC, BST): the window opens at 07:30 local, before eight.
    const halfPastEight = Date.UTC(2026, 9, 15, 7, 30);
    const windowOpens = halfPastEight - ERRAND_LIMITS.windowMinutes * 60_000;
    expect(remindAtFor('morning_of', halfPastEight, tz, halfPastEight - 48 * HOUR)).toBe(windowOpens);
    for (const choice of ['morning_of', 'hour_before'] as const) {
      expect(remindAtFor(choice, at, tz, at - 48 * HOUR)!).toBeLessThanOrEqual(at - ERRAND_LIMITS.windowMinutes * 60_000);
    }
  });

  it('no reminder at all, or for a visit that is not ahead', () => {
    expect(remindAtFor('none', at, tz, at - 48 * HOUR)).toBeUndefined();
    expect(remindAtFor('hour_before', at, tz, at + 1)).toBeUndefined();
  });

  it('a morning-of visit before eight is reminded an hour before instead', () => {
    const early = Date.UTC(2026, 9, 15, 6, 30); // 07:30 local
    expect(remindAtFor('morning_of', early, tz, early - 48 * HOUR)).toBe(early - HOUR);
  });
});

describe('limits', () => {
  it('are the numbers the spec gives', () => {
    expect(ERRAND_LIMITS).toEqual({
      maxOpenPerHousehold: 10,
      whoMaxChars: 40,
      windowMinutes: 60,
      minLeadMs: 2 * 60_000,
      maxLeadMs: 60 * 24 * HOUR,
    });
  });
});

describe('door.rang', () => {
  it('reads the detail the door puts on the bus', () => {
    expect(ERRAND_EVENTS).toEqual({ source: 'wick.door', doorRang: 'door.rang' });
    expect(readDoorRangDetail({ householdId: 'hh_1', at: 5, cardId: 'door-x', matchPersonId: 'errand:err_abcdefghijklmnopqrst' })).toEqual({
      householdId: 'hh_1',
      at: 5,
      cardId: 'door-x',
      matchPersonId: 'errand:err_abcdefghijklmnopqrst',
    });
    expect(readDoorRangDetail({ householdId: 'hh_1', at: 5, cardId: 'door-x' })).toEqual({ householdId: 'hh_1', at: 5, cardId: 'door-x' });
  });

  it('refuses anything else', () => {
    for (const bad of [null, {}, { householdId: '', at: 5, cardId: 'c' }, { householdId: 'h', at: 'x', cardId: 'c' }, { householdId: 'h', at: 5 }, { householdId: 'h', at: 5, cardId: 'c', matchPersonId: 7 }]) {
      expect(readDoorRangDetail(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});
