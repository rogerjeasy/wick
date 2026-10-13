import { describe, expect, it } from 'vitest';
import type { QueuedCard } from '@wick/contracts';
import { MAX_NOTIFICATION_BYTES, WICK_ICON_URL, doorToast, notificationBytes } from '../doorToast.js';
import { waitingToast } from '../waitingToast.js';

const door: QueuedCard = {
  id: 'c1',
  urgency: 'DOOR',
  card: { type: 'DOOR', id: 'c1', householdId: 'h1', correlationId: 'x', createdAt: 0, actions: [], line: "Someone's at the front door." },
  queuedAt: 0,
  shownCount: 0,
};

describe('waitingToast — what waits for a family member, said over another app', () => {
  const toast = waitingToast({ id: 'ftv-door_look-d1', line: 'Margaret asks who is at her door.' })!;

  it('says the server’s sentence, and that Wick is where to answer it', () => {
    expect(toast.mTitle).toBe('Margaret asks who is at her door.');
    expect(toast.mDescription).toBe('Open Wick to answer.');
  });

  it('has one button, which brings Wick forward', () => {
    expect(toast.mLaunchTargets).toEqual([{ appUri: 'pkg://com.wick.tv.main', title: 'Open Wick', iconUri: 'not_used' }]);
  });

  it('is the shape the platform draws — the door toast’s own, to the channel name (FL-022)', () => {
    const { mTitle: _title, mDescription: _description, ...shape } = toast;
    const { mTitle: _doorTitle, mDescription: _doorDescription, ...doorShape } = doorToast(door)!;

    expect(shape).toEqual(doorShape);
    expect(toast.mChannel.name).toBe('MenuToastRenderTemplate');
    expect(toast.mIconUri).toBe(WICK_ICON_URL);
  });

  it('carries nothing but that sentence: no picture, no name of a card, nothing of her day', () => {
    expect(JSON.stringify(toast)).not.toContain('ftv-door_look-d1');
  });

  it('is not posted at all when it would be refused for its size', () => {
    expect(notificationBytes(toast)).toBeLessThan(MAX_NOTIFICATION_BYTES);
    expect(waitingToast({ id: 'x', line: 'é'.repeat(MAX_NOTIFICATION_BYTES) })).toBeUndefined();
  });
});
