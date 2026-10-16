import { describe, expect, it, vi } from 'vitest';
import type { QueuedCard } from '@wick/contracts';
import { AppLaunchTarget, ToastKind } from '@amazon-devices/react-native-kepler/Libraries/Components/ToastKepler/NotificationManagerUtils';
import { MAX_NOTIFICATION_BYTES, doorToast, notificationBytes, postToast, WICK_ICON_URL } from '../doorToast.js';

const door = (over: Record<string, unknown> = {}): QueuedCard => ({
  id: 'door-1',
  urgency: 'DOOR',
  card: {
    type: 'DOOR',
    id: 'door-1',
    householdId: 'h1',
    correlationId: 'c',
    createdAt: 0,
    actions: [],
    line: "Someone's at the front door.",
    ...over,
  },
  queuedAt: 0,
  shownCount: 0,
});

const note: QueuedCard = {
  id: 'note-1',
  urgency: 'DEFERRED',
  card: {
    type: 'MESSAGE',
    id: 'note-1',
    householdId: 'h1',
    correlationId: 'c',
    createdAt: 0,
    actions: [],
    fromName: 'Sarah',
    transcript: 'Thinking of you.',
    suggestedReplies: [],
  },
  queuedAt: 0,
  shownCount: 0,
};

describe('doorToast', () => {
  it("says the door card's own line, and offers to open Wick", () => {
    const toast = doorToast(door());

    expect(toast).toMatchObject({
      mTitle: "Someone's at the front door.",
      mDescription: 'Open Wick to see who it is.',
      mLaunchTargets: [{ appUri: 'pkg://com.wick.tv.main', title: 'Open Wick' }],
    });
  });

  it('names the render template as the channel — any other name posts and draws nothing', () => {
    expect(doorToast(door())?.mChannel).toEqual({
      importance: { importance: 'NORMAL' },
      kind: { kindDescriptor: 5 },
      name: 'MenuToastRenderTemplate',
    });
  });

  it("is built from the parts react-native-kepler's useToastKepler builds with, not copies of them", () => {
    const toast = doorToast(door())!;
    expect(toast.mChannel.kind).toBeInstanceOf(ToastKind);
    expect(toast.mLaunchTargets?.[0]).toBeInstanceOf(AppLaunchTarget);
    // The hook's long toast.
    expect(toast.mTimeout).toBe(8);
  });

  it('carries the description once the door agent has one', () => {
    expect(doorToast(door({ description: 'A man in a blue jacket holding a parcel.' }))?.mDescription).toBe(
      'A man in a blue jacket holding a parcel.',
    );
  });

  it('shows the picture from the door when there is one', () => {
    const toast = doorToast(door({ imageRef: 'https://cdn.example/door.jpg' }));

    expect(toast?.mIconUri).toBe('https://cdn.example/door.jpg');
  });

  it("shows a picture whose address is long, as Ring's signed ones are — the address is sent once, not twice", () => {
    const signed = `https://download.example/frame.jpg?X-Amz-Signature=${'a'.repeat(1800)}`;
    const toast = doorToast(door({ imageRef: signed, description: 'A man in a blue jacket holding a parcel.' }))!;

    expect(toast.mIconUri).toBe(signed);
    expect(JSON.stringify(toast).split(signed)).toHaveLength(2);
  });

  it("shows Wick's own mark when there is no picture yet", () => {
    expect(doorToast(door())?.mIconUri).toBe(WICK_ICON_URL);
  });

  it("shows Wick's own mark when the picture's address is not https", () => {
    expect(doorToast(door({ imageRef: 'http://cdn.example/door.jpg' }))?.mIconUri).toBe(WICK_ICON_URL);
  });

  it("shows Wick's own mark rather than send a notification the platform would refuse for its size", () => {
    // The notification manager caps one notification at 4096 bytes. The words come first.
    const huge = `https://cdn.example/door.jpg?sig=${'a'.repeat(4000)}`;
    const toast = doorToast(door({ imageRef: huge, description: 'A man in a blue jacket holding a parcel.' }))!;

    expect(toast.mIconUri).toBe(WICK_ICON_URL);
    expect(toast.mDescription).toBe('A man in a blue jacket holding a parcel.');
    expect(notificationBytes(toast)).toBeLessThanOrEqual(MAX_NOTIFICATION_BYTES);
  });

  it('keeps every toast it builds inside the cap, picture and all', () => {
    const justFits = `https://cdn.example/door.jpg?sig=${'a'.repeat(3000)}`;
    const toast = doorToast(door({ imageRef: justFits, description: 'A'.repeat(240) }))!;

    expect(notificationBytes(toast)).toBeLessThanOrEqual(MAX_NOTIFICATION_BYTES);
  });

  it('is silent for a note from family — a note waits for a natural break, it never interrupts', () => {
    expect(doorToast(note)).toBeUndefined();
  });
});

describe('postToast', () => {
  it('hands the toast to the platform', async () => {
    const post = vi.fn().mockResolvedValue({ bytes: [] });
    const toast = doorToast(door())!;

    await postToast(toast, () => ({ post }));

    expect(post).toHaveBeenCalledWith(toast);
  });

  it('never throws — not when the platform refuses, and not when it has no notification manager at all', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const refuses = () => ({ post: () => Promise.reject(new Error('[com.amazon.apmf.SecurityError]: No Permission Error')) });
    const missing = () => {
      throw new Error("TurboModuleRegistry.getEnforcing(...): 'NotificationManager' could not be found");
    };

    await expect(postToast(doorToast(door())!, refuses)).resolves.toBeUndefined();
    await expect(postToast(doorToast(door())!, missing)).resolves.toBeUndefined();
  });
});
