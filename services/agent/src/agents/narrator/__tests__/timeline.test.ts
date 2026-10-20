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

  it('leaves out a person seen who did not ring: not a caller, so the week neither counts nor tells it', () => {
    expect(toTimelineEntry(item({ type: { S: 'door' }, motion: { BOOL: true } }))).toBeUndefined();
  });

  it('parses the timestamp out of the sort key, not off an item attribute — no writer produces one', () => {
    const entry = toTimelineEntry(item({ type: { S: 'door' } }));
    expect(entry?.at).toBe(1789455093305);
  });

  it('maps a presence row to somebody at the door when the visitor was expected — never "Maria visited": the door does not know who rang', () => {
    const entry = toTimelineEntry(item({ type: { S: 'presence' }, personId: { S: 'maria' }, personName: { S: 'Maria' } }));
    expect(entry).toEqual({ at: 1789455093305, kind: 'presence', summary: 'Someone came to the door when Maria was expected.', personId: 'maria', name: 'Maria' });
    expect(entry?.summary).not.toMatch(/Maria (visited|came)/);
  });

  it('falls back to a generic summary for a presence row with no personName', () => {
    const entry = toTimelineEntry(item({ type: { S: 'presence' }, personId: { S: 'x' } }));
    expect(entry?.summary).toBe('Someone came to the door when a regular visitor was expected.');
  });

  describe('a visit the resident answered (VISIT#, packages/contracts visit.ts)', () => {
    const visitRow = (answer?: string): Record<string, AttributeValue> => ({
      pk: { S: 'HH#hh-1' },
      sk: { S: 'VISIT#001789455093305#maria' },
      personId: { S: 'maria' },
      name: { S: 'Maria' },
      arrivedAt: { N: '1789455093305' },
      ...(answer ? { answer: { S: answer } } : {}),
    });

    it('is the one entry that says who came, once she confirmed it', () => {
      expect(toTimelineEntry(visitRow('confirmed'))).toEqual({ at: 1789455093305, kind: 'visit', summary: 'Maria came, as confirmed on the television.', personId: 'maria', name: 'Maria' });
    });

    it('is nothing while she has not answered, or when she said it was not right', () => {
      expect(toTimelineEntry(visitRow())).toBeUndefined();
      expect(toTimelineEntry(visitRow('disputed'))).toBeUndefined();
    });
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
