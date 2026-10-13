import { describe, it, expect } from 'vitest';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { toTimelineEntry } from '../timeline.js';

const item = (attrs: Record<string, AttributeValue>): Record<string, AttributeValue> => ({
  pk: { S: 'HH#hh-1' },
  sk: { S: 'EVT#001789455093305#evt-1' },
  ...attrs,
});

describe('toTimelineEntry', () => {
  it('maps a door event to kind "door", the same wording get_today.ts already uses', () => {
    const entry = toTimelineEntry(item({ type: { S: 'door' } }));
    expect(entry).toMatchObject({ kind: 'door', summary: 'Someone was at the front door.' });
  });

  it('parses the timestamp out of the sort key, not off an item attribute — no writer produces one', () => {
    const entry = toTimelineEntry(item({ type: { S: 'door' } }));
    expect(entry?.at).toBe(1789455093305);
  });

  it('maps a presence event to kind "visit" — the narrative-level term the seed script already models', () => {
    const entry = toTimelineEntry(item({ type: { S: 'presence' }, personId: { S: 'maria' }, personName: { S: 'Maria' } }));
    expect(entry).toMatchObject({ kind: 'visit', summary: 'Maria visited.', personId: 'maria' });
  });

  it('falls back to a generic summary for a presence row with no personName', () => {
    const entry = toTimelineEntry(item({ type: { S: 'presence' }, personId: { S: 'x' } }));
    expect(entry?.summary).toBe('Someone visited.');
  });

  it('ignores card_shown/card_action — too granular for a weekly narrative, and not what a family member is asking about', () => {
    expect(toTimelineEntry(item({ type: { S: 'card_shown' }, cardId: { S: 'door-1' } }))).toBeUndefined();
    expect(toTimelineEntry(item({ type: { S: 'card_action' }, cardId: { S: 'door-1' }, action: { S: 'dismiss' } }))).toBeUndefined();
  });

  it('never puts her answer to a picture in the week: neither press, with or without its button, is an entry (mantel.ts, THE RULE)', () => {
    // The edge writes a picture's press without its button (device-event.mjs); even with one, nothing of it is narrated.
    for (const attrs of [
      { type: { S: 'card_action' }, cardId: { S: 'photo-p1' } },
      { type: { S: 'card_action' }, cardId: { S: 'photo-p1' }, action: { S: 'keep' } },
      { type: { S: 'card_action' }, cardId: { S: 'photo-p1' }, action: { S: 'thanks' } },
      { type: { S: 'card_shown' }, cardId: { S: 'photo-p1' } },
    ]) {
      expect(toTimelineEntry(item(attrs))).toBeUndefined();
    }
  });

  it('ignores an item with no recognised type rather than guessing', () => {
    expect(toTimelineEntry(item({ type: { S: 'something_new' } }))).toBeUndefined();
  });

  it('ignores a malformed sort key rather than reporting a wrong timestamp', () => {
    const bad = { pk: { S: 'HH#hh-1' }, sk: { S: 'NOT-AN-EVT-ROW' }, type: { S: 'door' } };
    expect(toTimelineEntry(bad)).toBeUndefined();
  });
});
