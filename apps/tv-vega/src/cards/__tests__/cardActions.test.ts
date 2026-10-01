import { describe, it, expect } from 'vitest';
import type { Card } from '@wick/contracts';
import { opensLiveView, removesCard } from '../cardActions.js';

const door = { type: 'DOOR', id: 'd', householdId: 'h', correlationId: 'c', createdAt: 0, line: 'x', actions: [] } as Card;
const week = { type: 'WEEK', id: 'week-2026-W40', householdId: 'h', correlationId: 'c', createdAt: 0, isoWeek: '2026-W40', text: 't', actions: [] } as Card;
const sharing = {
  type: 'SHARING', id: 'sharing', householdId: 'h', correlationId: 'c', createdAt: 0, actions: [],
  factClass: 'DOOR_EVENT', page: 0, pages: 4, headline: 'h', detail: 'd',
} as Card;

describe('removesCard', () => {
  it('keeps a door card on screen while the chime answer is on its way', () => {
    expect(removesCard(door, 'hallway_chime')).toBe(false);
  });

  it('keeps a door card under the live view, so Back returns to it', () => {
    expect(removesCard(door, 'watch_live')).toBe(false);
  });

  it('removes a door card on Not now', () => {
    expect(removesCard(door, 'dismiss')).toBe(true);
  });

  it('removes the Week card on OK', () => {
    expect(removesCard(week, 'seen')).toBe(true);
  });

  it('keeps the Week card behind "What Sarah sees", so Done returns to it', () => {
    expect(removesCard(week, 'sharing')).toBe(false);
  });

  it('keeps the sharing card through its toggle and Next — the server replaces it in place — and removes it on Done', () => {
    expect(removesCard(sharing, 'toggle')).toBe(false);
    expect(removesCard(sharing, 'next')).toBe(false);
    expect(removesCard(sharing, 'done')).toBe(true);
  });
});

describe('opensLiveView', () => {
  it('is only the door card\'s Watch live', () => {
    expect(opensLiveView(door, 'watch_live')).toBe(true);
    expect(opensLiveView(door, 'hallway_chime')).toBe(false);
    expect(opensLiveView(week, 'watch_live')).toBe(false);
  });
});
