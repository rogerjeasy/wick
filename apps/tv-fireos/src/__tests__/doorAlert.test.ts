/**
 * The door, outside Wick, on Fire OS: what the notification says, and when
 * there is none (src/door/doorAlert.ts). Pure decisions; what Android draws
 * from them is src/door/native.ts and the Kotlin beside MainActivity.
 */
import { describe, expect, it } from 'vitest';
import { DOOR_CARD_TTL_MS, type QueuedCard } from '@wick/contracts';
import { doorAlert, shouldAskToNotify } from '../door/doorAlert.js';

const NOW = 1_800_000_000_000;

const door = (over: Partial<Extract<QueuedCard['card'], { type: 'DOOR' }>> = {}, queued: Partial<QueuedCard> = {}): QueuedCard => ({
  id: 'door-1',
  urgency: 'DOOR',
  card: {
    type: 'DOOR',
    id: 'door-1',
    householdId: 'hh-1',
    correlationId: 'corr-1',
    createdAt: NOW,
    actions: [],
    line: "Someone's at the front door.",
    ...over,
  },
  queuedAt: NOW,
  expiresAt: NOW + DOOR_CARD_TTL_MS,
  shownCount: 0,
  ...queued,
});

const note: QueuedCard = {
  id: 'note-1',
  urgency: 'DEFERRED',
  card: { type: 'MESSAGE', id: 'note-1', householdId: 'hh-1', correlationId: 'corr-2', createdAt: NOW, actions: [], fromName: 'Sarah', transcript: 'See you Sunday.', suggestedReplies: ['Lovely', 'Thank you', 'See you then'] },
  queuedAt: NOW,
  shownCount: 0,
};

describe('the door notification', () => {
  it('says the door card’s own line, and that Wick will show who it is, until the door agent has said', () => {
    expect(doorAlert(door(), 'en', NOW)).toEqual({
      cardId: 'door-1',
      title: "Someone's at the front door.",
      text: 'Open Wick to see who it is.',
      openLabel: 'Open Wick',
      endsInMs: DOOR_CARD_TTL_MS,
    });
  });

  it('says what the vision model saw, with the picture from the door, once they have come', () => {
    const alert = doorAlert(
      door({ description: 'A person in a blue coat holding a parcel.', imageRef: 'https://media.example/snap.jpg?X-Amz-Signature=abc' }),
      'en',
      NOW,
    );

    expect(alert).toMatchObject({
      title: "Someone's at the front door.",
      text: 'A person in a blue coat holding a parcel.',
      pictureUrl: 'https://media.example/snap.jpg?X-Amz-Signature=abc',
    });
  });

  it('speaks her language in its own words; the line and the sentence come from the server already in it', () => {
    expect(doorAlert(door({ line: 'Hay alguien en la puerta de entrada.' }), 'es', NOW)).toMatchObject({
      title: 'Hay alguien en la puerta de entrada.',
      text: 'Abra Wick para ver quién es.',
      openLabel: 'Abrir Wick',
    });
  });

  it('is for the door only: a note from the family never interrupts another app', () => {
    expect(doorAlert(note, 'en', NOW)).toBeUndefined();
  });

  it('is not put up for a door card that is no longer live: "someone is at the door" would not be true', () => {
    expect(doorAlert(door({}, { expiresAt: NOW }), 'en', NOW)).toBeUndefined();
    expect(doorAlert(door({}, { expiresAt: NOW - 1 }), 'en', NOW)).toBeUndefined();
  });

  it('goes when its card goes: a card sent before the Door agent stamped one lives five minutes from when it came', () => {
    const { expiresAt: _none, ...unstamped } = door({}, { queuedAt: NOW - 60_000 });

    expect(doorAlert(unstamped, 'en', NOW)?.endsInMs).toBe(DOOR_CARD_TTL_MS - 60_000);
  });

  it('shows a picture only from an https address: Android fetches it itself', () => {
    expect(doorAlert(door({ imageRef: 'http://media.example/snap.jpg' }), 'en', NOW)?.pictureUrl).toBeUndefined();
    expect(doorAlert(door({ imageRef: 'file:///data/snap.jpg' }), 'en', NOW)?.pictureUrl).toBeUndefined();
  });

  it('does not say a sentence that is only blank', () => {
    expect(doorAlert(door({ description: '   ' }), 'en', NOW)?.text).toBe('Open Wick to see who it is.');
  });
});

describe('asking her once whether Wick may put up notifications', () => {
  it('asks on Android 13 and later, where it is hers to allow', () => {
    expect(shouldAskToNotify({ sdk: 33, granted: false, askedBefore: false })).toBe(true);
    expect(shouldAskToNotify({ sdk: 34, granted: false, askedBefore: false })).toBe(true);
  });

  it('never asks on Fire OS 7 and 8 (Android 9 and 11): there it is allowed when Wick is installed', () => {
    expect(shouldAskToNotify({ sdk: 28, granted: false, askedBefore: false })).toBe(false);
    expect(shouldAskToNotify({ sdk: 30, granted: false, askedBefore: false })).toBe(false);
  });

  it('never asks again: not when she has allowed it, and not when she has said no', () => {
    expect(shouldAskToNotify({ sdk: 34, granted: true, askedBefore: false })).toBe(false);
    expect(shouldAskToNotify({ sdk: 34, granted: false, askedBefore: true })).toBe(false);
  });
});
